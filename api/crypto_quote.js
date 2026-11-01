import { tx } from '../lib/db.js';
import { activeWallets, usdPrices } from '../lib/wallet.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET gerekli' });
  try {
    const wallets = await tx(c => activeWallets(c));
    const rates = await usdPrices(wallets.map(w => w.price_id));
    return res.status(200).json({
      ok: true,
      source: 'CoinGecko',
      retrievedAt: Date.now(),
      quotes: wallets.map(w => ({
        id: Number(w.id), label: w.label, network: w.network,
        decimals: Number(w.decimals) || 4,
        priceId: w.price_id,
        usdPerCoin: Number(rates[w.price_id]) > 0 ? Number(rates[w.price_id]) : null,
      })),
    });
  } catch (e) {
    console.error('[crypto-quote]', e);
    return res.status(503).json({ ok: false, error: 'Kripto fiyatları alınamadı.' });
  }
}
