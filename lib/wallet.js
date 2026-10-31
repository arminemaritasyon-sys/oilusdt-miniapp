// Kendi cüzdanınıza kripto ödeme. Oyuncu gösterilen adrese tam tutarı gönderir, admin panelinden elle onaylanır.
import * as G from './game.js';
import { tg, webappKeyboard, env } from './tg.js';

const WAIT_SECS = 2 * 3600;   // Ödeme bildirilmeden bu süre geçerse sipariş düşer (kur sabitliği için)

const nf = (n) => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 0 });

/** Oyunda gösterilecek açık cüzdanlar. */
export async function activeWallets(c) {
  return (await c.query("SELECT id, label, network, color FROM crypto_wallets WHERE enabled = 1 AND address <> '' ORDER BY sort, id")).rows;
}

const priceCache = new Map();
/** CoinGecko'dan USD kuru (60 sn önbellek). price_id 'usd' ise 1 kabul edilir. */
async function usdPrice(priceId) {
  if (!priceId || priceId === 'usd') return 1;
  const hit = priceCache.get(priceId);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  let v;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(priceId)}&vs_currencies=usd`, { signal: AbortSignal.timeout(8000) });
    v = (await r.json())?.[priceId]?.usd;
  } catch {}
  if (!v) throw new G.GameError('Kur bilgisi alınamadı, biraz sonra tekrar dene.');
  priceCache.set(priceId, { v, t: Date.now() });
  return v;
}

/** Süresi geçmiş, bildirilmemiş siparişleri kapatır. */
async function expireOld(c) {
  await c.query("UPDATE wallet_invoices SET status = 'expired' WHERE status = 'waiting' AND created_at < $1", [G.now() - WAIT_SECS]);
}

/**
 * Paket için ödeme siparişi açar. Aynı cüzdanda bekleyen siparişlerle karışmasın diye
 * tutarın son hanelerine benzersiz bir fark eklenir; admin ödemeyi bu tutardan tanır.
 */
export async function createWalletInvoice(c, user, product, walletId) {
  await expireOld(c);
  const w = (await c.query("SELECT * FROM crypto_wallets WHERE id = $1 AND enabled = 1 AND address <> ''", [walletId])).rows[0];
  if (!w) throw new G.GameError('Bu ödeme yöntemi şu anda kapalı.');

  // Oyuncunun aynı paket ve cüzdan için açık siparişi varsa onu göster
  const open = (await c.query("SELECT * FROM wallet_invoices WHERE user_id = $1 AND product_id = $2 AND wallet_id = $3 AND status IN ('waiting','submitted') ORDER BY id DESC LIMIT 1",
    [user.id, product.id, w.id])).rows[0];
  if (open) return publicInvoice(open);

  const decimals = Math.min(Math.max(Number(w.decimals) || 4, 2), 8);
  const unit = 10 ** -decimals;
  const base = product.usd / (await usdPrice(w.price_id));
  for (let i = 0; i < 40; i++) {
    const k = 1 + Math.floor(Math.random() * 99);
    const amount = (Math.ceil(base / unit) * unit + k * unit).toFixed(decimals);
    const clash = (await c.query("SELECT 1 FROM wallet_invoices WHERE wallet_id = $1 AND amount = $2 AND status IN ('waiting','submitted')", [w.id, amount])).rows[0];
    if (clash) continue;
    const row = (await c.query(`INSERT INTO wallet_invoices(user_id, product_id, usd, wallet_id, label, network, address, amount, created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [user.id, product.id, product.usd, w.id, w.label, w.network, w.address, amount, G.now()])).rows[0];
    return publicInvoice(row);
  }
  throw new G.GameError('Şu anda ödeme oluşturulamadı, biraz sonra tekrar dene.');
}

export function publicInvoice(r) {
  return {
    id: r.id, label: r.label, network: r.network, address: r.address, amount: r.amount, usd: r.usd,
    status: r.status, tx_hash: r.tx_hash, expires_at: Number(r.created_at) + WAIT_SECS,
  };
}

/** Oyuncu "gönderdim" dediğinde sipariş onay kuyruğuna girer ve adminlere haber verilir. */
export async function submitWalletInvoice(c, user, id, txHash) {
  await expireOld(c);
  const r = (await c.query('SELECT * FROM wallet_invoices WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, user.id])).rows[0];
  if (!r) throw new G.GameError('Ödeme bulunamadı.');
  if (r.status === 'expired') throw new G.GameError('Bu ödemenin süresi doldu. Yeni ödeme oluştur.');
  if (r.status !== 'waiting' && r.status !== 'submitted') return publicInvoice(r);
  const tx = String(txHash || '').trim().slice(0, 140) || null;
  const row = (await c.query("UPDATE wallet_invoices SET status = 'submitted', submitted_at = $1, tx_hash = COALESCE($2, tx_hash) WHERE id = $3 RETURNING *",
    [G.now(), tx, id])).rows[0];
  return { invoice: publicInvoice(row), notify: r.status === 'waiting' || (tx && tx !== r.tx_hash) ? row : null };
}

export async function notifyAdminsSubmitted(row, user, productTitle) {
  for (const aid of env.adminIds) {
    await tg('sendMessage', {
      chat_id: aid, parse_mode: 'HTML',
      text: `💎 <b>Onay bekleyen kripto ödemesi #${row.id}</b>\n`
        + `Paket: ${productTitle || '-'}\n`
        + `Tutar: <code>${row.amount}</code> ${row.label} (${row.network})\n`
        + `Değeri: ${row.usd} $\nOyuncu: ${user.first_name || ''} (${user.id})\n`
        + (row.tx_hash ? `TX: <code>${row.tx_hash}</code>\n` : '')
        + '\nAdmin paneli → Kripto ödemeler bölümünden onaylayın.',
    });
  }
}

/** Admin onayı: ürünü verir ve oyuncuya bildirir. */
export async function approveWalletInvoice(c, id, req) {
  const r = (await c.query('SELECT * FROM wallet_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) throw new Error('Ödeme bulunamadı.');
  if (r.status === 'paid') return 'Bu ödeme zaten onaylanmış.';
  // Eski profil silindikten sonra açılan yeni oyuna geçmiş kripto ödemesinden
  // paket vermeyelim. Ödeme kaydı denetimde kalır; yönetici iadeyi çözebilir.
  const reset = (await c.query(
    'SELECT deleted_at FROM account_resets WHERE user_id=$1', [r.user_id]
  )).rows[0];
  if (reset && Number(r.created_at) <= Number(reset.deleted_at)) {
    throw new Error('Bu kripto siparişi, oyuncunun silinen eski hesabına ait. Yeni hesabına paket yüklenemez. Ödemeyi kontrol edip manuel iade/çözüm sağlayın.');
  }
  const product = await G.findProduct(c, r.product_id, false);
  if (!product) throw new Error('Ürün bulunamadı.');
  const s = await G.loadSettings(c);
  const granted = await G.grantPurchase(c, s, r.user_id, product, 0, 'cw-' + r.id);
  await c.query("UPDATE wallet_invoices SET status = 'paid', paid_at = $1 WHERE id = $2", [G.now(), id]);
  if (granted && r.user_id < G.DEV_ID_BASE) {
    const what = granted.power ? `+${nf(granted.power)} güç` : granted.coins ? `+${nf(granted.coins)} oyun parası` : `${granted.boost_secs / 3600} saat Turbo`;
    await tg('sendMessage', { chat_id: r.user_id, text: `✅ Kripto ödemen onaylandı: ${product.title}\n${what} hesabına eklendi.`, reply_markup: webappKeyboard(req) });
  }
  return 'Ödeme onaylandı, paket verildi.';
}

export async function rejectWalletInvoice(c, id, note, req) {
  const r = (await c.query('SELECT * FROM wallet_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) throw new Error('Ödeme bulunamadı.');
  if (r.status === 'paid') throw new Error('Onaylanmış ödeme reddedilemez; Ödemeler sayfasından iade edin.');
  await c.query("UPDATE wallet_invoices SET status = 'rejected', note = $1 WHERE id = $2", [String(note || '').slice(0, 300) || null, id]);
  if (r.user_id < G.DEV_ID_BASE && r.status === 'submitted') {
    await tg('sendMessage', { chat_id: r.user_id, text: `❌ ${r.amount} ${r.label} tutarındaki ödemen doğrulanamadı.${note ? '\nNot: ' + note : ''}\nBir hata olduğunu düşünüyorsan /paysupport yaz.`, reply_markup: webappKeyboard(req) });
  }
  return 'Ödeme reddedildi.';
}
