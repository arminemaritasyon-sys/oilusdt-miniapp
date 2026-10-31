import crypto from 'node:crypto';
import { tx, query } from '../lib/db.js';
import { env, tg, webappUrl, webappKeyboard, safeEqual, botUsername } from '../lib/tg.js';
import * as G from '../lib/game.js';
import { approveWalletInvoice, rejectWalletInvoice } from '../lib/wallet.js';
import * as R from '../lib/rewards.js';

const TOKEN_TTL = 12 * 3600;
const sign = (exp) => crypto.createHmac('sha256', env.adminPassword + '|' + env.secret).update(String(exp)).digest('hex');
const makeToken = () => { const exp = G.now() + TOKEN_TTL; return `${exp}.${sign(exp)}`; };
function validToken(t) {
  const [exp, sig] = String(t || '').split('.');
  return !!env.adminPassword && Number(exp) > G.now() && !!sig && safeEqual(sig, sign(exp));
}

const PAY_SQL = `SELECT p.*, u.first_name, u.username, pr.title FROM payments p
  LEFT JOIN users u ON u.id = p.user_id LEFT JOIN products pr ON pr.id = p.product_id`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST gerekli' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  try {
    if (b.action === 'login') {
      await new Promise((r) => setTimeout(r, 400)); // kaba kuvvet denemelerini yavaşlat
      if (!env.adminPassword) return res.status(400).json({ ok: false, error: 'ADMIN_PASSWORD ortam değişkeni tanımlı değil.' });
      if (!safeEqual(b.password || '', env.adminPassword)) return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
      return res.json({ ok: true, token: makeToken() });
    }
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!validToken(auth)) return res.status(401).json({ ok: false, error: 'Oturum süresi doldu.', relogin: true });

    const out = await run(b, req);
    return res.json({ ok: true, dev: env.dev, ...out });
  } catch (e) {
    console.error('[admin]', e);
    return res.status(500).json({ ok: false, error: e.message || 'Sunucu hatası.' });
  }
}

async function run(b, req) {
  const day = G.now() - 86400;
  switch (b.action) {
    case 'dash': {
      const one = async (sql) => Object.values((await query(sql))[0])[0];
      // Botun gerçek Stars bakiyesi Telegram'dan okunur (çekilebilir tutar, iadeler düşülmüş)
      const bal = await tg('getMyStarBalance');
      return {
        stats: {
          ...(bal.ok ? { 'Bot Stars bakiyesi': bal.result.amount } : {}),
          'Toplam oyuncu': await one('SELECT COUNT(*)::int FROM users'),
          'Son 24 saat yeni': await one(`SELECT COUNT(*)::int FROM users WHERE created_at > ${day}`),
          'Son 24 saat aktif': await one(`SELECT COUNT(*)::int FROM users WHERE last_seen > ${day}`),
          'Üretime başlayan': await one('SELECT COUNT(*)::int FROM users WHERE started = 1'),
          'Ödeme yapan': await one('SELECT COUNT(DISTINCT user_id)::int FROM payments WHERE refunded = 0'),
          'Toplam Stars': await one('SELECT COALESCE(SUM(stars),0)::int FROM payments WHERE refunded = 0'),
          'Son 24 saat Stars': await one(`SELECT COALESCE(SUM(stars),0)::int FROM payments WHERE refunded = 0 AND created_at > ${day}`),
          'Kripto geliri ($)': await one("SELECT COALESCE(SUM(wi.usd),0)::float FROM wallet_invoices wi JOIN payments p ON p.charge_id = 'cw-' || wi.id WHERE wi.status = 'paid' AND p.refunded = 0"),
          'Onay bekleyen kripto': await one("SELECT COUNT(*)::int FROM wallet_invoices WHERE status = 'submitted'"),
          'Bekleyen çekim': await one("SELECT COUNT(*)::int FROM withdrawals WHERE status IN ('pending','approved')"),
          'Oyuncuların ödül bakiyesi ($)': await one('SELECT COALESCE(SUM(reward_usd),0)::float FROM users'),
          'Botu engelleyen': await one('SELECT COUNT(*)::int FROM users WHERE blocked_bot = 1'),
        },
        payments: await query(`${PAY_SQL} ORDER BY p.id DESC LIMIT 10`),
      };
    }
    case 'users': {
      const q = String(b.q || '').trim();
      const order = b.sort === 'stars' ? 'stars_spent DESC' : b.sort === 'oil' ? 'oil_total DESC' : 'created_at DESC';
      return {
        users: await query(`SELECT * FROM users WHERE ($1 = '' OR id::text = $1 OR username ILIKE $2 OR first_name ILIKE $2) ORDER BY ${order} LIMIT 100`, [q, `%${q}%`]),
      };
    }
    case 'user': {
      const id = Number(b.id);
      const u = (await query('SELECT * FROM users WHERE id = $1', [id]))[0];
      if (!u) throw new Error('Kullanıcı bulunamadı.');
      const refs = (await query('SELECT COUNT(*)::int AS total, COALESCE(SUM(started),0)::int AS active FROM users WHERE ref_by = $1', [id]))[0];
      return { user: u, refs, payments: await query(`${PAY_SQL} WHERE p.user_id = $1 ORDER BY p.id DESC`, [id]) };
    }
    case 'user_save':
      await tx(async (c) => {
        const s = await G.loadSettings(c);
        const u = await G.findUser(c, Number(b.id), true);
        if (!u) throw new Error('Kullanıcı bulunamadı.');
        G.accrue(s, u);
        u.power = Math.max(0, Number(b.power) || 0);
        u.coins = Math.max(0, Number(b.coins) || 0);
        u.level = Math.max(1, Math.floor(Number(b.level) || 1));
        await G.saveUser(c, u);
        await c.query('UPDATE users SET banned = $1 WHERE id = $2', [b.banned ? 1 : 0, u.id]);
      });
      return { msg: 'Kullanıcı güncellendi.' };

    case 'payments':
      return { payments: await query(`${PAY_SQL} ORDER BY p.id DESC LIMIT 300`) };

    case 'refund':
      return { msg: await tx(async (c) => G.refundPayment(c, await G.loadSettings(c), Number(b.id))) };

    case 'products':
      return { products: await query('SELECT * FROM products ORDER BY sort, id') };

    case 'product_save': {
      const row = [String(b.title || '').trim(), String(b.description || '').trim(), Math.max(1, Math.floor(Number(b.stars) || 1)),
        ['power', 'boost', 'coins'].includes(b.type) ? b.type : 'power', Number(b.amount) || 0, Math.floor(Number(b.hours) || 0),
        Math.floor(Number(b.sort) || 0), b.active ? 1 : 0, Math.max(0, Math.round((Number(b.usd) || 0) * 100) / 100)];
      if (!row[0]) throw new Error('Başlık gerekli.');
      if (Number(b.id)) await query('UPDATE products SET title=$1, description=$2, stars=$3, type=$4, amount=$5, hours=$6, sort=$7, active=$8, usd=$9 WHERE id=$10', [...row, Number(b.id)]);
      else await query('INSERT INTO products(title, description, stars, type, amount, hours, sort, active, usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', row);
      return { msg: 'Ürün kaydedildi.' };
    }

    case 'tasks':
      return { tasks: await query('SELECT t.*, (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id) AS done FROM tasks t ORDER BY sort, id') };

    case 'task_save': {
      const row = [['invite', 'channel', 'link'].includes(b.type) ? b.type : 'link', String(b.title || '').trim(), String(b.subtitle || '').trim(),
        String(b.target || '').trim() || null, Math.floor(Number(b.count) || 0), Number(b.reward) || 0, Math.floor(Number(b.sort) || 0), b.active ? 1 : 0];
      if (!row[1]) throw new Error('Başlık gerekli.');
      if (Number(b.id)) await query('UPDATE tasks SET type=$1, title=$2, subtitle=$3, target=$4, count=$5, reward=$6, sort=$7, active=$8 WHERE id=$9', [...row, Number(b.id)]);
      else await query('INSERT INTO tasks(type, title, subtitle, target, count, reward, sort, active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', row);
      return { msg: 'Görev kaydedildi.' };
    }

    case 'settings': {
      const values = await tx((c) => G.loadSettings(c));
      return { defs: G.DEFAULT_SETTINGS, values };
    }
    case 'settings_save':
      for (const k of Object.keys(G.DEFAULT_SETTINGS)) {
        const v = b.values?.[k];
        if (v !== undefined && v !== '' && Number.isFinite(Number(v))) await query('UPDATE settings SET v = $1 WHERE k = $2', [String(Number(v)), k]);
      }
      return { msg: 'Ayarlar kaydedildi.' };

    case 'broadcasts':
      return { broadcasts: await query('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 20') };

    case 'broadcast_create': {
      const text = String(b.text || '').trim();
      if (!text) throw new Error('Mesaj boş olamaz.');
      const r = await query('INSERT INTO broadcasts(text, btn, created_at) VALUES($1,$2,$3) RETURNING id', [text, b.btn ? 1 : 0, G.now()]);
      return { id: r[0].id };
    }
    case 'broadcast_step': {
      // Bir parti mesaj gönderir; sayfa bitene kadar tekrar çağırır
      const bc = (await query('SELECT * FROM broadcasts WHERE id = $1', [Number(b.id)]))[0];
      if (!bc || bc.done) return { done: true, sent: bc?.sent ?? 0, failed: bc?.failed ?? 0 };
      const ids = (await query('SELECT id FROM users WHERE id > $1 AND blocked_bot = 0 AND banned = 0 AND id < $2 ORDER BY id LIMIT 25', [bc.cursor, G.DEV_ID_BASE])).map((r) => r.id);
      let sent = 0, failed = 0;
      for (const uid of ids) {
        const params = { chat_id: uid, text: bc.text, parse_mode: 'HTML' };
        if (bc.btn) params.reply_markup = webappKeyboard(req);
        const r = await tg('sendMessage', params);
        if (r.ok) sent++;
        else {
          failed++;
          if (r.error_code === 403) await query('UPDATE users SET blocked_bot = 1 WHERE id = $1', [uid]);
          if (r.error_code === 429) await new Promise((ok) => setTimeout(ok, (r.parameters?.retry_after || 3) * 1000));
        }
        await new Promise((ok) => setTimeout(ok, 40));
      }
      const done = ids.length < 25 ? 1 : 0;
      const r = await query('UPDATE broadcasts SET cursor = $1, sent = sent + $2, failed = failed + $3, done = $4 WHERE id = $5 RETURNING sent, failed, done',
        [ids.length ? ids[ids.length - 1] : bc.cursor, sent, failed, done, bc.id]);
      return { done: !!r[0].done, sent: r[0].sent, failed: r[0].failed };
    }

    case 'group_send': {
      // Gruba/kanala tek mesaj. Grupta web_app butonu açılmaz, bu yüzden bota giden bağlantı butonu kullanılır.
      const text = String(b.text || '').trim();
      let chat = String(b.chat || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/\/.*$/, '');
      if (!text) throw new Error('Mesaj boş olamaz.');
      if (!chat) throw new Error('Grup/kanal girin (ör. @oilusdtt).');
      if (!/^-?\d+$/.test(chat) && !chat.startsWith('@')) chat = '@' + chat;
      const params = { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true };
      if (b.btn) params.reply_markup = { inline_keyboard: [[{ text: '🛢 Oyna', url: `https://t.me/${await botUsername()}?startapp=group` }]] };
      const r = await tg('sendMessage', params);
      if (!r.ok) {
        const d = r.description || 'bilinmeyen hata';
        const hint = /not found/i.test(d) ? ' Grup adı yanlış olabilir ya da bot grupta değil.'
          : /not enough rights|administrator|forbidden|kicked/i.test(d) ? ' Botu gruba ekleyin ve mesaj gönderme yetkisi verin (kanalsa yönetici yapın).' : '';
        throw new Error('Telegram: ' + d + '.' + hint);
      }
      if (b.pin) {
        const p = await tg('pinChatMessage', { chat_id: chat, message_id: r.result.message_id, disable_notification: false });
        if (!p.ok) return { msg: `Mesaj ${chat} grubuna gönderildi ama sabitlenemedi (botun sabitleme yetkisi yok).` };
      }
      return { msg: `Mesaj ${chat} grubuna gönderildi${b.pin ? ' ve sabitlendi' : ''}.` };
    }

    case 'wallets':
      return { wallets: await query('SELECT * FROM crypto_wallets ORDER BY sort, id') };

    case 'wallet_save': {
      const row = [String(b.label || '').trim().slice(0, 30), String(b.network || '').trim().slice(0, 30), String(b.address || '').trim().slice(0, 200),
        String(b.price_id || 'usd').trim().toLowerCase().slice(0, 60) || 'usd', Math.min(Math.max(Math.floor(Number(b.decimals) || 4), 2), 8),
        /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#26a17b', Math.floor(Number(b.sort) || 0), b.enabled ? 1 : 0];
      if (!row[0] || !row[2]) throw new Error('Coin adı ve cüzdan adresi gerekli.');
      if (Number(b.id)) await query('UPDATE crypto_wallets SET label=$1, network=$2, address=$3, price_id=$4, decimals=$5, color=$6, sort=$7, enabled=$8 WHERE id=$9', [...row, Number(b.id)]);
      else await query('INSERT INTO crypto_wallets(label, network, address, price_id, decimals, color, sort, enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', row);
      return { msg: 'Cüzdan kaydedildi.' };
    }
    case 'wallet_delete':
      await query('DELETE FROM crypto_wallets WHERE id = $1', [Number(b.id)]);
      return { msg: 'Cüzdan silindi. Açık siparişler etkilenmez.' };

    case 'winvoices': {
      const st = ['submitted', 'waiting', 'paid', 'rejected', 'expired'].includes(b.status) ? b.status : 'submitted';
      return {
        status: st,
        counts: Object.fromEntries((await query('SELECT status, COUNT(*)::int AS n FROM wallet_invoices GROUP BY status')).map((r) => [r.status, r.n])),
        invoices: await query(`SELECT wi.*, u.first_name, u.username, pr.title FROM wallet_invoices wi
          LEFT JOIN users u ON u.id = wi.user_id LEFT JOIN products pr ON pr.id = wi.product_id
          WHERE wi.status = $1 ORDER BY wi.id DESC LIMIT 200`, [st]),
      };
    }
    case 'winv_approve':
      return { msg: await tx((c) => approveWalletInvoice(c, Number(b.id), req)) };
    case 'winv_reject':
      return { msg: await tx((c) => rejectWalletInvoice(c, Number(b.id), b.note, req)) };

    case 'rewards': {
      const current = R.weekKey(), previous = R.weekKey(G.now() - 7 * 86400);
      const week = /^\d{4}-W\d{2}$/.test(b.week || '') ? b.week : current;
      const s = await tx((c) => G.loadSettings(c));
      return {
        week, current, previous, pool: s.weekly_pool_usd, winners: s.weekly_winners,
        closed: (await query('SELECT * FROM reward_weeks WHERE week = $1', [week]))[0] || null,
        top: await query(`SELECT wp.user_id, wp.points, u.first_name, u.username FROM weekly_points wp JOIN users u ON u.id = wp.user_id
          WHERE wp.week = $1 AND wp.points > 0 ORDER BY wp.points DESC, wp.user_id LIMIT 100`, [week]),
        weeks: await query('SELECT * FROM reward_weeks ORDER BY week DESC LIMIT 20'),
        referrals: await query(`SELECT rr.*, a.first_name AS referrer_name, b.first_name AS referred_name FROM referral_rewards rr
          LEFT JOIN users a ON a.id = rr.referrer_id LEFT JOIN users b ON b.id = rr.referred_id ORDER BY rr.created_at DESC LIMIT 50`),
      };
    }
    case 'week_close':
      return { msg: await tx((c) => R.closeWeek(c, String(b.week), b.pool, b.winners, req)) };

    case 'reward_adjust': {
      const amt = Math.round((Number(b.amount) || 0) * 100) / 100;
      if (!amt) throw new Error('Tutar girin.');
      await tx(async (c) => {
        const u = await G.findUser(c, Number(b.id), true);
        if (!u) throw new Error('Kullanıcı bulunamadı.');
        if (u.reward_usd + amt < 0) throw new Error('Bakiye eksiye düşemez.');
        await R.credit(c, u.id, amt, 'admin', null, String(b.note || '').slice(0, 200) || null);
      });
      return { msg: 'Ödül bakiyesi güncellendi.' };
    }

    case 'withdrawals': {
      const st = ['pending', 'approved', 'paid', 'rejected'].includes(b.status) ? b.status : 'pending';
      return {
        status: st,
        counts: Object.fromEntries((await query('SELECT status, COUNT(*)::int AS n FROM withdrawals GROUP BY status')).map((r) => [r.status, r.n])),
        rows: await query(`SELECT w.*, u.first_name, u.username FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
          WHERE w.status = $1 ORDER BY w.id DESC LIMIT 200`, [st]),
        networks: await query('SELECT * FROM payout_networks ORDER BY sort, id'),
        api: !!process.env.PAYOUT_API_KEY,
      };
    }
    case 'wd_approve':
      return { msg: await tx((c) => R.approveWithdraw(c, Number(b.id))) };
    case 'wd_paid':
      return { msg: await tx((c) => R.markPaid(c, Number(b.id), b.tx_hash, req)) };
    case 'wd_reject':
      return { msg: await tx((c) => R.rejectWithdraw(c, Number(b.id), b.note, req)) };

    case 'pnet_save': {
      const row = [String(b.label || '').trim().slice(0, 30), String(b.network || '').trim().slice(0, 30),
        Math.max(0, Number(b.min_usd) || 0), Math.max(0, Number(b.fee_usd) || 0),
        /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#26a17b', Math.floor(Number(b.sort) || 0), b.enabled ? 1 : 0];
      if (!row[0]) throw new Error('Coin adı gerekli.');
      if (Number(b.id)) await query('UPDATE payout_networks SET label=$1, network=$2, min_usd=$3, fee_usd=$4, color=$5, sort=$6, enabled=$7 WHERE id=$8', [...row, Number(b.id)]);
      else await query('INSERT INTO payout_networks(label, network, min_usd, fee_usd, color, sort, enabled) VALUES($1,$2,$3,$4,$5,$6,$7)', row);
      return { msg: 'Çekim yöntemi kaydedildi.' };
    }
    case 'pnet_delete':
      await query('DELETE FROM payout_networks WHERE id = $1', [Number(b.id)]);
      return { msg: 'Çekim yöntemi silindi.' };

    case 'setup_info': {
      const [me, wh] = await Promise.all([tg('getMe'), tg('getWebhookInfo')]);
      return { me, wh, webapp: webappUrl(req), webhook: webappUrl(req) + 'api/bot' };
    }
    case 'setup_run': {
      const out = [];
      const st = (r) => (r.ok ? 'tamam' : r.description || 'hata');
      out.push('Webhook: ' + st(await tg('setWebhook', { url: webappUrl(req) + 'api/bot', secret_token: env.secret, allowed_updates: ['message', 'pre_checkout_query'] })));
      out.push('Menü butonu: ' + st(await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Oyna', web_app: { url: webappUrl(req) } } })));
      out.push('Komutlar: ' + st(await tg('setMyCommands', { commands: [{ command: 'start', description: 'Oyunu başlat' }, { command: 'sss', description: 'Sık sorulan sorular' }, { command: 'paysupport', description: 'Ödeme desteği' }] })));
      return { msg: out.join(' · ') };
    }
  }
  throw new Error('Bilinmeyen işlem.');
}
