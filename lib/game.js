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

// `ref_share` toplam bütçedir; 9 kat ayrı ayrı ödenmez.
const WEIGHTS=Object.freeze([0.4,0.2,0.1,0.08,0.06,0.05,0.04,0.04,0.03]);
export function referralRates(settings) {
  const total=Math.max(0,Math.min(0.2,Number(settings.ref_share)||0));
  return WEIGHTS.map(w=>total*w);
}
export async function shopProducts(c,userId) {
  return (await Core.shopProducts(c,userId)).map(p=>({...p,locked:false,requires:null}));
}
export async function actSell(c,settings,user) {
  Core.accrue(settings,user);
  if(user.oil<0.00001)throw new Core.GameError('Satılacak petrol yok.');
  const earned=user.oil*settings.oil_price;
  if(!Number.isFinite(earned)||earned<=0)throw new Core.GameError('Geçersiz petrol kazancı.');
  user.oil=0;
  const cash=cents(earned);
  if(cash>0)await credit(c,user.id,cash,'oil_sale',null,'Petrol satışı');
  const rates=referralRates(settings),seen=new Set([String(user.id)]);
  let parentId=user.ref_by;
  for(let level=0;level<9&&parentId;level++){
    if(seen.has(String(parentId)))break;
    seen.add(String(parentId));
    const {rows}=await c.query('SELECT id,ref_by FROM users WHERE id=$1 AND banned=0',[parentId]);
    const parent=rows[0];
    if(!parent)break;
    const bonus=cents(earned*rates[level]);
    if(bonus>0){
      await c.query('UPDATE users SET ref_earned=ref_earned+$1 WHERE id=$2',[bonus,parent.id]);
      await credit(c,parent.id,bonus,'oil_referral',String(user.id),`${level+1}. seviye petrol referans payı`);
    }
    parentId=parent.ref_by;
  }
  return earned;
}
