import { env, tg } from '../lib/tg.js';

const WEBHOOK_URL = 'https://oilusdt-miniapp.vercel.app/api/bot';
const APP_URL = 'https://oilusdt-miniapp.vercel.app/';

// One-time maintenance endpoint: remove immediately after production repair.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();
  if (!env.token || !env.secret) return res.status(503).json({ ok: false, error: 'BOT_TOKEN/WEBHOOK_SECRET eksik' });
  const me = await tg('getMe');
  const before = await tg('getWebhookInfo');
  if (!me.ok) return res.status(502).json({ok:false,phase:'getMe',error:me.description});
  const set = await tg('setWebhook', {
    url: WEBHOOK_URL,
    secret_token: env.secret,
    allowed_updates: ['message', 'pre_checkout_query'],
  });
  if (!set.ok) return res.status(502).json({ok:false,phase:'setWebhook',error:set.description});
  const menu = await tg('setChatMenuButton', { menu_button: {type:'web_app',text:'Oyna',web_app:{url:APP_URL}} });
  const commands = await tg('setMyCommands', { commands: [
    {command:'start',description:'Oyunu başlat'},
    {command:'sss',description:'Sık sorulan sorular'},
    {command:'paysupport',description:'Ödeme desteği'},
  ]});
  const after = await tg('getWebhookInfo');
  const summary = wh => ({url:wh?.result?.url || null,
    pending_update_count:wh?.result?.pending_update_count ?? null,
    last_error_message:wh?.result?.last_error_message || null,
    last_error_date:wh?.result?.last_error_date || null});
  return res.status(200).json({ok:true,bot:me.result?.username,
    before:summary(before),after:summary(after),menu_ok:menu.ok,commands_ok:commands.ok});
}
