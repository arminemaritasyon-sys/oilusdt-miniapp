// Cashable petroleum revenue is moved out of game coins in one database transaction.
// The original game implementation is preserved in game_original.js.
import * as Core from './game_original.js';
import { credit } from './rewards.js';
import { tg } from './tg.js';
export * from './game_original.js';

const cents = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/** Silinmiş hesabı açan oyuncu eski davetini yeniden kullandırıp bonus üretemez. */
export async function ensureUser(c, settings, telegramUser, ref) {
  const previous = (await c.query(
    'SELECT 1 FROM account_resets WHERE user_id=$1', [Number(telegramUser.id)]
  )).rows[0];
  return Core.ensureUser(c, settings, telegramUser, previous ? null : ref);
}


/**
 * Tek seferlik: oyuncunun çekilebilir bakiye sistemi gelmeden önce biriktirdiği oyun coinlerini
 * 1 Coin = 1 USD olarak çekilebilir bakiyeye taşır. Mevcut oyuncular coins_migrated = 0 ile,
 * sonradan kayıt olanlar 1 ile başlar (lib/db.js). Kullanıcı satırı ensureUser'da FOR UPDATE ile
 * kilitli olduğundan aynı anda gelen iki istek coini iki kez aktaramaz.
 */
export async function migrateLegacyCoins(c, user) {
  if (Number(user.coins_migrated) !== 0) return 0;
  const cash = cents(Math.max(0, Number(user.coins) || 0));
  await c.query('UPDATE users SET coins = 0, coins_migrated = 1 WHERE id = $1 AND coins_migrated = 0', [user.id]);
  user.coins = 0;
  user.coins_migrated = 1;
  if (cash > 0) await credit(c, user.id, cash, 'coin_migration', null, 'Mevcut coin aktarımı');
  return cash;
}

// `ref_share` toplam bütçedir; 9 kat ayrı ayrı ödenmez.
const WEIGHTS=Object.freeze([0.4,0.2,0.1,0.08,0.06,0.05,0.04,0.04,0.03]);
export function referralRates(settings) {
  const total=Math.max(0,Math.min(0.2,Number(settings.ref_share)||0));
  return WEIGHTS.map(w=>total*w);
}
export async function shopProducts(c, userId) {
  const products = await Core.shopProducts(c, userId);
  const marker = (await c.query(
    'SELECT payments_before_id FROM account_resets WHERE user_id=$1', [userId]
  )).rows[0];
  if (marker) {
    const owned = (await c.query(
      'SELECT product_id, COUNT(*)::int AS n FROM payments WHERE user_id=$1 AND id>$2 AND refunded=0 GROUP BY product_id',
      [userId, marker.payments_before_id]
    )).rows;
    const count = new Map(owned.map(row => [row.product_id, row.n]));
    for (const product of products) product.owned = count.get(product.id) || 0;
  }
  return products.map(p => ({...p, locked:false, requires:null}));
}
const istanbulDay = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(date);

export async function freeDailyOilRemaining(c, settings, user) {
  if (Number(user.paid_count) > 0) return null;
  const limitCents = Math.max(0, Math.floor((Number(settings.free_daily_oil_usd) || 0) * 100 + 1e-8));
  const row = (await c.query(
    'SELECT earned_cents FROM free_oil_sales WHERE user_id=$1 AND day=$2',
    [user.id, istanbulDay()]
  )).rows[0];
  return Math.max(0, limitCents - Number(row?.earned_cents || 0)) / 100;
}

export async function actSell(c, settings, user) {
  Core.accrue(settings, user);
  const price = Number(settings.oil_price);
  if (!(price > 0) || !Number.isFinite(price)) throw new Core.GameError('Petrol fiyatı geçersiz.');
  if (user.oil < 1e-9) throw new Core.GameError('Satılacak petrol yok.');

  // ensureUser, bu işlem sırasında users satırını FOR UPDATE ile kilitler.
  let saleCents = Math.max(0, Math.round(user.oil * price * 100));
  if (Number(user.paid_count) === 0) {
    const remaining = await freeDailyOilRemaining(c, settings, user);
    saleCents = Math.min(Math.max(0, Math.floor(user.oil * price * 100 + 1e-8)), Math.round(remaining * 100));
    if (saleCents < 1) {
      if (remaining < 0.01) throw new Core.GameError('Bugünkü $0,05 petrol satış limitin doldu. Yarın yeniden satabilirsin.');
      throw new Core.GameError('Satış için en az $0,01 değerinde petrol birikmesini bekle.');
    }
    // Günlük limit tablosu silinen hesapla birlikte temizlenmez.
    await c.query(
      `INSERT INTO free_oil_sales(user_id,day,earned_cents) VALUES($1,$2,$3)
       ON CONFLICT(user_id,day) DO UPDATE SET earned_cents=free_oil_sales.earned_cents + EXCLUDED.earned_cents`,
      [user.id, istanbulDay(), saleCents]
    );
    user.oil = Math.max(0, user.oil - saleCents / (price * 100));
  } else {
    if (saleCents < 1) throw new Core.GameError('Satış için en az $0,01 değerinde petrol birikmesini bekle.');
    user.oil = 0;
  }

  const earned = saleCents / 100;
  await credit(c, user.id, earned, 'oil_sale', null, 'Petrol satışı');
  const rates=referralRates(settings),seen=new Set([String(user.id)]);
  let parentId=user.ref_by;
  for(let level=0;level<9&&parentId;level++){
    if(seen.has(String(parentId)))break;
    seen.add(String(parentId));
    const {rows}=await c.query('SELECT id,ref_by FROM users WHERE id=$1 AND banned=0',[parentId]);
    const parent=rows[0];
    if(!parent)break;
    const bonus=cents(earned*rates[level]);
    if(bonus>0){
      await c.query('UPDATE users SET ref_earned=ref_earned+$1 WHERE id=$2',[bonus,parent.id]);
      await credit(c,parent.id,bonus,'oil_referral',String(user.id),`${level+1}. seviye petrol referans payı`);
    }
    parentId=parent.ref_by;
  }
  return earned;
}

/** Güncel ödül/USD bakiyesiyle veya ayrı oyun Coin'iyle pompa yükselt. */
export async function actUpgrade(c, s, user) {
  Core.accrue(s, user);
  if (user.level >= s.max_level) throw new Core.GameError('Pompa maksimum seviyede.');
  const cost = Core.upgradeCost(s, user.level);
  if (!Number.isFinite(cost) || cost <= 0) throw new Core.GameError('Geçersiz yükseltme maliyeti.');

  // Coin olarak görünen bakiye = çekilebilir USD bakiyesi.
  // Satın alınan oyun Coin'leri bu yükseltmede harcanamaz.
  const { rows } = await c.query(
    'UPDATE users SET reward_usd=reward_usd-$1 WHERE id=$2 AND reward_usd >= $1 RETURNING reward_usd',
    [cost, user.id]
  );
  if (!rows[0]) throw new Core.GameError('Yükseltme için yeterli Coin bakiyen yok.');
  await c.query(
    'INSERT INTO reward_ledger(user_id,kind,amount,ref,note,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [user.id, 'upgrade', -cost, String(user.level + 1), 'Pompa yükseltmesi', Core.now()]
  );
  user.level += 1;
  return { source: 'reward_usd', cost, balance: Number(rows[0].reward_usd) };
}

/** Önceki oyun hesabına ait bir alışveriş iade edilirse yeni hesabın gücünü düşürme. */
export async function refundPayment(c, settings, paymentId) {
  const payment=(await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[paymentId])).rows[0];
  if(!payment) return 'Ödeme bulunamadı.';
  const marker=(await c.query('SELECT payments_before_id FROM account_resets WHERE user_id=$1',[payment.user_id])).rows[0];
  if(!marker || Number(payment.id) > Number(marker.payments_before_id))
    return Core.refundPayment(c,settings,paymentId);
  if(payment.refunded) return 'Bu ödeme zaten iade edilmiş.';
  const crypto=/^c[pw]-/.test(String(payment.charge_id));
  if(!crypto && !String(payment.charge_id).startsWith('dev-')) {
    const result=await tg('refundStarPayment',{user_id:payment.user_id,telegram_payment_charge_id:payment.charge_id});
    if(!result.ok) return 'Telegram iadeyi reddetti: '+(result.description||'bilinmeyen hata');
  }
  await c.query('UPDATE payments SET refunded=1 WHERE id=$1',[paymentId]);
  return crypto
    ? 'Önceki hesaba ait ürün kapatıldı. Kripto iadesi gerekiyorsa manuel işlem yapın.'
    : 'Önceki hesaba ait ödeme iade edildi. Yeni oyuncu hesabı etkilenmedi.';
}
