// Existing reward accounting remains authoritative for payouts.
import * as Core from './rewards_original.js';
import { GameError } from './game.js';
export * from './rewards_original.js';

export async function requestWithdraw(c, settings, user, body) {
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount < 10)
    throw new GameError('Minimum çekim tutarı 10 USD.');
  // Core.requestWithdraw locks the user's balance row, checks pending requests,
  // creates the withdrawal and debits the wallet within the caller's transaction.
  return Core.requestWithdraw(c, {
    ...settings,
    withdraw_min_usd: Math.max(10, Number(settings.withdraw_min_usd) || 0)
  }, user, body);
}
