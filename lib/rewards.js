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

/** Silinip yeniden açılmış hesaplarda eski mali kayıtları yeni hesap geçmişine ekleme. */
export async function rewardsInfo(c, settings, user) {
  const info = await Core.rewardsInfo(c, settings, user);
  // Aktif olmayan coin yöntemlerini listede göster, ama çekim başlatılmasına izin verme.
  info.display_networks = (await c.query(
    'SELECT id,label,network,min_usd,fee_usd,color,enabled FROM payout_networks ORDER BY sort,id'
  )).rows;
  const marker = (await c.query(
    'SELECT deleted_at, withdrawals_before_id, ledger_before_id FROM account_resets WHERE user_id=$1',
    [user.id]
  )).rows[0];
  if (!marker) return info;
  info.withdrawals = (await c.query(
    'SELECT id, amount, fee, label, network, address, status, tx_hash, note, created_at FROM withdrawals WHERE user_id=$1 AND id>$2 ORDER BY id DESC LIMIT 20',
    [user.id, marker.withdrawals_before_id]
  )).rows;
  info.ledger = (await c.query(
    'SELECT kind, amount, ref, note, created_at FROM reward_ledger WHERE user_id=$1 AND id>$2 ORDER BY id DESC LIMIT 20',
    [user.id, marker.ledger_before_id]
  )).rows;
  const nowRefs = (await c.query(
    'SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s FROM referral_rewards WHERE referrer_id=$1 AND created_at>$2',
    [user.id, marker.deleted_at]
  )).rows[0];
  info.referral.rewarded = nowRefs.n;
  info.referral.earned = Math.floor(Number(nowRefs.s || 0) * 100) / 100;
  const activeRef=(await c.query('SELECT COUNT(*)::int AS n FROM users WHERE ref_by=$1',[user.id])).rows[0]?.n || 0;
  info.referral.pending = Math.max(0,activeRef-nowRefs.n);
  return info;
}
