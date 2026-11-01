(() => {
  'use strict';

  const tg = window.Telegram?.WebApp;
  const qs = new URLSearchParams(location.search);
  // Yerel test: tarayıcıda ?dev=1 ile açılır (sunucuda dev_mode açık olmalı)
  const initData = tg?.initData || (qs.get('dev') ? 'dev:' + qs.get('dev') : '');
  const API = '/api/game';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const short = (n) => n >= 1e9 ? fmt(n / 1e9, 2) + 'B' : n >= 1e6 ? fmt(n / 1e6, 2) + 'M' : n >= 1e4 ? fmt(n / 1e3, 1) + 'K' : fmt(n, n < 10 ? 2 : 0);

  let S = null;          // sunucu durumu
  let clockOffset = 0;   // sunucu saati - istemci saati (sn)
  let receivedAt = 0;    // durumun alındığı an (ms)
  let products = [];
  let crypto = { wallets: [] };
  let bankAccounts = [];
  let gramUsdPrice = null;
  let gramPriceUpdatedAt = 0;
  // Gramcoin (GRAM / eski TON) tutarı tahmini USD karşılığıdır;
  // gerçek ödül defteri USD olarak kalır.
  const gramNumber = (n) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  function renderGramBalance() {
    const usd = Math.max(0, Number(S?.balance) || 0);
    $('#coinUsdEquivalent').textContent = 'USD bakiye: $' + fmt(usd, 2);
    $('#coins').textContent = gramUsdPrice === null
      ? 'GRAM kuru alınamadı'
      : gramNumber(usd / gramUsdPrice) + ' GRAM';
  }
  async function refreshGramQuote() {
    try {
      const res = await fetch('/api/gram_quote', {cache:'no-store'});
      if (!res.ok) throw new Error('GRAM kuru alınamadı');
      const row = await res.json();
      const rate = Number(row.usd_per_gram);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('Geçersiz GRAM kuru');
      gramUsdPrice = rate;
      gramPriceUpdatedAt = Date.now();
    } catch {
      gramUsdPrice = null;
      gramPriceUpdatedAt = 0;
    }
    if (S) renderGramBalance();
  }
  let busy = false;
  let prefs = { haptic: true, sound: true, music: true };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('op-prefs') || '{}') }; } catch {}

  /* ---------- API ---------- */
  async function api(action, data = {}) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, initData, ref: qs.get('ref'), ...data }),
    });
    let j;
    try { j = await res.json(); } catch { throw new Error('Sunucuya ulaşılamadı.'); }
    if (!j.ok) throw new Error(j.error || 'Bir hata oluştu.');
    if (j.state) setState(j.state);
    if (j.migratedCoins > 0) setTimeout(() => toast(`${fmt(j.migratedCoins, 2)} coinin çekilebilir bakiyene ($) aktarıldı!`), 800);
    return j;
  }

  function setState(st) {
    S = st;
    receivedAt = Date.now();
    clockOffset = st.now - Date.now() / 1000;
    render();
  }

  const serverNow = () => Date.now() / 1000 + clockOffset;

  /** İstemci tarafında anlık petrol tahmini (gerçek değer sunucuda hesaplanır). */
  function liveOil() {
    if (!S) return 0;
    if (!S.running) return S.oil;
    const from = receivedAt / 1000 + clockOffset;
    const to = Math.min(serverNow(), S.shift_end);
    return S.oil + Math.max(0, to - from) * S.rate_hour / 3600;
  }

  /* ---------- Geri bildirim ---------- */
  function haptic(type = 'light') {
    if (!prefs.haptic || !tg?.HapticFeedback) return;
    if (type === 'success' || type === 'error') tg.HapticFeedback.notificationOccurred(type);
    else tg.HapticFeedback.impactOccurred(type);
  }

  // Ses efektleri: dosya indirmeden Web Audio ile üretilir. Her nota: [frekans, başlangıç sn, süre sn, dalga, ses]
  const SOUNDS = {
    tap: [[660, 0, 0.06, 'triangle', 0.1]],
    coin: [[988, 0, 0.08, 'square', 0.07], [1319, 0.07, 0.18, 'square', 0.07]],
    start: [[196, 0, 0.12, 'sawtooth', 0.08], [262, 0.1, 0.12, 'sawtooth', 0.08], [392, 0.2, 0.25, 'sawtooth', 0.08]],
    upgrade: [[523, 0, 0.1, 'triangle', 0.15], [659, 0.09, 0.1, 'triangle', 0.15], [784, 0.18, 0.1, 'triangle', 0.15], [1047, 0.27, 0.25, 'triangle', 0.15]],
    success: [[784, 0, 0.1, 'triangle', 0.15], [1047, 0.1, 0.2, 'triangle', 0.15]],
    error: [[220, 0, 0.14, 'square', 0.07], [165, 0.12, 0.22, 'square', 0.07]],
    truck: [[70, 0, 0.5, 'sawtooth', 0.06], [82, 0.25, 0.5, 'sawtooth', 0.05], [110, 0.6, 0.3, 'sawtooth', 0.04]],
    pour: [[180, 0, 0.3, 'triangle', 0.05], [150, 0.3, 0.3, 'triangle', 0.05], [130, 0.6, 0.3, 'triangle', 0.05], [120, 0.9, 0.35, 'triangle', 0.05]],
    fanfare: [[523, 0, 0.12, 'square', 0.06], [659, 0.12, 0.12, 'square', 0.06], [784, 0.24, 0.12, 'square', 0.06], [1047, 0.36, 0.4, 'square', 0.07],
      [1319, 0.36, 0.4, 'triangle', 0.08], [988, 0.5, 0.08, 'square', 0.05], [1319, 0.58, 0.25, 'square', 0.05]],
  };
  let actx;
  function sfx(name) {
    if (!prefs.sound || !SOUNDS[name]) return;
    try {
      actx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime;
      for (const [freq, start, dur, type, vol] of SOUNDS[name]) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0 + start);
        g.gain.setValueAtTime(0.0001, t0 + start);
        g.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        o.connect(g).connect(actx.destination);
        o.start(t0 + start);
        o.stop(t0 + start + dur + 0.02);
      }
    } catch {}
  }

  // Arka plan müziği: sakin country/maden havası (G-C-D-G). Dosya yok, Web Audio ile çalınır.
  const MUSIC = {
    bpm: 92,
    chords: [[98, [196, 247, 294]], [131, [262, 330, 392]], [147, [294, 370, 440]], [98, [196, 247, 294]]],
    melody: [392, 0, 440, 494, 0, 440, 392, 0, 523, 0, 494, 440, 0, 392, 330, 0, 370, 0, 440, 0, 494, 440, 370, 0, 392, 0, 0, 294, 330, 0, 392, 0],
  };
  let music = null;
  function startMusic() {
    if (!prefs.music || music || document.hidden) return;
    try {
      actx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const bus = actx.createGain();
      bus.gain.setValueAtTime(0, actx.currentTime);
      bus.gain.linearRampToValueAtTime(0.5, actx.currentTime + 2);
      bus.connect(actx.destination);
      const step = 60 / MUSIC.bpm / 2; // sekizlik
      let n = 0, next = actx.currentTime + 0.1;
      const note = (f, t, d, type, v) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(bus);
        o.start(t); o.stop(t + d + 0.05);
      };
      const len = Math.floor(actx.sampleRate * 0.04), noise = actx.createBuffer(1, len, actx.sampleRate), nd = noise.getChannelData(0);
      for (let i = 0; i < len; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const hat = (t, v) => {
        const s = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
        s.buffer = noise; f.type = 'highpass'; f.frequency.value = 6000; g.gain.value = v;
        s.connect(f).connect(g).connect(bus); s.start(t);
      };
      const timer = setInterval(() => {
        if (next < actx.currentTime) next = actx.currentTime + 0.05;
        while (next < actx.currentTime + 0.4) {
          const bar = Math.floor(n / 8) % 4, pos = n % 8;
          const [bass, triad] = MUSIC.chords[bar];
          if (pos === 0) note(bass, next, step * 1.8, 'triangle', 0.16);
          if (pos === 4) note(bass * 1.5, next, step * 1.8, 'triangle', 0.12);
          if (pos % 2 === 0) note(triad[(pos / 2) % 3], next, step * 1.4, 'triangle', 0.035);
          else note(triad[(pos + 1) % 3] * 2, next, step * 0.9, 'sine', 0.02);
          const m = MUSIC.melody[n % 32];
          if (m && Math.floor(n / 32) % 2 === 1) note(m * 2, next, step * 1.6, 'sine', 0.03);
          hat(next, pos % 2 ? 0.015 : 0.03);
          n++; next += step;
        }
      }, 100);
      music = { bus, timer };
    } catch {}
  }
  function stopMusic() {
    if (!music) return;
    const { bus, timer } = music;
    music = null;
    clearInterval(timer);
    try {
      bus.gain.cancelScheduledValues(actx.currentTime);
      bus.gain.setValueAtTime(bus.gain.value, actx.currentTime);
      bus.gain.linearRampToValueAtTime(0, actx.currentTime + 0.4);
      setTimeout(() => bus.disconnect(), 600);
    } catch {}
  }
  // Tarayıcılar sesi ilk dokunuştan sonra açar
  document.addEventListener('pointerdown', startMusic, { passive: true });

  function savePrefs() {
    try { localStorage.setItem('op-prefs', JSON.stringify(prefs)); } catch {}
  }

  let toastTimer;
  function toast(msg, err = false, sound = err ? 'error' : 'success') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
    haptic(err ? 'error' : 'success');
    sfx(sound);
  }

  function floatText(text, target) {
    const r = target.getBoundingClientRect();
    const f = el('div', 'float', esc(text));
    f.style.left = r.left + r.width / 2 - 40 + 'px';
    f.style.top = r.top - 10 + 'px';
    $('#app').appendChild(f);
    setTimeout(() => f.remove(), 1200);
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { busy = false; }
  }

  /* ---------- Petrol ekranı ---------- */
  // Zip içindeki seviye 01..10 animasyonunu API'den yükle. 11+ için 10 kullan.
  // Üretim sürerken SVG hareket eder, durduğunda aynı SVG'nin hareketsiz hâli görünür.
  const pumpAnimation = $('#pumpAnimation');
  const pumpGround = pumpAnimation?.closest('.ground');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
  function updatePumpAnimation() {
    if (!S || !pumpAnimation || !pumpGround) return;
    const lvl = Math.max(1, Math.min(10, Math.floor(Number(S.level) || 1)));
    pumpGround.classList.toggle('pump-art-high-level', lvl >= 6);
    pumpGround.classList.toggle('pump-art-tall-level', lvl >= 9);
    const still = !S.running || reducedMotion ? 1 : 0;
    const source = '/api/sondaj?level=' + lvl + '&still=' + still + '&v=1';
    if (pumpAnimation.dataset.current === source) return;
    pumpAnimation.dataset.current = source;
    pumpGround.classList.remove('pump-art-loaded');
    pumpAnimation.src = source;
  }
  if (pumpAnimation) {
    pumpAnimation.addEventListener('load', () => {
      if (pumpAnimation.naturalWidth > 0) pumpGround?.classList.add('pump-art-loaded');
    });
    pumpAnimation.addEventListener('error', () => {
      pumpGround?.classList.remove('pump-art-loaded');
      console.warn('[Oil Pump] Animasyon yüklenemedi; mevcut sondaj yedeği kullanılıyor.');
    });
  }

  function render() {
    if (!S) return;
    renderGramBalance();
    $('#power').textContent = fmt(S.power);
    $('#levelBadge').textContent = 'Seviye ' + S.level;
    $('#rateBadge').textContent = S.starter_drill_oil_24h != null
      ? '🛢 24 saatte ' + fmt(S.starter_drill_oil_24h, 2) + ' petrol'
      : fmt(S.rate_hour, S.rate_hour < 10 ? 2 : 1) + ' petrol / saat';
    $('#turboBadge').classList.toggle('hidden', !S.boost_until);
    $('#turboBadge').textContent = 'TURBO x' + S.boost_mult;
    $('#btnUpgrade').disabled = S.upgrade_cost === null;
    $('#pumpSvg').classList.toggle('paused', !S.running);
    // Saha seviyeye göre büyür: 1-4 tek kuyu, 5-9 ikinci tank, 10-19 sondaj kulesi, 20+ alev bacası
    $('#pumpSvg').dataset.tier = S.level >= 20 ? 4 : S.level >= 10 ? 3 : S.level >= 5 ? 2 : 1;
    updatePumpAnimation();
    $('#firstBonus').classList.toggle('hidden', !S.first_buy);
    $('#firstBonusPct').textContent = '+%' + Math.round(S.first_bonus * 100);
    tick();
  }

  // PETROL sayacı: sayıyı kısaltmadan kutuya sığan en büyük yazı boyutunu kullan.
  // Görsel hassasiyet 6 basamak; hesaplama ve saklanan petrol miktarı değişmez.
  const oilCounter = $('#oil');
  const oilCanvas = document.createElement('canvas');
  const oilMeasure = oilCanvas.getContext('2d');
  let lastOilText = '';
  let lastOilWidth = -1;
  function fitOilCounter(oil) {
    const starter = S?.starter_drill_usd_24h != null;
    const digits = starter ? 6 : oil < 100 ? 5 : 2;
    const label = Number(oil || 0).toLocaleString('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    });
    const available = oilCounter.parentElement?.clientWidth || 0;
    if (label === lastOilText && available === lastOilWidth) return;
    lastOilText = label;
    lastOilWidth = available;
    oilCounter.textContent = label;
    const maxFontSize = 24;
    if (!oilMeasure || available <= 0) {
      oilCounter.style.fontSize = '18px';
      return;
    }
    oilMeasure.font = '900 ' + maxFontSize + 'px "Rubik", system-ui, sans-serif';
    const textPixels = oilMeasure.measureText(label).width;
    const fitted = Math.min(maxFontSize, maxFontSize * (available - 3) / Math.max(1, textPixels));
    oilCounter.style.fontSize = Math.max(11, Math.floor(fitted * 10) / 10) + 'px';
  }
  if (typeof ResizeObserver !== 'undefined' && oilCounter.parentElement) {
    new ResizeObserver(() => {
      lastOilWidth = -1;
      if (S) fitOilCounter(liveOil());
    }).observe(oilCounter.parentElement);
  }
  document.fonts?.ready?.then(() => {
    lastOilWidth = -1;
    if (S) fitOilCounter(liveOil());
  });

  function tick() {
    if (!S) return;
    const oil = liveOil();
    fitOilCounter(oil);

    // Tank doluluğu: bir vardiyalık üretime göre
    const cap = Math.max(S.rate_hour * S.shift_hours, 0.0001);
    const h = Math.round(Math.min(oil / cap, 1) * 70);
    const fill = $('#tankFill');
    fill.setAttribute('y', 176 - h);
    fill.setAttribute('height', h);

    const btn = $('#btnStart');
    if (S.running) {
      const left = Math.max(0, S.shift_end - serverNow());
      if (left <= 0) { S.running = false; S.shift_end = null; render(); return; }
      const hh = Math.floor(left / 3600), mm = Math.floor(left % 3600 / 60), ss = Math.floor(left % 60);
      btn.textContent = [hh, mm, ss].map((v) => String(v).padStart(2, '0')).join(':');
      btn.classList.add('running');
      btn.style.setProperty('--p', (100 - left / (S.shift_hours * 36)).toFixed(2) + '%');
    } else {
      btn.textContent = oil > 0 && S.oil_total > 0 ? 'YENİDEN BAŞLAT' : 'BAŞLAT';
      btn.classList.remove('running');
    }
  }
  setInterval(tick, 250);

  // Gökyüzü telefonun saatine göre: 07–18 gündüz, 06 ve 19 alacakaranlık, gerisi gece
  function paintSky() {
    const h = new Date().getHours();
    const mode = h >= 7 && h < 19 ? 'day' : h === 6 || h === 19 ? 'dusk' : 'night';
    const sky = $('#sky');
    if (!sky.classList.contains(mode)) sky.className = 'sky ' + mode;
  }
  paintSky();
  setInterval(paintSky, 60000);

  $('#btnStart').onclick = () => {
    if (S?.running) { toast('Pompa çalışıyor. Süre dolunca yeniden başlat.', false, 'tap'); return; }
    run(async () => {
      await api('start');
      haptic('medium');
      toast('Pompa çalışmaya başladı!', false, 'start');
    });
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  $('#btnSell').onclick = () => run(async () => {
    const oil = liveOil();
    const j = await api('sell');
    if (reduceMotion) { celebrate(j.earned); return; }
    // Kamyon gelir, petrol yüklenir, kamyon gider, konfeti patlar
    const fx = $('#sellFx'), fill = $('#truckFill'), label = $('#loadLabel');
    fill.setAttribute('y', 50); fill.setAttribute('height', 0);
    fx.className = 'sell-fx drive-in';
    sfx('truck');
    await wait(1100);
    fx.className = 'sell-fx loading';
    sfx('pour');
    haptic('light');
    const t0 = performance.now();
    fill.setAttribute('y', 14); fill.setAttribute('height', 36);
    await new Promise((done) => {
      const step = (t) => {
        const k = Math.min((t - t0) / 1300, 1);
        label.textContent = '+' + fmt(oil * k, oil < 100 ? 3 : 1) + ' 🛢';
        k < 1 ? requestAnimationFrame(step) : done();
      };
      requestAnimationFrame(step);
    });
    await wait(200);
    fx.className = 'sell-fx drive-out';
    sfx('truck');
    await wait(850);
    fx.className = 'sell-fx hidden';
    celebrate(j.earned);
  });

  function celebrate(earned) {
    $('#celAmt').textContent = '+' + fmt(earned, 2);
    const c = $('#celebrate');
    c.classList.remove('hidden', 'out');
    void c.offsetWidth;
    sfx('fanfare');
    haptic('success');
    confetti();
    setTimeout(() => c.classList.add('out'), 1900);
    setTimeout(() => c.classList.add('hidden'), 2300);
  }

  function confetti() {
    if (reduceMotion) return;
    const cv = $('#confetti'), ctx = cv.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#ffd24a', '#ff6a52', '#5ad1ff', '#7be07b', '#ffffff', '#c58cff'];
    const parts = [];
    for (const [x, dir] of [[W * 0.15, 1], [W * 0.85, -1], [W * 0.5, 0]]) {
      for (let i = 0; i < 55; i++) {
        const a = -Math.PI / 2 + dir * 0.45 + (Math.random() - 0.5) * 1.1;
        const v = 7 + Math.random() * 8;
        parts.push({ x, y: H * 0.62, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
          w: 5 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[i % colors.length] });
      }
    }
    const t0 = performance.now();
    const frame = (t) => {
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.25; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        const sh = Math.abs(Math.cos(p.r * 2));
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h * sh / 2, p.w, p.h * sh + 1);
        ctx.restore();
      }
      if (t - t0 < 3200) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    requestAnimationFrame(frame);
  }

  $('#btnUpgrade').onclick = () => {
    if (!S || S.upgrade_cost === null) return;
    // Coin burada çekilebilir USD bakiyesinin oyun içi adıdır (1 Coin = 1 USD).
    const cost = Number(S.upgrade_cost);
    const balance = Math.max(0, Number(S.balance) || 0);
    const canPay = Number.isFinite(cost) && balance + 1e-9 >= cost;
    sheet(`
      <h2>Pompayı Yükselt</h2>
      <div class="rows">
        <div><span>Seviye</span><b>${S.level} → ${S.level + 1}</b></div>
        <div><span>Üretim artışı</span><b class="up">+%${fmt((S.next_mult - 1) * 100, 1)}</b></div>
        <div><span>Yükseltme bedeli</span><b>${fmt(cost, 2)} Coin</b></div>
        <div><span>Coin</span><b>${fmt(balance, 2)} Coin</b></div>
      </div>
      <div class="btns">
        <button class="btn teal" id="doUpgrade" ${canPay ? '' : 'disabled'}>${canPay ? 'COIN İLE YÜKSELT' : 'YETERSİZ COIN'}</button>
        <button class="btn done" data-close>Kapat</button>
      </div>`);
    $('#doUpgrade').onclick = () => run(async () => {
      await api('upgrade');
      closeSheet();
      toast('Pompa seviye ' + S.level + ' oldu!', false, 'upgrade');
    });
  };

  /* ---------- Sekmeler ---------- */
  const loaders = { shop: renderShop, tasks: loadTasks, friends: loadFriends, top: loadTop, withdraw: loadRewards };
  function show(v) {
    document.querySelectorAll('.view').forEach((n) => n.classList.toggle('active', n.id === 'v-' + v));
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('#btnTop').classList.toggle('on', v === 'top');
    haptic('light');
    sfx('tap');
    loaders[v]?.();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => show(b.dataset.v));
  $('#btnTop').onclick = () => show('top');

  /* ---------- Mağaza ---------- */
  const productIcon = { power: '⚡', boost: '🚀', coins: '💰' };

  /** Paketin dolar karşılığı: admin panelindeki USD fiyatı, yoksa 50 ⭐ ≈ 1 $ kabul edilir. */
  const priceUsd = (p) => (p.usd > 0 ? p.usd : p.stars / 50);
  const priceLabel = (p) => `<span class="pr-usd">$${fmt(priceUsd(p), 2)}</span>`;

  /** Paket görseli: basamak arttıkça büyüyen varil yığını. */
  function barrelArt(step) {
    const n = Math.min(step, 6);
    const pos = [[22, 38], [8, 38], [36, 38], [15, 18], [29, 18], [22, -2]].slice(0, n);
    const barrels = pos.map(([x, y]) => `<g transform="translate(${x} ${y})"><rect width="18" height="22" rx="3" fill="#c0392b"/>`
      + '<rect y="5" width="18" height="2.5" fill="#7a2a20"/><rect y="14.5" width="18" height="2.5" fill="#7a2a20"/>'
      + '<path d="M9 8.5c-1.4 2-2.2 3.1-2.2 4.2a2.2 2.2 0 0 0 4.4 0c0-1.1-.8-2.2-2.2-4.2Z" fill="#f4c35b"/></g>').join('');
    // Görünüm alanını varillerin kapladığı kareye oturt, böylece az varil de büyük görünür
    const minX = Math.min(...pos.map((p) => p[0])), maxX = Math.max(...pos.map((p) => p[0])) + 18;
    const minY = Math.min(...pos.map((p) => p[1])), maxY = Math.max(...pos.map((p) => p[1])) + 22;
    const size = Math.max(maxX - minX, maxY - minY) + 6;
    const vx = (minX + maxX - size) / 2, vy = (minY + maxY - size) / 2;
    return `<svg viewBox="${vx} ${vy} ${size} ${size}" class="tier-art">${barrels}</svg>`;
  }

  function renderShop() {
    const box = $('#products');
    box.innerHTML = '';
    if (!products.length) { box.append(el('div', 'empty', 'Şu anda satışta ürün yok.')); return; }
    const bankSection = $('#bankTransferSection');
    if (bankSection) {
      const banks = bankAccounts.slice(0,5);
      bankSection.innerHTML = banks.length
        ? `<div class="card tl-bank-card"><h3>🏦 TL havale / EFT</h3>
          <p>Ödeme yapmak için bir paket seç ve ödeme yöntemlerinden bankanı seç. IBAN, alıcı ve sipariş tutarı ödeme adımında gösterilir. Paket yalnızca banka transferi doğrulandıktan sonra verilir.</p>
          <div class="tl-banks">${banks.map(b=>`<div class="tl-bank-row">
            <span>🏦 ${esc(b.bank_name)}</span><small>Havale/EFT</small>
          </div>`).join('')}</div></div>`
        : '';
    }

    // Her oyuncunun gerçek sunucu üretim hızından 24 saatlik petrol hesabı.
    const hourRate = Math.max(0, Number(S?.rate_hour) || 0);
    const boostActive = Number(S?.boost_until) > serverNow() && Number(S?.boost_mult) > 1;
    const baseHourRate = boostActive ? hourRate / Number(S.boost_mult) : hourRate;
    const boostHoursLeft = boostActive ? Math.min(24, Math.max(0, (Number(S.boost_until) - serverNow()) / 3600)) : 0;
    const dailyOil = baseHourRate * (24 + boostHoursLeft * (boostActive ? Number(S.boost_mult) - 1 : 0));
    // Petrol miktarı ile $ değerini karıştırma: başlangıç oyuncusunda doğrudan
    // sunucunun belirlediği 24 saatlik üretim (0,05 petrol) gösterilir.
    const shownDailyOil = S?.starter_drill_oil_24h != null
      ? Number(S.starter_drill_oil_24h) : dailyOil;
    const dailyLabel = fmt(shownDailyOil, shownDailyOil > 0 && shownDailyOil < 0.01 ? 6 : 2);
    box.append(el('div', 'shop-hero', `
      <div><small>Gücün</small><b>⚡ ${fmt(S?.power || 0)}</b></div>
      <div><small>Üretim</small><b class="shop-daily">🛢 ${dailyLabel}</b><i>petrol / 24 saat</i></div>
      <div><small>Seviye</small><b>${S?.level || 1}</b></div>`));

    const ladder = products.filter((p) => p.type === 'power');
    const extras = products.filter((p) => p.type !== 'power');
    const nextStep = ladder.find((p) => !p.locked && !p.owned)?.step;

    if (ladder.length) {
      box.append(el('h2', 'shop-sec', 'Güç Paketleri <span>İstediğin paketi doğrudan seçebilirsin</span>'));
      const list = el('div', 'ladder');
      for (const p of ladder) {
        const gain = p.amount * (S?.first_buy ? 1 + S.first_bonus : 1);
        // Paket kartı: satın alınacak baz gücün 24 saatlik üretim katkısı.
        // İlk alışveriş +%30 güç ve seviye çarpanı ayrıca etki eder.
        const dailyPackOil = (Number(p.amount) / 1000) * 24 * (Number(S?.package_oil_per_kpower_hour) || 0.00625);
        const state = p.locked ? 'locked' : p.step === nextStep ? 'next' : p.owned ? 'owned' : '';
        const badge = p.locked ? '' : p.step === nextStep ? '<span class="ribbon">ŞİMDİ AÇIK</span>' : p.owned ? `<span class="ribbon owned">✓ Alındı${p.owned > 1 ? ' ×' + p.owned : ''}</span>` : '';
        const card = el('div', 'tier ' + state, `
          ${badge}
          <span class="tier-step">${p.locked ? '🔒' : p.step}</span>
          ${barrelArt(p.step)}
          <div class="tier-body">
            <b>${esc(p.title)}</b>
            <span class="gain">+${fmt(gain)} güç</span>
            <small>🛢 +${fmt(dailyPackOil, dailyPackOil < 10 ? 2 : 1)} petrol / 24 saat${S?.first_buy ? ' · ilk alım güç bonusu hariç' : ''}</small>
            ${p.locked ? `<small class="req">Önce “${esc(p.requires)}” paketini al</small>` : ''}
          </div>
          <button class="price ${p.locked ? 'is-locked' : ''}">${p.locked ? 'Kilitli' : priceLabel(p)}</button>`);
        card.querySelector('button').onclick = () => {
          if (p.locked) { toast(`Önce “${p.requires}” paketini almalısın.`, false, 'error'); return; }
          buy(p);
        };
        list.append(card);
      }
      box.append(list);
    }

    if (extras.length) {
      box.append(el('h2', 'shop-sec', 'Ekstralar'));
      const grid = el('div', 'extras');
      for (const p of extras) {
        const card = el('div', 'extra ' + p.type, `
          <span class="p-ico">${productIcon[p.type] || '🛢'}</span>
          <b>${esc(p.title)}</b>
          <p>${esc(p.description)}</p>
          <button class="price">${priceLabel(p)}</button>`);
        card.querySelector('button').onclick = () => buy(p);
        grid.append(card);
      }
      box.append(grid);
    }
  }

  /* ---------- Ödeme yöntemi ---------- */
  const SYMBOLS = { GRAMCOIN: '◈', 'BNB COIN': '⬡', TRONCOIN: '▼', USDT: '₮', USDC: '$', TRON: '▼', TRX: '▼', TON: '◆', BTC: '₿', BITCOIN: '₿', ETH: 'Ξ', ETHEREUM: 'Ξ', LTC: 'Ł', LITECOIN: 'Ł', BNB: '◈', SOL: '≡', SOLANA: '≡', DOGE: 'Ð', XRP: '✕' };
  const coinSym = (label) => SYMBOLS[String(label).toUpperCase()] || String(label)[0] || '?';
  const usd = (n) => '$' + fmt(n, 2);
  const copySvg = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 8h11v13H8Zm-4-5h11v3H7v11H4Z"/></svg>';
  let pollTimer = null;
  const stopPoll = () => { clearTimeout(pollTimer); pollTimer = null; };

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = el('textarea'); t.value = text; document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch {}
      t.remove();
    }
    toast('Kopyalandı', false, 'tap');
  }

  /** Pakete tıklayınca banka listesini yeniden sorgula; panelden yeni açılan IBAN'lar anında görünür. */
  async function buy(p) {
    stopPoll();
    try {
      const fresh = await api('banks_active');
      bankAccounts = fresh.bank_accounts || [];
    } catch (e) { console.warn('[bank payment choices]', e.message); }
    const showCrypto = crypto.wallets.length > 0 && p.usd > 0;
    const showBank = bankAccounts.length > 0 && priceUsd(p) > 0;
    const gain = p.type === 'power' ? `+${fmt(p.amount * (S?.first_buy ? 1 + S.first_bonus : 1))} güç`
      : p.type === 'coins' ? `+${fmt(p.amount * (S?.first_buy ? 1 + S.first_bonus : 1))} oyun parası` : esc(p.description);
    sheet(`
      <h2>ÖDEME YÖNTEMİ SEÇ</h2>
      <div class="pay-product"><span>${productIcon[p.type] || '🛢'}</span><div><b>${esc(p.title)}</b><small>${gain}</small></div></div>
      <button class="pay-stars" id="payStars">
        <span class="pay-star">⭐</span>
        <span class="pay-txt"><b>TELEGRAM STARS</b><small>Telefonunla öde</small></span>
        <span class="pay-amt">$${fmt(priceUsd(p), 2)}</span>
      </button>
      ${showBank ? `<div class="pay-sec">🏦 BANKA HAVALESİ / EFT <span>TL</span></div>
        <p class="bank-choose-note">Banka seçerek pakete özel TL tutarını ve ödeme açıklama kodunu oluştur. Kur ödeme siparişinde sabitlenir.</p>
        <div class="bank-choices">${bankAccounts.map(b=>`<div class="bank-option">
          <div class="bank-option-name">🏦 ${esc(b.bank_name)}</div>
          <small>Alıcı: ${esc(b.holder)}</small>
          <div class="bank-iban-row"><code>${esc(b.iban.replace(/(.{4})/g,'$1 ').trim())}</code>
            <button type="button" data-bank-copy="${esc(b.iban)}" aria-label="IBAN kopyala">${copySvg}</button></div>
          <button class="bank-select" type="button" data-bank="${b.id}">BU BANKA İLE TL ÖDE</button>
        </div>`).join('')}</div>` : ''}
      ${showCrypto ? `<div class="pay-sec">KRİPTO İLE ÖDE <span>${usd(p.usd)}</span></div>
      <div class="coins">${crypto.wallets.map((w) => `<button class="coin" data-wallet="${w.id}">
        <span class="coin-ico" style="--c:${esc(w.color)}">${esc(coinSym(w.label))}</span>
        <span><b>${esc(w.label)}</b><small>${esc(w.network)}</small></span></button>`).join('')}</div>` : ''}
      <button class="pay-cancel" data-close>Vazgeç</button>`);
    $('#payStars').onclick = () => { closeSheet(); payStars(p); };
    $('#sheet').querySelectorAll('[data-wallet]').forEach((b) => b.onclick = () => payCrypto(p, Number(b.dataset.wallet)));
    $('#sheet').querySelectorAll('[data-bank-copy]').forEach(b => b.onclick=()=>copyText(b.dataset.bankCopy));
    $('#sheet').querySelectorAll('[data-bank]').forEach(b => b.onclick=()=>payBank(p, Number(b.dataset.bank)));
  }

  function payBank(p, bankId) {
    run(async () => {
      const j = await api('bank_invoice', {id:p.id, bank:bankId});
      showBankInvoice(p, j.bank_invoice);
    });
  }

  function showBankInvoice(p, inv) {
    stopPoll();
    const amountTL = Number(inv.amount_try).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
    sheet(`
      <h2>🏦 TL HAVALE / EFT</h2>
      <div class="pay-product"><span>🏦</span><div><b>${esc(inv.bank_name)}</b>
        <small>${esc(p.title)} · ${usd(inv.usd)}</small></div></div>
      <div class="pay-field"><small>ALICI ADI</small>
        <div class="copy-row"><code>${esc(inv.holder)}</code>
          <button class="copy-btn" data-copy="${esc(inv.holder)}" aria-label="Alıcıyı kopyala">${copySvg}</button></div></div>
      <div class="pay-field"><small>IBAN</small>
        <div class="copy-row"><code>${esc(inv.iban.replace(/(.{4})/g,'$1 ').trim())}</code>
          <button class="copy-btn" data-copy="${esc(inv.iban)}" aria-label="IBAN kopyala">${copySvg}</button></div></div>
      <div class="pay-field"><small>GÖNDERİLECEK TUTAR · TÜRK LİRASI</small>
        <div class="copy-row"><b class="amt">₺${amountTL}</b>
          <button class="copy-btn" data-copy="${Number(inv.amount_try).toFixed(2)}" aria-label="Tutarı kopyala">${copySvg}</button></div></div>
      <div class="pay-field"><small>HAVALE AÇIKLAMASI · SİPARİŞ KODU</small>
        <div class="copy-row"><code>${esc(inv.code)}</code>
          <button class="copy-btn" data-copy="${esc(inv.code)}" aria-label="Açıklamayı kopyala">${copySvg}</button></div></div>
      <p class="bank-choose-note">Ödeme açıklamasına <b>${esc(inv.code)}</b> yaz. Tutar bu sipariş için 24 saat boyunca sabittir.
        Kur: 1 USD = ₺${Number(inv.rate_try).toLocaleString('tr-TR',{maximumFractionDigits:4})}.
        <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a>.
        Bu uygulama bankadan otomatik tahsilat kontrolü yapmaz; ödeme ancak yönetici banka hesabına gelen transferi doğruladıktan sonra onaylanır.</p>
      <div class="pay-status"><span class="pill" id="bankPayState"></span><span id="bankPayHint"></span></div>
      <div class="bank-confirm">
        <label>Göndericinin adı soyadı<input id="bankPayerName" class="wd-input"
          maxlength="120" placeholder="Havale gönderen kişi" value="${esc(inv.payer_name||'')}"></label>
        <label>Dekont / banka işlem numarası<input id="bankReceiptRef" class="wd-input"
          maxlength="140" placeholder="Bankadan aldığın işlem numarası"
          value="${esc(inv.receipt_reference||'')}"></label>
      </div>
      <button class="btn green" id="bankSentBtn">HAVALEYİ GÖNDERDİM</button>
      <button class="pay-cancel" id="bankOther">Başka ödeme yöntemi seç</button>
    `);
    $('#sheet').querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>copyText(b.dataset.copy));
    $('#bankOther').onclick=()=>buy(p);
    $('#bankSentBtn').onclick=()=>run(async()=>{
      const payer=$('#bankPayerName').value.trim();
      const receipt=$('#bankReceiptRef').value.trim();
      const response=await api('bank_submit',{invoice_id:inv.id,payer_name:payer,receipt_reference:receipt});
      inv=response.bank_invoice;
      paintBankState(inv);
      toast('Havale bildirimin yöneticiye iletildi. Kontrol bekleniyor.');
    });
    paintBankState(inv);
    pollBankInvoice(p,inv.id);
  }
  function paintBankState(inv) {
    const label=$('#bankPayState'),hint=$('#bankPayHint'),sent=$('#bankSentBtn');
    if(!label)return;
    const expired=inv.status==='expired'||(inv.status==='waiting'&&serverNow()>inv.expires_at);
    const descriptions={waiting:['ÖDEME BEKLENİYOR','Havale sonrası dekont bilgisiyle bildir.'],
      submitted:['ONAY BEKLENİYOR','Banka transferi yönetici tarafından kontrol ediliyor.'],
      rejected:['DOĞRULANAMADI','Destek için yöneticiye ulaş.'],
      paid:['ONAYLANDI','Paket hesabına eklendi.']};
    const [status,info]=expired?['SÜRESİ DOLDU','Yeni paket siparişi oluştur.']:descriptions[inv.status]||descriptions.waiting;
    label.textContent=status;label.className='pill'+(expired||inv.status==='rejected'?' err':inv.status==='submitted'?' wait':'');
    hint.textContent=info;
    if(sent){sent.disabled=expired||inv.status!=='waiting';}
    $('#bankPayerName').disabled=inv.status!=='waiting';
    $('#bankReceiptRef').disabled=inv.status!=='waiting';
  }
  function pollBankInvoice(p,id) {
    stopPoll();
    const check=async()=>{
      if($('#modal').classList.contains('hidden')||!$('#bankPayState')) return stopPoll();
      try{
        const r=await api('bank_status',{invoice_id:id});
        if(r.bank_invoice.status==='paid'){
          if(r.products)products=r.products;
          closeSheet(); renderShop();
          toast('TL ödemen onaylandı: '+p.title,false,'upgrade');
          return;
        }
        paintBankState(r.bank_invoice);
      }catch{}
      pollTimer=setTimeout(check,8000);
    };
    pollTimer=setTimeout(check,8000);
  }

  function payCrypto(p, walletId) {
    run(async () => {
      const { invoice } = await api('crypto_invoice', { id: p.id, wallet: walletId });
      showInvoice(p, invoice);
    });
  }

  /** Cüzdan adresi + benzersiz tutar ekranı. Oyuncu gönderip bildirir, admin onaylar. */
  function showInvoice(p, inv) {
    const tag = `${esc(inv.label)}${inv.network ? ' · ' + esc(inv.network) : ''}`;
    sheet(`
      <h2>KRİPTO PARAYI GÖNDER</h2>
      <div class="pay-field">
        <small>CÜZDAN ADRESİ · ${tag}</small>
        <div class="copy-row"><code>${esc(inv.address)}</code><button class="copy-btn" data-copy="${esc(inv.address)}" aria-label="Adresi kopyala">${copySvg}</button></div>
      </div>
      <div class="pay-field">
        <small>TUTAR · ${tag}</small>
        <div class="copy-row"><b class="amt">${esc(inv.amount)}</b><button class="copy-btn" data-copy="${esc(inv.amount)}" aria-label="Tutarı kopyala">${copySvg}</button></div>
      </div>
      <div class="pay-status"><span class="pill" id="payState"></span><span id="payHint"></span></div>
      <div class="pay-note">Bu adrese <b>tam olarak ${esc(inv.amount)} ${esc(inv.label)}</b> gönder${inv.network ? ` (<b>${esc(inv.network)}</b> ağı)` : ''}. Tutar farklı olursa ödemen eşleşmeyebilir. Gönderdikten sonra aşağıdaki butona bas; ödemen kontrol edilip onaylanınca <b>${esc(p.title)}</b> hesabına eklenir.</div>
      <div id="txArea"><input id="txHash" class="tx-input" placeholder="İşlem kodu (TX) – isteğe bağlı" value="${esc(inv.tx_hash || '')}"></div>
      <button class="btn green" id="sentBtn">ÖDEMEYİ GÖNDERDİM</button>
      <button class="pay-cancel" id="otherCoin">Başka coin seç</button>`);
    $('#sheet').querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyText(b.dataset.copy));
    $('#otherCoin').onclick = () => buy(p);
    $('#sentBtn').onclick = () => run(async () => {
      const j = await api('crypto_submit', { invoice_id: inv.id, tx_hash: $('#txHash').value });
      inv = j.invoice;
      paintState(inv);
      toast('Bildirimin alındı, ödemen kontrol ediliyor.', false, 'success');
    });
    paintState(inv);
    pollInvoice(p, inv.id);
  }

  function paintState(inv) {
    const pill = $('#payState'), hint = $('#payHint');
    if (!pill) return;
    const expired = inv.status === 'expired' || (inv.status === 'waiting' && serverNow() > inv.expires_at);
    const map = {
      waiting: ['ÖDEME BEKLENİYOR', 'Gönderince aşağıdaki butona bas'],
      submitted: ['ONAY BEKLENİYOR', 'Ödemen kontrol ediliyor, onaylanınca paket eklenir'],
      rejected: ['DOĞRULANAMADI', 'Sorun varsa bota /paysupport yaz'],
    };
    const [txt, sub] = expired ? ['SÜRESİ DOLDU', 'Yeni ödeme oluşturmak için başka coin seç'] : map[inv.status] || map.waiting;
    pill.textContent = txt;
    pill.className = 'pill' + (expired || inv.status === 'rejected' ? ' err' : inv.status === 'submitted' ? ' wait' : '');
    hint.textContent = sub;
    const sent = $('#sentBtn');
    if (sent) {
      sent.disabled = expired || inv.status === 'rejected';
      sent.textContent = inv.status === 'submitted' ? 'TX KODUNU GÜNCELLE' : 'ÖDEMEYİ GÖNDERDİM';
    }
  }

  /** Pencere açıkken onay durumunu yoklar; onaylanınca mağazayı yeniler. */
  function pollInvoice(p, id) {
    stopPoll();
    const check = async () => {
      if ($('#modal').classList.contains('hidden') || !$('#payState')) return stopPoll();
      try {
        const j = await api('crypto_status', { invoice_id: id });
        if (j.invoice.status === 'paid') {
          if (j.products) products = j.products;
          closeSheet();
          renderShop();
          toast('Ödemen onaylandı: ' + p.title, false, 'upgrade');
          return;
        }
        paintState(j.invoice);
      } catch {}
      pollTimer = setTimeout(check, 8000);
    };
    pollTimer = setTimeout(check, 8000);
  }

  function payStars(p) {
    run(async () => {
      const j = await api('invoice', { id: p.id });
      if (j.dev_paid) {
        products = (await api('init')).products;
        renderShop();
        toast('Test satın alma tamamlandı: ' + p.title, false, 'upgrade');
        return;
      }
      if (!tg?.openInvoice) throw new Error('Ödeme yalnızca Telegram içinde yapılabilir.');
      tg.openInvoice(j.link, async (status) => {
        if (status === 'paid') {
          toast('Ödeme alındı, ürün hesabına ekleniyor…');
          // Bot ödemeyi işledikten sonra güncel durumu çek
          const before = S.paid_count;
          for (let i = 0; i < 6 && S.paid_count === before; i++) {
            await new Promise((r) => setTimeout(r, 1200));
            products = (await api('init')).products;
          }
          renderShop();
          toast('Satın alma tamamlandı: ' + p.title, false, 'upgrade');
        } else if (status === 'failed') {
          toast('Ödeme başarısız oldu.', true);
        }
      });
    });
  }

  /* ---------- Görevler ---------- */
  async function loadTasks() {
    try {
      const j = await api('tasks');
      const d = j.daily;
      const daily = $('#daily');
      daily.innerHTML = `
        <span class="d-ico">📅</span>
        <div class="d-txt"><b>Günlük ödül</b><small>${d.streak ? d.streak + ' günlük seri · ' : ''}${d.claimed ? 'Yarın: ' : 'Bugün: '}+${fmt(d.next)} para</small></div>
        <button class="btn small ${d.claimed ? 'done' : 'gold'}" ${d.claimed ? 'disabled' : ''}>${d.claimed ? 'ALINDI' : 'AL'}</button>`;
      daily.querySelector('button').onclick = () => run(async () => {
        const r = await api('daily');
        toast('Günlük ödül: +' + fmt(r.reward) + ' para');
        loadTasks();
      });

      const list = $('#taskList');
      list.innerHTML = '';
      if (!j.tasks.length) list.append(el('div', 'empty', 'Şu anda görev yok.'));
      for (const t of j.tasks) list.append(taskCard(t));
    } catch (e) { toast(e.message, true); }
  }

  const kindLabel = { invite: 'DAVET', channel: 'ABONELİK', link: 'ZİYARET' };
  function taskCard(t) {
    const pct = t.progress != null ? Math.round(t.progress / t.count * 100) : 0;
    const ring = t.type === 'invite' ? `<div class="ring" style="--p:${pct}%"><span>${t.progress}/${t.count}</span></div>` : '';
    const label = t.done ? 'TAMAM' : t.type === 'invite' ? (t.progress >= t.count ? 'AL' : 'DAVET ET') : t.opened ? 'KONTROL ET' : 'YAP';
    const card = el('div', 'card task', `
      <div class="t-txt">
        <span class="t-kind">${kindLabel[t.type] || 'GÖREV'}</span>
        <b>${esc(t.title)}</b>
        <small>${esc(t.subtitle || '')}</small>
        <span class="reward">+${fmt(t.reward)} ⚡</span>
      </div>
      ${ring}
      <button class="btn small ${t.done ? 'done' : 'gold'}" ${t.done ? 'disabled' : ''}>${label}</button>`);
    const btn = card.querySelector('button');
    btn.onclick = () => {
      if (t.type === 'invite' && t.progress < t.count) { show('friends'); return; }
      if ((t.type === 'channel' || t.type === 'link') && !t.opened) {
        t.opened = true;
        openLink(t.url);
        btn.textContent = 'KONTROL ET';
        return;
      }
      run(async () => {
        const r = await api('task', { id: t.id });
        toast('Görev tamamlandı: +' + fmt(r.reward) + ' güç');
        loadTasks();
      });
    };
    return card;
  }

  function openLink(url) {
    if (!url) return;
    if (url.startsWith('https://t.me/') && tg?.openTelegramLink) tg.openTelegramLink(url);
    else if (tg?.openLink) tg.openLink(url);
    else window.open(url, '_blank');
  }

  /* ---------- Arkadaşlar ---------- */
  let refLink = '';
  async function loadFriends() {
    try {
      const { friends: f } = await api('friends');
      refLink = f.link;
      $('#refLink').value = f.link;
      $('#refPower').textContent = '+' + fmt(f.ref_power);
      $('#fTotal').textContent = fmt(f.total);
      $('#fActive').textContent = fmt(f.active);
      $('#fEarned').textContent = short(f.earned);
      const refRates = Array.isArray(f.ref_rates) ? f.ref_rates.slice(0, 9) : [];
      // Yüzdeler sunucudaki gerçek referans oranlarından gelir; sabitlenmez.
      $('#refShareText').innerHTML = `
        <h3 class="ref-earn-title">👥 9 Seviyeli Referans Kazancı</h3>
        <p class="ref-earn-intro">Arkadaşlarının petrol satışlarından aşağıdaki seviyelere göre pay kazanırsın:</p>
        <ol class="ref-earn-list">
          ${refRates.map((rate, i) => `
            <li>
              <span class="ref-earn-level"><span class="ref-earn-index">${i + 1}</span> ${i + 1}. Seviye</span>
              <strong>%${Number((Number(rate) * 100).toFixed(2)).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</strong>
            </li>`).join('')}
        </ol>
        <p class="ref-earn-foot">Bu kazançlar arkadaşlarının bakiyesinden kesilmez. Oranlar ilgili seviyedeki oyuncunun petrol satışına uygulanır.</p>`;
      const list = $('#friendList');
      list.innerHTML = '';
      if (!f.list.length) list.append(el('div', 'empty', 'Henüz davet ettiğin kimse yok.'));
      for (const x of f.list) {
        list.append(el('div', 'li', `<span class="nm">${esc(x.name)}</span><span class="vl">${short(x.oil)} 🛢</span><span class="tag ${x.active ? '' : 'off'}">${x.active ? 'AKTİF' : 'BEKLİYOR'}</span>`));
      }
    } catch (e) { toast(e.message, true); }
  }

  $('#btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(refLink); toast('Bağlantı kopyalandı'); }
    catch { $('#refLink').select(); document.execCommand('copy'); toast('Bağlantı kopyalandı'); }
  };
  $('#btnInvite').onclick = () => {
    const text = '🛢 Benimle Oil Pump oyna! Pompanı kur, petrol çıkar, ekibini büyüt.';
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(refLink) + '&text=' + encodeURIComponent(text);
    openLink(url);
  };

  /* ---------- Ödül çekimi ---------- */
  let RW = null;
  let wdNet = null;
  const money = (n) => '$' + fmt(n, 2);
  const kindName = { weekly: 'Haftalık ödül', referral: 'Referans ödülü', oil_referral: 'Petrol referans kazancı', oil_sale: 'Petrol satış kazancı', upgrade: 'Pompa yükseltme', coin_migration: 'Mevcut coin aktarımı', withdraw: 'Çekim talebi', refund: 'Çekim iadesi', admin: 'Düzeltme' };
  const wdStatus = { pending: 'BEKLEMEDE', approved: 'ONAYLANDI', paid: 'ÖDENDİ', rejected: 'REDDEDİLDİ' };

  function timeLeft(ts) {
    const s = Math.max(0, ts - serverNow());
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}g ${h}s` : h ? `${h}s ${m}dk` : `${m}dk`;
  }

  async function loadRewards() {
    try {
      RW = (await api('rewards')).rewards;
      renderRewards();
    } catch (e) { toast(e.message, true); }
  }

  const kindIco = { weekly: '🏆', referral: '👥', oil_referral: '👥', oil_sale: '🛢', upgrade: '⚡', coin_migration: '🪙', withdraw: '↗', refund: '↩', admin: '⚙' };
  const fmtDate = (t) => new Date(t * 1000).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  /** Bakiye hareketleri + çekim talepleri, en yeniden eskiye. */
  function rewardMoves(r) {
    return [
      ...r.withdrawals.map((x) => ({ t: x.created_at, kind: 'withdraw', title: `Çekim · ${x.label} ${x.network}`,
        sub: x.tx_hash ? 'TX ' + x.tx_hash.slice(0, 12) + '…' : x.address.slice(0, 6) + '…' + x.address.slice(-4),
        amount: -x.amount, status: x.status })),
      ...r.ledger.filter((l) => l.kind !== 'withdraw').map((l) => ({ t: l.created_at, kind: l.kind, title: kindName[l.kind] || l.kind,
        sub: [l.ref, l.note].filter(Boolean).join(' · '), amount: l.amount })),
    ].sort((a, b) => b.t - a.t);
  }
  const moveRow = (m) => `<div class="mv">
      <span class="mv-ico k-${m.kind}">${kindIco[m.kind] || '•'}</span>
      <span class="mv-txt"><b>${esc(m.title)}</b><small>${fmtDate(m.t)}${m.sub ? ' · ' + esc(m.sub) : ''}</small></span>
      <span class="mv-amt"><b class="${m.amount > 0 ? 'plus' : 'minus'}">${m.amount > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</b>${m.status ? `<span class="st ${m.status}">${wdStatus[m.status]}</span>` : ''}</span>
    </div>`;
  const emptyMoves = '<div class="mv-empty">Henüz hesap hareketi yok.<br>Haftalık yarışmadan ve referans ödüllerinden kazandıkların burada görünür.</div>';

  // Display equivalent only: never use this total to authorize or fund withdrawals.
  function walletDisplay(coins, balance) {
    const coinUsd = Number(coins) * 1; // User-selected display rate: 1 coin = 1 USD.
    const availableUsd = Number(balance); // Already includes credited referral rewards.
    return { coinUsd, availableUsd, totalUsd: coinUsd + availableUsd };
  }

  function renderRewards() {
    const r = RW;
    $('#rwBalance').textContent = fmt(r.balance, 2);
    if (S && Number.isFinite(Number(r.balance))) { S.balance = Number(r.balance); render(); }
    $('#rwCoinAmount').textContent = fmt(S.coins, 2);
    const w = r.week;
    $('#rwBanner').innerHTML = `<button class="wl-banner" id="rwContest">
        <span class="wb-ico">🏆</span>
        <span class="wb-txt"><b>Haftalık yarışma${w.pool > 0 ? ' · ' + money(w.pool) : ''}</b>
          <small>${w.rank ? `Sıran #${fmt(w.rank)} · ${fmt(w.points)} puan` : 'Pompanı çalıştır, puan topla'} · bitişe ${timeLeft(w.ends_at)}</small></span>
        <span class="wb-go">›</span></button>`;
    $('#rwContest').onclick = showEarn;
    const moves = rewardMoves(r);
    $('#rwBody').innerHTML = moves.slice(0, 10).map(moveRow).join('') || emptyMoves;
    $('#rwAll').classList.toggle('hidden', moves.length <= 10);
  }

  function showHistory() {
    const moves = rewardMoves(RW);
    sheet(`<h2>Hesap hareketleri</h2><div class="wl-list in-sheet">${moves.map(moveRow).join('') || emptyMoves}</div>
      <div class="btns"><button class="btn done" data-close>Kapat</button></div>`);
  }

  function showEarn() {
    const w = RW.week, ref = RW.referral;
    sheet(`<h2>Ödül kazan</h2>
      <div class="card rw-card">
        <h3>🏆 Haftalık yarışma <small>Bitişe ${timeLeft(w.ends_at)}</small></h3>
        <div class="rw-stats">
          <div><b>${fmt(w.points)}</b><small>Puanın</small></div>
          <div><b>${w.rank ? '#' + fmt(w.rank) : '-'}</b><small>Sıran / ${fmt(w.players)}</small></div>
          <div><b>${w.pool > 0 ? money(w.pool) : '-'}</b><small>Havuz</small></div>
        </div>
        <p>${w.pool > 0 ? `Hafta sonunda ilk <b>${fmt(w.winners)}</b> oyuncu, havuzu puanlarına göre paylaşır.` : 'Bu hafta ödül havuzu açıklanmadı.'}
          Puan: vardiya başlatma +${fmt(w.rules.shift)}, günlük ödül +${fmt(w.rules.daily)}, görev +${fmt(w.rules.task)}. Satın almalar puan kazandırmaz.</p>
      </div>
      ${ref.amount > 0 ? `<div class="card rw-card">
        <h3>👥 Referans ödülü <small>+${money(ref.amount)} / arkadaş</small></h3>
        <div class="rw-stats">
          <div><b>${fmt(ref.rewarded)}</b><small>Ödül alınan</small></div>
          <div><b>${fmt(ref.pending)}</b><small>Bekleyen</small></div>
          <div><b>${money(ref.earned)}</b><small>Toplam kazanılan (geçmiş)</small></div>
        </div>
        <p>Davet ettiğin arkadaş <b>${fmt(ref.days)}</b> farklı günde pompasını çalıştırınca toplam çekilebilir bakiyene eklenir. Buradaki geçmiş kazanç ayrı bir bakiye değildir.</p>
      </div>` : ''}
      <div class="btns"><button class="btn gold" id="goInvite">ARKADAŞ DAVET ET</button><button class="btn done" data-close>Kapat</button></div>`);
    $('#goInvite').onclick = () => { closeSheet(); show('friends'); };
  }

  function showWithdraw() {
    const r = RW;
    const open = r.withdrawals.find((x) => x.status === 'pending' || x.status === 'approved');
    if (!r.withdraw_enabled || !r.networks.length) { toast('Çekimler şu anda kapalı.', true); return; }
    if (open) {
      sheet(`<h2>Çekim talebin</h2>
        <div class="pay-box"><span class="coin-ico big" style="--c:#26a17b">${esc(coinSym(open.label))}</span>
          <div><small>${esc(open.label)} · ${esc(open.network)}</small><b class="amt">${money(open.amount)}</b></div></div>
        <div class="wd-status"><small class="mono">${esc(open.address)}</small><span class="st ${open.status}">${wdStatus[open.status]}</span></div>
        <p class="wd-info">Talebin işleniyor. Ödeme yapılınca sana bottan mesaj gelecek.</p>
        <div class="btns"><button class="btn done" data-close>Kapat</button></div>`);
      return;
    }
    if (!wdNet || !r.networks.some((n) => n.id === wdNet)) wdNet = r.networks[0].id;
    const net = r.networks.find((n) => n.id === wdNet);
    const min = Math.max(10, r.min, net.min_usd || 0);
    sheet(`<h2>Çekim</h2>
      <div class="pay-sec">ÇEKİLEBİLİR BAKİYE <span>${money(r.balance)}</span></div><div class="pay-sec">YÖNTEM SEÇ</div>
      <div class="coins">${(r.display_networks || r.networks).map((n) => `<button
        class="coin${n.id === wdNet ? ' sel' : ''}${!n.enabled ? ' unavailable' : ''}"
        ${n.enabled ? `data-net="${n.id}"` : 'disabled aria-disabled="true"'}>
        <span class="coin-ico" style="--c:${esc(n.color)}">${esc(coinSym(n.label))}</span>
        <span><b>${esc(n.label)}</b><small>${esc(n.network)}${!n.enabled ? ' · Yakında' : ''}</small></span>
      </button>`).join('')}</div>
      <p class="wd-info">Talep tutarı USD'dir. Ödenecek coin tutarı ödeme günündeki kura ve ağ masrafına bağlıdır.</p>
      <input id="wdAddr" class="wd-input mono" placeholder="${esc(net.label)} ${esc(net.network)} cüzdan adresin" autocomplete="off" style="margin-top:12px">
      <div class="wd-amt"><input id="wdAmt" class="wd-input" type="number" step="0.01" min="${min}" placeholder="Tutar ($)"><button class="wd-max" id="wdMax">MAKS</button></div>
      <p class="wd-info" id="wdInfo"></p>
      <div class="btns"><button class="btn gold" id="wdBtn" ${r.balance < min ? 'disabled' : ''}>ÇEKİM TALEBİ OLUŞTUR</button></div>
      <button class="pay-cancel" data-close>Vazgeç</button>`);
    $('#sheet').querySelectorAll('[data-net]').forEach((b) => b.onclick = () => { wdNet = Number(b.dataset.net); sfx('tap'); showWithdraw(); });
    const amt = $('#wdAmt');
    const info = () => {
      const a = Number(amt.value) || 0, fee = net.fee_usd || 0;
      $('#wdInfo').innerHTML = `En az ${money(min)}${fee ? ` · ağ ücreti ${money(fee)}` : ''}${a > fee ? ` · cüzdanına geçecek: <b>${money(a - fee)}</b>` : ''}`;
    };
    amt.oninput = info;
    info();
    $('#wdMax').onclick = () => { amt.value = Math.floor(r.balance * 100) / 100; info(); };
    $('#wdBtn').onclick = () => run(async () => {
      const a = Number(amt.value) || 0;
      if (!Number.isFinite(a) || a < min || a > r.balance) { toast('Çekim tutarı ' + money(min) + ' ile kullanılabilir bakiye arasında olmalı.', true); return; }
      const address = $('#wdAddr').value.trim();
      if (!confirm(`${money(a)} çekim talebi oluşturulsun mu?\n\nAdres: ${address}\nAğ: ${net.label} ${net.network}\n\nAdresi kontrol et; yanlış adrese gönderilen ödeme geri alınamaz.`)) return;
      RW = (await api('withdraw', { network: wdNet, address, amount: a })).rewards;
      closeSheet();
      renderRewards();
      toast('Çekim talebin alındı.', false, 'coin');
    });
  }

  const wlActions = { withdraw: showWithdraw, earn: showEarn, history: showHistory };
  document.querySelectorAll('.wl-actions [data-act]').forEach((b) => b.onclick = () => {
    if (!RW) return;
    sfx('tap'); haptic('light');
    wlActions[b.dataset.act]();
  });
  $('#rwAll').onclick = () => RW && showHistory();

  /* ---------- Sıralama ---------- */
  async function loadTop() {
    try {
      const { top } = await api('top');
      $('#myRank').textContent = '#' + fmt(top.me);
      const list = $('#topList');
      list.innerHTML = '';
      top.list.forEach((r, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || i + 1;
        list.append(el('div', 'li' + (r.me ? ' me' : ''), `<span class="rank">${medal}</span><span class="nm">${esc(r.name)}</span><span class="vl">${short(r.oil)} 🛢</span>`));
      });
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- Modal ---------- */
  function sheet(html) {
    $('#sheet').innerHTML = html;
    $('#modal').classList.remove('hidden');
    $('#sheet').querySelectorAll('[data-close]').forEach((b) => b.onclick = closeSheet);
  }
  function closeSheet() { $('#modal').classList.add('hidden'); }
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeSheet(); };

  $('#btnSettings').onclick = () => {
    sheet(`
      <h2>Ayarlar</h2>
      <div class="rows">
        <div><span>Ses efektleri</span><b><button class="btn small ${prefs.sound ? 'green' : 'done'}" id="tSound">${prefs.sound ? 'AÇIK' : 'KAPALI'}</button></b></div>
        <div><span>Müzik</span><b><button class="btn small ${prefs.music ? 'green' : 'done'}" id="tMusic">${prefs.music ? 'AÇIK' : 'KAPALI'}</button></b></div>
        <div><span>Titreşim</span><b><button class="btn small ${prefs.haptic ? 'green' : 'done'}" id="tHaptic">${prefs.haptic ? 'AÇIK' : 'KAPALI'}</button></b></div>
      </div>
      <div class="btns">
        <button class="btn account-delete" id="openAccountDelete">🗑️ Hesabımı Sil</button>
        <button class="btn done" data-close>Kapat</button>
      </div>`);
    $('#openAccountDelete').onclick = () => {
      sheet(`
        <h2>⚠️ Hesabımı Sil</h2>
        <div class="account-delete-warning">
          <b>Bu işlem geri alınamaz.</b>
          <p>Petrolün, pompa seviyen, gücün, görevlerin ve mevcut Coin/çekilebilir bakiyen sıfırlanır. Satın aldığın paketler yeni hesabına geri verilmez.</p>
          <p>Yalnızca <b>Beklemede</b> durumundaki çekim talebi silmeyi engeller. <b>Onaylandı</b> ve <b>Ödendi</b> çekimlerinde hesabını silebilirsin. Kripto siparişleri engel olmaz; geçmiş ödeme kayıtları ve varsa henüz yapılmamış ödeme yükümlülükleri korunur.</p>
          <p>Tekrar giriş yaptığında oyuna başlangıç seviyesinden devam edebilirsin.</p>
        </div>
        <label class="account-delete-label" for="accountDeleteWord">Onaylamak için <b>HESABIMI SİL</b> yaz:</label>
        <input id="accountDeleteWord" type="text" placeholder="HESABIMI SİL" autocomplete="off" autocapitalize="characters" spellcheck="false">
        <div class="btns">
          <button class="btn account-delete" id="confirmAccountDelete" disabled>HESABI KALICI OLARAK SİL</button>
          <button class="btn done" id="cancelAccountDelete">Vazgeç</button>
        </div>`);
      const phrase = $('#accountDeleteWord');
      const confirmDelete = $('#confirmAccountDelete');
      phrase.oninput = () => {
        confirmDelete.disabled = phrase.value.trim().toLocaleUpperCase('tr-TR') !== 'HESABIMI SİL';
      };
      $('#cancelAccountDelete').onclick = () => $('#btnSettings').onclick();
      confirmDelete.onclick = () => run(async () => {
        if (phrase.value.trim().toLocaleUpperCase('tr-TR') !== 'HESABIMI SİL') return;
        confirmDelete.disabled = true;
        const result = await api('delete_account', {
          confirmation: 'HESABIMI SİL',
          accept_forfeit: true,
        });
        if (!result.deleted) throw new Error('Hesap silme tamamlanamadı.');
        S = null;
        RW = null;
        wdNet = null;
        products = [];
        closeSheet();
        try {
          const fresh = await api('init');
          products = fresh.products || [];
          crypto = fresh.crypto || { wallets: [] };
          bankAccounts = fresh.bank_accounts || [];
          show('pump');
          toast('Hesabın silindi. Yeni hesabın başlangıç seviyesinden açıldı.');
        } catch (e) {
          toast('Hesabın silindi. Tekrar başlamak için uygulamayı yeniden aç.', true);
        }
      });
    };
    $('#tSound').onclick = () => {
      prefs.sound = !prefs.sound;
      savePrefs();
      sfx('tap');
      $('#btnSettings').onclick();
    };
    $('#tMusic').onclick = () => {
      prefs.music = !prefs.music;
      savePrefs();
      prefs.music ? startMusic() : stopMusic();
      $('#btnSettings').onclick();
    };
    $('#tHaptic').onclick = () => {
      prefs.haptic = !prefs.haptic;
      savePrefs();
      haptic('medium');
      $('#btnSettings').onclick();
    };
  };

  /* ---------- Başlangıç ---------- */
  async function boot() {
    if (tg) {
      tg.ready();
      tg.expand();
      try { tg.setHeaderColor('#0c1330'); tg.setBackgroundColor('#1b1512'); tg.disableVerticalSwipes?.(); } catch {}
    }
    if (!initData) {
      $('#loadMsg').textContent = 'Bu oyun Telegram içinden açılmalıdır.';
      return;
    }
    try {
      const j = await api('init');
      products = j.products;
      crypto = j.crypto || crypto;
      bankAccounts = j.bank_accounts || [];
      refreshGramQuote();
      $('#loader').classList.add('out');
      setTimeout(() => $('#loader').classList.add('hidden'), 400);
    } catch (e) {
      $('#loadMsg').textContent = e.message;
    }
  }

  // Uygulama arka plandan dönünce durumu tazele
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopMusic(); else startMusic();
    if (!document.hidden && S) api('init').then((j) => { products = j.products; crypto = j.crypto || crypto; bankAccounts = j.bank_accounts || bankAccounts; }).catch(() => {});
    if (!document.hidden && (!gramPriceUpdatedAt || Date.now()-gramPriceUpdatedAt > 300000)) refreshGramQuote();
  });

  boot();
})();
