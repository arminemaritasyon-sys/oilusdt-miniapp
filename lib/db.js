// Postgres bağlantısı. Canlıda DATABASE_URL (Neon), yerelde DEV_MODE ile gömülü PGlite kullanılır.
import pg from 'pg';

const URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const parsers = { 20: (v) => Number(v), 1700: (v) => Number(v) };

async function createDriver() {
  if (URL) {
    pg.types.setTypeParser(20, parsers[20]);
    pg.types.setTypeParser(1700, parsers[1700]);
    const pool = new pg.Pool({ connectionString: URL, max: 3 });
    return {
      query: (text, params) => pool.query(text, params),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(c);
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
    };
  }
  if (process.env.DEV_MODE !== '1') throw new Error('DATABASE_URL tanımlı değil.');
  // Değişken adla içe aktarılır ki Vercel paketi fonksiyona dahil etmesin
  const pkg = '@electric-sql/' + 'pglite';
  const { PGlite } = await import(pkg);
  const db = new PGlite(process.env.PGLITE_DIR || './.pglite', { parsers });
  return {
    query: (text, params) => db.query(text, params),
    tx: (fn) => db.transaction((t) => fn(t)),
  };
}

let driverP;
let readyP;
const driver = () => (driverP ??= createDriver().catch((e) => { driverP = null; throw e; }));

export async function ready() {
  return (readyP ??= driver().then(migrate).catch((e) => { readyP = null; throw e; }));
}

export async function query(text, params = []) {
  await ready();
  return (await (await driver()).query(text, params)).rows;
}

export async function tx(fn) {
  await ready();
  return (await driver()).tx(fn);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id BIGINT PRIMARY KEY,
  username TEXT, first_name TEXT, lang TEXT,
  ref_by BIGINT,
  power DOUBLE PRECISION NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 1,
  coins DOUBLE PRECISION NOT NULL DEFAULT 0,
  oil DOUBLE PRECISION NOT NULL DEFAULT 0,
  oil_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  shift_end BIGINT, last_calc BIGINT,
  boost_until BIGINT NOT NULL DEFAULT 0,
  started INT NOT NULL DEFAULT 0,
  paid_count INT NOT NULL DEFAULT 0,
  stars_spent INT NOT NULL DEFAULT 0,
  ref_earned DOUBLE PRECISION NOT NULL DEFAULT 0,
  daily_last TEXT, daily_streak INT NOT NULL DEFAULT 0,
  banned INT NOT NULL DEFAULT 0,
  blocked_bot INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, last_seen BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_users_ref ON users(ref_by);
CREATE INDEX IF NOT EXISTS ix_users_total ON users(oil_total DESC);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS account_resets(
  user_id BIGINT PRIMARY KEY,
  deleted_at BIGINT NOT NULL,
  payments_before_id BIGINT NOT NULL DEFAULT 0,
  withdrawals_before_id BIGINT NOT NULL DEFAULT 0,
  ledger_before_id BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products(
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL, description TEXT,
  stars INT NOT NULL, type TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0, hours INT NOT NULL DEFAULT 0,
  sort INT NOT NULL DEFAULT 0, active INT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS payments(
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL, product_id INT, stars INT NOT NULL,
  charge_id TEXT UNIQUE, granted TEXT,
  created_at BIGINT NOT NULL, refunded INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks(
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT,
  target TEXT, count INT NOT NULL DEFAULT 0,
  reward DOUBLE PRECISION NOT NULL DEFAULT 0,
  sort INT NOT NULL DEFAULT 0, active INT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_tasks(
  user_id BIGINT NOT NULL, task_id INT NOT NULL, done_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, task_id)
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS usd DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS crypto_invoices(
  id SERIAL PRIMARY KEY,
  invoice_id BIGINT UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, product_id INT NOT NULL,
  usd DOUBLE PRECISION NOT NULL, asset TEXT,
  paid_asset TEXT, paid_amount TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL, paid_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_crypto_user ON crypto_invoices(user_id);
CREATE TABLE IF NOT EXISTS crypto_wallets(
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL, network TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  price_id TEXT NOT NULL DEFAULT 'usd', decimals INT NOT NULL DEFAULT 4,
  color TEXT NOT NULL DEFAULT '#26a17b',
  sort INT NOT NULL DEFAULT 0, enabled INT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS wallet_invoices(
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL, product_id INT NOT NULL,
  usd DOUBLE PRECISION NOT NULL, wallet_id INT NOT NULL,
  label TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', tx_hash TEXT, note TEXT,
  created_at BIGINT NOT NULL, submitted_at BIGINT, paid_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_winv_status ON wallet_invoices(status, id);
CREATE INDEX IF NOT EXISTS ix_winv_user ON wallet_invoices(user_id, status);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reward_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS coins_migrated SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ALTER COLUMN coins_migrated SET DEFAULT 1;
CREATE TABLE IF NOT EXISTS reward_ledger(
  id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, kind TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, ref TEXT, note TEXT, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ledger_user ON reward_ledger(user_id, id);
-- Günlük limit hesap silinip yeniden açıldığında bile korunur.
CREATE TABLE IF NOT EXISTS free_oil_sales(
  user_id BIGINT NOT NULL, day TEXT NOT NULL, earned_cents INT NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, day), CONSTRAINT free_oil_sales_nonnegative CHECK(earned_cents >= 0)
);
CREATE TABLE IF NOT EXISTS weekly_points(
  user_id BIGINT NOT NULL, week TEXT NOT NULL, points INT NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, week)
);
CREATE INDEX IF NOT EXISTS ix_wp_week ON weekly_points(week, points DESC);
CREATE TABLE IF NOT EXISTS active_days(user_id BIGINT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS referral_rewards(
  referred_id BIGINT PRIMARY KEY, referrer_id BIGINT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, month TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_refrw_referrer ON referral_rewards(referrer_id, month);
CREATE TABLE IF NOT EXISTS reward_weeks(
  week TEXT PRIMARY KEY, pool DOUBLE PRECISION NOT NULL, winners INT NOT NULL,
  paid_total DOUBLE PRECISION NOT NULL, closed_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payout_networks(
  id SERIAL PRIMARY KEY, label TEXT NOT NULL, network TEXT NOT NULL DEFAULT '',
  min_usd DOUBLE PRECISION NOT NULL DEFAULT 0, fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#26a17b', sort INT NOT NULL DEFAULT 0, enabled INT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS withdrawals(
  id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  network_id INT, label TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT, note TEXT,
  created_at BIGINT NOT NULL, updated_at BIGINT
);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS group_approved_notified INT NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS group_paid_notified INT NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS channel_paid_notified INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_wd_status ON withdrawals(status, id);
CREATE INDEX IF NOT EXISTS ix_wd_user ON withdrawals(user_id, id);
CREATE TABLE IF NOT EXISTS broadcasts(
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL, btn INT NOT NULL DEFAULT 1,
  cursor BIGINT NOT NULL DEFAULT 0, sent INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0, done INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);`;

async function migrate(d) {
  const { DEFAULT_SETTINGS } = await import('./game.js');
  await d.tx(async (c) => {
    // Aynı anda açılan iki fonksiyonun şemayı birlikte kurmasını engelle
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await c.query(stmt);
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      await c.query('INSERT INTO settings(k, v) VALUES($1, $2) ON CONFLICT (k) DO NOTHING', [k, String(def.v)]);
    }
    const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM products');
    if (rows[0].n === 0) {
      for (const p of [
        ['Küçük Kuyu', '+5.000 güç', 50, 'power', 5000, 0, 1],
        ['Orta Kuyu', '+30.000 güç', 250, 'power', 30000, 0, 2],
        ['Büyük Saha', '+140.000 güç', 1000, 'power', 140000, 0, 3],
        ['Turbo x2', '24 saat 2 kat üretim', 75, 'boost', 0, 24, 4],
        ['Para Kasası', '+5.000 oyun parası', 100, 'coins', 5000, 0, 5],
      ]) await c.query('INSERT INTO products(title, description, stars, type, amount, hours, sort) VALUES($1,$2,$3,$4,$5,$6,$7)', p);
      for (const t of [
        ['invite', 'Ekibini kur', 'Bir arkadaşını davet et', null, 1, 200, 1, 1],
        ['invite', 'Küçük ekip', '5 arkadaşını davet et', null, 5, 1500, 2, 1],
        ['invite', 'Petrol şirketi', '25 arkadaşını davet et', null, 25, 10000, 3, 1],
        ['channel', 'Oyun haberleri', 'Kanalımıza abone ol', '@kanal_adiniz', 0, 555, 4, 0],
        ['link', 'Bizi takip et', 'Sayfamızı ziyaret et', 'https://example.com', 0, 300, 5, 0],
      ]) await c.query('INSERT INTO tasks(type, title, subtitle, target, count, reward, sort, active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', t);
    }
    // Kripto fiyatları ilk kurulumda Stars fiyatından türetilir (50 ⭐ ≈ 1 $); sonra admin panelinden değiştirilir
    const usdInit = await c.query("INSERT INTO settings(k, v) VALUES('_usd_init', '1') ON CONFLICT (k) DO NOTHING RETURNING k");
    if (usdInit.rows[0]) await c.query('UPDATE products SET usd = ROUND((stars / 50.0)::numeric, 2) WHERE usd = 0');
    // Eski ürünlerin ödeme geçmişi saklanır; yalnızca mağazadan kaldırılır.
    const marker=await c.query("INSERT INTO settings(k,v) VALUES('_packs_5_10_50_100_250_1000','1') ON CONFLICT (k) DO NOTHING RETURNING k");
    if(marker.rows[0]){
      await c.query('UPDATE products SET active=0');
      const packs=[
        ['Çırak Petrolcü','5.000 güç · başlangıç paketi',250,5000,5],
        ['Bronz Sondajcı','10.000 güç · bronz paket',500,10000,10],
        ['Gümüş Petrolcü','50.000 güç · gümüş paket',2500,50000,50],
        ['Altın Petrolcü','100.000 güç · altın paket',5000,100000,100],
        ['Platin Saha','250.000 güç · platin paket',12500,250000,250],
        ['Petrol İmparatoru','1.000.000 güç · imparator paketi',50000,1000000,1000]
      ];
      for(let i=0;i<packs.length;i++){
        const [title,description,stars,amount,usd]=packs[i];
        await c.query("INSERT INTO products(title,description,stars,usd,type,amount,hours,sort,active) VALUES($1,$2,$3,$4,'power',$5,0,$6,1)",[title,description,stars,usd,amount,i+1]);
      }
    }
    // Varsayılan çekim yöntemi (admin panelinden değiştirilebilir/silinebilir)
    const payoutInit = await c.query("INSERT INTO settings(k, v) VALUES('_payout_init', '1') ON CONFLICT (k) DO NOTHING RETURNING k");
    if (payoutInit.rows[0]) {
      await c.query("INSERT INTO payout_networks(label, network, min_usd, fee_usd, color, sort) VALUES('USDT', 'TRC-20', 5, 1, '#26a17b', 1)");
    }
  });
}
