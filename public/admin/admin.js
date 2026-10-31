(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (n, d = 0) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const dt = (t) => (t ? new Date(t * 1000).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '-');
  const main = $('#main');
  let token = '';
  try { token = sessionStorage.getItem('op-admin') || ''; } catch {}
  let flash = '';

  async function api(action, data = {}) {
    const r = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action, ...data }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'Sunucuya ulaşılamadı.' }));
    if (j.relogin) { logout(); throw new Error(j.error); }
    if (!j.ok) throw new Error(j.error || 'Hata');
    return j;
  }

  function showLogin(on) {
    $('#login').classList.toggle('hidden', !on);
    $('#side').classList.toggle('hidden', on);
    main.classList.toggle('hidden', on);
    document.body.classList.toggle('is-login', on);
  }
  function logout() {
    token = '';
    try { sessionStorage.removeItem('op-admin'); } catch {}
    showLogin(true);
  }

  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#loginErr');
    try {
      const j = await api('login', { password: e.target.password.value });
      token = j.token;
      try { sessionStorage.setItem('op-admin', token); } catch {}
      e.target.reset();
      err.classList.add('hidden');
      showLogin(false);
      route();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };

  /* ---------- Yardımcılar ---------- */
  function page(html, dev) {
    main.innerHTML = (dev ? '<div class="alert err">DEV MODU AÇIK — canlıda DEV_MODE ortam değişkenini kaldırın.</div>' : '')
      + (flash ? `<div class="alert">${esc(flash)}</div>` : '') + html;
    flash = '';
  }
  const formData = (f) => Object.fromEntries([...new FormData(f).entries()].concat([...f.querySelectorAll('input[type=checkbox]')].map((c) => [c.name, c.checked])));
  function bindForm(sel, action, after) {
    const f = $(sel);
    if (!f) return;
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { const j = await api(action, formData(f)); flash = j.msg || 'Kaydedildi.'; after ? after(j) : route(); }
      catch (ex) { alert(ex.message); }
    };
  }
  const field = (label, name, value, type = 'text', extra = '') =>
    `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${type === 'number' ? 'step="any"' : ''} ${extra}></label>`;
  const check = (label, name, on) => `<label class="chk"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
  const select = (label, name, opts, value) =>
    `<label>${label}<select name="${name}">${Object.entries(opts).map(([k, v]) => `<option value="${k}"${k === value ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;

  function paymentsTable(rows, refund) {
    const tr = rows.map((p) => {
      const g = JSON.parse(p.granted || '{}');
      const given = g.power ? nf(g.power) + ' güç' : g.coins ? nf(g.coins) + ' para' : g.boost_secs ? g.boost_secs / 3600 + ' sa turbo' : '-';
      const st = p.refunded ? 'İade edildi' : refund ? `<button class="sm" data-refund="${p.id}">İade et</button>` : 'Tamam';
      return `<tr${p.refunded ? ' class="ban"' : ''}><td>${p.id}</td><td>${dt(p.created_at)}</td><td><a href="#user/${p.user_id}">${esc(p.first_name || p.user_id)}</a></td><td>${esc(p.title || '-')}</td><td>${p.stars} ⭐</td><td>${given}</td><td>${st}</td></tr>`;
    }).join('') || '<tr><td colspan="7">Henüz ödeme yok.</td></tr>';
    return `<table><tr><th>#</th><th>Tarih</th><th>Kullanıcı</th><th>Ürün</th><th>Stars</th><th>Verilen</th><th>Durum</th></tr>${tr}</table>`;
  }
  function bindRefunds() {
    main.querySelectorAll('[data-refund]').forEach((b) => b.onclick = async () => {
      if (!confirm('Stars iade edilsin ve verilen ürün geri alınsın mı?')) return;
      try { flash = (await api('refund', { id: b.dataset.refund })).msg; route(); } catch (e) { alert(e.message); }
    });
  }

  /* ---------- Sayfalar ---------- */
  const pages = {
    async dash() {
      const j = await api('dash');
      page(`<h1>Özet</h1><div class="grid">${Object.entries(j.stats).map(([k, v]) => `<div class="card stat"><small>${k}</small><b>${nf(v)}${k.includes('Stars') ? ' ⭐' : ''}</b></div>`).join('')}</div>
        <h2>Son ödemeler</h2>${paymentsTable(j.payments, false)}`, j.dev);
    },

    async users(arg) {
      const params = new URLSearchParams(arg || '');
      const j = await api('users', { q: params.get('q') || '', sort: params.get('sort') || '' });
      const rows = j.users.map((u) => `<tr${u.banned ? ' class="ban"' : ''}><td><a href="#user/${u.id}">${u.id}</a></td><td>${esc(u.first_name)}${u.username ? ` <small>@${esc(u.username)}</small>` : ''}</td>
        <td>${nf(u.power)}</td><td>${u.level}</td><td>${nf(u.coins, 2)}</td><td>${nf(u.oil_total, 2)}</td><td>${nf(u.stars_spent)}</td>
        <td>${u.ref_by ? `<a href="#user/${u.ref_by}">${u.ref_by}</a>` : '-'}</td><td>${dt(u.created_at)}</td></tr>`).join('');
      page(`<h1>Kullanıcılar</h1><form class="bar" id="uq"><input name="q" value="${esc(params.get('q') || '')}" placeholder="ID, kullanıcı adı veya isim"><button>Ara</button>
        <a href="#users/sort=oil">Üretime göre</a> · <a href="#users/sort=stars">Stars'a göre</a></form>
        <table><tr><th>ID</th><th>İsim</th><th>Güç</th><th>Sev.</th><th>Para</th><th>Toplam petrol</th><th>Stars</th><th>Davet eden</th><th>Kayıt</th></tr>${rows}</table>`, j.dev);
      $('#uq').onsubmit = (e) => { e.preventDefault(); location.hash = 'users/q=' + encodeURIComponent(e.target.q.value); };
    },

    async user(id) {
      const j = await api('user', { id });
      const u = j.user;
      const cards = { 'Ödül bakiyesi': '$' + nf(u.reward_usd, 2), 'Toplam petrol': nf(u.oil_total, 2), 'Harcanan Stars': nf(u.stars_spent) + ' ⭐', 'Davet': `${j.refs.total} (${j.refs.active} aktif)`,
        'Davet kazancı (oyun parası)': nf(u.ref_earned, 2), 'Son görülme': dt(u.last_seen), 'Kayıt': dt(u.created_at) };
      page(`<h1>${esc(u.first_name)} <small>${u.id}${u.username ? ' · @' + esc(u.username) : ''}</small></h1>
        <div class="grid">${Object.entries(cards).map(([k, v]) => `<div class="card stat"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
        <h2>Düzenle</h2><form class="card form" id="uf"><input type="hidden" name="id" value="${u.id}">
        ${field('Güç', 'power', Math.round(u.power), 'number')}${field('Para', 'coins', Math.round(u.coins * 1e4) / 1e4, 'number')}${field('Seviye', 'level', u.level, 'number', 'min="1"')}
        ${check('Yasaklı', 'banned', u.banned)}<button>Kaydet</button></form>
        <h2>Ödül bakiyesi düzelt</h2><form class="card form" id="rf"><input type="hidden" name="id" value="${u.id}">
        ${field('Tutar ($, eksi değer düşer)', 'amount', '', 'number')}${field('Not', 'note', '')}<button>Uygula</button></form>
        <h2>Ödemeleri</h2>${paymentsTable(j.payments, true)}`, j.dev);
      bindForm('#uf', 'user_save');
      bindForm('#rf', 'reward_adjust');
      bindRefunds();
    },

    async payments() {
      const j = await api('payments');
      page('<h1>Ödemeler</h1>' + paymentsTable(j.payments, true), j.dev);
      bindRefunds();
    },

    async products(editId) {
      const j = await api('products');
      const rows = j.products.map((p) => `<tr><td>${p.sort}</td><td>${esc(p.title)}</td><td>${esc(p.description)}</td><td>${p.type}</td><td>${nf(p.amount)}</td><td>${p.hours}</td><td>${p.stars} ⭐</td><td>${p.usd > 0 ? nf(p.usd, 2) + ' $' : '-'}</td><td>${p.active ? 'Aktif' : 'Pasif'}</td><td><a href="#products/${p.id}">Düzenle</a></td></tr>`).join('');
      const e = j.products.find((p) => String(p.id) === editId) || { id: 0, title: '', description: '', stars: 50, usd: 1, type: 'power', amount: 0, hours: 0, sort: 0, active: 1 };
      page(`<h1>Ürünler <small>Telegram Stars veya kripto cüzdanı ile satılan oyun içi paketler. Güç paketleri sırayla açılır.</small></h1>
        <table><tr><th>Sıra</th><th>Başlık</th><th>Açıklama</th><th>Tür</th><th>Miktar</th><th>Saat</th><th>Stars</th><th>Kripto</th><th>Durum</th><th></th></tr>${rows}</table>
        <h2>${e.id ? 'Ürünü düzenle' : 'Yeni ürün'}</h2><form class="card form" id="pf"><input type="hidden" name="id" value="${e.id}">
        ${field('Başlık', 'title', e.title, 'text', 'required')}${field('Açıklama', 'description', e.description)}
        ${select('Tür', 'type', { power: 'Güç', boost: 'Turbo (süreli)', coins: 'Oyun parası' }, e.type)}
        ${field('Miktar (güç/para)', 'amount', e.amount, 'number')}${field('Süre (saat, turbo için)', 'hours', e.hours, 'number')}
        ${field('Fiyat (Stars)', 'stars', e.stars, 'number', 'min="1"')}${field('Kripto fiyatı (USD, 0 = kripto ile satılmaz)', 'usd', e.usd, 'number', 'min="0"')}
        ${field('Sıra', 'sort', e.sort, 'number')}${check('Aktif', 'active', e.active)}<button>Kaydet</button></form>`, j.dev);
      bindForm('#pf', 'product_save', () => { location.hash = 'products'; route(); });
    },

    async tasks(editId) {
      const j = await api('tasks');
      const rows = j.tasks.map((t) => `<tr><td>${t.sort}</td><td>${t.type}</td><td>${esc(t.title)}</td><td>${esc(t.target)}</td><td>${t.count}</td><td>${nf(t.reward)}</td><td>${nf(t.done)}</td><td>${t.active ? 'Aktif' : 'Pasif'}</td><td><a href="#tasks/${t.id}">Düzenle</a></td></tr>`).join('');
      const e = j.tasks.find((t) => String(t.id) === editId) || { id: 0, type: 'channel', title: '', subtitle: '', target: '', count: 0, reward: 500, sort: 0, active: 1 };
      page(`<h1>Görevler</h1><table><tr><th>Sıra</th><th>Tür</th><th>Başlık</th><th>Hedef</th><th>Sayı</th><th>Ödül (güç)</th><th>Tamamlayan</th><th>Durum</th><th></th></tr>${rows}</table>
        <h2>${e.id ? 'Görevi düzenle' : 'Yeni görev'}</h2><form class="card form" id="tf"><input type="hidden" name="id" value="${e.id}">
        ${select('Tür', 'type', { channel: 'Kanal aboneliği (bot kanalda admin olmalı)', link: 'Bağlantı ziyareti', invite: 'Arkadaş daveti' }, e.type)}
        ${field('Başlık', 'title', e.title, 'text', 'required')}${field('Alt yazı', 'subtitle', e.subtitle)}
        ${field('Hedef (@kanal veya https://…)', 'target', e.target || '')}${field('Davet sayısı (davet görevi)', 'count', e.count, 'number')}
        ${field('Ödül (güç)', 'reward', e.reward, 'number')}${field('Sıra', 'sort', e.sort, 'number')}${check('Aktif', 'active', e.active)}<button>Kaydet</button></form>`, j.dev);
      bindForm('#tf', 'task_save', () => { location.hash = 'tasks'; route(); });
    },

    async settings() {
      const j = await api('settings');
      const v = j.values;
      const ex = (v.start_power / 1000) * v.oil_per_kpower_hour * v.shift_hours;
      page(`<h1>Ekonomi ayarları</h1><form class="card form" id="sf">
        ${Object.entries(j.defs).map(([k, d]) => field(esc(d.label), k, v[k], 'number')).join('')}<button>Kaydet</button></form>
        <p class="hint">Örnek: Yeni bir oyuncu bir vardiyada ${nf(ex, 2)} petrol üretir = ${nf(ex * v.oil_price, 2)} oyun parası. İlk yükseltme ${nf(v.upgrade_base)} para.</p>`, j.dev);
      const f = $('#sf');
      f.onsubmit = async (e) => {
        e.preventDefault();
        try { flash = (await api('settings_save', { values: Object.fromEntries(new FormData(f)) })).msg; route(); } catch (ex2) { alert(ex2.message); }
      };
    },

    async broadcast(runId) {
      const j = await api('broadcasts');
      const rows = j.broadcasts.map((b) => `<tr><td>${dt(b.created_at)}</td><td>${esc(b.text.slice(0, 80))}${b.text.length > 80 ? '…' : ''}</td><td>${b.sent}</td><td>${b.failed}</td><td>${b.done ? 'Bitti' : `<a href="#broadcast/${b.id}">Devam et</a>`}</td></tr>`).join('');
      let group = '@oilusdtt';
      try { group = localStorage.getItem('op-group') || group; } catch {}
      page(`<h1>Toplu mesaj</h1>${runId ? '<div class="card"><b id="bcStatus">Gönderiliyor…</b><p class="hint">Bu sayfayı kapatmayın.</p></div>' : ''}
        <h2>Oyunculara (bota start verenler)</h2>
        <form class="card form" id="bf"><label class="wide">Mesaj (HTML: &lt;b&gt;, &lt;i&gt;, &lt;a href&gt;)<textarea name="text" rows="6" required></textarea></label>${check('“Oyna” butonu ekle', 'btn', true)}<button>Gönder</button></form>
        <h2>Gruba / kanala</h2>
        <form class="card form" id="gf">${field('Grup veya kanal (@kullanıcıadı ya da t.me bağlantısı)', 'chat', group, 'text', 'required')}
        <label class="wide">Mesaj (HTML: &lt;b&gt;, &lt;i&gt;, &lt;a href&gt;)<textarea name="text" rows="6" required></textarea></label>
        ${check('“Oyna” butonu ekle', 'btn', true)}${check('Mesajı sabitle', 'pin', false)}<button>Gruba gönder</button></form>
        <p class="hint">Bot gruba üye olmalı ve mesaj gönderme yetkisi olmalı; kanalsa botu yönetici yapın. Sabitlemek için botun “mesaj sabitleme” yetkisi gerekir. Grupta buton botu açar, oyuncu oradan oyuna girer.</p>
        <h2>Geçmiş</h2><table><tr><th>Tarih</th><th>Mesaj</th><th>Gönderilen</th><th>Başarısız</th><th>Durum</th></tr>${rows}</table>`, j.dev);
      bindForm('#bf', 'broadcast_create', (r) => { location.hash = 'broadcast/' + r.id; });
      const gf = $('#gf');
      gf.onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(gf);
        if (!confirm(`Mesaj ${d.chat} grubuna gönderilsin mi?`)) return;
        try {
          flash = (await api('group_send', d)).msg;
          try { localStorage.setItem('op-group', d.chat); } catch {}
          location.hash = 'broadcast';
          route();
        } catch (ex) { alert(ex.message); }
      };
      if (runId) {
        const s = $('#bcStatus');
        for (;;) {
          let r;
          try { r = await api('broadcast_step', { id: runId }); } catch (e) { s.textContent = 'Hata: ' + e.message; break; }
          if (!s.isConnected) break;
          s.textContent = `${r.done ? 'Tamamlandı' : 'Gönderiliyor'}: ${r.sent} gönderildi, ${r.failed} başarısız`;
          if (r.done) break;
        }
      }
    },

    async crypto(arg) {
      const status = arg || 'submitted';
      const j = await api('winvoices', { status });
      const names = { submitted: 'Onay bekleyen', waiting: 'Gönderilmedi', paid: 'Onaylanan', rejected: 'Reddedilen', expired: 'Süresi dolan' };
      const tabs = Object.entries(names).map(([k, v]) => `<a href="#crypto/${k}"${k === status ? ' class="tab on"' : ' class="tab"'}>${v} (${j.counts[k] || 0})</a>`).join('');
      const rows = j.invoices.map((r) => `<tr><td>${r.id}</td><td>${dt(r.submitted_at || r.created_at)}</td>
        <td><a href="#user/${r.user_id}">${esc(r.first_name || r.user_id)}</a></td><td>${esc(r.title || '-')}</td>
        <td><b>${esc(r.amount)}</b> ${esc(r.label)}<br><small>${esc(r.network)} · ${nf(r.usd, 2)} $</small></td>
        <td><small class="mono">${esc(r.address)}</small></td>
        <td>${r.tx_hash ? `<small class="mono">${esc(r.tx_hash)}</small>` : '-'}${r.note ? `<br><small>Not: ${esc(r.note)}</small>` : ''}</td>
        <td>${['submitted', 'waiting', 'expired'].includes(r.status)
          ? `<button class="ok" data-approve="${r.id}">Onayla</button> <button class="sm" data-reject="${r.id}">Reddet</button>` : names[r.status] || r.status}</td></tr>`).join('')
        || '<tr><td colspan="8">Kayıt yok.</td></tr>';
      page(`<h1>Kripto ödemeler</h1>
        <p class="hint">Oyuncu "Ödemeyi gönderdim" dediğinde ödeme <b>Onay bekleyen</b> sekmesine düşer. Cüzdanınızda <b>tam tutarı</b> (ve varsa TX kodunu) kontrol edip onaylayın; paket anında verilir ve oyuncuya bottan mesaj gider. Her siparişin tutarı benzersizdir, ödemeyi tutardan tanıyabilirsiniz.</p>
        <div class="tabs">${tabs}</div>
        <table><tr><th>#</th><th>Tarih</th><th>Oyuncu</th><th>Paket</th><th>Tutar</th><th>Adres</th><th>TX / Not</th><th></th></tr>${rows}</table>`, j.dev);
      main.querySelectorAll('[data-approve]').forEach((b) => b.onclick = async () => {
        if (!confirm('Ödemeyi cüzdanınızda gördünüz mü? Onaylanınca paket oyuncuya verilir.')) return;
        try { flash = (await api('winv_approve', { id: b.dataset.approve })).msg; route(); } catch (e) { alert(e.message); }
      });
      main.querySelectorAll('[data-reject]').forEach((b) => b.onclick = async () => {
        const note = prompt('Oyuncuya iletilecek not (isteğe bağlı):', 'Ödeme cüzdanımıza ulaşmadı.');
        if (note === null) return;
        try { flash = (await api('winv_reject', { id: b.dataset.reject, note })).msg; route(); } catch (e) { alert(e.message); }
      });
    },

    async wallets(editId) {
      const j = await api('wallets');
      const rows = j.wallets.map((w) => `<tr><td>${w.sort}</td><td><span class="dot" style="background:${esc(w.color)}"></span> <b>${esc(w.label)}</b></td><td>${esc(w.network)}</td>
        <td><small class="mono">${esc(w.address)}</small></td><td>${w.price_id === 'usd' ? 'Sabit 1 $' : esc(w.price_id)}</td><td>${w.decimals}</td><td>${w.enabled ? 'Açık' : 'Kapalı'}</td>
        <td><a href="#wallets/${w.id}">Düzenle</a> · <a href="#" data-del="${w.id}">Sil</a></td></tr>`).join('') || '<tr><td colspan="8">Henüz cüzdan eklenmedi. Oyunda kripto seçeneği görünmez.</td></tr>';
      const e = j.wallets.find((w) => String(w.id) === editId) || { id: 0, label: 'USDT', network: 'TRC-20', address: '', price_id: 'usd', decimals: 4, color: '#26a17b', sort: 0, enabled: 1 };
      page(`<h1>Cüzdanlar <small>Oyuncuların ödeme göndereceği adresler</small></h1>
        <table><tr><th>Sıra</th><th>Coin</th><th>Ağ</th><th>Adres</th><th>Kur</th><th>Ondalık</th><th>Durum</th><th></th></tr>${rows}</table>
        <h2>${e.id ? 'Cüzdanı düzenle' : 'Yeni cüzdan ekle'}</h2>
        <form class="card form" id="wf"><input type="hidden" name="id" value="${e.id}">
        ${field('Coin adı (ör. USDT, TRON, BNB)', 'label', e.label, 'text', 'required')}${field('Ağ (ör. TRC-20, BEP-20, TON)', 'network', e.network)}
        <label class="wide">Cüzdan adresi<input name="address" value="${esc(e.address)}" required class="mono"></label>
        ${field('Kur kaynağı (usd = sabit 1$, ya da CoinGecko kimliği)', 'price_id', e.price_id)}
        ${field('Tutar ondalık hanesi (2–8)', 'decimals', e.decimals, 'number', 'min="2" max="8"')}
        <label>Renk<input name="color" type="color" value="${esc(e.color)}"></label>
        ${field('Sıra', 'sort', e.sort, 'number')}${check('Oyunda göster', 'enabled', e.enabled)}<button>Kaydet</button></form>
        <p class="hint"><b>Kur kaynağı:</b> USDT/USDC için <code>usd</code> yazın (1 coin = 1 $). Diğerleri için CoinGecko kimliği: TRON → <code>tron</code>, BNB → <code>binancecoin</code>, TON → <code>the-open-network</code>, Bitcoin → <code>bitcoin</code>, Ethereum → <code>ethereum</code>, Solana → <code>solana</code>, Litecoin → <code>litecoin</code>.<br>
        <b>Ondalık:</b> USDT için 4, TRX/TON için 6, BTC/ETH/BNB için 8 önerilir. Her siparişe son hanelerde benzersiz küçük bir fark eklenir; ödemeyi bu tutardan tanırsınız.<br>
        Adresi iki kez kontrol edin: yanlış adrese giden kripto geri alınamaz.</p>`, j.dev);
      bindForm('#wf', 'wallet_save', () => { location.hash = 'wallets'; route(); });
      main.querySelectorAll('[data-del]').forEach((a) => a.onclick = async (ev) => {
        ev.preventDefault();
        if (!confirm('Bu cüzdan silinsin mi?')) return;
        try { flash = (await api('wallet_delete', { id: a.dataset.del })).msg; route(); } catch (e2) { alert(e2.message); }
      });
    },

    async rewards(week) {
      const j = await api('rewards', { week });
      const usd = (v) => '$' + nf(v, 2);
      const rows = j.top.map((r, i) => `<tr><td>${i + 1}</td><td><a href="#user/${r.user_id}">${esc(r.first_name || r.user_id)}</a>${r.username ? ` <small>@${esc(r.username)}</small>` : ''}</td><td>${nf(r.points)}</td></tr>`).join('')
        || '<tr><td colspan="3">Bu hafta henüz puan yok.</td></tr>';
      const weeks = j.weeks.map((w) => `<tr><td><a href="#rewards/${w.week}">${w.week}</a></td><td>${usd(w.pool)}</td><td>${w.winners}</td><td>${usd(w.paid_total)}</td><td>${dt(w.closed_at)}</td></tr>`).join('')
        || '<tr><td colspan="5">Henüz kapatılan hafta yok.</td></tr>';
      const refs = j.referrals.map((r) => `<tr><td>${dt(r.created_at)}</td><td><a href="#user/${r.referrer_id}">${esc(r.referrer_name || r.referrer_id)}</a></td><td>${esc(r.referred_name || r.referred_id)}</td><td>${r.amount > 0 ? usd(r.amount) : 'Sınır doldu'}</td></tr>`).join('')
        || '<tr><td colspan="4">Henüz referans ödülü verilmedi.</td></tr>';
      page(`<h1>Haftalık ödül <small>${j.week}${j.week === j.current ? ' · bu hafta' : ''}</small></h1>
        <div class="bar"><a href="#rewards/${j.current}" class="tab${j.week === j.current ? ' on' : ''}">Bu hafta</a><a href="#rewards/${j.previous}" class="tab${j.week === j.previous ? ' on' : ''}">Geçen hafta</a></div>
        ${j.closed ? `<div class="alert">Bu hafta kapatıldı: ${j.closed.winners} oyuncuya ${usd(j.closed.paid_total)} dağıtıldı (${dt(j.closed.closed_at)}).</div>`
          : `<form class="card form" id="wcf"><input type="hidden" name="week" value="${j.week}">
            ${field('Dağıtılacak havuz ($)', 'pool', j.pool, 'number', 'min="0"')}${field('Kazanan sayısı', 'winners', j.winners, 'number', 'min="1"')}
            <button>Haftayı kapat ve ödülleri dağıt</button></form>
            <p class="hint">Havuz, ilk N oyuncuya ödül puanlarıyla orantılı dağıtılır ve oyuncuların <b>ödül bakiyesine</b> eklenir. Oyunda gösterilen havuz ve kazanan sayısı Ekonomi ayarlarından gelir. ${j.week === j.current ? '<b>Dikkat:</b> bu hafta henüz bitmedi.' : ''}</p>`}
        <table><tr><th>#</th><th>Oyuncu</th><th>Puan</th></tr>${rows}</table>
        <h2>Kapatılan haftalar</h2><table><tr><th>Hafta</th><th>Havuz</th><th>Kazanan</th><th>Dağıtılan</th><th>Tarih</th></tr>${weeks}</table>
        <h2>Referans ödülleri</h2><table><tr><th>Tarih</th><th>Davet eden</th><th>Davet edilen</th><th>Ödül</th></tr>${refs}</table>`, j.dev);
      const f = $('#wcf');
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const d = formData(f);
        if (!confirm(`${d.week} haftası kapatılsın ve $${d.pool} dağıtılsın mı? Bu işlem geri alınamaz.`)) return;
        try { flash = (await api('week_close', d)).msg; route(); } catch (ex) { alert(ex.message); }
      };
    },

    async withdrawals(arg) {
      const [status, editId] = String(arg || 'pending').split('/');
      const j = await api('withdrawals', { status });
      const usd = (v) => '$' + nf(v, 2);
      const names = { pending: 'Bekleyen', approved: 'Onaylanan (ödenecek)', paid: 'Ödenen', rejected: 'Reddedilen' };
      const tabs = Object.entries(names).map(([k, v]) => `<a href="#withdrawals/${k}" class="tab${k === j.status ? ' on' : ''}">${v} (${j.counts[k] || 0})</a>`).join('');
      const rows = j.rows.map((w) => `<tr><td>${w.id}</td><td>${dt(w.created_at)}</td><td><a href="#user/${w.user_id}">${esc(w.first_name || w.user_id)}</a></td>
        <td><b>${usd(w.amount - w.fee)}</b><br><small>talep ${usd(w.amount)} · ücret ${usd(w.fee)}</small></td><td>${esc(w.label)}<br><small>${esc(w.network)}</small></td>
        <td><small class="mono">${esc(w.address)}</small></td><td>${w.tx_hash ? `<small class="mono">${esc(w.tx_hash)}</small>` : '-'}${w.note ? `<br><small>Not: ${esc(w.note)}</small>` : ''}</td>
        <td>${w.status === 'pending' ? `<button class="ok" data-ap="${w.id}">Onayla</button> ` : ''}${['pending', 'approved'].includes(w.status) ? `<button class="ok" data-paid="${w.id}">Ödendi</button> <button class="sm" data-rej="${w.id}">Reddet</button>` : names[w.status]}</td></tr>`).join('')
        || '<tr><td colspan="8">Kayıt yok.</td></tr>';
      const nets = j.networks.map((n) => `<tr><td>${n.sort}</td><td><span class="dot" style="background:${esc(n.color)}"></span> <b>${esc(n.label)}</b></td><td>${esc(n.network)}</td><td>${usd(n.min_usd)}</td><td>${usd(n.fee_usd)}</td><td>${n.enabled ? 'Açık' : 'Kapalı'}</td>
        <td><a href="#withdrawals/${j.status}/${n.id}">Düzenle</a> · <a href="#" data-pdel="${n.id}">Sil</a></td></tr>`).join('') || '<tr><td colspan="7">Çekim yöntemi yok.</td></tr>';
      const e = j.networks.find((n) => String(n.id) === editId) || { id: 0, label: 'USDT', network: 'TRC-20', min_usd: 5, fee_usd: 1, color: '#26a17b', sort: 0, enabled: 1 };
      page(`<h1>Çekimler <small>Ödül bakiyesinden çekim talepleri</small></h1>
        <p class="hint">Talep oluşturulunca tutar oyuncunun ödül bakiyesinden düşülür. <b>Reddet</b> tutarı geri ekler. Ödemeyi yaptıktan sonra <b>Ödendi</b> deyip TX kodunu girin; oyuncuya bottan mesaj gider.
        ${j.api ? 'Otomatik ödeme API\'si açık (PAYOUT_API_KEY tanımlı).' : 'Otomatik ödeme altyapınızı bağlamak için Vercel\'e <code>PAYOUT_API_KEY</code> ekleyin.'}</p>
        <div class="tabs">${tabs}</div>
        <table><tr><th>#</th><th>Tarih</th><th>Oyuncu</th><th>Gönderilecek</th><th>Yöntem</th><th>Adres</th><th>TX / Not</th><th></th></tr>${rows}</table>
        <h2>Çekim yöntemleri</h2><table><tr><th>Sıra</th><th>Coin</th><th>Ağ</th><th>En az</th><th>Ağ ücreti</th><th>Durum</th><th></th></tr>${nets}</table>
        <h2>${e.id ? 'Yöntemi düzenle' : 'Yeni çekim yöntemi'}</h2><form class="card form" id="pnf"><input type="hidden" name="id" value="${e.id}">
        ${field('Coin adı', 'label', e.label, 'text', 'required')}${field('Ağ', 'network', e.network)}
        ${field('En az çekim ($)', 'min_usd', e.min_usd, 'number', 'min="0"')}${field('Ağ ücreti ($, tutardan düşülür)', 'fee_usd', e.fee_usd, 'number', 'min="0"')}
        <label>Renk<input name="color" type="color" value="${esc(e.color)}"></label>${field('Sıra', 'sort', e.sort, 'number')}${check('Açık', 'enabled', e.enabled)}<button>Kaydet</button></form>`, j.dev);
      bindForm('#pnf', 'pnet_save', () => { location.hash = 'withdrawals/' + j.status; route(); });
      const act = async (action, data, ask) => { if (ask && !confirm(ask)) return; try { flash = (await api(action, data)).msg; route(); } catch (ex) { alert(ex.message); } };
      main.querySelectorAll('[data-ap]').forEach((b) => b.onclick = () => act('wd_approve', { id: b.dataset.ap }, 'Talep onaylansın mı?'));
      main.querySelectorAll('[data-paid]').forEach((b) => b.onclick = () => {
        const txh = prompt('Ödemenin TX kodu (isteğe bağlı):', '');
        if (txh !== null) act('wd_paid', { id: b.dataset.paid, tx_hash: txh });
      });
      main.querySelectorAll('[data-rej]').forEach((b) => b.onclick = () => {
        const note = prompt('Oyuncuya iletilecek not (isteğe bağlı):', '');
        if (note !== null) act('wd_reject', { id: b.dataset.rej, note });
      });
      main.querySelectorAll('[data-pdel]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); act('pnet_delete', { id: a.dataset.pdel }, 'Bu çekim yöntemi silinsin mi?'); });
    },

    async setup() {
      const j = await api('setup_info');
      const w = j.wh.result || {};
      page(`<h1>Kurulum</h1><div class="card">
        <p><b>Bot:</b> ${j.me.ok ? '@' + esc(j.me.result.username) : `<span class="bad">Token geçersiz veya tanımsız: ${esc(j.me.description || '')}</span>`}</p>
        <p><b>Kurulu webhook:</b> ${esc(w.url || '-')}</p>
        ${w.last_error_message ? `<p class="bad">Son hata: ${esc(w.last_error_message)} (${dt(w.last_error_date)})</p>` : ''}
        <p><b>Bekleyen güncelleme:</b> ${w.pending_update_count || 0}</p>
        <p><b>Mini App adresi:</b> ${esc(j.webapp)}</p>
        <p><b>Webhook adresi:</b> ${esc(j.webhook)}</p>
        <button id="doSetup">Webhook, menü butonu ve komutları kur</button></div>
        <p class="hint">Kanal görevleri için botu kanala yönetici olarak ekleyin. İsterseniz BotFather → /newapp ile doğrudan Mini App bağlantısı da oluşturabilirsiniz.</p>`, j.dev);
      $('#doSetup').onclick = async () => { try { flash = (await api('setup_run')).msg; route(); } catch (e) { alert(e.message); } };
    },
  };

  async function route() {
    const [name, arg] = location.hash.slice(1).split(/\/(.*)/s);
    if (name === 'logout') { logout(); location.hash = ''; return; }
    if (!token) return showLogin(true);
    showLogin(false);
    const key = pages[name] ? name : 'dash';
    document.querySelectorAll('.side a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + (key === 'user' ? 'users' : key)));    try { await pages[key](arg); } catch (e) { if (token) page(`<div class="alert err">${esc(e.message)}</div>`); }
  }
  window.addEventListener('hashchange', route);
  route();
})();
