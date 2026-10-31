// Botun sık sorulan sorulara verdiği cevaplar. Sayılar admin panelindeki ekonomi ayarlarından okunur.

const nf = (n) => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
const pct = (x) => '%' + nf(x * 100);

/** Karşılaştırma için: küçük harf, Türkçe karakterler sadeleştirilmiş. */
export function normalize(text) {
  return String(text || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Her konu: anahtar kelimeler (normalize edilmiş), örnek soru ve cevap.
 * Sıra önemlidir: ilk eşleşen konu cevaplanır, bu yüzden para çekme gibi kritik konular önce gelir.
 */
export const FAQ = [
  {
    keys: ['para cek', 'cekim', 'cekebil', 'cekme', 'cekilir', 'withdraw', 'nakit', 'cuzdana', 'banka', 'iban', 'gercek para', 'paraya cevir', 'odeme alabilir'],
    q: 'Kazandığım parayı çekebilir miyim?',
    a: (s) => '💵 <b>Oyun parası çekilmez, ödül bakiyesi çekilir.</b>\n\n'
      + '• Oyundaki para, güç ve petrol sadece oyun içinde geçerlidir; gerçek paraya çevrilemez.\n'
      + '• ÇEKİM sekmesindeki toplam dolar karşılığı, coin × $1 + mevcut ödül bakiyesidir. 1 coin = $1 yalnızca gösterim kurudur; coin karşılığı çekilemez ve ödül bakiyesine aktarılmaz. Referans ödülleri zaten bakiyelere dahildir, tekrar eklenmez.\n'
      + '• <b>Ödül bakiyesi</b> ise çekilebilir. Ödül bakiyesine şunlar eklenir:\n'
      + '  🏆 Haftalık yarışmada derece yapınca kazandığın ödül\n'
      + (s.ref_reward_usd > 0 ? `  👥 Davet ettiğin arkadaş ${nf(s.ref_reward_days)} gün oynayınca $${nf(s.ref_reward_usd)} referans ödülü\n` : '')
      + `\n<b>ÇEKİM</b> sekmesinden ağını seç, cüzdan adresini ve tutarı yaz (en az $${nf(s.withdraw_min_usd)}). Talebin işlenince bottan mesaj gelir.`,
  },
  {
    keys: ['kripto', 'usdt', ' ton ', 'btc', 'bitcoin', 'trx', ' tron', 'bnb', ' eth', 'ethereum', 'ltc', 'usdc', ' coin', 'cuzdan adres', 'onaylanmadi', 'onay bekl'],
    q: 'Kripto ile satın alabilir miyim?',
    a: () => '💎 <b>Evet, mağazadaki paketleri kripto ile de alabilirsin.</b>\n\n'
      + '1️⃣ Mağazada istediğin paketin fiyatına bas.\n'
      + '2️⃣ <b>Kripto ile öde</b> bölümünden coin\'ini seç.\n'
      + '3️⃣ Gösterilen cüzdan adresine <b>tam tutarı</b>, doğru ağ üzerinden gönder.\n'
      + '4️⃣ <b>Ödemeyi gönderdim</b> butonuna bas (varsa işlem kodunu da yaz).\n'
      + '5️⃣ Ödemen kontrol edilip onaylanınca paket hesabına eklenir ve sana mesaj gelir.\n\n'
      + 'ℹ️ Kripto ile alınan paketler de oyun içi içeriktir; geri çekilemez veya paraya çevrilemez.',
  },
  {
    keys: ['nasil kazan', 'kazanirim', 'kazanc', 'para kazan', 'kazanmak', 'nasil para', 'kar ', 'kar nasil', 'gelir'],
    q: 'Nasıl kazanırım?',
    a: (s) => '🛢 <b>Oyunda böyle kazanırsın:</b>\n\n'
      + `1️⃣ <b>Pompayı başlat.</b> Bir vardiya ${nf(s.shift_hours)} saat sürer. Bu sürede pompan kendi kendine petrol çıkarır.\n`
      + `2️⃣ <b>Petrolü sat.</b> 1 petrol = ${nf(s.oil_price)} oyun parası.\n`
      + `3️⃣ <b>Pompayı yükselt.</b> Her seviye üretimi ${pct(s.level_bonus)} artırır. İlk yükseltme ${nf(s.upgrade_base)} para.\n`
      + '4️⃣ <b>Vardiya bitince yeniden başlat.</b> Süre dolunca pompa durur, tekrar başlatman gerekir.\n'
      + `5️⃣ <b>Haftalık yarışma:</b> Vardiya, günlük ödül ve görevlerle ödül puanı topla; hafta sonunda ilk ${nf(s.weekly_winners)} oyuncu ödül bakiyesi kazanır (ÇEKİM sekmesinden çekilir).\n\n`
      + '<b>Daha hızlı büyümek için:</b>\n'
      + `• Günlük ödülünü al (seri yaptıkça artar, günde ${nf(s.daily_base)}'den ${nf(s.daily_base * 7)} paraya kadar)\n`
      + `• Görevleri yap, güç kazan\n`
      + `• Arkadaş davet et: üretime başlayan her arkadaş +${nf(s.ref_power)} güç, sattıkları petrolden ${pct(s.ref_share)} bonus\n\n`
      + 'ℹ️ Kazandıkların oyun parasıdır, gerçek paraya çevrilemez.',
  },
  {
    keys: ['nasil oyna', 'nasil basla', 'baslangic', 'yeni basl', 'ne yapmali', 'oyun nedir', 'nasil calisir', 'nasil isliyor'],
    q: 'Nasıl oynanır?',
    a: (s) => '🎮 <b>Kısaca Oil Pump:</b>\n\n'
      + '• Aşağıdaki <b>Oyna</b> butonuyla oyunu aç.\n'
      + '• <b>PETROL</b> ekranında yeşil <b>BAŞLAT</b> butonuna bas.\n'
      + `• Pompa ${nf(s.shift_hours)} saat boyunca petrol çıkarır, sayaç kalan süreyi gösterir.\n`
      + '• <b>SAT</b> ile petrolü oyun parasına çevir, <b>YÜKSELT</b> ile pompanı güçlendir.\n'
      + '• Süre bitince tekrar <b>BAŞLAT</b>\'a bas.\n\n'
      + 'Hepsi bu kadar! Ne kadar düzenli girersen o kadar hızlı büyürsün.',
  },
  {
    keys: ['guc ne', 'guc nedir', 'guc nasil', 'guc artir', 'guc kazan', 'power'],
    q: 'Güç nedir, nasıl artırırım?',
    a: (s) => '⚡ <b>Güç</b> pompanın ne kadar hızlı petrol çıkardığını belirler.\n\n'
      + `• Her 1.000 güç saatte ${nf(s.oil_per_kpower_hour)} petrol üretir (seviye bonusu hariç).\n`
      + `• Yeni oyuncular ${nf(s.start_power)} güçle başlar.\n\n`
      + '<b>Gücü artırmanın yolları:</b>\n'
      + '• Görevleri tamamlamak\n'
      + `• Arkadaş davet etmek (+${nf(s.ref_power)} güç / aktif arkadaş)\n`
      + '• Mağazadan güç paketi almak (Telegram Stars ile)',
  },
  {
    keys: ['yukselt', 'seviye', 'level', 'upgrade'],
    q: 'Pompayı yükseltmek ne işe yarar?',
    a: (s) => '📈 <b>Yükseltme</b> pompanın seviyesini artırır.\n\n'
      + `• Her seviye üretimi ${pct(s.level_bonus)} artırır.\n`
      + `• İlk yükseltme ${nf(s.upgrade_base)} para, sonrakiler her seferinde ${nf(s.upgrade_growth)} katına çıkar.\n`
      + `• En yüksek seviye: ${nf(s.max_level)}.\n\n`
      + 'İpucu: Satıştan kazandığın parayı yükseltmeye yatırmak uzun vadede en hızlı büyüme yoludur.',
  },
  {
    keys: [' sat ', ' satarim', ' satilir', 'satis', 'petrol sat', 'petrolu sat'],
    q: 'Petrolü nasıl satarım?',
    a: (s) => `🟠 PETROL ekranındaki turuncu <b>SAT</b> butonuna bas. Biriken petrolün tamamı satılır; 1 petrol = ${nf(s.oil_price)} oyun parası.\n\n`
      + 'Petrolü bekletmenin bir zararı yok, istediğin zaman satabilirsin.',
  },
  {
    keys: ['vardiya', 'sure', 'sayac', 'durdu', 'neden durdu', 'uretim durdu', 'zaman', '12 saat'],
    q: 'Pompam neden durdu?',
    a: (s) => `⏱ Her vardiya ${nf(s.shift_hours)} saat sürer. Süre dolunca pompa durur ve petrol birikmez.\n\n`
      + 'Yeşil butona basarak yeni vardiya başlatabilirsin. Biriken petrolün kaybolmaz, satmayı unutma.',
  },
  {
    keys: ['turbo', 'boost', 'hizlandir', '2x', 'x2'],
    q: 'Turbo nedir?',
    a: (s) => `🚀 <b>Turbo</b> belirli bir süre boyunca üretimini ${nf(s.boost_mult)} katına çıkarır.\n\n`
      + 'Mağazadan Telegram Stars ile alınır. Turbo sadece pompa çalışırken işe yarar, o yüzden almadan önce vardiyanı başlat.',
  },
  {
    keys: ['davet', 'referans', ' ref ', 'arkadas', 'ekip', 'davet linki', 'baglanti'],
    q: 'Arkadaş davet edince ne kazanırım?',
    a: (s) => '👥 <b>Davet sistemi:</b>\n\n'
      + `• Davet ettiğin arkadaş pompasını ilk kez başlattığında <b>+${nf(s.ref_power)} güç</b> kazanırsın.\n`
      + `• Arkadaşın her petrol sattığında, onun kazancının ${pct(s.ref_share)}'u kadar <b>bonus oyun parası</b> alırsın. Bu bonus arkadaşından kesilmez.\n`
      + '• Davet görevleri ekstra güç verir.\n'
      + (s.ref_reward_usd > 0 ? `• Arkadaşın ${nf(s.ref_reward_days)} farklı gün oynayınca ödül bakiyene <b>$${nf(s.ref_reward_usd)}</b> eklenir (ÇEKİM sekmesinden çekilir).\n` : '')
      + '\n'
      + 'Davet bağlantını oyunda <b>ARKADAŞLAR</b> sekmesinde bulabilirsin.',
  },
  {
    keys: ['gorev', 'gunluk', 'odul', 'bonus', 'seri'],
    q: 'Görevler ve günlük ödül nasıl çalışır?',
    a: (s) => '✅ <b>GÖREVLER</b> sekmesinde:\n\n'
      + `• <b>Günlük ödül:</b> Her gün gir ve al. Arka arkaya girdikçe artar: ${nf(s.daily_base)}, ${nf(s.daily_base * 2)}, ${nf(s.daily_base * 3)}… en fazla ${nf(s.daily_base * 7)} para. Bir gün kaçırırsan seri sıfırlanır.\n`
      + '• <b>Görevler:</b> Kanala katılmak, arkadaş davet etmek gibi görevler güç verir. Kanal görevinde önce kanala katıl, sonra <b>KONTROL ET</b>\'e bas.',
  },
  {
    keys: ['iade', 'gelmedi', 'yuklenmedi', 'eklenmedi', 'gecmedi', 'odeme sorun', 'odeme yaptim'],
    q: 'Ödeme yaptım ama ürün gelmedi.',
    a: () => '🛠 Çoğu zaman ürün birkaç saniye içinde gelir. Oyunu kapatıp tekrar aç.\n\n'
      + 'Hâlâ görünmüyorsa /paysupport yaz ve sorunu anlat; ödemeni kontrol edip ya ürünü teslim eder ya da Stars\'ını iade ederiz.',
  },
  {
    keys: ['stars', 'yildiz', 'satin al', 'magaza', 'paket', 'ucret', 'fiyat', 'odeme'],
    q: 'Mağazada ne var, nasıl satın alırım?',
    a: (s) => '⭐ <b>Mağaza</b>\'da güç paketleri, Turbo ve oyun parası paketleri var. Ödemeyi Telegram <b>Stars</b> ile ya da kripto (USDT, TRX vb.) ile yapabilirsin.\n\n'
      + '• Güç paketleri sırayla açılır: bir paketi alınca sıradaki açılır.\n'
      + `• İlk alışverişine ${pct(s.first_buy_bonus)} bonus eklenir.\n`
      + '• Satın aldıkların hemen hesabına geçer.\n'
      + '• Satın almalar oyun içi içeriktir; gerçek paraya çevrilemez.\n\n'
      + 'Satın almak zorunda değilsin; oyun tamamen ücretsiz oynanabilir.',
  },
  {
    keys: ['sirala', 'lider', ' top ', 'birinci', 'kupa'],
    q: 'Sıralama neye göre?',
    a: () => '🏆 <b>SIRALAMA</b> sekmesi, oyuncuları bugüne kadar ürettikleri toplam petrole göre sıralar. İlk 50 oyuncu listelenir, kendi sıranı da en üstte görürsün.',
  },
];

/** Mesaja uyan konunun cevabını döndürür; eşleşme yoksa null. */
export function faqAnswer(text, s) {
  const t = ' ' + normalize(text) + ' ';
  for (const f of FAQ) if (f.keys.some((k) => t.includes(k))) return f.a(s);
  return null;
}

/** /sss için örnek soruların listesi. */
export function faqMenu() {
  return '❓ <b>Sık sorulan sorular</b>\n\nBana aşağıdakilerden birini (ya da kendi cümlenle) yazabilirsin:\n\n'
    + FAQ.map((f) => '• ' + f.q).join('\n')
    + '\n\nÖdeme sorunları için: /paysupport';
}
