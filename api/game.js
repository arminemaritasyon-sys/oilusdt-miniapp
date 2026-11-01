import { tx } from '../lib/db.js';
import { env, tg, verifyInitData, refLink, botUsername } from '../lib/tg.js';
import * as G from '../lib/game.js';
import { activeWallets, createWalletInvoice, submitWalletInvoice, notifyAdminsSubmitted, publicInvoice } from '../lib/wallet.js';
import * as R from '../lib/rewards.js';
import { notifyWithdrawalGroup } from '../lib/payout_announcements.js';
import { deletePlayerAccount } from '../lib/account_deletion.js';
import { activeBanks, createBankInvoice, submitBankInvoice, publicBankInvoice, notifyAdminsBankInvoice } from '../lib/bank_payments.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST gerekli' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { action = '', initData = '' } = body;

  let tgUser;
  if (env.dev && String(initData).startsWith('dev:')) {
    const n = Number(String(initData).slice(4)) || 1;
    tgUser = { id: G.DEV_ID_BASE + n, first_name: 'Test ' + n, username: 'test' + n, start_param: body.ref || null };
  } else {
    tgUser = verifyInitData(String(initData));
    if (!tgUser) return res.status(401).json({ ok: false, error: 'Oturum doğrulanamadı. Uygulamayı Telegram içinden açın.' });
  }

  try {
    const out = await tx(async (c) => {
      // Profil silme normal oyun başlatma yolundan ayrı: hesap yoksa yeniden açma.
      if (action === 'delete_account') {
        const result = await deletePlayerAccount(c, tgUser.id, body.confirmation, body.accept_forfeit);
        return { ok: true, ...result };
      }
      const s = await G.loadSettings(c);
      if (s.maintenance > 0) throw new G.GameError('Bakım çalışması yapılıyor, birazdan tekrar dene.');
      let u = await G.ensureUser(c, s, tgUser, tgUser.start_param);
      if (u.banned) throw new G.GameError('Hesabın askıya alındı.');
      const extra = {};
      const migrated = await G.migrateLegacyCoins(c, u);
      if (migrated > 0) extra.migratedCoins = migrated;

      switch (action) {
        case 'init':
          G.accrue(s, u);
          extra.products = await G.shopProducts(c, u.id);
          extra.bot = await botUsername();
          extra.crypto = { wallets: s.crypto_enabled > 0 ? await activeWallets(c) : [] };
          extra.bank_accounts = await activeBanks(c);
          break;
        case 'start':
          await G.actStart(c, s, u, req);
          await R.onShiftStart(c, s, u, req);
          break;
        case 'sell':
          extra.earned = Math.round((await G.actSell(c, s, u)) * 1e4) / 1e4;
          break;
        case 'upgrade':
          extra.upgrade = await G.actUpgrade(c, s, u);
          break;
        case 'daily':
          extra.reward = G.actDaily(s, u);
          await R.addPoints(c, u.id, s.points_daily);
          break;
        case 'tasks': {
          const done = new Set((await c.query('SELECT task_id FROM user_tasks WHERE user_id = $1', [u.id])).rows.map((r) => r.task_id));
          const refs = await G.countStartedRefs(c, u.id);
          extra.tasks = (await c.query('SELECT id, type, title, subtitle, target, count, reward FROM tasks WHERE active = 1 ORDER BY sort, id')).rows.map((t) => {
            const url = t.type === 'channel' ? 'https://t.me/' + String(t.target || '').replace(/^@/, '') : t.type === 'link' ? t.target : undefined;
            const { target, ...rest } = t;
            return { ...rest, url, done: done.has(t.id), progress: t.type === 'invite' ? Math.min(refs, t.count) : null };
          });
          extra.daily = G.dailyInfo(s, u);
          break;
        }
        case 'task':
          extra.reward = await G.actTask(c, s, u, Number(body.id) || 0);
          await R.addPoints(c, u.id, s.points_task);
          break;
        case 'rewards':
          extra.rewards = await R.rewardsInfo(c, s, u);
          break;
        case 'withdraw': {
          const row = await R.requestWithdraw(c, s, u, body);
          extra.withdrawAnnounce = row;
          extra.rewards = await R.rewardsInfo(c, s, u);
          break;
        }
        case 'friends': {
          const list = (await c.query('SELECT first_name, username, started, oil_total FROM users WHERE ref_by = $1 ORDER BY created_at DESC LIMIT 100', [u.id])).rows;
          const cnt = (await c.query('SELECT COUNT(*)::int AS total, COALESCE(SUM(started),0)::int AS active FROM users WHERE ref_by = $1', [u.id])).rows[0];
          extra.friends = {
            link: await refLink(u.id), total: cnt.total, active: cnt.active,
            earned: Math.round(u.ref_earned * 100) / 100, ref_power: s.ref_power, ref_share: s.ref_share, ref_rates:G.referralRates(s), ref_depth:9,
            list: list.map((f) => ({ name: f.first_name || f.username || 'Oyuncu', active: !!f.started, oil: Math.round(f.oil_total * 10) / 10 })),
          };
          break;
        }
        case 'top': {
          G.accrue(s, u);
          await G.saveUser(c, u);
          const top = (await c.query('SELECT id, first_name, username, oil_total, level FROM users WHERE banned = 0 ORDER BY oil_total DESC LIMIT 50')).rows;
          const me = (await c.query('SELECT COUNT(*)::int + 1 AS r FROM users WHERE banned = 0 AND oil_total > $1', [u.oil_total])).rows[0].r;
          extra.top = { me, list: top.map((r) => ({ name: r.first_name || r.username || 'Oyuncu', oil: Math.round(r.oil_total * 10) / 10, level: r.level, me: r.id === u.id })) };
          break;
        }
        case 'invoice': {
          const p = (await G.shopProducts(c, u.id)).find((x) => x.id === Number(body.id));
          if (!p) throw new G.GameError('Ürün bulunamadı.');
          if (p.locked) throw new G.GameError(`Bu paket kilitli. Önce "${p.requires}" paketini al.`);
          if (env.dev && u.id >= G.DEV_ID_BASE) {
            // Yerel testte gerçek ödeme olmadan ürünü ver
            await G.saveUser(c, u);
            await G.grantPurchase(c, s, u.id, p, p.stars, 'dev-' + Date.now() + Math.random().toString(36).slice(2, 8));
            u = await G.findUser(c, u.id, true);
            extra.dev_paid = true;
            break;
          }
          const r = await tg('createInvoiceLink', {
            title: p.title,
            description: p.description || p.title,
            payload: JSON.stringify({ u: u.id, p: p.id }),
            provider_token: '',
            currency: 'XTR',
            prices: [{ label: p.title, amount: p.stars }],
          });
          if (!r.ok) throw new G.GameError('Ödeme bağlantısı oluşturulamadı.');
          extra.link = r.result;
          break;
        }
        case 'banks_active':
          // Aynı oturum içinde aktif edilen IBANları en güncel haliyle getir.
          extra.bank_accounts = await activeBanks(c);
          break;
        case 'bank_invoice': {
          const p = (await G.shopProducts(c,u.id)).find(p=>p.id===Number(body.id));
          if (!p) throw new G.GameError('Ürün bulunamadı.');
          if (p.locked) throw new G.GameError('Bu paket kilitli.');
          extra.bank_invoice = await createBankInvoice(c,u,p,Number(body.bank)||0);
          break;
        }
        case 'bank_submit': {
          const r = await submitBankInvoice(c,u,Number(body.invoice_id)||0,body.payer_name,body.receipt_reference);
          extra.bank_invoice = r.invoice;
          if (r.notify) {
            const p = await G.findProduct(c,r.notify.product_id,false);
            extra.bank_notify = {row:r.notify,title:p?.title};
          }
          break;
        }
        case 'bank_status': {
          const row = (await c.query(
            'SELECT * FROM bank_invoices WHERE id=$1 AND user_id=$2',
            [Number(body.invoice_id)||0,u.id])).rows[0];
          if (!row) throw new G.GameError('Banka siparişi bulunamadı.');
          extra.bank_invoice = publicBankInvoice(row);
          if (row.status === 'paid') {
            u = await G.findUser(c,u.id,true);
            extra.products = await G.shopProducts(c,u.id);
          }
          break;
        }
        case 'crypto_invoice': {
          if (!(s.crypto_enabled > 0)) throw new G.GameError('Kripto ile ödeme şu anda kapalı.');
          const p = (await G.shopProducts(c, u.id)).find((x) => x.id === Number(body.id));
          if (!p) throw new G.GameError('Ürün bulunamadı.');
          if (p.locked) throw new G.GameError(`Bu paket kilitli. Önce "${p.requires}" paketini al.`);
          if (!(p.usd > 0)) throw new G.GameError('Bu paket kripto ile satılmıyor.');
          extra.invoice = await createWalletInvoice(c, u, p, Number(body.wallet) || 0);
          break;
        }
        case 'crypto_submit': {
          const r = await submitWalletInvoice(c, u, Number(body.invoice_id) || 0, body.tx_hash);
          extra.invoice = r.invoice || r;
          if (r.notify) {
            const p = await G.findProduct(c, r.notify.product_id, false);
            extra.announce = { row: r.notify, title: p?.title };
          }
          break;
        }
        case 'crypto_status': {
          const row = (await c.query('SELECT * FROM wallet_invoices WHERE id = $1 AND user_id = $2', [Number(body.invoice_id) || 0, u.id])).rows[0];
          if (!row) throw new G.GameError('Ödeme bulunamadı.');
          extra.invoice = publicInvoice(row);
          if (row.status === 'paid') {
            u = await G.findUser(c, u.id, true);
            extra.products = await G.shopProducts(c, u.id);
          }
          break;
        }
        default:
          throw new G.GameError('Bilinmeyen işlem.');
      }

      await G.saveUser(c, u);
      const state = G.publicState(s, u);
      // Çekilebilir bakiye (USD) her yanıtta güncel haliyle gönderilir: sol üstteki bakiye ve Çekim ekranı
      // aynı değeri gösterir; çekim, satış, iade gibi hareketler iki yerde birlikte görünür.
      const bal = (await c.query('SELECT reward_usd FROM users WHERE id = $1', [u.id])).rows[0];
      state.balance = Math.round((Number(bal?.reward_usd) || 0) * 100) / 100;
      return { ok: true, state, me: { id: u.id, name: u.first_name }, ...extra };
    });
    if (out.announce) {
      await notifyAdminsSubmitted(out.announce.row, tgUser, out.announce.title);
      delete out.announce;
    }
    if (out.bank_notify) {
      await notifyAdminsBankInvoice(out.bank_notify.row, tgUser, out.bank_notify.title);
      delete out.bank_notify;
    }
    if (out.withdrawAnnounce) {
      if(out.withdrawAnnounce.status==='approved')await notifyWithdrawalGroup(out.withdrawAnnounce.id,'approved');
      await R.notifyAdminsWithdraw(out.withdrawAnnounce, tgUser);
      delete out.withdrawAnnounce;
    }
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof G.GameError) return res.status(400).json({ ok: false, error: e.message });
    console.error('[game]', e);
    if (/DATABASE_URL/.test(e.message)) return res.status(503).json({ ok: false, error: 'Veritabanı henüz bağlanmadı.' });
    return res.status(500).json({ ok: false, error: 'Sunucu hatası.' });
  }
}
