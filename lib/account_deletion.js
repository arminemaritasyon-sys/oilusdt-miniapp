// Hesap silme oyun profilini temizler. Finansal denetim kayıtları anonimleştirilmiş
// yeni oyun profiline taşınmaz, ancak yasal mutabakat için saklanır.
import { GameError, now } from './game.js';

export async function deletePlayerAccount(c, telegramId, confirmation, acceptForfeit) {
  if (confirmation !== 'HESABIMI SİL' || acceptForfeit !== true)
    throw new GameError('Hesap silme onayı geçersiz.');

  const id=Number(telegramId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new GameError('Geçersiz hesap.');

  const { rows }=await c.query('SELECT id, reward_usd FROM users WHERE id=$1 FOR UPDATE',[id]);
  if (!rows[0]) return { deleted:true, alreadyDeleted:true };

  const openWithdrawals=(await c.query(
    "SELECT id FROM withdrawals WHERE user_id=$1 AND status IN ('pending','approved') LIMIT 1",[id])).rows;
  if (openWithdrawals.length) throw new GameError('Bekleyen veya onaylanan çekim talebin var. Hesabını silmeden önce talebin sonuçlanmalı.');

  // Güncel cüzdan siparişleri iki saat sonra, ödeme bildirimi yapılmadıysa sona erer.
  // Bu temizlik satın alma akışındaki WAIT_SECS kuralıyla aynıdır.
  await c.query(
    "UPDATE wallet_invoices SET status='expired' WHERE user_id=$1 AND status='waiting' AND created_at < $2",
    [id, now()-7200]
  );
  const openWallet=(await c.query(
    "SELECT id FROM wallet_invoices WHERE user_id=$1 AND status IN ('waiting','submitted') LIMIT 1",[id])).rows;
  if (openWallet.length) throw new GameError('Açık kripto satın alma siparişin var. Hesabını silmeden önce sipariş sonuçlanmalı.');

  // Legacy crypto_invoices kullanılmıyor: güncel kodun hiçbir satın alma/ödeme
  // işlemi bu tabloyu okumaz veya yazmaz. Eski 'active' kayıtları süresiz
  // kalabilir. Tarihsel kayıtları sakla, ama hesap silmeyi bunlarla engelleme.

  const max=async table => Number((await c.query(
    `SELECT COALESCE(MAX(id),0)::bigint AS n FROM ${table} WHERE user_id=$1`,[id])).rows[0].n);
  const [payments,withdrawals,ledger]=await Promise.all([
    max('payments'),max('withdrawals'),max('reward_ledger')
  ]);
  // Bu tablo, eski finansal kayıtları yeni kaydın ekranından ayırır.
  // Eski kayıtları silmediğimiz için muhasebe ve iade denetimi korunur.
  await c.query(`INSERT INTO account_resets
      (user_id,deleted_at,payments_before_id,withdrawals_before_id,ledger_before_id)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id) DO UPDATE SET deleted_at=EXCLUDED.deleted_at,
      payments_before_id=GREATEST(account_resets.payments_before_id,EXCLUDED.payments_before_id),
      withdrawals_before_id=GREATEST(account_resets.withdrawals_before_id,EXCLUDED.withdrawals_before_id),
      ledger_before_id=GREATEST(account_resets.ledger_before_id,EXCLUDED.ledger_before_id)`,
    [id,now(),payments,withdrawals,ledger]);

  await c.query('DELETE FROM user_tasks WHERE user_id=$1',[id]);
  await c.query('DELETE FROM weekly_points WHERE user_id=$1',[id]);
  await c.query('DELETE FROM active_days WHERE user_id=$1',[id]);
  // Davet ağındaki mevcut bağlantıları kopar; yeni hesap başka bir ağdan başlayabilir.
  await c.query('UPDATE users SET ref_by=NULL WHERE ref_by=$1',[id]);
  await c.query('DELETE FROM users WHERE id=$1',[id]);
  return { deleted:true };
}
