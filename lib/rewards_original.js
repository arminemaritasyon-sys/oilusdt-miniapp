// Ödül bakiyesi (USD): yalnızca sizin bütçenizden verilen haftalık yarışma ödülleri ve sabit referans ödülleri.
// Oyun parası, petrol ve satın alınan güç bu bakiyeyi hiçbir şekilde etkilemez.
import * as G from './game.js';
import { tg, webappKeyboard, env } from './tg.js';

const TZ = 'Europe/Istanbul';            // Türkiye saati (yaz saati yok, UTC+3)
const TZ_OFFSET = 3 * 3600;
const round2 = (v) => Math.floor(v * 100 + 1e-9) / 100;
const usd = (v) => '$' + Number(v).toFixed(2);

export const dayKey = (ts = G.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts * 1000));
const monthKey = (ts = G.now()) => dayKey(ts).slice(0, 7);

/** ISO hafta anahtarı, ör. 2026-W44 (Pazartesi başlar). */
export function weekKey(ts = G.now()) {
  const [y, m, d] = dayKey(ts).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

/** Haftanın bitişi: gelecek Pazartesi 00:00 (Türkiye saati). */
export function weekEndsAt(ts = G.now()) {
  const [y, m, d] = dayKey(ts).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return Math.floor(Date.UTC(y, m - 1, d + 8 - dow) / 1000) - TZ_OFFSET;
}

export async function addPoints(c, userId, pts) {
  if (!(pts > 0)) return;
  await c.query(`INSERT INTO weekly_points(user_id, week, points) VALUES($1,$2,$3)
    ON CONFLICT (user_id, week) DO UPDATE SET points = weekly_points.points + EXCLUDED.points`, [userId, weekKey(), Math.round(pts)]);
}

/** Ödül bakiyesine para ekler/düşer ve hareket kaydı tutar. */
export async function credit(c, userId, amount, kind, ref = null, note = null) {
  const amt = Math.round(amount * 100) / 100;
  if (!amt) return 0;
  await c.query('UPDATE users SET reward_usd = reward_usd + $1 WHERE id = $2', [amt, userId]);
  await c.query('INSERT INTO reward_ledger(user_id, kind, amount, ref, note, created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [userId, kind, amt, ref, note, G.now()]);
  return amt;
}

/**
 * Vardiya başlatınca: haftalık puan + aktif gün. Davet edilen oyuncu yeterli farklı günde oynadığında
 * davet edene sabit referans ödülü verilir (aylık kişi sınırı ve toplam bütçe ile).
 */
export async function onShiftStart(c, s, u, req) {
  await addPoints(c, u.id, s.points_shift);
  await c.query('INSERT INTO active_days(user_id, day) VALUES($1,$2) ON CONFLICT DO NOTHING', [u.id, dayKey()]);
  if (!u.ref_by || !(s.ref_reward_usd > 0)) return;
  if ((await c.query('SELECT 1 FROM referral_rewards WHERE referred_id = $1', [u.id])).rows[0]) return;
  const days = (await c.query('SELECT COUNT(*)::int AS n FROM active_days WHERE user_id = $1', [u.id])).rows[0].n;
  if (days < s.ref_reward_days) return;

  const month = monthKey();
  const mine = (await c.query('SELECT COALESCE(SUM(amount),0)::float AS s FROM referral_rewards WHERE referrer_id = $1 AND month = $2', [u.ref_by, month])).rows[0].s;
  const all = (await c.query('SELECT COALESCE(SUM(amount),0)::float AS s FROM referral_rewards WHERE month = $1', [month])).rows[0].s;
  const amt = Math.max(0, round2(Math.min(s.ref_reward_usd, s.ref_reward_monthly_cap - mine, s.ref_reward_month_budget - all)));
  // Sınır dolsa bile kayıt atılır ki aynı davet için tekrar denenmesin
  await c.query('INSERT INTO referral_rewards(referred_id, referrer_id, amount, month, created_at) VALUES($1,$2,$3,$4,$5)',
    [u.id, u.ref_by, amt, month, G.now()]);
  if (amt > 0) {
    await credit(c, u.ref_by, amt, 'referral', String(u.id), u.first_name || null);
    await G.notify(c, u.ref_by, `🎁 Arkadaşın ${u.first_name || 'bir oyuncu'} ${s.ref_reward_days} gün oynadı! Ödül bakiyene +${usd(amt)} eklendi.`, req);
  }
}

/** Çekim sekmesinin verileri. */
export async function rewardsInfo(c, s, u) {
  const week = weekKey();
  const points = (await c.query('SELECT points FROM weekly_points WHERE user_id = $1 AND week = $2', [u.id, week])).rows[0]?.points || 0;
  const rank = points ? (await c.query('SELECT COUNT(*)::int + 1 AS r FROM weekly_points WHERE week = $1 AND points > $2', [week, points])).rows[0].r : null;
  const players = (await c.query('SELECT COUNT(*)::int AS n FROM weekly_points WHERE week = $1 AND points > 0', [week])).rows[0].n;
  const balance = (await c.query('SELECT reward_usd FROM users WHERE id = $1', [u.id])).rows[0].reward_usd;
  const refDone = (await c.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s FROM referral_rewards WHERE referrer_id = $1', [u.id])).rows[0];
  const refTotal = (await c.query('SELECT COUNT(*)::int AS n FROM users WHERE ref_by = $1', [u.id])).rows[0].n;
  return {
    balance: round2(balance),
    withdraw_enabled: s.withdraw_enabled > 0,
    min: s.withdraw_min_usd,
    week: { key: week, points, rank, players, pool: s.weekly_pool_usd, winners: s.weekly_winners, ends_at: weekEndsAt(),
      rules: { shift: s.points_shift, daily: s.points_daily, task: s.points_task } },
    referral: { amount: s.ref_reward_usd, days: s.ref_reward_days, rewarded: refDone.n, earned: round2(refDone.s), pending: Math.max(0, refTotal - refDone.n) },
    networks: (await c.query('SELECT id, label, network, min_usd, fee_usd, color FROM payout_networks WHERE enabled = 1 ORDER BY sort, id')).rows,
    withdrawals: (await c.query('SELECT id, amount, fee, label, network, address, status, tx_hash, note, created_at FROM withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [u.id])).rows,
    ledger: (await c.query('SELECT kind, amount, ref, note, created_at FROM reward_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [u.id])).rows,
  };
}

/** Oyuncunun çekim talebi. Tutar bakiyeden hemen düşülür; reddedilirse geri eklenir. */
export async function requestWithdraw(c, s, u, body) {
  if (!(s.withdraw_enabled > 0)) throw new G.GameError('Çekimler şu anda kapalı.');
  const n = (await c.query('SELECT * FROM payout_networks WHERE id = $1 AND enabled = 1', [Number(body.network) || 0])).rows[0];
  if (!n) throw new G.GameError('Bu çekim yöntemi şu anda kapalı.');
  const address = String(body.address || '').trim();
  if (!/^[A-Za-z0-9:_\-.]{20,120}$/.test(address)) throw new G.GameError('Geçerli bir cüzdan adresi gir.');
  const amount = round2(Number(body.amount) || 0);
  const min = Math.max(s.withdraw_min_usd, n.min_usd);
  if (amount < min) throw new G.GameError(`En az ${usd(min)} çekebilirsin.`);
  if (amount <= n.fee_usd) throw new G.GameError('Tutar ağ ücretinden büyük olmalı.');
  const balance = (await c.query('SELECT reward_usd FROM users WHERE id = $1 FOR UPDATE', [u.id])).rows[0].reward_usd;
  if (amount > balance + 1e-9) throw new G.GameError('Ödül bakiyen yetersiz.');
  if ((await c.query("SELECT 1 FROM withdrawals WHERE user_id = $1 AND status IN ('pending','approved')", [u.id])).rows[0]) {
    throw new G.GameError('Sonuçlanmamış bir çekim talebin var.');
  }
  const status = s.withdraw_auto_approve > 0 ? 'approved' : 'pending';
  const row = (await c.query(`INSERT INTO withdrawals(user_id, amount, fee, network_id, label, network, address, status, created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [u.id, amount, n.fee_usd, n.id, n.label, n.network, address, status, G.now()])).rows[0];
  await credit(c, u.id, -amount, 'withdraw', String(row.id));
  return row;
}

export async function notifyAdminsWithdraw(row, user) {
  for (const aid of env.adminIds) {
    await tg('sendMessage', {
      chat_id: aid, parse_mode: 'HTML',
      text: `💸 <b>Yeni çekim talebi #${row.id}</b>\nTutar: ${usd(row.amount)} (ağ ücreti ${usd(row.fee)}, gönderilecek ${usd(row.amount - row.fee)})\n`
        + `Yöntem: ${row.label} ${row.network}\nAdres: <code>${row.address}</code>\nOyuncu: ${user.first_name || ''} (${user.id})\nDurum: ${row.status}`,
    });
  }
}

async function loadWithdrawal(c, id) {
  const w = (await c.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!w) throw new Error('Çekim talebi bulunamadı.');
  return w;
}

export async function approveWithdraw(c, id) {
  const w = await loadWithdrawal(c, id);
  if (w.status !== 'pending') throw new Error('Yalnızca bekleyen talepler onaylanabilir.');
  await c.query("UPDATE withdrawals SET status = 'approved', updated_at = $1 WHERE id = $2", [G.now(), id]);
  return 'Talep onaylandı; ödeme altyapınız bu talebi ödeyebilir.';
}

export async function markPaid(c, id, txHash, req) {
  const w = await loadWithdrawal(c, id);
  if (w.status === 'paid') return 'Bu talep zaten ödendi olarak işaretli.';
  if (w.status === 'rejected') throw new Error('Reddedilmiş talep ödenemez.');
  await c.query("UPDATE withdrawals SET status = 'paid', tx_hash = $1, updated_at = $2 WHERE id = $3", [String(txHash || '').trim().slice(0, 140) || null, G.now(), id]);
  await G.notify(c, w.user_id, `✅ Çekim talebin ödendi: ${usd(w.amount - w.fee)} ${w.label} (${w.network})${txHash ? '\nTX: ' + txHash : ''}`, req);
  return 'Ödendi olarak işaretlendi.';
}

export async function rejectWithdraw(c, id, note, req) {
  const w = await loadWithdrawal(c, id);
  if (w.status === 'paid' || w.status === 'rejected') throw new Error('Bu talep artık reddedilemez.');
  await c.query("UPDATE withdrawals SET status = 'rejected', note = $1, updated_at = $2 WHERE id = $3", [String(note || '').slice(0, 300) || null, G.now(), id]);
  await credit(c, w.user_id, w.amount, 'refund', String(w.id), 'Reddedilen çekim');
  await G.notify(c, w.user_id, `↩️ ${usd(w.amount)} tutarındaki çekim talebin reddedildi, tutar ödül bakiyene geri eklendi.${note ? '\nNot: ' + note : ''}`, req);
  return 'Talep reddedildi, tutar oyuncunun bakiyesine iade edildi.';
}

/** Haftayı kapatır: havuz, ilk N oyuncuya puanlarıyla orantılı dağıtılır. */
export async function closeWeek(c, week, pool, winners, req) {
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error('Geçersiz hafta.');
  if ((await c.query('SELECT 1 FROM reward_weeks WHERE week = $1', [week])).rows[0]) throw new Error('Bu hafta zaten kapatıldı.');
  pool = round2(Number(pool) || 0);
  winners = Math.max(1, Math.floor(Number(winners) || 1));
  const top = (await c.query(`SELECT wp.user_id, wp.points FROM weekly_points wp JOIN users u ON u.id = wp.user_id
    WHERE wp.week = $1 AND wp.points > 0 AND u.banned = 0 ORDER BY wp.points DESC, wp.user_id LIMIT $2`, [week, winners])).rows;
  const total = top.reduce((a, r) => a + r.points, 0);
  let paid = 0;
  if (pool > 0 && total > 0) {
    for (const [i, r] of top.entries()) {
      const amt = round2((pool * r.points) / total);
      if (amt <= 0) continue;
      paid += await credit(c, r.user_id, amt, 'weekly', week, `${i + 1}. sıra`);
      await G.notify(c, r.user_id, `🏆 ${week} haftasında ${i + 1}. oldun! Ödül bakiyene +${usd(amt)} eklendi. Çekim sekmesinden çekebilirsin.`, req);
    }
  }
  await c.query('INSERT INTO reward_weeks(week, pool, winners, paid_total, closed_at) VALUES($1,$2,$3,$4,$5)', [week, pool, top.length, round2(paid), G.now()]);
  return `${week} kapatıldı: ${top.length} oyuncuya toplam ${usd(paid)} dağıtıldı.`;
}
