// Cashable petroleum revenue is moved out of game coins in one database transaction.
// The original game implementation is preserved in game_original.js.
import * as Core from './game_original.js';
import { credit } from './rewards.js';
export * from './game_original.js';

const cents = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

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

export async function actSell(c, settings, user) {
  // The caller already runs actSell inside a DB transaction and saves user afterwards.
  const earned = await Core.actSell(c, settings, user);
  if (!Number.isFinite(earned) || earned <= 0) return earned;
  // Undo game-coin credit; the sale goes into withdrawable rewards instead.
  user.coins -= earned;
  const cash = cents(earned);
  if (cash > 0) await credit(c, user.id, cash, 'oil_sale', null, 'Petrol satışı');
  // The original game also gives the referrer game money. Move that bonus to
  // the referrer's cashable ledger inside the same transaction without double credit.
  if (user.ref_by && settings.ref_share > 0) {
    const refBonus = earned * settings.ref_share;
    const moved = await c.query(
      'UPDATE users SET coins = coins - $1 WHERE id = $2 RETURNING id',
      [refBonus, user.ref_by]
    );
    if (moved.rows.length && cents(refBonus) > 0)
      await credit(c, user.ref_by, cents(refBonus), 'oil_referral', String(user.id), 'Petrol referans payı');
  }
  return earned;
}
