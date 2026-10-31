// Kendi ödeme altyapınız için çekim API'si. PAYOUT_API_KEY ortam değişkeni ile korunur.
//   GET  /api/payouts?status=approved           → ödenecek talepler
//   POST /api/payouts {action:'paid', id, tx_hash}   → ödendi olarak işaretle (oyuncuya bildirim gider)
//   POST /api/payouts {action:'reject', id, note}    → reddet, tutar oyuncunun bakiyesine döner
import { tx, query } from '../lib/db.js';
import { safeEqual } from '../lib/tg.js';
import * as R from '../lib/rewards.js';
import { notifyWithdrawalGroup } from '../lib/payout_announcements.js';

const KEY = process.env.PAYOUT_API_KEY || '';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!KEY || !safeEqual(KEY, req.headers['x-api-key'] || '')) return res.status(403).json({ ok: false, error: 'Yetkisiz.' });
  try {
    if (req.method === 'GET') {
      const st = new URL(req.url, 'http://x').searchParams.get('status');
      const status = ['approved', 'pending'].includes(st) ? st : 'approved';
      const rows = await query(`SELECT id, user_id, amount, fee, ROUND((amount - fee)::numeric, 2)::float AS payout,
        label, network, address, status, created_at FROM withdrawals WHERE status = $1 ORDER BY id`, [status]);
      return res.json({ ok: true, withdrawals: rows });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      let msg;
      if (b.action === 'paid') msg = await tx((c) => R.markPaid(c, Number(b.id), b.tx_hash, req));
      else if (b.action === 'reject') msg = await tx((c) => R.rejectWithdraw(c, Number(b.id), b.note, req));
      else return res.status(400).json({ ok: false, error: "action 'paid' ya da 'reject' olmalı." });
      if(b.action==='paid')await notifyWithdrawalGroup(Number(b.id),'paid');
      return res.json({ ok: true, msg });
    }
    return res.status(405).json({ ok: false, error: 'GET ya da POST' });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
}
