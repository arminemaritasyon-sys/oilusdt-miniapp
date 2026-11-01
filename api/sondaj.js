import { brotliDecompressSync } from 'node:zlib';
import SVG_BUNDLE_BASE64 from '../lib/sondaj_svg_bundle.js';

// Kaynak: kullanıcı tarafından verilen sondaj_animasyonlari.zip -> svg/sondaj_seviye_01..10.svg
// Animasyonlar aslına uygun saklanır. WebM dosyaları Telegram sticker çıktısıdır.
let frames;
let stillFrames;

function assets() {
  if (!frames) {
    frames = brotliDecompressSync(Buffer.from(SVG_BUNDLE_BASE64, 'base64'))
      .toString('utf8').split('\0');
    if (frames.length !== 10 || frames.some(x => !x.includes('<svg') || !x.includes('</svg>')))
      throw new Error('Sondaj animasyon paketi bozuk.');
    // SVG SMIL animasyon etiketlerini çıkararak motor durduğunda sabit görsel sağla.
    stillFrames = frames.map(svg => svg.replace(/<animate(?:Transform|Motion|Color)?\b[^>]*\/>/g, ''));
  }
  return frames;
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('GET gerekli');
  try {
    const candidate = Number.parseInt(String(req.query?.level ?? '1'), 10);
    const level = Number.isFinite(candidate) ? Math.max(1, Math.min(10, candidate)) : 1;
    const still = String(req.query?.still || '') === '1';
    const data = assets();
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000');
    return res.status(200).end(still ? stillFrames[level - 1] : data[level - 1]);
  } catch (error) {
    console.error('[sondaj animation]', String(error));
    return res.status(500).end('Animasyon yüklenemedi');
  }
}
