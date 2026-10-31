import { query } from './db.js';
import { tg, escHtml } from './tg.js';
const usd=n=>'$'+Number(n||0).toFixed(2);
export async function notifyWithdrawalGroup(id,stage) {
  if(!['approved','paid'].includes(stage))return {sent:false};
  const saved=(await query("SELECT v FROM settings WHERE k='payout_group_chat'"))[0]?.v;
  const chat=String(saved||process.env.PAYOUT_GROUP_CHAT_ID||'').trim();
  if(!(/^@\w{5,32}$/.test(chat)||/^-?\d{5,20}$/.test(chat)))return {sent:false,reason:'Grup tanımlı değil'};
  const col=stage==='approved'?'group_approved_notified':'group_paid_notified';
  const allowed=stage==='approved'?"('approved','paid')":"('paid')";
  const rows=await query(`UPDATE withdrawals SET ${col}=1 WHERE id=$1 AND ${col}=0 AND status IN ${allowed} RETURNING id,user_id,amount,fee,label,network`,[id]);
  const w=rows[0];if(!w)return {sent:false,reason:'Zaten gönderildi veya durum uygun değil'};
  try {
    const u=(await query('SELECT first_name,username FROM users WHERE id=$1',[w.user_id]))[0]||{};
    const who=escHtml(u.first_name||u.username||'Oyuncu');
    const msg=stage==='approved'
      ? `✅ <b>Çekim talebi onaylandı</b>\n👤 Oyuncu: ${who}\n💵 Tutar: <b>${usd(w.amount)}</b>\n🌐 ${escHtml(w.label)} ${escHtml(w.network)}\n📋 #${w.id}\n<i>Henüz ödeme yapılmadı.</i>`
      : `🎉 <b>Çekim ödendi</b>\n👤 Oyuncu: ${who}\n💸 Gönderilen: <b>${usd(w.amount-w.fee)}</b>\n🌐 ${escHtml(w.label)} ${escHtml(w.network)}\n📋 #${w.id}`;
    const r=await tg('sendMessage',{chat_id:chat,text:msg,parse_mode:'HTML'});
    if(!r.ok)throw Error(r.description||'Telegram hatası');
    return {sent:true};
  }catch(e){
    console.error('[withdraw-group]',e);
    await query(`UPDATE withdrawals SET ${col}=0 WHERE id=$1`,[id]).catch(console.error);
    return {sent:false,reason:'Bildirim başarısız'};
  }
}
