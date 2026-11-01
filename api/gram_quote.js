// Gram (GRAM, formerly TON) quote, for display only. Not a token balance or payout conversion.
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&include_last_updated_at=true';
let rateCache = null;
export default async function handler(req,res) {
  if(req.method !== 'GET') return res.status(405).json({ok:false,error:'GET gerekli'});
  res.setHeader('Cache-Control','no-store');
  try {
    if(rateCache && Date.now()-rateCache.cachedAt<90000)
      return res.status(200).json({ok:true,usd_per_gram:rateCache.usd,updated_at:rateCache.updatedAt,source:'CoinGecko',symbol:'GRAM'});
    const response = await fetch(PRICE_URL,{signal:AbortSignal.timeout(6500),headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error('CoinGecko HTTP '+response.status);
    const row = (await response.json())?.['the-open-network'];
    const usd = Number(row?.usd);
    const updatedAt = Number(row?.last_updated_at);
    if(!Number.isFinite(usd)||usd<=0||!Number.isSafeInteger(updatedAt)||
       Math.abs(Date.now()/1000-updatedAt)>1800)
      throw new Error('GRAM kuru bulunamadı veya eski.');
    rateCache={usd,updatedAt,cachedAt:Date.now()};
    return res.status(200).json({ok:true,usd_per_gram:usd,updated_at:updatedAt,source:'CoinGecko',symbol:'GRAM'});
  } catch(e) {
    console.warn('[gram_quote]',e.message);
    return res.status(503).json({ok:false,error:'Canlı GRAM kuru alınamadı'});
  }
}
