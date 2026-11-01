import { tx } from '../lib/db.js';
import { activeWallets, usdPrices } from '../lib/wallet.js';

/** Public display quote; checkout invoices are independently recalculated on the server. */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET gerekli' });
  const raw = req.query?.usd;
  const requestedUsd = raw === undefined ? null : Number(raw);
  if (requestedUsd !== null && (!Number.isFinite(requestedUsd) || requestedUsd <= 0 || requestedUsd > 1000000)) {
    return res.status(400).json({ ok: false, error: 'USD tutarı geçersiz' });
  }
  try {
    const wallets = await tx(c => activeWallets(c));
    const rates = await usdPrices(wallets.map(w => w.price_id));
    return res.status(200).json({
      ok: true,
      source: 'CoinGecko',
      retrievedAt: Date.now(),
      usdAmount: requestedUsd,
      quotes: wallets.map(w => {
        const rate = Number(rates[w.price_id]);
        const usdPerCoin = Number.isFinite(rate) && rate > 0 ? rate : null;
        const decimals = Math.min(8, Math.max(2, Number(w.decimals) || 4));
        return {
          id: Number(w.id), label: w.label, network: w.network,
          decimals, priceId: w.price_id, usdPerCoin,
          // Örn: 100 USD / 77.688 USD/BTC ≈ 0.00128720 BTC.
          amount: requestedUsd !== null && usdPerCoin
            ? (requestedUsd / usdPerCoin).toFixed(decimals) : null,
        };
      }),
    });
  } catch (e) {
    console.error('[crypto-quote]', e);
    return res.status(503).json({ ok: false, error: 'Kripto fiyatları alınamadı.' });
  }
}
