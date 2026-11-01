// Cashable petroleum revenue is moved out of game coins in one database transaction.
// The original game implementation is preserved in game_original.js.
import * as Core from './game_original.js';
import { credit } from './rewards.js';
import { tg, parseReferralCode } from './tg.js';
export * from './game_original.js';

const cents = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/** Silinmiş hesabı açan oyuncu eski davetini yeniden kullandırıp bonus üretemez. */
export async function ensureUser(c, settings, telegramUser, ref) {
  const previous = (await c.query(
    'SELECT 1 FROM account_resets WHERE user_id=$1', [Number(telegramUser.id)]
  )).rows[0];
  const refCode = previous ? null : parseReferralCode(ref);
  const user = await Core.ensureUser(c, settings, telegramUser, refCode);
  // Botun /start işlemi ilk kaydı referanssız açtıysa, yalnızca henüz
  // oynamamış/alışveriş yapmamış çok yeni hesaplarda daveti kurtar.
  // Aktif/eski kullanıcıların davetçisini sonradan değiştirme.
  if (!previous && refCode && !user.ref_by && !user.started && !user.paid_count
      && Core.now() - Number(user.created_at) <= 15 * 60) {
    const parentId = Number(refCode.slice(1));
    if (Number.isSafeInteger(parentId) && parentId !== Number(user.id)) {
      const parent = (await c.query('SELECT id FROM users WHERE id=$1 AND banned=0', [parentId])).rows[0];
      if (parent) {
        const { rows } = await c.query(`UPDATE users SET ref_by=$1
          WHERE id=$2 AND ref_by IS NULL AND started=0 AND paid_count=0 AND created_at >= $3
          RETURNING ref_by`, [parentId, user.id, Core.now() - 15 * 60]);
        if (rows[0]) user.ref_by = rows[0].ref_by;
      }
    }
  }
  return user;
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
// Günlük limit, Türkiye saati ile aynı takvim gününde yapılan petrol satışlarına
// uygulanır. Geçmişte biriken petrol veya gün içinde tekrarlanan SAT işlemleri
// toplam 0,05 USD sınırını geçemez.
const istanbulDayStart = (t) => Math.floor((t + 10800) / 86400) * 86400 - 10800;
export async function starterRemainingCents(c, userId, timestamp = Core.now()) {
  const start = istanbulDayStart(timestamp);
  const { rows } = await c.query(`
    SELECT COALESCE(SUM(amount), 0)::float AS earned
    FROM reward_ledger
    WHERE user_id=$1 AND kind='oil_sale' AND created_at >= $2
      AND id > COALESCE(
        (SELECT ledger_before_id FROM account_resets WHERE user_id=$1), 0
      )`, [userId, start]);
  const used = Math.max(0, Math.round(Number(rows[0]?.earned || 0) * 100));
  return Math.max(0, 5 - used);
}

/**
 * 0,01 USD altındaki komisyonlar kaybolmaz; 1/1.000.000 USD hassasiyetle
 * biriktirilir, yalnızca tam kuruş olunca ödül bakiyesine aktarılır.
 * Bütün işlemler satışla aynı veritabanı transaction'ında gerçekleşir.
 */
async function accrueReferralCommission(c, referrerId, usdShare, referredId, level) {
  const delta = Math.round(Math.max(0, usdShare) * 1000000);
  if (delta <= 0) return;
  const { rows } = await c.query(`INSERT INTO referral_commission_carry(user_id, micro_usd)
    VALUES($1,$2) ON CONFLICT(user_id)
    DO UPDATE SET micro_usd=referral_commission_carry.micro_usd+EXCLUDED.micro_usd
    RETURNING micro_usd`, [referrerId, delta]);
  const centsDue = Math.floor(Number(rows[0].micro_usd) / 10000);
  if (centsDue <= 0) return;
  await c.query('UPDATE referral_commission_carry SET micro_usd=micro_usd-$1 WHERE user_id=$2',
    [centsDue * 10000, referrerId]);
  const bonus = centsDue / 100;
  await c.query('UPDATE users SET ref_earned=ref_earned+$1 WHERE id=$2', [bonus, referrerId]);
  await credit(c, referrerId, bonus, 'oil_referral', String(referredId),
    `${level+1}. seviye petrol referans payı`);
}

export async function actSell(c, settings, user) {
  Core.accrue(settings, user);
  if (user.oil < 1e-9) throw new Core.GameError('Satılacak petrol yok.');
  const unitPrice = Number(settings.oil_price);
  const earned = user.oil * unitPrice;
  if (!Number.isFinite(earned) || earned <= 0) throw new Core.GameError('Geçersiz petrol kazancı.');

  const starter = Core.isStarterPump(user);
  let cash;
  if (starter) {
    const remaining = await starterRemainingCents(c, user.id);
    if (remaining <= 0)
      throw new Core.GameError('Bugünkü $0,05 sondaj satış sınırına ulaştın. Yarın tekrar satış yapabilirsin.');
    cash = Math.min(remaining, Math.max(0, Math.floor(earned * 100 + 1e-8))) / 100;
    if (cash <= 0)
      throw new Core.GameError('Petrolün henüz $0,01 değerine ulaşmadı. Sondaja devam et.');
    // Limitten fazlası henüz birikmişse kalan petrolü silmeden sakla.
    user.oil = Math.max(0, user.oil - cash / unitPrice);
  } else {
    cash = cents(earned);
    user.oil = 0;
  }

  if (cash > 0) await credit(c, user.id, cash, 'oil_sale', null, 'Petrol satışı');
  const rates = referralRates(settings);
  const seen = new Set([String(user.id)]);
  let parentId = user.ref_by;
  for (let level=0; level < rates.length && parentId; level++) {
    if (seen.has(String(parentId))) break;
    seen.add(String(parentId));
    const { rows } = await c.query('SELECT id,ref_by FROM users WHERE id=$1 AND banned=0', [parentId]);
    const parent = rows[0];
    if (!parent) break;
    await accrueReferralCommission(c, parent.id, cash * rates[level], user.id, level);
    parentId = parent.ref_by;
  }
  return cash;
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
