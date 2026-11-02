// Public USD/TRY reference quote used to preview TR bank withdrawal amounts.
// Quoting and debiting at submission are revalidated on the server.
import { usdTryRate } from '../lib/bank_payments.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ok:false,error:'GET required'});
  res.setHeader('Cache-Control','no-store');
  try {
    const fx = await usdTryRate();
    return res.status(200).json({
      ok:true, base:'USD', quote:'TRY', rate:fx.rate,
      updated_at:fx.updated, source:fx.source,
      reference_only:true
    });
  } catch(e) {
    console.warn('[usd_try_quote]',e.message);
    return res.status(503).json({ok:false,error:'Güncel USD/TRY kuru alınamadı.'});
  }
}
