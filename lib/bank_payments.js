// TL havale/EFT siparişleri: bankadaki tahsilat kontrol edilmeden paket verilemez.
import * as G from './game.js';
import { tg, webappKeyboard, env } from './tg.js';

const BANK_WAIT_SECS = 24 * 3600;
let fxCache = null;
const safeAmount = (n) => Number(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});

export async function activeBanks(c) {
  return (await c.query(
    "SELECT id, bank_name, holder, iban FROM bank_accounts WHERE enabled=1 AND holder<>'' AND iban ~ '^TR[0-9]{24}$' ORDER BY sort,id LIMIT 10"
  )).rows;
}

// Referans döviz kuru; işlem anında sunucuda kilitlenir, istemciden kur/tutar kabul edilmez.
// Kaynak: https://www.exchangerate-api.com (açık USD/TRY verisi).
export async function usdTryRate() {
  if (fxCache && Date.now()-fxCache.cached < 30*60*1000) return fxCache;
  let result;
  try {
    const response=await fetch('https://open.er-api.com/v6/latest/USD',{
      signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}
    });
    if (!response.ok) throw new Error('Kura ulaşılamadı.');
    const data=await response.json();
    const rate=Number(data?.rates?.TRY);
    const updated=Number(data?.time_last_update_unix);
    if(data.result!=='success'||data.base_code!=='USD'||!Number.isFinite(rate)||
      rate<=0||!Number.isSafeInteger(updated)||Math.abs(Date.now()/1000-updated)>72*3600)
      throw new Error('TL kuru güncel değil.');
    result={rate,updated,source:'ExchangeRate-API'};
  } catch(e) {
    throw new G.GameError('Güncel USD/TL kuru alınamadı. Lütfen daha sonra yeniden dene.');
  }
  fxCache={...result,cached:Date.now()};
  return fxCache;
}
const invoiceCode = id => 'OP-' + String(id).padStart(7,'0');
export function publicBankInvoice(row) {
  return {
    id:row.id,bank_name:row.bank_name,holder:row.holder,iban:row.iban,
    usd:Number(row.usd),amount_try:Number(row.amount_try),rate_try:Number(row.rate_try),
    code:invoiceCode(row.id),status:row.status,submitted_at:row.submitted_at,
    payer_name:row.payer_name,receipt_reference:row.receipt_reference,
    expires_at:Number(row.created_at)+BANK_WAIT_SECS,
  };
}
const expireWaiting = async c =>
  c.query("UPDATE bank_invoices SET status='expired' WHERE status='waiting' AND created_at < $1",[G.now()-BANK_WAIT_SECS]);

export async function createBankInvoice(c,user,product,bankId) {
  await expireWaiting(c);
  const bank=(await c.query(
    "SELECT * FROM bank_accounts WHERE id=$1 AND enabled=1 AND holder<>'' AND iban ~ '^TR[0-9]{24}$'",
    [bankId])).rows[0];
  if (!bank) throw new G.GameError('Bu banka hesabı şu anda aktif değil.');
  if(!Number.isFinite(Number(product.usd)) || Number(product.usd)<=0)
    throw new G.GameError('Bu paket için TL fiyatı mevcut değil.');
  const old=(await c.query(
    "SELECT * FROM bank_invoices WHERE user_id=$1 AND product_id=$2 AND bank_id=$3 AND status IN ('waiting','submitted') ORDER BY id DESC LIMIT 1",
    [user.id,product.id,bank.id])).rows[0];
  if(old) return publicBankInvoice(old);
  const fx=await usdTryRate();
  const amount=Math.round((Number(product.usd)*fx.rate+Number.EPSILON)*100)/100;
  if(!Number.isFinite(amount)||amount<=0||amount>100000000)
    throw new G.GameError('TL sipariş tutarı hesaplanamadı.');
  const row=(await c.query(
    `INSERT INTO bank_invoices
    (user_id,product_id,bank_id,usd,amount_try,rate_try,bank_name,holder,iban,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [user.id,product.id,bank.id,Number(product.usd),amount,fx.rate,bank.bank_name,bank.holder,bank.iban,G.now()]
  )).rows[0];
  return publicBankInvoice(row);
}
export async function submitBankInvoice(c,user,id,payerName,receiptReference) {
  await expireWaiting(c);
  const r=(await c.query('SELECT * FROM bank_invoices WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id])).rows[0];
  if(!r) throw new G.GameError('Banka siparişi bulunamadı.');
  if(r.status!=='waiting') {
    if(r.status==='submitted') return {invoice:publicBankInvoice(r),notify:null};
    throw new G.GameError('Bu sipariş artık ödeme bildirimine açık değil.');
  }
  // Oyuncu yalnızca "Havale gönderdim" der; gönderen/dekont alanı zorunlu değil.
  // Gerçek bankacılık hareketi, OP sipariş kodu ve tutar admin tarafından kontrol edilir.
  const row=(await c.query(
    "UPDATE bank_invoices SET status='submitted',submitted_at=$1 WHERE id=$2 RETURNING *",
    [G.now(),r.id]
  )).rows[0];
  return {invoice:publicBankInvoice(row),notify:row};
}
export async function notifyAdminsBankInvoice(row,user,productTitle) {
  for(const aid of env.adminIds) {
    try {
      await tg('sendMessage',{chat_id:aid,
        text:`🏦 TL banka transfer bildirimi ${invoiceCode(row.id)}\nPaket: ${productTitle||'-'}\nTutar: ${safeAmount(row.amount_try)} TL (${row.usd} USD)\nBanka: ${row.bank_name}\nBonus: +%10 paket gücü (sadece güç paketi)\nOyuncu: ${user.first_name||''} (${user.id})\nÖdemeyi banka hesabında doğrulayın, ardından Admin → TL Transferler bölümünden onaylayın.`
      });
    } catch(e) { console.warn('[bank notify]',String(e)); }
  }
}
export async function approveBankInvoice(c,id,req) {
  const r=(await c.query('SELECT * FROM bank_invoices WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!r) throw new Error('TL ödeme kaydı bulunamadı.');
  if(r.status==='paid') return 'Bu havale zaten onaylandı.';
  if(r.status!=='submitted') throw new Error('Yalnızca ödeme bildirimi alınmış havale onaylanabilir.');
  const reset=(await c.query('SELECT deleted_at FROM account_resets WHERE user_id=$1',[r.user_id])).rows[0];
  if(reset && Number(r.created_at)<=Number(reset.deleted_at))
    throw new Error('Bu transfer silinmiş eski hesaba ait. Yeni hesapta paket verilemez; iadeyi manuel inceleyin.');
  const user=(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[r.user_id])).rows[0];
  if(!user) throw new Error('Oyuncunun aktif hesabı yok. Önce iade/ödeme çözümü uygulayın.');
  const product=await G.findProduct(c,r.product_id,false);
  if(!product) throw new Error('Paket bulunamadı.');
  const settings=await G.loadSettings(c);
  const granted=await G.grantPurchase(c,settings,r.user_id,product,0,'bank-'+r.id);
  // Banka havalesinde ekstra +%10 temel güç. Ücretsiz oyun puanı veya
  // çekilebilir USD değil; sadece ürünün pompa gücü artar. İlk-alım bonusundan
  // bağımsızdır ve ödeme kaydına yazılır, dolayısıyla tekrarlı onaydan etkilenmez.
  if (granted && product.type === 'power') {
    const bonusPower = Math.round(Number(product.amount) * 0.10);
    if (bonusPower > 0) {
      const extra = await G.findUser(c,r.user_id,true);
      extra.power += bonusPower;
      await G.saveUser(c,extra);
      granted.power += bonusPower;
      granted.bank_bonus_power = bonusPower;
      await c.query(
        'UPDATE payments SET granted=$1 WHERE charge_id=$2',
        [JSON.stringify(granted),'bank-'+r.id]
      );
    }
  }
  await c.query("UPDATE bank_invoices SET status='paid',paid_at=$1 WHERE id=$2",[G.now(),id]);
  if(granted && r.user_id < G.DEV_ID_BASE) {
    const what=granted.power ? '+'+Math.round(granted.power).toLocaleString('tr-TR')+' güç'
      :granted.coins?'+'+Math.round(granted.coins).toLocaleString('tr-TR')+' oyun parası'
      :granted.boost_secs?'Turbo '+Math.round(granted.boost_secs/3600)+' saat':'Ürün hesabına eklendi';
    try { await tg('sendMessage',{chat_id:r.user_id,text:`✅ TL havale ödemen onaylandı: ${product.title}\n${what} hesabına eklendi.`,reply_markup:webappKeyboard(req)}); }
    catch(e){console.warn('[bank paid notification]',String(e));}
  }
  return 'TL havale onaylandı, paket oyuncuya verildi.';
}
export async function rejectBankInvoice(c,id,note) {
  const row=(await c.query('SELECT * FROM bank_invoices WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row) throw new Error('Banka siparişi bulunamadı.');
  if(row.status==='paid') throw new Error('Onaylanan havale reddedilemez.');
  if(!['waiting','submitted'].includes(row.status)) throw new Error('Bu kayıt artık değiştirilemez.');
  await c.query("UPDATE bank_invoices SET status='rejected',note=$1 WHERE id=$2",[String(note||'').trim().slice(0,300),id]);
  return 'TL ödeme bildirimi reddedildi (banka iadesi bu işlemle yapılmaz).';
}
