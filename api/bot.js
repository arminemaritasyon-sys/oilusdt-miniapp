import { tx } from '../lib/db.js';
import { env, tg, webappKeyboard, safeEqual, escHtml } from '../lib/tg.js';
import * as G from '../lib/game.js';
import { faqAnswer, faqMenu } from '../lib/faq.js';

const nf = (n) => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 0 });

export default async function handler(req, res) {
  // Yalnızca Telegram'ın gönderdiği, gizli anahtarı taşıyan istekleri kabul et
  if (req.method !== 'POST' || !env.secret || !safeEqual(env.secret, req.headers['x-telegram-bot-api-secret-token'] || '')) {
    return res.status(403).end();
  }
  const update = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  try {
    // 1) Ödeme onayı: Telegram 10 sn içinde yanıt bekler
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      let payload = {};
      try { payload = JSON.parse(q.invoice_payload); } catch {}
      const ok = await tx(async (c) => {
        const product = await G.findProduct(c, Number(payload.p) || 0);
        const user = await G.findUser(c, q.from.id);
        return !!(product && user && !user.banned && Number(payload.u) === q.from.id
          && q.currency === 'XTR' && q.total_amount === product.stars);
      });
      await tg('answerPreCheckoutQuery', ok
        ? { pre_checkout_query_id: q.id, ok: true }
        : { pre_checkout_query_id: q.id, ok: false, error_message: 'Bu ürün şu anda satın alınamıyor.' });
      return res.status(200).end();
    }

    const msg = update.message;
    if (!msg || msg.chat?.type !== 'private') return res.status(200).end();
    const from = msg.from;
    const chatId = msg.chat.id;

    // 2) Başarılı ödeme
    if (msg.successful_payment) {
      const sp = msg.successful_payment;
      let payload = {};
      try { payload = JSON.parse(sp.invoice_payload); } catch {}
      const result = await tx(async (c) => {
        const product = await G.findProduct(c, Number(payload.p) || 0, false);
        if (!product) return null;
        const s = await G.loadSettings(c);
        const granted = await G.grantPurchase(c, s, from.id, product, sp.total_amount, sp.telegram_payment_charge_id);
        return granted && { product, granted };
      });
      if (result) {
        const g = result.granted;
        const what = g.power ? `+${nf(g.power)} güç` : g.coins ? `+${nf(g.coins)} oyun parası` : `${g.boost_secs / 3600} saat Turbo`;
        await tg('sendMessage', { chat_id: chatId, text: `✅ Satın alma tamamlandı: ${result.product.title}\n${what} hesabına eklendi.`, reply_markup: webappKeyboard(req) });
        for (const aid of env.adminIds) {
          await tg('sendMessage', { chat_id: aid, text: `⭐ Yeni ödeme: ${sp.total_amount} Stars\nÜrün: ${result.product.title}\nKullanıcı: ${from.username || from.first_name} (${from.id})` });
        }
      }
      return res.status(200).end();
    }

    const text = String(msg.text || '').trim();

    // 3) /start [davet kodu]
    if (text.startsWith('/start')) {
      const param = text.slice(6).trim() || null;
      await tx(async (c) => G.ensureUser(c, await G.loadSettings(c), from, param));
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: `🛢 <b>Oil Pump'a hoş geldin, ${escHtml(from.first_name)}!</b>\n\n`
          + '⚙️ Pompanı çalıştır, petrol kendiliğinden çıksın.\n'
          + '💰 Petrolünü sat, oyun parası kazan.\n'
          + '📈 Pompanı yükselt, daha çok üret.\n'
          + '👥 Arkadaşlarını davet et, ekibini büyüt.\n\n'
          + '❓ Sorun mu var? Bana yaz, örneğin <i>"Nasıl kazanırım?"</i> ya da /sss\n\n'
          + '👇 Başlamak için dokun:',
        reply_markup: webappKeyboard(req, '🛢 Pompayı Başlat'),
      });
    } else if (text === '/paysupport') {
      await tg('sendMessage', { chat_id: chatId, text: 'Ödemeyle ilgili bir sorun yaşadıysan bu sohbete yaz; ekibimiz en kısa sürede dönüş yapacak.' });
    } else if (['/sss', '/help', '/yardim'].includes(text.split(/[\s@]/)[0])) {
      await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: faqMenu(), reply_markup: webappKeyboard(req) });
    } else if (text) {
      // Serbest yazılan soruları sık sorulan sorulardan cevapla
      const s = await tx((c) => G.loadSettings(c));
      const answer = faqAnswer(text, s);
      await tg('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        text: answer || 'Bunu tam anlayamadım 🤔\n\nÖrneğin <i>"Nasıl kazanırım?"</i>, <i>"Güç nedir?"</i> ya da <i>"Davet edince ne kazanırım?"</i> diye sorabilirsin.\nTüm sorular için: /sss',
        reply_markup: webappKeyboard(req),
      });
    }
  } catch (e) {
    // 500 dönülünce Telegram güncellemeyi tekrar gönderir; ödeme teslimi charge_id ile tekrara karşı korunur.
    console.error('[bot]', e);
    return res.status(500).end();
  }
  return res.status(200).end();
}
