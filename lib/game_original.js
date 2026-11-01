// Oyun ekonomisi. Tüm fonksiyonlar açık bir işlem (transaction) içindeki istemci (c) ile çalışır.
import { tg, webappKeyboard } from './tg.js';

/** Admin panelinden düzenlenebilen ekonomi ayarları. */
export const DEFAULT_SETTINGS = {
  start_power: { v: 1000, label: 'Başlangıç gücü' },
  oil_per_kpower_hour: { v: 1, label: '1000 güç başına saatlik petrol' },
  shift_hours: { v: 12, label: 'Vardiya süresi (saat)' },
  oil_price: { v: 10, label: '1 petrolün satış fiyatı (oyun parası)' },
  upgrade_base: { v: 100, label: 'İlk yükseltme maliyeti' },
  upgrade_growth: { v: 1.7, label: 'Yükseltme maliyet çarpanı' },
  level_bonus: { v: 0.15, label: 'Seviye başına üretim artışı (0.15 = %15)' },
  max_level: { v: 30, label: 'Maksimum pompa seviyesi' },
  boost_mult: { v: 2, label: 'Turbo çarpanı' },
  ref_power: { v: 200, label: 'Üretime başlayan her arkadaş için güç' },
  ref_share: { v: 0.1, label: 'Arkadaşın satışından pay (0.10 = %10, oyun parası)' },
  free_daily_oil_usd: { v: 0.05, label: 'Paket almamış oyuncuların günlük petrol satış üst sınırı ($)' },
  first_buy_bonus: { v: 0.3, label: 'İlk Stars alışverişi bonusu (0.30 = %30)' },
  daily_base: { v: 50, label: 'Günlük ödül (× seri günü, en fazla 7)' },
  crypto_enabled: { v: 1, label: 'Kripto cüzdana ödeme (1 = açık, 0 = kapalı)' },
  weekly_pool_usd: { v: 0, label: 'Haftalık ödül havuzu ($) – kendi bütçenizden' },
  weekly_winners: { v: 20, label: 'Haftalık ödül kazanan sayısı' },
  points_shift: { v: 10, label: 'Ödül puanı: vardiya başlatma' },
  points_daily: { v: 5, label: 'Ödül puanı: günlük ödül alma' },
  points_task: { v: 20, label: 'Ödül puanı: görev tamamlama' },
  ref_reward_usd: { v: 0.1, label: 'Referans ödülü ($ / aktif arkadaş)' },
  ref_reward_days: { v: 7, label: 'Referans ödülü için arkadaşın oynaması gereken gün' },
  ref_reward_monthly_cap: { v: 5, label: 'Oyuncu başı aylık referans ödülü sınırı ($)' },
  ref_reward_month_budget: { v: 100, label: 'Toplam aylık referans ödülü bütçesi ($)' },
  withdraw_enabled: { v: 1, label: 'Ödül çekimi (1 = açık, 0 = kapalı)' },
  withdraw_min_usd: { v: 5, label: 'En az çekim tutarı ($)' },
  withdraw_auto_approve: { v: 0, label: 'Çekim taleplerini otomatik onayla (1 = evet)' },
  maintenance: { v: 0, label: 'Bakım modu (1 = açık)' },
};

export class GameError extends Error {}

export const now = () => Math.floor(Date.now() / 1000);
const ymd = (days = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(Date.now() + days * 86400000));
const DEV_ID_BASE = 1000000000000;

export async function loadSettings(c) {
  const s = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, d]) => [k, d.v]));
  for (const r of (await c.query('SELECT k, v FROM settings')).rows) s[r.k] = Number(r.v);
  return s;
}

/* ---------- Kullanıcı ---------- */

export async function findUser(c, id, lock = false) {
  const { rows } = await c.query(`SELECT * FROM users WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] || null;
}

/** Kullanıcıyı kilitleyerek getirir; yoksa oluşturur. Davet kodu yalnızca ilk kayıtta işlenir. */
export async function ensureUser(c, s, t, ref) {
  const id = Number(t.id);
  const ts = now();
  const existing = await findUser(c, id, true);
  if (existing) {
    await c.query('UPDATE users SET username = $1, first_name = $2, lang = $3, last_seen = $4, blocked_bot = 0 WHERE id = $5',
      [t.username ?? null, t.first_name ?? '', t.language_code ?? null, ts, id]);
    return { ...existing, username: t.username ?? null, first_name: t.first_name ?? '' };
  }
  let refBy = null;
  const m = /^r?(\d+)$/.exec(String(ref || ''));
  if (m && Number(m[1]) !== id && (await findUser(c, Number(m[1])))) refBy = Number(m[1]);
  await c.query(`INSERT INTO users(id, username, first_name, lang, ref_by, power, created_at, last_seen)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (id) DO NOTHING`,
    [id, t.username ?? null, t.first_name ?? '', t.language_code ?? null, refBy, s.start_power, ts]);
  return findUser(c, id, true);
}

export async function saveUser(c, u) {
  await c.query(`UPDATE users SET power=$1, level=$2, coins=$3, oil=$4, oil_total=$5, shift_end=$6, last_calc=$7, boost_until=$8,
    started=$9, paid_count=$10, stars_spent=$11, ref_earned=$12, daily_last=$13, daily_streak=$14 WHERE id=$15`,
    [u.power, u.level, u.coins, u.oil, u.oil_total, u.shift_end, u.last_calc, u.boost_until,
      u.started, u.paid_count, u.stars_spent, u.ref_earned, u.daily_last, u.daily_streak, u.id]);
}

/* ---------- Üretim ---------- */

const levelMult = (s, level) => 1 + (level - 1) * s.level_bonus;
export const ratePerHour = (s, u) => {
  if (Number(u.paid_count) === 0) {
    const limit = Math.max(0, Number(s.free_daily_oil_usd) || 0);
    const price = Number(s.oil_price), hours = Number(s.shift_hours);
    // Tek vardiyada $0.05; ikinci vardiyada satış limiti yine günlük 5 sent.
    return price > 0 && hours > 0 ? limit / (price * hours) : 0;
  }
  return (u.power / 1000) * s.oil_per_kpower_hour * levelMult(s, u.level);
};
export const upgradeCost = (s, level) => Math.round(s.upgrade_base * s.upgrade_growth ** (level - 1));

/** Son hesaplamadan bu yana biriken petrolü ekler. Güç değişmeden önce mutlaka çağrılmalı. */
export function accrue(s, u, t = now()) {
  if (!u.shift_end) return;
  const from = Number(u.last_calc), to = Math.min(t, Number(u.shift_end));
  if (to <= from) return;
  const perSec = ratePerHour(s, u) / 3600;
  const boosted = Number(u.paid_count) > 0 ? Math.max(0, Math.min(to, Number(u.boost_until)) - from) : 0;
  const oil = perSec * (to - from + boosted * (s.boost_mult - 1));
  u.oil += oil;
  u.oil_total += oil;
  u.last_calc = to;
}

export function publicState(s, u) {
  const t = now();
  const running = !!u.shift_end && t < u.shift_end;
  const boost = Number(u.paid_count) > 0 && u.boost_until > t;
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    now: t,
    power: Math.round(u.power),
    level: u.level,
    max_level: s.max_level,
    coins: round(u.coins, 4),
    oil: round(u.oil, 8),
    oil_total: round(u.oil_total, 2),
    rate_hour: round(ratePerHour(s, u) * (boost ? s.boost_mult : 1), 8),
    rate_per_kpower: round(s.oil_per_kpower_hour * levelMult(s, u.level), 5),
    oil_price: s.oil_price,
    running,
    shift_end: running ? u.shift_end : null,
    shift_hours: s.shift_hours,
    boost_until: boost ? u.boost_until : null,
    boost_mult: s.boost_mult,
    upgrade_cost: u.level < s.max_level ? upgradeCost(s, u.level) : null,
    next_mult: round(levelMult(s, u.level + 1) / levelMult(s, u.level), 4),
    paid_count: u.paid_count,
    first_buy: u.paid_count === 0,
    free_daily_oil_usd: u.paid_count === 0 ? Math.max(0, Number(s.free_daily_oil_usd) || 0) : null,
    first_bonus: s.first_buy_bonus,
  };
}

/* ---------- Eylemler ---------- */

export async function actStart(c, s, u, req) {
  const t = now();
  accrue(s, u, t);
  if (u.shift_end && t < u.shift_end) throw new GameError('Pompa zaten çalışıyor.');
  u.shift_end = t + Math.round(s.shift_hours * 3600);
  u.last_calc = t;
  if (!u.started) {
    u.started = 1;
    const r = u.ref_by && (await findUser(c, u.ref_by, true));
    if (r) {
      accrue(s, r, t);
      r.power += s.ref_power;
      await saveUser(c, r);
      await notify(c, r.id, `⚡ Arkadaşın ${u.first_name || 'bir oyuncu'} üretime başladı. +${s.ref_power} güç kazandın!`, req);
    }
  }
}

export async function actSell(c, s, u) {
  accrue(s, u);
  if (u.oil < 0.00001) throw new GameError('Satılacak petrol yok.');
  const earned = u.oil * s.oil_price;
  u.coins += earned;
  u.oil = 0;
  // Davet eden kişiye bonus: arkadaşın kazancından kesilmez, ayrıca oyun parası olarak üretilir.
  const r = u.ref_by && s.ref_share > 0 && (await findUser(c, u.ref_by, true));
  if (r) {
    const bonus = earned * s.ref_share;
    r.coins += bonus;
    r.ref_earned += bonus;
    await saveUser(c, r);
  }
  return earned;
}

export function actUpgrade(s, u) {
  accrue(s, u);
  if (u.level >= s.max_level) throw new GameError('Pompa maksimum seviyede.');
  const cost = upgradeCost(s, u.level);
  if (u.coins < cost) throw new GameError('Yeterli paran yok.');
  u.coins -= cost;
  u.level += 1;
}

export function dailyInfo(s, u) {
  const claimed = u.daily_last === ymd();
  const streak = claimed || u.daily_last === ymd(-1) ? u.daily_streak : 0;
  return { claimed, streak, next: s.daily_base * Math.min(streak + 1, 7) };
}

export function actDaily(s, u) {
  if (u.daily_last === ymd()) throw new GameError('Bugünkü ödülünü zaten aldın.');
  const streak = u.daily_last === ymd(-1) ? u.daily_streak + 1 : 1;
  const reward = s.daily_base * Math.min(streak, 7);
  u.coins += reward;
  u.daily_last = ymd();
  u.daily_streak = streak;
  return reward;
}

export async function countStartedRefs(c, id) {
  const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM users WHERE ref_by = $1 AND started = 1', [id]);
  return rows[0].n;
}

export async function actTask(c, s, u, taskId) {
  const t = (await c.query('SELECT * FROM tasks WHERE id = $1 AND active = 1', [taskId])).rows[0];
  if (!t) throw new GameError('Görev bulunamadı.');
  const done = (await c.query('SELECT 1 FROM user_tasks WHERE user_id = $1 AND task_id = $2', [u.id, taskId])).rows[0];
  if (done) throw new GameError('Bu görevi zaten tamamladın.');

  if (t.type === 'invite') {
    if ((await countStartedRefs(c, u.id)) < t.count) throw new GameError('Henüz yeterli aktif arkadaşın yok.');
  } else if (t.type === 'channel') {
    const r = await tg('getChatMember', { chat_id: t.target, user_id: u.id });
    if (!['member', 'administrator', 'creator', 'restricted'].includes(r.result?.status)) {
      throw new GameError('Kanala abone olmadın. Abone olduktan sonra tekrar dene.');
    }
  }
  // 'link' görevleri bağlantı açıldıktan sonra onaylanır.
  accrue(s, u);
  u.power += t.reward;
  await c.query('INSERT INTO user_tasks(user_id, task_id, done_at) VALUES($1,$2,$3)', [u.id, taskId, now()]);
  return t.reward;
}

/* ---------- Stars ödemeleri ---------- */

/**
 * Mağaza listesi. Güç paketleri sırayla açılır: bir paket alınmadan sonraki kilitli kalır.
 * Turbo ve para paketleri her zaman açıktır.
 */
export async function shopProducts(c, userId) {
  const products = (await c.query('SELECT id, title, description, stars, usd, type, amount, hours FROM products WHERE active = 1 ORDER BY sort, id')).rows;
  const owned = new Map((await c.query('SELECT product_id, COUNT(*)::int AS n FROM payments WHERE user_id = $1 AND refunded = 0 GROUP BY product_id', [userId]))
    .rows.map((r) => [r.product_id, r.n]));
  let step = 0, prevOwned = true, prevTitle = null;
  for (const p of products) {
    p.owned = owned.get(p.id) || 0;
    p.locked = false;
    if (p.type === 'power') {
      p.step = ++step;
      p.locked = !prevOwned;
      p.requires = p.locked ? prevTitle : null;
      prevOwned = p.owned > 0;
      prevTitle = p.title;
    }
  }
  return products;
}

export async function findProduct(c, id, activeOnly = true) {
  const { rows } = await c.query(`SELECT * FROM products WHERE id = $1${activeOnly ? ' AND active = 1' : ''}`, [id]);
  return rows[0] || null;
}

/** Ödeme sonrası ürünü verir. Aynı charge_id iki kez işlenmez; işlenmişse null döner. */
export async function grantPurchase(c, s, userId, product, stars, chargeId) {
  const ins = await c.query(`INSERT INTO payments(user_id, product_id, stars, charge_id, created_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT (charge_id) DO NOTHING RETURNING id`, [userId, product.id, stars, chargeId, now()]);
  if (!ins.rows[0]) return null;
  const u = await findUser(c, userId, true);
  if (!u) throw new Error('Ödeme yapan kullanıcı bulunamadı: ' + userId);
  const t = now();
  accrue(s, u, t);
  const mult = u.paid_count === 0 ? 1 + s.first_buy_bonus : 1;
  const granted = {};
  if (product.type === 'power') { granted.power = Math.round(product.amount * mult); u.power += granted.power; }
  else if (product.type === 'coins') { granted.coins = Math.round(product.amount * mult); u.coins += granted.coins; }
  else if (product.type === 'boost') { granted.boost_secs = product.hours * 3600; u.boost_until = Math.max(t, u.boost_until) + granted.boost_secs; }
  u.paid_count += 1;
  u.stars_spent += stars;
  await saveUser(c, u);
  await c.query('UPDATE payments SET granted = $1 WHERE id = $2', [JSON.stringify(granted), ins.rows[0].id]);
  return granted;
}

/** Stars iadesi yapar ve verilen ürünü geri alır. */
export async function refundPayment(c, s, paymentId) {
  const p = (await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!p) return 'Ödeme bulunamadı.';
  if (p.refunded) return 'Bu ödeme zaten iade edilmiş.';
  const isCrypto = /^c[pw]-/.test(String(p.charge_id));
  if (!isCrypto && !String(p.charge_id).startsWith('dev-')) {
    const r = await tg('refundStarPayment', { user_id: p.user_id, telegram_payment_charge_id: p.charge_id });
    if (!r.ok) return 'Telegram iadeyi reddetti: ' + (r.description || 'bilinmeyen hata');
  }
  const u = await findUser(c, p.user_id, true);
  if (u) {
    accrue(s, u);
    const g = JSON.parse(p.granted || '{}');
    if (g.power) u.power = Math.max(0, u.power - g.power);
    if (g.coins) u.coins = Math.max(0, u.coins - g.coins);
    if (g.boost_secs) u.boost_until = Math.max(0, u.boost_until - g.boost_secs);
    u.stars_spent = Math.max(0, u.stars_spent - p.stars);
    await saveUser(c, u);
  }
  await c.query('UPDATE payments SET refunded = 1 WHERE id = $1', [paymentId]);
  return isCrypto ? 'Ürün geri alındı. Kripto ödemesini oyuncuya kendi cüzdanınızdan elle iade etmelisiniz.' : 'İade edildi.';
}

export async function notify(c, chatId, text, req) {
  if (chatId >= DEV_ID_BASE) return; // yerel test kullanıcıları
  const r = await tg('sendMessage', { chat_id: chatId, text, reply_markup: webappKeyboard(req) });
  if (r.error_code === 403) await c.query('UPDATE users SET blocked_bot = 1 WHERE id = $1', [chatId]);
}

export { DEV_ID_BASE };
