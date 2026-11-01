import crypto from 'node:crypto';

export const env = {
  token: process.env.BOT_TOKEN || '',
  // Gerçek bot adı bilinçli yedek: getMe ağına bağımlı davet linki üretme.
  username: (process.env.BOT_USERNAME || 'oilusdt286_bot').replace(/^@/, ''),
  secret: process.env.WEBHOOK_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  dev: process.env.DEV_MODE === '1',
};

/** Mini App adresi: WEBAPP_URL yoksa üretim alan adından türetilir. */
export function webappUrl(req) {
  if (process.env.WEBAPP_URL) return process.env.WEBAPP_URL;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || req?.headers?.host || 'localhost';
  return `https://${host}/`;
}

/** Telegram Bot API çağrısı. Başarısızlıkta { ok: false, ... } döner. */
export async function tg(method, params = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

/** https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export function verifyInitData(initData, maxAge = 86400) {
  if (!env.token || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const lines = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`);
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.token).digest();
  const calc = crypto.createHmac('sha256', secret).update(lines.join('\n')).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > maxAge) return null;
  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { return null; }
  if (!user?.id) return null;
  user.start_param = params.get('start_param');
  return user;
}

/** Bot kullanıcı adı: BOT_USERNAME yoksa token ile getMe'den bir kez alınır. */
export async function botUsername() {
  if (!env.username) {
    const r = await tg('getMe');
    env.username = r.result?.username || 'bot';
  }
  return env.username;
}

export const refLink = async (id) => `https://t.me/${await botUsername()}?start=r${id}`;

export const webappKeyboard = (req, text = '🛢 Oyna') => ({
  inline_keyboard: [[{ text, web_app: { url: webappUrl(req) } }]],
});

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
