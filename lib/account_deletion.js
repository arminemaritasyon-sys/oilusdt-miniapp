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

  // Tek hesap silme engeli: sonuçlanmamış "Beklemede" çekim talebi.
  // Onaylanan çekim, henüz transfer edilmemiş olsa bile ödeme yükümlülüğü
  // withdrawals tablosunda tutulur; profil silinmesi onu iptal etmez.
  const pendingWithdrawal=(await c.query(
    "SELECT id FROM withdrawals WHERE user_id=$1 AND status='pending' LIMIT 1",[id])).rows;
  if (pendingWithdrawal.length)
    throw new GameError('Beklemede çekim talebin var. Önce çekim talebin onaylanmalı veya sonuçlanmalı.');

  // Kripto faturaları hesabı silmeyi ENGELLEMEZ.
  // Henüz ödeme bildirimi yapılmamış cüzdan talepleri kapatılır.
  // "submitted" siparişler denetim ve manuel iade için korunur;
  // silinmiş hesaba ait bir satın almanın yeni hesaba yüklenmesi yasaktır.
  await c.query(
    "UPDATE wallet_invoices SET status='expired', note=COALESCE(note,'Hesap silindi: ödeme bildirimi yapılmamış sipariş kapatıldı') WHERE user_id=$1 AND status='waiting'",
    [id]
  );

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
