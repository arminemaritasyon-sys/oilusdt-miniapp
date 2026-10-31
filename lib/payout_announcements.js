import { query } from './db.js';
import { tg, escHtml } from './tg.js';

export const PAID_ANNOUNCEMENT_CHANNEL = '@oilwithdrawal';
const money = amount => '$' + Number(amount || 0).toFixed(2);
const validChat = chat => /^@\w{5,32}$/.test(chat) || /^-?\d{5,20}$/.test(chat);
const sameChat = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function sendOnce(withdrawalId, column, stage, chat, prettyChannel = false) {
  if (!validChat(chat)) return { sent: false, reason: 'Geçersiz kanal veya grup' };
  const allowed = stage === 'approved' ? "('approved','paid')" : "('paid')";
  // Mark the claim atomically: concurrent paid/admin calls won't duplicate announcements.
  const rows = await query(
    `UPDATE withdrawals SET ${column} = 1
     WHERE id = $1 AND ${column} = 0 AND status IN ${allowed}
     RETURNING id, user_id, amount, fee, label, network`,
    [withdrawalId]
  );
  const w = rows[0];
  if (!w) return { sent: false, reason: 'Daha önce duyuruldu veya işlem tamamlanmadı' };

  try {
    const person = (await query('SELECT first_name, username FROM users WHERE id = $1', [w.user_id]))[0] || {};
    const name = escHtml(person.first_name || (person.username ? '@' + person.username : 'Değerli oyuncumuz'));
    const paid = money(Math.max(0, Number(w.amount) - Number(w.fee)));
    const text = prettyChannel
      ? `🎉 <b>Oil Pump'tan güzel bir haber!</b>\n\n👤 Oyuncumuz <b>${name}</b>, <b>${paid}</b> tutarındaki çekimini başarıyla tamamladı!\n✅ <b>Çekim ödemesi gerçekleştirilmiştir.</b>\n\n🛢️ Oil Pump ailesine teşekkür eder, bol kazançlı oyunlar dileriz! 🚀`
      : stage === 'approved'
        ? `✅ <b>Çekim talebi onaylandı</b>\n👤 Oyuncu: ${name}\n💵 Talep: <b>${money(w.amount)}</b>\n🌐 ${escHtml(w.label)} ${escHtml(w.network)}\n📋 #${w.id}\n<i>Ödeme henüz tamamlanmadı.</i>`
        : `🎉 <b>Çekim ödendi</b>\n👤 Oyuncu: ${name}\n💸 Gönderilen: <b>${paid}</b>\n🌐 ${escHtml(w.label)} ${escHtml(w.network)}\n📋 #${w.id}`;
    const response = await tg('sendMessage', {
      chat_id: chat, text, parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    if (!response.ok) throw new Error(response.description || 'Telegram mesajı gönderilemedi');
    return { sent: true };
  } catch (error) {
    console.error('[withdrawal notification]', { stage, destination: chat, error: String(error) });
    // Re-enable retry if Telegram failed. Real payout status remains unchanged.
    try {
      await query(`UPDATE withdrawals SET ${column} = 0 WHERE id = $1`, [withdrawalId]);
    } catch (resetError) {
      console.error('[withdrawal notification flag reset]', String(resetError));
    }
    return { sent: false, reason: 'Telegram mesajı gönderilemedi; botun kanalda gönderi yetkisini kontrol edin' };
  }
}

/** Called only *after* the withdrawal's status update has committed.
 * Approval is not a payment. Only 'paid' may be posted to @oilwithdrawal.
 */
export async function notifyWithdrawalGroup(withdrawalId, stage) {
  if (!['approved', 'paid'].includes(stage)) return { sent: false };
  try {
    const stored = (await query("SELECT v FROM settings WHERE k = 'payout_group_chat'"))[0]?.v;
    const group = String(stored || process.env.PAYOUT_GROUP_CHAT_ID || '').trim();
    if (stage === 'approved') {
      return { group: validChat(group)
        ? await sendOnce(withdrawalId, 'group_approved_notified', 'approved', group)
        : { sent: false, reason: 'Bildirim grubu tanımlı değil' } };
    }
    // Existing configured group keeps receiving paid alerts, except when it
    // is this same channel; otherwise the channel would get duplicate messages.
    const groupResult = validChat(group) && !sameChat(group, PAID_ANNOUNCEMENT_CHANNEL)
      ? await sendOnce(withdrawalId, 'group_paid_notified', 'paid', group)
      : { sent: false, reason: 'Ayrı grup tanımlı değil veya kanal ile aynı' };
    const channelResult = await sendOnce(
      withdrawalId, 'channel_paid_notified', 'paid', PAID_ANNOUNCEMENT_CHANNEL, true
    );
    return { group: groupResult, channel: channelResult };
  } catch (error) {
    console.error('[withdrawal notification]', String(error));
    return { sent: false, reason: 'Bildirim sırasında sunucu hatası' };
  }
}
