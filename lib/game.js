// Cashable petroleum revenue is moved out of game coins in one database transaction.
// The original game implementation is preserved in game_original.js.
import * as Core from './game_original.js';
import { credit } from './rewards.js';
export * from './game_original.js';

const cents = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

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
