'use strict';
/* DoraGo — çevrimdışı bilet cüzdanı */

const APP_VER = '5.24';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const A = window.Android || null; // yerel köprü (APK içinde)
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const TYPES = [
  { k: 'ucak', n: TX('Uçak'), i: '✈️', ic: 'plane-tilt', col: '#378ADD' },
  { k: 'muze', n: TX('Müze'), i: '🏛️', ic: 'building-bank', col: '#BA7517' },
  { k: 'etkinlik', n: TX('Etkinlik'), i: '🎫', ic: 'ticket', col: '#D85A30' },
  { k: 'ulasim', n: TX('Tren / Otobüs'), i: '🚆', ic: 'train', col: '#1D9E75' },
  { k: 'konaklama', n: TX('Konaklama'), i: '🏨', ic: 'bed', col: '#7F77DD' },
  { k: 'yemek', n: TX('Yeme-içme'), i: '🍽️', ic: 'tools-kitchen-2', col: '#D4537E', place: true },
  { k: 'gezi', n: TX('Gezi'), i: '📷', ic: 'camera', col: '#0F766E', place: true },
  { k: 'diger', n: TX('Diğer'), i: '📄', ic: 'file-text', col: '#888780' },
];
/* ikon seti: dolu renkli daire + beyaz çizgi ikon (i: bildirim/takvim metinleri için emoji) */
const dot = (ic, col, cls = '') => `<span class="dot ${cls}" style="background:${col};--c:${col}">${I(ic)}</span>`;
const tDot = (k, cls = '') => { const t = typeOf(k); return dot(t.ic, t.col, cls); };
const typeOf = k => TYPES.find(t => t.k === k) || TYPES.find(t => t.k === 'diger');
/* platform: Android kabuğu (A) ya da tarayıcı / iPhone web uygulaması */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canGeo = () => (A && (A.geoFetch || A.geocode)) || (!A && typeof fetch === 'function');
const isPlace = k => !!(TYPES.find(t => t.k === k) || {}).place;

/* ================= IndexedDB ================= */
let _db;
function db() {
  if (!_db) _db = new Promise((res, rej) => {
    const r = indexedDB.open('biletim', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('tickets', { keyPath: 'id' });
      d.createObjectStore('pages', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _db;
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error(TX('İşlem başarısız'))); });
async function getAll(store) { return rq((await db()).transaction(store).objectStore(store).getAll()); }
async function getOne(store, key) { return rq((await db()).transaction(store).objectStore(store).get(key)); }
async function metaGet(k) { return getOne('meta', k); }
async function metaSet(k, v) { const t = (await db()).transaction('meta', 'readwrite'); t.objectStore('meta').put(v, k); return done(t); }

async function saveTicketDB(ticket, newPages, removedIds) {
  const t = (await db()).transaction(['tickets', 'pages'], 'readwrite');
  const ps = t.objectStore('pages');
  for (const p of newPages) ps.put(p);
  for (const id of removedIds) ps.delete(id);
  t.objectStore('tickets').put(ticket);
  return done(t);
}
/* başka biletin de kullandığı sayfalar (gidiş-dönüş) silinmez */
const pagesInUse = (ids, exceptId) => ids.filter(id => !S.tickets.some(o => o.id !== exceptId && (o.pageIds || []).includes(id)));
async function deleteTicketDB(ticket) {
  const t = (await db()).transaction(['tickets', 'pages'], 'readwrite');
  for (const id of pagesInUse(ticket.pageIds, ticket.id)) t.objectStore('pages').delete(id);
  if (ticket.hph && ticket.hph.id) t.objectStore('pages').delete(ticket.hph.id);
  t.objectStore('tickets').delete(ticket.id);
  return done(t);
}
async function wipeAll() {
  const t = (await db()).transaction(['tickets', 'pages', 'meta'], 'readwrite');
  t.objectStore('tickets').clear(); t.objectStore('pages').clear(); t.objectStore('meta').clear();
  await done(t);
  try { localStorage.clear(); } catch (e) {}
}

/* ================= yardımcılar ================= */
const B64 = {
  enc(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) { const b = atob(str); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
};
const TE = new TextEncoder(), TD = new TextDecoder();

async function pinHash(pin, salt) {
  const k = await crypto.subtle.importKey('raw', TE.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return B64.enc(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, k, 256));
}
async function aesKey(pin, salt) {
  const k = await crypto.subtle.importKey('raw', TE.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = TX(msg); t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
let busyEl = null;
function busy(msg, onCancel) {
  if (msg === false) { busyEl?.remove(); busyEl = null; return; }
  if (!busyEl) { busyEl = document.createElement('div'); busyEl.className = 'busy'; busyEl.innerHTML = TX('<div class="spin"></div><div class="bm"></div><button class="bcancel hidden">Atla</button>'); document.body.appendChild(busyEl); }
  busyEl.querySelector('.bm').textContent = msg || TX('Lütfen bekle…');
  const b = busyEl.querySelector('.bcancel');
  if (onCancel) { b.classList.remove('hidden'); b.onclick = onCancel; } else b.classList.add('hidden');
}
let dlgClose = null;
function dialog({ title, text, ok = TX('Tamam'), cancel = TX('Vazgeç'), danger = false }) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = `<div class="dlg"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}<div class="row2">
      ${cancel ? `<button class="btn" data-a="0">${esc(cancel)}</button>` : ''}
      <button class="btn ${danger ? 'dan' : 'pri'}" data-a="1">${esc(ok)}</button></div></div>`;
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    ov.addEventListener('click', e => { const a = e.target.closest('[data-a]'); if (a) close(a.dataset.a === '1'); else if (e.target === ov) close(false); });
    dlgClose = () => close(false);
    document.body.appendChild(ov);
  });
}

const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: 'numeric', weekday: 'short' });
}
function daysLeft(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number); const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - t) / 86400000);
}

const urls = new Map();
function blobURL(key, blob) {
  if (!blob) return '';
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}

/* ================= logo (5.21: bilet + iple bağlı büyük Dora etiketi, Baloo 2 yazılar çizgi olarak; renkler temadan) ================= */
const LOGO_INNER = `<rect class="lg-b" width="120" height="120" rx="28"/>
<g transform="translate(14 56)"><path class="lg-t" d="M10 0h72a10 10 0 0 1 10 10v8a8 8 0 0 0 0 16v8a10 10 0 0 1 -10 10h-72a10 10 0 0 1 -10 -10v-8a8 8 0 0 0 0 -16v-8a10 10 0 0 1 10 -10z"/>
<line class="lg-pl" x1="30" y1="6" x2="30" y2="46" stroke-width="2" stroke-dasharray="3 4"/><path class="lg-p" d="M25 26c0 .7 -1 1.1 -2.5 1.1h-5l-4.3 6.3h-2l2.4 -6.3h-4.2l-2 2.7h-1.5l1.1 -3.8l-1.1 -3.8h1.5l2 2.7h4.2l-2.4 -6.3h2l4.3 6.3h5c1.5 0 2.5 .4 2.5 1.1z"/>
<path class="lg-x" d="M61.7 26.2L61.7 32.2Q61.7 33.1 61.4 33.5Q61 34 60.3 34.4Q59.5 34.8 58 35.2Q56.4 35.5 54.9 35.5Q52.1 35.5 49.8 34.6Q47.6 33.6 46.2 31.5Q44.9 29.5 44.9 26.2Q44.9 23.2 46.2 21.1Q47.6 19 49.9 17.9Q52.1 16.9 55 16.9Q56.8 16.9 58.1 17.3Q59.5 17.7 60.2 18.4Q60.9 19.1 60.9 20Q60.9 20.8 60.5 21.3Q60.2 21.9 59.7 22.2Q59 21.8 57.9 21.4Q56.8 21 55.3 21Q53.8 21 52.6 21.6Q51.4 22.3 50.8 23.4Q50.1 24.6 50.1 26.2Q50.1 28 50.7 29.1Q51.4 30.3 52.5 30.9Q53.6 31.5 55 31.5Q55.6 31.5 56.1 31.3Q56.6 31.2 56.8 31.1L56.8 28.3L53.7 28.3Q53.6 28 53.4 27.5Q53.2 26.9 53.2 26.4Q53.2 25.3 53.7 24.9Q54.2 24.4 55 24.4L59.9 24.4Q60.7 24.4 61.2 24.9Q61.7 25.3 61.7 26.2M79.2 28Q79.2 30.3 78.3 32Q77.3 33.6 75.6 34.6Q73.9 35.5 71.6 35.5Q69.3 35.5 67.6 34.6Q65.9 33.7 65 32Q64 30.3 64 28Q64 25.7 65 24Q65.9 22.3 67.7 21.4Q69.4 20.5 71.6 20.5Q73.9 20.5 75.6 21.4Q77.3 22.3 78.3 24Q79.2 25.7 79.2 28M71.6 24.3Q70.4 24.3 69.8 25.3Q69.1 26.2 69.1 28Q69.1 29.8 69.7 30.7Q70.4 31.6 71.6 31.6Q72.8 31.6 73.5 30.7Q74.2 29.7 74.2 28Q74.2 26.2 73.5 25.3Q72.8 24.3 71.6 24.3"/><circle class="lg-p" cx="82" cy="9" r="3.2"/></g>
<path class="lg-s" d="M96 65c7 -12 5 -30 -4 -37" fill="none" stroke-width="3" stroke-linecap="round"/>
<g transform="rotate(-6 60 30)"><path class="lg-g" d="M18 13h70l10 17l-10 17h-70a6 6 0 0 1 -6 -6v-22a6 6 0 0 1 6 -6z"/><circle class="lg-p" cx="90" cy="30" r="3"/>
<path class="lg-gx" d="M34.7 31.5Q34.7 33.7 33.6 34.8Q32.5 35.9 30.8 35.9Q30.5 35.9 30.1 35.8Q29.7 35.8 29.4 35.8L29.4 27Q29.8 27 30.1 27Q30.5 26.9 30.8 26.9Q32 26.9 32.9 27.5Q33.7 28 34.2 29Q34.7 30 34.7 31.5M39.2 31.4Q39.2 28.7 38.1 26.9Q37 25.1 35.1 24.3Q33.1 23.4 30.5 23.4Q29.6 23.4 28.4 23.5Q27.2 23.6 26.1 24Q25.6 24.2 25.3 24.5Q25 24.8 25 25.3L25 37Q25 38.3 26.4 38.8Q27.4 39.1 28.7 39.3Q29.9 39.4 30.8 39.4Q33.3 39.4 35.2 38.5Q37.1 37.6 38.1 35.9Q39.2 34.1 39.2 31.4M53.9 32.9Q53.9 34.9 53.1 36.4Q52.3 37.8 50.9 38.6Q49.4 39.4 47.4 39.4Q45.4 39.4 43.9 38.6Q42.5 37.9 41.6 36.4Q40.8 35 40.8 32.9Q40.8 30.9 41.7 29.5Q42.5 28 44 27.3Q45.4 26.5 47.4 26.5Q49.4 26.5 50.8 27.3Q52.3 28.1 53.1 29.5Q53.9 31 53.9 32.9M47.4 29.8Q46.4 29.8 45.8 30.6Q45.2 31.4 45.2 32.9Q45.2 34.5 45.8 35.3Q46.3 36.1 47.4 36.1Q48.4 36.1 49 35.3Q49.6 34.5 49.6 32.9Q49.6 31.4 49 30.6Q48.4 29.8 47.4 29.8M60.3 30.4L60.3 39Q60 39 59.5 39.1Q59 39.2 58.4 39.2Q57.1 39.2 56.6 38.8Q56 38.4 56 37.2L56 29.8Q56 29 56.4 28.5Q56.8 28 57.4 27.6Q58.3 27 59.5 26.8Q60.6 26.5 61.9 26.5Q64.6 26.5 64.6 28.4Q64.6 28.9 64.5 29.3Q64.4 29.6 64.2 29.9Q63.9 29.9 63.6 29.9Q63.2 29.8 62.8 29.8Q62.2 29.8 61.5 30Q60.8 30.1 60.3 30.4M71.5 36.3Q71.9 36.3 72.4 36.2Q72.9 36.1 73.2 36L73.2 34L71.4 34.1Q70.7 34.2 70.2 34.4Q69.8 34.7 69.8 35.2Q69.8 35.7 70.2 36Q70.6 36.3 71.5 36.3M71.3 26.5Q74 26.5 75.7 27.6Q77.3 28.7 77.3 31.1L77.3 36.6Q77.3 37.3 76.9 37.7Q76.6 38.1 76.1 38.4Q75.3 38.9 74.1 39.1Q73 39.4 71.5 39.4Q68.9 39.4 67.3 38.4Q65.7 37.4 65.7 35.3Q65.7 33.6 66.7 32.7Q67.8 31.8 69.9 31.5L73.2 31.2L73.2 31Q73.2 30.3 72.5 30Q71.9 29.6 70.7 29.6Q69.8 29.6 68.8 29.9Q67.9 30 67.2 30.4Q66.9 30.1 66.7 29.7Q66.4 29.2 66.4 28.7Q66.4 27.5 67.7 27Q68.4 26.7 69.4 26.6Q70.4 26.5 71.3 26.5"/></g>`;
const logoSvg = cls => `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true">${LOGO_INNER}</svg>`;

/* ================= tema ================= */
const THEMES = {
  klasik: { n: TX('Klasik'), bar: ['#0284C7', '#0369A1', 0, 0], p: ['#0284C7', '#F0F7FF', '#fff', '#0284C7'] },
  gece: { n: TX('Gece mavisi'), bar: ['#0B1220', '#0B1220', 0, 0], p: ['#0B1220', '#0B1220', '#111C2E', '#0EA5E9'] },
  defter: { n: TX('Seyahat defteri'), big: 1, hero: 1, bar: ['#FAF6EF', '#FAF6EF', 1, 1], p: ['#FAF6EF', '#C2410C', '#FFFDF8', '#0F766E'] },
  sade: { n: TX('Sade beyaz'), big: 1, rows: 1, pill: 1, bar: ['#FFFFFF', '#FFFFFF', 1, 1], p: ['#FFFFFF', '#FFFFFF', '#F1F5F9', '#F97316'] },
  okyanus: { n: TX('Okyanus'), hero: 1, bar: ['#0F766E', '#F0FDFA', 0, 1], p: ['#0F766E', '#0F766E', '#F0FDFA', '#14B8A6'] },
};
const darkMQ = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function curTheme() {
  const t = lsGet('dgTheme', 'defter'), auto = lsGet('dgThemeAuto', false);
  return auto && darkMQ && darkMQ.matches ? TX('gece') : (THEMES[t] ? t : 'defter');
}
function applyTheme() {
  const k = curTheme(), T = THEMES[k], h = document.documentElement;
  h.dataset.theme = k;
  for (const f of ['big', 'rows', 'pill']) { if (T[f]) h.setAttribute('data-' + f, ''); else h.removeAttribute('data-' + f); }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = T.bar[0];
  try { A && A.setBars && A.setBars(T.bar[0], T.bar[1], !!T.bar[2], !!T.bar[3]); } catch (e) {}
  return T;
}
applyTheme();
if (darkMQ) { const f = () => { if (lsGet('dgThemeAuto', false)) { applyTheme(); if (S.unlocked) render(); } }; darkMQ.addEventListener ? darkMQ.addEventListener('change', f) : darkMQ.addListener(f); }

/* ================= durum ================= */
const START_TAB = (() => { try { return JSON.parse(localStorage.getItem('dgStartTab')) || 'trips'; } catch (e) { return 'trips'; } })();
const S = {
  view: 'home', filter: 'all', trip: '', q: '', showPast: false,
  tickets: [], cur: null, draft: null, unlocked: false, tab: START_TAB, calMonth: '', calDay: '', bio: false, bioAvail: false, notif: { on: true, dayBefore: true, hours: 3 }, pendingTicket: false, mapApp: '', multi: null, sel: null, groupBy: 'date', tripOpen: {}, hintLong: true,
  lockDelay: 60000, autoBright: true, pausedAt: 0, pickAt: 0, pendingShare: false,
};

/* ================= PIN / kilit ================= */
const FP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 9.6a8 8 0 0 1 14.8 0"/><path d="M6.6 17.2c.5-1.6.6-3.2.6-5.2a4.8 4.8 0 0 1 9.6 0c0 1.4-.1 2.8-.3 4"/><path d="M9.6 12a2.4 2.4 0 0 1 4.8 0c0 3.6-.6 6.4-1.8 8.6"/><path d="M12 12c0 3.2-.6 5.8-1.8 8"/><path d="M15.9 19.6c.3-.9.6-1.9.8-3"/><path d="M5.3 14.5c.2-.8.3-1.6.3-2.5"/></svg>';

function keypad(host, { title, sub, extra = '', onPin, onClose, onBio }) {
  host.innerHTML = TL`<div class="kp">
    ${onClose ? TX('<button class="icon-btn kp-close" data-k="close" aria-label="Kapat">') + I('x') + '</button>' : ''}
    <div class="kp-top">${logoSvg('kp-logo')}<div class="kp-brand">DoraGo</div><h2>${esc(title)}</h2><p class="kp-sub${sub && sub.chip ? ' chip' : ''}">${esc(sub && sub.text != null ? sub.text : sub || '')}</p>
      <div class="dots">${'<div class="pdot"></div>'.repeat(6)}</div><p class="kp-msg"></p></div>
    <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-k="${n}">${n}</button>`).join('')}
      ${onBio ? TL`<button class="key bio" data-k="bio" aria-label="Parmak izi">${FP_SVG}</button>` : '<button class="key blank" disabled></button>'}
      <button class="key" data-k="0">0</button><button class="key del" data-k="del" aria-label="Sil">${I('backspace')}</button></div>
    <div class="kp-link-wrap">${extra || '<div class="kp-link"></div>'}</div></div>`;
  let pin = '', locked = false;
  const dots = $$('.pdot', host), msgEl = $('.kp-msg', host);
  const draw = () => dots.forEach((d, i) => d.classList.toggle('f', i < pin.length));
  const api = {
    reset(msg = '', shake = false) { pin = ''; locked = false; draw(); msgEl.textContent = msg; if (shake) { const k = $('.dots', host); k.classList.remove('shake'); void k.offsetWidth; k.classList.add('shake'); } },
    setSub(t) { $('.kp-sub', host).textContent = t; },
    setTitle(t) { $('h2', host).textContent = t; },
    setMsg(t) { msgEl.textContent = t; },
    success() { pin = '······'; draw(); $('.dots', host).classList.add('ok'); },
    hideBio() { const b = $('.key.bio', host); if (b) { b.className = 'key blank'; b.innerHTML = ''; b.disabled = true; } },
    disable(on, msg) { $$('.key[data-k]', host).forEach(b => b.disabled = on); if (msg != null) msgEl.textContent = msg; },
  };
  host.onclick = async e => {
    const b = e.target.closest('[data-k]'); if (!b || b.disabled) return;
    const k = b.dataset.k;
    if (k === 'close') return onClose && onClose();
    if (k === 'bio') return onBio && onBio();
    if (locked) return;
    if (k === 'del') { pin = pin.slice(0, -1); draw(); return; }
    if (pin.length >= 6) return;
    pin += k; draw(); msgEl.textContent = '';
    if (pin.length === 6) { locked = true; const p = pin; setTimeout(() => onPin(p, api), 120); }
  };
  return api;
}

async function checkPin(pin) {
  const salt = await metaGet('pinSalt'), hash = await metaGet('pinHash');
  if (!salt || !hash) return false;
  return (await pinHash(pin, salt)) === hash;
}
async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await metaSet('pinSalt', salt); await metaSet('pinHash', await pinHash(pin, salt));
}

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
/* 5.13: dili değiştir → kaydet, Android'e bildir, yeniden yükle (tüm metinler yeni dilde kurulur) */
function setLang(l) { lsSet('dgLang', l); try { A && A.setLang && A.setLang(l); } catch (e) {} if (l !== LANG) { lsSet('lastActive', Date.now()); location.reload(); } }

/* 5.13: ilk açılış — dil, ev ülkesi, para birimi, pasaport (telefonun dil/bölgesinden önerilir) */
function detectRegion() {
  const locs = [...(navigator.languages || []), navigator.language]; try { locs.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch (e) {}
  for (const l of locs) { const m = String(l || '').match(/[-_]([A-Za-z]{2})(?:$|[-_])/); if (m && window.CINFO && CINFO[m[1].toUpperCase()]) return m[1].toUpperCase(); }
  try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; const hit = Object.entries(window.CINFO || {}).find(([c, v]) => v.tz === tz); if (hit) return hit[0]; } catch (e) {}
  return LANG === 'tr' ? 'TR' : 'GB';
}
const curFor = cc => { const c = window.CINFO && CINFO[cc] && CINFO[cc].cur; return CURS.includes(c) ? c : (c === 'EUR' ? 'EUR' : 'USD'); };
async function regionWizard() {
  await loadCInfo(); await loadWorld();
  const W = lsGet('dgWiz', null) || {}; const home = W.home || detectRegion();
  const st = { home, cur: W.cur || curFor(home), pass: W.pass || home, curTouched: !!W.curTouched, passTouched: !!W.passTouched };
  const el = document.createElement('div'); el.className = 'wiz'; document.body.appendChild(el);
  const curOpts = () => [...new Set([st.cur, ...CURS])].map(c => `<option value="${c}" ${c === st.cur ? 'selected' : ''}>${c}${curSymbol(c) !== c ? ' ' + curSymbol(c) : ''}</option>`).join('');
  const draw = () => {
    el.innerHTML = TL`${logoSvg('wlogo')}<h1>Hoş geldin</h1><p class="wsub">Telefonundan şunları önerdik. Doğruysa başla, değilse dokunup değiştir.</p>
      <div class="group">
        <div class="item"><span class="ii">${I('language')}</span><span class="it">Dil<small>${LANG === 'tr' ? 'Language' : 'Dil'}</small></span><select id="wzL">${LANGS.map(l => `<option value="${l.id}" ${l.id === LANG ? 'selected' : ''}>${l.name}</option>`).join('')}</select></div>
        <div class="item"><span class="ii">${I('home')}</span><span class="it">Ev ülkesi<small>Özet ve saat farkı buna göre</small></span><select id="wzH">${ccOptions(st.home)}</select></div>
        <div class="item"><span class="ii">${I('cash')}</span><span class="it">Para birimi<small>Masraf toplamları</small></span><select id="wzC">${curOpts()}</select></div>
        <div class="item"><span class="ii">${I('id')}</span><span class="it">Pasaport<small>Vize kontrolü</small></span><select id="wzP">${ccOptions(st.pass)}</select></div>
      </div>
      <button class="btn pri wgo" id="wzGo">Başla</button>
      <p class="wnote">Hepsini sonra Ayarlar'dan değiştirebilirsin.</p>`;
    $('#wzL', el).onchange = e => { lsSet('dgWiz', st); lsSet('dgLang', e.target.value); location.reload(); };
    $('#wzH', el).onchange = e => { st.home = e.target.value; if (!st.curTouched) st.cur = curFor(st.home); if (!st.passTouched) st.pass = st.home; draw(); };
    $('#wzC', el).onchange = e => { st.cur = e.target.value; st.curTouched = true; };
    $('#wzP', el).onchange = e => { st.pass = e.target.value; st.passTouched = true; };
  };
  draw();
  return new Promise(res => {
    el.addEventListener('click', e => {
      if (!e.target.closest('#wzGo')) return;
      lsSet('dgLang', LANG); lsSet('dgHome', st.home); lsSet('dgBaseCur', st.cur); lsSet('dgPass', st.pass);
      try { localStorage.removeItem('dgWiz'); } catch (er) {}
      HOME_CC = st.home; try { A && A.setLang && A.setLang(LANG); } catch (er) {}
      el.remove(); res();
    });
  });
}

function showSetup() {
  const host = $('#lock'); host.classList.remove('hidden');
  let first = null;
  const kp = keypad(host, {
    title: 'PIN belirle', sub: TX('Biletlerini korumak için 6 haneli bir PIN seç'),
    onPin: async (pin, api) => {
      if (!first) {
        if (/^(\d)\1{5}$/.test(pin) || pin === '123456' || pin === '654321') { api.reset(TX('Bu PIN çok kolay, başka bir tane seç'), true); return; }
        first = pin; api.setTitle('PIN\'i tekrar gir'); api.setSub(TX('Onaylamak için aynı PIN\'i gir')); api.reset(); return;
      }
      if (pin !== first) { first = null; api.setTitle('PIN belirle'); api.setSub(TX('Biletlerini korumak için 6 haneli bir PIN seç')); api.reset(TX('PIN\'ler eşleşmedi, baştan dene'), true); return; }
      api.disable(true, ''); busy('PIN kaydediliyor…');
      await setPin(pin); busy(false);
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      api.success(); setTimeout(unlock, 240);
      if (S.pinReset) { S.pinReset = false; setTimeout(() => dialog({ title: TX('PIN değişti'), text: TX('Biletlerin yerinde. Daha önce aldığın yedekler eski PIN ile açılır; yeni bir yedek almanı öneririm (Ayarlar → Yedek al).'), ok: TX('Tamam'), cancel: '' }), 700); return; }
      if (S.bioAvail) setTimeout(async () => {
        if (await dialog({ title: TX('Parmak izi ile açılsın mı?'), text: TX('Uygulamayı her seferinde PIN yerine parmak izinle açabilirsin. PIN yedek olarak kalır.'), ok: TX('Evet, aç'), cancel: TX('Şimdi değil') })) enableBio();
      }, 700);
    },
  });
  return kp;
}

/* ---------- parmak izi ---------- */
let bioWait = null;
window.onBioResult = r => { const f = bioWait; bioWait = null; f && f(r); };
function bioRun(enrolling) {
  return new Promise(res => {
    if (!A || !A.bioAuth) return res('nokey');
    if (bioWait) return res('busy');
    bioWait = res; S.pickAt = Date.now();
    try { A.bioAuth(!!enrolling); } catch (e) { bioWait = null; res('nokey'); }
  });
}
async function enableBio() {
  const r = await bioRun(true);
  if (r === 'ok') { S.bio = true; await metaSet('bio', true); toast(TX('Parmak izi açıldı')); return true; }
  try { A && A.bioDisable(); } catch (e) {}
  if (r !== 'cancel' && r !== 'error') toast(TX('Parmak izi açılamadı'));
  return false;
}

let lockTimer = null;
function greeting() { const h = new Date().getHours(); return h >= 5 && h < 12 ? TX('Günaydın') : h < 18 && h >= 12 ? TX('İyi günler') : h >= 18 && h < 22 ? TX('İyi akşamlar') : TX('İyi geceler'); }
/* kilit ekranındaki "sıradaki yolculuk" satırı: biletler açılmadan gösterilebilsin diye kısa bir özet saklanır */
function nextHintSave() {
  if (S.lockHint === false) { lsSet('nextHint', null); return; }
  const n = upcoming()[0];
  lsSet('nextHint', n ? { date: n.date, end: n.endDate || n.date, text: n.type === 'ucak' && n.from && n.to ? `${apCity(n.from) || n.from} → ${apCity(n.to) || n.to}` : (n.title || typeOf(n.type).n).slice(0, 40) } : null);
}
function lockHint() {
  const h = S.lockHint === false ? null : lsGet('nextHint', null), today = todayStr();
  if (!h || !h.date || (h.end || h.date) < today) return { text: TX('Biletlerin hazır'), chip: false };
  const n = nightsBetween(today, h.date);
  const when = n <= 0 ? (h.date === today ? TX('Bugün') : TX('Şu an')) : n === 1 ? TX('Yarın') : n < 7 ? TL`${n} gün sonra` : `${+h.date.slice(8)} ${MONTH_TR[+h.date.slice(5, 7) - 1]}`;
  return { text: `${when} · ${h.text}`, chip: true };
}
function showLock() {
  S.unlocked = false; brightness(false);
  const host = $('#lock'); host.classList.remove('hidden', 'out');
  const useBio = S.bio && S.bioAvail;
  const kp = keypad(host, {
    title: greeting(), sub: lockHint(),
    extra: '<button class="kp-link" id="forgot">PIN\'i unuttum</button>',
    onBio: useBio ? () => tryBio() : null,
    onPin: async (pin, api) => {
      if (await checkPin(pin)) { lsSet('bl_fails', 0); lsSet('bl_until', 0); api.success(); setTimeout(unlock, 240); return; }
      const fails = lsGet('bl_fails', 0) + 1; lsSet('bl_fails', fails);
      if (fails >= 5) { lsSet('bl_until', Date.now() + Math.min(30000 * 2 ** (fails - 5), 900000)); api.reset('', true); countdown(); }
      else api.reset(TL`Yanlış PIN (${5 - fails} deneme hakkı kaldı)`, true);
    },
  });
  async function tryBio() {
    if (lsGet('bl_until', 0) > Date.now() || S.unlocked) return;
    const r = await bioRun(false);
    if (S.unlocked) return;
    if (r === 'ok') { lsSet('bl_fails', 0); kp.success(); setTimeout(unlock, 240); }
    else if (r === 'invalid' || r === 'nokey') {
      S.bio = false; await metaSet('bio', false); kp.hideBio();
      kp.setMsg(TX('Telefona yeni parmak izi eklendiği için PIN gerekli. Parmak izini Ayarlar\'dan tekrar açabilirsin.'));
    }
  }
  function countdown() {
    clearInterval(lockTimer);
    const tick = () => {
      const left = lsGet('bl_until', 0) - Date.now();
      if (left <= 0) { clearInterval(lockTimer); kp.disable(false, ''); return; }
      kp.disable(true, TL`Çok fazla hatalı deneme. ${Math.ceil(left / 1000)} sn bekle.`);
    };
    tick(); lockTimer = setInterval(tick, 1000);
  }
  if (lsGet('bl_until', 0) > Date.now()) countdown();
  else if (useBio && !document.hidden) setTimeout(tryBio, 380);
  $('#forgot').onclick = () => forgotPin();

}

/* PIN'i unuttum: telefonun ekran kilidiyle doğrulayıp biletleri silmeden yeni PIN belirle */
let devAuthWait = null;
window.onDeviceAuth = r => { const f = devAuthWait; devAuthWait = null; f && f(r); };
function deviceAuth() {
  return new Promise(res => {
    if (!A || !A.deviceAuth) return res('nolock');
    devAuthWait = res; S.pickAt = Date.now();
    try { A.deviceAuth(); } catch (e) { devAuthWait = null; res('error'); }
  });
}
async function forgotPin() {
  const canDev = !!(A && A.deviceAuth);
  const v = await sheetMenu(TX('PIN\'i mi unuttun?'), [
    ...(canDev ? [{ icon: I('lock'), label: TX('Telefonun kilidiyle sıfırla'), sub: TX('Biletlerin silinmez; yeni bir PIN belirlersin'), value: 'dev' }] : []),
    { icon: I('trash'), label: TX('Her şeyi sil ve baştan başla'), sub: TX('Tüm biletler silinir'), value: 'wipe', danger: true },
  ]);
  if (v === 'dev') {
    const r = await deviceAuth();
    if (r === 'ok') {
      lsSet('bl_fails', 0); lsSet('bl_until', 0); clearInterval(lockTimer);
      const kp = showSetup();
      kp.setTitle(TX('Yeni PIN belirle')); kp.setSub(TX('Biletlerin yerinde; yeni 6 haneli PIN\'ini seç'));
      S.pinReset = true;
      return;
    }
    if (r === 'nolock') await dialog({ title: TX('Telefonda ekran kilidi yok'), text: TX('Bu yöntem için telefonunda PIN, desen ya da şifreyle ekran kilidi olmalı. Ayarlar → Güvenlik\'ten ekran kilidi açıp tekrar dene.'), ok: TX('Tamam'), cancel: '' });
    else if (r === 'error') toast(TX('Doğrulama başlatılamadı'));
    return;
  }
  if (v !== 'wipe') return;
  const ok = await dialog({
    title: TX('Her şey silinsin mi?'),
    text: TX('Bütün biletler silinecek. Yedeğin varsa sonra geri yükleyebilirsin (yedeği alırken kullandığın PIN gerekir).'),
    ok: TX('Her şeyi sil'), danger: true,
  });
  if (!ok) return;
  if (!await dialog({ title: TX('Emin misin?'), text: TX('Bütün biletler kalıcı olarak silinecek. Bu işlem geri alınamaz.'), ok: TX('Evet, sil'), danger: true })) return;
  await wipeAll(); try { A && A.bioDisable(); } catch (e) {} S.bio = false; S.tickets = []; showSetup();
}
async function unlock() {
  S.unlocked = true; clearInterval(lockTimer);
  if (!S.loaded) {
    await loadTickets(); const pl = preload();
    // 5.23.1: seyahat verileri (harita, kapaklar, vize…) hazır olsun ki ekran bir kez ve tam çizilsin (en çok 1,5 sn bekle)
    await Promise.race([pl, new Promise(r => setTimeout(r, 1500))]);
    S.loaded = true; S.anim = 'fade'; render();
    if (TRIPS_READY !== 2) pl.then(() => { if (S.view === 'home') quietRender(); });
  }
  const host = $('#lock'); host.classList.add('out');
  setTimeout(() => { if (!S.unlocked) return; host.classList.add('hidden'); host.classList.remove('out'); host.innerHTML = ''; }, 290);
  if (S.pendingText) { S.pendingText = false; setTimeout(takeSharedText, 350); }
  if (S.pendingShare) { S.pendingShare = false; setTimeout(takeShared, 300); }
  else setTimeout(openLaunchTicket, 300);
  if (!S.synced) { S.synced = true; setTimeout(syncReminders, 800); }
  setTimeout(() => { try { nextHintSave(); } catch (e) {} }, 900);
  ensureFirstUse(); setTimeout(diagPrune, 1500);
}
function lock() {
  if (!S.unlocked) return;
  dlgClose && dlgClose();
  $('.modal-kp')?.remove();
  showLock();
}

/* yaşam döngüsü: arka plana gidince kilitle */
function appPaused() { if (!S.pausedAt) S.pausedAt = Date.now(); if (S.unlocked) { lsSet('lastActive', Date.now()); try { nextHintSave(); } catch (e) {} } }
function appResumed() {
  const p = S.pausedAt; S.pausedAt = 0; if (!p) return;
  // dosya seçici / kaydet ekranı açıldığı için arka plana geçtiyse kilitleme
  if (S.pickAt && p >= S.pickAt && p - S.pickAt < 5000) { S.pickAt = 0; return; }
  if (S.unlocked && S.lockDelay !== -1 && Date.now() - p >= S.lockDelay) lock();
}
window.appPaused = appPaused; window.appResumed = appResumed;
document.addEventListener('visibilitychange', () => document.hidden ? appPaused() : appResumed());

/* ayrı PIN sorma ekranı (ayarlar, geri yükleme) */
function askPin(title, sub, validate) {
  return new Promise(res => {
    const host = document.createElement('div'); host.className = 'modal-kp'; document.body.appendChild(host);
    const close = v => { host.remove(); res(v); };
    keypad(host, {
      title, sub, onClose: () => close(null),
      onPin: async (pin, api) => {
        if (validate) { const err = await validate(pin); if (err) { api.reset(err, true); return; } }
        close(pin);
      },
    });
  });
}

/* ================= parlaklık ================= */
function brightness(on) { S.brightOn = !!on; try { A && A.setBrightness(on ? 1 : -1); } catch (e) {} }

/* ================= veri ================= */
async function loadTickets() {
  S.tickets = await getAll('tickets');
  S.lockDelay = (await metaGet('lockDelay')) ?? 60000;
  S.autoBright = (await metaGet('autoBright')) ?? true;
  S.notif = Object.assign({ on: true, dayBefore: true, hours: 3 }, (await metaGet('notif')) || {});
  S.mapApp = (await metaGet('mapApp')) || '';
  S.groupBy = 'date'; // 5.21.1: Biletler yalnız tarihe göre; seyahat görünümü Seyahatler sekmesinde
  S.hintLong = !!(await metaGet('hintLong'));
  S.geocode = await metaGet('geocode'); if (S.geocode === undefined) S.geocode = null;
  S.ocr = (await metaGet('ocr')) !== false;
  S.wx = (await metaGet('wx')) !== false;
  S.trips = (await metaGet('trips')) || [];
  metaCache.tripReviewed = (await metaGet('tripReviewed')) || [];
  await getPacks(); await getExp(); await getFx(); await getDocs(); await getShop();
  S.askN = Object.assign({ m: 'after', h: 2, t: '09:00' }, (await metaGet('askNotif')) || {});
  await autoAssume();
  S.lockHint = lsGet('lockHintOn', true) !== false;
  await loadTravel();
}

function sortTickets(list) {
  const today = todayStr();
  const key = t => (t.date || '') + 'T' + (t.time || '99:99');
  const end = t => t.endDate || t.date;
  const up = list.filter(t => t.date && end(t) >= today).sort((a, b) => key(a) < key(b) ? -1 : 1);
  const nod = list.filter(t => !t.date).sort((a, b) => b.createdAt - a.createdAt);
  const past = list.filter(t => t.date && end(t) < today).sort((a, b) => key(a) < key(b) ? 1 : -1);
  return { up, nod, past };
}
const timeRange = t => t.time ? (t.type !== 'konaklama' && t.endTime ? `${t.time}–${t.endTime}` : t.time) : '';
function fmtRange(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTH_TR[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTH_TR[m1 - 1]} – ${d2} ${MONTH_TR[m2 - 1]} ${y1}`;
  return `${d1} ${MONTH_TR[m1 - 1]} ${y1} – ${d2} ${MONTH_TR[m2 - 1]} ${y2}`;
}
function flightLine(t) {
  const al = t.airlineName || alName(t.airline);
  return [al && t.flightNo ? `${al} · ${t.flightNo}` : (al || t.flightNo), t.seat && TL`Koltuk ${t.seat}`].filter(Boolean).join(' · ');
}

/* ================= görünümler ================= */
const TCOL = { ucak: '#0EA5E9', muze: '#A855F7', etkinlik: '#F59E0B', ulasim: '#10B981', konaklama: '#EC4899', diger: '#64748B' };

function render() {
  const app = $('#app'), anim = S.anim; S.anim = null;
  if (S.view === 'home') (S.tab === 'cal' ? renderCal : S.tab === 'trips' ? renderTrips : renderHome)(app, anim);
  else if (S.view === 'edit') renderEdit(app, anim);
  else if (S.view === 'view') renderViewer(app, anim);
  else if (S.view === 'settings') renderSettings(app, anim);
  else if (S.view === 'multi') renderMulti(app, anim);
  else if (S.view === 'stats') renderStats(app, anim);
  else if (S.view === 'pack') renderPack(app, anim);
  else if (S.view === 'cinfo') renderCInfo(app, anim);
  else if (S.view === 'phr') renderPhr(app, anim);
  else if (S.view === 'trip') renderTrip(app, anim);
  else if (S.view === 'exp') renderExp(app, anim);
  else if (S.view === 'docs') renderDocs(app, anim);
  else if (S.view === 'shop') renderShop(app, anim);
  else if (S.view === 'world') renderWorld(app, anim);
}
function animCls(anim) { return anim ? ' a-' + anim : ''; }
function go(view, anim) {
  if (S.pendingReload && view === 'home') { S.pendingReload = false; setTimeout(reloadForUpdate, 300); }
  if (view !== 'home') S.sel = null;
  if (S.view === 'view' && view !== 'view') brightness(false);
  const order = { home: 0, docs: 1, world: 2, trip: 1, settings: 1, view: 2, multi: 1, stats: 1, pack: 2, cinfo: 2, phr: 2, exp: 2, shop: 2, edit: 3 };
  if (view === 'home' && S.view === 'pack' && S.packRet && S.cur) { view = 'view'; S.packRet = false; }
  else if (view === 'home' && S.retTrip && ['view', 'pack', 'cinfo', 'phr', 'edit', 'exp', 'shop'].includes(S.view)) view = 'trip';
  if (view !== 'pack') S.packRet = false;
  S.anim = anim || (view === 'view' ? 'up' : (order[view] ?? 0) >= (order[S.view] ?? 0) ? 'fwd' : 'back');
  /* 5.23.2: liste/seyahat sayfasından derine inerken kaydırma yerini sakla, geri dönünce aynı yere (açılan bileti ortala) */
  const fromK = scrollKey(S.view), toK = scrollKey(view), mem = S.scrollMem || (S.scrollMem = {});
  if (fromK && (order[view] ?? 0) > (order[S.view] ?? 0)) mem[fromK] = window.scrollY;
  const restore = toK && (order[view] ?? 0) < (order[S.view] ?? 0) && toK in mem;
  if (toK && !restore) delete mem[toK];
  ghostOut(S.anim);
  S.view = view; render();
  if (restore) restoreScroll(toK); else window.scrollTo(0, 0);
}
function scrollKey(v) { return v === 'home' ? 'h:' + S.tab : v === 'trip' ? 't:' + S.tripName : null; }
function restoreScroll(k) {
  const y = S.scrollMem[k]; delete S.scrollMem[k];
  const tid = S.lastTid; S.lastTid = null;
  const esc_ = window.CSS && CSS.escape ? CSS.escape(tid || '') : String(tid || '').replace(/"/g, '\\"');
  const card = tid && ($(`#app .card[data-id="${esc_}"]`) || $(`#app [data-id="${esc_}"]`));
  const r = card && card.getBoundingClientRect();
  if (r && r.height > 0) {
    window.scrollTo(0, Math.max(0, window.scrollY + r.top + r.height / 2 - innerHeight / 2));
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1300);
  } else window.scrollTo(0, y || 0);
}
/* geçişte eski ekranın kopyası hafifçe büyüyüp solar (C) */
function ghostOut(anim) {
  try {
    if (!(anim === 'fwd' || anim === 'back' || anim === 'up') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const app = document.getElementById('app'), old = app && app.firstElementChild; if (!old) return;
    document.querySelectorAll('.ghost').forEach(g => g.remove());
    const g = old.cloneNode(true); g.classList.add('ghost'); if (anim === 'back') g.classList.add('back');
    g.querySelectorAll('[id]').forEach(e => e.removeAttribute('id')); g.removeAttribute('id');
    if (!old.classList.contains('worldp')) g.style.top = (-window.scrollY) + 'px';
    g.style.animationDelay = '0s'; g.classList.remove('a-fwd', 'a-back', 'a-up', 'a-fade', 'a-stagger');
    document.body.appendChild(g); setTimeout(() => g.remove(), 260);
  } catch (e) {}
}
/* kısa onay efekti */
function tick() { try { if (A && A.vibrate) A.vibrate(12); else if (navigator.vibrate) navigator.vibrate(10); } catch (e) {} }
function okPop(el) { if (!el) return; el.classList.remove('ok-pop'); void el.offsetWidth; el.classList.add('ok-pop'); setTimeout(() => el.classList.remove('ok-pop'), 400); }
function header(sub, extraRight = '') {
  return TL`<div class="top-row"><div class="brand">${logoSvg('blogo')}<span><b>DoraGo</b><small>${esc(sub)}</small></span></div>
    ${extraRight}<button class="icon-btn" id="btnSet" aria-label="Ayarlar">${I('settings')}</button></div>`;
}
function tabsBar() {
  const t = S.tab === 'cal' || S.tab === 'trips' ? S.tab : 'list';
  return TL`<nav class="tabs"><button class="tab ${t === 'list' ? 'on' : ''}" data-tab="list"><span class="ic">${I('ticket')}</span>Biletler</button>
    <button class="tab ${t === 'trips' ? 'on' : ''}" data-tab="trips"><span class="ic">${I('map-2')}</span>Seyahatler</button><span class="tsp"></span>
    <button class="tab ${t === 'cal' ? 'on' : ''}" data-tab="cal"><span class="ic">${I('calendar')}</span>Takvim</button></nav>`;
}
function bindShell(app) {
  $('#btnSet').onclick = () => go('settings');
  const TORD = { list: 0, trips: 1, cal: 2 };
  $$('[data-tab]').forEach(b => b.onclick = async () => {
    const nt = b.dataset.tab, cur = S.tab === 'cal' || S.tab === 'trips' ? S.tab : 'list';
    if (cur === nt) { if (nt !== 'list') window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (nt === 'trips') await tripsData();
    S.tab = nt; S.anim = TORD[nt] > TORD[cur] ? 'fwd' : 'back'; render(); window.scrollTo(0, 0);
  });
  const add = $('#add'); if (add) add.onclick = () => addNew();
}

/* mode: 'list' | { day } (takvim günü) */
function card(t, past, i = 0, mode = 'list') {
  const ty = typeOf(t.type), today = todayStr();
  const end = t.endDate || t.date, inStay = t.type === 'konaklama' && t.endDate && t.date <= today && today <= t.endDate;
  const dl = daysLeft(t.date);
  let badge = '';
  const dl_ = mode === 'dl'; if (dl_) mode = 'list';
  if (mode === 'list' && !past) {
    if (inStay) badge = TX('<span class="badge today">Konaklamada</span>');
    else if (dl != null && !dl_) badge = dl === 0 ? TX('<span class="badge today">Bugün</span>') : dl === 1 ? TX('<span class="badge">Yarın</span>') : dl > 0 && dl <= 30 ? TL`<span class="badge">${dl} gün</span>` : '';
  }
  const shortD = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTH_TR[m - 1].slice(0, 3)}`; };
  let head, l2, l3;
  const isFl = t.type === 'ucak' && t.from && t.to;
  if (isFl) {
    head = `${t.leg ? `<span class="legb">${esc(t.leg)}</span>` : ''}<span class="route">${esc(t.from)}<span class="arr">→</span>${esc(t.to)}</span>`;
  } else head = esc(t.title || ty.n);
  // 2. satır: tarih/saat (uçuşta havayolu ve uçuş no)
  if (mode !== 'list') {
    const day = mode.day;
    if (t.type === 'konaklama' && t.endDate) {
      const n = nightsBetween(t.date, day) + 1, tot = nightsBetween(t.date, t.endDate);
      l2 = day === t.date ? TL`Giriş${t.time ? ' ' + t.time : ''}` : day === t.endDate ? TL`Çıkış${t.endTime ? ' ' + t.endTime : ''}` : TL`Konaklama · ${n}. gece / ${tot}`;
    } else l2 = timeRange(t) || TX('Saat yok');
  } else if (t.type === 'konaklama' && t.endDate) l2 = TL`${t.date.slice(0, 7) === t.endDate.slice(0, 7) ? +t.date.slice(8) : shortD(t.date)}–${shortD(t.endDate)} · ${nightsBetween(t.date, t.endDate)} gece`;
  else l2 = t.date ? `${shortD(t.date)}${t.time ? ' · ' + timeRange(t) : ''}` : (isPlace(t.type) ? TX('Tarihsiz') : TX('Tarih yok'));
  if (t.type === 'ucak') { const fl = [t.airlineName || alName(t.airline), t.flightNo].filter(Boolean).join(' '); if (fl) l2 += ' · ' + fl; }
  // 3. satır: şehir/yer + hava
  if (isFl) l3 = `${apCity(t.from) || t.from} → ${apCity(t.to) || t.to}`;
  else { const pl = (t.place || '').split(',').map(x => x.trim()).filter(Boolean); l3 = pl.length > 1 ? pl.slice(0, 2).join(', ') : pl[0] || (hasC(t) ? nearCity(t.lat, t.lon) : '') || ''; }
  if (dl_) {
    // gün başlığı altında: tarih ve hava başlıkta, kart sadece saat + yer
    if (t.type === 'konaklama' && t.endDate) l2 = inStay ? TL`Çıkış ${shortD(t.endDate)}${t.endTime ? ' · ' + t.endTime : ''}` : TL`${nightsBetween(t.date, t.endDate)} gece · çıkış ${shortD(t.endDate)}`;
    else if (isFl) { const fl = [t.airlineName || alName(t.airline), t.flightNo].filter(Boolean).join(' '); l2 = [t.time, fl].filter(Boolean).join(' · '); }
    else { l2 = [timeRange(t), l3].filter(Boolean).join(' · '); l3 = ''; }
  }
  if (isPlace(t.type) && t.notes) l3 = [String(t.notes).split('\n')[0].slice(0, 70), l3].filter(Boolean).join(' · ');
  const wx = S.wx !== false && !dl_ && t.date && end >= today ? `<span class="cwx${l3 ? '' : ' solo'}" data-wx="${esc(t.id)}"></span>` : '';
  const fs = t.type === 'ucak' && flightCode(t) ? TL`<span class="cic cfs" data-fs="${esc(t.id)}" role="button" aria-label="Uçuş durumu">${I('plane-departure')}</span>` : '';
  const sb = statusCardBits(t);
  return `<button class="card cA ${past ? 'past' : ''} ${sb.stamp ? 'stamped' : ''} ${sb.ask ? 'asking' : ''} ty-${t.type}" data-id="${esc(t.id)}" style="--i:${Math.min(i, 10)}">
    <div class="cdot">${tDot(t.type, 'lg')}</div>
    <div class="ci"><div class="ct"><span class="ctt">${head}</span>${badge}</div>
      ${l2 ? `<div class="cm">${esc(l2)}</div>` : ''}
      ${l3 || wx ? `<div class="cs"><span class="csx">${esc(l3)}</span>${wx}</div>` : ''}${sb.ref}${sb.ask}${mode === 'list' && !past ? pfChip(t) : ''}</div>
    <div class="cr">${fs}${pinBtn(t)}</div>${sb.stamp}</button>`;
}

/* ================= 5.5: bavul listesi, özet (istatistik + harita), seyahat kartpostalı ================= */
let WORLD_P = null;
/* 5.13: haritadaki ülke adları seçilen dilde */
function worldLang(W) { if (W && LANG !== 'tr') { for (const cc in W.c) { const n = countryName(cc); if (n && n !== cc) W.c[cc].n = n; } for (const cc in (W.names || {})) { const n = countryName(cc); if (n && n !== cc) W.names[cc] = n; } } return W; }
function loadWorld() {
  if (window.WORLD) return Promise.resolve(window.WORLD);
  if (!WORLD_P) WORLD_P = new Promise(res => { const s = document.createElement('script'); s.src = 'world.js'; s.onload = () => res(worldLang(window.WORLD || null)); s.onerror = () => { WORLD_P = null; res(null); }; document.head.appendChild(s); });
  return WORLD_P;
}
/* yakındaki havalimanı kaydı → şehir + ülke kodu */
function nearAp(lat, lon) {
  if (!TRAVEL || lat === '' || lat == null) return null;
  let best = null, bd = 80;
  for (const v of Object.values(TRAVEL.ap)) { if (v[3] == null) continue; const dk = distKm({ lat: +lat, lon: +lon }, { lat: v[3], lon: v[4] }); if (dk < bd) { bd = dk; best = v; } }
  return best ? { city: best[0], cc: best[2], lat: best[3], lon: best[4] } : null;
}
const apRec = c => (TRAVEL && c && TRAVEL.ap[c]) ? { city: TRAVEL.ap[c][0], cc: TRAVEL.ap[c][2], lat: TRAVEL.ap[c][3], lon: TRAVEL.ap[c][4] } : null;
let _dn = null;
const countryName = cc => { if (!cc) return cc; if (LANG !== 'tr') { try { _dn = _dn || new Intl.DisplayNames([LANG], { type: 'region' }); const n = _dn.of(cc); if (n && n !== cc) return n; } catch (e) {} } return (window.WORLD && (WORLD.names[cc] || (WORLD.c[cc] && WORLD.c[cc].n))) || cc; };
const realised = t => t.status !== 'cancel' && t.status !== 'missed';
/* biletin bulunduğu yer: uçuşta varış, yoksa koordinat */
function ticketWhere(t) {
  if (t.type === 'ucak') return apRec(t.to);
  if (hasC(t)) return nearAp(t.lat, t.lon) || { city: '', cc: '', lat: +t.lat, lon: +t.lon };
  return null;
}
function flightKm(t) { const a = apRec(t.from), b = apRec(t.to); return a && b && a.lat != null && b.lat != null ? distKm(a, b) : 0; }
/* 5.13: ev ülkesi ve pasaport ülkesi ayardan (eski kurulumlar: TR) */
let HOME_CC = (() => { try { return JSON.parse(localStorage.getItem('dgHome') || 'null') || 'TR'; } catch (e) { return 'TR'; } })();
const passCC = () => lsGet('dgPass', HOME_CC);
const homeName = () => countryName(HOME_CC);
const homeTz = () => (window.CINFO && CINFO[HOME_CC] && CINFO[HOME_CC].tz) || (HOME_CC === 'TR' ? 'Europe/Istanbul' : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
/* Türkçe ayrılma eki: Türkiye'den, Almanya'dan, Fransa'dan */
const ablSfx = w => { const v = (String(w).toLocaleLowerCase(LANG).match(/[aeıioöuü](?=[^aeıioöuü]*$)/) || ['e'])[0], last = String(w).slice(-1).toLocaleLowerCase(LANG), hard = /[çfhkpsşt]/.test(last); return "'" + (hard ? 't' : 'd') + (/[aıou]/.test(v) ? 'an' : 'en'); };
function statsFor(ts, days) {
  const done = ts.filter(t => t.date && hasEnded(t) && realised(t));
  const fl = done.filter(t => t.type === 'ucak' && t.from && t.to);
  const km = fl.reduce((s, t) => s + flightKm(t), 0);
  const longest = fl.slice().sort((a, b) => flightKm(b) - flightKm(a))[0];
  const cities = new Map(), countries = new Map(), pts = [];
  // ev şehri: seyahatlerin ilk uçuşunun kalkış şehri (dönüş uçuşu ziyaret sayılmaz)
  const home = new Set(); for (const g of new Set(ts.map(t => t.trip).filter(Boolean))) { const f = ts.filter(t => t.trip === g && t.type === 'ucak' && t.from && t.date).sort((a, b) => (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1)[0]; const r = f && apRec(f.from); if (r) home.add(r.city); }
  for (const t of done) {
    const w = ticketWhere(t); if (!w) continue;
    if (t.type === 'ucak' && home.has(w.city)) continue;
    if (w.city) cities.set(w.city, (cities.get(w.city) || 0) + 1);
    if (w.cc && w.cc !== HOME_CC) { const k = t.trip || t.date; const s = countries.get(w.cc) || new Set(); s.add(k); countries.set(w.cc, s); }
    if (w.lat != null) pts.push({ lat: w.lat, lon: w.lon, city: w.city });
  }
  return {
    done, fl, km: Math.round(km), longest, days,
    places: done.filter(t => !['ucak', 'konaklama', 'ulasim'].includes(t.type)).length,
    museums: done.filter(t => t.type === 'muze' || t.type === 'etkinlik').length,
    cities: [...cities.keys()], countries: [...countries.entries()].map(([cc, s]) => ({ cc, n: s.size })).sort((a, b) => b.n - a.n),
    arcs: fl.map(t => [apRec(t.from), apRec(t.to)]).filter(([a, b]) => a && b && a.lat != null && b.lat != null), pts,
  };
}
function kindMix(y) {
  const today = todayStr(), trips = allTrips().filter(g => g.a && g.a.slice(0, 4) === String(y) && g.a <= today);
  const cnt = new Map(); for (const g of trips) { const k = tripKind(g.name); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
  const tot = [...cnt.values()].reduce((a, b) => a + b, 0), list = TRIP_KINDS.filter(k => cnt.get(k.k)).map(k => ({ ...k, n2: cnt.get(k.k), p: Math.round(cnt.get(k.k) / tot * 100) }));
  const text = list.map(k => `${pct(k.p)} ${k.n.split(' ')[0].toLocaleLowerCase(LANG)}`).join(' · ');
  const hasW = cnt.get('is'), noW = lsGet('statsNoWork', false);
  const html = list.length ? `<div class="kmix"><div class="kmb">${list.map(k => `<i style="flex:${k.n2};background:${k.c}"></i>`).join('')}</div><div class="kml">${list.map(k => `<span><b style="background:${k.c}"></b>${esc(k.n)} ${pct(k.p)}</span>`).join('')}</div>${hasW ? TL`<button class="kmw ${noW ? '' : 'on'}" id="statsNoWork"><span class="pcb">${noW ? '' : I('check')}</span> İş seyahatlerini özete kat</button>` : ''}</div>` : '';
  return { list, text, html };
}
function yearStats(y) {
  const noW = lsGet('statsNoWork', false), ts = S.tickets.filter(t => t.date && t.date.slice(0, 4) === String(y) && !(noW && t.trip && tripKind(t.trip) === 'is'));
  let days = 0;
  for (const g of allTrips()) { if (!g.a || (noW && tripKind(g.name) === 'is')) continue; const a = g.a < `${y}-01-01` ? `${y}-01-01` : g.a, e = (g.e || g.a) > `${y}-12-31` ? `${y}-12-31` : (g.e || g.a); if (a <= e && a.slice(0, 4) === String(y) && a <= todayStr()) days += nightsBetween(a, e < todayStr() ? e : todayStr()) + 1; }
  return statsFor(ts, days);
}
const fmtN = n => n.toLocaleString(LOC);
/* harita SVG'si: ziyaret edilen ülkeler boyalı, uçuşlar yay, şehirler nokta; görünüm noktalara yakınlaşır */
function mapSvg(st, opt = {}) {
  const W = window.WORLD; if (!W) return '';
  const P = (lat, lon) => wproj(lat, lon, W);
  const vis = new Set(st.countries.map(c => c.cc));
  const xy = [...st.pts.map(p => P(p.lat, p.lon)), ...st.arcs.flatMap(([a, b]) => [P(a.lat, a.lon), P(b.lat, b.lon)])];
  let vb = W.proj === 'rob' ? [0, 20, W.W, W.H - 60] : [0, 30, W.W, W.H - 110];
  if (xy.length) {
    let x0 = Math.min(...xy.map(p => p[0])), x1 = Math.max(...xy.map(p => p[0])), y0 = Math.min(...xy.map(p => p[1])), y1 = Math.max(...xy.map(p => p[1]));
    let w = Math.max(x1 - x0, 60) * 1.5, h = Math.max(y1 - y0, 30) * 1.6; const ar = opt.ar || 2;
    if (w / h < ar) w = h * ar; else h = w / ar;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; vb = [cx - w / 2, cy - h / 2, w, h];
  }
  const s = vb[2] / 320;
  const lands = Object.entries(W.c).map(([cc, c]) => `<path d="${c.d}" class="${vis.has(cc) ? 'mv' : cc === HOME_CC ? 'mh' : ''}"/>`).join('');
  const arcs = st.arcs.map(([a, b]) => { const p = P(a.lat, a.lon), q = P(b.lat, b.lon), mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2 - Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.28; return `<path class="ma" d="M${p[0]} ${p[1]}Q${mx} ${my} ${q[0]} ${q[1]}" stroke-width="${1.6 * s}" stroke-dasharray="${4 * s} ${3 * s}"/>`; }).join('');
  const seen = new Set(), dots = [];
  for (const p of [...st.arcs.flatMap(([a, b]) => [a, b]), ...st.pts]) { const k = p.city || `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`; if (seen.has(k)) continue; seen.add(k); dots.push(p); }
  const dd = dots.slice(0, 14).map((p, i) => { const [x, y] = P(p.lat, p.lon); return `<circle cx="${x}" cy="${y}" r="${3.4 * s}" class="md"/>${p.city && i < 8 ? `<text x="${x + 5 * s}" y="${y - 4 * s}" font-size="${9.5 * s}" class="mt">${esc(p.city)}</text>` : ''}`; }).join('');
  return TL`<svg class="wmap" viewBox="${vb.map(v => v.toFixed(1)).join(' ')}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Seyahat haritası"><g stroke-width="${0.5 * s}">${lands}</g>${arcs}${dd}</svg>`;
}
async function renderStats(app, anim) {
  await loadWorld();
  const years = [...new Set(S.tickets.filter(t => t.date && hasEnded(t)).map(t => +t.date.slice(0, 4)))].sort((a, b) => b - a);
  if (!years.length) years.push(new Date().getFullYear());
  if (!S.statsYear || !years.includes(S.statsYear)) S.statsYear = years[0];
  const y = S.statsYear, st = yearStats(y), prev = years.includes(y - 1) ? yearStats(y - 1) : null;
  const tile = (n, l) => `<div class="sst"><b>${n}</b><span>${l}</span></div>`;
  const cmp = prev && st.fl.length !== prev.fl.length ? TL` · geçen yıldan ${Math.abs(st.fl.length - prev.fl.length)} ${st.fl.length > prev.fl.length ? TX('fazla') : TX('az')}` : '';
  const topCity = st.cities.length ? st.cities[0] : '';
  app.innerHTML = TL`<div class="page stats${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>Özet</b><small>Gerçekleşen biletlerinden</small></div></div>
    <div class="sbody">
      <div class="syrs">${years.map(v => `<button class="chip ${v === y ? 'on' : ''}" data-yr="${v}">${v}</button>`).join('')}</div>
      ${kindMix(y).html}
      ${(() => { const sp = yearSpend(y); return sp.total > 0 ? TL`<div class="exyr">${I('cash')}<span><small>${y} seyahat harcaması</small><b>${fmtMoney(sp.total)}</b><em>${sp.trips} seyahat · seyahat başına ${fmtMoney(sp.total / sp.trips)}</em></span></div>` : ''; })()}
      ${st.done.length ? TL`<button class="wrapbtn" id="wrapGo">${I('sparkles')}<span><b>${y} yıl özeti</b><small>Hikâye gibi kaydır, paylaş</small></span><i>›</i></button>` : ''}
      <button class="wrapbtn wopen" id="wOpen">${I('world')}<span><b>Dünya haritam</b><small>Gittiklerin, planladıkların, gitmek istediklerin</small></span><i>›</i></button>
      ${st.done.length ? TL`<div class="smap" id="smapGo">${mapSvg(st)}</div>
      <div class="sgrid">${tile(fmtN(st.cities.length), TL`şehir · ${st.countries.length} ülke`)}${tile(fmtN(st.fl.length), TL`uçuş · ${fmtN(st.km)} km`)}${tile(fmtN(st.days), TX('gün yolda'))}${tile(fmtN(st.museums), TX('müze ve etkinlik'))}</div>
      ${st.longest ? TL`<p class="snote">En uzun uçuş: ${esc(apCity(st.longest.from) || st.longest.from)} → ${esc(apCity(st.longest.to) || st.longest.to)} · ${fmtN(Math.round(flightKm(st.longest)))} km${cmp}</p>` : ''}
      <div class="sh"><b>Pullarım</b><span>${st.countries.length} ülke${st.countries.length ? '' : TX(' · yurt dışı seyahatlerin burada birikir')}</span></div>
      <div class="stamps">${st.countries.map((c, i) => TL`<div class="pul" style="--pc:${['#C2410C', '#0F766E', '#854F0B', '#378ADD', '#993556', '#3B6D11'][i % 6]}"><b>${esc(c.cc)}</b><small>${esc(countryName(c.cc))}</small><i>${c.n} kez</i></div>`).join('')}<div class="pul empty"><b>?</b><small>sıradaki</small></div></div>`
      : TL`<div class="empty"><p>${y} yılında henüz gerçekleşen bilet yok.</p></div>`}
    </div></div>`;
  $('#back').onclick = () => go('home', 'back');
  $$('[data-yr]').forEach(b => b.onclick = () => { S.statsYear = +b.dataset.yr; renderStats(app); });
  const wg = $('#wrapGo'); if (wg) wg.onclick = () => yearWrap(y);
  const wo = $('#wOpen'); if (wo) wo.onclick = () => openWorld(); const sm = $('#smapGo'); if (sm) sm.onclick = () => openWorld();
  const nw = $('#statsNoWork'); if (nw) nw.onclick = () => { lsSet('statsNoWork', !lsGet('statsNoWork', false)); renderStats(app); };
}

/* ---------- bavul listesi ---------- */
const PACK_CATS = [TX('Belgeler'), TX('Giysi'), TX('Elektronik'), TX('Banyo'), TX('İlaç'), TX('Diğer')];
const PACK_BASE = [
  [TX('Belgeler'), TX('Pasaport / kimlik')], [TX('Belgeler'), TX('Biletler · DoraGo\'da')], [TX('Belgeler'), TX('Seyahat sigortası')], [TX('Belgeler'), TX('Kredi kartı ve biraz nakit')],
  [TX('Giysi'), TX('İç çamaşırı')], [TX('Giysi'), TX('Çorap')], [TX('Giysi'), TX('Tişört / gömlek')], [TX('Giysi'), TX('Pantolon')], [TX('Giysi'), TX('Pijama')], [TX('Giysi'), TX('Rahat yürüyüş ayakkabısı')],
  [TX('Elektronik'), TX('Telefon şarjı')], [TX('Elektronik'), TX('Powerbank')], [TX('Elektronik'), TX('Kulaklık')],
  [TX('Banyo'), TX('Diş fırçası ve macun')], [TX('Banyo'), TX('Deodorant')], [TX('Banyo'), TX('Şampuan (küçük boy)')],
  [TX('İlaç'), TX('Kişisel ilaçlar')], [TX('İlaç'), TX('Ağrı kesici')],
  [TX('Diğer'), TX('Su şişesi')],
];
/* ülkelere göre priz tipleri (Türkiye: C/F) */
const PLUGS = { GB: 'G', IE: 'G', MT: 'G', CY: 'G', AE: 'G', SG: 'G', HK: 'G', QA: 'G', MY: 'G', US: 'A/B', CA: 'A/B', MX: 'A/B', JP: 'A/B', TH: 'A/B/C', TW: 'A/B', PH: 'A/B/C', CN: 'A/C/I', AU: 'I', NZ: 'I', AR: 'C/I', CH: 'J', LI: 'J', IT: 'C/F/L', BR: 'N', ZA: 'M/N', IN: 'C/D/M', IL: 'C/H', DK: 'C/F/K', JO: 'B/C/D/F/G/J', SA: 'G', EG: 'C/F', MA: 'C/E', BE: 'C/E', FR: 'C/E', CZ: 'C/E', SK: 'C/E', PL: 'C/E' };
const homePlug = () => (window.CINFO && CINFO[HOME_CC] && CINFO[HOME_CC].plug) || PLUGS[HOME_CC] || 'C/F';
/* ev ülkesinin fişleri bu prizlere girer mi (C fişi E/F prizine, F fişi E prizine de uyar) */
const plugFits = p => { const h = new Set(homePlug().split('/')); if (h.has('C')) { h.add('E'); h.add('F'); } if (h.has('F')) h.add('E'); if (h.has('A')) h.add('B'); return String(p).split('/').some(x => h.has(x)); };
const needsAdapter = cc => { const p = (window.CINFO && CINFO[cc] && CINFO[cc].plug) || PLUGS[cc]; return !!p && !plugFits(p); };
let PACKS = null;
async function getPacks() { if (!PACKS) PACKS = (await metaGet('packs')) || {}; return PACKS; }
async function savePacks() { await metaSet('packs', PACKS || {}); }
const tripForeign = name => { const d = tripDest(name); return !!(d && d.cc && d.cc !== HOME_CC); };
const packCount = name => { const p = PACKS && PACKS[name]; return p ? [p.items.filter(i => i.done).length, p.items.length] : null; };
function tripDest(name) {
  const ts = S.tickets.filter(t => t.trip === name);
  const fl = ts.filter(t => t.type === 'ucak' && t.to).sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1)[0];
  if (fl) { const r = apRec(fl.to); if (r) return r; }
  const c = tripCenter(name); if (c) return nearAp(c.lat, c.lon) || { city: c.label, cc: '', lat: c.lat, lon: c.lon };
  return null;
}
async function packSuggest(name, p) {
  const add = (c, t, why) => { if (p.items.some(i => i.t.toLocaleLowerCase(LANG) === t.toLocaleLowerCase(LANG)) || (p.hide || []).includes(t)) return false; p.items.push({ id: uid(), c, t, done: false, auto: why }); return true; };
  await loadWorld(); await loadCInfo(); window.CINFO = window.CINFO || {};
  const tips = [], dest = tripDest(name), g = allTrips().find(x => x.name === name) || {};
  const tdays = g.a ? nightsBetween(g.a, g.e || g.a) + 1 : 0, ci = dest && dest.cc ? CINFO[dest.cc] : null, cn = dest && dest.cc ? countryName(dest.cc) : '';
  if (dest && dest.cc && dest.cc !== HOME_CC) {
    if (ci && ci.cur && add(TX('Belgeler'), TL`Biraz yerel para (${curSymbol(ci.cur) !== ci.cur ? curSymbol(ci.cur) + ' ' : ''}${ci.cur})`, 'para')) tips.push(TL`${cn}: yerel para ${ci.cur} · listeye eklendi`);
    add(TX('Belgeler'), TX('Vize / giriş belgesi kontrolü'), 'vize'); add(TX('Elektronik'), TX('Yurt dışı paketi ya da eSIM'), 'esim'); add(TX('Diğer'), TX('Çevrimdışı harita ve çeviri paketini indir'), 'cevrim');
    if (ci && +String(ci.volt || '230').split('-')[0] < 150 && add(TX('Elektronik'), TX('110 V uyumluluğunu kontrol et (saç kurutma makinesi vb.)'), 'volt')) tips.push(TL`${cn}: elektrik ${ci.volt} V · cihazlarını kontrol et`);
    if (ci && ci.water === 0) { const a = add(TX('Diğer'), TX('Şişe su'), 'su'), b = add(TX('İlaç'), TX('Mide ilacı'), 'su'); if (a || b) tips.push(TL`${cn}: musluk suyu genelde içilmez · şişe su ve mide ilacı eklendi`); }
    if (dest.lat != null && Math.abs(dest.lat) < 23.5 && add(TX('İlaç'), TX('Sivrisinek kovucu'), 'sinek')) tips.push(TX('Tropik bölge · sivrisinek kovucu eklendi'));
    if ((ci && ci.sac) || /^(Roma|Kudüs|Mekke|Medine)$/.test(dest.city || '')) { if (add(TX('Giysi'), TX('Omuz ve dizleri kapatan kıyafet / şal'), 'kutsal')) tips.push(TX('Kutsal mekân ziyaretleri için omuz ve dizleri kapatan kıyafet eklendi')); }
  }
  const fls = S.tickets.filter(t => t.trip === name && t.type === 'ucak' && t.from && t.to);
  if (fls.some(t => HIGH_AP.has(t.to))) { if (add(TX('İlaç'), TX('Dudak koruyucu'), 'rakim')) tips.push(TX('Yüksek rakımlı şehir · yavaş tempo, bol su; dudak koruyucu eklendi')); }
  if (fls.some(t => flightKm(t) >= 4800)) { const a = add(TX('Diğer'), TX('Boyun yastığı'), 'uzun'), b = add(TX('Diğer'), TX('Kulak tıkacı ve göz bandı'), 'uzun'); if (a || b) tips.push(TX('Uzun uçuş (6 saat üstü) · boyun yastığı ve göz bandı eklendi')); }
  if (tdays >= 6) { const a = add(TX('Diğer'), TX('Çamaşır torbası'), 'uzunsey'), b = add(TX('Banyo'), TX('Küçük deterjan'), 'uzunsey'); if (a || b) tips.push(TL`${tdays} günlük seyahat · çamaşır torbası ve küçük deterjan eklendi`); }
  if (dest && dest.cc && dest.cc !== HOME_CC) { try { const tc = await tripCountry(name); if (tc && Math.abs(tc.diffH || 0) >= 3 && !(p.tips || []).some(x => /saat fark/.test(x))) tips.push(TL`Saat farkı ${Math.abs(tc.diffH)} saat · ilk güne hafif program koy`); } catch (e) {} }
  if (dest && dest.cc && needsAdapter(dest.cc)) { if (add(TX('Elektronik'), TL`Priz dönüştürücü (tip ${(CINFO[dest.cc] || {}).plug || PLUGS[dest.cc]})`, 'priz')) tips.push(TL`${countryName(dest.cc)}: priz tipi ${(CINFO[dest.cc] || {}).plug || PLUGS[dest.cc]} · dönüştürücü eklendi`); }
  if (S.tickets.some(t => t.trip === name && t.type === 'ucak')) add(TX('Banyo'), TX('Sıvılar ≤100 ml, şeffaf poşette'), 'ucus');
  if (dest && dest.lat != null && g.a && S.wx !== false) {
    const days = []; for (let d = g.a; d <= (g.e || g.a) && days.length < 21; d = addDays(d, 1)) days.push(d);
    let wx = {}; try { wx = await wxDays(dest.lat, dest.lon, days); } catch (e) {}
    const vals = Object.values(wx); p.wxDone = vals.length > 0;
    if (vals.length) {
      const rain = vals.filter(w => (w.prob != null && w.prob >= 50) || (w.code >= 51 && w.code <= 82)).length;
      const cold = Math.min(...vals.map(w => w.min)), hot = Math.max(...vals.map(w => w.max)), city = dest.city || name;
      if (rain) { const a = add(TX('Giysi'), TX('Şemsiye'), 'yagmur'), b = add(TX('Giysi'), TX('Yağmurluk'), 'yagmur'); if (a || b) tips.push(TL`${city}: ${rain} gün yağmur bekleniyor · şemsiye ve yağmurluk eklendi`); }
      if (cold <= 7) { const a = add(TX('Giysi'), TX('Mont'), 'soguk'), b = add(TX('Giysi'), TX('Atkı ve eldiven'), 'soguk'); if (a || b) tips.push(TL`Gece ${Math.round(cold)}°'ye kadar düşüyor · mont eklendi`); }
      if (hot >= 26) { const a = add(TX('Diğer'), TX('Güneş kremi'), 'sicak'); add(TX('Diğer'), TX('Şapka'), 'sicak'); add(TX('Diğer'), TX('Güneş gözlüğü'), 'sicak'); if (hot >= 27) add(TX('Giysi'), TX('Mayo'), 'sicak'); if (a) tips.push(TL`Gündüz ${Math.round(hot)}°'yi buluyor · güneş kremi, şapka${hot >= 27 ? TX(' ve mayo') : ''} eklendi`); }
    }
  }
  if (tips.length) p.tips = [...new Set([...(p.tips || []), ...tips])];
}
async function openPack(name) {
  await getPacks();
  let p = PACKS[name];
  if (!p) {
    const tpl = (await metaGet('packTpl')) || [], hide = (await metaGet('packHide')) || [];
    p = PACKS[name] = { items: [], tips: [], hide };
    for (const [c, t] of [...PACK_BASE, ...tpl.map(x => [x.c, x.t])]) if (!hide.includes(t) && !p.items.some(i => i.t === t)) p.items.push({ id: uid(), c, t, done: false });
  }
  S.packTrip = name; go('pack');
  if (packKind(name, p)) { await savePacks(); render(); }
  if (!p.wxDone || p.rv !== 2) { await packSuggest(name, p); p.rv = 2; await savePacks(); if (S.view === 'pack' && S.packTrip === name) render(); }
}
function renderPack(app, anim) {
  const name = S.packTrip, p = PACKS && PACKS[name]; if (!p) { go('home'); return; }
  const done = p.items.filter(i => i.done).length, tot = p.items.length;
  app.innerHTML = TL`<div class="page pack${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>${esc(name)} · Bavul</b><small>${done} / ${tot} hazır</small></div></div>
    <div class="sbody"><div class="pbar"><i style="width:${tot ? Math.round(done / tot * 100) : 0}%"></i></div>
      ${(p.tips || []).map(t => `<div class="ptip">${I(/yağmur/.test(t) ? 'cloud-rain' : /priz|V ·/.test(t) ? 'plug' : /mont|°/.test(t) ? 'temperature' : /para/.test(t) ? 'cash' : /su /.test(t) ? 'droplet' : /uçuş|Saat/.test(t) ? 'plane-tilt' : 'bulb')}<span>${esc(t)}</span></div>`).join('')}
      ${PACK_CATS.map(c => { const its = p.items.filter(i => i.c === c); return TL`<div class="pcat"><div class="pch"><b>${c}</b><span>${its.filter(i => i.done).length}/${its.length}</span></div>
        ${its.map(i => TL`<div class="pit ${i.done ? 'on' : ''}" data-pi="${i.id}"><span class="pcb">${i.done ? I('check') : ''}</span><span class="ptx">${esc(i.t)}</span><button class="pdel" data-pdel="${i.id}" aria-label="Kaldır">${I('x')}</button></div>`).join('')}
        <button class="padd" data-padd="${c}">${I('plus')} Ekle</button></div>`; }).join('')}
      <p class="snote">Eklediğin eşyalar sonraki seyahatlerin listesine de gelir.</p></div></div>`;
  $('#back').onclick = () => go('home', 'back');
  $$('[data-pi]').forEach(r => r.onclick = async e => {
    if (e.target.closest('.pdel')) return;
    const i = p.items.find(x => x.id === r.dataset.pi); i.done = !i.done; await savePacks();
    const y = scrollY; renderPack(app); window.scrollTo(0, y); if (i.done) { okPop($(`[data-pi="${i.id}"] .pcb`)); tick(); }
  });
  $$('[data-pdel]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const i = p.items.find(x => x.id === b.dataset.pdel);
    const v = await sheetMenu(i.t, [{ icon: I('x'), label: TX('Bu listeden kaldır'), value: 'one' }, { icon: I('ban'), label: TX('Kaldır ve bir daha önerme'), sub: TX('Sonraki seyahatlerde de gelmez'), value: 'all' }]); if (!v) return;
    p.items = p.items.filter(x => x.id !== i.id);
    if (v === 'all') { const h = (await metaGet('packHide')) || []; if (!h.includes(i.t)) h.push(i.t); await metaSet('packHide', h); const tp = ((await metaGet('packTpl')) || []).filter(x => x.t !== i.t); await metaSet('packTpl', tp); }
    await savePacks(); const y = scrollY; renderPack(app); window.scrollTo(0, y);
  });
  $$('[data-padd]').forEach(b => b.onclick = async () => {
    const t = (await inputDialog({ title: TL`${b.dataset.padd} · ekle`, placeholder: TX('Örn. Kamera'), ok: TX('Ekle') }) || '').trim(); if (!t) return;
    p.items.push({ id: uid(), c: b.dataset.padd, t, done: false });
    const tp = (await metaGet('packTpl')) || []; if (!tp.some(x => x.t === t) && !PACK_BASE.some(x => x[1] === t)) { tp.push({ c: b.dataset.padd, t }); await metaSet('packTpl', tp); }
    const h = ((await metaGet('packHide')) || []).filter(x => x !== t); await metaSet('packHide', h);
    await savePacks(); const y = scrollY; renderPack(app); window.scrollTo(0, y);
  });
}

/* ---------- 5.6: ülke bilgileri ("Bilmen gerekenler") ---------- */
let CINFO_P = null;
function loadCInfo() {
  if (window.CINFO) return Promise.resolve(window.CINFO);
  if (!CINFO_P) CINFO_P = new Promise(res => { const s = document.createElement('script'); s.src = 'countries.js'; s.onload = () => res(window.CINFO || null); s.onerror = () => { CINFO_P = null; res(null); }; document.head.appendChild(s); });
  return CINFO_P;
}
const THANKS = { en: TX('Thank you'), de: TX('Danke'), fr: TX('Merci'), it: TX('Grazie'), es: TX('Gracias'), pt: TX('Obrigado / Obrigada'), nl: TX('Dank je'), el: TX('Efharistó'), ru: TX('Spasibo'), ar: TX('Şukran'), ja: TX('Arigatō'), zh: TX('Xièxie'), ko: TX('Gamsahamnida'), pl: TX('Dziękuję'), cs: 'Děkuji', sk: 'Ďakujem', hu: TX('Köszönöm'), ro: TX('Mulțumesc'), bg: TX('Blagodarya'), hr: TX('Hvala'), sr: TX('Hvala'), bs: TX('Hvala'), sl: TX('Hvala'), mk: TX('Blagodaram'), sq: TX('Faleminderit'), sv: TX('Tack'), no: TX('Takk'), nb: TX('Takk'), da: TX('Tak'), fi: TX('Kiitos'), is: TX('Takk'), et: TX('Aitäh'), lv: TX('Paldies'), lt: 'Ačiū', uk: TX('Dyakuyu'), ka: TX('Madloba'), hy: TX('Shnorhakalutyun'), az: TX('Təşəkkür edirəm'), kk: TX('Rahmet'), uz: TX('Rahmat'), th: TX('Khop khun'), vi: 'Cảm ơn', id: TX('Terima kasih'), ms: TX('Terima kasih'), tl: TX('Salamat'), hi: TX('Dhanyavaad'), ne: TX('Dhanyabad'), bn: TX('Dhonnobad'), si: TX('Istuti'), he: TX('Toda'), fa: TX('Mersi'), ur: TX('Shukriya'), sw: TX('Asante'), mt: TX('Grazzi'), ca: TX('Gràcies'), ga: TX('Go raibh maith agat'), km: TX('Arkun'), lo: TX('Khop jai'), my: TX('Kyay zu tin ba de'), mn: TX('Bayarlalaa'), am: TX('Ameseginalehu') };
const HIGH_AP = new Set(['CUZ', 'LPB', 'VVI', 'UIO', 'BOG', 'LXA', 'ADD', 'MEX', 'JUL', 'AQP', 'KTM', 'SRE']);
const TRANSIT = { 'Londra': TX('Metro ve otobüste temassız kredi kartı ya da telefonla ödeme yeterli; Oyster kart şart değil. Günlük/haftalık ücret tavanı otomatik uygulanır.'), 'New York': TX('Metro ve otobüste OMNY: temassız kart ya da telefonla turnikeye dokun.'), 'Amsterdam': TX('Tram, metro ve trende OVpay: temassız banka kartıyla giriş ve çıkışta okut.'), 'Roma': TX('Metroda turnikeye temassız kart ya da telefonla geçilebilir; otobüs ve tramda bilet doğrulamayı unutma.'), 'İstanbul': TX('İstanbulkart ile tüm toplu taşıma; birçok hatta temassız kredi kartı da geçiyor.'), 'Paris': TX('Metro için Navigo Easy kartı ya da resmi uygulamadan bilet; tek tek kâğıt bilet artık satılmıyor olabilir, istasyonda kontrol et.') };
function tzOf(c, lat, lon) {
  if (c.tz) return c.tz;
  if (c._cc === 'US') return lon > -87.5 ? 'America/New_York' : lon > -101 ? 'America/Chicago' : lon > -115 ? (lat < 37 && lon > -115 && lon < -109 ? 'America/Phoenix' : 'America/Denver') : 'America/Los_Angeles';
  if (c._cc === 'CA') return lon > -67 ? 'America/Halifax' : lon > -90 ? 'America/Toronto' : lon > -102 ? 'America/Winnipeg' : lon > -120 ? 'America/Edmonton' : 'America/Vancouver';
  if (c._cc === 'AU') return lon > 141 ? (lat > -29 ? 'Australia/Brisbane' : 'Australia/Sydney') : lon > 129 ? (lat > -20 ? 'Australia/Darwin' : 'Australia/Adelaide') : 'Australia/Perth';
  if (c._cc === 'ID') return lon < 114 ? 'Asia/Jakarta' : lon < 127 ? 'Asia/Makassar' : 'Asia/Jayapura';
  return '';
}
function tzOffsetMin(tz, date) {
  try { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date).find(x => x.type === 'timeZoneName').value; const m = p.match(/GMT([+-]\d+)(?::(\d+))?/); return m ? (+m[1]) * 60 + Math.sign(+m[1] || 1) * (+(m[2] || 0)) : 0; } catch (e) { return null; }
}
const curSymbol = c => { try { return new Intl.NumberFormat(LOC, { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(x => x.type === 'currency').value; } catch (e) { return c; } };
const langName = l => { try { return new Intl.DisplayNames([LANG], { type: 'language' }).of(l); } catch (e) { return l; } };
/* seyahatin ülke özeti: gidilen yer + tablo + saat farkı */
async function tripCountry(name) {
  await loadCInfo(); await loadWorld();
  const dest = tripDest(name); if (!dest || !dest.cc || !window.CINFO || !CINFO[dest.cc]) return null;
  const c = { ...CINFO[dest.cc], _cc: dest.cc }, g = allTrips().find(x => x.name === name) || {};
  const tz = tzOf(c, dest.lat, dest.lon), when = g.a ? new Date(at(g.a, '12:00')) : new Date();
  const off = tz ? tzOffsetMin(tz, when) : null, home = tzOffsetMin(homeTz(), when);
  const diffH = off != null && home != null ? (off - home) / 60 : null;
  return { ...c, cc: dest.cc, city: dest.city, lat: dest.lat, lon: dest.lon, country: countryName(dest.cc), tzName: tz, diffH, foreign: dest.cc !== HOME_CC };
}
const diffTxt = h => { if (h == null) return ''; const hn = homeName(); return h === 0 ? TL`${hn} ile aynı saat` : TL`${hn}${ablSfx(hn)} ${Math.abs(h)} saat ${h > 0 ? TX('ileride') : TX('geride')}`; };
async function openCInfo(name) { busy(TX('Hazırlanıyor…')); const ci = await tripCountry(name); busy(false); if (!ci) { toast(TX('Bu seyahatin ülkesi bulunamadı')); return; } S.cinfo = { name, ci }; go('cinfo'); }
/* ---------- 5.24: konuşma kılavuzu (www/phrases.js, tembel) ---------- */
const PHR_LANGS = new Set('en tr de fr it es pt nl el ar ru ja zh ko th cs hu pl hr ka'.split(' '));
const PHR_ALIAS = { sr: 'hr', bs: 'hr', cnr: 'hr' };
let PHR_P = null, PHR_TRIED = false;
function loadPhr() {
  if (window.PHR) return Promise.resolve(window.PHR);
  if (!PHR_P) PHR_P = new Promise(res => { const s = document.createElement('script'); s.src = 'phrases.js'; s.onload = () => res(window.PHR || null); s.onerror = () => { PHR_P = null; res(null); }; document.head.appendChild(s); });
  return PHR_P;
}
/* seyahatin hedef dili (kılavuz varsa ve uygulama dilinden farklıysa) — {l: kılavuz dili, o: ülkenin dili} */
function tripPhrLang(name) {
  const d = tripDest(name); if (!d || !d.cc || d.cc === HOME_CC) return null;
  if (!window.CINFO) { if (!PHR_TRIED) { PHR_TRIED = true; loadCInfo().then(c => { if (c && S.view === 'trip') quietRender(); }); } return null; }
  const o = CINFO[d.cc] && CINFO[d.cc].lang, l = PHR_ALIAS[o] || o;
  return l && PHR_LANGS.has(l) && l !== LANG ? { l, o } : null;
}
const capFirst = x => x ? x.charAt(0).toLocaleUpperCase(LANG) + x.slice(1) : x;
async function openPhr(name) {
  const pl = tripPhrLang(name); if (!pl) return;
  busy(TX('Hazırlanıyor…')); const P = await loadPhr(); busy(false);
  if (!P) { toast(TX('Kılavuz açılamadı')); return; }
  S.phr = { name, ...pl }; if (!S.phrCat) S.phrCat = 'b'; go('phr');
}
function phrRow(i) {
  const P = window.PHR, { l } = S.phr, it = P.items[i], tg = P.L[l][i];
  const [t, rom] = Array.isArray(tg) ? tg : [tg, ''];
  return { src: LANG === 'tr' ? it[1] : it[2], t, rom };
}
function renderPhr(app, anim) {
  const P = window.PHR; if (!P || !S.phr) { go('home', 'back'); return; }
  const { name, l, o } = S.phr, cat = S.phrCat || 'b';
  const tabs = P.cats.map(c => `<button class="phc${c[0] === cat ? ' on' : ''}" data-c="${c[0]}">${I(c[3])} ${esc(LANG === 'tr' ? c[1] : c[2])}</button>`).join('');
  const rows = P.items.map((it, i) => it[0] === cat ? i : -1).filter(i => i >= 0).map(i => {
    const r = phrRow(i);
    return `<div class="phr" data-i="${i}"><span class="pht"><small>${esc(r.src)}</small><b dir="auto" lang="${l}">${esc(r.t)}</b>${r.rom ? `<em>${esc(r.rom)}</em>` : ''}</span><button class="icon-btn phs" data-sp="${i}" aria-label="Dinle">${I('volume')}</button></div>`;
  }).join('');
  const alias = o && o !== l ? TL`<p class="snote">${capFirst(langName(l))} kalıplar; ${capFirst(langName(o))} konuşanlar da büyük ölçüde anlar.</p>` : '';
  app.innerHTML = TL`<div class="page phrp${animCls(anim)}">
    <div class="phtop"><div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>${esc(capFirst(langName(l)))}</b><small>Konuşma kılavuzu · ${esc(name)}</small></div></div>
    <div class="phtabs">${tabs}</div></div>
    <div class="sbody"><div class="phl">${rows}</div>${alias}
    <p class="snote">Kalıba dokun: büyük yazıyla göster. Çeviriler günlük kullanım içindir.</p></div></div>`;
  $('#back').onclick = () => go('home', 'back');
  $$('.phc', app).forEach(b => b.onclick = () => { S.phrCat = b.dataset.c; quietRender(); window.scrollTo(0, 0); });
  $$('.phr', app).forEach(r => r.onclick = e => { if (e.target.closest('.phs')) return; phrShow(+r.dataset.i); });
  $$('.phs', app).forEach(b => b.onclick = () => phrSpeak(+b.dataset.sp));
  const on = $('.phc.on', app); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function phrSpeak(i) {
  const r = phrRow(i), l = S.phr.l, txt = r.t.replace(/…/g, ' ').replace(/\s*\/\s*/g, ', ');
  window.onSpeak = st => { if (st === 'nolang') toast(TL`Telefonda ${langName(l)} ses paketi yüklü değil (Ayarlar → Metin okuma)`, 4000); else if (st === 'noengine') toast(TX('Sesli okuma bu telefonda kullanılamıyor')); };
  if (A && A.speak) { A.speak(txt, l); return; }
  try {
    const ss = window.speechSynthesis; if (!ss) throw 0;
    const u = new SpeechSynthesisUtterance(txt); u.lang = l; u.rate = .85;
    const vs = ss.getVoices(); if (vs.length && !vs.some(v => (v.lang || '').toLowerCase().startsWith(l))) { onSpeak('nolang'); return; }
    ss.cancel(); ss.speak(u);
  } catch (e) { onSpeak('noengine'); }
}
function phrShow(i) {
  const r = phrRow(i), l = S.phr.l;
  const ov = document.createElement('div'); ov.className = 'ov phov';
  ov.innerHTML = TL`<div class="phbig"><small>${esc(r.src)}</small><div class="phbt" dir="auto" lang="${l}">${esc(r.t)}</div>${r.rom ? `<em>${esc(r.rom)}</em>` : ''}
    <div class="phbb"><button class="btn" id="phSay">${I('volume')} Dinle</button><button class="btn" id="phX">Kapat</button></div></div>`;
  document.body.appendChild(ov); tick();
  const close = () => { ov.remove(); dlgClose = null; if (A && A.stopSpeak) A.stopSpeak(); };
  dlgClose = close;
  ov.onclick = e => { if (e.target.closest('#phSay')) { phrSpeak(i); return; } close(); };
}
function renderCInfo(app, anim) {
  const { name, ci } = S.cinfo || {}; if (!ci) { go('home'); return; }
  const row = (ic, k, v, sub) => v ? `<div class="vrow"><span class="vri">${I(ic)}</span><span class="vrt"><small>${esc(k)}</small><b>${esc(v)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span></div>` : '';
  const sym = ci.cur ? curSymbol(ci.cur) : '', plugOk = ci.plug && plugFits(ci.plug);
  const tr = TRANSIT[ci.city] || TRANSIT[{ London: 'Londra', Rome: 'Roma', Istanbul: 'İstanbul' }[ci.city]];
  app.innerHTML = TL`<div class="page cinfo${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>Bilmen gerekenler</b><small>${esc(ci.country)}${ci.city ? ' · ' + esc(ci.city) : ''}</small></div></div>
    <div class="sbody"><div class="vrows cig">
      ${row('cash', TX('Para'), ci.cur ? `${sym !== ci.cur ? sym + ' ' : ''}${ci.cur}` : '', ci.cur === 'EUR' ? TX('Euro') : '')}
      ${row('plug', TX('Priz / voltaj'), ci.plug ? TL`Tip ${ci.plug} · ${ci.volt} V` : '', ci.plug ? (plugOk ? TL`${homeName()} fişleri genelde uyar` : TX('Dönüştürücü gerekir')) + (+String(ci.volt).split('-')[0] < 150 ? TX(' · cihazların 110 V destekliyor mu kontrol et') : '') : '')}
      ${row('phone-call', TX('Acil numara'), emTxt(ci.em) || '112', ci.em ? '' : TX('Çoğu ülkede cep telefonundan 112 çalışır'))}
      ${row('car', TX('Trafik'), ci.dr === 'L' ? TX('Soldan akar') : TX('Sağdan akar'), ci.dr === 'L' ? TX('Karşıya geçerken önce sağa bak') : '')}
      ${row('clock', TX('Saat'), ci.diffH != null ? diffTxt(ci.diffH) : '', Math.abs(ci.diffH || 0) >= 3 ? TX('Jet lag için ilk güne hafif program koy') : '')}
      ${row('language', TX('Dil'), ci.lang ? langName(ci.lang) : '', THANKS[ci.lang] ? TL`"Teşekkürler" = ${THANKS[ci.lang]}` : '')}
      ${ci.water === 0 ? row('droplet', TX('Musluk suyu'), TX('Genelde içilmez'), TX('Şişe su tercih et, buz ve çiğ sebzeye dikkat')) : ''}
      ${tr ? row('bus', TL`${ci.city} ulaşımı`, tr) : ''}
      ${ci.foreign ? row('id', TX('Giriş koşulları'), TX('Vize / giriş koşullarını kontrol et'), TX('Kurallar değişebiliyor; resmi kaynaktan bak')) : ''}
    </div><p class="snote">Bilgiler internetsiz çalışır ve "genelde" geçerlidir; yerel duyurular önceliklidir.</p></div></div>`;
  $('#back').onclick = () => go('home', 'back');
}

/* ================= 5.9: masraflar ================= */
const EXP_CATS = [
  { k: 'ulasim', n: TX('Ulaşım'), ic: 'plane-tilt', c: '#378ADD' },
  { k: 'konaklama', n: TX('Konaklama'), ic: 'bed', c: '#7F77DD' },
  { k: 'yemek', n: TX('Yemek'), ic: 'tools-kitchen-2', c: '#BA7517' },
  { k: 'gezi', n: TX('Gezi'), ic: 'building-bank', c: '#0F766E' },
  { k: 'alisveris', n: TX('Alışveriş'), ic: 'shopping-bag', c: '#D4537E' },
  { k: 'diger', n: TX('Diğer'), ic: 'receipt', c: '#888780' },
];
const expCat = k => EXP_CATS.find(c => c.k === k) || EXP_CATS[5];
const TYPE_CAT = { ucak: 'ulasim', ulasim: 'ulasim', konaklama: 'konaklama', yemek: 'yemek', muze: 'gezi', etkinlik: 'gezi', gezi: 'gezi', diger: 'diger' };
const CURS = ['TRY', 'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'AED', 'SAR', 'QAR', 'THB', 'GEL', 'AZN', 'EGP', 'MAD', 'CZK', 'HUF', 'PLN', 'SEK', 'NOK', 'DKK', 'BGN', 'RON', 'RSD', 'ISK', 'CAD', 'AUD', 'NZD', 'CNY', 'KRW', 'SGD', 'HKD', 'INR', 'IDR', 'MYR', 'MXN', 'BRL', 'ZAR', 'ILS'];
const pct = v => LANG === 'tr' ? '%' + v : v + '%';
const baseCur = () => lsGet('dgBaseCur', 'TRY');
const emTxt = e => !e || LANG === 'tr' ? e : String(e).replace(/turist polisi/g, 'tourist police').replace(/Polis/g, 'Police').replace(/polis/g, 'police').replace(/ambulans/g, 'ambulance').replace(/cepten/g, 'mobile');
let EXP = null, FX = null;
async function getExp() { if (!EXP) EXP = (await metaGet('expenses')) || {}; return EXP; }
async function saveExp() { await metaSet('expenses', EXP || {}); }
async function getFx() { if (!FX) FX = (await metaGet('fx')) || null; return FX; }
async function refreshFx(force) {
  const b = baseCur(); await getFx();
  if (!force && FX && FX.base === b && Date.now() - FX.at < 12 * 3600e3) return FX;
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${b}`); if (!r.ok) throw new Error(r.status);
    const j = await r.json(); if (!j || !j.rates) throw new Error(TX('kur yok'));
    FX = { base: b, date: j.date, at: Date.now(), rates: j.rates }; await metaSet('fx', FX);
  } catch (e) { if (force) toast(TX('Kur alınamadı (internet?)')); }
  return FX;
}
/* 1 birim cur = ? base */
function fxRate(cur, b = baseCur()) {
  if (!cur || cur === b) return 1; if (!FX || !FX.rates) return null;
  const R = { ...FX.rates, [FX.base]: 1 };
  return R[cur] && R[b] ? R[b] / R[cur] : null;
}
const parseAmt = v => {
  if (v == null || v === '') return NaN; let s = String(v).trim().replace(/[\s₺$€£]/g, ''); const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc > -1) s = /^[1-9]\d{0,2}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (ld > -1 && /^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return parseFloat(s);
};
const parseRate = v => parseFloat(String(v || '').trim().replace(/\s/g, '').replace(',', '.'));
function fmtMoney(v, cur = baseCur(), dec) {
  if (v == null || isNaN(v)) return '—';
  const d = dec != null ? dec : Math.abs(v) >= 1000 || Math.round(v) === v ? 0 : 2;
  try { return new Intl.NumberFormat(LOC, { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(v); } catch (e) { return `${v.toFixed(d)} ${cur}`; }
}
function expRec(name) { return (EXP && EXP[name]) || { people: [TX('Ben')], items: [] }; }
function expItems(name) {
  const rec = expRec(name), me = rec.people[0];
  const fromT = S.tickets.filter(t => t.trip === name && parseAmt(t.priceAmt) > 0).map(t => ({
    id: 't:' + t.id, tid: t.id, amt: parseAmt(t.priceAmt), cur: (t.priceCur || baseCur()).toUpperCase(), cat: TYPE_CAT[t.type] || 'diger',
    date: t.date || '', note: t.title || typeOf(t.type).n, payer: t.pPay || me, split: t.pSplit || null, r: t.pR || null, rb: t.pRb || null,
  }));
  return [...fromT, ...shopExpItems(name, me), ...rec.items];
}
function itemBase(it, b = baseCur()) {
  if (it.cur === b) return it.amt;
  if (it.r && it.rb === b) return it.amt * it.r;
  if (it.r && it.rb) { const x = fxRate(it.rb, b); if (x) return it.amt * it.r * x; }
  const r = fxRate(it.cur, b); return r ? it.amt * r : null;
}
function expSummary(name) {
  const rec = expRec(name), people = rec.people, its = expItems(name), b = baseCur();
  let total = 0, unknown = 0; const byCat = new Map(), bal = Object.fromEntries(people.map(p => [p, 0])), paid = Object.fromEntries(people.map(p => [p, 0]));
  let big = null;
  for (const it of its) {
    const v = itemBase(it, b); if (v == null) { unknown++; continue; }
    total += v; byCat.set(it.cat, (byCat.get(it.cat) || 0) + v);
    if (!big || v > big.v) big = { it, v };
    const payer = people.includes(it.payer) ? it.payer : people[0], sp = (it.split && it.split.length ? it.split : people).filter(p => people.includes(p));
    paid[payer] += v; bal[payer] += v; for (const p of sp) bal[p] -= v / sp.length;
  }
  const deb = people.filter(p => bal[p] < -0.5).map(p => [p, -bal[p]]).sort((x, y) => y[1] - x[1]);
  const cre = people.filter(p => bal[p] > 0.5).map(p => [p, bal[p]]).sort((x, y) => y[1] - x[1]);
  const settle = []; let i = 0, j = 0;
  while (i < deb.length && j < cre.length) { const m = Math.min(deb[i][1], cre[j][1]); settle.push({ from: deb[i][0], to: cre[j][0], v: m }); deb[i][1] -= m; cre[j][1] -= m; if (deb[i][1] < 0.5) i++; if (cre[j][1] < 0.5) j++; }
  const g = allTrips().find(x => x.name === name) || {}, days = g.a ? nightsBetween(g.a, g.e || g.a) + 1 : 0;
  return { total, unknown, byCat: EXP_CATS.filter(c => byCat.get(c.k)).map(c => ({ ...c, v: byCat.get(c.k) })), people, paid, bal, settle, big, days, n: its.length, b };
}
function yearSpend(y) {
  if (!EXP) return { total: 0, trips: 0 };
  const today = todayStr(); let total = 0, trips = 0;
  for (const g of allTrips()) { if (!g.a || g.a.slice(0, 4) !== String(y) || g.a > today) continue; if (lsGet('statsNoWork', false) && tripKind(g.name) === 'is') continue; const s = expSummary(g.name); if (s.total > 0) { total += s.total; trips++; } }
  return { total, trips };
}
async function openExp(name) {
  await getExp(); await getFx(); S.expTrip = name; S.expTab = 'list';
  if (!S.expCur || S.expCur.name !== name) { const ci = await tripCountry(name).catch(() => null); S.expCur = { name, cur: ci && ci.cur ? ci.cur : baseCur() }; }
  go('exp');
  refreshFx().then(f => { if (f && S.view === 'exp') render(); });
}
function renderExp(app, anim) {
  const name = S.expTrip, g = allTrips().find(x => x.name === name);
  if (!g) { go('home', 'back'); return; }
  const rec = expRec(name), sm = expSummary(name), multi = rec.people.length > 1, tab = multi ? S.expTab || 'list' : 'list', b = sm.b;
  const its = expItems(name).slice().sort((x, y) => (x.date || '9999') < (y.date || '9999') ? -1 : (x.date || '9999') > (y.date || '9999') ? 1 : 0);
  const row = it => { const c = expCat(it.cat), v = itemBase(it, b); return `<button class="exr" data-ex="${esc(it.id)}">${dot(c.ic, c.c)}<span class="ext"><b>${esc(it.note || c.n)}</b><small>${esc([c.n, it.tid ? TX('bilet fiyatı') : '', multi ? TL`${it.payer} ödedi` : '', it.split && it.split.length && it.split.length < rec.people.length ? TL`${it.split.length} kişi` : ''].filter(Boolean).join(' · '))}</small></span><span class="exa"><b>${fmtMoney(it.amt, it.cur)}</b>${it.cur !== b ? `<small>${v != null ? '≈ ' + fmtMoney(v, b) : TX('kur yok')}</small>` : ''}</span></button>`; };
  let list = '', lastD = null;
  for (const it of its) { const d = it.date || ''; if (d !== lastD) { list += `<div class="exd">${d ? esc(new Date(d + 'T12:00').toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short' })) : TX('Tarihsiz')}</div>`; lastD = d; } list += row(it); }
  const sumCard = TL`<div class="exsum"><small>Toplam${multi ? TL` · ${rec.people.length} kişi` : ''}</small><b>${fmtMoney(sm.total, b)}</b>
    <span>${[multi ? TL`Kişi başı ${fmtMoney(sm.total / rec.people.length, b)}` : '', sm.days ? TL`günde ${fmtMoney(sm.total / sm.days, b)}` : ''].filter(Boolean).join(' · ')}${sm.unknown ? TL` · ${sm.unknown} masrafın kuru yok` : ''}</span>
    ${sm.byCat.length ? `<div class="exbar">${sm.byCat.map(c => `<i style="flex:${c.v};background:${c.c}"></i>`).join('')}</div><div class="exlg">${sm.byCat.map(c => `<span><em style="background:${c.c}"></em>${c.n} ${pct(Math.round(c.v / sm.total * 100))}</span>`).join('')}</div>` : ''}</div>`;
  const ppl = TL`<div class="exsec">Kim ne ödedi</div><div class="vrows">${rec.people.map((p, i) => `<button class="exp-p" data-pp="${i}"><span class="av" style="--h:${(i * 67) % 360}">${esc(p.slice(0, 1).toLocaleUpperCase(LANG))}</span><span class="ext"><b>${esc(p)}</b><small>${sm.bal[p] > 0.5 ? TL`${fmtMoney(sm.bal[p], b)} alacaklı` : sm.bal[p] < -0.5 ? TL`${fmtMoney(-sm.bal[p], b)} borçlu` : TX('Hesap kapalı')}</small></span><span class="exa"><b>${fmtMoney(sm.paid[p], b)}</b></span></button>`).join('')}
      <button class="exp-p add" id="pAdd">${I('user-plus')}<span class="ext"><b>Kişi ekle</b></span></button></div>
    <div class="exsec">Hesaplaşma</div>${sm.settle.length ? `<div class="vrows">${sm.settle.map(s => `<div class="exr"><span class="ext"><b>${esc(s.from)} → ${esc(s.to)}</b></span><span class="exa"><b>${fmtMoney(s.v, b)}</b></span></div>`).join('')}</div>` : TX('<p class="snote">Herkes ödeşmiş görünüyor.</p>')}`;
  app.innerHTML = TL`<div class="page expp${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>Masraflar</b><small>${esc(name)}</small></div><button class="icon-btn" id="pMng" aria-label="Kişiler">${I('users')}</button></div>
    <div class="sbody">
      ${multi ? TL`<div class="seg exseg"><button class="${tab === 'list' ? 'on' : ''}" data-xt="list">${I('receipt')} Masraflar</button><button class="${tab === 'ppl' ? 'on' : ''}" data-xt="ppl">${I('users')} Kişiler</button></div>` : ''}
      ${sumCard}
      ${tab === 'ppl' ? ppl : its.length ? `<div class="exlist">${list}</div>` : TL`<p class="snote">Henüz masraf yok. Biletlerine fiyat girersen burada kendiliğinden görünür.</p>`}
      <p class="snote exfx">${FX && FX.base === b ? TL`Kur: Avrupa Merkez Bankası · ${esc(fmtDate(FX.date))}` : TX('Kur henüz alınmadı')} · <button id="fxR">Yenile</button> · Ana para: ${b}</p>
    </div>
    <button class="fab exfab" id="exAdd" aria-label="Masraf ekle">${I('plus')}</button></div>`;
  $('#back').onclick = () => go('home', 'back');
  $$('[data-xt]').forEach(x => x.onclick = () => { S.expTab = x.dataset.xt; render(); });
  $$('[data-ex]').forEach(x => x.onclick = () => { const it = expItems(name).find(i => i.id === x.dataset.ex); if (it && it.sid) { const si = shopRec(name).items.find(i => i.id === it.sid); if (si) { shopDialog(name, si); return; } } expDialog(name, it); });
  $('#exAdd').onclick = () => expDialog(name, null);
  $('#fxR').onclick = async () => { busy(TX('Kur alınıyor…')); await refreshFx(true); busy(false); render(); };
  const pm = () => peopleMenu(name); $('#pMng').onclick = pm; const pa = $('#pAdd'); if (pa) pa.onclick = () => addPerson(name);
  $$('[data-pp]').forEach(x => x.onclick = () => personMenu(name, +x.dataset.pp));
}
function mergeExp(src, only) {
  for (const [k, r] of Object.entries(src || {})) {
    if (only && k !== only) continue; if (!r || !r.items) continue;
    const cur = EXP[k] || (EXP[k] = { people: [...(r.people || [TX('Ben')])], items: [] });
    cur.people = [...new Set([...cur.people, ...(r.people || [])])];
    for (const it of r.items) { const i = cur.items.findIndex(x => x.id === it.id); if (i < 0) cur.items.push(it); else if ((it.updatedAt || 0) > (cur.items[i].updatedAt || 0)) cur.items[i] = it; }
  }
}
function ensureExp(name) { EXP = EXP || {}; return EXP[name] || (EXP[name] = { people: [TX('Ben')], items: [] }); }
async function addPerson(name) {
  const n = await inputDialog({ title: TX('Kişi ekle'), placeholder: TX('Örn. Ayşe'), ok: TX('Ekle') }); if (!n || !n.trim()) return;
  const r = ensureExp(name), v = n.trim(); if (r.people.includes(v)) { toast(TX('Bu isim zaten var')); return; }
  r.people.push(v); r.updatedAt = Date.now(); await saveExp(); S.expTab = 'ppl'; render();
}
async function peopleMenu(name) {
  const r = expRec(name);
  const v = await sheetMenu(TX('Masrafı paylaşan kişiler'), [...r.people.map((p, i) => ({ icon: I('users'), label: p + (i === 0 ? ' (sen)' : ''), value: 'p' + i })), { icon: I('user-plus'), label: TX('Kişi ekle'), value: 'add' }]);
  if (!v) return; if (v === 'add') return addPerson(name); return personMenu(name, +v.slice(1));
}
async function personMenu(name, i) {
  const r = ensureExp(name), p = r.people[i]; if (p == null) return;
  const v = await sheetMenu(p, [{ icon: I('pencil'), label: TX('Adını değiştir'), value: 'ren' }, ...(i ? [{ icon: I('trash'), label: TX('Çıkar'), sub: TX('Ödediği masraflar sana geçer'), value: 'del', danger: true }] : [])]);
  if (!v) return;
  const swap = (from, to) => { for (const it of r.items) { if (it.payer === from) it.payer = to; if (it.split) it.split = to ? it.split.map(x => x === from ? to : x) : it.split.filter(x => x !== from); } };
  const swapT = async (from, to) => { for (const t of S.tickets.filter(t => t.trip === name)) { let ch = false; if (t.pPay === from) { t.pPay = to; ch = true; } if (t.pSplit) { t.pSplit = to ? t.pSplit.map(x => x === from ? to : x) : t.pSplit.filter(x => x !== from); ch = true; } if (ch) await saveTicketDB(t, [], []); } };
  if (v === 'ren') { const n = await inputDialog({ title: TX('Yeni ad'), value: p, ok: TX('Kaydet') }); if (!n || !n.trim() || n.trim() === p) return; if (r.people.includes(n.trim())) { toast(TX('Bu isim zaten var')); return; } r.people[i] = n.trim(); swap(p, n.trim()); await swapT(p, n.trim()); }
  else { r.people.splice(i, 1); swap(p, r.people[0]); for (const it of r.items) if (it.split) it.split = [...new Set(it.split)].filter(x => r.people.includes(x)); await swapT(p, r.people[0]); }
  r.updatedAt = Date.now(); await saveExp(); render();
}
function expDialog(name, it) {
  const r = ensureExp(name), people = r.people, isT = it && it.tid, b = baseCur();
  const cur0 = it ? it.cur : (S.expCur && S.expCur.name === name ? S.expCur.cur : b);
  const st = { amt: it ? String(it.amt).replace('.', ',') : '', cur: cur0, cat: it ? it.cat : 'yemek', date: it ? it.date : (() => { const g = allTrips().find(x => x.name === name) || {}, t = todayStr(); return g.a && t >= g.a && t <= (g.e || g.a) ? t : g.a || t; })(), note: it ? it.note : '', payer: it ? it.payer : people[0], split: it && it.split && it.split.length ? [...it.split] : [...people], rate: '' };
  const rateOf = c => { if (it && it.cur === c && it.r && it.rb === b) return it.r; return fxRate(c, b); };
  let rate = rateOf(st.cur);
  const ov = document.createElement('div'); ov.className = 'ov';
  const fmtR = v => v == null ? '' : String(+v.toFixed(v < 1 ? 6 : 4)).replace('.', ',');
  const draw = () => {
    ov.innerHTML = TL`<div class="dlg sheet exdlg"><h3>${it ? TX('Masrafı düzenle') : TX('Masraf ekle')}</h3>
      <div class="exam"><input class="inp" id="xAmt" inputmode="decimal" placeholder="0" value="${esc(st.amt)}" autocomplete="off"><select class="inp" id="xCur">${[...new Set([st.cur, b, ...(S.expCur ? [S.expCur.cur] : []), ...CURS])].map(c => `<option ${c === st.cur ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      ${st.cur !== b ? `<div class="exrate">1 ${st.cur} = <input class="inp" id="xRate" inputmode="decimal" value="${esc(fmtR(rate))}" placeholder="kur"> ${b} <span id="xConv"></span></div>` : ''}
      ${isT ? '' : `<div class="fchips excats">${EXP_CATS.map(c => `<button class="chip ${st.cat === c.k ? 'on' : ''}" data-xc="${c.k}" style="--kc:${c.c}">${I(c.ic)} ${c.n}</button>`).join('')}</div>`}
      ${isT ? TL`<p class="snote" style="margin:4px 2px 10px">${esc(it.note)} · bilet fiyatı</p>` : TL`<div class="row2"><div class="fld" style="flex:1.4"><label for="xNote">Not</label><input class="inp" id="xNote" maxlength="60" placeholder="Örn. Sahil restoranı" value="${esc(st.note)}"></div><div class="fld"><label for="xDate">Tarih</label><input class="inp" type="date" id="xDate" value="${esc(st.date)}"></div></div>`}
      ${people.length > 1 ? TL`<div class="fsec"><small>Ödeyen</small><div class="fchips">${people.map(p => `<button class="chip ${st.payer === p ? 'on' : ''}" data-xp="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
        <div class="fsec"><small>Kimler arasında bölünsün</small><div class="fchips">${people.map(p => `<button class="chip ${st.split.includes(p) ? 'on' : ''}" data-xs="${esc(p)}">${st.split.includes(p) ? I('check') + ' ' : ''}${esc(p)}</button>`).join('')}</div></div>` : ''}
      <p class="tde" id="xErr"></p>
      <div class="row2">${it ? `<button class="btn dan" data-xa="del">${isT ? TX('Fiyatı sil') : TX('Sil')}</button>` : TL`<button class="btn" data-xa="cancel">Vazgeç</button>`}<button class="btn pri" data-xa="ok">Kaydet</button></div></div>`;
    const conv = () => { const a = parseAmt($('#xAmt', ov).value), rt = $('#xRate', ov) ? parseRate($('#xRate', ov).value) : 1, e = $('#xConv', ov); if (e) e.textContent = a > 0 && rt > 0 ? '≈ ' + fmtMoney(a * rt, b) : ''; };
    $('#xAmt', ov).oninput = e => { st.amt = e.target.value; conv(); $('#xErr', ov).textContent = ''; };
    $('#xCur', ov).onchange = e => { st.cur = e.target.value; rate = rateOf(st.cur); keep(); draw(); };
    const xr = $('#xRate', ov); if (xr) xr.oninput = () => { rate = parseRate(xr.value); conv(); };
    conv();
  };
  const keep = () => { const n = $('#xNote', ov), d = $('#xDate', ov); if (n) st.note = n.value; if (d) st.date = d.value; };
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', async e => {
    const c = e.target.closest('[data-xc]'), p = e.target.closest('[data-xp]'), s = e.target.closest('[data-xs]'), a = e.target.closest('[data-xa]');
    if (c) { keep(); st.cat = c.dataset.xc; draw(); }
    else if (p) { keep(); st.payer = p.dataset.xp; draw(); }
    else if (s) { keep(); const v = s.dataset.xs; st.split = st.split.includes(v) ? st.split.filter(x => x !== v) : [...st.split, v]; draw(); }
    else if (a && a.dataset.xa === 'cancel') close();
    else if (a && a.dataset.xa === 'del') {
      if (!await dialog({ title: isT ? TX('Bilet fiyatı silinsin mi?') : TX('Masraf silinsin mi?'), ok: TX('Sil'), danger: true })) return;
      if (isT) { const t = S.tickets.find(x => x.id === it.tid); if (t) { for (const k of ['priceAmt', 'priceCur', 'pPay', 'pSplit', 'pR', 'pRb']) delete t[k]; t.updatedAt = Date.now(); await saveTicketDB(t, [], []); } }
      else { r.items = r.items.filter(x => x.id !== it.id); r.updatedAt = Date.now(); await saveExp(); }
      close(); render();
    }
    else if (a && a.dataset.xa === 'ok') {
      keep(); const amt = parseAmt(st.amt), err = $('#xErr', ov);
      if (!(amt > 0)) { err.textContent = TX('Tutarı yaz'); return; }
      if (people.length > 1 && !st.split.length) { err.textContent = TX('En az bir kişi seç'); return; }
      const rt = st.cur === b ? 1 : (rate > 0 ? rate : null);
      const split = people.length > 1 && st.split.length < people.length ? st.split : null;
      if (isT) {
        const t = S.tickets.find(x => x.id === it.tid); if (t) { Object.assign(t, { priceAmt: String(amt), priceCur: st.cur, pPay: st.payer, pSplit: split, pR: rt, pRb: b, updatedAt: Date.now() }); await saveTicketDB(t, [], []); }
      } else {
        const rec = { id: it ? it.id : 'x' + uid(), amt, cur: st.cur, r: rt, rb: b, cat: st.cat, date: st.date || '', note: (st.note || '').trim(), payer: st.payer, split, updatedAt: Date.now() };
        if (it) r.items = r.items.map(x => x.id === it.id ? rec : x); else r.items.push(rec);
        r.updatedAt = Date.now(); await saveExp();
      }
      S.expCur = { name, cur: st.cur }; close(); render();
    }
    else if (e.target === ov) close();
  });
  dlgClose = close; draw(); noAnimAfter(ov); document.body.appendChild(ov); setTimeout(() => { const x = $('#xAmt', ov); if (x && !it) x.focus(); }, 60);
}

/* ================= 5.17: hızlı gezilecek yer (ad + tür + not; konum sonra) ================= */
function quickPlace(name) {
  const st = { title: '', type: 'yemek', notes: '' }, ov = document.createElement('div'); ov.className = 'ov';
  const keep = () => { st.title = $('#qpN', ov).value; st.notes = $('#qpO', ov).value; };
  const draw = () => {
    ov.innerHTML = TL`<div class="dlg sheet qpdlg"><h3>Gezilecek yer</h3>
      <div class="fld"><label for="qpN">Yer</label><input class="inp" id="qpN" maxlength="80" value="${esc(st.title)}" placeholder="Örn. Pazar yerindeki fırın"></div>
      <div class="fchips">${['yemek', 'gezi'].map(k => `<button class="chip ${st.type === k ? 'on' : ''}" data-qt="${k}">${I(typeOf(k).ic)} ${esc(typeOf(k).n)}</button>`).join('')}</div>
      <div class="fld"><label for="qpO">Not <small>ne yenecek, kim önerdi…</small></label><input class="inp" id="qpO" maxlength="120" value="${esc(st.notes)}" placeholder="Örn. Tatlısı meşhur · arkadaş önerisi"></div>
      <p class="snote">Tarihsiz kaydedilir, planın altında "Gezilecekler" bölümünde durur. Konumu ve tarihi sonra bileti düzenleyerek ekleyebilirsin.</p>
      <p class="tde" id="qpErr"></p>
      <div class="row2"><button class="btn" data-qa="cancel">Vazgeç</button><button class="btn pri" data-qa="ok">Kaydet</button></div></div>`;
  };
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', async e => {
    const c = e.target.closest('[data-qt]'), a = e.target.closest('[data-qa]');
    if (c) { keep(); st.type = c.dataset.qt; draw(); return; }
    if (e.target === ov || (a && a.dataset.qa === 'cancel')) { close(); return; }
    if (a && a.dataset.qa === 'ok') {
      keep(); const tl = st.title.trim(); if (!tl) { $('#qpErr', ov).textContent = TX('Yerin adını yaz'); $('#qpN', ov).focus(); return; }
      const now = Date.now(), t = { id: uid(), type: st.type, title: tl, notes: st.notes.trim(), trip: name, date: '', pages: [], pageIds: [], createdAt: now, updatedAt: now };
      await saveTicketDB(t, [], []); S.tickets.push(t); close(); toast(TX('Yer kaydedildi')); render();
    }
  });
  dlgClose = close; draw(); noAnimAfter(ov); document.body.appendChild(ov); setTimeout(() => { const x = $('#qpN', ov); if (x) x.focus(); }, 60);
}

/* ================= 5.16: Alınacaklar (seyahat başına alışveriş / yapılacaklar listesi) ================= */
/* meta.shop = { [seyahat]: { items: [{ id, name, qty, who, store, sloc:{lat,lon,url,label}?, ph, note, done, doneAt, price, cur, createdAt, updatedAt }] } }
   fotoğraf pages deposunda 'sh_' kimlikli; mağaza isteğe bağlı (boş → "Genel", yalnız ad → Haritalar'da arama, konum → o yer + otele uzaklık) */
let SHOP = null;
async function getShop() { if (!SHOP) SHOP = (await metaGet('shop')) || {}; return SHOP; }
async function saveShop() { await metaSet('shop', SHOP || {}); }
const shopRec = name => (SHOP && SHOP[name]) || { items: [] };
const ensureShop = name => { SHOP = SHOP || {}; return SHOP[name] || (SHOP[name] = { items: [] }); };
function shopCount(name) { const it = shopRec(name).items; return it.length ? [it.filter(i => i.done).length, it.length] : null; }
function mergeShop(src, only) {
  for (const [k, r] of Object.entries(src || {})) {
    if (only && k !== only) continue; if (!r || !r.items) continue;
    const cur = ensureShop(k);
    for (const it of r.items) { const i = cur.items.findIndex(x => x.id === it.id); if (i < 0) cur.items.push(it); else if ((it.updatedAt || 0) > (cur.items[i].updatedAt || 0)) cur.items[i] = it; }
  }
}
function shopPhotoIds(name) { return shopRec(name).items.map(i => i.ph).filter(Boolean); }
async function moveShop(from, to) { await getShop(); if (!SHOP[from]) return; if (SHOP[to]) SHOP[to].items.push(...SHOP[from].items); else SHOP[to] = SHOP[from]; delete SHOP[from]; await saveShop(); }
async function dropShop(name) { await getShop(); const r = SHOP[name]; if (!r) return; const ph = r.items.map(i => i.ph).filter(Boolean); if (ph.length) await delPages(ph); delete SHOP[name]; await saveShop(); }
const tripHotel = name => S.tickets.find(t => t.trip === name && t.type === 'konaklama' && hasC(t));
/* Google Haritalar'da mağaza/ürün araması: otel konumu varsa onun çevresinde, yoksa seyahatin bir adresiyle */
function shopMapUrl(name, q) {
  q = (q || '').trim() || TX('mağaza'); const h = tripHotel(name);
  if (h) return `https://www.google.com/maps/search/${encodeURIComponent(q)}/@${(+h.lat).toFixed(5)},${(+h.lon).toFixed(5)},14z`;
  const p = S.tickets.find(t => t.trip === name && t.place && t.type !== 'ucak');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p ? q + ', ' + p.place : q)}`;
}
function shopDist(name, ll) {
  const h = tripHotel(name); if (!h || !ll || ll.lat == null) return '';
  const km = distKm({ lat: +h.lat, lon: +h.lon }, { lat: +ll.lat, lon: +ll.lon }), min = Math.max(1, Math.round(km * 1.25 / 4.8 * 60));
  return min <= 45 ? TL`otele ${min} dk` : TL`otele ${km.toLocaleString(LOC, { maximumFractionDigits: 1 })} km`;
}
function shopGroups(name, by) {
  const key = i => ((by === 'who' ? i.who : i.store) || '').trim(), m = new Map();
  for (const i of shopRec(name).items) { const k = key(i); if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
  return [...m.entries()].map(([k, its]) => ({ k, its: its.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.createdAt || 0) - (b.createdAt || 0)) }))
    .sort((a, b) => (a.k ? 1 : 0) - (b.k ? 1 : 0) || a.k.localeCompare(b.k, LANG));
}
/* masraflara: fiyatı girilmiş ve alınmış ürünler (expItems içinde 's:' kimliğiyle) */
function shopExpItems(name, me) {
  return shopRec(name).items.filter(i => i.done && parseAmt(i.price) > 0).map(i => ({ id: 's:' + i.id, sid: i.id, amt: parseAmt(i.price), cur: (i.cur || baseCur()).toUpperCase(), cat: 'alisveris', date: i.doneAt ? ymdOf(i.doneAt) : '', note: i.name, payer: me, split: null, r: null, rb: null }));
}
async function openShop(name) { await getShop(); S.shopTrip = name; if (!S.shopBy) S.shopBy = 'store'; for (const id of shopPhotoIds(name)) await photoBlob(id); go('shop'); }
function renderShop(app, anim) {
  const name = S.shopTrip; if (!name) { go('home'); return; }
  const by = S.shopBy || 'store', items = shopRec(name).items, gs = shopGroups(name, by), c = shopCount(name) || [0, 0];
  const keyed = gs.some(g => g.k);
  const sub = i => [i.qty > 1 ? TL`${i.qty} adet` : '', by === 'who' && i.store ? i.store : '', i.note || '', i.done && parseAmt(i.price) > 0 ? fmtMoney(parseAmt(i.price), (i.cur || baseCur()).toUpperCase()) : ''].filter(Boolean).join(' · ');
  const row = i => TL`<div class="shi ${i.done ? 'on' : ''}" data-si="${i.id}"><button class="pcb" data-sck="${i.id}" aria-label="Satın alındı">${i.done ? I('check') : ''}</button>${i.ph ? `<span class="shth" data-sph="${esc(i.ph)}" style="background-image:url('${PHB.get(i.ph) ? blobURL('ph:' + i.ph, PHB.get(i.ph)) : ''}')"></span>` : ''}<span class="ext"><b>${esc(i.name)}</b>${sub(i) ? `<small>${esc(sub(i))}</small>` : ''}</span>${i.who && by !== 'who' ? `<span class="shwho">${esc(i.who)}</span>` : ''}</div>`;
  const head = g => {
    if (!keyed) return '';
    if (!g.k) return TL`<div class="shg"><b>Genel</b><span>${g.its.length}</span></div>`;
    if (by === 'who') return `<div class="shg"><b>${I('user')} ${esc(g.k)}</b><span>${g.its.length}</span></div>`;
    const loc = (g.its.find(i => i.sloc && i.sloc.lat != null) || {}).sloc, d = loc ? shopDist(name, loc) : '';
    return TL`<div class="shg"><b>${I('building-store')} ${esc(g.k)}</b>${d ? `<small>${esc(d)}</small>` : ''}<button class="shmap" data-smap="${esc(g.k)}">${I('map-pin')} Harita</button></div>`;
  };
  app.innerHTML = TL`<div class="page shop${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>${esc(name)} · Alınacaklar</b><small>${c[1] ? TL`${c[0]} / ${c[1]} alındı` : TX('Liste boş')}</small></div></div>
    <div class="sbody">
      <div class="shadd"><input class="inp" id="shIn" placeholder="Örn. Buzdolabı magneti" autocomplete="off" maxlength="80"><button class="icon-btn" id="shPh" aria-label="Fotoğrafla ekle">${I('camera-plus')}</button><button class="btn pri" id="shAdd" aria-label="Ekle">${I('plus')}</button></div>
      ${items.length ? TL`<div class="seg shby"><button class="${by === 'store' ? 'on' : ''}" data-sby="store">${I('building-store')} Mağazaya göre</button><button class="${by === 'who' ? 'on' : ''}" data-sby="who">${I('user')} Kişiye göre</button></div>
        ${gs.map(g => `<div class="shgr">${head(g)}${g.its.map(row).join('')}</div>`).join('')}`
      : TL`<div class="shempty">${I('shopping-cart')}<p><b>Alınacakları buraya yaz</b><br>Hediyeler, denenecek yiyecekler, yapılacaklar… Mağaza ve kişi isteğe bağlı. Fotoğrafı WhatsApp'tan <b>Paylaş → DoraGo</b> ile de ekleyebilirsin.</p></div>`}
    </div></div>`;
  $('#back').onclick = () => go('home', 'back');
  const add = async () => { const v = ($('#shIn').value || '').trim(); if (!v) { $('#shIn').focus(); return; } const r = ensureShop(name), now = Date.now(); r.items.push({ id: 'i' + uid(), name: v, qty: 1, createdAt: now, updatedAt: now }); await saveShop(); renderShop(app); setTimeout(() => { const x = $('#shIn'); if (x) x.focus(); }, 30); };
  $('#shAdd').onclick = add;
  $('#shIn').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  $('#shPh').onclick = async () => { const [f] = await pickFiles('image/*', false); if (!f) return; busy(TX('Fotoğraf ekleniyor…')); let ph = null; try { ph = await shopPhotoFrom(f); } finally { busy(false); } shopDialog(name, null, { ph }); };
  $$('[data-sby]').forEach(b => b.onclick = () => { S.shopBy = b.dataset.sby; renderShop(app); });
  $$('[data-sck]').forEach(b => b.onclick = async e => {
    e.stopPropagation(); const i = shopRec(name).items.find(x => x.id === b.dataset.sck); if (!i) return;
    i.done = !i.done; i.doneAt = i.done ? Date.now() : null; i.updatedAt = Date.now(); await saveShop();
    const y = scrollY; renderShop(app); window.scrollTo(0, y); if (i.done) { okPop($(`[data-sck="${i.id}"]`)); tick(); }
  });
  $$('[data-sph]').forEach(t => t.onclick = async e => { e.stopPropagation(); const b = await photoBlob(t.dataset.sph); if (b) openLightbox([b]); });
  $$('[data-si]').forEach(r => r.onclick = () => { const i = shopRec(name).items.find(x => x.id === r.dataset.si); if (i) shopDialog(name, i); });
  $$('[data-smap]').forEach(b => b.onclick = () => {
    const k = b.dataset.smap, loc = (shopRec(name).items.find(i => (i.store || '').trim() === k && i.sloc) || {}).sloc;
    openUrl(loc && loc.url ? loc.url : loc && loc.lat != null ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(k)}`);
  });
}
async function shopPhotoFrom(file) { const s = await shrinkPhoto(file, 1200), id = 'sh_' + uid(); await putPages([{ id, w: s.w, h: s.h, blob: s.blob }]); PHB.set(id, s.blob); return id; }
function shopDialog(name, it, pre = {}) {
  const r = ensureShop(name), others = r.items.filter(x => !it || x.id !== it.id);
  const uniq = a => [...new Set(a.map(x => (x || '').trim()).filter(Boolean))];
  const whoList = uniq([...others.map(x => x.who), ...((EXP && EXP[name] && EXP[name].people) || []).slice(1)]).slice(0, 8);
  const storeList = uniq(others.map(x => x.store)).slice(0, 8);
  const st = { name: it ? it.name : '', qty: it ? it.qty || 1 : 1, who: it ? it.who || '' : '', store: it ? it.store || '' : '', sloc: it ? it.sloc || null : null, ph: it ? it.ph || null : pre.ph || null, note: it ? it.note || '' : '', done: it ? !!it.done : false, price: it && it.price ? String(it.price).replace('.', ',') : '', cur: it && it.cur ? it.cur : (S.expCur && S.expCur.name === name ? S.expCur.cur : baseCur()) };
  const ph0 = st.ph, ov = document.createElement('div'); ov.className = 'ov';
  const keep = () => { for (const [k, id] of [['name', 'sN'], ['who', 'sW'], ['store', 'sS'], ['note', 'sO'], ['price', 'sP']]) { const e = $('#' + id, ov); if (e) st[k] = e.value; } const q = $('#sQ', ov); if (q) st.qty = Math.max(1, Math.min(99, parseInt(q.value, 10) || 1)); const cu = $('#sC', ov); if (cu) st.cur = cu.value; };
  const draw = () => {
    ov.innerHTML = TL`<div class="dlg sheet shdlg"><h3>${it ? TX('Ürünü düzenle') : TX('Alınacak ekle')}</h3>
      <div class="row2"><div class="fld" style="flex:3"><label for="sN">Ne</label><input class="inp" id="sN" maxlength="80" value="${esc(st.name)}" placeholder="Örn. Yerel çikolata"></div><div class="fld" style="flex:1"><label for="sQ">Adet</label><input class="inp" id="sQ" type="number" min="1" max="99" inputmode="numeric" value="${st.qty}"></div></div>
      <div class="shphx">${st.ph ? `<span class="shth big" data-sa="view" style="background-image:url('${PHB.get(st.ph) ? blobURL('ph:' + st.ph, PHB.get(st.ph)) : ''}')"></span><button class="btn" data-sa="phdel">${I('x')} ${TX('Fotoğrafı kaldır')}</button>` : `<button class="btn" data-sa="ph">${I('camera-plus')} ${TX('Fotoğraf ekle')}</button>`}</div>
      <div class="fld"><label for="sW">Kim için <small>isteğe bağlı</small></label><input class="inp" id="sW" maxlength="30" value="${esc(st.who)}" placeholder="Örn. Annem"></div>
      ${whoList.length ? `<div class="fchips">${whoList.map(w => `<button class="chip ${st.who === w ? 'on' : ''}" data-sw="${esc(w)}">${esc(w)}</button>`).join('')}</div>` : ''}
      <div class="fld"><label for="sS">Mağaza <small>isteğe bağlı · çok yerde varsa sadece adı yeter</small></label><input class="inp" id="sS" maxlength="40" value="${esc(st.store)}" placeholder="Örn. Zara"></div>
      ${storeList.length ? `<div class="fchips">${storeList.map(w => `<button class="chip ${st.store === w ? 'on' : ''}" data-ss="${esc(w)}">${esc(w)}</button>`).join('')}</div>` : ''}
      <div class="shloc">${st.sloc ? `<span class="tap" data-sa="lshow">${I('map-pin')} ${esc(st.sloc.label || TX('Konum kayıtlı'))}${shopDist(name, st.sloc) ? ' · ' + esc(shopDist(name, st.sloc)) : ''}</span><button class="btn" data-sa="locdel">${I('x')}</button>` : `<button class="btn" data-sa="lpick">${I('map-pin')} ${TX('Haritada şube seç')}</button><button class="btn" data-sa="loc" title="${TX('Bağlantı yapıştır')}">${I('link')}</button>`}</div>
      <div class="fld"><label for="sO">Not</label><input class="inp" id="sO" maxlength="80" value="${esc(st.note)}" placeholder="Örn. otelin yanındaki şube"></div>
      <div class="row2"><div class="fld" style="flex:2"><label for="sP">Fiyat <small>alınınca masraflara eklenir</small></label><input class="inp" id="sP" inputmode="decimal" value="${esc(st.price)}" placeholder="0"></div><div class="fld" style="flex:1"><label for="sC">&nbsp;</label><select class="inp" id="sC">${[...new Set([st.cur, baseCur(), ...CURS])].map(c => `<option ${c === st.cur ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
      <button class="chip shdone ${st.done ? 'on' : ''}" data-sa="done">${st.done ? I('check') + ' ' : ''}${TX('Satın alındı')}</button>
      <p class="tde" id="sErr"></p>
      <div class="row2">${it ? `<button class="btn dan" data-sa="del">${TX('Sil')}</button>` : `<button class="btn" data-sa="cancel">${TX('Vazgeç')}</button>`}<button class="btn pri" data-sa="ok">${TX('Kaydet')}</button></div></div>`;
    $('#sN', ov).oninput = () => { $('#sErr', ov).textContent = ''; };
  };
  const close = async (saved) => { if (!saved && st.ph && st.ph !== ph0) await delPages([st.ph]); if (!saved && !it && pre.ph && st.ph !== pre.ph) {} ov.remove(); dlgClose = null; S.shopLoc = null; };
  // harita paylaşımı (bağlantı ya da Google Haritalar → Paylaş → DoraGo) açık pencereye eklenir
  const applyLoc = async txt => {
    busy(TX('Konum alınıyor…')); let sh = null; try { sh = await locFromShare(txt, { trip: name, title: st.store || st.name }); } catch (er) { sh = null; } busy(false);
    if (!sh || !sh.ll) { toast(TX('Bu bağlantıda konum bulunamadı.')); return; }
    const url = (String(txt).match(/https?:\/\/\S+/) || [''])[0];
    st.sloc = { lat: +sh.ll.lat, lon: +sh.ll.lon, url: sh.link || url, label: sh.name || (sh.placeText || '').split(',')[0].trim() || '' };
    if (!st.store && st.sloc.label) st.store = st.sloc.label.slice(0, 40);
    draw(); toast(TX('Konum eklendi'), 2500);
  };
  S.shopLoc = txt => { if (!ov.isConnected) { S.shopLoc = null; return false; } keep(); applyLoc(txt); return true; };
  ov.addEventListener('click', async e => {
    const w = e.target.closest('[data-sw]'), s = e.target.closest('[data-ss]'), a = e.target.closest('[data-sa]');
    if (w) { keep(); st.who = st.who === w.dataset.sw ? '' : w.dataset.sw; draw(); return; }
    if (s) { keep(); st.store = st.store === s.dataset.ss ? '' : s.dataset.ss; draw(); return; }
    if (e.target === ov) { await close(false); if (!it && pre.ph) await delPages([pre.ph]); return; }
    if (!a) return;
    const act = a.dataset.sa; keep();
    if (act === 'done') { st.done = !st.done; draw(); }
    else if (act === 'view') { const b = await photoBlob(st.ph); if (b) openLightbox([b]); }
    else if (act === 'ph') { const [f] = await pickFiles('image/*', false); if (!f) return; busy(TX('Fotoğraf ekleniyor…')); try { st.ph = await shopPhotoFrom(f); } finally { busy(false); } draw(); }
    else if (act === 'phdel') { if (st.ph && st.ph !== ph0) await delPages([st.ph]); st.ph = null; draw(); }
    else if (act === 'locdel') { st.sloc = null; draw(); }
    else if (act === 'lshow') showOnMap({ lat: st.sloc.lat, lon: st.sloc.lon, url: st.sloc.url || '', name: st.sloc.label || st.store || TX('Konum'), address: '' });
    else if (act === 'lpick') {
      if (A && !(await metaGet('gmHint'))) {
        const ok = await dialog({ title: TX('Google Haritalar açılıyor'), text: TX('1. Doğru şubeye dokun<br>2. <b>Paylaş</b>\'a bas<br>3. Listeden <b>DoraGo</b>\'yu seç<br><br>Konum otomatik olarak bu ürüne eklenir.'), ok: TX('Tamam, aç'), cancel: TX('Vazgeç') });
        if (!ok) return; await metaSet('gmHint', true);
      }
      openUrl(shopMapUrl(name, st.store || st.name), (mapApps().find(a => a.id === 'google') || {}).pkg || '');
    }
    else if (act === 'loc') {
      const txt = await inputDialog({ title: TX('Mağazanın konumu'), text: TX('Google Haritalar\'da mağazayı aç → Paylaş → Bağlantıyı kopyala, buraya yapıştır.'), placeholder: TX('https://maps.app.goo.gl/… ya da 41.0, 28.9'), ok: TX('Ekle') });
      if (!txt) return;
      await applyLoc(txt);
    }
    else if (act === 'cancel') { await close(false); if (!it && pre.ph && st.ph === pre.ph) await delPages([pre.ph]); }
    else if (act === 'del') {
      if (!await dialog({ title: TL`"${it.name}" silinsin mi?`, ok: TX('Sil'), danger: true })) return;
      r.items = r.items.filter(x => x.id !== it.id); if (it.ph) await delPages([it.ph]); if (st.ph && st.ph !== it.ph) await delPages([st.ph]);
      await saveShop(); ov.remove(); dlgClose = null; render();
    }
    else if (act === 'ok') {
      const nm = (st.name || '').trim(); if (!nm) { $('#sErr', ov).textContent = TX('Ne alınacağını yaz'); $('#sN', ov).focus(); return; }
      const pr = parseAmt(st.price), now = Date.now();
      const rec = { ...(it || { id: 'i' + uid(), createdAt: now }), name: nm, qty: st.qty, who: (st.who || '').trim(), store: (st.store || '').trim(), sloc: st.sloc, ph: st.ph, note: (st.note || '').trim(), done: st.done, doneAt: st.done ? (it && it.doneAt) || now : null, price: pr > 0 ? pr : null, cur: pr > 0 ? st.cur : null, updatedAt: now };
      if (it && it.ph && it.ph !== st.ph) await delPages([it.ph]);
      if (it) r.items = r.items.map(x => x.id === it.id ? rec : x); else r.items.push(rec);
      await saveShop(); ov.remove(); dlgClose = null; if (S.view === 'shop') render(); else openShop(name);
    }
  });
  dlgClose = () => close(false); draw(); noAnimAfter(ov); document.body.appendChild(ov);
  setTimeout(() => { const x = $('#sN', ov); if (x && !it) x.focus(); }, 60);
}
/* paylaşılan fotoğraf: bilet mi, alınacak mı? */
async function sharedImageChoice(file) {
  const today = todayStr(), trips = allTrips().filter(g => !g.past && (!g.e || g.e >= today));
  if (!trips.length) return false;
  const v = await sheetMenu(TX('Bu fotoğraf ne için?'), [{ icon: I('ticket'), label: TX('Bilet olarak ekle'), value: 'ticket' }, { icon: I('shopping-cart'), label: TX('Alınacaklara ekle'), sub: TX('Seyahatte alınacak ürün, hediye'), value: 'shop' }]);
  if (!v) return true;
  if (v === 'ticket') return false;
  let name = trips[0].name;
  if (trips.length > 1) { const n = await sheetMenu(TX('Hangi seyahat?'), trips.slice(0, 8).map(g => ({ icon: I('luggage'), label: g.name, sub: g.a ? fmtRange(g.a, g.e || g.a) : '', value: g.name }))); if (!n) return true; name = n; }
  busy(TX('Fotoğraf ekleniyor…')); await getShop(); let ph = null; try { ph = await shopPhotoFrom(file); } finally { busy(false); } shopDialog(name, null, { ph }); return true;
}
function shopReminders(now) {
  const out = []; if (!SHOP) return out;
  for (const g of allTrips()) {
    const left = shopRec(g.name).items.filter(i => !i.done); if (!left.length || !g.e) continue;
    const when = at(g.e === g.a ? g.e : addDays(g.e, -1), '10:00');
    if (when > now + 30000 && when < now + 400 * 86400000) out.push({ at: when, title: TL`Alınacaklar · ${g.name}`, text: TL`${left.length} ürün alınmadı: ${left.slice(0, 4).map(i => i.name).join(', ')}`, ticket: 'shop:' + g.name, kind: 's' });
  }
  return out;
}

/* ================= 5.9: seyahat PDF'i (A: seyahat defteri) ================= */
/* sayfa = [{w,h,bytes,cs,x,y,dw,dh}] (pt, sol-alt köşe) ya da tek tam sayfa {w,h,bytes} */
function pdfFromJpegs(pages, Wpt = 595.28, Hpt = 841.89) {
  const enc = new TextEncoder(), chunks = [], offs = []; let len = 0, n = 2;
  const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (num, parts) => { offs[num] = len; push(`${num} 0 obj\n`); for (const p of parts) push(p); push('\nendobj\n'); };
  push('%PDF-1.4\n'); push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  const W = Wpt.toFixed(2), H = Hpt.toFixed(2), plan = pages.map(p => { const ims = Array.isArray(p) ? p : [{ ...p, x: 0, y: 0, dw: Wpt, dh: Hpt }]; const pg = ++n, ct = ++n; return { pg, ct, ims: ims.map(im => ({ ...im, id: ++n })) }; });
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Kids [${plan.map(p => `${p.pg} 0 R`).join(' ')}] /Count ${plan.length} >>`]);
  for (const p of plan) {
    const cs = p.ims.map((im, k) => `q ${im.dw.toFixed(2)} 0 0 ${im.dh.toFixed(2)} ${im.x.toFixed(2)} ${im.y.toFixed(2)} cm /I${k} Do Q`).join('\n');
    obj(p.pg, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << ${p.ims.map((im, k) => `/I${k} ${im.id} 0 R`).join(' ')} >> >> /Contents ${p.ct} 0 R >>`]);
    obj(p.ct, [`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`]);
    for (const im of p.ims) obj(im.id, [`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.cs || 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream']);
  }
  const xo = len, total = n + 1;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`; for (let k = 1; k < total; k++) x += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
/* JPEG başlığından gerçek boyut ve renk kanalı (yeniden sıkıştırmadan gömmek için) */
function jpegInfo(u) {
  if (u[0] !== 0xFF || u[1] !== 0xD8) return null;
  for (let i = 2; i + 9 < u.length;) {
    if (u[i] !== 0xFF) { i++; continue; } const m = u[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const L = (u[i + 2] << 8) | u[i + 3];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (u[i + 5] << 8) | u[i + 6], w: (u[i + 7] << 8) | u[i + 8], c: u[i + 9] };
    i += 2 + L;
  }
  return null;
}
function geoFor(ts) {
  const pts = [], cc = new Map();
  for (const t of ts) { const w = ticketWhere(t); if (!w) continue; if (w.lat != null && t.type !== 'ucak') pts.push({ lat: w.lat, lon: w.lon }); if (w.cc && w.cc !== HOME_CC) cc.set(w.cc, 1); }
  const arcs = ts.filter(t => t.type === 'ucak' && t.from && t.to).map(t => [apRec(t.from), apRec(t.to)]).filter(([a, b]) => a && b && a.lat != null && b.lat != null);
  return { pts, arcs, countries: [...cc.keys()].map(c => ({ cc: c, n: 1 })) };
}
/* indir: Android → İndirilenler (parça parça köprü), web → tarayıcı indirmesi */
async function saveDownload(blob, fname, mime) {
  if (A && A.dlBegin) {
    const u8 = new Uint8Array(await blob.arrayBuffer()), CH = 512 * 1024;
    busy(TX('Kaydediliyor…')); A.dlBegin(fname, mime);
    for (let i = 0; i < u8.length; i += CH) { A.dlChunk(B64.enc(u8.subarray(i, i + CH))); if (i % (CH * 4) === 0) await new Promise(r => setTimeout(r)); }
    window.onSaveResult = ok => toast(ok ? 'PDF kaydedildi' : 'PDF kaydedilmedi');
    S.pickAt = Date.now(); A.dlEnd(); return;
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); toast('PDF indirildi');
}
window.onDownload = ok => { busy(false); if (!ok) { toast(TX('Kaydedilemedi')); return; } actToast(TX("İndirilenler'e kaydedildi"), TX('Aç'), () => A && A.openLastDownload && A.openLastDownload()); };
function actToast(msg, label, fn, ms = 7000) {
  document.querySelectorAll('.atoast').forEach(e => e.remove());
  const el = document.createElement('div'); el.className = 'atoast'; el.innerHTML = `<span>${esc(msg)}</span><button>${esc(label)}</button>`;
  el.querySelector('button').onclick = () => { el.remove(); fn(); };
  document.body.appendChild(el); setTimeout(() => el.remove(), ms);
}
async function pdfDialog(name) {
  await getExp();
  const ts = S.tickets.filter(t => t.trip === name), hasPg = ts.some(t => (t.pageIds || []).length), hasEx = expItems(name).length > 0;
  const o = { pages: hasPg, exp: hasEx };
  const ok = await new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    const draw = () => { ov.innerHTML = TL`<div class="dlg sheet"><h3>Seyahat PDF'i</h3><p class="snote" style="margin:0 2px 12px">Kapak, gün gün plan${o.exp ? ', masraflar' : ''}${o.pages ? TX(' ve biletlerin kendi sayfaları') : ''} tek dosyada. Telefonda hazırlanır, ${A ? TX("İndirilenler klasörüne") : 'telefona'} kaydedilir.</p>
      ${hasPg ? TL`<button class="kmw ${o.pages ? 'on' : ''}" data-po="pages"><span class="pcb">${o.pages ? I('check') : ''}</span> Bilet sayfalarını ekle (QR / barkod)</button>` : ''}
      ${hasEx ? TL`<button class="kmw ${o.exp ? 'on' : ''}" data-po="exp"><span class="pcb">${o.exp ? I('check') : ''}</span> Masrafları ekle</button>` : ''}
      <div class="row2" style="margin-top:16px"><button class="btn" data-pa="0">Vazgeç</button><button class="btn pri" data-pa="1">${I('download')} PDF'i indir</button></div></div>`; };
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    ov.addEventListener('click', e => { const t = e.target.closest('[data-po]'), a = e.target.closest('[data-pa]'); if (t) { o[t.dataset.po] = !o[t.dataset.po]; draw(); } else if (a) close(a.dataset.pa === '1'); else if (e.target === ov) close(false); });
    dlgClose = () => close(false); draw(); noAnimAfter(ov); document.body.appendChild(ov);
  });
  if (!ok) return;
  busy(TX('PDF hazırlanıyor…'));
  try {
    o.onProgress = (i, n) => busy(TL`PDF hazırlanıyor… ${i}/${n} sayfa`);
    const blob = await tripPdf(name, o);
    const fname = TL`DoraGo-${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'seyahat'}.pdf`;
    await saveDownload(blob, fname, 'application/pdf'); busy(false);
  } catch (e) { console.error(e); busy(false); toast(TX('PDF hazırlanamadı')); }
}
async function tripPdf(name, o = {}) {
  await loadWorld(); await getTP(); await getExp();
  const C = WRAP_C, W = 1240, H = 1754, PX = 1050, PY = 1485, M = 96, serif = 'Georgia, "Noto Serif", serif', sans = 'system-ui, -apple-system, Roboto, sans-serif';
  const g = allTrips().find(x => x.name === name) || { name }, key = t => (t.date || '9999') + 'T' + (t.time || '99:99');
  const ts = S.tickets.filter(t => t.trip === name).sort((a, b) => key(a) < key(b) ? -1 : 1);
  const out = []; let pgNo = 0;
  const font = (x, w, s, f) => { x.font = `${w} ${s}px ${f}`; };
  const wrap = (x, txt, maxW) => { const L = []; for (const para of String(txt).split('\n')) { let line = ''; for (const w of para.split(/\s+/)) { const t2 = line ? line + ' ' + w : w; if (x.measureText(t2).width > maxW && line) { L.push(line); line = w; } else line = t2; } L.push(line); } return L; };
  const prog = o.onProgress || (() => {});
  const newPage = () => { const cv = document.createElement('canvas'); cv.width = PX; cv.height = PY; const x = cv.getContext('2d'); x.scale(PX / W, PY / H); x.fillStyle = C.cream; x.fillRect(0, 0, W, H); x.textBaseline = 'alphabetic'; out.push(cv); pgNo++; return x; };
  const footer = (x, label) => { x.fillStyle = C.mut; font(x, 500, 20, sans); x.textAlign = 'left'; x.fillText(TL`DoraGo · ${name}${label ? ' · ' + label : ''}`, M, H - 56); x.textAlign = 'right'; x.fillText(String(pgNo), W - M, H - 56); x.textAlign = 'left'; };
  const dash = (x, y) => { x.strokeStyle = C.land; x.lineWidth = 2; x.setLineDash([12, 10]); x.beginPath(); x.moveTo(M, y); x.lineTo(W - M, y); x.stroke(); x.setLineDash([]); };
  /* kapak */
  let x = newPage();
  x.fillStyle = C.acc; font(x, 700, 22, sans); x.letterSpacing = '4px'; x.fillText('DORAGO · SEYAHAT PLANI', M, 120); x.letterSpacing = '0px';
  const cov = await tripCoverBlob(name), geo = geoFor(ts), bx = { x: M, y: 160, w: W - 2 * M, h: 560 };
  if (cov) { const im = await createImageBitmap(cov), sc = Math.max(bx.w / im.width, bx.h / im.height); x.save(); x.beginPath(); x.roundRect ? x.roundRect(bx.x, bx.y, bx.w, bx.h, 22) : x.rect(bx.x, bx.y, bx.w, bx.h); x.clip(); x.drawImage(im, bx.x + (bx.w - im.width * sc) / 2, bx.y + (bx.h - im.height * sc) / 2, im.width * sc, im.height * sc); x.restore(); }
  else wrapMap(x, geo, bx.x, bx.y, bx.w, bx.h, C);
  const K = kindOf(tripKind(name)), days = g.a ? nightsBetween(g.a, g.e || g.a) + 1 : 0;
  x.fillStyle = C.ink; let s = 92; font(x, 500, s, serif); while (x.measureText(name).width > W - 2 * M && s > 48) { s -= 4; font(x, 500, s, serif); } x.fillText(name, M, 840);
  x.fillStyle = C.mut; font(x, 500, 30, sans); x.fillText([g.a ? (g.e && g.e !== g.a ? fmtRange(g.a, g.e) : fmtDate(g.a)) : TX('Tarihsiz'), days ? TL`${days} gün` : '', K ? K.n : ''].filter(Boolean).join(' · '), M, 892);
  dash(x, 940);
  const ci = await tripCountry(name).catch(() => null);
  let cy = 1000; const colL = M, colR = cov ? M + 560 : M;
  if (cov) wrapMap(x, geo, M, 990, 520, 420, C);
  if (ci) {
    const rows = [[TX('Para'), ci.cur ? `${curSymbol(ci.cur) !== ci.cur ? curSymbol(ci.cur) + ' ' : ''}${ci.cur}` : ''], [TX('Priz / voltaj'), ci.plug ? TL`Tip ${ci.plug} · ${ci.volt} V` : ''], [TX('Acil numara'), emTxt(ci.em) || '112'], [TX('Saat'), ci.diffH != null ? diffTxt(ci.diffH) : ''], [TX('Dil'), ci.lang ? langName(ci.lang) : ''], [TX('Trafik'), ci.dr === 'L' ? TX('Soldan akar') : '']].filter(r => r[1]);
    x.fillStyle = C.acc; font(x, 700, 20, sans); x.fillText((ci.country || TX('ÜLKE')).toLocaleUpperCase(LANG), colR, cy); cy += 46;
    for (const [k, v] of rows) { x.fillStyle = C.mut; font(x, 500, 22, sans); x.fillText(k, colR, cy); x.fillStyle = C.ink; font(x, 600, 28, sans); x.fillText(v, colR + (cov ? 0 : 260), cov ? cy + 34 : cy); cy += cov ? 72 : 52; }
  }
  const nT = n => ts.filter(t => t.type === n).length, sm = expItems(name).length ? expSummary(name) : null;
  x.fillStyle = C.mut; font(x, 500, 26, sans);
  x.fillText([TL`${ts.length} bilet`, nT('ucak') && TL`${nT('ucak')} uçuş`, nT('konaklama') && TL`${nT('konaklama')} konaklama`, sm && sm.total ? TL`Masraf ${fmtMoney(sm.total, sm.b)}` : ''].filter(Boolean).join(' · '), M, H - 150);
  font(x, 500, 20, sans); x.fillText(TL`Oluşturuldu: ${fmtDate(todayStr())}`, M, H - 110);
  /* plan */
  x = newPage(); let y = 150;
  const head = () => { x.fillStyle = C.acc; font(x, 700, 20, sans); x.letterSpacing = '4px'; x.fillText('PLAN', M, 100); x.letterSpacing = '0px'; };
  head();
  const need = h => { if (y + h > H - 120) { footer(x, TX('Plan')); x = newPage(); head(); y = 150; } };
  const lines = t => {
    const L = [];
    if (t.type === 'ucak') L.push([(t.title || '').includes('→') ? '' : [apCity(t.from) || t.from, apCity(t.to) || t.to].filter(Boolean).join(' → '), [t.airlineName || (t.airline ? alName(t.airline) : ''), t.flightNo].filter(Boolean).join(' ')].filter(Boolean).join(' · '));
    if (t.type === 'konaklama' && t.endDate) L.push(TL`${nightsBetween(t.date, t.endDate)} gece · çıkış ${fmtDate(t.endDate)}${t.endTime ? ' ' + t.endTime : ''}`);
    const codes = [t.ref && `${t.type === 'ucak' ? 'PNR' : TX('Rez.')} ${t.ref}`, t.seat && TL`Koltuk ${t.seat}`, t.gate && TL`Kapı ${t.gate}`].filter(Boolean).join(' · '); if (codes) L.push(codes);
    if (t.place) L.push(t.place); if (t.notes) L.push(t.notes);
    if (parseAmt(t.priceAmt) > 0) L.push(TL`Fiyat ${fmtMoney(parseAmt(t.priceAmt), (t.priceCur || baseCur()).toUpperCase())}`);
    return L;
  };
  let lastD = null;
  for (const t of ts) {
    const d = t.date || '';
    if (d !== lastD) { need(120); y += lastD === null ? 0 : 30; x.fillStyle = C.ink; font(x, 500, 44, serif); x.fillText(d ? new Date(d + 'T12:00').toLocaleDateString(LOC, { weekday: 'long', day: 'numeric', month: 'long' }) : TX('Gezilecekler · tarihsiz'), M, y + 40); y += 70; lastD = d; }
    font(x, 500, 24, sans); const det = lines(t).flatMap(l => wrap(x, l, W - 2 * M - 170)).slice(0, 8);
    const h = 56 + det.length * 34 + 18; need(h);
    x.fillStyle = typeOf(t.type).col; x.beginPath(); x.arc(M + 10, y + 28, 9, 0, Math.PI * 2); x.fill();
    x.fillStyle = C.ink; font(x, 700, 28, sans); x.fillText(t.time || '', M + 34, y + 38);
    font(x, 600, 32, sans); x.fillText(t.title || typeOf(t.type).n, M + 170, y + 38);
    x.fillStyle = C.mut; font(x, 500, 24, sans); det.forEach((l, i) => x.fillText(l, M + 170, y + 78 + i * 34));
    y += h; x.strokeStyle = C.land; x.lineWidth = 1; x.beginPath(); x.moveTo(M + 170, y - 8); x.lineTo(W - M, y - 8); x.stroke(); y += 8;
  }
  if (!ts.length) { x.fillStyle = C.mut; font(x, 500, 28, sans); x.fillText(TX('Bu seyahatte henüz bilet yok.'), M, y + 40); }
  footer(x, TX('Plan'));
  /* masraflar */
  if (o.exp && expItems(name).length) {
    const sm2 = expSummary(name), b = sm2.b, rec = expRec(name);
    x = newPage(); x.fillStyle = C.acc; font(x, 700, 20, sans); x.letterSpacing = '4px'; x.fillText('MASRAFLAR', M, 100); x.letterSpacing = '0px';
    x.fillStyle = C.ink; font(x, 500, 80, serif); x.fillText(fmtMoney(sm2.total, b), M, 210);
    x.fillStyle = C.mut; font(x, 500, 26, sans); x.fillText([rec.people.length > 1 ? TL`${rec.people.length} kişi · kişi başı ${fmtMoney(sm2.total / rec.people.length, b)}` : '', sm2.days ? TL`günde ${fmtMoney(sm2.total / sm2.days, b)}` : ''].filter(Boolean).join(' · '), M, 256);
    let bx2 = M; const bw = W - 2 * M; for (const c of sm2.byCat) { const w = bw * c.v / sm2.total; x.fillStyle = c.c; x.fillRect(bx2, 290, Math.max(w - 3, 1), 18); bx2 += w; }
    y = 360; font(x, 500, 22, sans); let lx = M; for (const c of sm2.byCat) { const t = `${c.n} ${pct(Math.round(c.v / sm2.total * 100))}`; x.fillStyle = c.c; x.fillRect(lx, y - 14, 14, 14); x.fillStyle = C.ink; x.fillText(t, lx + 22, y); lx += x.measureText(t).width + 56; if (lx > W - M - 200) { lx = M; y += 36; } }
    y += 50;
    const its = expItems(name).slice().sort((p, q) => (p.date || '9') < (q.date || '9') ? -1 : 1);
    const ehead = () => { x.fillStyle = C.acc; font(x, 700, 20, sans); x.letterSpacing = '4px'; x.fillText('MASRAFLAR', M, 100); x.letterSpacing = '0px'; };
    for (const it of its) {
      if (y > H - 170) { footer(x, TX('Masraflar')); x = newPage(); ehead(); y = 160; }
      const c = expCat(it.cat), v = itemBase(it, b);
      x.fillStyle = c.c; x.beginPath(); x.arc(M + 10, y - 9, 9, 0, Math.PI * 2); x.fill();
      x.fillStyle = C.mut; font(x, 500, 22, sans); x.fillText(it.date ? fmtDate(it.date) : '—', M + 34, y);
      x.fillStyle = C.ink; font(x, 600, 26, sans); x.fillText((it.note || c.n).slice(0, 40) + (rec.people.length > 1 ? `  ·  ${it.payer}` : ''), M + 250, y);
      x.textAlign = 'right'; x.fillText(fmtMoney(it.amt, it.cur), W - M, y); if (it.cur !== b) { x.fillStyle = C.mut; font(x, 500, 20, sans); x.fillText(v != null ? '≈ ' + fmtMoney(v, b) : TX('kur yok'), W - M, y + 26); } x.textAlign = 'left';
      y += it.cur !== b ? 66 : 52;
    }
    if (sm2.settle.length) { y += 20; if (y > H - 260) { footer(x, TX('Masraflar')); x = newPage(); ehead(); y = 160; } x.fillStyle = C.ink; font(x, 500, 36, serif); x.fillText(TX('Hesaplaşma'), M, y); y += 50; for (const st of sm2.settle) { font(x, 500, 26, sans); x.fillText(`${st.from} → ${st.to}`, M, y); x.textAlign = 'right'; x.fillText(fmtMoney(st.v, b), W - M, y); x.textAlign = 'left'; y += 44; } }
    footer(x, TX('Masraflar'));
  }
  /* ekler: biletlerin kendi sayfaları — JPEG ise olduğu gibi gömülür */
  const jpg = async cv => { const bl = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86)); return new Uint8Array(await bl.arrayBuffer()); };
  const final = [], att = [];
  if (o.pages) for (const t of ts) { const ids = t.pageIds || []; ids.forEach((id, i) => att.push({ t, id, i, n: ids.length })); }
  const totalP = out.length + att.length; let doneP = 0;
  for (const cv of out) { final.push({ w: PX, h: PY, bytes: await jpg(cv) }); prog(++doneP, totalP); await new Promise(r => setTimeout(r)); }
  const Wpt = 595.28, Hpt = 841.89, k = Wpt / W, hdH = 200;
  for (const a of att) {
    const p = await getOne('pages', a.id); prog(++doneP, totalP); if (!p || !p.blob) continue;
    const hc = document.createElement('canvas'); hc.width = PX; hc.height = Math.round(hdH * PX / W); const hx = hc.getContext('2d'); hx.scale(PX / W, PX / W);
    hx.fillStyle = '#fff'; hx.fillRect(0, 0, W, hdH); hx.fillStyle = C.acc; font(hx, 700, 20, sans); hx.letterSpacing = '4px'; hx.fillText('EK', M, 100); hx.letterSpacing = '0px';
    hx.fillStyle = C.ink; font(hx, 600, 30, sans); hx.fillText(`${a.t.title || typeOf(a.t.type).n}${a.t.date ? ' · ' + fmtDate(a.t.date) : ''}${a.n > 1 ? TL` · sayfa ${a.i + 1}/${a.n}` : ''}`, M, 146);
    let im = null; const u = new Uint8Array(await p.blob.arrayBuffer()), ji = jpegInfo(u);
    if (ji && (ji.c === 3 || ji.c === 1) && ji.w && ji.h) im = { w: ji.w, h: ji.h, bytes: u, cs: ji.c === 1 ? 'DeviceGray' : 'DeviceRGB' };
    else { let bm; try { bm = await createImageBitmap(p.blob); } catch (e) { continue; } const c2 = document.createElement('canvas'); const s2 = Math.min(1, 1600 / Math.max(bm.width, bm.height)); c2.width = Math.round(bm.width * s2); c2.height = Math.round(bm.height * s2); const x2 = c2.getContext('2d'); x2.fillStyle = '#fff'; x2.fillRect(0, 0, c2.width, c2.height); x2.drawImage(bm, 0, 0, c2.width, c2.height); im = { w: c2.width, h: c2.height, bytes: await jpg(c2) }; }
    const aw = (W - 2 * M) * k, ah = (H - hdH - 80) * k, sc = Math.min(aw / im.w, ah / im.h), dw = im.w * sc, dh = im.h * sc;
    final.push([{ w: hc.width, h: hc.height, bytes: await jpg(hc), x: 0, y: Hpt - hdH * k, dw: Wpt, dh: hdH * k }, { ...im, x: M * k + (aw - dw) / 2, y: Hpt - hdH * k - dh, dw, dh }]);
    await new Promise(r => setTimeout(r));
  }
  return pdfFromJpegs(final);

}

/* ================= 5.11: dünya haritam (A+B, karma etiket) ================= */
const ROB_K = [[0.9986, -0.062], [1, 0], [0.9986, 0.062], [0.9954, 0.124], [0.99, 0.186], [0.9822, 0.248], [0.973, 0.31], [0.96, 0.372], [0.9427, 0.434], [0.9216, 0.4958], [0.8962, 0.5571], [0.8679, 0.6176], [0.835, 0.6769], [0.7986, 0.7346], [0.7597, 0.7903], [0.7186, 0.8435], [0.6732, 0.8936], [0.6213, 0.9394], [0.5722, 0.9761], [0.5322, 1]].map(d => [d[0], d[1] * 1.593415793900743]);
function robRaw(l, p) {
  const i = Math.min(18, Math.abs(p) * 36 / Math.PI), i0 = Math.floor(i), di = i - i0;
  const [ax, ay] = ROB_K[i0], [bx, by] = ROB_K[i0 + 1], [cx, cy] = ROB_K[Math.min(19, i0 + 2)];
  return [l * (bx + di * (cx - ax) / 2 + di * di * (cx - 2 * bx + ax) / 2), Math.sign(p) * (by + di * (cy - ay) / 2 + di * di * (cy - 2 * by + ay) / 2)];
}
/* enlem/boylam → harita koordinatı (world.js izdüşümüne göre) */
function wproj(lat, lon, W = window.WORLD) {
  if (!W || W.proj !== 'rob') return [(lon + 180) / 360 * (W ? W.W : 1000), (90 - lat) / 180 * (W ? W.H : 500)];
  const [x, y] = robRaw(lon * Math.PI / 180, lat * Math.PI / 180); return [W.tx + W.k * x, W.ty - W.k * y];
}
const flagOf = cc => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
let WISH = null;
async function getWish() { if (!WISH) WISH = (await metaGet('wish')) || {}; return WISH; }
async function saveWish() { await metaSet('wish', WISH || {}); }
/* ülke durumları: v gidildi (biletlerden ya da elle), p planlandı (gelecek seyahat), w istek */
function worldStatus() {
  const m = new Map();
  for (const t of S.tickets) {
    if (!t.date || !hasEnded(t) || !realised(t)) continue; const w = ticketWhere(t), cc = w && w.cc; if (!cc || cc === HOME_CC) continue;
    const r = m.get(cc) || { s: 'v', auto: 1, trips: new Set(), years: new Set() }; if (t.trip) r.trips.add(t.trip); r.years.add(t.date.slice(0, 4)); m.set(cc, r);
  }
  for (const [cc, w] of Object.entries(WISH || {})) if (w.s === 'v' && !m.has(cc)) m.set(cc, { s: 'v', manual: 1, trips: new Set(), years: new Set(w.y ? [String(w.y)] : []) });
  for (const g of allTrips()) {
    if (g.past) continue;
    for (const cc of tripCCs(g.name)) { const r = m.get(cc); if (r && r.s === 'v') { (r.plan = r.plan || []).push(g.name); continue; } const q = r || { s: 'p', trips: new Set() }; q.s = 'p'; q.trips.add(g.name); m.set(cc, q); }
  }
  for (const [cc, w] of Object.entries(WISH || {})) if (w.s === 'w' && !m.has(cc)) m.set(cc, { s: 'w', at: w.at });
  return m;
}
async function openWorld() {
  busy(TX('Harita yükleniyor…')); await loadWorld(); await getWish(); await getDocs(); await loadVisa(); await loadCInfo(); busy(false);
  S.worldRet = S.view === 'world' ? S.worldRet : S.view; S.wvb = null; S.wDrawer = false; go('world');
}
function renderWorld(app, anim) {
  const W = window.WORLD; if (!W) { go('home', 'back'); return; }
  const M = worldStatus(), cnt = { v: 0, p: 0, w: 0 }; for (const r of M.values()) cnt[r.s]++;
  const tab = S.wTab || (cnt.v ? 'v' : cnt.w ? 'w' : 'v');
  const cls = cc => { const r = M.get(cc); return (r ? 'w' + r.s : '') + (cc === HOME_CC ? ' wh' : ''); };
  const paths = Object.entries(W.c).map(([cc, c]) => c.dot ? '' : `<path data-cc="${cc}" class="${cls(cc)}" d="${c.d}"/>`).join('');
  const dots = Object.entries(W.c).filter(([, c]) => c.dot).map(([cc, c]) => `<g data-cc="${cc}" class="wdot ${cls(cc)}"><circle class="hit" cx="${c.l[0]}" cy="${c.l[1]}" r="6"/><circle class="dt" cx="${c.l[0]}" cy="${c.l[1]}" r="2"/></g>`).join('');
  const list = [...M.entries()].filter(([, r]) => r.s === tab).map(([cc, r]) => ({ cc, r, n: (W.c[cc] || {}).n || W.names[cc] || cc })).sort((a, b) => a.n.localeCompare(b.n, 'tr'));
  const me = person('me') || { pcc: passCC() };
  const ptc = new Set([...M.values()].filter(r => r.s === 'p').flatMap(r => [...(r.trips || [])])).size;
  const sub = (cc, r) => r.s === 'v' ? [r.years && r.years.size ? [...r.years].sort().join(', ') : '', r.manual ? TX('elle işaretli') : r.trips.size ? TL`${r.trips.size} seyahat` : '', r.plan ? TX('yine planlandı') : ''].filter(Boolean).join(' · ')
    : r.s === 'p' ? (r.trips.size > 1 ? TL`${r.trips.size} seyahat` + ' · ' : '') + [...r.trips].join(', ') : reqTxt(visaReq(me.pcc, cc));
  app.innerHTML = TL`<div class="page worldp${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="wsrch"><input class="inp" id="wq" placeholder="Ülke ara…" autocomplete="off"><div class="wres" id="wres"></div></div><button class="icon-btn" id="wHome" aria-label="Tüm dünya">${I('world')}</button></div>
    <div class="wbox" id="wbox"><svg id="wsvg" viewBox="0 0 ${W.W} ${W.H}" preserveAspectRatio="xMidYMid slice"><path class="wsea" d="M0 0H${W.W}V${W.H}H0Z"/><g id="wl">${paths}</g><g id="wdg">${dots}</g><g id="wlab"></g></svg></div>
    <div class="wdrawer ${S.wDrawer ? 'open' : ''}" id="wdr">
      <button class="wdh" id="wdh" aria-label="Listeyi aç/kapa"><i></i></button>
      <div class="wsum"><b>${cnt.v} / 195 ülke</b><span>${cnt.p ? TL`${cnt.p} ülke planlandı (${ptc} seyahat)` + ' · ' : ''}${TL`${cnt.w} istek`}</span><div class="wbar"><i style="width:${cnt.v / 195 * 100}%;background:#C2410C"></i><i style="width:${cnt.p / 195 * 100}%;background:#5DCAA5"></i><i style="width:${cnt.w / 195 * 100}%;background:#9CC5EE"></i></div></div>
      <div class="seg wtabs"><button class="${tab === 'v' ? 'on' : ''}" data-wt="v">Gittim ${cnt.v}<small>ülke</small></button><button class="${tab === 'p' ? 'on' : ''}" data-wt="p">Plan ${cnt.p}<small>ülke</small></button><button class="${tab === 'w' ? 'on' : ''}" data-wt="w">İstek ${cnt.w}<small>ülke</small></button></div>
      <div class="wlist">${list.length ? list.map(({ cc, r, n }) => `<div class="wrow" data-wc="${cc}"><span class="wfl">${flagOf(cc)}</span><span class="ext"><b>${esc(n)}</b><small>${esc(sub(cc, r))}</small></span>${r.s === 'w' ? TL`<button class="wadd" data-wn="${cc}">+ Seyahat</button>` : ''}</div>`).join('') : `<p class="snote" style="padding:14px">${tab === 'w' ? TX('Haritada bir ülkeye dokun, "Gitmek istiyorum" de.') : tab === 'p' ? TX('Gelecek seyahatlerindeki ülkeler burada görünür.') : TX('Gittiğin ülkeler biletlerinden kendiliğinden işaretlenir; eskileri haritadan "Gittim" diye ekleyebilirsin.')}</p>`}</div>
    </div></div>`;
  const svg = $('#wsvg'), box = $('#wbox');
  const asp = () => { const r = svg.getBoundingClientRect(); return r.width / Math.max(r.height, 1) || 1; };
  let vb = S.wvb ? [...S.wvb] : (() => { const h = W.H * 0.95, w = h * asp(); return [Math.min(Math.max(0, 545 - w / 2), W.W - w), W.H * 0.02, w, h]; })();
  const scale = () => { const r = svg.getBoundingClientRect(); return r.width / vb[2]; };
  const clamp = () => { vb[2] = Math.min(W.W * 1.05, Math.max(W.W / 40, vb[2])); vb[3] = vb[2] / asp(); vb[0] = Math.min(W.W - vb[2] * 0.3, Math.max(-vb[2] * 0.7, vb[0])); vb[1] = vb[3] >= W.H ? (W.H - vb[3]) / 2 : Math.min(W.H - vb[3] * 0.6, Math.max(-vb[3] * 0.4, vb[1])); };
  const apply = () => { clamp(); svg.setAttribute('viewBox', vb.map(v => v.toFixed(2)).join(' ')); S.wvb = [...vb]; };
  let labT = null;
  const labels = () => {
    const s = scale(), out = [];
    $$('#wdg .dt').forEach(c => c.setAttribute('r', (4 / s).toFixed(2))); $$('#wdg .hit').forEach(c => c.setAttribute('r', (13 / s).toFixed(2)));
    svg.style.setProperty('--sw', (0.6 / s).toFixed(3)); svg.style.setProperty('--sw2', (1.6 / s).toFixed(3));
    for (const [cc, c] of Object.entries(W.c)) {
      const r = M.get(cc), fl = r && cc !== HOME_CC, nameOk = s > 0.95 && (c.w * s > 46 || (c.dot && s > 2.6)), [x, y] = c.l;
      if (x < vb[0] - 20 || x > vb[0] + vb[2] + 20 || y < vb[1] - 20 || y > vb[1] + vb[3] + 20) continue;
      if (fl) out.push(`<text class="wfg" x="${x}" y="${y}" font-size="${(15 / s).toFixed(2)}">${flagOf(cc)}</text>`);
      if (nameOk) out.push(`<text class="wnm ${r && r.s === 'v' ? 'on' : ''}" x="${x}" y="${(y + (fl ? 13 / s : 0)).toFixed(2)}" font-size="${(10.5 / s).toFixed(2)}" stroke-width="${(2.4 / s).toFixed(2)}">${esc(c.n)}</text>`);
    }
    $('#wlab').innerHTML = out.join('');
  };
  const relabel = () => { clearTimeout(labT); labT = setTimeout(labels, 90); };
  const zoomAt = (f, px, py) => { const r = svg.getBoundingClientRect(), s = scale(), ox = 0, oy = 0; const ux = vb[0] + (px - r.left - ox) / s, uy = vb[1] + (py - r.top - oy) / s; const nw = vb[2] / f; vb = [ux - (ux - vb[0]) / f, uy - (uy - vb[1]) / f, nw, nw / asp()]; apply(); relabel(); };
  window.__wzoom = cc => { const c = W.c[cc]; if (!c) return; const b = c.b, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, bw = Math.max((b[2] - b[0]) * 2.6, (b[3] - b[1]) * 2.6 * asp(), 70); vb = [cx - bw / 2, cy - bw / asp() / 2, bw, bw / asp()]; apply(); labels(); };
  apply(); labels();
  /* hareketler: sürükle, iki parmakla yakınlaş, çift dokun, tekerlek */
  const pts = new Map(); let start = null, moved = false, lastTap = 0;
  svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = false; start = { vb: [...vb], pts: new Map(pts), t: Date.now(), x: e.clientX, y: e.clientY, cc: (e.target.closest && e.target.closest('[data-cc]') || {}).dataset?.cc }; });
  svg.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !start) return; pts.set(e.pointerId, [e.clientX, e.clientY]); const s = scale();
    if (pts.size === 1) { const [x, y] = pts.get(e.pointerId), p0 = start.pts.get(e.pointerId) || [start.x, start.y]; const dx = x - p0[0], dy = y - p0[1]; if (Math.hypot(dx, dy) > 6) moved = true; if (!moved) return; vb = [start.vb[0] - dx / s, start.vb[1] - dy / s, start.vb[2], start.vb[3]]; apply(); }
    else if (pts.size === 2) {
      moved = true; const [a, b] = [...pts.values()], ids = [...pts.keys()], a0 = start.pts.get(ids[0]), b0 = start.pts.get(ids[1]); if (!a0 || !b0) { start = { vb: [...vb], pts: new Map(pts) }; return; }
      const d0 = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]), d1 = Math.hypot(a[0] - b[0], a[1] - b[1]), f = d1 / Math.max(d0, 1);
      const r = svg.getBoundingClientRect(), s0 = r.width / start.vb[2], ox = 0, oy = 0;
      const mx0 = (a0[0] + b0[0]) / 2 - r.left - ox, my0 = (a0[1] + b0[1]) / 2 - r.top - oy, mx1 = (a[0] + b[0]) / 2 - r.left - ox, my1 = (a[1] + b[1]) / 2 - r.top - oy;
      const ux = start.vb[0] + mx0 / s0, uy = start.vb[1] + my0 / s0, nw = Math.min(W.W * 1.05, Math.max(W.W / 40, start.vb[2] / f)), s1 = s0 * start.vb[2] / nw;
      vb = [ux - mx1 / s1, uy - my1 / s1, nw, nw / asp()]; apply();
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId);
    if (pts.size) { start = { vb: [...vb], pts: new Map(pts) }; return; }
    relabel();
    if (!moved && start && Date.now() - start.t < 500) {
      const now = Date.now();
      if (now - lastTap < 300) { zoomAt(2.2, e.clientX, e.clientY); lastTap = 0; clearTimeout(window.__wtapT); return; }
      lastTap = now; const cc = start.cc; window.__wtapT = setTimeout(() => { if (cc) countrySheet(cc); }, 260);
    }
    start = null;
  };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY); }, { passive: false });
  /* arama */
  const wq = $('#wq'), wres = $('#wres'), norm = s => s.toLocaleLowerCase(LANG).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
  wq.oninput = () => { const q = norm(wq.value.trim()); if (!q) { wres.innerHTML = ''; return; } const hits = Object.entries(W.c).map(([cc, c]) => [cc, c.n]).filter(([, n]) => norm(n).includes(q)).sort((a, b) => norm(a[1]).indexOf(q) - norm(b[1]).indexOf(q)).slice(0, 6); wres.innerHTML = hits.map(([cc, n]) => `<button data-sq="${cc}">${flagOf(cc)} ${esc(n)}</button>`).join('') || TX('<p>Bulunamadı</p>'); };
  wres.onclick = e => { const b = e.target.closest('[data-sq]'); if (!b) return; wq.value = ''; wres.innerHTML = ''; wq.blur(); window.__wzoom(b.dataset.sq); countrySheet(b.dataset.sq); };
  $('#wHome').onclick = () => { const h = W.W / asp(); vb = [0, (W.H - h) / 2, W.W, h]; apply(); labels(); };
  $('#back').onclick = () => go(S.worldRet && S.worldRet !== 'world' ? S.worldRet : 'home', 'back');
  /* çekmece */
  const dr = $('#wdr'); $('#wdh').onclick = () => { S.wDrawer = !S.wDrawer; dr.classList.toggle('open', S.wDrawer); };
  let dy0 = null; dr.addEventListener('touchstart', e => { if (e.target.closest('.wlist') && dr.classList.contains('open') && $('.wlist', dr).scrollTop > 0) return; dy0 = e.touches[0].clientY; }, { passive: true });
  dr.addEventListener('touchend', e => { if (dy0 == null) return; const d = e.changedTouches[0].clientY - dy0; dy0 = null; if (d < -40 && !S.wDrawer) { S.wDrawer = true; dr.classList.add('open'); } else if (d > 40 && S.wDrawer) { S.wDrawer = false; dr.classList.remove('open'); } });
  $$('[data-wt]').forEach(b => b.onclick = () => { S.wTab = b.dataset.wt; S.wDrawer = true; render(); });
  $$('[data-wc]').forEach(r => r.onclick = e => { if (e.target.closest('[data-wn]')) return; S.wDrawer = false; dr.classList.remove('open'); window.__wzoom(r.dataset.wc); countrySheet(r.dataset.wc); });
  $$('[data-wn]').forEach(b => b.onclick = () => tripFromCountry(b.dataset.wn));
}
async function tripFromCountry(cc) {
  const W = window.WORLD, n = (W.c[cc] || {}).n || W.names[cc] || cc, y = new Date().getFullYear();
  let sug = `${n} ${y}`; if (allTrips().some(g => g.name === sug)) sug = `${n} ${y + 1}`;
  const name = await newTrip(sug); if (!name) return;
  const r = tripRec(name); if (r) { r.cc = cc; await saveTripRecs(); }
  toast(TL`"${name}" oluşturuldu`); openTrip(name);
}
function countrySheet(cc) {
  const W = window.WORLD, c = W.c[cc] || {}, n = c.n || W.names[cc] || cc, M = worldStatus(), r = M.get(cc), w = (WISH || {})[cc];
  const me = person('me') || { pcc: passCC() }, req = visaReq(me.pcc, cc), ci = (window.CINFO || {})[cc] || {};
  const status = !r ? (cc === HOME_CC ? TX('Ev ülken') : TX('Henüz işaret yok')) : r.s === 'v' ? TL`Gittin${r.years && r.years.size ? ' · ' + [...r.years].sort().join(', ') : ''}${r.trips && r.trips.size ? ' · ' + [...r.trips].slice(0, 3).join(', ') : ''}${r.manual ? TX(' · elle işaretli') : ''}` : r.s === 'p' ? TL`Planlandı · ${[...r.trips].join(', ')}` : TX('İstek listende');
  const planned = r && (r.s === 'p' ? [...r.trips] : r.plan || []);
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = TL`<div class="dlg sheet csheet"><div class="chd"><span class="cfl">${flagOf(cc)}</span><div><h3>${esc(n)}</h3><small>${esc(status)}</small></div></div>
    ${cc !== HOME_CC ? TL`<div class="vrows cinf"><div class="drow"><span class="ext"><b>Vize (${esc(me.name || TX('Ben'))})</b><small>${esc(reqTxt(req))} · genel bilgi</small></span></div>${ci.cur ? TL`<div class="drow"><span class="ext"><b>Para · priz</b><small>${esc(ci.cur)}${ci.plug ? TL` · Tip ${esc(ci.plug)} · ${esc(ci.volt)} V` : ''}</small></span></div>` : ''}</div>` : ''}
    ${planned && planned.length ? planned.map(t => TL`<button class="kmw" data-co="${esc(t)}">${I('luggage')} Seyahati aç: ${esc(t)}</button>`).join('') : ''}
    ${cc !== HOME_CC && !(r && r.s === 'v' && r.auto) ? TL`<button class="kmw ${w && w.s === 'w' ? 'on' : ''}" data-ca="w"><span class="pcb">${w && w.s === 'w' ? I('check') : ''}</span> ★ Gitmek istiyorum</button>
      <button class="kmw ${w && w.s === 'v' ? 'on' : ''}" data-ca="v"><span class="pcb">${w && w.s === 'v' ? I('check') : ''}</span> ✓ Gittim <small style="color:var(--muted)">(biletsiz, eski seyahat)</small></button>` : r && r.auto ? TX('<p class="snote" style="margin:4px 2px 10px">Biletlerinden kendiliğinden işaretlendi.</p>') : ''}
    <div class="row2"><button class="btn" data-ca="x">Kapat</button>${cc !== HOME_CC ? TL`<button class="btn pri" data-ca="t">${I('plus')} Seyahat oluştur</button>` : ''}</div></div>`;
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', async e => {
    const a = e.target.closest('[data-ca]'), o = e.target.closest('[data-co]');
    if (o) { close(); openTrip(o.dataset.co); return; }
    if (!a) { if (e.target === ov) close(); return; }
    const k = a.dataset.ca;
    if (k === 'x') { close(); return; }
    if (k === 't') { close(); tripFromCountry(cc); return; }
    await getWish(); if (WISH[cc] && WISH[cc].s === k) delete WISH[cc]; else WISH[cc] = { s: k, at: Date.now() };
    await saveWish(); close(); if (k === 'w' && WISH[cc]) S.wTab = 'w'; if (k === 'v' && WISH[cc]) S.wTab = 'v'; render();
  });
  dlgClose = close; noAnimAfter(ov); document.body.appendChild(ov);
}

/* ================= 5.10: belgelerim (pasaport + vize) ================= */
const SCHENGEN = new Set('AT BE BG CH CZ DE DK EE ES FI FR GR HR HU IS IT LI LT LU LV MT NL NO PL PT RO SE SI SK'.split(' '));
const VKIND = { visa: TX('Vize'), evisa: 'e-Vize', eta: 'ETA / ESTA', res: TX('Oturum izni') };
const VSTAT = { plan: TX('Planlandı'), appt: TX('Randevu'), applied: TX('Başvuruldu'), ok: TX('Onaylandı'), rej: TX('Reddedildi') };
const REQ_TXT = { free: TX('Vizesiz'), voa: TX('Kapıda vize'), evisa: 'e-Vize gerekli', eta: TX('Elektronik izin (ETA) gerekli'), visa: TX('Vize gerekli'), ban: TX('Giriş kısıtlı'), self: TX('Kendi ülken') };
let VISA_P = null, VISA_IX = null, DOCS = null;
function loadVisa() { if (window.VISA) return Promise.resolve(window.VISA); if (!VISA_P) VISA_P = new Promise(res => { const s = document.createElement('script'); s.src = 'visa.js'; s.onload = () => res(window.VISA || null); s.onerror = () => { VISA_P = null; res(null); }; document.head.appendChild(s); }); return VISA_P; }
function visaReq(pcc, dcc) {
  const V = window.VISA; if (!V || !pcc || !dcc) return null; if (pcc === dcc) return { k: 'self' };
  if (!VISA_IX) { VISA_IX = {}; V.dest.split(',').forEach((c, i) => VISA_IX[c] = i); }
  const s = V.p[pcc], i = VISA_IX[dcc]; if (!s || i == null) return null; const c = s[i], di = 'ABCDEFGHIJKLMNO'.indexOf(c);
  if (di >= 0) return { k: 'free', days: V.days[di] };
  return { k: { f: 'free', a: 'voa', e: 'evisa', t: 'eta', v: 'visa', x: 'ban', '-': 'self' }[c] || null };
}
const reqTxt = r => !r || !r.k ? TX('Bilinmiyor') : r.k === 'free' && r.days ? TL`Vizesiz · ${r.days} gün` : REQ_TXT[r.k];
function migrateDocs(D) {
  let ch = false;
  for (const p of D.people) { if (p.ppage !== undefined) { p.ppages = p.ppage ? [p.ppage] : (p.ppages || []); delete p.ppage; ch = true; } if (!p.ppages) p.ppages = []; }
  const add = [];
  for (const v of D.visas) {
    if (v.page !== undefined) { v.pages = v.page ? [v.page] : (v.pages || []); delete v.page; ch = true; } if (!v.pages) v.pages = [];
    if ((v.people || []).length > 1) { for (const pid of v.people.slice(1)) add.push({ ...JSON.parse(JSON.stringify(v)), id: 'v' + uid(), people: [pid], pages: [], updatedAt: Date.now() }); v.people = [v.people[0]]; ch = true; }
  }
  D.visas.push(...add); return ch;
}
async function getDocs() { if (!DOCS) { DOCS = (await metaGet('docs')) || null; if (DOCS && migrateDocs(DOCS)) await metaSet('docs', DOCS); } if (!DOCS) DOCS = { people: [{ id: 'me', name: TX('Ben'), pcc: passCC(), pexp: '', plast: '', ppages: [] }], visas: [] }; return DOCS; }
async function saveDocs() { await metaSet('docs', DOCS); syncReminders && syncReminders(); }
const person = id => (DOCS && DOCS.people.find(p => p.id === id)) || null;
const regionName = r => r === 'SCH' ? TX('Schengen') : countryName(r);
const regionCode = r => r === 'SCH' ? 'EU' : r;
const fdate = d => d ? new Date(d.slice(0, 10) + 'T12:00').toLocaleDateString(LOC, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const addMonths = (ds, m) => { const [y, mo, d] = ds.split('-').map(Number); return ymd(new Date(y, mo - 1 + m, d)); };
const tripTrav = name => { const r = tripRec(name); return r && r.trav && r.trav.length ? r.trav.filter(id => person(id)) : ['me']; };
function tripCCs(name) {
  const s = new Set(), rc = tripRec(name); if (rc && rc.cc && rc.cc !== HOME_CC) s.add(rc.cc);
  for (const t of S.tickets.filter(t => t.trip === name && t.status !== 'cancel')) { const w = ticketWhere(t), cc = w && w.cc; if (cc && cc !== HOME_CC) s.add(cc); }
  return [...s];
}
function schengenDays(pid, ref, from = null) {
  const days = new Set();
  for (const g of allTrips()) {
    if (!g.a || !tripTrav(g.name).includes(pid)) continue;
    const ts = S.tickets.filter(t => t.trip === g.name); if (ts.length && ts.every(t => t.status === 'cancel' || t.status === 'missed')) continue;
    if (!tripCCs(g.name).some(c => SCHENGEN.has(c))) continue;
    for (let d = g.a; d <= (g.e || g.a); d = addDays(d, 1)) days.add(d);
  }
  const lo = addDays(ref, -179); return [...days].filter(d => d >= lo && d <= ref && (!from || d >= from)).length;
}
function visaCheck(name) {
  const out = []; if (!DOCS) return out;
  const g = allTrips().find(x => x.name === name) || {}, a = g.a, e = g.e || g.a, ccs = tripCCs(name); if (!ccs.length) return out;
  const regions = [...new Set(ccs.map(c => SCHENGEN.has(c) ? 'SCH' : c))];
  for (const pid of tripTrav(name)) {
    const p = person(pid); if (!p) continue; const nm = p.name;
    if (!p.pexp) out.push({ pid, nm, lvl: 'warn', txt: TX('Pasaport bitiş tarihi girilmemiş'), sh: TX('Pasaport tarihi yok'), act: 'pass' });
    else if (e) { const onlySch = regions.every(r => r === 'SCH'), m = onlySch ? 3 : 6; if (p.pexp < e) out.push({ pid, nm, lvl: 'err', txt: TL`Pasaport ${fdate(p.pexp)} tarihinde, seyahatten önce bitiyor`, sh: TX('Pasaport bitiyor!'), act: 'pass' }); else if (p.pexp < addMonths(e, m)) out.push({ pid, nm, lvl: 'warn', txt: TL`Pasaport dönüşten sonra en az ${m} ay geçerli olmalı (bitiş ${fdate(p.pexp)})`, sh: TX('Pasaport süresi kısa'), act: 'pass' }); }
    for (const r of regions) {
      const dcc = r === 'SCH' ? ccs.find(c => SCHENGEN.has(c)) : r, req = visaReq(p.pcc, dcc), lab = regionName(r);
      const vs = DOCS.visas.filter(v => (v.people || []).includes(pid) && (v.region === r || (r !== 'SCH' && v.region === 'SCH' && SCHENGEN.has(r))));
      const cover = v => !a || ((!v.from || v.from <= a) && (!v.to || v.to >= e));
      const ok = vs.find(v => v.status === 'ok' && cover(v)), okLate = vs.find(v => v.status === 'ok' && !cover(v)), pend = vs.find(v => ['plan', 'appt', 'applied'].includes(v.status));
      const base = { pid, nm, region: r, lab };
      if (ok) out.push({ ...base, lvl: 'ok', txt: TL`${lab} ${VKIND[ok.kind] ? VKIND[ok.kind].toLocaleLowerCase(LANG) : TX('vize')}si geçerli`, vid: ok.id, sh: `${lab} ✓` });
      else if (pend) out.push({ ...base, lvl: 'info', txt: `${lab}: ${VSTAT[pend.status]}${pend.status === 'appt' && pend.appt ? ' · ' + fdate(pend.appt.slice(0, 10)) + ' ' + pend.appt.slice(11, 16) : ''}`, vid: pend.id, sh: `${lab} · ${VSTAT[pend.status].toLocaleLowerCase(LANG)}` });
      else if (okLate) out.push({ ...base, lvl: 'warn', txt: TL`${lab} vizesi ${okLate.to ? fdate(okLate.to) : ''} bitiyor, seyahati kapsamıyor`, vid: okLate.id, act: 'visa', sh: `${lab} vizesi bitiyor` });
      else if (!req || !req.k) out.push({ ...base, lvl: 'info', txt: TL`${lab}: vize durumu bilinmiyor, kontrol et`, act: 'visa' });
      else if (req.k === 'free' || req.k === 'self') out.push({ ...base, lvl: 'ok', txt: `${lab}: ${reqTxt(req)}`, sh: reqTxt(req) });
      else if (req.k === 'voa') out.push({ ...base, lvl: 'info', txt: TL`${lab}: kapıda vize` });
      else out.push({ ...base, lvl: req.k === 'visa' || req.k === 'ban' ? 'err' : 'warn', txt: `${lab}: ${reqTxt(req)}`, sh: TL`${reqTxt(req)} · başvur`, act: 'visa' });
      if (r === 'SCH' && e) { const used = schengenDays(pid, e); if (used > 90) out.push({ ...base, lvl: 'err', txt: TL`Schengen 90/180 sınırı aşılıyor (${used} gün)` }); }
    }
  }
  return out;
}
const LV = { err: 3, warn: 2, info: 1, ok: 0 };
const worstOf = list => list.reduce((w, x) => !w || LV[x.lvl] > LV[w.lvl] ? x : w, null);
function docsWarnings() {
  const out = [], today = todayStr(); if (!DOCS) return out;
  for (const p of DOCS.people) { if (p.pexp && p.pexp < today) out.push({ lvl: 'err', pid: p.id, pass: 1, txt: TL`${p.name}: pasaportun süresi dolmuş` }); else if (p.pexp && p.pexp < addMonths(today, 6)) out.push({ lvl: 'warn', pid: p.id, pass: 1, txt: `${p.name}: pasaport ${fdate(p.pexp)} tarihinde bitiyor` }); }
  for (const v of DOCS.visas) { if (v.status === 'appt' && v.appt && v.appt.slice(0, 10) >= today) out.push({ lvl: 'info', txt: `${regionName(v.region)} randevusu: ${fdate(v.appt.slice(0, 10))} ${v.appt.slice(11, 16)}${v.place ? ' · ' + v.place : ''}` }); if (v.status === 'ok' && v.to && v.to >= today && v.to < addDays(today, 60)) out.push({ lvl: 'warn', txt: `${regionName(v.region)} vizesi ${fdate(v.to)} tarihinde bitiyor` }); }
  for (const g of allTrips()) { if (!g.a || g.past) continue; for (const it of visaCheck(g.name)) if (LV[it.lvl] >= 2 && !(it.act === 'pass' && out.some(w => w.pid === it.pid && w.pass))) out.push({ lvl: it.lvl, txt: `${g.name} · ${DOCS.people.length > 1 ? it.nm + ': ' : ''}${it.txt}`, trip: g.name }); }
  return out;
}
async function openDocs() { await getDocs(); await loadVisa(); await loadWorld(); S.docPid = null; go('docs'); }
function stampHtml(code, col) { return `<span class="dstamp" style="--c:${col}">${esc(code)}</span>`; }
function passBadge(p) { const t = todayStr(); if (!p.pexp) return TX('<span class="dbd wn">Tarih yok</span>'); if (p.pexp < t) return TX('<span class="dbd er">Bitti</span>'); if (p.pexp < addMonths(t, 6)) return TX('<span class="dbd wn">6 ay</span>'); return `<span class="dbd ok">${I('check')}</span>`; }
function visaRow(v) {
  const st = v.status === 'ok' ? (v.to && v.to < todayStr() ? ['er', TX('Bitti')] : ['ok', TX('Geçerli')]) : v.status === 'rej' ? ['er', VSTAT.rej] : ['wn', VSTAT[v.status]];
  const who = (v.people || []).map(id => (person(id) || {}).name).filter(Boolean).join(', ');
  const sub = v.status === 'ok' ? [v.from && v.to ? `${fdate(v.from)} – ${fdate(v.to)}` : v.to ? TL`Bitiş ${fdate(v.to)}` : '', v.stay ? TL`${v.stay} gün` : ''] : [v.status === 'appt' && v.appt ? `${fdate(v.appt.slice(0, 10))} ${v.appt.slice(11, 16)}${v.place ? ' · ' + v.place : ''}` : ''];
  return `<button class="drow" data-vid="${esc(v.id)}">${stampHtml(regionCode(v.region), v.region === 'SCH' ? '#185FA5' : '#0F6E56')}<span class="ext"><b>${esc(regionName(v.region))}${DOCS.people.length > 1 ? ' · ' + esc(who) : ''}</b><small>${esc([v.kind && v.kind !== 'visa' ? VKIND[v.kind] : '', v.entry === 'multi' ? TX('çok giriş') : v.entry === 'single' ? TX('tek giriş') : '', ...sub, (v.pages || []).length ? `${v.pages.length} ek` : ''].filter(Boolean).join(' · '))}</small></span><span class="dbd ${st[0]}">${esc(st[1])}</span></button>`;
}
function schBar(pid) { const used = schengenDays(pid, todayStr()), left = Math.max(0, 90 - used); return TL`<div class="dsch"><div class="dsb"><i style="width:${Math.min(100, used / 90 * 100)}%"></i></div><small>Son 180 günde ${used} gün Schengen'de · <b>${left} gün kaldı</b></small></div>`; }
function renderDocs(app, anim) {
  const pid = S.docPid, me = pid && person(pid);
  if (S.view === 'docs' && pid && !me) S.docPid = null;
  const warns = docsWarnings();
  let body = '';
  if (me) {
    const vs = DOCS.visas.filter(v => (v.people || []).includes(me.id));
    body = TL`<button class="dpass" id="dPass"><small>${esc(countryName(me.pcc).toLocaleUpperCase(LANG))} · PASAPORT</small><b>${me.plast ? '···· ' + esc(me.plast) : esc(me.name)}</b><span>${me.pexp ? TL`Bitiş ${fdate(me.pexp)}` : TX('Bitiş tarihini ekle')}</span>${(me.ppages || []).length ? I('paperclip') : ''}</button>
      <div class="exsec">Vizeler</div>${vs.length ? `<div class="vrows">${vs.map(visaRow).join('')}</div>` : TX('<p class="snote">Bu kişi için vize kaydı yok.</p>')}
      <div class="exsec">Schengen 90/180</div><div class="vrows" style="padding:12px">${schBar(me.id)}</div>
      ${me.id !== 'me' ? TX('<button class="btn dan" id="dDelP" style="width:100%;margin-top:16px">Kişiyi sil</button>') : ''}`;
  } else {
    const sch = DOCS.people.filter(p => DOCS.visas.some(v => v.region === 'SCH' && (v.people || []).includes(p.id)) || schengenDays(p.id, todayStr()) > 0);
    body = TL`${warns.length ? `<div class="dwarn">${warns.slice(0, 6).map(w => `<p class="${w.lvl}">${I(w.lvl === 'info' ? 'calendar-event' : 'alert-triangle')}<span>${esc(w.txt)}</span></p>`).join('')}</div>` : ''}
      <div class="exsec">Pasaportlar</div><div class="vrows">${DOCS.people.map(p => `<button class="drow" data-pid="${esc(p.id)}">${stampHtml(p.pcc || '?', '#7A1F1F')}<span class="ext"><b>${esc(p.name)}</b><small>${p.pexp ? TX('Bitiş ') + fdate(p.pexp) : TX('Bitiş tarihi yok')}${p.plast ? ' · ···· ' + esc(p.plast) : ''}</small></span>${passBadge(p)}</button>`).join('')}<button class="drow add" id="dAddP">${I('user-plus')}<span class="ext"><b>Kişi ekle</b></span></button></div>
      <div class="exsec">Vizeler</div>${DOCS.visas.length ? `<div class="vrows">${DOCS.visas.slice().sort((x, y) => (y.to || '') < (x.to || '') ? -1 : 1).map(visaRow).join('')}</div>` : TX('<p class="snote">Henüz vize kaydı yok.</p>')}
      ${sch.length ? TL`<div class="exsec">Schengen 90/180</div><div class="vrows" style="padding:12px">${sch.map(p => `${DOCS.people.length > 1 ? `<b class="dschn">${esc(p.name)}</b>` : ''}${schBar(p.id)}`).join('')}</div>` : ''}
      <button class="tmini dlook" id="dLook">${I('world')}<span><small>Vize gerekiyor mu?</small><b>Ülkeye göre bak</b></span></button>
      <p class="snote">Vize bilgisi genel bilgidir (Passport Index açık verisi); kurallar değişebilir, seyahatten önce resmi kaynaktan kontrol et.</p>`;
  }
  app.innerHTML = TL`<div class="page docsp${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><div class="vt"><b>${me ? esc(me.name) : TX('Belgelerim')}</b><small>${me ? TX('Pasaport ve vizeler') : TX('Pasaport · vize · Schengen')}</small></div></div>
    <div class="sbody">${body}</div>
    <button class="fab exfab" id="dAdd" aria-label="Vize ekle">${I('plus')}</button></div>`;
  $('#back').onclick = () => { if (me) { S.docPid = null; render(); } else go('home', 'back'); };
  $$('[data-pid]').forEach(b => b.onclick = () => { S.docPid = b.dataset.pid; render(); window.scrollTo(0, 0); });
  $$('[data-vid]').forEach(b => b.onclick = () => visaDialog(DOCS.visas.find(v => v.id === b.dataset.vid)));
  const on = (id, f) => { const e = $('#' + id); if (e) e.onclick = f; };
  on('dAddP', () => personDialog(null)); on('dPass', () => personDialog(me)); on('dLook', () => visaLookup());
  on('dAdd', () => visaDialog(null, me ? { people: [me.id] } : {}));
  on('dDelP', async () => { if (!await dialog({ title: TL`${me.name} silinsin mi?`, text: TX('Pasaport bilgisi silinir; vizelerden de çıkarılır.'), ok: TX('Sil'), danger: true })) return; DOCS.people = DOCS.people.filter(p => p.id !== me.id); for (const v of DOCS.visas) v.people = (v.people || []).filter(x => x !== me.id); DOCS.visas = DOCS.visas.filter(v => v.people.length); await delPages(me.ppages || []); S.docPid = null; await saveDocs(); render(); });
}
/* belge ekleri: fotoğraf ya da PDF (sayfalar görüntüye çevrilir), çoklu, silinebilir */
async function docAttach() {
  const files = await pickFiles('image/*,application/pdf', true); if (!files.length) return [];
  try {
    const r = await filesToPages(files); busy(TX('Kaydediliyor…'));
    const list = (r.pages || []).map(p => ({ id: 'dc_' + uid(), w: p.w, h: p.h, blob: p.blob }));
    if (list.length) await putPages(list); busy(false);
    for (const p of list) PHB.set(p.id, p.blob);
    return list.map(p => p.id);
  } catch (e) { console.error(e); busy(false); toast(TX('Eklenemedi')); return []; }
}
async function attBlobs(ids) { for (const id of ids) if (!PHB.has(id)) { const p = await getOne('pages', id); if (p) PHB.set(id, p.blob); } }
function attHtml(ids, label) {
  return TL`<div class="fld"><label>${esc(label)}${ids.length ? ` (${ids.length})` : ''}</label><div class="pgrid datt">${ids.map((id, i) => TL`<div class="pg" data-av="${i}" style="background-image:url('${PHB.get(id) ? blobURL('dc:' + id, PHB.get(id)) : ''}')"><button class="x" data-ax="${i}" aria-label="Eki sil">${I('x')}</button><span class="n">${i + 1}</span></div>`).join('')}<button class="pg add" data-aa="1">＋<br>Fotoğraf / PDF</button></div></div>`;
}
/* diyalog için ek durumu: eklenenler iptalde, çıkarılanlar kayıtta silinir */
function attState(ids) { return { ids: [...(ids || [])], added: [], removed: [] }; }
async function attClick(e, A, redraw) {
  const ax = e.target.closest('[data-ax]'), av = e.target.closest('[data-av]'), aa = e.target.closest('[data-aa]');
  if (ax) { const id = A.ids[+ax.dataset.ax]; A.ids = A.ids.filter(x => x !== id); if (A.added.includes(id)) { A.added = A.added.filter(x => x !== id); await delPages([id]); } else A.removed.push(id); redraw(); return true; }
  if (av) { openLightbox(A.ids.map(id => PHB.get(id)).filter(Boolean), +av.dataset.av); return true; }
  if (aa) { const n = await docAttach(); A.ids.push(...n); A.added.push(...n); redraw(); return true; }
  return false;
}
function ccOptions(sel, withSch) {
  const V = window.VISA, codes = V ? V.dest.split(',') : Object.keys(window.CINFO || {});
  const list = codes.map(c => [c, countryName(c)]).sort((x, y) => x[1].localeCompare(y[1], LANG));
  return (withSch ? TL`<option value="SCH" ${sel === 'SCH' ? 'selected' : ''}>Schengen bölgesi</option>` : '') + list.map(([c, n]) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function personDialog(p) {
  const st = p ? { ...p } : { id: 'p' + uid(), name: '', pcc: passCC(), pexp: '', plast: '', ppages: [] }, AT = attState(st.ppages);
  const ov = document.createElement('div'); ov.className = 'ov';
  const draw = () => {
    ov.innerHTML = TL`<div class="dlg sheet ddlg"><h3>${p ? (p.id === 'me' ? TX('Pasaportum') : TX('Kişiyi düzenle')) : TX('Kişi ekle')}</h3>
      <div class="fld"><label for="pName">Ad</label><input class="inp" id="pName" maxlength="30" placeholder="Örn. Ayşe" value="${esc(st.name)}"></div>
      <div class="fld"><label for="pCc">Pasaportun ülkesi</label><select class="inp" id="pCc">${ccOptions(st.pcc)}</select></div>
      <div class="row2"><div class="fld"><label for="pExp">Bitiş tarihi</label><input class="inp" type="date" id="pExp" value="${esc(st.pexp)}"></div><div class="fld"><label for="pLast">No · son 4 hane</label><input class="inp code" id="pLast" maxlength="4" placeholder="isteğe bağlı" value="${esc(st.plast)}"></div></div>
      ${attHtml(AT.ids, TX('Pasaport sayfası'))}
      <p class="tde" id="pErr"></p><div class="row2"><button class="btn" data-pa="0">Vazgeç</button><button class="btn pri" data-pa="1">Kaydet</button></div></div>`;
  };
  const keep = () => { st.name = $('#pName', ov).value.trim(); st.pcc = $('#pCc', ov).value; st.pexp = $('#pExp', ov).value; st.plast = $('#pLast', ov).value.trim(); };
  const close = async ok => { ov.remove(); dlgClose = null; if (!ok && AT.added.length) await delPages(AT.added); };
  ov.addEventListener('click', async e => {
    if (await attClick(e, AT, () => { keep(); draw(); })) return;
    const a = e.target.closest('[data-pa]'); if (!a) { if (e.target === ov) close(); return; }
    if (a.dataset.pa === '0') { close(); return; }
    keep(); if (!st.name) { $('#pErr', ov).textContent = TX('Adı yaz'); return; }
    st.ppages = AT.ids; if (AT.removed.length) await delPages(AT.removed);
    st.updatedAt = Date.now(); if (p) Object.assign(p, st); else DOCS.people.push(st);
    await saveDocs(); close(true); render();
  });
  dlgClose = () => close(); attBlobs(AT.ids).then(() => { draw(); noAnimAfter(ov); document.body.appendChild(ov); });
}
function visaDialog(v, preset = {}) {
  const st = v ? JSON.parse(JSON.stringify(v)) : { id: 'v' + uid(), region: preset.region || 'SCH', kind: 'visa', entry: 'multi', from: '', to: '', stay: preset.region && preset.region !== 'SCH' ? '' : 90, status: 'plan', appt: '', place: '', people: [(preset.people || ['me'])[0]], pages: [], note: '' };
  const AT = attState(st.pages);
  const ov = document.createElement('div'); ov.className = 'ov';
  const chips = (key, map) => `<div class="fchips">${Object.entries(map).map(([k, n]) => `<button class="chip ${st[key] === k ? 'on' : ''}" data-ck="${key}" data-cv="${k}">${n}</button>`).join('')}</div>`;
  const draw = () => {
    const req = visaReq((person(st.people[0]) || {}).pcc || passCC(), st.region === 'SCH' ? 'DE' : st.region);
    ov.innerHTML = TL`<div class="dlg sheet ddlg"><h3>${v ? TX('Vizeyi düzenle') : TX('Vize ekle')}</h3>
      <div class="fld"><label for="vReg">Ülke / bölge</label><select class="inp" id="vReg">${ccOptions(st.region, true)}</select><div class="sub">${req ? esc(reqTxt(req)) + TX(' (genel bilgi)') : ''}</div></div>
      <div class="fsec"><small>Tür</small>${chips('kind', VKIND)}</div>
      <div class="fsec"><small>Giriş</small>${chips('entry', { single: TX('Tek'), multi: TX('Çok') })}</div>
      <div class="fsec"><small>Durum</small>${chips('status', VSTAT)}</div>
      ${st.status === 'appt' ? TL`<div class="row2"><div class="fld"><label for="vAppt">Randevu</label><input class="inp" type="datetime-local" id="vAppt" value="${esc(st.appt)}"></div><div class="fld"><label for="vPlace">Yer</label><input class="inp" id="vPlace" maxlength="40" placeholder="Örn. VFS Global" value="${esc(st.place)}"></div></div>` : ''}
      <div class="row2"><div class="fld"><label for="vFrom">Geçerlilik başı</label><input class="inp" type="date" id="vFrom" value="${esc(st.from)}"></div><div class="fld"><label for="vTo">Bitiş</label><input class="inp" type="date" id="vTo" value="${esc(st.to)}"></div></div>
      <div class="fld"><label for="vStay">Kalış hakkı (gün, isteğe bağlı)</label><input class="inp" id="vStay" inputmode="numeric" maxlength="3" value="${esc(st.stay)}"></div>
      ${DOCS.people.length > 1 ? TL`<div class="fsec"><small>Kimin vizesi</small><div class="fchips">${DOCS.people.map(p => `<button class="chip ${st.people[0] === p.id ? 'on' : ''}" data-vp="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div></div>` : ''}
      <div class="fld"><label for="vNote">Not</label><input class="inp" id="vNote" maxlength="80" placeholder="Örn. başvuru no" value="${esc(st.note)}"></div>
      ${attHtml(AT.ids, TX('Vize sayfası / e-vize'))}
      <p class="tde" id="vErr"></p>
      <div class="row2">${v ? TX('<button class="btn dan" data-va="del">Sil</button>') : TX('<button class="btn" data-va="0">Vazgeç</button>')}<button class="btn pri" data-va="1">Kaydet</button></div></div>`;
    $('#vReg', ov).onchange = e => { keep(); st.region = e.target.value; if (st.region === 'SCH' && !st.stay) st.stay = 90; draw(); };
  };
  const keep = () => { const g = id => { const e = $('#' + id, ov); return e ? e.value.trim() : null; }; st.from = g('vFrom') ?? st.from; st.to = g('vTo') ?? st.to; st.stay = g('vStay') ?? st.stay; st.note = g('vNote') ?? st.note; if ($('#vAppt', ov)) { st.appt = g('vAppt'); st.place = g('vPlace'); } };
  const close = async ok => { ov.remove(); dlgClose = null; if (!ok && AT.added.length) await delPages(AT.added); };
  ov.addEventListener('click', async e => {
    if (await attClick(e, AT, () => { keep(); draw(); })) return;
    const c = e.target.closest('[data-ck]'), p = e.target.closest('[data-vp]'), a = e.target.closest('[data-va]');
    if (c) { keep(); st[c.dataset.ck] = c.dataset.cv; draw(); return; }
    if (p) { keep(); st.people = [p.dataset.vp]; draw(); return; }
    if (!a) { if (e.target === ov) close(); return; }
    if (a.dataset.va === '0') { close(); return; }
    if (a.dataset.va === 'del') { if (!await dialog({ title: TX('Vize kaydı silinsin mi?'), ok: TX('Sil'), danger: true })) return; DOCS.visas = DOCS.visas.filter(x => x.id !== v.id); await delPages([...(v.pages || []), ...AT.added]); await saveDocs(); close(true); render(); return; }
    keep(); const err = $('#vErr', ov);
    if (!st.people.length) { err.textContent = TX('En az bir kişi seç'); return; }
    if (st.from && st.to && st.to < st.from) { err.textContent = TX('Bitiş başlangıçtan önce olamaz'); return; }
    if (st.status === 'ok' && !st.to) { err.textContent = TX('Onaylı vize için bitiş tarihini yaz'); return; }
    st.stay = st.stay ? +st.stay || '' : ''; st.updatedAt = Date.now(); st.pages = AT.ids; if (AT.removed.length) await delPages(AT.removed);
    if (v) Object.assign(v, st); else DOCS.visas.push(st);
    await saveDocs(); close(true); render();
  });
  dlgClose = () => close(); attBlobs(AT.ids).then(() => { draw(); noAnimAfter(ov); document.body.appendChild(ov); });
}
async function visaLookup() {
  await loadVisa(); await loadWorld();
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = TL`<div class="dlg sheet ddlg"><h3>Vize gerekiyor mu?</h3><div class="fld"><select class="inp" id="lkC"><option value="">Ülke seç…</option>${ccOptions('')}</select></div><div id="lkR"></div>
    <p class="snote" style="margin:10px 2px">Genel bilgidir; kurallar değişebilir. Resmi kaynaktan (konsolosluk, Dışişleri) kontrol et.</p><div class="row2"><button class="btn" data-lk="x">Kapat</button></div></div>`;
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', e => { if (e.target.closest('[data-lk]') || e.target === ov) close(); });
  $('#lkC', ov).onchange = e => { const cc = e.target.value; $('#lkR', ov).innerHTML = cc ? `<div class="vrows">${DOCS.people.map(p => { const r = visaReq(p.pcc, cc) || (SCHENGEN.has(cc) && p.pcc && SCHENGEN.has(p.pcc) ? { k: 'free' } : null); return `<div class="drow">${stampHtml(p.pcc, '#7A1F1F')}<span class="ext"><b>${esc(p.name)}</b><small>${esc(countryName(p.pcc))} pasaportu</small></span><span class="dbd ${!r ? 'wn' : r.k === 'free' || r.k === 'self' ? 'ok' : r.k === 'voa' ? 'wn' : 'er'}">${esc(reqTxt(r))}</span></div>`; }).join('')}</div>${SCHENGEN.has(cc) ? TX('<p class="snote" style="margin:8px 2px 0">Schengen ülkesi: tek vize tüm bölgede geçer, 180 günde en fazla 90 gün.</p>') : ''}` : ''; };
  dlgClose = close; document.body.appendChild(ov);
}
async function tripVisaSheet(name) {
  await getDocs(); await loadVisa(); await loadWorld();
  const ov = document.createElement('div'); ov.className = 'ov';
  const draw = () => {
    const list = visaCheck(name), trav = tripTrav(name);
    ov.innerHTML = TL`<div class="dlg sheet ddlg"><h3>Vize · ${esc(name)}</h3>
      ${DOCS.people.length > 1 ? TL`<div class="fsec"><small>Kim gidiyor</small><div class="fchips">${DOCS.people.map(p => `<button class="chip ${trav.includes(p.id) ? 'on' : ''}" data-tv="${esc(p.id)}">${trav.includes(p.id) ? I('check') + ' ' : ''}${esc(p.name)}</button>`).join('')}</div></div>` : ''}
      <div class="vrows">${list.map((it, i) => `<button class="drow" data-ti="${i}"><span class="dlv ${it.lvl}">${I(it.lvl === 'ok' ? 'check' : it.lvl === 'info' ? 'info-circle' : 'alert-triangle')}</span><span class="ext"><b style="white-space:normal">${esc(it.txt)}</b>${DOCS.people.length > 1 ? `<small>${esc(it.nm)}</small>` : ''}</span>${it.act ? `<i class="pfgo">›</i>` : ''}</button>`).join('') || TX('<p class="snote" style="padding:12px">Yurt dışı durak bulunamadı.</p>')}</div>
      <p class="snote" style="margin:10px 2px">Vize bilgisi genel bilgidir; resmi kaynaktan kontrol et.</p>
      <div class="row2"><button class="btn" data-tx="docs">Belgelerim</button><button class="btn pri" data-tx="x">Tamam</button></div></div>`;
  };
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', async e => {
    const tv = e.target.closest('[data-tv]'), ti = e.target.closest('[data-ti]'), tx = e.target.closest('[data-tx]');
    if (tv) { const r = tripRec(name) || (await setTripKind(name, tripKind(name)), tripRec(name)); const cur = tripTrav(name), id = tv.dataset.tv; r.trav = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]; if (!r.trav.length) r.trav = [id]; await saveTripRecs(); draw(); }
    else if (ti) { const it = visaCheck(name)[+ti.dataset.ti]; if (!it) return; if (it.vid) { close(); visaDialog(DOCS.visas.find(v => v.id === it.vid)); } else if (it.act === 'visa') { close(); const g = allTrips().find(x => x.name === name) || {}; visaDialog(null, { region: it.region, people: [it.pid] }); } else if (it.act === 'pass') { close(); personDialog(person(it.pid)); } }
    else if (tx) { close(); if (tx.dataset.tx === 'docs') openDocs(); else render(); }
    else if (e.target === ov) { close(); render(); }
  });
  dlgClose = () => { close(); render(); }; draw(); noAnimAfter(ov); document.body.appendChild(ov);
}
/* uçuş kontrolündeki pasaport satırı için kısa vize özeti */
function pfVisaTxt(t) {
  if (!DOCS || !t.trip) return null; const list = visaCheck(t.trip).filter(x => x.pid === 'me'); if (!list.length) return null;
  const w = worstOf(list), vw = worstOf(list.filter(x => x.region)); return { txt: w.txt, bad: !!vw && LV[vw.lvl] >= 2 };
}
function docsReminders(now) {
  const out = []; if (!DOCS) return out;
  const add = (when, title, text) => { if (when > now + 30000 && when < now + 400 * 86400000) out.push({ at: when, title, text, ticket: 'docs', kind: 'v' }); };
  const nine = d => at(d, '09:00');
  for (const p of DOCS.people) if (p.pexp) { add(nine(addMonths(p.pexp, -6)), TX('Pasaport 6 ay sonra bitiyor'), TL`${p.name}: birçok ülke 6 ay geçerlilik ister`); add(nine(addDays(p.pexp, -60)), TX('Pasaport bitiyor'), `${p.name}: ${fdate(p.pexp)}`); }
  for (const v of DOCS.visas) {
    const lab = regionName(v.region);
    if (v.status === 'ok' && v.to) { add(nine(addDays(v.to, -60)), TL`${lab} vizesi 2 ay sonra bitiyor`, fdate(v.to)); add(nine(addDays(v.to, -14)), `${lab} vizesi bitiyor`, fdate(v.to)); }
    if (v.status === 'appt' && v.appt && v.appt.length >= 16) { const t = at(v.appt.slice(0, 10), v.appt.slice(11, 16)); add(t - 86400000, TL`Yarın ${lab} vize randevun var`, TL`${v.appt.slice(11, 16)}${v.place ? ' · ' + v.place : ''} · belgelerini hazırla`); add(t - 2 * 3600000, TL`${lab} vize randevusu`, `${v.appt.slice(11, 16)}${v.place ? ' · ' + v.place : ''}`); }
  }
  for (const g of allTrips()) { if (!g.a || g.past) continue; const need = visaCheck(g.name).find(x => x.act === 'visa' && LV[x.lvl] >= 2); if (need) add(nine(addDays(g.a, -60)), TX('Vize başvuru zamanı'), `${g.name}: ${need.txt}`); }
  return out;
}

document.addEventListener('focusin', e => { const el = e.target; if (el && el.closest && el.closest('.dlg') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (er) {} }, 320); });
function noAnimAfter(ov) {
  setTimeout(() => ov.classList.add('noanim'), 450);
  /* yeniden çizimde kaydırma yeri korunur */
  let st = 0; ov.addEventListener('scroll', e => { if (e.target.classList && e.target.classList.contains('dlg')) st = e.target.scrollTop; }, true);
  new MutationObserver(() => { const d = ov.querySelector('.dlg'); if (d && st && d.scrollTop !== st) d.scrollTop = st; }).observe(ov, { childList: true });
}
/* ================= 5.8: seyahat tipleri ================= */
const TRIP_KINDS = [
  { k: 'gezi', n: TX('Gezi'), ic: 'map-2', c: '#C2410C', s: TX('Şehir, kültür') },
  { k: 'tatil', n: TX('Tatil'), ic: 'beach', c: '#0E8A94', s: TX('Deniz, dinlenme') },
  { k: 'is', n: TX('İş seyahati'), ic: 'briefcase', c: '#1E3A8A', s: TX('Toplantı, fuar, konferans') },
  { k: 'aile', n: TX('Aile / ziyaret'), ic: 'home-heart', c: '#3B6D11', s: TX('Akraba, arkadaş') },
  { k: 'etkinlik', n: TX('Etkinlik'), ic: 'ticket', c: '#7C3AED', s: TX('Konser, maç, düğün, festival') },
  { k: 'doga', n: TX('Doğa / macera'), ic: 'mountain', c: '#5B6B2A', s: TX('Kamp, kayak, yürüyüş') },
];
const kindOf = k => TRIP_KINDS.find(x => x.k === k) || null;
const tripKind = name => ((tripRec(name) || {}).kind) || '';
async function setTripKind(name, k) {
  S.trips = S.trips || []; let r = tripRec(name);
  if (!r) { r = { name, a: '', e: '', createdAt: Date.now() }; S.trips.push(r); }
  if (k) r.kind = k; else delete r.kind;
  await saveTripRecs();
}
/* biletlerden tip tahmini (yalnızca öneri) */
function guessKind(name) {
  const ts = S.tickets.filter(t => t.trip === name); if (!ts.length) return '';
  const n = ty => ts.filter(t => t.type === ty).length;
  if (n('etkinlik') && n('etkinlik') >= n('muze')) return 'etkinlik';
  if (n('muze') + n('gezi') >= 2) return 'gezi';
  const g = allTrips().find(x => x.name === name) || {}, d = (typeof tripDest === 'function' && tripDest(name)) || null, m = g.a ? +g.a.slice(5, 7) : 0;
  if (d && d.lat != null && Math.abs(d.lat) < 42 && m >= 6 && m <= 9 && n('konaklama')) return 'tatil';
  return n('muze') || n('yemek') ? 'gezi' : '';
}
function kindChips(cur, guess) {
  return `<div class="tkinds">${TRIP_KINDS.map(k => `<button type="button" class="tkc ${cur === k.k ? 'on' : ''} ${guess === k.k && cur !== k.k ? 'sug' : ''}" data-tk="${k.k}" style="--kc:${k.c}">${I(k.ic)}<span>${k.n}</span></button>`).join('')}</div>`;
}
async function pickTripKind(name) {
  const cur = tripKind(name), guess = guessKind(name);
  const v = await sheetMenu(TL`"${name}" ne tür bir seyahat?`, [
    ...TRIP_KINDS.map(k => ({ icon: dot(k.ic, k.c), label: k.n + (cur === k.k ? ' ✓' : ''), sub: k.s + (guess === k.k && cur !== k.k ? TX(' · önerilen') : ''), value: k.k })),
    ...(cur ? [{ icon: I('x'), label: TX('Tipi kaldır'), value: '-' }] : []),
  ]); if (!v) return;
  await setTripKind(name, v === '-' ? '' : v); render();
}
const KIND_PACK = {
  is: [[TX('Giysi'), TX('Takım elbise / gömlek')], [TX('Elektronik'), TX('Laptop ve şarjı')], [TX('Elektronik'), TX('Sunum adaptörü (HDMI / USB-C)')], [TX('Belgeler'), TX('Kartvizit')], [TX('Belgeler'), TX('Toplantı notları / davet yazısı')]],
  tatil: [[TX('Giysi'), TX('Mayo')], [TX('Diğer'), TX('Güneş kremi')], [TX('Diğer'), TX('Şapka')], [TX('Diğer'), TX('Güneş gözlüğü')], [TX('Diğer'), TX('Plaj havlusu')], [TX('Giysi'), TX('Terlik')]],
  doga: [[TX('Giysi'), TX('Yürüyüş botu')], [TX('Diğer'), TX('El feneri / kafa lambası')], [TX('Giysi'), TX('Yağmurluk')], [TX('İlaç'), TX('İlk yardım çantası')], [TX('Diğer'), TX('Matara')], [TX('Giysi'), TX('Polar / sıcak katman')]],
  etkinlik: [[TX('Belgeler'), TX('Etkinlik bileti · DoraGo\'da')], [TX('Diğer'), TX('Kulak tıkacı')], [TX('Elektronik'), TX('Powerbank')], [TX('Diğer'), TX('Küçük çanta (giriş kuralına uygun)')]],
  aile: [[TX('Diğer'), TX('Hediyeler')], [TX('Diğer'), TX('Ev sahibine küçük bir hediye')]],
  gezi: [[TX('Giysi'), TX('Rahat yürüyüş ayakkabısı')], [TX('Diğer'), TX('Şehir / müze kartı kontrolü')], [TX('Diğer'), TX('Küçük sırt çantası')]],
};
function packKind(name, p) {
  const k = tripKind(name); if (!k || p.kind === k) return false;
  let n = 0;
  for (const [c, t] of KIND_PACK[k] || []) if (!p.items.some(i => i.t.toLocaleLowerCase(LANG) === t.toLocaleLowerCase(LANG)) && !(p.hide || []).includes(t)) { p.items.push({ id: uid(), c, t, done: false, auto: 'tip' }); n++; }
  p.kind = k; if (n) p.tips = [...new Set([...(p.tips || []), TL`${kindOf(k).n} · ${n} eşya eklendi`])];
  return true;
}
const KIND_SUG = {
  is: [{ icon: 'coffee', label: TX('Çalışmaya uygun kafeler'), q: 'laptop friendly cafes' }, { icon: 'tools-kitchen-2', label: TX('İş yemeği için restoranlar'), q: 'business lunch restaurants' }],
  etkinlik: [{ icon: 'tools-kitchen-2', label: TX('Mekâna yakın yemek'), q: 'restaurants near venue' }, { icon: 'glass-full', label: TX('Etkinlik sonrası barlar'), q: 'bars' }],
  doga: [{ icon: 'mountain', label: TX('Yürüyüş parkurları'), q: 'hiking trails' }, { icon: 'map-2', label: TX('Kamp alanları'), q: 'campgrounds' }],
  tatil: [{ icon: 'beach', label: TX('Plajlar'), q: 'beaches' }, { icon: 'sun', label: TX('Beach club / plaj tesisleri'), q: 'beach clubs' }],
  aile: [{ icon: 'mood-kid', label: TX('Ailece gidilecek yerler'), q: 'family friendly places' }],
  gezi: [],
};

/* ================= 5.8: yıl özeti (DoraGo Wrapped) ================= */
const WRAP_C = { cream: '#FAF6EF', sand: '#F4ECDF', ink: '#3B2A1E', mut: '#A8846A', acc: '#C2410C', teal: '#0F766E', land: '#EADFCF', vis: '#F0B79A' };
function wrapYearDue(t = todayStr()) {
  const m = +t.slice(5, 7), d = +t.slice(8, 10), y = +t.slice(0, 4);
  const yy = m === 12 && d >= 15 ? y : m === 1 ? y - 1 : null;
  if (!yy || lsGet('wrapSeen' + yy, false)) return null;
  return yearStats(yy).done.length >= 3 ? yy : null;
}
function wrapMap(x, st, mx, my, mw, mh, C) {
  const Wd = window.WORLD; x.save(); x.beginPath(); x.roundRect ? x.roundRect(mx, my, mw, mh, 36) : x.rect(mx, my, mw, mh); x.clip();
  x.fillStyle = C.sand; x.fillRect(mx, my, mw, mh);
  if (Wd) {
    const P = (lat, lon) => wproj(lat, lon, Wd);
    const xy = [...st.pts.map(p => P(p.lat, p.lon)), ...st.arcs.flatMap(([a, b]) => [P(a.lat, a.lon), P(b.lat, b.lon)])];
    let x0 = 0, x1 = Wd.W, y0 = 30, y1 = Wd.H - 80;
    if (xy.length) { x0 = Math.min(...xy.map(p => p[0])); x1 = Math.max(...xy.map(p => p[0])); y0 = Math.min(...xy.map(p => p[1])); y1 = Math.max(...xy.map(p => p[1])); }
    let w = Math.max(x1 - x0, 50) * 1.45, h = Math.max(y1 - y0, 30) * 1.45; if (w / h < mw / mh) w = h * mw / mh; else h = w * mh / mw;
    const sc = mw / w, ox = (x0 + x1) / 2 - w / 2, oy = (y0 + y1) / 2 - h / 2;
    x.translate(mx - ox * sc, my - oy * sc); x.scale(sc, sc);
    const vis = new Set(st.countries.map(c => c.cc));
    for (const [cc, c] of Object.entries(Wd.c)) { x.fillStyle = vis.has(cc) ? C.vis : C.land; x.fill(new Path2D(c.d)); }
    x.lineWidth = 3.4 / sc; x.setLineDash([9 / sc, 7 / sc]); x.strokeStyle = C.acc;
    for (const [a, b] of st.arcs) { const p = P(a.lat, a.lon), q = P(b.lat, b.lon); x.beginPath(); x.moveTo(p[0], p[1]); x.quadraticCurveTo((p[0] + q[0]) / 2, (p[1] + q[1]) / 2 - Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.28, q[0], q[1]); x.stroke(); }
    x.setLineDash([]); x.fillStyle = C.ink;
    for (const p of [...st.pts, ...st.arcs.flat()]) { const [px, py] = P(p.lat, p.lon); x.beginPath(); x.arc(px, py, 8 / sc, 0, Math.PI * 2); x.fill(); }
  }
  x.restore();
}
async function yearWrap(y) {
  busy(TX('Yıl özetin hazırlanıyor…'));
  try {
    await loadWorld(); await getTP(); await getExp(); await getFx();
    const C = WRAP_C, W = 1080, H = 1920, serif = 'Georgia, "Noto Serif", serif', sans = 'system-ui, -apple-system, Roboto, sans-serif';
    const st = yearStats(y), today = todayStr();
    const trips = allTrips().filter(g => g.a && g.a.slice(0, 4) === String(y) && g.a <= today && !(lsGet('statsNoWork', false) && tripKind(g.name) === 'is'));
    const slides = [];
    const mk = bg => { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = cv.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, W, H); x.textBaseline = 'alphabetic'; slides.push(cv); return x; };
    const font = (x, w, s, f) => { x.font = `${w} ${s}px ${f}`; };
    const fit = (x, txt, maxW, s, w, f, min = 40) => { font(x, w, s, f); while (x.measureText(txt).width > maxW && s > min) { s -= 4; font(x, w, s, f); } return s; };
    const kick = (x, txt, col, yy) => { x.fillStyle = col; font(x, 700, 34, sans); x.letterSpacing = '6px'; x.fillText(txt, 96, yy); x.letterSpacing = '0px'; };
    const foot = (x, col, n) => { x.fillStyle = col; font(x, 600, 32, sans); x.textAlign = 'left'; x.fillText(TX('DoraGo'), 96, H - 100); x.pnCol = col; };
    const dash = (x, col, yy) => { x.strokeStyle = col; x.lineWidth = 3; x.setLineDash([14, 12]); x.beginPath(); x.moveTo(96, yy); x.lineTo(W - 96, yy); x.stroke(); x.setLineDash([]); };
    // 1 · kapak
    let x = mk(C.acc);
    x.fillStyle = C.cream; font(x, 600, 40, sans); x.fillText(TX('DoraGo'), 96, 170);
    x.textAlign = 'center'; font(x, 700, 330, serif); x.fillText(String(y), W / 2, 900);
    font(x, 'italic 400', 96, serif); x.fillText(TX('seyahat yılın'), W / 2, 1040);
    x.globalAlpha = .55; dash(x, C.cream, 1200); x.globalAlpha = 1;
    font(x, 500, 50, sans); x.fillText([trips.length && TL`${trips.length} seyahat`, st.days && TL`${fmtN(st.days)} gün yolda`].filter(Boolean).join(' · ') || TL`${st.done.length} bilet`, W / 2, 1300);
    { const km = kindMix(y).text; if (km) { font(x, 500, 40, sans); x.globalAlpha = .85; x.fillText(km, W / 2, 1380); x.globalAlpha = 1; } }
    font(x, 500, 40, sans); x.globalAlpha = .8; x.fillText(TX('Kaydırarak izle →'), W / 2, H - 220); x.globalAlpha = 1; x.textAlign = 'left';
    x.strokeStyle = C.cream; x.lineWidth = 5; x.save(); x.translate(W - 200, 260); x.rotate(.18); x.beginPath(); x.arc(0, 0, 86, 0, Math.PI * 2); x.stroke(); x.lineWidth = 2; x.beginPath(); x.arc(0, 0, 72, 0, Math.PI * 2); x.stroke(); x.textAlign = 'center'; font(x, 700, 24, sans); x.fillStyle = C.cream; x.fillText('YIL', 0, -4); x.fillText(TX('ÖZETİ'), 0, 26); x.restore();
    // 2 · rakamlar
    x = mk(C.cream); kick(x, 'YOLDA', C.acc, 260);
    x.fillStyle = C.ink; font(x, 600, 300, serif); x.fillText(fmtN(st.days || st.done.length), 84, 560);
    font(x, 'italic 400', 72, serif); x.fillStyle = C.mut; x.fillText(st.days ? TX('gün yolda geçti') : TX('bilet kullandın'), 96, 660);
    dash(x, C.land, 760);
    let ly = 900;
    const row = (big, small) => { x.fillStyle = C.ink; font(x, 600, 92, serif); x.fillText(big, 96, ly); if (small) { x.fillStyle = C.mut; font(x, 500, 40, sans); x.fillText(small, 96, ly + 62); } ly += small ? 200 : 140; };
    const spd = yearSpend(y);
    if (st.fl.length) {
      row(TL`${fmtN(st.fl.length)} uçuş`, `${fmtN(st.km)} km havada`);
      const r = st.km / 40075; row(r >= 1 ? TL`Dünya'yı ${r.toLocaleString(LOC, { maximumFractionDigits: 1 })} kez` : TL`Dünya'nın ${pct(Math.max(1, Math.round(r * 100)))}'i`, r >= 1 ? TX('dolaşacak kadar yol') : TX('kadar yol: çevresi 40.075 km'));
      if (st.longest) { const l = st.longest; x.fillStyle = C.acc; font(x, 700, 30, sans); x.fillText(TX('EN UZUN UÇUŞ'), 96, ly); x.fillStyle = C.ink; fit(x, `${apCity(l.from) || l.from} → ${apCity(l.to) || l.to}`, W - 192, 64, 500, serif); x.fillText(`${apCity(l.from) || l.from} → ${apCity(l.to) || l.to}`, 96, ly + 80); x.fillStyle = C.mut; font(x, 500, 40, sans); x.fillText(`${fmtN(Math.round(flightKm(l)))} km`, 96, ly + 140); }
    } else { row(TL`${fmtN(st.places)} yer`, TX('müze, etkinlik, yemek, gezi')); row(TL`${fmtN(st.cities.length)} şehir`, ''); }
    if (spd.total > 0) { const sy = Math.min(st.fl.length && st.longest ? ly + 240 : ly, 1640); x.fillStyle = C.acc; font(x, 700, 30, sans); x.fillText(TX('SEYAHATE HARCADIĞIN'), 96, sy); x.fillStyle = C.ink; font(x, 600, 80, serif); x.fillText(fmtMoney(spd.total), 96, sy + 90); }
    foot(x, C.mut, 2);
    // 3 · harita
    x = mk(C.teal); kick(x, TX('HARİTAN'), C.cream, 260);
    x.fillStyle = C.cream; const ttl = st.countries.length ? TL`${st.countries.length} ülke · ${st.cities.length} şehir` : TL`${st.cities.length} şehir`;
    fit(x, ttl, W - 192, 104, 600, serif); x.fillText(ttl, 96, 400);
    wrapMap(x, st, 96, 480, W - 192, 960, C);
    x.fillStyle = C.cream; font(x, 'italic 400', 46, serif); { let line = '', yy = 1540; for (const c of st.cities.slice(0, 9)) { const t2 = line ? line + ' · ' + c : c; if (x.measureText(t2).width > W - 192) { x.fillText(line, 96, yy); yy += 64; line = c; if (yy > 1690) { line = ''; break; } } else line = t2; } if (line) x.fillText(line, 96, yy); }
    foot(x, C.cream, 3);
    // 4 · yılın seyahati
    const best = trips.map(g => ({ g, d: nightsBetween(g.a, (g.e || g.a) < today ? (g.e || g.a) : today) + 1, n: S.tickets.filter(t => t.trip === g.name).length })).sort((a, b) => b.d - a.d || b.n - a.n)[0];
    if (best) {
      x = mk(C.cream); kick(x, TX('YILIN SEYAHATİ'), C.acc, 260);
      const cov = await tripCoverBlob(best.g.name);
      if (cov) {
        const im = await createImageBitmap(cov), S2 = 700, sc = Math.max(S2 / im.width, S2 / im.height);
        x.save(); x.translate(W / 2, 760); x.rotate(-0.04); x.shadowColor = 'rgba(0,0,0,.22)'; x.shadowBlur = 40; x.shadowOffsetY = 14; x.fillStyle = '#fff'; x.fillRect(-S2 / 2 - 28, -S2 / 2 - 28, S2 + 56, S2 + 150); x.shadowColor = 'transparent';
        x.beginPath(); x.rect(-S2 / 2, -S2 / 2, S2, S2); x.clip(); x.drawImage(im, -im.width * sc / 2, -im.height * sc / 2, im.width * sc, im.height * sc); x.restore();
      } else {
        x.save(); x.translate(W / 2, 760); x.rotate(-0.1); x.strokeStyle = C.teal; x.fillStyle = C.teal; x.lineWidth = 10; x.beginPath(); x.arc(0, 0, 260, 0, Math.PI * 2); x.stroke(); x.lineWidth = 3; x.beginPath(); x.arc(0, 0, 228, 0, Math.PI * 2); x.stroke();
        x.textAlign = 'center'; font(x, 600, 200, serif); x.fillText(String(best.d), 0, 60); font(x, 700, 48, sans); x.fillText(TX('GÜN'), 0, 140); x.restore();
      }
      x.fillStyle = C.ink; x.textAlign = 'left'; fit(x, best.g.name, W - 192, 120, 500, serif, 56); x.fillText(best.g.name, 96, 1340);
      x.fillStyle = C.mut; font(x, 500, 44, sans); x.fillText(TL`${fmtRange(best.g.a, best.g.e || best.g.a)} · ${best.d} gün · ${best.n} bilet`, 96, 1420);
      const cc = new Map(); for (const g of trips) { const seen = new Set(); for (const t of S.tickets.filter(t => t.trip === g.name && t.date && hasEnded(t) && realised(t))) { const w = ticketWhere(t); if (w && w.city && t.type !== 'ucak') seen.add(w.city); else if (w && w.city && t.type === 'ucak' && w.cc !== HOME_CC) seen.add(w.city); } for (const c of seen) cc.set(c, (cc.get(c) || 0) + 1); }
      const top = [...cc.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 2) { dash(x, C.land, 1520); x.fillStyle = C.acc; font(x, 700, 30, sans); x.fillText(TX('EN ÇOK GİTTİĞİN ŞEHİR'), 96, 1610); x.fillStyle = C.ink; font(x, 600, 72, serif); x.fillText(TL`${top[0]} · ${top[1]} kez`, 96, 1700); }
      foot(x, C.mut, 4);
    }
    // 5 · pullar / kapanış
    x = mk(C.ink); kick(x, 'PASAPORTUN', C.vis, 260);
    x.fillStyle = C.cream; const pt = st.countries.length ? TL`${st.countries.length} yeni pul` : TX('Yurt içi bir yıl');
    font(x, 600, 110, serif); x.fillText(pt, 96, 400);
    const cols = ['#C2410C', '#0F766E', '#B7791F', '#378ADD', '#B4436C', '#5B8C2A'];
    const cs = st.countries.slice(0, 9);
    cs.forEach((c, i) => {
      const cw = 270, ch = 300, gx = 96 + (i % 3) * (cw + 39), gy = 500 + Math.floor(i / 3) * (ch + 40);
      x.save(); x.translate(gx + cw / 2, gy + ch / 2); x.rotate([-.05, .04, -.02, .05, -.04, .02, -.03, .05, -.05][i]); x.strokeStyle = cols[i % 6]; x.fillStyle = cols[i % 6];
      x.lineWidth = 5; x.setLineDash([12, 8]); x.beginPath(); x.roundRect ? x.roundRect(-cw / 2, -ch / 2, cw, ch, 22) : x.rect(-cw / 2, -ch / 2, cw, ch); x.stroke(); x.setLineDash([]);
      x.globalAlpha = .14; x.fill(); x.globalAlpha = 1; x.textAlign = 'center'; x.fillStyle = C.cream;
      font(x, 700, 110, serif); x.fillText(c.cc, 0, 10); fit(x, countryName(c.cc), cw - 30, 34, 600, sans, 22); x.fillText(countryName(c.cc), 0, 80); font(x, 500, 28, sans); x.globalAlpha = .7; x.fillText(TL`${c.n} kez`, 0, 124); x.globalAlpha = 1; x.restore();
    });
    const slots = Math.min(9, Math.max(6, Math.ceil((cs.length + 1) / 3) * 3));
    for (let i = cs.length; i < slots; i++) {
      const cw = 270, ch = 300, gx = 96 + (i % 3) * (cw + 39), gy = 500 + Math.floor(i / 3) * (ch + 40);
      x.save(); x.translate(gx + cw / 2, gy + ch / 2); x.strokeStyle = 'rgba(250,246,239,.22)'; x.lineWidth = 4; x.setLineDash([12, 10]); x.beginPath(); x.roundRect ? x.roundRect(-cw / 2, -ch / 2, cw, ch, 22) : x.rect(-cw / 2, -ch / 2, cw, ch); x.stroke(); x.setLineDash([]);
      x.fillStyle = 'rgba(250,246,239,.25)'; x.textAlign = 'center'; font(x, 600, 110, serif); x.fillText('?', 0, 36); x.restore();
    }
    x.fillStyle = C.vis; x.textAlign = 'left'; font(x, 'italic 400', 88, serif); x.fillText(`${y + 1}'de nereye?`, 96, 500 + Math.ceil(slots / 3) * 340 + 140);
    foot(x, C.mut, 0);
    // sayfa numaraları
    const T = slides.length;
    for (const [i, cv] of slides.entries()) if (i) { const c = cv.getContext('2d'); c.fillStyle = c.pnCol || C.mut; c.textAlign = 'right'; c.font = `500 30px ${sans}`; c.fillText(`${y} · ${i + 1}/${T}`, W - 96, H - 100); }
    const blobs = []; for (const cv of slides) blobs.push(await new Promise(r => cv.toBlob(r, 'image/png')));
    busy(false); lsSet('wrapSeen' + y, true);
    showWrap(y, blobs);
  } catch (e) { console.error(e); busy(false); toast(TX('Yıl özeti hazırlanamadı')); }
}
function showWrap(y, blobs) {
  const urls = blobs.map(b => URL.createObjectURL(b)); let i = 0;
  const ov = document.createElement('div'); ov.className = 'wrapv';
  ov.innerHTML = TL`<div class="wbars">${urls.map((_, k) => `<i data-k="${k}"></i>`).join('')}</div><img alt="${y} yıl özeti"><div class="wnav"><button data-w="prev" aria-label="Önceki"></button><button data-w="next" aria-label="Sonraki"></button></div>
    <div class="row2 wbtn"><button class="btn" data-w="close">Kapat</button><button class="btn pri" data-w="share">${I('share')} Paylaş</button></div>`;
  const img = ov.querySelector('img');
  const show = () => { img.src = urls[i]; ov.querySelectorAll('.wbars i').forEach((b, k) => b.className = k <= i ? 'on' : ''); };
  const close = () => { ov.remove(); dlgClose = null; urls.forEach(u => URL.revokeObjectURL(u)); };
  ov.addEventListener('click', async e => {
    const b = e.target.closest('[data-w]'); if (!b) return; const w = b.dataset.w;
    if (w === 'prev') { i = Math.max(0, i - 1); show(); }
    else if (w === 'next') { if (i < urls.length - 1) { i++; show(); } }
    else if (w === 'close') close();
    else if (w === 'share') {
      const title = TL`${y} seyahat yılım`;
      if (A && A.shareImages) { const parts = []; for (const bl of blobs) parts.push('png:' + B64.enc(await bl.arrayBuffer())); S.pickAt = Date.now(); A.shareImages(title, parts.join('|')); return; }
      const files = blobs.map((bl, k) => new File([bl], TL`DoraGo-${y}-${k + 1}.png`, { type: 'image/png' }));
      try { if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title }); return; } } catch (er) { if (er.name === 'AbortError') return; }
      files.forEach(f => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); });
    }
  });
  dlgClose = close; document.body.appendChild(ov); show();
}

/* ================= 5.8: kalkış öncesi kontrol ================= */
const PF_WIN = 48 * 3600000;
function pfActive(t) { if (t.type !== 'ucak' || !t.date || !t.time || t.status) return false; const s = at(t.date, t.time), now = Date.now(); return s > now && s - now <= PF_WIN; }
const pfIntl = t => { const a = apRec(t.from), b = apRec(t.to); return a && b && a.cc && b.cc ? a.cc !== b.cc : !!(t.trip && tripForeign(t.trip)); };
function pfItems(t) {
  const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const intl = pfIntl(t), s = at(t.date, t.time || '12:00'), ci = t.checkinH ? s - t.checkinH * 3600000 : null;
  const hasBp = (t.pageIds || []).length > 0, pc = t.trip ? packCount(t.trip) : null;
  const L = [
    { k: 'ci', l: TX('Online check-in'), s: ci && ci > Date.now() ? TL`${shortDay(ci).split(' ').slice(0, 2).join(' ')} ${hm(ci)}'de açılır` : TX('Havayolunun uygulamasından ya da sitesinden') },
    (() => { const vz = intl ? pfVisaTxt(t) : null; return { k: 'id', l: intl ? TX('Pasaport') + (vz ? (vz.bad ? TX(' · vize eksik') : TX(' · vize tamam')) : '') : TX('Kimlik kartı'), s: intl ? (vz ? vz.txt : TX('Vize ya da e-vize gerekiyorsa onu da yanına al')) : TX('Cüzdanında olsun') }; })(),
    { k: 'bp', l: TX('Biniş kartı telefonda'), s: hasBp ? TX('DoraGo\'da kayıtlı') : TX('Check-in sonrası DoraGo\'ya ekle'), auto: hasBp },
    { k: 'pw', l: TX('Şarj ve powerbank'), s: TX('Powerbank kabin çantasında olmalı') },
    { k: 'lq', l: TX('Sıvılar en fazla 100 ml'), s: TX('Şeffaf poşette, toplam 1 litre') },
    { k: 'go', l: TL`Havalimanında en geç ${hm(s - (intl ? 3 : 2) * 3600000)}`, s: TL`${intl ? TX('Dış hat: 3') : TX('İç hat: 2')} saat önce · ulaşımı planla` },
    ...(pc ? [{ k: 'pk', l: TX('Bavul listesi'), s: TL`${pc[0]}/${pc[1]} hazır`, auto: pc[0] === pc[1] && pc[1] > 0, link: true }] : []),
  ];
  for (const i of L) i.done = !!i.auto || !!(t.pf && t.pf[i.k]);
  return L;
}
function pfHtml(t) {
  const L = pfItems(t), d = L.filter(i => i.done).length;
  return TL`<div class="pfbox"><div class="pfh">${I('list-check')}<b>Kalkış öncesi kontrol</b><span>${d}/${L.length}</span></div>
    ${L.map(i => `<button class="pfi ${i.done ? 'on' : ''}" data-pf="${i.k}"><span class="pcb">${i.done ? I('check') : ''}</span><span class="pft"><b>${esc(i.l)}</b><small>${esc(i.s)}</small></span>${i.link ? '<i class="pfgo">›</i>' : ''}</button>`).join('')}</div>`;
}
function pfChip(t) { if (!pfActive(t)) return ''; const L = pfItems(t), d = L.filter(i => i.done).length; return TL`<span class="pfch ${d === L.length ? 'ok' : ''}">${I('list-check')} Kalkış kontrolü ${d}/${L.length}</span>`; }
async function pfToggle(t, k) {
  if (k === 'pk') { S.packRet = true; openPack(t.trip); return; }
  const it = pfItems(t).find(i => i.k === k); if (!it || it.auto) return;
  t.pf = { ...(t.pf || {}), [k]: !it.done }; await saveTicketDB(t, [], []); render(); if (!it.done) { okPop($(`[data-pf="${k}"] .pcb`)); tick(); }
}

/* ================= 5.7: seyahat sayfası (B düzeni) + anı fotoğrafları ================= */
const PHOTO_MAX = 10;
let TP = null; /* { [seyahat]: { cover, items: [{ id, note, date }] } } — fotoğrafların kendisi pages deposunda */
async function dropTripPhotos(name) { await dropShop(name); await getExp(); if (EXP[name]) { delete EXP[name]; await saveExp(); } await getTP(); const r = TP[name]; if (!r) return; await delPages(r.items.map(i => i.id)); delete TP[name]; await saveTP(); }
async function getTP() { if (!TP) TP = (await metaGet('tripPhotos')) || {}; return TP; }
async function saveTP() { await metaSet('tripPhotos', TP || {}); }
const PHB = new Map();
async function putPages(list) { const t = (await db()).transaction('pages', 'readwrite'); for (const p of list) t.objectStore('pages').put(p); return done(t); }
async function delPages(ids) { const t = (await db()).transaction('pages', 'readwrite'); for (const id of ids) t.objectStore('pages').delete(id); return done(t); }
async function photoBlob(id) { if (!PHB.has(id)) { const p = await getOne('pages', id); if (p) PHB.set(id, p.blob); } return PHB.get(id); }
async function shrinkPhoto(file, max = 1600) {
  const bmp = await createImageBitmap(file), s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return { blob: await canvasBlob(c, 'image/jpeg', 0.82), w: c.width, h: c.height };
}
async function tripCoverBlob(name) { await getTP(); const r = TP[name]; if (!r || !r.items.length) return null; return photoBlob(r.cover && r.items.some(i => i.id === r.cover) ? r.cover : r.items[0].id); }
async function addTripPhotos(name) {
  await getTP(); const r = TP[name] || (TP[name] = { cover: null, items: [] });
  const room = PHOTO_MAX - r.items.length; if (room <= 0) { toast(TL`En fazla ${PHOTO_MAX} anı fotoğrafı`); return; }
  const files = (await pickFiles('image/*', true)).slice(0, room); if (!files.length) return;
  busy(TX('Fotoğraflar ekleniyor…'));
  try {
    const pages = [];
    for (const f of files) {
      const p = await shrinkPhoto(f), id = 'ph_' + uid(), d = new Date(f.lastModified || Date.now());
      pages.push({ id, w: p.w, h: p.h, blob: p.blob }); PHB.set(id, p.blob);
      r.items.push({ id, note: '', date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` });
    }
    const newCover = !r.cover; await putPages(pages); if (!r.cover) { r.cover = r.items[0].id; delete r.cpos; } await saveTP();
    busy(false); toast(TL`${files.length} fotoğraf eklendi${files.length < room ? '' : ''}`); render();
    if (newCover) coverAlign(name);
  } catch (e) { console.error(e); busy(false); toast(TX('Fotoğraf eklenemedi')); }
}
async function photoMenu(name, id) {
  const r = TP[name], it = r && r.items.find(i => i.id === id); if (!it) return;
  const v = await sheetMenu(it.note || TX('Anı fotoğrafı'), [
    ...(r.cover !== id ? [{ icon: I('photo'), label: TX('Kapak yap'), sub: TX('Sayfanın ve kartpostalın fotoğrafı'), value: 'cover' }] : [{ icon: I('arrows-move'), label: TX('Kapağı hizala'), sub: TX('Sürükle ve büyüt'), value: 'align' }]),
    { icon: I('pencil'), label: it.note ? TX('Notu değiştir') : TX('Not yaz'), value: 'note' },
    { icon: I('trash'), label: TX('Sil'), value: 'del', danger: true },
  ]); if (!v) return;
  if (v === 'align') { coverAlign(name); return; }
  if (v === 'cover') { r.cover = id; delete r.cpos; await saveTP(); render(); coverAlign(name); return; }
  else if (v === 'note') { const n = await inputDialog({ title: TX('Fotoğraf notu'), value: it.note, placeholder: TX('Örn. Hyde Park'), ok: TX('Kaydet') }); if (n == null) return; it.note = n.trim(); }
  else if (v === 'del') { if (!await dialog({ title: TX('Fotoğraf silinsin mi?'), ok: TX('Sil'), danger: true })) return; r.items = r.items.filter(i => i.id !== id); if (r.cover === id) { r.cover = r.items[0] ? r.items[0].id : null; delete r.cpos; } await delPages([id]); PHB.delete(id); }
  await saveTP(); render();
}
/* ---------- 5.18 seyahat görseli: kapak fotoğrafı ya da ülke haritası + bayrak ---------- */
const MAIN_BB = new Map();
/* ülkenin en büyük parçasının sınırları (denizaşırı topraklar görünümü büyütmesin) */
function mainBB(cc) {
  if (MAIN_BB.has(cc)) return MAIN_BB.get(cc);
  const c = window.WORLD && WORLD.c[cc]; let best = null;
  if (c && c.d) for (const sp of c.d.split('M').filter(Boolean)) {
    const n = sp.match(/-?\d+(?:\.\d+)?/g); if (!n || n.length < 4) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i + 1 < n.length; i += 2) { const x = +n[i], y = +n[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const a = (x1 - x0) * (y1 - y0); if (!best || a > best.a) best = { a, b: [x0, y0, x1, y1] };
  }
  const r = best ? best.b : (c && c.b) || null; MAIN_BB.set(cc, r); return r;
}
function tripArtCCs(name) { const c = tripCCs(name); return c.length ? c : (HOME_CC ? [HOME_CC] : []); }
function tripPin(name) {
  const ts = S.tickets.filter(t => t.trip === name && t.status !== 'cancel');
  const h = ts.find(t => t.type === 'konaklama' && hasC(t)); if (h) return { lat: +h.lat, lon: +h.lon };
  const o = ts.find(t => t.type !== 'ucak' && hasC(t)); if (o) return { lat: +o.lat, lon: +o.lon };
  const f = ts.filter(t => t.type === 'ucak').map(t => apRec(t.to)).find(a => a && a.lat != null && a.cc !== HOME_CC); return f ? { lat: f.lat, lon: f.lon } : null;
}
function ccMapCore(ccs, pp, cls = '') {
  const W = window.WORLD; if (!W) return '';
  ccs = ccs.filter(cc => W.c[cc]);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const cc of ccs) { const b = mainBB(cc); if (!b) continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  if (pp) { x0 = Math.min(x0, pp[0] - 3); y0 = Math.min(y0, pp[1] - 3); x1 = Math.max(x1, pp[0] + 3); y1 = Math.max(y1, pp[1] + 3); }
  if (x0 > x1) return '';
  const sz = Math.max(x1 - x0, y1 - y0, 6) * 1.18, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, vx = cx - sz / 2, vy = cy - sz / 2;
  const hit = b => b && b[2] >= vx && b[0] <= vx + sz && b[3] >= vy && b[1] <= vy + sz;
  const nb = Object.entries(W.c).filter(([cc, c]) => !ccs.includes(cc) && c.d && hit(c.b)).map(([, c]) => `<path class="nb" d="${c.d}"/>`).join('');
  const on = ccs.map(cc => `<path class="on" d="${W.c[cc].d}"/>`).join('');
  const r = sz * 0.022;
  const pinS = pp ? `<circle class="halo" cx="${pp[0].toFixed(1)}" cy="${pp[1].toFixed(1)}" r="${(r * 2.1).toFixed(2)}"/><circle class="pin" cx="${pp[0].toFixed(1)}" cy="${pp[1].toFixed(1)}" r="${r.toFixed(2)}"/>` : '';
  return `<svg${cls ? ` class="${cls}"` : ''} viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${sz.toFixed(1)} ${sz.toFixed(1)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${nb}${on}${pinS}</svg>`;
}
function tripMapSvg(name) {
  const W = window.WORLD; if (!W) return '';
  const pin = tripPin(name);
  return ccMapCore(tripArtCCs(name), pin ? wproj(pin.lat, pin.lon, W) : null);
}
/* bilet detayı: uçuşta iki havalimanı arası rota, konumlu bilette ülke haritası + işaret */
function ticketArt(t) {
  const W = window.WORLD; if (!W) return '';
  if (t.type === 'ucak') {
    const a = apRec(t.from), b = apRec(t.to); if (!a || !b || a.lat == null || b.lat == null) return '';
    const pa = wproj(a.lat, a.lon, W), pb = wproj(b.lat, b.lon, W);
    const dx = Math.abs(pa[0] - pb[0]), dy = Math.abs(pa[1] - pb[1]);
    const w = Math.max(dx * 1.6, dy * 1.6 * 16 / 9, 30), h = w * 9 / 16, cx = (pa[0] + pb[0]) / 2, cy = (pa[1] + pb[1]) / 2 - h * 0.06, vx = cx - w / 2, vy = cy - h / 2;
    const hit = bb => bb && bb[2] >= vx && bb[0] <= vx + w && bb[3] >= vy && bb[1] <= vy + h;
    const ends = new Set([a.cc, b.cc]);
    const land = Object.entries(W.c).filter(([, c]) => c.d && hit(c.b)).map(([cc, c]) => `<path class="${ends.has(cc) ? 'on' : 'nb'}" d="${c.d}"/>`).join('');
    const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2, len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
    let nx = -(pb[1] - pa[1]) / len, ny = (pb[0] - pa[0]) / len; if (ny > 0) { nx = -nx; ny = -ny; }
    const qx = mx + nx * len * 0.28, qy = my + ny * len * 0.28, r = w * 0.011;
    return `<svg viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${land}
      <path class="rt" d="M${pa[0].toFixed(1)},${pa[1].toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${pb[0].toFixed(1)},${pb[1].toFixed(1)}"/>
      <circle class="pin" cx="${pa[0].toFixed(1)}" cy="${pa[1].toFixed(1)}" r="${r.toFixed(2)}"/><circle class="halo" cx="${pb[0].toFixed(1)}" cy="${pb[1].toFixed(1)}" r="${(r * 2.2).toFixed(2)}"/><circle class="pin" cx="${pb[0].toFixed(1)}" cy="${pb[1].toFixed(1)}" r="${r.toFixed(2)}"/></svg>`;
  }
  if (!hasC(t)) return '';
  const near = nearAp(+t.lat, +t.lon), cc = near && near.cc;
  return cc ? ccMapCore([cc], wproj(+t.lat, +t.lon, W), 'vmap') : '';
}
const tripFlags = name => tripCCs(name).slice(0, 5).map(flagOf).join(' ');
const tripHasCover = name => !!(TP && TP[name] && TP[name].items.length);
/* harita ve fotoğraf verisi yüklenmemişse bir kez yükleyip yeniden çiz */
let ART_P = null;
function artReady() {
  if (window.WORLD && TP) return true;
  if (!ART_P) ART_P = Promise.all([loadWorld(), getTP()]).then(() => { if (S.view === 'home' || S.view === 'trip' || S.view === 'view') quietRender(); });
  return false;
}
/* data-cov="seyahat" olan öğelere kapak fotoğrafını koy */
async function fillCovers(root) {
  const self = root && root.matches && root.matches('[data-cov]:not([data-cdone])') ? [root] : [];
  for (const el of [...self, ...$$('[data-cov]:not([data-cdone])', root || document)]) {
    el.dataset.cdone = '1';
    const b = await tripCoverBlob(el.dataset.cov); if (!b || !el.isConnected) continue;
    el.style.backgroundImage = `linear-gradient(180deg,rgba(0,0,0,.28) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,.08) 50%,rgba(0,0,0,.62) 100%),url('${blobURL('ph:' + el.dataset.cov + ':' + b.size, b)}')`;
    el.classList.add('hascov');
    const cp = TP[el.dataset.cov] && TP[el.dataset.cov].cpos;
    if (cp) { const d = await imgDims(b); if (d && el.isConnected) { el._cov = { cp, d }; placeCover(el); } }
  }
}
/* 5.22 kapak hizalama: cpos = {x,y} (kadrajın ortasına gelen nokta, 0–1) + z (cover'a göre yakınlaştırma) */
const IMG_DIMS = new WeakMap();
async function imgDims(b) {
  if (IMG_DIMS.has(b)) return IMG_DIMS.get(b);
  let d = null; try { const bm = await createImageBitmap(b); d = { w: bm.width, h: bm.height }; bm.close && bm.close(); } catch (e) {}
  IMG_DIMS.set(b, d); return d;
}
function coverBox(W, H, d, cp) {
  const sc = Math.max(W / d.w, H / d.h) * (cp.z || 1), dw = d.w * sc, dh = d.h * sc;
  const ox = Math.min(0, Math.max(W - dw, W / 2 - cp.x * dw)), oy = Math.min(0, Math.max(H - dh, H / 2 - cp.y * dh));
  return { dw, dh, ox, oy };
}
function placeCover(el) {
  const { cp, d } = el._cov || {}; if (!cp) return; const W = el.clientWidth, H = el.clientHeight; if (!W || !H) return;
  const k = coverBox(W, H, d, cp);
  el.style.backgroundSize = `100% 100%, ${k.dw}px ${k.dh}px`; el.style.backgroundPosition = `0 0, ${k.ox}px ${k.oy}px`;
}
addEventListener('resize', () => $$('[data-cdone]').forEach(el => el._cov && placeCover(el)));
/* sürükle + yakınlaştır penceresi: yeni cpos döner; null = sıfırla, undefined = vazgeç */
async function alignDialog(b, cp0, title) {
  const d = await imgDims(b); if (!d) return undefined;
  cp0 = cp0 || { x: .5, y: .5, z: 1 }; let z = cp0.z || 1, W = 0, H = 0, k = null;
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = TL`<div class="dlg cal"><h3>${esc(title)}</h3><p class="calh">Sürükle · iki parmakla büyüt</p>
    <div class="calf"><img src="${blobURL('al:' + b.size + ':' + b.type, b)}" alt="" draggable="false"></div>
    <div class="calz">${I('zoom-out')}<input type="range" id="calZ" min="1" max="3" step="0.01" value="${z}">${I('zoom-in')}</div>
    <div class="row2"><button class="btn" data-a="0">Vazgeç</button><button class="btn" data-a="2">Sıfırla</button><button class="btn pri" data-a="1">Kaydet</button></div></div>`;
  document.body.appendChild(ov);
  const fr = $('.calf', ov), im = $('img', fr), zr = $('#calZ', ov);
  W = Math.min(fr.clientWidth || 300, 440); H = Math.round(W / 2.55); fr.style.width = W + 'px'; fr.style.height = H + 'px';
  k = coverBox(W, H, d, { x: cp0.x, y: cp0.y, z });
  const draw = () => { im.style.width = k.dw + 'px'; im.style.height = k.dh + 'px'; im.style.transform = `translate(${k.ox}px,${k.oy}px)`; };
  const focal = () => ({ x: (W / 2 - k.ox) / k.dw, y: (H / 2 - k.oy) / k.dh });
  const setZ = nz => { const f = focal(); z = Math.min(3, Math.max(1, nz)); k = coverBox(W, H, d, { ...f, z }); zr.value = z; draw(); };
  const move = (dx, dy) => { k.ox = Math.min(0, Math.max(W - k.dw, k.ox + dx)); k.oy = Math.min(0, Math.max(H - k.dh, k.oy + dy)); draw(); };
  draw();
  const pts = new Map(); let pinch0 = 0, z0 = 1;
  const dist = () => { const [a, c] = [...pts.values()]; return Math.hypot(a.x - c.x, a.y - c.y); };
  fr.addEventListener('pointerdown', e => { fr.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { pinch0 = dist(); z0 = z; } });
  fr.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) move(dx, dy); else if (pts.size === 2 && pinch0) setZ(z0 * dist() / pinch0);
  });
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; };
  fr.addEventListener('pointerup', up); fr.addEventListener('pointercancel', up);
  fr.addEventListener('wheel', e => { e.preventDefault(); setZ(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
  zr.oninput = () => setZ(+zr.value);
  const a = await new Promise(res => { dlgClose = () => res('0'); ov.addEventListener('click', e => { const bt = e.target.closest('[data-a]'); if (bt) res(bt.dataset.a); else if (e.target === ov) res('0'); }); });
  ov.remove(); dlgClose = null;
  if (a === '0') return undefined;
  if (a === '2') return null;
  const f = focal(); return { x: +f.x.toFixed(4), y: +f.y.toFixed(4), z: +z.toFixed(3) };
}
async function coverAlign(name) {
  await getTP(); const r = TP[name]; const b = await tripCoverBlob(name); if (!r || !b) return;
  const cp = await alignDialog(b, r.cpos, TX('Kapağı hizala')); if (cp === undefined) return;
  if (cp === null) delete r.cpos; else r.cpos = cp;
  await saveTP(); toast(TX('Kapak hizalandı')); render();
}

/* ================= 5.23 bilet başlık fotoğrafı (yer fotoğrafı) =================
   t.hph = { id:'hp_<bilet>', src:'wm'|'own', cr, lic, url, cpos } · { none: zaman } (bulunamadı) · { off: 1 } (harita kalsın)
   Kaynak: Wikipedia sayfa görseli + Wikimedia Commons yakın fotoğrafları (anahtarsız, origin=*). Bir kez indirilir, pages deposunda saklanır. */
const PH_TYPES = ['muze', 'etkinlik', 'konaklama', 'yemek', 'gezi', 'diger'];
const phAuto = () => lsGet('dgPlacePh', true) !== false;
const phEligible = t => PH_TYPES.includes(t.type) && (hasC(t) || ((t.title || '').trim().length > 2 && !!t.place));
const PH_BUSY = new Set();
const phNorm = x => (x || '').toLocaleLowerCase('en').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^file:/, '').replace(/\.(jpe?g|png|webp|tiff?)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const PH_STOP = new Set(['the', 'of', 'and', 'de', 'la', 'le', 'du', 'des', 'di', 'del', 'hotel', 'otel', 'museum', 'muzesi', 'museo', 'musee', 'restaurant', 'cafe', 'bar', 'london', 'paris', 'istanbul', 'in', 'at', 'a']);
function phSim(name, title) {
  const A1 = phNorm(name).split(' ').filter(w => w.length > 1), B1 = new Set(phNorm(title).split(' '));
  const key = A1.filter(w => !PH_STOP.has(w)); if (!A1.length) return 0;
  const hit = A1.filter(w => B1.has(w)).length, khit = key.filter(w => B1.has(w)).length;
  return key.length ? (khit / key.length) * .8 + (hit / A1.length) * .2 : hit / A1.length * .5;
}
async function wjson(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('http ' + r.status); return r.json(); }
const WQ = '&format=json&formatversion=2&origin=*';
const thumbW = (u, w) => u && /\/\d+px-/.test(u) ? u.replace(/\/\d+px-/, `/${w}px-`) : u;
const stripHtml = h => { const d = document.createElement('div'); d.innerHTML = h || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
/* aday fotoğraflar: Wikipedia (konum ya da adla) + Commons (konumla) */
async function placeCands(t) {
  const out = [], seen = new Set(), name = t.title || '';
  const push = o => { const k = phNorm(o.file); if (!o.big || seen.has(k)) return; seen.add(k); out.push(o); };
  const wikiPages = ps => (ps || []).filter(p => p.thumbnail && p.pageimage && !/\.svg$/i.test(p.pageimage)).forEach(p => push({ file: 'File:' + p.pageimage, big: p.thumbnail.source, thumb: thumbW(p.thumbnail.source, 330), title: p.title, sim: phSim(name, p.title), idx: p.index || 0, wiki: true }));
  const jobs = [];
  if (hasC(t)) {
    jobs.push(wjson(`https://en.wikipedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${+t.lat}|${+t.lon}&ggsradius=400&ggslimit=10&prop=pageimages&piprop=thumbnail|name&pithumbsize=1280${WQ}`).then(j => wikiPages(j.query && j.query.pages)).catch(() => {}));
    jobs.push(wjson(`https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${+t.lat}|${+t.lon}&ggsradius=250&ggslimit=20&ggsnamespace=6&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1280&iiextmetadatafilter=Artist|LicenseShortName${WQ}`).then(j => {
      for (const p of (j.query && j.query.pages) || []) {
        const ii = (p.imageinfo || [])[0]; if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime || '')) continue;
        const m = ii.extmetadata || {};
        push({ file: p.title, big: ii.thumburl || ii.url, thumb: thumbW(ii.thumburl, 330) || ii.url, title: p.title, sim: phSim(name, p.title), idx: p.index || 0, cr: stripHtml(m.Artist && m.Artist.value).slice(0, 60), lic: m.LicenseShortName && m.LicenseShortName.value || '', url: ii.descriptionurl || '' });
      }
    }).catch(() => {}));
  }
  if (name.trim().length > 2) {
    const city = (t.place || '').split(',').map(x => x.trim()).filter(Boolean).slice(-2, -1)[0] || (hasC(t) ? nearCity(t.lat, t.lon) : '') || '';
    jobs.push(wjson(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent((name + ' ' + city).trim())}&gsrlimit=5&prop=pageimages&piprop=thumbnail|name&pithumbsize=1280${WQ}`).then(j => wikiPages(j.query && j.query.pages)).catch(() => {}));
  }
  await Promise.all(jobs);
  out.sort((a, b) => (b.sim - a.sim) || ((b.wiki ? 1 : 0) - (a.wiki ? 1 : 0)) || (a.idx - b.idx));
  return out.slice(0, 9);
}
/* Wikipedia görselinin yazar/lisans bilgisi */
async function phCredit(c) {
  if (c.cr !== undefined && c.lic) return c;
  try {
    const j = await wjson(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(c.file)}&prop=imageinfo&iiprop=url|extmetadata&iiextmetadatafilter=Artist|LicenseShortName${WQ}`);
    const ii = ((((j.query || {}).pages || [])[0] || {}).imageinfo || [])[0];
    if (ii) { const m = ii.extmetadata || {}; c.cr = stripHtml(m.Artist && m.Artist.value).slice(0, 60); c.lic = m.LicenseShortName && m.LicenseShortName.value || ''; c.url = ii.descriptionurl || ''; }
  } catch (e) {}
  return c;
}
async function phSave(t, blob, meta) {
  const sh = await shrinkPhoto(blob, 1280).catch(() => null), b = sh ? sh.blob || sh : blob;
  const d = await imgDims(b) || { w: 0, h: 0 }, id = 'hp_' + t.id;
  const fresh = await getOne('tickets', t.id) || t;
  fresh.hph = { id, ...meta }; t.hph = fresh.hph;
  await saveTicketDB(fresh, [{ id, w: d.w, h: d.h, blob: b }], []);
  const i = S.tickets.findIndex(x => x.id === t.id); if (i >= 0) S.tickets[i] = fresh; if (S.cur && S.cur.t && S.cur.t.id === t.id) S.cur.t = fresh;
  return fresh;
}
async function phFromCand(t, c) {
  await phCredit(c);
  const r = await fetch(c.big); if (!r.ok) throw new Error('img');
  return phSave(t, await r.blob(), { src: 'wm', cr: c.cr || '', lic: c.lic || '', url: c.url || '' });
}
async function phMark(t, v) {
  const fresh = await getOne('tickets', t.id) || t; const old = fresh.hph; fresh.hph = v; t.hph = v;
  await saveTicketDB(fresh, [], old && old.id ? [old.id] : []);
  const i = S.tickets.findIndex(x => x.id === t.id); if (i >= 0) S.tickets[i] = fresh; if (S.cur && S.cur.t && S.cur.t.id === t.id) S.cur.t = fresh;
}
/* görüntüleyici açılınca: uygunsa bir kez otomatik dene */
async function phAutoFetch(t) {
  if (!phAuto() || !phEligible(t) || PH_BUSY.has(t.id) || !navigator.onLine) return;
  const h = t.hph; if (h && (h.id || h.off || (h.none && Date.now() - h.none < 30 * 864e5))) return;
  PH_BUSY.add(t.id);
  try {
    const cs = await placeCands(t), best = cs.find(c => c.sim >= .5);
    if (best) { await phFromCand(t, best); if (S.view === 'view' && S.cur && S.cur.t && S.cur.t.id === t.id) quietRender(); }
    else if (cs.length || hasC(t)) await phMark(t, { none: Date.now() });
  } catch (e) {} finally { PH_BUSY.delete(t.id); }
}
async function phBlob(t) { if (!t.hph || !t.hph.id) return null; const p = await getOne('pages', t.hph.id); return p && p.blob; }
async function fillVhero(t) {
  const el = $('#app .vhero[data-hph]') || $('.vhero[data-hph]:not(.ghost *)'); if (!el) return; const b = await phBlob(t);
  if (!b) { /* sayfa kayıp (eski yedekten geri yükleme): kaydı temizle → harita + yeniden indirme */ if (t.hph && t.hph.id && !PH_BUSY.has(t.id)) { await phMark(t, t.hph.src === 'own' ? { off: 1 } : null); if (S.view === 'view' && S.cur && S.cur.t && S.cur.t.id === t.id) quietRender(); } return; }
  if (!el.isConnected) return;
  el.style.backgroundImage = `linear-gradient(180deg,rgba(0,0,0,.42) 0%,rgba(0,0,0,0) 32%,rgba(0,0,0,.1) 50%,rgba(0,0,0,.7) 100%),url('${blobURL('hp:' + t.id + ':' + b.size, b)}')`;
  el.classList.add('hasph');
  const cp = t.hph.cpos; if (cp) { const d = await imgDims(b); if (d) { el._cov = { cp, d }; el.dataset.cdone = '1'; placeCover(el); } }
}
/* Değiştir penceresi: adaylar + Galeriden / Harita / Hizala */
async function placePhotoSheet(t) {
  const ov = document.createElement('div'); ov.className = 'ov';
  const has = !!(t.hph && t.hph.id);
  ov.innerHTML = TL`<div class="dlg pps"><h3>Başlık fotoğrafı</h3><p class="calh">${esc(t.title || '')}</p>
    <div class="ppg" id="ppg"><div class="ppl">${I('loader-2')} Fotoğraflar aranıyor…</div></div>
    <div class="ppo"><button class="btn" data-a="gal">${I('photo-plus')} Galeriden</button><button class="btn" data-a="map">${I('map')} Harita</button>${has ? TL`<button class="btn" data-a="align">${I('arrows-move')} Hizala</button>` : ''}</div>
    <p class="ppn">Wikipedia/Wikimedia Commons'tan serbest lisanslı fotoğraflar · yalnız yerin adı ve konumu gönderilir</p>
    <div class="row2"><button class="btn" data-a="x">Kapat</button></div></div>`;
  document.body.appendChild(ov);
  let cands = [];
  const fill = async () => {
    const g = $('#ppg', ov); if (!navigator.onLine) { g.innerHTML = TL`<div class="ppl">İnternet yok</div>`; return; }
    try { cands = await placeCands(t); } catch (e) { cands = []; }
    if (!ov.isConnected) return;
    g.innerHTML = cands.length ? cands.map((c, i) => `<button class="ppi" data-c="${i}" style="background-image:url('${esc(c.thumb)}')" aria-label="${esc(c.title)}"></button>`).join('') : TL`<div class="ppl">Bu yer için fotoğraf bulunamadı</div>`;
  };
  fill();
  const act = await new Promise(res => { dlgClose = () => res('x'); ov.addEventListener('click', e => { const c = e.target.closest('[data-c]'); if (c) return res('c' + c.dataset.c); const bt = e.target.closest('[data-a]'); if (bt) res(bt.dataset.a); else if (e.target === ov) res('x'); }); });
  ov.remove(); dlgClose = null;
  try {
    if (act[0] === 'c') { busy(TX('Fotoğraf indiriliyor…')); try { t = await phFromCand(t, cands[+act.slice(1)]); } finally { busy(false); } render(); }
    else if (act === 'gal') {
      const fs = await pickFiles('image/*', false); if (!fs.length) return;
      busy(TX('Fotoğraf ekleniyor…')); try { t = await phSave(t, fs[0], { src: 'own' }); } finally { busy(false); }
      render(); const cp = await alignDialog(await phBlob(t), null, TX('Fotoğrafı hizala')); if (cp) await phSetPos(t, cp);
    } else if (act === 'map') { await phMark(t, { off: 1 }); render(); }
    else if (act === 'align') { const cp = await alignDialog(await phBlob(t), t.hph.cpos, TX('Fotoğrafı hizala')); if (cp !== undefined) await phSetPos(t, cp); }
  } catch (e) { toast(TX('Fotoğraf alınamadı')); }
}
async function phSetPos(t, cp) {
  const fresh = await getOne('tickets', t.id) || t; if (!fresh.hph || !fresh.hph.id) return;
  if (cp) fresh.hph.cpos = cp; else delete fresh.hph.cpos;
  await saveTicketDB(fresh, [], []); const i = S.tickets.findIndex(x => x.id === t.id); if (i >= 0) S.tickets[i] = fresh; if (S.cur && S.cur.t && S.cur.t.id === t.id) S.cur.t = fresh; render();
}
async function tripsData() { TRIPS_READY = 2; await getTP(); await getPacks(); await getShop(); await getExp(); await getFx(); await getDocs(); await loadVisa(); await loadWorld(); }
async function openTrip(name) {
  await tripsData();
  for (const it of (TP[name] || { items: [] }).items) await photoBlob(it.id);
  S.tripName = name; S.retTrip = name; go('trip');
}
/* 5.19/5.20 gün koçanları (A): seyahat sayfasında ve Biletler'de aynı görünüm */
function dayStubHtml({ key, day, list, lab, chips = '', open, pastD, cards, icon }) {
  const icons = [...new Set(list.map(t => t.type))].slice(0, 5).map(k => I(typeOf(k).ic)).join('');
  let blk;
  if (day) { const [, m, d] = day.split('-').map(Number), [y] = day.split('-').map(Number); blk = `<small>${esc(MONTH_TR[m - 1].slice(0, 3).toLocaleUpperCase(LANG))}</small><b>${d}</b><small>${esc(new Date(y, m - 1, d).toLocaleDateString(LOC, { weekday: 'short' }))}</small>`; }
  else blk = I(icon || 'bookmark');
  const rep = day && !pastD && S.wx !== false ? (list.find(t => t.type !== 'ucak' && wxLocFor(t, day)) || list.find(t => wxLocFor(t, day))) : null;
  return `<div class="dstub${open ? ' open' : ''}${pastD ? ' pastd' : ''}${day ? '' : ' und'}" data-dk="${esc(key)}">
    <button class="dsh"><span class="ddb">${blk}</span>
    <span class="dsm"><b>${esc(lab)}</b><small>${esc(day ? TL`${list.length} etkinlik` : TL`${list.length} yer · tarihsiz`)}</small><span class="dsi">${icons}${chips}</span></span>
    ${rep ? `<span class="dwx" data-day="${day}" data-wx="${esc(rep.id)}"></span>` : ''}<span class="dch">${I('chevron-down')}</span></button>
    <div class="dsc"><div class="dsci">${cards}</div></div></div>`;
}
function tripDays(name, g, ts) {
  const today = todayStr(), S_ = S.dayOpen = S.dayOpen || {};
  const dated = ts.filter(t => t.date), undated = ts.filter(t => !t.date);
  const days = [...new Set(dated.map(t => t.date))];
  const dIdx = d => g.a ? Math.round((new Date(d + 'T12:00') - new Date(g.a + 'T12:00')) / 864e5) + 1 : 0;
  let out = '', i = 0;
  for (const day of days) {
    const list = dated.filter(t => t.date === day), key = name + '|' + day, pastD = (day < today && !list.some(t => (t.endDate || t.date) >= today));
    const open = key in S_ ? S_[key] : day === today;
    const [y, m, d] = day.split('-').map(Number), dl = daysLeft(day), wd = new Date(y, m - 1, d).toLocaleDateString(LOC, { weekday: 'short' });
    const n = dIdx(day), lab = [n > 0 ? TL`${n}. gün` : '', dl === 0 ? TX('Bugün') : dl === 1 ? TX('Yarın') : ''].filter(Boolean).join(' · ') || `${wd} ${d}`;
    out += dayStubHtml({ key, day, list, lab, open, pastD, cards: list.map(t => card(t, (t.endDate || t.date) < today, i++, 'dl')).join('') });
  }
  if (undated.length) {
    const key = name + '|-', open = key in S_ ? S_[key] : false;
    out += dayStubHtml({ key, day: '', list: undated, lab: TX('Gezilecekler'), open, cards: undated.map(t => card(t, false, i++, 'list')).join('') });
  }
  return out;
}
function bindDays(root) {
  $$('.dstub > .dsh', root).forEach(b => b.onclick = () => {
    const st = b.parentElement, o = !st.classList.contains('open'); st.classList.toggle('open', o);
    (S.dayOpen = S.dayOpen || {})[st.dataset.dk] = o; tick();
    if (o) revealDay(st);
  });
}
/* 5.23.2: açılan günün içeriği ekran dışında kalmasın — gerektiği kadar kaydır, başlık üstten çıkmasın */
function revealDay(st) {
  /* sayfa, içerik büyümeden aşağı kayamaz → açılma geçişi bitince (en geç 380 ms) kaydır */
  const dsc = $('.dsc', st); let done = false;
  const run = () => { if (done) return; done = true; if (dsc) dsc.removeEventListener('transitionend', run); if (st.isConnected && st.classList.contains('open')) doReveal(st); };
  if (dsc) dsc.addEventListener('transitionend', run); setTimeout(run, 380);
}
function doReveal(st) {
  {
    const inner = $('.dsci', st); if (!inner) return;
    const head = $('.dsh', st), r = st.getBoundingClientRect();
    const full = head.offsetHeight + inner.scrollHeight + 16;
    const nav = $('.tabs'), fab = $('.fab');
    let bottom = innerHeight - 12;
    if (nav) bottom = Math.min(bottom, nav.getBoundingClientRect().top - 8);
    if (fab) bottom = Math.min(bottom, fab.getBoundingClientRect().top - 8);
    const over = r.top + full - bottom; if (over <= 0) return;
    const bar = $('#app .top') || $('#app .bar'), topPad = (bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0) + 8;
    const dy = Math.min(over, r.top - topPad); if (dy <= 0) return;
    window.scrollBy({ top: dy, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}
function renderTrip(app, anim) {
  const name = S.tripName, g = allTrips().find(x => x.name === name);
  if (!g) { S.retTrip = null; go('home', 'back'); return; }
  const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5), today = todayStr(), key = t => (t.date || '9999') + 'T' + (t.time || '99:99');
  const ts = S.tickets.filter(t => t.trip === name).sort((a, b) => key(a) < key(b) ? -1 : 1);
  const [yy, mm] = (g.a || today).split('-').map(Number);
  const n = g.a ? dayDiff(today, g.a) : null;
  const kick = [g.a ? `${MONTH_TR[mm - 1].toLocaleUpperCase(LANG)} ${yy}` : '', g.past ? TX('BİTTİ') : n > 1 ? TL`${n} GÜN KALDI` : n === 1 ? TX('YARIN') : g.a && g.a <= today ? TX('ŞU AN SEYAHATTESİN') : ''].filter(Boolean).join(' · ');
  const r = (TP && TP[name]) || { items: [] }, ph = r.items;
  const rot = i => [-3, 2, -1.5, 2.5, -2, 1][i % 6];
  const strip = ph.map((p, i) => `<button class="pol" data-ph="${esc(p.id)}" style="--r:${rot(i)}deg"><span class="pimg" style="background-image:url('${PHB.get(p.id) ? blobURL('ph:' + p.id, PHB.get(p.id)) : ''}')"></span>${r.cover === p.id ? '<i class="pcov">KAPAK</i>' : ''}<small>${esc([p.date ? wxDayLabel(p.date) : '', p.note].filter(Boolean).join(' · '))}</small></button>`).join('')
    + (ph.length < PHOTO_MAX ? `<button class="pol padd2" id="phAdd">${I('camera-plus')}<span>${ph.length ? TX('Ekle') : TX('Anı ekle')}</span></button>` : '');
  const pc = packCount(name), foreign = tripForeign(name), ended = ts.some(t => t.date && hasEnded(t)), sc = shopCount(name);
  const tile = (id, ic, label, cls = '', badge = 0) => `<button class="tic ${cls}" id="${id}"><span class="tib">${I(ic)}${badge === '!' || badge > 0 ? `<i class="tbd">${badge > 99 ? '99+' : badge}</i>` : ''}</span><small>${esc(label)}</small></button>`;
  const vw = tripCCs(name).length && !g.past ? worstOf(visaCheck(name)) : null;
  const phl = tripPhrLang(name);
  const tiles = [
    tile('tmPack', 'briefcase', TX('Bavul'), pc && pc[0] === pc[1] ? 'ok' : '', pc ? pc[1] - pc[0] : 0),
    tile('tmShop', 'shopping-cart', TX('Alınacak'), sc && sc[0] === sc[1] ? 'ok' : '', sc ? sc[1] - sc[0] : 0),
    tile('tmExp', 'cash', TX('Masraf')),
    tripCCs(name).length ? tile('tmVisa', 'id', vw && vw.lvl !== 'ok' ? TX('Vize') : TX('Vize ✓'), vw ? vw.lvl : 'ok', vw && vw.lvl === 'err' ? '!' : 0) : '',
    foreign ? tile('tmInfo', 'info-circle', TX('Bilgi')) : '',
    !g.past ? tile('tmSug', 'map-search', TX('Öneriler')) : '',
    ended ? tile('tmCard', 'photo', TX('Kartpostal')) : '',
    tile('tmPdf', 'file-text', TX('PDF')),
    phl ? tile('tmLang', 'language', capFirst(langName(phl.l))) : tile('tmMem', 'camera', TX('Anılar'), '', 0),
  ].filter(Boolean);
  const kd = kindOf(tripKind(name)), hasCov = ph.length > 0, art = hasCov || !artReady() ? '' : tripMapSvg(name), flags = tripFlags(name);
  const memSec = ph.length ? TL`<div class="tsec" id="tpMem"><b>Anılar</b><span>${ph.length} / ${PHOTO_MAX}</span></div><div class="pstrip">${strip}</div>` : '';
  const plan = ts.length ? tripDays(name, g, ts) : TX('<p class="snote">Henüz bilet yok.</p>');
  app.innerHTML = TL`<div class="page tripp${animCls(anim)}">
    <div class="tph thero${hasCov ? ' cov' : ''}" style="--kc:${kd ? kd.c : 'var(--acc)'}"${hasCov ? ` data-cov="${esc(name)}"` : ''}>
      ${art ? `<div class="tart">${art}</div>` : ''}
      <div class="tpbar"><button class="icon-btn" id="back" aria-label="Geri">←</button><span class="tpbr"><button class="tcovb" id="${ph.length ? 'tpPh' : 'phAdd'}">${I(ph.length ? 'photo' : 'camera-plus')} ${ph.length ? TL`${ph.length}/${PHOTO_MAX} anı` : TL`Kapak ekle · 0/${PHOTO_MAX}`}</button><button class="icon-btn" id="tpMenu" aria-label="Seyahat menüsü">${I('dots')}</button></span></div>
      <div class="thb">${flags ? `<div class="tflag">${flags}</div>` : ''}
      <button class="tkind" id="tpKind" style="--kc:${(kd || { c: 'var(--muted)' }).c}">${kd ? `${I(kd.ic)} ${esc(kd.n)}` : TL`${I('plus')} Tip seç${guessKind(name) ? ` · ${esc(kindOf(guessKind(name)).n)}?` : ''}`}</button>
      ${kick ? `<div class="tpk">${esc(kick)}</div>` : ''}<h1 class="tpn">${esc(name)}</h1>
      <div class="tps">${esc(g.a ? (g.e && g.e !== g.a ? fmtRange(g.a, g.e) : fmtDate(g.a)) : TX('Tarihsiz'))} · ${ts.length} bilet</div></div></div>
    <div class="sbody">
      <div class="tgrid">${tiles.join('')}</div>
      ${g.past ? memSec : ''}
      <div class="tsec"><b>Plan</b>${ts.some(t => ticketLocs(t).some(l => hasC(l) || l.address || l.url)) ? TL`<button id="tpRoute">${I('route')} Rota</button>` : ''}</div>
      <div class="tplan">${plan}</div>
      ${!g.past ? TL`<div class="tadd2"><button class="card st-add" id="tpAdd">${I('plus')}<span>Bu seyahate ekle</span></button><button class="card st-add" id="tpQuick">${I('map-pin')}<span>Gezilecek yer</span></button></div>` : ''}
      ${!g.past ? memSec : ''}
    </div></div>`;
  $('#back').onclick = () => { S.retTrip = null; go('home', 'back'); };
  $('#tpMenu').onclick = () => tripMenu(name, true);
  $('#tpKind').onclick = () => pickTripKind(name);
  const pa = $('#phAdd'); if (pa) pa.onclick = () => addTripPhotos(name);
  const goMem = () => { const m = $('#tpMem'); if (m) m.scrollIntoView({ behavior: 'smooth', block: 'start' }); else addTripPhotos(name); };
  const tpp = $('#tpPh'); if (tpp) tpp.onclick = goMem;
  fillCovers(app);
  $$('[data-ph]').forEach(b => {
    let tm = null, long = false;
    b.addEventListener('pointerdown', () => { long = false; tm = setTimeout(() => { long = true; try { navigator.vibrate && navigator.vibrate(15); } catch (e) {} photoMenu(name, b.dataset.ph); }, 450); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(tm)));
    b.addEventListener('contextmenu', e => e.preventDefault());
    b.onclick = () => { if (long) return; const ids = ph.map(p => p.id); openLightbox(ids.map(id => PHB.get(id)).filter(Boolean), ids.indexOf(b.dataset.ph)); };
  });
  const on = (id, f) => { const e = $('#' + id); if (e) e.onclick = f; };
  on('tmPack', () => openPack(name)); on('tmShop', () => openShop(name)); on('tmExp', () => openExp(name)); on('tmPdf', () => pdfDialog(name)); on('tmVisa', () => tripVisaSheet(name)); on('tmInfo', () => openCInfo(name)); on('tmCard', () => tripPostcard(name)); on('tmSug', () => tripSuggest(name)); on('tmMem', goMem); on('tmLang', () => openPhr(name));
  on('tpRoute', () => tripRoute(name)); on('tpAdd', () => addNew(name)); on('tpQuick', () => quickPlace(name));
  $$('.tplan .card').forEach(c => bindCardPress(c, () => openTicket(c.dataset.id)));
  bindDays(app); fillDayWx(app);
  fillCardWx(app);
}

/* ---------- seyahat kartpostalı (paylaşılabilir görsel) ---------- */
async function tripPostcard(name) {
  busy(TX('Kartpostal hazırlanıyor…'));
  try {
    await loadWorld();
    const g = allTrips().find(x => x.name === name) || {};
    const days = g.a ? nightsBetween(g.a, g.e || g.a) + 1 : 0;
    const st = statsFor(S.tickets.filter(t => t.trip === name), days);
    const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
    const C = { bg: '#FAF6EF', ink: '#3B2A1E', mut: '#A8846A', acc: '#C2410C', teal: '#0F766E', land: '#EADFCF', vis: '#F0B79A' };
    const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d'), serif = 'Georgia, "Noto Serif", serif', sans = 'system-ui, -apple-system, Roboto, sans-serif';
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    x.strokeStyle = C.land; x.lineWidth = 4; x.strokeRect(36, 36, W - 72, H - 72);
    // tarih ve ad
    const [yy, mm] = (g.a || todayStr()).split('-').map(Number);
    x.fillStyle = C.mut; x.font = `600 34px ${sans}`; x.letterSpacing = '6px'; x.fillText(`${MONTH_TR[mm - 1].toLocaleUpperCase(LANG)} ${yy}`, 96, 150); x.letterSpacing = '0px';
    let fs = 132; x.font = `500 ${fs}px ${serif}`; while (x.measureText(name).width > W - 400 && fs > 56) { fs -= 6; x.font = `500 ${fs}px ${serif}`; }
    x.fillStyle = C.ink; x.fillText(name, 92, 150 + fs + 20);
    // damga: gün sayısı
    x.save(); x.translate(W - 190, 220); x.rotate(0.14); x.strokeStyle = C.teal; x.fillStyle = C.teal; x.lineWidth = 6;
    x.beginPath(); x.arc(0, 0, 92, 0, Math.PI * 2); x.stroke(); x.lineWidth = 2; x.beginPath(); x.arc(0, 0, 78, 0, Math.PI * 2); x.stroke();
    x.textAlign = 'center'; x.font = `600 64px ${serif}`; x.fillText(String(days || st.done.length), 0, 14); x.font = `700 24px ${sans}`; x.fillText(days ? TX('GÜN') : TX('BİLET'), 0, 50); x.restore();
    // satırlar
    const lines = [
      st.places && TL`${st.places} yer`, st.fl.length && TL`${st.fl.length} uçuş · ${fmtN(st.km)} km`, st.museums && TL`${st.museums} müze ve etkinlik`,
      st.cities.length && st.cities.slice(0, 3).join(', '),
    ].filter(Boolean);
    let ly = 150 + fs + 120; x.textAlign = 'left';
    for (const [i, l] of lines.entries()) { x.fillStyle = i === lines.length - 1 && st.cities.length ? C.mut : C.ink; x.font = `${i === lines.length - 1 && st.cities.length ? 'italic 500 44px ' + serif : '500 52px ' + sans}`; x.fillText(l, 96, ly); ly += 78; }
    // harita
    const mx = 96, my = Math.max(ly + 10, 760), mw = W - 192, mh = H - my - 190;
    const covB = await tripCoverBlob(name);
    if (covB) {
      const im = await createImageBitmap(covB), sc2 = Math.max(mw / im.width, mh / im.height), dw = im.width * sc2, dh = im.height * sc2;
      x.save(); x.beginPath(); x.roundRect ? x.roundRect(mx, my, mw, mh, 28) : x.rect(mx, my, mw, mh); x.clip(); x.drawImage(im, mx + (mw - dw) / 2, my + (mh - dh) / 2, dw, dh); x.restore();
    } else if (window.WORLD && (st.pts.length || st.arcs.length)) {
      const Wd = WORLD, P = (lat, lon) => wproj(lat, lon, Wd);
      const xy = [...st.pts.map(p => P(p.lat, p.lon)), ...st.arcs.flatMap(([a, b]) => [P(a.lat, a.lon), P(b.lat, b.lon)])];
      let x0 = Math.min(...xy.map(p => p[0])), x1 = Math.max(...xy.map(p => p[0])), y0 = Math.min(...xy.map(p => p[1])), y1 = Math.max(...xy.map(p => p[1]));
      let w = Math.max(x1 - x0, 40) * 1.5, h = Math.max(y1 - y0, 24) * 1.6; if (w / h < mw / mh) w = h * mw / mh; else h = w * mh / mw;
      const sc = mw / w, ox = (x0 + x1) / 2 - w / 2, oy = (y0 + y1) / 2 - h / 2;
      x.save(); x.beginPath(); x.roundRect ? x.roundRect(mx, my, mw, mh, 28) : x.rect(mx, my, mw, mh); x.clip();
      x.fillStyle = '#F4ECDF'; x.fillRect(mx, my, mw, mh);
      x.setTransform(sc, 0, 0, sc, mx - ox * sc, my - oy * sc);
      const vis = new Set(st.countries.map(c => c.cc));
      for (const [cc, c] of Object.entries(Wd.c)) { x.fillStyle = vis.has(cc) ? C.vis : C.land; x.fill(new Path2D(c.d)); }
      x.lineWidth = 3.2 / sc; x.setLineDash([8 / sc, 6 / sc]); x.strokeStyle = C.acc;
      for (const [a, b] of st.arcs) { const p = P(a.lat, a.lon), q = P(b.lat, b.lon), cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2 - Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.28; x.beginPath(); x.moveTo(p[0], p[1]); x.quadraticCurveTo(cx, cy, q[0], q[1]); x.stroke(); }
      x.setLineDash([]); x.fillStyle = C.ink;
      for (const p of [...st.pts, ...st.arcs.flat()]) { const [px, py] = P(p.lat, p.lon); x.beginPath(); x.arc(px, py, 7 / sc, 0, Math.PI * 2); x.fill(); }
      x.restore();
    }
    // alt bilgi
    x.fillStyle = C.mut; x.font = `600 30px ${sans}`; x.fillText(TX('DoraGo'), 96, H - 96);
    x.fillStyle = C.acc; x.beginPath(); (x.roundRect ? x.roundRect(W - 96 - 84, H - 128, 84, 52, 8) : x.rect(W - 180, H - 128, 84, 52)); x.fill();
    x.fillStyle = C.bg; x.font = `700 28px ${serif}`; x.textAlign = 'center'; x.fillText(TX('Go'), W - 96 - 42, H - 92);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    busy(false);
    showPostcard(name, blob);
  } catch (e) { console.error(e); busy(false); toast(TX('Görsel hazırlanamadı')); }
}
function showPostcard(name, blob) {
  const url = URL.createObjectURL(blob), ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = TL`<div class="dlg pcd"><img src="${url}" alt="${esc(name)} kartpostalı"><div class="row2"><button class="btn" data-a="0">Kapat</button><button class="btn pri" data-a="1">${I('share')} Paylaş</button></div></div>`;
  const close = () => { ov.remove(); dlgClose = null; URL.revokeObjectURL(url); };
  ov.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) { if (e.target === ov) close(); return; }
    if (b.dataset.a !== '1') return close();
    const fname = TL`DoraGo-${name.replace(/[^\p{L}\p{N} ]/gu, '').trim().replace(/\s+/g, '-') || 'seyahat'}.png`;
    if (A && A.shareImages) { S.pickAt = Date.now(); A.shareImages(name, 'png:' + B64.enc(await blob.arrayBuffer())); return; }
    const f = new File([blob], fname, { type: 'image/png' });
    try { if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return; } } catch (er) { if (er.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  });
  dlgClose = close; document.body.appendChild(ov);
}

/* ================= gerçekleşme takibi (5.4) ================= */
const ST = { done: { l: TX('GİDİLDİ'), n: TX('Gidildi'), ic: 'check' }, missed: { l: TX('KAÇIRILDI'), n: TX('Gidilmedi'), ic: 'x' }, cancel: { l: TX('İPTAL'), n: TX('İptal edildi'), ic: 'ban' } };
const DUR_H = { muze: 2, etkinlik: 2.5, yemek: 1.5, gezi: 2, ulasim: 3, ucak: 3, diger: 2 };
/* biletin bittiği an: bitiş saati, yoksa türüne göre tahmini süre; konaklamada çıkış */
function endAt(t) {
  if (!t.date) return null;
  if (t.type === 'konaklama') return t.endDate ? at(t.endDate, t.endTime || '11:00') : at(t.date, '23:59');
  if (!t.time) return at(t.date, '23:59');
  if (t.type !== 'ucak' && t.endTime && t.endTime > t.time) return at(t.date, t.endTime);
  return at(t.date, t.time) + (DUR_H[t.type] || 2) * 3600000;
}
const ASK_WIN = 3 * 86400000;
const hasEnded = t => { const e = endAt(t); return e != null && e <= Date.now(); };
const needsAsk = t => !t.status && hasEnded(t) && Date.now() - endAt(t) < ASK_WIN;
async function autoAssume() {
  const now = Date.now();
  for (const t of S.tickets) {
    const e = endAt(t);
    if (!t.status && e != null && now - e >= ASK_WIN) { t.status = 'done'; t.statusAuto = true; try { await saveTicketDB(t, [], []); } catch (er) {} }
  }
}
function askLabel(a = S.askN || {}) { return a.m === 'off' ? TX('Kapalı') : a.m === 'morning' ? TL`Ertesi sabah ${a.t || '09:00'}` : TL`Günün son etkinliğinden ${a.h || 2} saat sonra`; }
async function setStatus(ids, st, opt = {}) {
  const ts = S.tickets.filter(t => ids.includes(t.id));
  for (const t of ts) {
    if (st) t.status = st; else delete t.status;
    t.statusAuto = !!opt.auto; if (!opt.auto) delete t.statusAuto;
    if (st !== 'cancel' && t.refund && t.refund.state === 'wait') delete t.refund;
    t.updatedAt = Date.now();
    await saveTicketDB(t, [], []);
  }
  if (!opt.quiet) toast(ts.length > 1 ? TL`${ts.length} bilet: ${st ? ST[st].n.toLocaleLowerCase(LANG) : TX('durum temizlendi')}` : st ? ST[st].n : TX('Durum temizlendi'));
  syncReminders(true); render();
  if (st === 'cancel' && ts.length === 1 && !opt.noRefund) await refundDialog(ts[0]);
}
async function statusMenu(t) {
  const ended = hasEnded(t), items = [];
  if (ended) items.push({ icon: I('check'), label: TX('Gidildi'), value: 'done' }, { icon: I('x'), label: TX('Gidilmedi / kaçırıldı'), value: 'missed' });
  items.push({ icon: I('ban'), label: TX('İptal edildi'), sub: TX('İade takibi eklenebilir'), value: 'cancel' });
  if (t.date) items.push({ icon: I('calendar-event'), label: TX('Ertelendi'), sub: TX('Yeni tarihe taşı'), value: 'move' });
  if (t.status) items.push({ icon: I('refresh'), label: TX('Durumu temizle'), value: 'clear' });
  const v = await sheetMenu(t.title || (t.from && t.to ? `${t.from} → ${t.to}` : typeOf(t.type).n), items); if (!v) return;
  if (v === 'move') return postpone(t);
  await setStatus([t.id], v === 'clear' ? '' : v);
}
function postpone(t) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = TL`<div class="dlg"><h3>Yeni tarih</h3><p>${esc(t.title || typeOf(t.type).n)} bu tarihe taşınacak.</p>
      <div class="row2 tdd"><div class="fld"><label for="ppD">Tarih</label><input class="inp" id="ppD" type="date" value="${esc(t.date)}"></div><div class="fld"><label for="ppT">Saat</label><input class="inp" id="ppT" type="time" value="${esc(t.time || '')}"></div></div>
      <div class="row2"><button class="btn" data-a="0">Vazgeç</button><button class="btn pri" data-a="1">Taşı</button></div></div>`;
    const close = () => { ov.remove(); dlgClose = null; res(); };
    ov.addEventListener('click', async e => {
      const b = e.target.closest('[data-a]'); if (!b) { if (e.target === ov) close(); return; }
      if (b.dataset.a === '1') {
        const nd = $('#ppD', ov).value, nt = $('#ppT', ov).value; if (!nd) return;
        if (t.endDate) { const sh = nightsBetween(t.date, nd); t.endDate = addDays(t.endDate, sh); }
        t.date = nd; if (nt) t.time = nt; delete t.status; delete t.statusAuto; t.updatedAt = Date.now();
        await saveTicketDB(t, [], []); toast(TL`${fmtDate(nd)} tarihine taşındı`); syncReminders(); render();
      }
      close();
    });
    dlgClose = close; document.body.appendChild(ov);
  });
}
const CUR = [['TRY', '₺'], ['GBP', '£'], ['EUR', '€'], ['USD', '$']];
const curSym = c => (CUR.find(x => x[0] === c) || [c, typeof curSymbol === 'function' ? curSymbol(c) : c])[1];
const refundTxt = r => { const n = daysLeft(r.due); return `${r.amt ? `${r.amt} ${curSym(r.cur)} · ` : ''}${n > 1 ? TL`${n} gün` : n === 1 ? TX('yarın son gün') : n === 0 ? TX('bugün son gün') : TL`${-n} gün gecikti`}`; };
function refundDialog(t) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    const r = t.refund || {};
    ov.innerHTML = TL`<div class="dlg"><h3>İade bekleniyor mu?</h3><p>Takip edeyim: süre dolmadan hatırlatırım, gelince "alındı" dersin.</p>
      <div class="row2 tdd"><div class="fld"><label for="rfA">Tutar</label><input class="inp" id="rfA" inputmode="decimal" placeholder="120" value="${esc(r.amt || '')}"></div>
        <div class="fld"><label for="rfC">Para birimi</label><select class="inp" id="rfC">${[...new Set([baseCur(), r.cur || baseCur(), ...CUR.map(x => x[0])])].map(c => `<option value="${c}" ${(r.cur || baseCur()) === c ? 'selected' : ''}>${curSym(c) !== c ? curSym(c) + ' ' : ''}${c}</option>`).join('')}</select></div></div>
      <div class="fld"><label for="rfD">Ne zamana kadar gelmeli?</label><select class="inp" id="rfD">${[7, 14, 30, 45, 60, 90].map(d => TL`<option value="${d}" ${d === 30 ? 'selected' : ''}>${d} gün içinde</option>`).join('')}</select></div>
      <div class="row2"><button class="btn" data-a="0">İade yok</button><button class="btn pri" data-a="1">Takip et</button></div></div>`;
    const close = () => { ov.remove(); dlgClose = null; res(); };
    ov.addEventListener('click', async e => {
      const b = e.target.closest('[data-a]'); if (!b) { if (e.target === ov) close(); return; }
      if (b.dataset.a === '1') {
        t.refund = { amt: $('#rfA', ov).value.trim().replace(',', '.'), cur: $('#rfC', ov).value, due: addDays(todayStr(), +$('#rfD', ov).value), state: 'wait' };
        t.updatedAt = Date.now(); await saveTicketDB(t, [], []); toast(TX('İade takipte')); syncReminders(true); render();
      }
      close();
    });
    dlgClose = close; document.body.appendChild(ov);
  });
}
async function refundDone(t) { t.refund.state = 'got'; t.refund.got = todayStr(); t.updatedAt = Date.now(); await saveTicketDB(t, [], []); toast(TX('İade alındı')); syncReminders(true); render(); }
/* toplu kontrol ekranı: seyahat sonu ya da "tek tek seç" */
function reviewDialog(ts, title, sub) {
  return new Promise(res => {
    const sel = new Map(ts.map(t => [t.id, t.status && !t.statusAuto ? t.status : 'done']));
    const ov = document.createElement('div'); ov.className = 'ov rvov';
    const row = t => { const v = sel.get(t.id); return `<div class="rvr" data-id="${esc(t.id)}"><span class="rvn"><b>${esc(t.type === 'ucak' && t.from && t.to ? `${t.from} → ${t.to}${t.flightNo ? ' · ' + t.flightNo : ''}` : t.title || typeOf(t.type).n)}</b><small>${esc(t.date ? fmtDate(t.date) : '')}${t.time ? ' · ' + esc(t.time) : ''}</small></span>${['done', 'missed', 'cancel'].map(k => `<button class="rvb ${v === k ? 'on s-' + k : ''}" data-v="${k}" aria-label="${ST[k].n}">${I(ST[k].ic)}</button>`).join('')}</div>`; };
    const sum = () => { const c = { done: 0, missed: 0, cancel: 0 }; for (const v of sel.values()) c[v]++; return [c.done && `${c.done} gidildi`, c.missed && TL`${c.missed} kaçtı`, c.cancel && `${c.cancel} iptal`].filter(Boolean).join(', '); };
    const draw = () => { ov.innerHTML = TL`<div class="dlg sheet rv"><div class="rvh"><small>${esc(sub || '')}</small><b>${esc(title)}</b></div><div class="rvl">${ts.map(row).join('')}</div>
      <div class="row2"><button class="btn" data-a="0">Sonra</button><button class="btn pri" data-a="1">Kaydet · ${esc(sum())}</button></div></div>`; };
    draw();
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    ov.addEventListener('click', async e => {
      const rb = e.target.closest('.rvb'); if (rb) { sel.set(rb.closest('.rvr').dataset.id, rb.dataset.v); const y = $('.rvl', ov).scrollTop; draw(); $('.rvl', ov).scrollTop = y; return; }
      const b = e.target.closest('[data-a]'); if (!b) { if (e.target === ov) close(false); return; }
      if (b.dataset.a !== '1') return close(false);
      ov.remove(); dlgClose = null;
      const newC = [];
      for (const t of ts) { const v = sel.get(t.id); if (v === 'cancel' && t.status !== 'cancel') newC.push(t); t.status = v; delete t.statusAuto; if (v !== 'cancel' && t.refund && t.refund.state === 'wait') delete t.refund; t.updatedAt = Date.now(); await saveTicketDB(t, [], []); }
      toast(TL`Kaydedildi · ${sum()}`); syncReminders(true); render();
      for (const t of newC) await refundDialog(t);
      res(true);
    });
    dlgClose = () => close(false); document.body.appendChild(ov);
  });
}
/* ana ekran üstü: "Gittin mi?", bekleyen iadeler, seyahat sonu kontrolü */
function statusBars() {
  const today = todayStr(), out = [];
  const asks = S.tickets.filter(needsAsk).sort((a, b) => endAt(a) - endAt(b));
  if (asks.length) out.push(TL`<div class="askbar"><div class="abt">${I('help')}<span><b>Gittin mi?</b><small>${esc(asks.slice(0, 3).map(t => t.type === 'ucak' && t.from && t.to ? `${t.from} → ${t.to}` : t.title || typeOf(t.type).n).join(', '))}${asks.length > 3 ? ` +${asks.length - 3}` : ''}</small></span></div>
    <div class="abb"><button class="btn pri" data-ab="done">${asks.length > 1 ? TX('Hepsi gidildi') : TX('Gittim')}</button><button class="btn" data-ab="one">${asks.length > 1 ? TX('Tek tek seç') : TX('Diğer…')}</button></div></div>`);
  const rv = (metaCache.tripReviewed || []);
  for (const g of allTrips()) {
    if (!g.e || g.e >= today || g.e < addDays(today, -14) || rv.includes(g.name)) continue;
    const ts = S.tickets.filter(t => t.trip === g.name && t.date); if (!ts.length) continue;
    out.push(TL`<button class="tripend" data-te="${esc(g.name)}"><small>SEYAHAT BİTTİ</small><b>${esc(g.name)}</b><span>${esc(fmtRange(g.a, g.e))} · ${ts.length} bilet · kontrol et</span></button>`);
  }
  const wy = wrapYearDue(); if (wy) out.push(TL`<button class="wrapbar" data-wrap="${wy}">${I('sparkles')}<span><b>${wy} seyahat yılın hazır</b><small>Yıl özetini izle ve paylaş</small></span><i>›</i></button>`);
  const rf = S.tickets.filter(t => t.status === 'cancel' && t.refund && t.refund.state === 'wait').sort((a, b) => a.refund.due < b.refund.due ? -1 : 1);
  if (rf.length) out.push(`<button class="refbar" data-rf="${esc(rf[0].id)}">${I('receipt-refund')}<span>${rf.length > 1 ? TL`${rf.length} iade bekleniyor · en yakını: ` : TX('İade bekleniyor: ')}<b>${esc(rf[0].title || typeOf(rf[0].type).n)}</b> · ${esc(refundTxt(rf[0].refund))}</span></button>`);
  return out.join('');
}
const metaCache = {};
function bindStatusBars(app) {
  $$('[data-ab]', app).forEach(b => b.onclick = async () => {
    const asks = S.tickets.filter(needsAsk);
    if (b.dataset.ab === 'done') return setStatus(asks.map(t => t.id), 'done');
    if (asks.length === 1) return statusMenu(asks[0]);
    reviewDialog(asks, TX('Gittin mi?'), TX('Son etkinlikler'));
  });
  $$('[data-te]', app).forEach(b => b.onclick = async () => {
    const name = b.dataset.te, ts = S.tickets.filter(t => t.trip === name && t.date).sort((x, y) => endAt(x) - endAt(y));
    if (await reviewDialog(ts, name, TX('Seyahat bitti · kontrol et'))) {
      metaCache.tripReviewed = [...(metaCache.tripReviewed || []), name]; await metaSet('tripReviewed', metaCache.tripReviewed); render();
      if (tripKind(name) !== 'is' && await dialog({ title: TL`${name} kartpostalı`, text: TX('Seyahatin özetini paylaşılabilir bir görsel olarak hazırlayayım mı?'), ok: TX('Hazırla'), cancel: TX('Sonra') })) tripPostcard(name);
    }
  });
  $$('[data-wrap]', app).forEach(b => b.onclick = () => yearWrap(+b.dataset.wrap));
  $$('[data-rf]', app).forEach(b => b.onclick = async () => {
    const rf = S.tickets.filter(t => t.status === 'cancel' && t.refund && t.refund.state === 'wait');
    if (rf.length === 1) return openTicket(rf[0].id);
    const v = await sheetMenu(TX('Bekleyen iadeler'), rf.map(t => ({ icon: I('receipt-refund'), label: t.title || typeOf(t.type).n, sub: refundTxt(t.refund), value: t.id }))); if (v) openTicket(v);
  });
}
function statusCardBits(t) {
  let stamp = '', ask = '', ref = '';
  if (t.status && ST[t.status] && (t.status === 'cancel' || hasEnded(t))) stamp = `<span class="stamp s-${t.status}">${ST[t.status].l}</span>`;
  if (needsAsk(t) && !S.sel) ask = TL`<span class="cask"><span>Gittin mi?</span><span class="cab yes" data-st="done" role="button">${I('check')} Evet</span><span class="cab no" data-st="missed" role="button">${I('x')} Hayır</span></span>`;
  if (t.status === 'cancel' && t.refund) ref = t.refund.state === 'wait' ? TL`<span class="rfch">${I('receipt-refund')} İade bekleniyor · ${esc(refundTxt(t.refund))}</span>` : TL`<span class="rfch got">${I('check')} İade alındı</span>`;
  return { stamp, ask, ref };
}

/* kart üstündeki konum butonu */
function pinBtn(t) {
  const has = ticketLocs(t).some(l => hasC(l) || l.address || l.url);
  return `<span class="cic cpin ${has ? 'on' : ''}" data-pin="${esc(t.id)}" role="button" aria-label="${has ? TX('Konum') : TX('Konum ekle')}">${I(has ? 'map-pin' : 'map-pin-plus')}</span>`;
}
async function pinTap(id, long) {
  const t = S.tickets.find(x => x.id === id); if (!t) return;
  const locs = ticketLocs(t).filter(l => hasC(l) || l.address || l.url);
  if (!locs.length) return addLocMenu(t);
  if (!long && locs.length === 1) return directions(locs[0]);
  const items = [];
  if (t.type === 'ucak' && flightCode(t)) items.push({ icon: I('plane-tilt'), label: TX('Uçuş durumu'), sub: TX('Rötar, kapı, bagaj bandı · Trip.com'), value: { a: 'fs' } });
  for (const [i, l] of locs.entries()) {
    const nm = locs.length > 1 ? ` · ${l.label}` : '';
    items.push({ icon: I('navigation'), label: TX('Yol tarifi') + nm, sub: l.name, value: { a: 'dir', i } });
    if (long) items.push({ icon: I('map'), label: TX('Haritada aç') + nm, value: { a: 'map', i } });
  }
  if (long) {
    items.push({ icon: I('copy'), label: TX('Adresi kopyala'), value: { a: 'copy', i: 0 } });
    if (t.type !== 'ucak') items.push({ icon: I('refresh'), label: TX('Konumu değiştir'), value: { a: 'change' } });
  }
  const v = await sheetMenu(t.title || typeOf(t.type).n, items); if (!v) return;
  const l = locs[v.i];
  if (v.a === 'fs') return openFlightStatus(t, 'trip');
  if (v.a === 'dir') directions(l);
  else if (v.a === 'map') showOnMap(l);
  else if (v.a === 'copy') copyText([l.name, l.address].filter(Boolean).join(', ') + (hasC(l) ? `\n${l.lat}, ${l.lon}` : ''));
  else if (v.a === 'change') addLocMenu(t);
}
async function saveTicketLoc(t, ll, label, approx) {
  t.lat = ll.lat; t.lon = ll.lon; t.locSrc = label || ''; t.locApprox = !!approx; t.updatedAt = Date.now();
  await saveTicketDB(t, [], []); render();
  toast(approx ? TX('Yaklaşık konum eklendi') : TX('Konum eklendi'), 2500);
}
async function addLocMenu(t) {
  if (t.type === 'ucak') { toast(TX('Uçuşlarda konum havalimanından alınır')); return; }
  const geoOK = canGeo() && (t.place || t.title);
  const items = [{ icon: I('map-2'), label: TX('Google Haritalar\'da seç'), sub: TX('Yere dokun → Paylaş → DoraGo'), value: 'g' }];
  if (geoOK) items.push({ icon: I('current-location'), label: TX('Adresten otomatik bul'), sub: t.place || t.title, value: 'geo' });
  items.push({ icon: I('link'), label: TX('Bağlantı yapıştır'), sub: TX('Harita bağlantısı ya da koordinat'), value: 'paste' });
  const v = await sheetMenu(`${t.title || TX('Bilet')} · konum`, items); if (!v) return;
  if (v === 'g') {
    S.locTarget = { id: t.id, at: Date.now() };
    const q = t.title && t.place && t.place.toLowerCase().includes(t.title.toLowerCase()) ? t.place : [t.title, t.place].filter(Boolean).join(', ');
    openUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || 'konum')}`, (mapApps().find(a => a.id === 'google') || {}).pkg || '');
  } else if (v === 'geo') {
    if (S.geocode === false && !await dialog({ title: TX('Adresten konum'), text: TX('Adres OpenStreetMap tabanlı servislere gönderilerek konum aranacak (internet gerekir). Ayarlar\'da bu özellik kapalı, bu sefer için arayayım mı?'), ok: TX('Ara') })) return;
    const tmp = { ...t, auto: null }, prev = S.geocode; if (prev === false) S.geocode = true;
    let st; try { st = await findLocation(tmp, '', true); } finally { if (prev === false) S.geocode = false; }
    if (st === 'ok' || st === 'approx') await saveTicketLoc(t, { lat: tmp.lat, lon: tmp.lon }, tmp.geoLabel, tmp.geoApprox);
    else toast(geoMsg[st] || TX('Konum bulunamadı'), 3500);
  } else if (v === 'paste') {
    const txt = await inputDialog({ title: TX('Bağlantı yapıştır'), placeholder: TX('https://maps.app.goo.gl/… ya da 41.0, 28.9'), ok: TX('Ekle') });
    if (!txt) return;
    const sh = await locFromShare(txt, t);
    if (!sh.ll) { toast(sh.err ? TX('Bağlantı açılamadı. İnternet bağlantını kontrol et.') : TX('Bu bağlantıda konum bulunamadı. ') + shareHelp, 4500); return; }
    await saveTicketLoc(t, sh.ll, sh.name ? TL`Google Haritalar: ${sh.name}` : TX('Bağlantıdan eklendi'), false);
  }
}
/* kart: kısa/uzun dokunma; konum butonu ayrı */
function bindCardPress(c, onTap, onLong) {
  let timer = null, sx0 = 0, sy0 = 0, long = false, onPin = false, pressT = null, scrollY0 = 0;
  const clear = () => { clearTimeout(timer); timer = null; clearTimeout(pressT); c.classList.remove('pressing'); window.removeEventListener('scroll', onScroll, true); };
  const onScroll = () => { if (timer && Math.abs(window.scrollY - scrollY0) > 4) clear(); };
  c.addEventListener('pointerdown', e => {
    long = false; onPin = !!e.target.closest('.cpin') && !S.sel; sx0 = e.clientX; sy0 = e.clientY; clear();
    if (e.target.closest('[data-st]') && !S.sel) return;
    if (e.target.closest('.cfs') && !S.sel) return;
    scrollY0 = window.scrollY; window.addEventListener('scroll', onScroll, true);
    // basılı tutarken kart hafifçe küçülür (kısa dokunuşta görünmesin diye gecikmeli)
    if (onLong || onPin) pressT = setTimeout(() => c.classList.add('pressing'), 140);
    timer = setTimeout(() => { long = true; timer = null; c.classList.remove('pressing'); window.removeEventListener('scroll', onScroll, true); try { getSelection().removeAllRanges(); } catch (er) {} try { navigator.vibrate && navigator.vibrate(15); } catch (er) {} if (onPin) pinTap(c.dataset.id, true); else if (onLong) onLong(); }, 420);
  });
  c.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - sx0, e.clientY - sy0) > 16) clear(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => c.addEventListener(ev, clear));
  c.addEventListener('contextmenu', e => e.preventDefault());
  c.onclick = e => {
    if (long) { long = false; return; }
    if (e.target.closest('.cfs') && !S.sel) { const t = S.tickets.find(z => z.id === c.dataset.id); if (t) openFlightStatus(t, 'trip'); return; }
    const sbt = e.target.closest('[data-st]');
    if (sbt && !S.sel) { const t = S.tickets.find(z => z.id === c.dataset.id); if (t) { if (sbt.dataset.st === 'more') statusMenu(t); else setStatus([t.id], sbt.dataset.st); } return; }
    if (e.target.closest('.cpin') && !S.sel) { pinTap(c.dataset.id, false); return; }
    onTap();
  };
}

/* gün başlığı (G düzeni): tarih, kalan gün ve günün havası bir kez */
const hdrDay = t => { const td = todayStr(); return t.date < td ? td : t.date; };
function dayHead(day, ts, k) {
  const n = daysLeft(day), [y, m, d] = day.split('-').map(Number);
  const wd = new Date(y, m - 1, d).toLocaleDateString(LOC, { weekday: 'short' });
  const dd = `${wd} ${d} ${MONTH_TR[m - 1].slice(0, 3)}`;
  const lab = n === 0 ? TL`<b>Bugün</b><small> · ${dd}</small>` : n === 1 ? TL`<b>Yarın</b><small> · ${dd}</small>` : TL`<b>${dd}</b><small> · ${n} gün</small>`;
  const rep = ts.find(t => t.type !== 'ucak' && wxLocFor(t, day)) || ts.find(t => wxLocFor(t, day));
  return `<div class="dh" style="--k:${k}"><span class="dh-d">${lab}</span>${S.wx !== false && rep ? `<span class="dwx" data-day="${day}" data-wx="${esc(rep.id)}"></span>` : ''}</div>`;
}
/* tarihli yaklaşan biletleri gün başlıklarıyla dizer; cardFn(t, i, mode) */
function dayed(ts, cardFn, past) {
  let out = '', i = 0;
  while (i < ts.length) {
    const t = ts[i];
    if (past || !t.date) { out += cardFn(t, i, 'list'); i++; continue; }
    const day = hdrDay(t); let j = i; while (j < ts.length && ts[j].date && hdrDay(ts[j]) === day) j++;
    out += dayHead(day, ts.slice(i, j), i);
    for (let x = i; x < j; x++) out += cardFn(ts[x], x, 'dl');
    i = j;
  }
  return out;
}

/* kaydırınca başlık satırı yukarı kaybolur; arama çubuğu (varsa) üstte kalır */
function fitTop() {
  const top = $('#app .top'); if (!top) return;
  if (S.sel) { top.style.top = '0px'; return; }
  const safe = Math.max(0, parseFloat(getComputedStyle(top).paddingTop) - 12);
  const q = $('.sbox', top) || $('.search', top);
  const h = q ? q.offsetTop - 8 - safe : top.offsetHeight - safe;
  top.style.top = -Math.max(0, Math.round(h)) + 'px';
}
window.addEventListener('resize', () => { if (S.view === 'home') fitTop(); });

/* sıradaki seyahat alanı (defter, okyanus) */
/* 5.15.1: sıradaki kayıtlar — saatsizler günün sonunda, iptal/kaçan/gidilen hariç, saatsiz yeme-içme/gezi yerleri en sona (giriş ekranı ve ana kart aynı sırayı kullanır) */
function upcoming() {
  const today = todayStr(), key = t => (t.date || '') + 'T' + (t.time || '99:99');
  const list = S.tickets.filter(t => t.date && (t.endDate || t.date) >= today && !['cancel', 'missed', 'done'].includes(t.status)).sort((a, b) => key(a) < key(b) ? -1 : 1);
  const loose = t => !t.time && typeOf(t.type).place;
  return [...list.filter(t => !loose(t)), ...list.filter(loose)];
}
function heroHtml() {
  const today = todayStr();
  const up = upcoming();
  const t0 = up[0]; if (!t0) return '';
  let name, a, e, cnt;
  if (t0.trip) {
    const ts = S.tickets.filter(t => t.trip === t0.trip && t.date);
    a = ts.reduce((m, t) => t.date < m ? t.date : m, t0.date); e = ts.reduce((m, t) => (t.endDate || t.date) > m ? (t.endDate || t.date) : m, a);
    name = t0.trip; cnt = S.tickets.filter(t => t.trip === t0.trip).length;
  } else { name = t0.type === 'ucak' && t0.from && t0.to ? `${apCity(t0.from) || t0.from} → ${apCity(t0.to) || t0.to}` : (t0.title || typeOf(t0.type).n); a = t0.date; e = t0.endDate || t0.date; }
  const n = daysLeft(a), on = n <= 0 && !!t0.trip;
  const day = a < today ? today : a;
  const rep = (t0.trip ? up.filter(t => t.trip === t0.trip) : [t0]).find(t => t.type !== 'ucak' && wxLocFor(t, day)) || t0;
  const sub = [e !== a ? fmtRange(a, e) : fmtDate(a), cnt ? TL`${cnt} bilet` : ''].filter(Boolean).join(' · ');
  const [y, m, d] = t0.date.split('-').map(Number);
  const when = daysLeft(t0.date) === 0 ? TX('Bugün') : daysLeft(t0.date) === 1 ? TX('Yarın') : `${new Date(y, m - 1, d).toLocaleDateString(LOC, { weekday: 'short' })} ${d} ${MONTH_TR[m - 1].slice(0, 3)}`;
  const what = t0.type === 'ucak' && t0.from && t0.to ? `${t0.from} → ${t0.to}${t0.flightNo ? ' · ' + t0.flightNo : ''}` : (t0.title || typeOf(t0.type).n);
  const ready = t0.trip && artReady(), cov = false /* 5.22: sıradaki seyahat kartında hep harita (kapak yalnız seyahat kartlarında) */, art = ready ? tripMapSvg(t0.trip) : '', flags = t0.trip ? tripFlags(t0.trip) : '';
  return `<button class="hero${cov ? ' cov' : ''}" id="hero" data-trip="${esc(t0.trip || '')}" data-id="${esc(t0.id)}"${cov ? ` data-cov="${esc(t0.trip)}"` : ''}>${art ? `<span class="hart">${art}</span>` : ''}
    ${flags ? `<div class="hflag">${flags}</div>` : ''}<div class="hk">${on ? TX('Şu an seyahattesin') : t0.trip ? TX('Sıradaki seyahat') : TX('Sıradaki bilet')}</div>
    <div class="hr"><div class="hn">${esc(name)}</div>${on ? TL`<div class="hc"><b>${I('plane-tilt')}</b><small>şu an</small></div>` : n <= 0 ? TL`<div class="hc"><b>${I(typeOf(t0.type).ic)}</b><small>bugün</small></div>` : `<div class="hc"><b>${n}</b><small>${n === 1 ? TX('gün · yarın') : TX('gün kaldı')}</small></div>`}</div>
    <div class="hs">${esc(sub)}${S.wx !== false ? `<span class="dwx" data-day="${day}" data-wx="${esc(rep.id)}"></span>` : ''}</div>
    ${t0.trip ? TL`<div class="hf">${I(typeOf(t0.type).ic)}<span>Sıradaki · ${esc(when)}${t0.time ? ' ' + esc(t0.time) : ''} · ${esc(what)}</span></div>` : ''}</button>`;
}

function hdrBtns() {
  return TL`<button class="icon-btn" id="btnDocs" aria-label="Belgelerim">${I('id')}</button>` + (S.tickets.length ? TL`<button class="icon-btn" id="btnStats" aria-label="Özet">${I('chart-bar')}</button>` : '') + TL`<button class="icon-btn" id="btnWorld" aria-label="Dünya haritam">${I('world')}</button>`;
}
function bindHdr() {
  const bs = $('#btnStats'); if (bs) bs.onclick = () => go('stats');
  const bd = $('#btnDocs'); if (bd) bd.onclick = () => openDocs();
  const bw = $('#btnWorld'); if (bw) bw.onclick = () => openWorld();
}
function bindHero() {
  const hb = $('#hero'); if (hb) fillCovers(hb); if (hb) hb.onclick = () => {
    const tr = hb.dataset.trip;
    if (tr) { openTrip(tr); return; }
    else openTicket(hb.dataset.id);
  }
}
function renderHome(app, anim) {
  const keepY = anim ? null : window.scrollY;
  const q = S.q.trim().toLocaleLowerCase(LANG);
  const trips = [...new Set(S.tickets.map(t => t.trip).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  if (S.trip && !trips.includes(S.trip)) S.trip = '';
  const list = S.tickets.filter(t =>
    (S.filter === 'all' || t.type === S.filter) && (!S.trip || t.trip === S.trip) && (!S.tkind || (t.trip && tripKind(t.trip) === S.tkind)) &&
    (!q || [t.title, t.trip, t.place, t.notes, t.from, t.to, t.flightNo].join(' ').toLocaleLowerCase(LANG).includes(q)));
  const usedTypes = new Set(S.tickets.map(t => t.type));
  const chips = [{ k: 'all', n: TX('Tümü'), i: '' }, ...TYPES.filter(t => usedTypes.has(t.k))];
  const sel = S.sel;
  const today = todayStr();

  let body = '', n = 0;
  const cardS = (t, past, mode = 'list') => card(t, past, n++, mode).replace('<button class="card ', `<button class="card ${sel ? 'selmode ' : ''}${sel && sel.has(t.id) ? 'selected ' : ''}`);
  if (!S.tickets.length && !(S.trips || []).length) {
    body = TL`<div class="empty"><div class="big">${dot('ticket', 'var(--acc)', 'xl')}</div><h3>Henüz bilet yok</h3>
      <p>PDF, ekran görüntüsü ya da fotoğraf olarak biletlerini ekle. İnternet olmadan da açılırlar.</p>
      <p>${A ? TX('Başka uygulamalardan <b>Paylaş → DoraGo</b> ile de gönderebilirsin.') : ''}</p></div>`;
  } else if (!list.length) {
    body = TX('<div class="empty"><p>Bu filtreye uyan bilet yok.</p></div>');
  } else {
    const { up, nod, past } = sortTickets(list);
    if (up.length) {
      body += TL`<div class="tlh">Yaklaşan · ${up.length} bilet</div>`;
      const S_ = S.dayOpen = S.dayOpen || {}, days = [...new Set(up.map(hdrDay))];
      for (const day of days) {
        const ls = up.filter(t => hdrDay(t) === day), key = 'home|' + day, dl = daysLeft(day);
        const lab = dl === 0 ? TX('Bugün') : dl === 1 ? TX('Yarın') : TL`${dl} gün sonra`;
        const chips = [...new Set(ls.map(t => t.trip).filter(Boolean))].slice(0, 2).map(tn => `<span class="dchip">${esc(tn)}</span>`).join('');
        body += dayStubHtml({ key, day, list: ls, lab, chips, open: key in S_ ? S_[key] : (dl === 0 || !!sel || !!q), cards: ls.map(t => cardS(t, false, 'dl')).join('') });
      }
    }
    if (nod.length) body += TL`<div class="tlh">Tarihsiz · ${nod.length}</div>${nod.map(t => cardS(t, false)).join('')}`;
    if (past.length) {
      body += TL`<div class="tlh pastsec">Geçmiş · ${past.length}<button id="tgPast">${S.showPast ? TX('Gizle') : TX('Göster')}</button></div>`;
      if (S.showPast) { let yr = ''; for (const t of past) { const y = (t.date || '').slice(0, 4); if (y && y !== yr) { yr = y; body += `<div class="tly">${esc(y)}</div>`; } body += cardS(t, true); } }
    }
  }

  // seçim modunda başlık aynı yükseklikte kalır (liste zıplamasın): seçim çubuğu başlığın üstüne biner
  if (S.tkind && !allTrips().some(g => tripKind(g.name) === S.tkind)) S.tkind = '';
  const nF = (S.filter !== 'all') + !!S.tkind + !!S.trip;
  const top = `<div class="top${sel ? ' selon' : ''}">${header(TX('Biletlerim'), hdrBtns())}
      ${S.tickets.length ? TL`<div class="sbox"><input class="search" id="q" type="search" placeholder="Ara: başlık, seyahat, yer, uçuş…" value="${esc(S.q)}">${sel ? '' : `<button class="sflt${nF ? ' on' : ''}" id="fltBtn" aria-label="${TX('Filtre')}">${I('adjustments-horizontal')}${nF ? `<b>${nF}</b>` : ''}</button>`}</div>` : ''}
      ${sel ? TL`<div class="selov"><div class="top-row"><button class="icon-btn" id="selX" aria-label="Seçimi kapat">${I('x')}</button><h1>${sel.size} seçili</h1><button class="tbtn" id="selAll">${list.length && list.every(t => sel.has(t.id)) ? TX('Hiçbiri') : TX('Tümünü seç')}</button></div></div>` : ''}</div>`;
  const hero = !sel && !q ? statusBars() : '';
  const ctl = '';
  app.innerHTML = `<div class="page${animCls(anim)}">${top}
    ${hero}${ctl}
    ${!sel && !q && !lsGet('tripHintDone', false) && !allTrips().length ? TL`<div class="trip-hint"><span>${I('luggage')}</span><div><b>İlk seyahatini oluştur</b><p>Biletlerin seyahate göre toplanır; geri sayım, hava durumu ve öneriler bir arada görünür.</p><div class="th-b"><button class="btn pri" id="thNew">Seyahat oluştur</button><button class="btn" id="thX">Sonra</button></div></div></div>` : ''}
    ${(!S.hintLong || (sel && S.hintKeep)) && S.tickets.length ? '<div class="hint-card"><span>' + I('bulb') + TX('</span><p><b>İpucu:</b> Bir bilete uzun basarak seçebilir, toplu silebilir ya da seyahate taşıyabilirsin.</p><button id="hintOk">Tamam</button></div>') : ''}
    <div class="list ${anim ? 'stagger' : ''}">${body}</div></div>
    ${sel ? TL`<div class="selacts"><button id="aMove" ${sel.size ? '' : 'disabled'}>${I('luggage')}<span>Seyahate taşı</span></button><button id="aOut" ${sel.size ? '' : 'disabled'}>${I('arrow-back-up')}<span>Seyahatten çıkar</span></button><button id="aDel" class="dan" ${sel.size ? '' : 'disabled'}>${I('trash')}<span>Sil</span></button></div>`
      : TL`<button class="fab" id="add" aria-label="Bilet ekle">${I('plus')}</button>${tabsBar()}`}`;

  if (keepY) window.scrollTo(0, keepY);
  if (!sel) bindShell(app);
  const qi = $('#q'); if (qi) qi.oninput = () => { S.q = qi.value; const pos = qi.selectionStart; renderHome(app); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
  const fb = $('#fltBtn'); if (fb) fb.onclick = () => filterSheet(app, chips, trips);
  const tp = $('#tgPast'); if (tp) tp.onclick = () => { S.showPast = !S.showPast; renderHome(app); };
  $$('[data-tmenu]').forEach(b => b.onclick = () => tripMenu(b.dataset.tmenu));
  $$('[data-tgsel]').forEach(b => b.onclick = () => { const ts = list.filter(t => t.trip === b.dataset.tgsel), all = ts.every(t => sel.has(t.id)); ts.forEach(t => all ? sel.delete(t.id) : sel.add(t.id)); renderHome(app); });
  const hideHint = async () => { if (S.hintLong) return; S.hintLong = true; await metaSet('hintLong', true); };
  const ho = $('#hintOk'); if (ho) ho.onclick = async () => { await hideHint(); const h = $('.hint-card'); h.classList.add('out'); setTimeout(() => renderHome(app), 220); };
  if (sel && !S.hintLong) { S.hintKeep = true; hideHint(); } else if (!sel) S.hintKeep = false;
  const sx = $('#selX'); if (sx) sx.onclick = () => { S.sel = null; renderHome(app); };
  const sa = $('#selAll'); if (sa) sa.onclick = () => { const all = list.every(t => sel.has(t.id)); list.forEach(t => all ? sel.delete(t.id) : sel.add(t.id)); renderHome(app); };
  if (sel) {
    $('#aDel').onclick = () => bulkDelete([...sel]);
    $('#aMove').onclick = () => bulkMove([...sel]);
    $('#aOut').onclick = () => bulkSetTrip([...sel], '', TX('Seyahatten çıkarıldı'));
  }
  $$('.card:not(.st-add)').forEach(c => bindCardPress(c,
    () => { if (S.sel) { const id = c.dataset.id; S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); renderHome(app); return; } openTicket(c.dataset.id); },
    () => { if (!S.sel) S.sel = new Set(); S.sel.add(c.dataset.id); renderHome(app); }));
  $$('[data-tsug]').forEach(b => b.onclick = () => tripSuggest(b.dataset.tsug));
  $$('[data-tadd]').forEach(b => b.onclick = () => addNew(b.dataset.tadd));
  bindStatusBars(app); bindHdr(); bindDays(app); fillDayWx(app);
  const thn = $('#thNew'); if (thn) thn.onclick = () => createTripFlow();
  const thx = $('#thX'); if (thx) thx.onclick = () => { lsSet('tripHintDone', true); renderHome(app); };
;
  fillCardWx(app); fitTop();
}

/* ---------- seyahatler: biletlerden + ayrıca açılan (boş/tarihli) kayıtlar ---------- */
const tripRec = name => (S.trips || []).find(r => r.name === name);
async function saveTripRecs() { await metaSet('trips', S.trips || []); }
function allTrips() {
  const today = todayStr(), names = new Set([...S.tickets.map(t => t.trip).filter(Boolean), ...(S.trips || []).map(r => r.name)]);
  return [...names].map(name => {
    const ts = S.tickets.filter(t => t.trip === name), r = tripRec(name) || {};
    let a = r.a || '', e = r.e || r.a || '';
    for (const t of ts) if (t.date) { if (!a || t.date < a) a = t.date; const en = t.endDate || t.date; if (!e || en > e) e = en; }
    return { name, a, e, n: ts.length, past: !!e && e < today };
  });
}
function tripSub(g) { return [g.a ? (g.e && g.e !== g.a ? fmtRange(g.a, g.e) : fmtDate(g.a)) : TX('Tarihsiz'), TL`${g.n} bilet`].join(' · '); }
/* bilet için seyahat listesi: geçmişler gizli (biletin kendi seyahati hariç); tarihi uyan önce */
function tripChoices(cur, date) {
  const near = g => date && g.a && addDays(g.a, -3) <= date && date <= addDays(g.e || g.a, 3);
  return allTrips().filter(g => !g.past || g.name === cur)
    .sort((x, y) => (near(y) - near(x)) || ((x.a || '9') < (y.a || '9') ? -1 : (x.a || '9') > (y.a || '9') ? 1 : x.name.localeCompare(y.name, 'tr')));
}
function tripDialog({ title, name = '', a = '', e = '', ok = TX('Oluştur'), kind = '', guess = '' }) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = TL`<div class="dlg"><h3>${esc(title)}</h3>
      <div class="fld"><label for="tdN">Seyahatin adı</label><input class="inp" id="tdN" maxlength="60" value="${esc(name)}" placeholder="Örn. Roma · Mayıs 2027"></div>
      <div class="row2 tdd"><div class="fld"><label for="tdA">Başlangıç</label><input class="inp" id="tdA" type="date" value="${esc(a)}"></div><div class="fld"><label for="tdE">Bitiş</label><input class="inp" id="tdE" type="date" value="${esc(e)}"></div></div>
      <p class="tdh">Tarihler isteğe bağlı: biletleri ekledikçe kendiliğinden genişler.</p>
      <div class="fld"><label>Seyahat tipi <small>(isteğe bağlı${guess && !kind ? TX(' · kesik çizgili olan önerilen') : ''})</small></label>${kindChips(kind, guess)}</div><p class="tde"></p>
      <div class="row2"><button class="btn" data-a="0">Vazgeç</button><button class="btn pri" data-a="1">${esc(ok)}</button></div></div>`;
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    const done = () => {
      const n = $('#tdN', ov).value.trim(); let x = $('#tdA', ov).value, y = $('#tdE', ov).value;
      if (!n) { $('.tde', ov).textContent = TX('Seyahate bir ad ver'); $('#tdN', ov).focus(); return; }
      if (x && y && y < x) [x, y] = [y, x]; if (!x && y) [x, y] = [y, ''];
      const kc = $('.tkc.on', ov); close({ name: n, a: x, e: y || x, kind: kc ? kc.dataset.tk : '' });
    };
    $('#tdA', ov).onchange = () => { const y = $('#tdE', ov); if (!y.value || y.value < $('#tdA', ov).value) y.value = $('#tdA', ov).value; y.min = $('#tdA', ov).value; };
    ov.addEventListener('click', ev => { const k = ev.target.closest('[data-tk]'); if (k) { const on = k.classList.contains('on'); $$('.tkc', ov).forEach(x => x.classList.remove('on')); if (!on) k.classList.add('on'); return; } const b = ev.target.closest('[data-a]'); if (b) b.dataset.a === '1' ? done() : close(null); else if (ev.target === ov) close(null); });
    $('#tdN', ov).addEventListener('keydown', ev => { if (ev.key === 'Enter') done(); });
    dlgClose = () => close(null);
    document.body.appendChild(ov); setTimeout(() => $('#tdN', ov).focus(), 60);
  });
}
async function newTrip(sug = '') {
  const r = await tripDialog({ title: TX('Yeni seyahat'), name: sug }); if (!r) return null;
  if (allTrips().some(g => g.name === r.name)) { toast(TL`"${r.name}" zaten var`); return r.name; }
  (S.trips = S.trips || []).push({ name: r.name, a: r.a, e: r.e, createdAt: Date.now(), ...(r.kind ? { kind: r.kind } : {}) }); await saveTripRecs();
  lsSet('tripHintDone', true);
  return r.name;
}
async function createTripFlow() {
  const name = await newTrip(); if (!name) return;
  S.tab = 'trips'; await openTrip(name);
  toast(TL`"${name}" oluşturuldu · biletleri ekleyebilirsin`, 3000);
}

/* ---------- toplu işlemler ---------- */
function inputDialog({ title, text = '', value = '', ok = TX('Kaydet'), placeholder = '' }) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = TL`<div class="dlg"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}<input class="inp" id="dlgIn" maxlength="60" value="${esc(value)}" placeholder="${esc(placeholder)}" style="margin-bottom:14px"><div class="row2"><button class="btn" data-a="0">Vazgeç</button><button class="btn pri" data-a="1">${esc(ok)}</button></div></div>`;
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    ov.addEventListener('click', e => { const a = e.target.closest('[data-a]'); if (a) close(a.dataset.a === '1' ? $('#dlgIn', ov).value.trim() : null); else if (e.target === ov) close(null); });
    ov.addEventListener('keydown', e => { if (e.key === 'Enter') close($('#dlgIn', ov).value.trim()); });
    dlgClose = () => close(null);
    document.body.appendChild(ov); setTimeout(() => { const i = $('#dlgIn', ov); i.focus(); i.select(); }, 60);
  });
}
function filterSheet(app, chips, trips) {
  const kinds = TRIP_KINDS.filter(k => allTrips().some(g => tripKind(g.name) === k.k));
  const ov = document.createElement('div'); ov.className = 'ov';
  const draw = () => {
    const n = (S.filter !== 'all') + !!S.tkind + !!S.trip, cnt = S.tickets.filter(t => (S.filter === 'all' || t.type === S.filter) && (!S.trip || t.trip === S.trip) && (!S.tkind || (t.trip && tripKind(t.trip) === S.tkind))).length;
    ov.innerHTML = TL`<div class="dlg sheet fsheet"><h3>Filtre</h3>
      ${chips.length > 2 ? TL`<div class="fsec"><small>Bilet türü</small><div class="fchips">${chips.map(c => `<button class="chip ${S.filter === c.k ? 'on' : ''}" data-ff="${c.k}">${c.ic ? I(c.ic) : ''} ${esc(c.n)}</button>`).join('')}</div></div>` : ''}
      ${kinds.length ? TL`<div class="fsec"><small>Seyahat tipi</small><div class="fchips"><button class="chip ${!S.tkind ? 'on' : ''}" data-fk="">Tümü</button>${kinds.map(k => `<button class="chip ${S.tkind === k.k ? 'on' : ''}" data-fk="${k.k}" style="--kc:${k.c}">${I(k.ic)} ${esc(k.n)}</button>`).join('')}</div></div>` : ''}
      ${trips.length ? TL`<div class="fsec"><small>Seyahat</small><select class="trip-sel" id="fTrip"><option value="">Tüm seyahatler</option>${trips.map(t => `<option ${t === S.trip ? 'selected' : ''} value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>` : ''}
      <div class="row2"><button class="btn" data-fx="clear" ${n ? '' : 'disabled'}>Temizle</button><button class="btn pri" data-fx="ok">${cnt} bileti göster</button></div></div>`;
    const ft = $('#fTrip', ov); if (ft) ft.onchange = () => { S.trip = ft.value; draw(); renderHome(app); };
  };
  const close = () => { ov.remove(); dlgClose = null; renderHome(app, 'stagger'); };
  ov.addEventListener('click', e => {
    const f = e.target.closest('[data-ff]'), k = e.target.closest('[data-fk]'), x = e.target.closest('[data-fx]');
    if (f) { S.filter = f.dataset.ff; draw(); renderHome(app); }
    else if (k) { S.tkind = k.dataset.fk; draw(); renderHome(app); }
    else if (x) { if (x.dataset.fx === 'clear') { S.filter = 'all'; S.tkind = ''; S.trip = ''; draw(); renderHome(app); } else close(); }
    else if (e.target === ov) close();
  });
  dlgClose = close; draw(); noAnimAfter(ov); document.body.appendChild(ov);
}
function sheetMenu(title, items) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = `<div class="dlg sheet"><h3>${esc(title)}</h3>${items.map((it, i) => `<button class="item ${it.danger ? 'red' : ''}" data-i="${i}"><span class="ii">${it.icon || ''}</span><span class="it">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('')}</div>`;
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    ov.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) close(items[+b.dataset.i].value); else if (e.target === ov) close(null); });
    dlgClose = () => close(null);
    document.body.appendChild(ov);
  });
}
async function saveTrips(ids, trip) {
  for (const id of ids) {
    const t = S.tickets.find(x => x.id === id); if (!t) continue;
    t.trip = trip; t.updatedAt = Date.now();
    await saveTicketDB(t, [], []);
  }
}
async function bulkSetTrip(ids, trip, msg) {
  if (!ids.length) return;
  busy(TX('Kaydediliyor…')); await saveTrips(ids, trip); busy(false);
  S.sel = null; toast(msg || TX('Kaydedildi')); render(); syncReminders();
}
async function bulkMove(ids) {
  const first0 = S.tickets.filter(t => ids.includes(t.id) && t.date).sort((a, b) => a.date < b.date ? -1 : 1)[0];
  const v = await sheetMenu(TL`${ids.length} bileti seyahate taşı`, [...tripChoices('', first0 && first0.date).map(g => ({ icon: I('luggage'), label: g.name, sub: tripSub(g), value: { t: g.name } })), { icon: I('plus'), label: TX('Yeni seyahat…'), value: { nw: true } }]);
  if (!v) return;
  let name = v.t;
  if (v.nw) {
    const first = S.tickets.filter(t => ids.includes(t.id) && t.date).sort((a, b) => a.date < b.date ? -1 : 1)[0];
    const sug = first ? (first.type === 'ucak' && first.to ? autoTripName(first) : `${MONTH_TR[+first.date.slice(5, 7) - 1]} ${first.date.slice(0, 4)}`) : '';
    name = await newTrip(sug);
    if (!name) return;
  }
  await bulkSetTrip(ids, name, TL`${ids.length} bilet "${name}" seyahatine taşındı`);
}
async function bulkDelete(ids, title) {
  if (!ids.length) return;
  if (!await dialog({ title: title || TL`${ids.length} bilet silinsin mi?`, text: TX('Seçilen biletler ve hatırlatmaları kalıcı olarak silinecek. Bu işlem geri alınamaz.'), ok: TX('Sil'), danger: true })) return false;
  busy(TX('Siliniyor…'));
  for (const id of ids) {
    const t = S.tickets.find(x => x.id === id); if (!t) continue;
    await deleteTicketDB(t); S.tickets = S.tickets.filter(x => x.id !== id);
  }
  busy(false); S.sel = null; toast(TL`${ids.length} bilet silindi`); render(); syncReminders();
  return true;
}
async function tripMenu(name, onPage) {
  const ts = S.tickets.filter(t => t.trip === name);
  const v = await sheetMenu(name, [
    ...(onPage ? [] : [{ icon: I('layout-cards'), label: TX('Seyahat sayfasını aç'), sub: TX('Anılar, bavul, bilgi, plan'), value: 'page' }]),
    { icon: I('route'), label: TX('Seyahatin rotası'), sub: TX('Yerleri sırayla haritada aç'), value: 'route' },
    ...(ts.length ? [{ icon: I('share'), label: TX('Paylaş'), sub: TX('Şifreli dosya · DoraGo kullanan biriyle'), value: 'share' }] : []),

    { icon: I('pencil'), label: TX('Adı ve tarihleri düzenle'), value: 'rename' },
    { icon: I('list-check'), label: TX('Biletleri seç'), sub: TX('Toplu işlem için'), value: 'select' },
    { icon: I('trash'), label: TX('Tüm seyahati sil'), sub: TL`${ts.length} bilet silinir`, value: 'delete', danger: true },
  ]);
  if (v === 'rename') {
    const g = allTrips().find(x => x.name === name) || {}, r0 = tripRec(name) || {};
    const r = await tripDialog({ title: TX('Seyahati düzenle'), name, a: r0.a || g.a || '', e: r0.e || g.e || '', ok: TX('Kaydet'), kind: r0.kind || '', guess: guessKind(name) }); if (!r) return;
    const nn = r.name;
    const merge = nn !== name && allTrips().some(x => x.name === nn);
    if (merge && !await dialog({ title: TX('Seyahatler birleşsin mi?'), text: TL`"${esc(nn)}" adında bir seyahat zaten var. Biletler o seyahate eklenecek.`, ok: TX('Birleştir') })) return;
    S.trips = (S.trips || []).filter(x => x.name !== name && x.name !== nn);
    if (r.a || !ts.length || r.kind || r0.trav || r0.cc) S.trips.push({ name: nn, a: r.a, e: r.e, createdAt: r0.createdAt || Date.now(), ...(r.kind ? { kind: r.kind } : {}), ...(r0.trav ? { trav: r0.trav } : {}), ...(r0.cc ? { cc: r0.cc } : {}) });
    await saveTripRecs();
    if (S.tripOpen[name] !== undefined) { S.tripOpen[nn] = S.tripOpen[name]; if (nn !== name) delete S.tripOpen[name]; }
    if (nn !== name) await moveShop(name, nn);
    if (nn !== name) { await getPacks(); if (PACKS[name]) { PACKS[nn] = PACKS[name]; delete PACKS[name]; await savePacks(); } }
    if (nn !== name) { await getExp(); if (EXP[name]) { if (EXP[nn]) { EXP[nn].items.push(...EXP[name].items); EXP[nn].people = [...new Set([...EXP[nn].people, ...EXP[name].people])]; } else EXP[nn] = EXP[name]; delete EXP[name]; await saveExp(); } }
    if (nn !== name) { await getTP(); if (TP[name]) { TP[nn] = TP[nn] ? { cover: TP[nn].cover, items: [...TP[nn].items, ...TP[name].items].slice(0, PHOTO_MAX) } : TP[name]; delete TP[name]; await saveTP(); } }
    if (S.view === 'trip' && S.tripName === name) { S.tripName = nn; S.retTrip = nn; }
    if (nn !== name) { const sc = (await metaGet('shareCodes')) || {}; if (sc[name]) { sc[nn] = sc[name]; delete sc[name]; await metaSet('shareCodes', sc); } }
    if (nn !== name && ts.length) await bulkSetTrip(ts.map(t => t.id), nn, TX('Seyahat güncellendi'));
    else { toast(TX('Seyahat güncellendi')); render(); }
  } else if (v === 'delete') {
    if (!ts.length) { if (!await dialog({ title: TL`"${name}" silinsin mi?`, text: TX('Bu seyahatte bilet yok.'), ok: TX('Sil'), danger: true })) return; S.trips = (S.trips || []).filter(x => x.name !== name); await saveTripRecs(); await dropTripPhotos(name); toast(TX('Seyahat silindi')); if (S.view === 'trip') { S.retTrip = null; go('home', 'back'); } else render(); return; }
    if (!await dialog({ title: TL`"${name}" silinsin mi?`, text: TL`Bu seyahatteki <b>${ts.length} bilet</b> ve hatırlatmaları silinecek.`, ok: TX('Devam'), danger: true })) return;
    if (await bulkDelete(ts.map(t => t.id), TX('Emin misin? Bu işlem geri alınamaz.'))) { S.trips = (S.trips || []).filter(x => x.name !== name); await saveTripRecs(); await dropTripPhotos(name); if (S.view === 'trip') { S.retTrip = null; go('home', 'back'); } else render(); }
  } else if (v === 'select') {
    S.sel = new Set(ts.map(t => t.id)); S.trip = name; S.tab = 'list'; if (S.view === 'trip') { S.retTrip = null; go('home', 'back'); } else render();
  } else if (v === 'route') tripRoute(name);
  else if (v === 'add') addNew(name);
  else if (v === 'share') shareTrip(name);
  else if (v === 'pdf') pdfDialog(name);
  else if (v === 'pack') openPack(name);
  else if (v === 'info') openCInfo(name);
  else if (v === 'card') tripPostcard(name);
  else if (v === 'sug') tripSuggest(name);
  else if (v === 'page') openTrip(name);
}
/* seyahat rotası: uçuşlarda şehirlere bölünür */
function tripRoute(name) {
  const key = t => (t.date || '9999') + 'T' + (t.time || '99:99');
  const ts = S.tickets.filter(t => t.trip === name && t.date).sort((a, b) => key(a) < key(b) ? -1 : 1);
  const segs = []; let cur = { city: '', stops: [] };
  const push = l => { if (l && !cur.stops.some(x => locQuery(x) === locQuery(l))) cur.stops.push(l); };
  for (const t of ts) {
    if (t.type === 'ucak') {
      const [dep, arr] = ticketLocs(t);
      if (dep) { if (!cur.city) cur.city = apCity(t.from); push(dep); }
      if (cur.stops.length) segs.push(cur);
      cur = { city: apCity(t.to) || t.to || '', stops: [] }; if (arr) push(arr);
    } else { const l = ticketLocs(t)[0]; if (l) push(l); }
  }
  if (cur.stops.length) segs.push(cur);
  const usable = segs.filter(s => s.stops.length >= 2);
  if (!usable.length) { toast(TX('Rota için en az iki konumlu yer gerekli')); return; }
  const open = sg => {
    const st = sg.stops.slice(0, 10), e = encodeURIComponent;
    let url = `https://www.google.com/maps/dir/?api=1&origin=${e(locQuery(st[0]))}&destination=${e(locQuery(st[st.length - 1]))}`;
    if (st.length > 2) url += `&waypoints=${e(st.slice(1, -1).map(locQuery).join('|'))}`;
    if (sg.stops.length > 10) toast(TL`Google Haritalar en fazla 10 yer gösterebiliyor; ilk 10 yer açıldı`, 3500);
    const g = mapApps().find(a => a.id === 'google'); openUrl(url, g ? g.pkg : '');
  };
  if (usable.length === 1) { open(usable[0]); return; }
  sheetMenu(TX('Hangi şehrin rotası?'), usable.map((sg, i) => ({ icon: I('map-pin'), label: sg.city || TL`${i + 1}. bölüm`, sub: sg.stops.map(l => l.name.replace(/\s*\([A-Z]{3}\)$/, '')).join(' → ').slice(0, 90), value: sg })))
    .then(sg => sg && open(sg));
}

/* ---------- takvim ---------- */
const MONTH_TR = [TX('Ocak'), TX('Şubat'), TX('Mart'), TX('Nisan'), TX('Mayıs'), TX('Haziran'), TX('Temmuz'), TX('Ağustos'), TX('Eylül'), TX('Ekim'), TX('Kasım'), TX('Aralık')];
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/* ---------- 5.18 Seyahatler ekranı (büyük kartlar) ---------- */
function tripMissing(name, g) {
  const ts = S.tickets.filter(t => t.trip === name && t.status !== 'cancel'), out = [];
  if (!ts.length) return out;
  if (g.a && g.e && g.e > g.a && !ts.some(t => t.type === 'konaklama')) out.push(TX('konaklama'));
  const fl = ts.filter(t => t.type === 'ucak'), home = c => { const r = apRec(c); return r && r.cc === HOME_CC; };
  if (fl.length && fl.some(t => home(t.from)) && !fl.some(t => home(t.to))) out.push(TX('dönüş bileti'));
  return out;
}
function tripCardHtml(g) {
  const name = g.name, today = todayStr(), kd = kindOf(tripKind(name)), kc = kd ? kd.c : 'var(--acc)';
  const cov = tripHasCover(name), art = cov ? '' : tripMapSvg(name), flags = tripFlags(name);
  const n = g.a ? daysLeft(g.a) : null, days = g.a ? nightsBetween(g.a, g.e || g.a) + 1 : 0;
  const tag = [g.past ? '' : n == null ? TX('Tarihsiz') : n > 1 ? TL`${n} gün kaldı` : n === 1 ? TX('Yarın') : TX('Şu an seyahattesin'), kd ? kd.n : ''].filter(Boolean).join(' · ');
  const sub = [g.a ? (g.e && g.e !== g.a ? fmtRange(g.a, g.e) : fmtDate(g.a)) : '', days > 1 ? TL`${days} gün` : '', TL`${g.n} bilet`].filter(Boolean).join(' · ');
  const top = `<div class="tct${cov ? ' cov' : ''}"${cov ? ` data-cov="${esc(name)}"` : ''}>${art ? `<span class="tart">${art}</span>` : ''}${tag ? `<span class="tctag">${esc(tag)}</span>` : ''}
    <div class="tcb">${flags ? `<div class="tflag">${flags}</div>` : ''}<b class="tcn">${esc(name)}</b><small>${esc(sub)}</small></div></div>`;
  const ex = expItems(name).length ? expSummary(name) : null;
  if (g.past) {
    const nph = ((TP && TP[name]) || { items: [] }).items.length;
    const line = [nph ? TL`${nph} anı` : '', ex && ex.total ? fmtMoney(ex.total, ex.b) : ''].filter(Boolean).join(' · ');
    return `<button class="tcard past" data-tn="${esc(name)}" style="--kc:${kc}">${top}${line ? `<div class="tcx">${esc(line)}</div>` : ''}</button>`;
  }
  const row = (ic, txt, cls = '') => `<span class="${cls}">${I(ic)}<em>${esc(txt)}</em></span>`;
  const det = [];
  if (tripCCs(name).length) { const w = worstOf(visaCheck(name)); det.push(w && w.lvl !== 'ok' ? row('id', w.sh || w.txt, w.lvl + ' wide') : row('id', TX('Vize: sorun yok'), 'ok')); }
  const trav = tripTrav(name).length; if (trav > 1) det.push(row('users', TL`${trav} kişi`));
  const pc = packCount(name); if (pc) det.push(row('briefcase', TL`Bavul ${pc[0]}/${pc[1]}`, pc[0] === pc[1] ? 'ok' : 'warn'));
  const sc = shopCount(name); if (sc) det.push(row('shopping-cart', TL`Alınacak ${sc[0]}/${sc[1]}`, sc[0] === sc[1] ? 'ok' : 'warn'));
  if (ex && ex.total) det.push(row('cash', fmtMoney(ex.total, ex.b)));
  const up = upcoming().filter(t => t.trip === name), t0 = up[0];
  if (t0 && S.wx !== false && g.a && daysLeft(g.a) <= 15) { const day = g.a < today ? today : g.a, rep = up.find(t => t.type !== 'ucak' && wxLocFor(t, day)) || t0; det.push(`<span class="dwx" data-day="${day}" data-wx="${esc(rep.id)}"></span>`); }
  const miss = tripMissing(name, g);
  let foot = '';
  if (miss.length) foot = `<div class="tcx warn">${I('alert-triangle')}<span>${esc(TX('Eksik') + ': ' + miss.join(', '))}</span></div>`;
  else if (t0) {
    const [y, m, d] = t0.date.split('-').map(Number), dl = daysLeft(t0.date);
    const when = dl === 0 ? TX('Bugün') : dl === 1 ? TX('Yarın') : `${new Date(y, m - 1, d).toLocaleDateString(LOC, { weekday: 'short' })} ${d} ${MONTH_TR[m - 1].slice(0, 3)}`;
    const what = t0.type === 'ucak' && t0.from && t0.to ? `${t0.from} → ${t0.to}` : (t0.title || typeOf(t0.type).n);
    foot = `<div class="tcx">${I(typeOf(t0.type).ic)}<span>${esc(TX('Sıradaki') + ': ' + when + (t0.time ? ' ' + t0.time : '') + ' · ' + what)}</span></div>`;
  }
  return `<button class="tcard" data-tn="${esc(name)}" style="--kc:${kc}">${top}${det.length ? `<div class="tcg">${det.join('')}</div>` : ''}${foot}</button>`;
}
let TRIPS_READY = 0, PRELOAD = null;
function preload() { if (!PRELOAD) { const p = tripsData(); TRIPS_READY = 1; PRELOAD = p.catch(() => {}).then(() => { TRIPS_READY = 2; }); } return PRELOAD; }
/* arkadan yüklenen veriyle yeniden çizim: animasyonlar tekrar oynamasın */
function quietRender() { const a = $('#app'); a.classList.add('noanim'); render(); setTimeout(() => a.classList.remove('noanim'), 400); }
function renderTrips(app, anim) {
  artReady();
  const all = allTrips();
  const up = all.filter(g => !g.past).sort((a, b) => (a.a || '9999') < (b.a || '9999') ? -1 : (a.a || '9999') > (b.a || '9999') ? 1 : a.name.localeCompare(b.name, 'tr'));
  const past = all.filter(g => g.past).sort((a, b) => (a.e || '') > (b.e || '') ? -1 : 1);
  let body = '';
  if (up.length) body += TL`<div class="tlh">Yaklaşan · ${up.length}</div>` + up.map(tripCardHtml).join('');
  let yr = '';
  for (const g of past) { const y = (g.a || g.e || '').slice(0, 4); if (y !== yr) { yr = y; body += TL`<div class="tlh">Geçmiş · ${y}</div>`; } body += tripCardHtml(g); }
  if (!all.length) body = TL`<div class="empty"><div class="big">${dot('map-2', 'var(--acc)', 'xl')}</div><h3>Henüz seyahat yok</h3>
      <p>Biletlerini bir seyahatte topla; bavul, masraf ve vize tek sayfada.</p>
      <div class="ebtns"><button class="btn pri" id="tlNew">${I('plus')} Yeni seyahat</button><button class="btn" id="tlWorld">${I('world')} Haritadan</button></div></div>`;
  if (!TRIPS_READY) { TRIPS_READY = 1; tripsData().then(() => { TRIPS_READY = 2; if (S.view === 'home' && S.tab === 'trips') quietRender(); }); }
  const hero = (THEMES[curTheme()].hero && S.tickets.length ? heroHtml() : '') + statusBars();
  app.innerHTML = TL`<div class="page${animCls(anim)}">
    <div class="top">${header(TX('Seyahatler'), hdrBtns())}</div>
    ${hero}
    <div class="list tlist">${body}</div></div>
    <button class="fab" id="add" aria-label="Ekle">${I('plus')}</button>${tabsBar()}`;
  bindShell(app); bindHdr(); bindHero(); bindStatusBars(app);
  const nw = $('#tlNew'); if (nw) nw.onclick = () => createTripFlow();
  const nwW = $('#tlWorld'); if (nwW) nwW.onclick = () => openWorld();
  $$('[data-tn]').forEach(b => b.onclick = () => openTrip(b.dataset.tn));
  fillCovers(app); fillDayWx(app); fitTop();
}
function renderCal(app, anim) {
  const today = todayStr();
  if (!S.calDay) S.calDay = today;
  if (!S.calMonth) S.calMonth = S.calDay.slice(0, 7);
  const [y, m] = S.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1), off = (first.getDay() + 6) % 7, dim = new Date(y, m, 0).getDate();
  const cells = Math.ceil((off + dim) / 7) * 7;
  const byDay = {}, stay = {};
  for (const t of S.tickets) {
    if (!t.date) continue;
    (byDay[t.date] = byDay[t.date] || []).push(t);
    if (t.type === 'konaklama' && t.endDate && t.endDate > t.date) {
      const [a1, a2, a3] = t.date.split('-').map(Number);
      for (let k = 0; k <= 400; k++) {
        const key = ymd(new Date(a1, a2 - 1, a3 + k)); if (key > t.endDate) break;
        (stay[key] = stay[key] || []).push({ t, pos: key === t.date ? 's' : key === t.endDate ? 'e' : 'm' });
        if (k > 0) (byDay[key] = byDay[key] || []).push(t);
      }
    }
  }
  const usedTypes = new Set();
  let grid = '';
  for (let i = 0; i < cells; i++) {
    const d = new Date(y, m - 1, 1 - off + i), key = ymd(d), other = d.getMonth() !== m - 1;
    const ts = byDay[key] || [];
    if (!other) ts.forEach(t => usedTypes.add(t.type));
    const dots = ts.filter(t => t.type !== 'konaklama' || !t.endDate).slice(0, 3).map(t => `<b style="background:${TCOL[t.type] || TCOL.diger}"></b>`).join('');
    const st = stay[key] ? stay[key][0] : null;
    const dow = i % 7, band = st ? `<s class="band ${st.pos}${dow === 0 ? ' rs' : ''}${dow === 6 ? ' re' : ''}"></s>` : '';
    const cls = [other ? 'o' : '', key === today ? 'td' : '', key === S.calDay ? 'sel' : ''].join(' ');
    grid += `<button class="${cls}" data-d="${key}" aria-label="${d.getDate()} ${MONTH_TR[d.getMonth()]}${ts.length ? ', ' + ts.length + TX(' bilet') : ''}">${band}<span class="dn">${d.getDate()}</span><i>${dots}</i></button>`;
  }
  const monthCount = S.tickets.filter(t => t.date && (t.date.startsWith(S.calMonth) || (t.endDate && t.date <= S.calMonth + '-31' && t.endDate >= S.calMonth + '-01'))).length;
  const dayTs = (byDay[S.calDay] || []).slice().sort((a, b) => {
    const ka = a.date === S.calDay ? (a.time || '99') : '00', kb = b.date === S.calDay ? (b.time || '99') : '00';
    return ka < kb ? -1 : 1;
  });
  const [sy, sm, sd] = S.calDay.split('-').map(Number);
  const dayName = new Date(sy, sm - 1, sd).toLocaleDateString(LOC, { day: 'numeric', month: 'long', weekday: 'long' });
  const legend = TYPES.filter(t => usedTypes.has(t.k)).map(t => `<span><b style="background:${TCOL[t.k]}"></b>${t.n}</span>`).join('');
  let dayBody;
  if (dayTs.length) dayBody = dayTs.map((t, i) => card(t, (t.endDate || t.date) < today, i, { day: S.calDay })).join('');
  else {
    const next = S.tickets.filter(t => t.date && t.date > S.calDay).sort((a, b) => a.date < b.date ? -1 : 1)[0];
    dayBody = TL`<div class="empty" style="padding:22px 20px"><p style="margin:0">Bu güne ait bilet yok.</p>
      ${next ? TL`<p style="margin:10px 0 0"><button class="today-btn" id="goNext">Sonraki bilet: ${esc(fmtDate(next.date))} →</button></p>` : ''}</div>`;
  }
  const isCur = S.calMonth === today.slice(0, 7);
  app.innerHTML = TL`<div class="page${animCls(anim === 'slide-l' || anim === 'slide-r' ? null : anim)}">
    <div class="top">${header(TX('Takvim'))}</div>
    <div class="mh"><button class="ar" id="prevM" aria-label="Önceki ay">‹</button><b>${MONTH_TR[m - 1]} ${y}</b>
      ${isCur ? '' : TX('<button class="today-btn" id="todayB">Bugün</button>')}<button class="ar" id="nextM" aria-label="Sonraki ay">›</button></div>
    <div class="cal"><div class="${anim === 'slide-l' || anim === 'slide-r' ? anim : ''}">
      <div class="wd"><div>Pzt</div><div>Sal</div><div>Çar</div><div>Per</div><div>Cum</div><div>Cmt</div><div>Paz</div></div>
      <div class="gr">${grid}</div></div>
      ${legend ? `<div class="leg">${legend}</div>` : `<div class="leg">${monthCount ? '' : TX('Bu ay bilet yok')}</div>`}</div>
    <div class="dayh"><span>${esc(dayName)}${dayTs.length ? TL` · ${dayTs.length} bilet` : ''}</span>${dayStops(S.calDay, dayTs).stops.length >= 2 || (dayStops(S.calDay, dayTs).origin && dayStops(S.calDay, dayTs).stops.length) ? '<button class="today-btn" id="dayRoute">' + I('route') + TX(' Günün rotası</button>') : ''}</div>
    <div class="list stagger" style="padding-top:2px">${dayBody}</div></div>
    <button class="fab" id="add" aria-label="Bilet ekle">${I('plus')}</button>${tabsBar()}`;

  bindShell(app);
  fillCardWx(app); fitTop();
  const shift = dir => {
    const d = new Date(y, m - 1 + dir, 1); S.calMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    S.calDay = S.calMonth === today.slice(0, 7) ? today : S.calMonth + '-01';
    renderCal(app, dir > 0 ? 'slide-l' : 'slide-r');
  };
  $('#prevM').onclick = () => shift(-1);
  $('#nextM').onclick = () => shift(1);
  const tb = $('#todayB'); if (tb) tb.onclick = () => { const dir = S.calMonth < today.slice(0, 7) ? 'slide-l' : 'slide-r'; S.calDay = today; S.calMonth = today.slice(0, 7); renderCal(app, dir); };
  const gn = $('#goNext'); if (gn) gn.onclick = () => {
    const next = S.tickets.filter(t => t.date && t.date > S.calDay).sort((a, b) => a.date < b.date ? -1 : 1)[0];
    const dir = next.date.slice(0, 7) > S.calMonth ? 'slide-l' : null; S.calDay = next.date; S.calMonth = next.date.slice(0, 7); renderCal(app, dir);
  };
  $$('.gr button').forEach(b => b.onclick = () => {
    const d = b.dataset.d, mo = d.slice(0, 7);
    const dir = mo > S.calMonth ? 'slide-l' : mo < S.calMonth ? 'slide-r' : null;
    S.calDay = d; S.calMonth = mo; renderCal(app, dir);
  });
  $$('.list .card').forEach(c => bindCardPress(c, () => openTicket(c.dataset.id), null));
  const dr = $('#dayRoute'); if (dr) dr.onclick = () => openDayRoute(S.calDay, dayTs);
  // kaydırarak ay değiştir
  const cal = $('.cal'); let sx = null, sy0 = null;
  cal.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy0 = e.touches[0].clientY; }, { passive: true });
  cal.addEventListener('touchend', e => {
    if (sx == null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy0; sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1);
  });
}

/* ---------- görüntüleyici ---------- */
async function openTicket(id) {
  const t = S.tickets.find(x => x.id === id); if (!t) return;
  const pages = [];
  for (const pid of t.pageIds) { const p = await getOne('pages', pid); if (p) pages.push(p); }
  S.cur = { t, pages, zoom: 1 }; S.lastTid = id;
  go('view');
}

function renderViewer(app, anim) {
  const { t, pages } = S.cur, ty = typeOf(t.type), today = todayStr();
  const isFl = t.type === 'ucak' && t.from && t.to;
  const wd = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString(LOC, { day: 'numeric', month: 'short', weekday: 'short' }); };
  const chip = (k, v, copy) => v ? `<span class="vch${copy ? ' cp' : ''}"${copy ? ` data-copy="${esc(v)}"` : ''}>${k ? `<small>${k}</small>` : ''}<b>${esc(v)}</b>${copy ? I('copy') : ''}</span>` : '';
  const dl0 = t.date ? daysLeft(t.date) : null, kick = dl0 == null || (t.endDate || t.date) < today ? '' : dl0 > 1 ? TL`${dl0} GÜN KALDI` : dl0 === 1 ? TX('YARIN') : dl0 === 0 ? TX('BUGÜN') : '';
  let top;
  if (isFl) {
    const al = [t.airlineName || alName(t.airline), t.flightNo].filter(Boolean).join(' · ');
    top = `<div class="vlab">${esc([kick, al, t.date ? wd(t.date) : ''].filter(Boolean).join(' · '))}</div>
      <div class="vroute"><div><b>${esc(t.from)}</b><span>${esc(apCity(t.from) || '')}${t.time ? ' · ' + esc(t.time) : ''}</span></div>
        <i>${I('plane-tilt')}</i><div class="r"><b>${esc(t.to)}</b><span>${esc(apCity(t.to) || '')}</span></div></div>`;
  } else {
    const when = t.type === 'konaklama' && t.endDate ? TL`${fmtRange(t.date, t.endDate)} · ${nightsBetween(t.date, t.endDate)} gece` : t.date ? `${wd(t.date)}${t.time ? ' · ' + timeRange(t) : ''}` : TX('Tarihsiz');
    top = `<div class="vlab">${esc([kick, ty.n.toLocaleUpperCase(LANG), t.trip ? t.trip.toLocaleUpperCase(LANG) : ''].filter(Boolean).join(' · '))}</div>
      <div class="vname"><b>${esc(t.title || ty.n)}</b></div>
      <div class="vwhen">${esc(when)}${t.type === 'konaklama' && (t.time || t.endTime) ? `<br><small>${[t.time && TX('Giriş ') + t.time, t.endTime && TX('Çıkış ') + t.endTime].filter(Boolean).join(' · ')}</small>` : ''}</div>`;
  }
  const chips = isFl || t.type === 'ucak'
    ? chip('PNR', t.ref, true) + chip(TX('Koltuk'), t.seat) + chip(TX('Kapı'), t.gate)
    : chip(t.type === 'konaklama' ? TX('Rezervasyon') : isPlace(t.type) ? TX('Rezervasyon') : TX('Bilet no'), t.ref, true) + chip(TX('Koltuk'), t.seat);
  const wxc = S.wx !== false && t.date && (t.endDate || t.date) >= today ? '<span class="vch wxch" id="wxv"></span>' : '';
  const locs = ticketLocs(t).filter(l => hasC(l) || l.address || l.url);
  const acts = [
    t.type === 'ucak' && flightCode(t) ? TL`<button class="tic" id="vfs"><span class="tib">${I('plane-departure')}</span><small>Durum</small></button>` : '',
    `<button class="tic" id="vdir"><span class="tib">${I(locs.length ? 'navigation' : 'map-pin-plus')}</span><small>${locs.length ? TX('Yol tarifi') : TX('Konum ekle')}</small></button>`,
    t.date ? TL`<button class="tic" id="cal"><span class="tib">${I('calendar-event')}</span><small>Takvim</small></button>` : '',
    TL`<button class="tic" id="share"><span class="tib">${I('share-2')}</span><small>Paylaş</small></button>`,
  ].filter(Boolean);
  const rows = locs.map((l, i) => TL`<div class="vrow" data-lmap="${i}"><span class="vri">${l.icon}</span><span class="vrt"><small>${esc(l.label)}</small><b>${esc(l.name)}</b>${l.address && l.address !== l.name ? `<span>${esc(l.address)}</span>` : ''}${l.hint ? `<span class="loc-hint">${esc(l.hint)}</span>` : ''}</span><button class="vrb" data-lshow="${i}" aria-label="Haritada göster">${I('map')}</button><button class="vrb" data-lcopy="${i}" aria-label="Adresi kopyala">${I('copy')}</button></div>`).join('')
    + (t.date ? (() => { const st = t.status && ST[t.status], ended = hasEnded(t); return TL`<div class="vrow vst" id="vst"><span class="vri ${st ? 's-' + t.status : ''}">${I(st ? ST[t.status].ic : ended ? 'help' : 'calendar-event')}</span><span class="vrt"><small>Durum</small><b>${st ? ST[t.status].n + (t.statusAuto ? TX(' (varsayıldı)') : '') : ended ? TX('Gittin mi?') : TX('Planlandı')}</b><span>${ended || st ? TX('Değiştirmek için dokun') : TX('İptal ya da ertelendiyse dokun')}</span></span></div>`; })() : '')
    + (t.status === 'cancel' && t.refund ? TL`<div class="vrow vrf"><span class="vri">${I('receipt-refund')}</span><span class="vrt"><small>İade</small><b>${t.refund.state === 'wait' ? TX('Bekleniyor') : TX('Alındı')}${t.refund.amt ? ` · ${esc(t.refund.amt)} ${curSym(t.refund.cur)}` : ''}</b><span>${t.refund.state === 'wait' ? esc(refundTxt({ ...t.refund, amt: '' })) + ' · son ' + esc(fmtDate(t.refund.due)) : esc(fmtDate(t.refund.got || t.refund.due))}</span></span>${t.refund.state === 'wait' ? TL`<button class="btn rfgot" id="rfgot">Alındı</button>` : ''}</div>` : '')
    + (t.notes ? TL`<div class="vrow nt"><span class="vri">${I('pencil')}</span><span class="vrt"><small>Not</small><span class="vnote">${esc(t.notes).replace(/\n/g, '<br>')}</span></span></div>` : '')
    + (isFl && t.trip ? TL`<div class="vrow nt"><span class="vri">${I('luggage')}</span><span class="vrt"><small>Seyahat</small><b>${esc(t.trip)}</b></span></div>` : '');
  const hph = t.hph && t.hph.id, phOk = phEligible(t) || hph;
  const art = !hph && artReady() ? ticketArt(t) : '';
  const cred = hph && t.hph.src === 'wm' ? `<span class="vcred">${esc(TX('Foto') + ': ' + [t.hph.cr || 'Wikimedia', t.hph.lic].filter(Boolean).join(' · '))}</span>` : '';
  app.innerHTML = TL`<div class="viewer v2 v3${animCls(anim)}">
    <div class="vhero${isFl ? ' fl' : ''}" style="--kc:${ty.col || 'var(--acc)'}"${hph ? ` data-hph="1"` : ''}>${art ? `<div class="vart${isFl ? ' rte' : ''}">${art}</div>` : ''}
      <div class="tpbar"><button class="icon-btn" id="back" aria-label="Geri">←</button><span class="tpsp"></span>${phOk ? `<button class="icon-btn" id="vph" aria-label="${TX('Başlık fotoğrafı')}">${I('photo')}</button>` : ''}<button class="icon-btn" id="edit" aria-label="Düzenle">${I('pencil')}</button></div>
      <div class="vhb">${top}</div>${cred}</div>
    <div class="vbody">
      ${chips || wxc ? `<div class="vchips">${chips}${wxc}</div>` : ''}
      <div class="tgrid vgrid">${acts.join('')}</div>
      ${pfActive(t) ? pfHtml(t) : ''}
      ${pages.length ? TL`<div class="vpg"><div class="vpgh"><b>${isPlace(t.type) ? TX('Fotoğraflar') : TX('Bilet')} · ${pages.length} sayfa</b><button id="vfull">${I('external-link')} Tam ekran</button></div>
        <div class="vthumbs">${pages.map((p, i) => `<button class="vth" data-pv="${i}" style="background-image:url('${blobURL('p:' + p.id, p.blob)}')"><span>${i + 1}</span></button>`).join('')}</div></div>` : ''}
      ${rows ? `<div class="vrows">${rows}</div>` : ''}
    </div></div>`;
  $('#back').onclick = () => go('home', 'back');
  $('#edit').onclick = () => editTicket(t);
  const vph = $('#vph', app); if (vph) vph.onclick = () => placePhotoSheet(t);
  const vcr = $('.vcred', app); if (vcr && t.hph && t.hph.url) vcr.onclick = () => openUrl(t.hph.url);
  if (hph) fillVhero(t); else phAutoFetch(t);
  const fsb = $('#vfs'); if (fsb) bindCardPress(fsb, () => openFlightStatus(t, 'trip'), async () => { const v = await sheetMenu(TX('Uçuş durumu'), [{ icon: I('external-link'), label: TX('Trip.com'), value: 'trip' }, { icon: I('external-link'), label: TX('Google'), value: 'google' }, { icon: I('external-link'), label: TX('Flightradar24'), value: 'fr24' }]); if (v) openFlightStatus(t, v); });
  $('#vdir').onclick = () => locs.length ? pinTap(t.id, false) : addLocMenu(t);
  $$('[data-fs2]').forEach(b => b.onclick = () => openFlightStatus(t, b.dataset.fs2));
  const cal = $('#cal'); if (cal) cal.onclick = () => addToCalendar(t);
  $('#share').onclick = () => shareTicket(t, pages);
  const full = i => openLightbox(pages.map(p => p.blob), i, { bright: true });
  $$('.vth').forEach(b => b.onclick = () => full(+b.dataset.pv));
  const vf = $('#vfull'); if (vf) vf.onclick = () => full(0);
  $$('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));
  $$('.vrow[data-lmap]').forEach(r => r.onclick = e => { if (e.target.closest('.vrb')) return; showOnMap(locs[+r.dataset.lmap]); });
  const vst = $('#vst'); if (vst) vst.onclick = () => statusMenu(t);
  $$('[data-pf]').forEach(b => b.onclick = () => pfToggle(t, b.dataset.pf));
  const rg = $('#rfgot'); if (rg) rg.onclick = e => { e.stopPropagation(); refundDone(t); };
  $$('[data-lshow]', app).forEach(b => b.onclick = e => { e.stopPropagation(); showOnMap(locs[+b.dataset.lshow]); });
  $$('[data-lcopy]', app).forEach(b => b.onclick = e => { e.stopPropagation(); const l = locs[+b.dataset.lcopy]; copyText([l.name, l.address].filter(Boolean).join(', ') + (l.url ? `\n${l.url}` : hasC(l) ? `\n${l.lat}, ${l.lon}` : '')); });
  fillWxViewer(t);
}

function addToCalendar(t) {
  if (!t.date) { toast(TX('Önce bilete bir tarih ekle (Düzenle)')); return; }
  const [y, m, d] = t.date.split('-').map(Number);
  const ty = typeOf(t.type);
  const title = t.type === 'ucak' && t.from && t.to ? `✈️ ${t.flightNo ? t.flightNo + ' ' : ''}${apCity(t.from) || t.from} → ${apCity(t.to) || t.to}` : `${ty.i} ${t.title || ty.n}`;
  const desc = [t.type === 'ucak' && flightLine(t), t.gate && TX('Kapı: ') + t.gate, t.ref && (t.type === 'ucak' ? 'PNR: ' : TX('Rezervasyon: ')) + t.ref,
    t.trip && TX('Seyahat: ') + t.trip, t.notes, TX('DoraGo ile eklendi')].filter(Boolean).join('\n');
  const loc = t.type === 'ucak' ? (t.from ? `${apName(t.from) || t.from} (${t.from})` : '') : (t.type === 'konaklama' ? [t.title, t.place].filter(Boolean).join(', ') : t.place || '');
  let begin, end, allDay = !t.time;
  if (t.type === 'konaklama' && t.endDate) {
    const [y2, m2, d2] = t.endDate.split('-').map(Number);
    if (t.time) { const [hh, mm] = t.time.split(':').map(Number); begin = new Date(y, m - 1, d, hh, mm).getTime(); allDay = false; }
    else { begin = new Date(y, m - 1, d, 12, 0).getTime(); allDay = true; }
    const [eh, em] = (t.endTime || '12:00').split(':').map(Number);
    end = allDay ? new Date(y2, m2 - 1, d2 + 1, 12, 0).getTime() : new Date(y2, m2 - 1, d2, eh, em).getTime();
  } else if (allDay) { begin = new Date(y, m - 1, d, 12, 0).getTime(); end = 0; }
  else {
    const [hh, mm] = t.time.split(':').map(Number); begin = new Date(y, m - 1, d, hh, mm).getTime(); end = begin + 2 * 3600000;
    if (t.type !== 'ucak' && t.endTime && t.endTime > t.time) { const [eh, em] = t.endTime.split(':').map(Number); end = new Date(y, m - 1, d, eh, em).getTime(); }
  }
  if (A && A.addToCalendar) { S.pickAt = Date.now(); A.addToCalendar(title, begin, end, allDay, loc, desc); return; }
  // tarayıcı: .ics indir
  const f = x => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const icsEsc = v => String(v).replace(/[\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DoraGo//TR', 'BEGIN:VEVENT', 'UID:' + t.id + '@dorago', 'DTSTAMP:' + f(Date.now()),
    allDay ? `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}` : 'DTSTART:' + f(begin), allDay ? '' : 'DTEND:' + f(end),
    'SUMMARY:' + icsEsc(title), loc ? 'LOCATION:' + icsEsc(loc) : '', 'DESCRIPTION:' + icsEsc(desc),
    // hatırlatmalar (iPhone'da bildirim yerine takvim uyarıları): 1 gün önce ve birkaç saat önce; uçuşta check-in
    ...[allDay ? '-PT12H' : '-P1D', allDay ? '' : `-PT${S.notif && S.notif.hours ? S.notif.hours : 3}H`, t.type === 'ucak' && t.checkinH && !allDay && t.checkinH !== 24 ? `-PT${t.checkinH}H` : '']
      .filter(Boolean).flatMap(tr => ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(title), 'TRIGGER:' + tr, 'END:VALARM']),
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  if (IS_IOS) { location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); a.download = 'bilet.ics'; document.body.appendChild(a); a.click(); a.remove();
}

async function shareTicket(t, pages) {
  const ty = typeOf(t.type), title = t.title || ty.n;
  if (A && A.shareImages) {
    busy(TX('Hazırlanıyor…'));
    try {
      const parts = [];
      for (const p of pages) parts.push((p.blob.type === 'image/png' ? 'png' : 'jpg') + ':' + B64.enc(await p.blob.arrayBuffer()));
      busy(false); S.pickAt = Date.now(); A.shareImages(title, parts.join('|'));
    } catch (e) { busy(false); toast(TX('Paylaşılamadı')); }
    return;
  }
  try {
    const files = pages.map((p, i) => new File([p.blob], `${title}${pages.length > 1 ? '-' + (i + 1) : ''}.${p.blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: p.blob.type || 'image/jpeg' }));
    if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files, title });
    else toast(TX('Bu cihazda paylaşım desteklenmiyor'));
  } catch (e) { if (e.name !== 'AbortError') toast(TX('Paylaşılamadı')); }
}

function setupZoom(vp) {
  const imgs = $$('img', vp);
  const apply = (z, cx, cy) => {
    const old = S.cur.zoom; z = Math.max(1, Math.min(5, z)); if (Math.abs(z - old) < 0.001) return;
    const r = vp.getBoundingClientRect(); cx ??= r.width / 2; cy ??= r.height / 2;
    const fx = (vp.scrollLeft + cx) / old, fy = (vp.scrollTop + cy) / old;
    S.cur.zoom = z; imgs.forEach(i => i.style.width = (z * 100) + '%');
    vp.scrollLeft = fx * z - cx; vp.scrollTop = fy * z - cy;
  };
  imgs.forEach(i => i.style.width = (S.cur.zoom * 100) + '%');
  $('#zin').onclick = () => apply(S.cur.zoom * 1.5);
  $('#zout').onclick = () => apply(S.cur.zoom / 1.5);
  let lastTap = 0;
  vp.addEventListener('click', e => {
    if (e.target.tagName !== 'IMG') return;
    const now = Date.now();
    if (now - lastTap < 320) { const r = vp.getBoundingClientRect(); apply(S.cur.zoom > 1.2 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top); lastTap = 0; }
    else lastTap = now;
  });
  let pinch = null;
  const dist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  vp.addEventListener('touchstart', e => { if (e.touches.length === 2) pinch = { d: dist(e.touches), z: S.cur.zoom }; }, { passive: true });
  vp.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return; e.preventDefault();
    const r = vp.getBoundingClientRect();
    apply(pinch.z * dist(e.touches) / pinch.d, (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top);
  }, { passive: false });
  vp.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
}

/* ---------- ekle / düzenle ---------- */
function pickFiles(accept, multiple = true) {
  return new Promise(res => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    inp.style.display = 'none'; document.body.appendChild(inp);
    let fin = false; const end = v => { if (fin) return; fin = true; inp.remove(); res(v); };
    inp.onchange = () => end(Array.from(inp.files || []));
    inp.addEventListener('cancel', () => end([]));
    S.pickAt = Date.now(); inp.click();
  });
}

let pdfjsP = null;
/* ---------- OCR (Tesseract, telefonda, internetsiz) ---------- */
let ocrLoad = null;
function loadOcr() {
  return ocrLoad || (ocrLoad = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'ocr/tesseract.min.js'; sc.onload = res; sc.onerror = () => { ocrLoad = null; rej(new Error(TX('ocr yüklenemedi'))); }; document.head.appendChild(sc); }));
}
function wasmSimd() { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; } }
/* telefon ekran görüntüsü (uzun dikey): üstteki durum çubuğunu ve alttaki gezinme çubuğunu kes */
async function cropBars(pg) {
  if (!pg.w || !pg.h || pg.h / pg.w < 1.7) return pg.blob;
  try {
    const bmp = await createImageBitmap(pg.blob), top = Math.round(bmp.height * 0.045), bot = Math.round(bmp.height * 0.055);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height - top - bot;
    c.getContext('2d').drawImage(bmp, 0, -top); bmp.close && bmp.close();
    return await canvasBlob(c);
  } catch (e) { return pg.blob; }
}
/* sayfaları sırayla okur; "Atla" ile iptal edilebilir. Döner: metin ('' = okunamadı/iptal) */
async function ocrPages(pages, max = 3) {
  let worker = null, stop = false, text = '', cur = 0;
  const list = pages.slice(0, max), t0 = Date.now();
  const cancel = () => { stop = true; try { worker && worker.terminate(); } catch (e) {} };
  const show = pc => busy(TL`Görseldeki metin okunuyor…${list.length > 1 ? TL` sayfa ${cur + 1}/${list.length}` : ''}${pc != null ? ` ${pct(pc)}` : ''}`, cancel);
  let err = '';
  try {
    show(null);
    await loadOcr(); if (stop) return '';
    worker = await Tesseract.createWorker(['tur', 'eng'], 1, {
      workerPath: 'ocr/worker.min.js', corePath: wasmSimd() ? 'ocr/tesseract-core-simd-lstm.wasm.js' : 'ocr/tesseract-core-lstm.wasm.js',
      langPath: 'ocr/lang', gzip: true, cacheMethod: 'none', workerBlobURL: false,
      logger: m => { if (!stop && m.status === 'recognizing text') show(Math.round(m.progress * 100)); },
    });
    for (cur = 0; cur < list.length && !stop; cur++) {
      show(0);
      const { data } = await worker.recognize(await cropBars(list[cur]));
      text += '\n' + (data.text || '');
    }
  } catch (e) { if (!stop) { console.error('ocr', e); err = String(e && e.message || e).slice(0, 120); } }
  finally { try { worker && !stop && await worker.terminate(); } catch (e) {} }
  const flat = text.replace(/\s+/g, ' ').trim(); window.__lastOcr = text;
  diagLog({ kind: 'ocr', text: TL`${list.length} sayfa · ${Math.round((Date.now() - t0) / 1000)} sn · ${wasmSimd() ? 'simd' : 'temel'}${stop ? TX(' · atlandı') : ''}`, result: err ? 'hata: ' + err : `${flat.length} karakter`, steps: flat ? [flat.slice(0, 300)] : [] });
  return stop ? '' : text;
}
function loadPdfjs() {
  if (!pdfjsP) pdfjsP = import('./pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'; return m; });
  return pdfjsP;
}
const canvasBlob = (c, type = 'image/jpeg', q = 0.9) => new Promise(r => c.toBlob(r, type, q));

/* PDF metnini sayfadaki konuma göre satırlara diz (yukarıdan aşağı, soldan sağa).
   Aynı satırda uzak duran parçalar ayrı satıra iner; "Etiket:" ile değeri ise birleşik kalır. */
function layoutText(items) {
  const it = items.filter(x => x.str && x.str.trim()).map(x => ({ s: x.str, x: x.transform[4], y: x.transform[5], w: x.width || 0, h: Math.abs(x.height || x.transform[3]) || 10 }));
  it.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const o of it) {
    const r = rows.find(r => Math.abs(r.y - o.y) <= Math.max(2, Math.min(r.h, o.h) * 0.45));
    if (r) r.items.push(o); else rows.push({ y: o.y, h: o.h, items: [o] });
  }
  rows.sort((a, b) => b.y - a.y);
  const out = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let cur = '', end = null;
    for (const o of r.items) {
      const cw = o.w / Math.max(1, o.s.length) || o.h * 0.5;
      const gap = end == null ? 0 : o.x - end;
      if (end != null && gap > Math.max(cw * 4, o.h * 1.6) && !/:\s*$/.test(cur)) { out.push(cur.trim()); cur = ''; }
      else if (end != null && gap > cw * 0.25 && !/\s$/.test(cur) && !/^\s/.test(o.s)) cur += ' ';
      cur += o.s; end = o.x + o.w;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.join('\n');
}
async function filesToPages(files) {
  const pages = [], links = []; let text = '', ltext = ''; const errors = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi], pre = files.length > 1 ? TL`Dosya ${fi + 1}/${files.length} · ` : '';
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    try {
      if (isPdf) {
        busy(pre + TX('PDF açılıyor…'));
        const pdfjs = await loadPdfjs();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()), cMapUrl: './cmaps/', cMapPacked: true, standardFontDataUrl: './standard_fonts/', useWorkerFetch: false, isEvalSupported: false }).promise;
        const n = Math.min(doc.numPages, 30);
        for (let i = 1; i <= n; i++) {
          busy(TL`${pre}PDF işleniyor… sayfa ${i}/${n}`);
          const page = await doc.getPage(i);
          const v1 = page.getViewport({ scale: 1 });
          const scale = Math.min(1700 / v1.width, 4000 / v1.height, 4);
          const vp = page.getViewport({ scale });
          const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          pages.push({ blob: await canvasBlob(c), w: c.width, h: c.height });
          try { for (const an of await page.getAnnotations()) { const u = an.url || an.unsafeUrl; if (u && !links.includes(u)) links.push(u); } } catch (e) {}
          try { const tc = await page.getTextContent(); text += '\n' + tc.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join(''); ltext += '\n' + layoutText(tc.items); } catch (e) {}
          page.cleanup();
        }
        await doc.destroy();
      } else {
        busy(pre + TX('Görsel ekleniyor…'));
        const bmp = await createImageBitmap(f);
        const max = 2600, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
        if (s < 1 || f.size > 4e6 || !/^image\/(jpeg|png|webp)$/.test(f.type)) {
          const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
          pages.push({ blob: await canvasBlob(c), w: c.width, h: c.height });
        } else pages.push({ blob: f.slice(0, f.size, f.type), w: bmp.width, h: bmp.height });
        bmp.close && bmp.close();
      }
    } catch (e) {
      console.error(e);
      errors.push((f.name || TX('Dosya')) + (e && e.name === 'PasswordException' ? TX(': şifreli PDF açılamadı') : TX(': açılamadı')));
    }
  }
  busy(false);
  if (errors.length) toast(errors.join('\n'), 4000);
  return { pages, text, links, ltext };
}

function cleanName(n) {
  if (!n) return '';
  n = n.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(gmail|outlook|yahoo mail)\s*-\s*/i, '').replace(/\s+\d{5,}$/, '');
  if (/^(img|image|screenshot|ekran görüntüsü|scan|photo|dsc|pxl|paylaşılan|document|belge|boarding pass|e-?ticket|bilet|ticket)\b/i.test(n) || /^[\d\s-]+$/.test(n)) return '';
  return n.slice(0, 60);
}

const DRAFT_FIELDS = ['priceAmt', 'priceCur', 'title', 'type', 'date', 'time', 'endDate', 'endTime', 'from', 'to', 'airline', 'airlineName', 'flightNo', 'seat', 'gate', 'ref', 'place', 'trip', 'notes', 'checkinH', 'lat', 'lon', 'leg', 'mapUrl'];
async function startImport(files) {
  if (!files.length) return;
  const { pages, text, links, ltext } = await filesToPages(files);
  if (!pages.length) return;
  busy(TX('Bilet bilgileri okunuyor…'));
  let codes = [];
  for (const p of pages.slice(0, 3)) { codes = codes.concat(await readBarcodes(p.blob)); if (codes.some(parseBCBP)) break; }
  let allText = text;
  if (S.ocr !== false && text.replace(/\s/g, '').length < 40 && !codes.some(parseBCBP)) {
    busy(false); const o = await ocrPages(pages); if (o.trim()) allText = text + '\n' + o;
    busy(TX('Bilet bilgileri okunuyor…'));
  }
  const nm = files.map(f => f.name).join(' ');
  const info = await extractInfo(allText, codes, nm, links);
  // tablo düzenli PDF'ler: sayfadaki konuma göre dizilmiş metinden eksik alanları tamamla
  if (ltext && ltext.trim() && !(info.segments && info.segments.length > 1)) {
    const i2 = await extractInfo(ltext, codes, nm, links);
    if (i2.type === info.type) for (const k of i2.filled || []) {
      if (k === 'segments' || (info.filled || []).includes(k)) continue;
      info[k] = i2[k]; (info.filled = info.filled || []).push(k);
      if (k === 'lat' && i2.lon != null) info.lon = i2.lon;
    }
  }
  busy(false);
  const forced = S.addTrip || ''; S.addTrip = '';
  const d = { id: null, trip: forced || S.trip || '', notes: '', checkinH: 24, pages: pages.map(p => ({ id: uid(), ...p, isNew: true })), removed: [] };
  for (const k of DRAFT_FIELDS) if (d[k] === undefined) d[k] = '';
  const segs = info.segments; delete info.segments;
  Object.assign(d, info, { auto: new Set(info.filled) });
  if (!d.title) d.title = cleanName(files[0].name);
  delete d.filled;
  if (!d.trip && d.date) { const tr = matchTrip(d.date, d.endDate); if (tr) { d.trip = tr; d.auto.add('trip'); } }
  if (segs && segs.length > 1) { startMulti(segs, d); return; }
  const short = d.mapShort; delete d.mapShort;
  if (d.type !== 'ucak' && !hasC(d) && (d.place || short || d.title)) { const st = await findLocation(d, short); if (st === 'neterr') toast(geoMsg.neterr, 3500); }
  S.draft = d;
  go('edit');
}

/* ---------- adresten konum (OpenStreetMap) ---------- */
let geoWait = null;
window.onGeocode = b => { const f = geoWait; geoWait = null; f && f(b); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* provider: 'n' Nominatim, 'p' Photon; near: {lat,lon} bölge. Döner: { list: [{lat,lon,label}], err } */
async function geoFetchWeb(provider, q, near) {
  const e = encodeURIComponent(q);
  const u = provider === 'p' ? `https://photon.komoot.io/api/?limit=3&q=${e}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`
    : `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&addressdetails=0&q=${e}${near ? `&bounded=1&viewbox=${near.lon - 1.5},${near.lat + 1},${near.lon + 1.5},${near.lat - 1}` : ''}`;
  try { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000); const r = await fetch(u, { signal: ctl.signal, headers: { 'Accept-Language': 'tr,en' } }); clearTimeout(tm); return JSON.stringify({ s: r.status, b: r.ok ? await r.text() : '' }); }
  catch (er) { return '{"s":-1,"b":""}'; }
}
function geocodeOnce(q, provider = 'n', near = null) {
  return new Promise(res => {
    if (!A) { geoFetchWeb(provider, q, near).then(res); return; }
    if (!(A.geoFetch || A.geocode)) return res('');
    geoWait = res;
    if (near && A.geoFetchNear) A.geoFetchNear(provider, q, near.lat, near.lon);
    else if (A.geoFetch) A.geoFetch(provider, q); else A.geocode(q);
    setTimeout(() => { if (geoWait === res) { geoWait = null; res('{"s":-1,"b":""}'); } }, 15000);
  }).then(raw => {
    let s = 200, b = raw;
    try { const o = JSON.parse(raw || '""'); if (o && typeof o === 'object' && 's' in o) { s = o.s; b = o.b; } } catch (e) {}
    if (s !== 200) return { list: [], err: true };
    try {
      const d = JSON.parse(b || '[]');
      if (Array.isArray(d)) return { list: d.map(x => ({ lat: +(+x.lat).toFixed(6), lon: +(+x.lon).toFixed(6), label: x.display_name || '' })), err: false };
      return { list: (d.features || []).map(f => { const pr = f.properties || {}, [lon, lat] = f.geometry.coordinates; return { lat: +lat.toFixed(6), lon: +lon.toFixed(6), label: [pr.name, pr.street && [pr.housenumber, pr.street].filter(Boolean).join(' '), pr.city || pr.county, pr.state, pr.country].filter(Boolean).join(', ') }; }), err: false };
    } catch (e) { return { list: [], err: false }; }
  });
}
/* arama sırası: tam ifadeler (Nominatim) → Photon (yazım farklarına toleranslı) → kısaltılmış ad + şehir */
function geoQueries(d) {
  const uniq = a => a.map(q => (q || '').replace(/\s+/g, ' ').trim()).filter((q, i, x) => q.length > 3 && x.indexOf(q) === i);
  const inPlace = d.title && d.place && d.place.toLowerCase().includes(d.title.toLowerCase());
  const exact = uniq([d.place, inPlace ? '' : [d.title, d.place].filter(Boolean).join(', '), d.type !== 'diger' ? d.title : '']);
  const parts = (d.place || d.title || '').split(',').map(x => x.trim()).filter(Boolean);
  const name = parts[0] || '';
  // şehir: sondan başlayıp ülke adı ve posta kodu olmayan ilk parça ("London SE1 9DT" → "London")
  let city = '';
  for (let i = parts.length - 1; i >= 1; i--) {
    const c = parts[i].replace(/\b[a-z]*\d[a-z0-9]*\b/gi, '').replace(/\s+/g, ' ').trim();
    if (c.length >= 3 && !COUNTRIES.has(lowerSmart(c))) { city = c; break; }
  }
  const words = name.split(/\s+/), short = [];
  for (let n = words.length - 1; n >= 2; n--) short.push(words.slice(0, n).join(' ') + (city ? ', ' + city : ''));
  return { exact, photon: exact.slice(0, 2), short: uniq(short).filter(q => !exact.includes(q)).slice(0, 3), city };
}
/* ---------- bölge doğrulaması ---------- */
function distKm(a, b) {
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const COUNTRIES = new Set([TX('birleşik krallık'), 'ingiltere', 'united kingdom', 'uk', 'england', 'italya', 'i̇talya', 'italy', 'fransa', 'france', 'almanya', 'germany', 'deutschland', 'ispanya', 'i̇spanya', 'spain', 'españa', TX('türkiye'), 'turkey', TX('türkiye cumhuriyeti'), 'hollanda', 'netherlands', 'yunanistan', 'greece', 'abd', 'usa', 'united states', 'amerika', 'avusturya', 'austria', TX('belçika'), 'belgium', TX('isviçre'), TX('i̇sviçre'), 'switzerland', 'portekiz', 'portugal', TX('çekya'), 'czechia', 'czech republic', 'macaristan', 'hungary', 'polonya', 'poland', 'danimarka', 'denmark', TX('isveç'), TX('i̇sveç'), 'sweden', TX('norveç'), 'norway', 'irlanda', 'i̇rlanda', 'ireland', TX('hırvatistan'), 'croatia', 'japonya', 'japan', 'bae', 'uae', TX('birleşik arap emirlikleri'), TX('kıbrıs'), 'cyprus', 'kktc', TX('gürcistan'), 'georgia', 'azerbaycan', 'azerbaijan', TX('mısır'), 'egypt', 'fas', 'morocco']);
const CITY_ALIAS = { londra: 'london', roma: 'rome', milano: 'milan', münih: 'munich', viyana: 'vienna', atina: 'athens', brüksel: 'brussels', lizbon: 'lisbon', prag: 'prague', varşova: 'warsaw', moskova: 'moscow', kopenhag: 'copenhagen', stokholm: 'stockholm', cenevre: 'geneva', zürih: 'zurich', venedik: 'venice', floransa: 'florence', napoli: 'naples', köln: 'cologne', budapeşte: 'budapest', bükreş: 'bucharest', belgrad: 'belgrade', sofya: 'sofia', barselona: 'barcelona', sevilla: 'seville', selanik: 'thessaloniki', tiflis: 'tbilisi', bakü: 'baku', kahire: 'cairo', lefkoşa: 'nicosia', pekin: 'beijing', seul: 'seoul', üsküp: 'skopje', saraybosna: 'sarajevo', 'new york': 'new york', amsterdam: 'amsterdam', paris: 'paris', berlin: 'berlin', madrid: 'madrid', dubai: 'dubai', istanbul: 'istanbul', 'i̇stanbul': 'istanbul' };
function cityNames(c) {
  const l = lowerSmart(c || '').trim(); if (!l) return [];
  const out = new Set([l]); if (CITY_ALIAS[l]) out.add(CITY_ALIAS[l]);
  for (const [tr, en] of Object.entries(CITY_ALIAS)) if (en === l) out.add(tr);
  return [...out];
}
/* aynı günlerdeki bilinen konum: konaklama, uçuşun varış/kalkış havalimanı, aynı seyahatteki konumlu bilet */
function tripAnchor(d) {
  if (!d.date) return null;
  const dd = d.date, near = (a, b) => Math.abs(nightsBetween(a, b)) <= 2;
  let best = null, bestScore = 99;
  const take = (pt, score) => { if (pt && hasC(pt) && score < bestScore) { best = { lat: +pt.lat, lon: +pt.lon }; bestScore = score; } };
  for (const t of S.tickets) {
    if (t.id === d.id || !t.date) continue;
    if (t.type === 'konaklama' && hasC(t) && t.date <= addDays(dd, 1) && (t.endDate || t.date) >= addDays(dd, -1)) take(t, 0);
    else if (t.type === 'ucak' && near(t.date, dd)) {
      if (t.date <= dd && t.to) take(apLL(t.to), 1 + Math.abs(nightsBetween(t.date, dd)));
      else if (t.from) take(apLL(t.from), 1 + Math.abs(nightsBetween(t.date, dd)));
    } else if (hasC(t) && near(t.date, dd) && (!d.trip || t.trip === d.trip)) take(t, 2);
  }
  return best;
}
/* sonuç biletteki şehirde / seyahat bölgesinde mi? */
function geoAccept(r, ctx) {
  if (ctx.anchor && distKm(ctx.anchor, r) > ctx.radius) return false;
  if (!ctx.anchor && ctx.cities.length) { const lb = lowerSmart(r.label); if (!ctx.cities.some(c => lb.includes(c))) return false; }
  return true;
}

async function geoAllowed(ask = true) {
  if (!canGeo()) return false;
  if (S.geocode === null || S.geocode === undefined) {
    if (!ask) return false;
    const ok = await dialog({ title: TX('Adresten konum bulunsun mu?'), text: TX('Biletteki adresi <b>OpenStreetMap</b> tabanlı servislere gönderip haritadaki tam konumunu bulabilirim. Böylece Citymapper ve Moovit de çalışır. Bunun için internet gerekir. Bu ayarı sonra Ayarlar → Haritalar\'dan değiştirebilirsin.'), ok: TX('Evet, bul'), cancel: TX('Hayır') });
    S.geocode = ok; await metaSet('geocode', ok);
  }
  return !!S.geocode;
}
/* Döner: 'ok' | 'approx' | 'notfound' | 'neterr' | 'off' */
async function findLocation(d, short, ask = true) {
  if (!await geoAllowed(ask)) return 'off';
  busy(TX('Konum aranıyor…'));
  let errs = 0, tries = 0, rejected = 0;
  const hit = (r, approx, label) => { d.lat = r.lat; d.lon = r.lon; d.geoLabel = label || r.label; d.geoApprox = approx; d.auto && d.auto.add('lat'); return approx ? 'approx' : 'ok'; };
  try {
    if (short) { const u = await resolveShort(short); const ll = parseMapLink(u); if (ll) return hit(ll, false, TX('PDF\'teki harita bağlantısından')); }
    const Q = geoQueries(d);
    const osmLog = [];
    const run = async (q, prov, near) => { if (tries++ && prov === 'n') await sleep(1100); const x = await geocodeOnce(q, prov, near); if (x.err) errs++; osmLog.push(`${prov === 'p' ? TX('Photon') : TX('Nominatim')}${near ? TX(' (bölgede)') : ''}: "${q}" → ${x.err ? TX('bağlantı hatası') : x.list.length + TX(' sonuç')}${x.list[0] ? ' · ' + x.list[0].label.slice(0, 60) : ''}`); return x.list; };
    const done_ = (st, r) => { diagLog({ kind: TX('adres araması'), ticket: `${d.title || ''} (${d.date || 'tarihsiz'})`, result: st + (r ? ` · ${r.lat}, ${r.lon} · ${r.label.slice(0, 60)}` : ''), steps: osmLog }); return st; };
    const dead = () => errs >= 2 && errs === tries;
    // bölge: önce seyahatteki bilinen konum, yoksa biletteki şehrin merkezi
    const ctx = { anchor: (d.date && tripAnchor(d)) || tripAnchorAny(d), radius: 150, cities: cityNames(Q.city) };
    // Türkçe yer adı → İngilizce, şehir yoksa bölgenin şehri ("Kensington Bahçeleri" → "Kensington Gardens, London")
    { const en = trToEn(d.title || ''), rc = Q.city || regionCityEn(ctx.anchor); const extra = [en && rc ? `${en}, ${rc}` : '', en, !en && rc && d.title && !Q.city ? `${d.title}, ${rc}` : ''].filter(q => q && !Q.exact.includes(q)); Q.exact.unshift(...extra); }
    if (!ctx.anchor && Q.city) {
      const c = (await run(Q.city, 'n')).find(x => !ctx.cities.length || ctx.cities.some(n => lowerSmart(x.label).includes(n)));
      if (c) { ctx.anchor = { lat: c.lat, lon: c.lon }; ctx.radius = 80; }
      if (dead()) return done_('neterr');
    }
    const pick = list => { const ok = list.find(r => geoAccept(r, ctx)); if (!ok && list.length) rejected++; return ok; };
    for (const q of Q.exact) { const r = pick(await run(q, 'n', ctx.anchor)); if (r) return done_(hit(r, false), r); if (dead()) return done_('neterr'); }
    for (const q of Q.photon) { const r = pick(await run(q, 'p', ctx.anchor)); if (r) return done_(hit(r, false), r); if (dead()) return done_('neterr'); }
    for (const q of Q.short) { const r = pick(await run(q, 'n', ctx.anchor)); if (r) return done_(hit(r, true), r); if (dead()) return done_('neterr'); }
    return done_(errs >= tries && tries > 0 ? 'neterr' : 'notfound');
  } finally { busy(false); }
}
const geoMsg = { ok: TX('Konum bulundu, kontrol et'), approx: TX('Yaklaşık konum bulundu, kontrol et'), notfound: TX('Bu adres haritada bulunamadı. Bağlantı yapıştırarak ekleyebilirsin.'), neterr: TX('İnternete bağlanılamadı. Bağlantını kontrol edip tekrar dene.') };

/* ---------- seyahat eşleştirme ---------- */
function tripSpans() {
  const sp = {};
  for (const t of S.tickets) {
    if (!t.trip || !t.date) continue;
    const e = t.endDate || t.date, o = sp[t.trip] || (sp[t.trip] = { a: t.date, b: e });
    if (t.date < o.a) o.a = t.date; if (e > o.b) o.b = e;
  }
  return sp;
}
const addDays = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
function matchTrip(date, end) {
  const e = end || date;
  for (const [name, o] of Object.entries(tripSpans())) if (date <= addDays(o.b, 2) && e >= addDays(o.a, -2)) return name;
  return '';
}
function autoTripName(seg) {
  const city = apCity(seg.to) || seg.to; if (!seg.date) return city;
  const [y, m] = seg.date.split('-').map(Number); return `${city} · ${MONTH_TR[m - 1]} ${y}`;
}

/* ---------- çoklu uçuş (gidiş-dönüş / aktarmalı) ---------- */
function legLabels(segs) {
  if (segs.length === 2 && segs[0].from === segs[1].to && segs[0].to === segs[1].from) return [TX('Gidiş'), TX('Dönüş')];
  return segs.map((_, i) => TL`${i + 1}. uçuş`);
}
function startMulti(segs, base) {
  const labels = legLabels(segs);
  const legs = segs.map((g, i) => {
    const d = { id: null, type: 'ucak', notes: '', checkinH: 24, pages: base.pages, removed: [], multiIdx: i };
    for (const k of DRAFT_FIELDS) if (d[k] === undefined) d[k] = '';
    Object.assign(d, g, { leg: labels[i], auto: new Set(Object.keys(g).filter(k => g[k] && !['airlineName', 'title'].includes(k))) });
    return d;
  });
  S.multi = { legs, sel: legs.map(() => true), trip: base.trip || matchTrip(segs[0].date, segs[segs.length - 1].date) || autoTripName(segs[0]), pages: base.pages };
  go('multi');
}
function renderMulti(app, anim) {
  const M = S.multi, n = M.sel.filter(Boolean).length;
  app.innerHTML = TL`<div class="page${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="cancel" aria-label="Vazgeç">${I('x')}</button><h2>${M.legs.length} uçuş bulundu</h2></div>
    <div class="form">
      <div class="autonote">${I('sparkles')} Bu belgede ${M.legs.length} uçuş var. Her biri ayrı bilet olarak kaydedilecek, hepsi aynı sayfaları gösterecek. Düzenlemek için bir uçuşa dokun.</div>
      <div class="fld"><label for="m-trip">Seyahat</label><input class="inp auto" id="m-trip" maxlength="60" value="${esc(M.trip)}"></div>
      ${M.legs.map((d, i) => `<div class="leg-card ${M.sel[i] ? '' : 'off'}" style="--i:${i}">
        <label class="lc-check"><input type="checkbox" data-sel="${i}" ${M.sel[i] ? 'checked' : ''}><span></span></label>
        <button class="lc-body" data-leg="${i}">
          <span class="legb">${esc(d.leg)}</span>
          <span class="route">${esc(d.from)}<span class="arr">✈</span>${esc(d.to)}</span>
          <span class="lc-sub">${esc(`${apCity(d.from) || d.from} → ${apCity(d.to) || d.to}`)}</span>
          <span class="lc-sub"><b>${d.date ? esc(fmtDate(d.date)) : TX('Tarih yok')}${d.time ? ' · ' + esc(d.time) : ''}</b>${d.flightNo ? ' · ' + esc(d.flightNo) : ''}</span>
          ${!d.time ? TX('<span class="lc-warn">Kalkış saatini eklemek için dokun</span>') : ''}
        </button></div>`).join('')}
      <div class="fld" style="margin-top:6px"><label>Sayfalar (${M.pages.length})</label><div class="pgrid">
        ${M.pages.map((p, i) => `<div class="pg" style="background-image:url('${blobURL('p:' + p.id, p.blob)}')"><span class="n">${i + 1}</span></div>`).join('')}</div></div>
    </div>
    <div class="actions"><button class="btn pri" id="saveAll" ${n ? '' : 'disabled'}>${n === M.legs.length ? TX('Hepsini kaydet') : TX('Seçilenleri kaydet')} (${n})</button></div></div>`;
  $('#m-trip').oninput = e => { M.trip = e.target.value; e.target.classList.remove('auto'); };
  $$('[data-sel]').forEach(c => c.onchange = () => { M.sel[+c.dataset.sel] = c.checked; renderMulti(app); });
  $$('[data-leg]').forEach(b => b.onclick = () => { S.draft = M.legs[+b.dataset.leg]; S.draft.trip = M.trip; go('edit'); });
  $('#cancel').onclick = () => cancelMulti();
  $('#saveAll').onclick = async () => {
    busy(TX('Kaydediliyor…'));
    try {
      const thumb = await makeThumb(M.pages[0].blob), saved = [];
      let first = true;
      for (let i = 0; i < M.legs.length; i++) {
        if (!M.sel[i]) continue;
        const d = M.legs[i]; d.trip = M.trip.trim();
        const ticket = await buildTicket(d, thumb);
        const newPages = first ? M.pages.filter(p => p.isNew).map(p => ({ id: p.id, blob: p.blob, w: p.w, h: p.h })) : [];
        await saveTicketDB(ticket, newPages, []); first = false;
        S.tickets = S.tickets.filter(t => t.id !== ticket.id).concat(ticket); saved.push(ticket);
      }
      busy(false); S.multi = null; toast(TL`${saved.length} uçuş kaydedildi`);
      go('home', 'back'); syncReminders(); maybeAskNotif();
    } catch (e) { console.error(e); busy(false); toast(TX('Kaydedilemedi: ') + (e.message || e)); }
  };
}
async function cancelMulti() {
  if (!await dialog({ title: TX('Vazgeçilsin mi?'), text: TX('Bu uçuşlar kaydedilmeyecek.'), ok: TX('Vazgeç'), cancel: TX('Geri dön'), danger: true })) return;
  S.multi = null; go('home', 'back');
}
async function buildTicket(d, thumb) {
  const now = Date.now();
  let title = d.title;
  if (!title && d.type === 'ucak' && d.from && d.to) title = `${apCity(d.from) || d.from} → ${apCity(d.to) || d.to}`;
  const ticket = {
    id: d.id || uid(), title: title || typeOf(d.type).n, type: d.type, date: d.date, time: d.time,
    trip: d.trip, place: d.place, notes: d.notes, seat: d.seat, ref: d.ref,
    pageIds: d.pages.map(p => p.id), createdAt: d.createdAt || now, updatedAt: now, thumb: thumb || (d.pages[0] ? await makeThumb(d.pages[0].blob) : null),
  };
  if (d.type === 'ucak') Object.assign(ticket, { from: d.from, to: d.to, airline: d.airline, airlineName: d.airlineName, flightNo: d.flightNo, gate: d.gate, checkinH: +d.checkinH || 0, leg: d.leg || '' });
  else Object.assign(ticket, { lat: d.lat === '' || d.lat == null ? '' : +d.lat, lon: d.lon === '' || d.lon == null ? '' : +d.lon, mapUrl: d.mapUrl || '', locSrc: hasC(d) || d.mapUrl ? (d.geoLabel || '') : '', locApprox: hasC(d) && !d.mapUrl && !!d.geoApprox });
  if (d.type !== 'ucak' && d.type !== 'konaklama') ticket.endTime = d.endTime && d.time && d.endTime > d.time ? d.endTime : '';
  if (d.type === 'konaklama') Object.assign(ticket, { endDate: d.endDate && d.endDate >= d.date ? d.endDate : '', endTime: d.endTime });
  if (parseAmt(d.priceAmt) > 0) Object.assign(ticket, { priceAmt: String(parseAmt(d.priceAmt)), priceCur: (d.priceCur || baseCur()).toUpperCase().slice(0, 3) });
  for (const k of ['status', 'statusAuto', 'refund', 'pf', 'pPay', 'pSplit', 'pR', 'pRb', 'hph']) if (d[k] !== undefined && d[k] !== null && d[k] !== '') ticket[k] = d[k];
  if (ticket.pRb && ticket.priceCur && d.priceCur !== undefined && (d._pc0 || '') !== ticket.priceCur) { delete ticket.pR; delete ticket.pRb; }
  return ticket;
}
async function addNew(trip = '') {
  const v = await sheetMenu(trip ? TL`${trip} · ekle` : TX('Ne eklemek istiyorsun?'), [
    ...(trip ? [] : [{ icon: I('luggage'), label: TX('Yeni seyahat'), sub: TX('Önce seyahati aç, biletleri sonra ekle'), value: 'trip' }]),
    { icon: I('ticket'), label: TX('Bilet ekle'), sub: TX('PDF, fotoğraf ya da ekran görüntüsü'), value: 'ticket' },
    { icon: I('map-pin-plus'), label: TX('Yer ekle (biletsiz)'), sub: TX('Restoran, kafe, gezilecek yer…'), value: 'place' },
    ...(trip ? [] : [{ icon: I('download'), label: TX('Seyahat dosyası al'), sub: TX('Biri sana .dorago dosyası gönderdiyse'), value: 'recv' }]),
  ]);
  if (v === 'trip') return createTripFlow();
  if (v === 'recv') return receiveTripFile();
  if (v === 'place') return newPlace({ trip });
  if (v !== 'ticket') return;
  S.addTrip = trip; const f = await pickFiles('image/*,application/pdf'); if (!f.length) S.addTrip = ''; startImport(f);
}
/* öneriler: Google Haritalar'da otelin çevresinde arama; beğenilen yer Paylaş → DoraGo ile seyahate eklenir */
const SUGGEST = [
  { k: 'rest', icon: 'tools-kitchen-2', label: TX('Restoranlar'), q: 'restaurants' },
  { k: 'cafe', icon: 'coffee', label: TX('Kafeler'), q: 'cafes' },
  { k: 'bar', icon: 'glass-full', label: TX('Barlar'), q: 'bars' },
  { k: 'see', icon: 'camera', label: TX('Gezilecek yerler'), q: 'tourist attractions' },
  { k: 'kid', icon: 'mood-kid', label: TX('Çocukla gidilecek yerler'), q: 'things to do with kids' },
  { k: 'museum', icon: 'building-bank', label: TX('Müzeler'), q: 'museums' },
];
function tripCenter(name) {
  const ts = S.tickets.filter(t => t.trip === name);
  const a = tripAnchorAny({ trip: name, id: '' });
  if (a) { const ho = ts.find(t => t.type === 'konaklama' && hasC(t)); return { ...a, label: ho ? (ho.title || 'otel') : nearCity(a.lat, a.lon) || name }; }
  return null;
}
async function tripSuggest(name) {
  const c = tripCenter(name);
  const v = await sheetMenu(c ? TL`Öneriler · ${c.label} çevresi` : TL`Öneriler · ${name}`, [...(KIND_SUG[tripKind(name)] || []), ...SUGGEST].map(x => ({ icon: I(x.icon), label: x.label, sub: TX('Puanlar ve yorumlar Google Haritalar\'da'), value: x })));
  if (!v) return;
  if (!(await metaGet('sugHint'))) {
    const ok = await dialog({ title: TX('Google Haritalar açılıyor'), text: TL`Puanlara ve yorumlara bakıp beğendiğin yerde:<br><br>1. <b>Paylaş</b>'a bas<br>2. Listeden <b>DoraGo</b>'yu seç<br><br>Yer, konumuyla birlikte "${esc(name)}" seyahatinin Gezilecekler listesine eklenir.`, ok: TX('Tamam, aç'), cancel: TX('Vazgeç') });
    if (!ok) return; await metaSet('sugHint', true);
  }
  S.sugTrip = { trip: name, at: Date.now() };
  const q = c ? `${v.q}` : `${v.q} in ${name}`;
  const url = c ? `https://www.google.com/maps/search/${encodeURIComponent(q)}/@${(+c.lat).toFixed(5)},${(+c.lon).toFixed(5)},15z` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  openUrl(url, (mapApps().find(a => a.id === 'google') || {}).pkg || '');
}
/* biletsiz yer: restoran, kafe, gezilecek yer */
function newPlace(pre = {}) {
  const d = { id: null, type: 'gezi', trip: '', notes: '', checkinH: 24, pages: [], removed: [], auto: new Set() };
  for (const k of DRAFT_FIELDS) if (d[k] === undefined) d[k] = '';
  Object.assign(d, pre); d.auto = pre.auto || new Set();
  S.draft = d; go('edit');
}

async function editTicket(t) {
  const pages = S.cur && S.cur.t.id === t.id ? S.cur.pages : [];
  const d = { ...t, pages: pages.map(p => ({ ...p })), removed: [], auto: new Set(), geoLabel: t.locSrc || '', geoApprox: !!t.locApprox, _pc0: t.priceCur || '' };
  for (const k of DRAFT_FIELDS) if (d[k] === undefined) d[k] = k === 'checkinH' ? 24 : '';
  S.draft = d;
  go('edit');
}

function nightsBetween(a, b) {
  if (!a || !b) return 0;
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}
function apHint(code) {
  if (!code) return '';
  if (!TRAVEL) return '';
  const c = apCity(code); return c ? `${c} · ${apName(code)}` : TX('Havalimanı bulunamadı');
}

/* ---------- 5.24: havalimanı / havayolu arama (çevrimdışı, travel.json) ---------- */
const MAJOR_LIST = 'IST SAW ESB ADB AYT DLM BJV TZX ADA LHR LGW STN LTN LCY MAN EDI CDG ORY NCE MRS LYS FRA MUC BER DUS HAM STR CGN AMS EIN RTM BRU CRL FCO CIA MXP LIN BGY VCE NAP BLQ FLR PSA CTA PMO MAD BCN AGP PMI ALC VLC SVQ IBZ LIS OPO FAO ZRH GVA BSL VIE PRG BUD WAW KRK ATH SKG HER RHO CFU JTR JMK CPH ARN OSL HEL DUB KEF OTP SOF BEG ZAG SPU DBV LJU TIA SKP TBS BUS GYD EVN DXB AUH DOH JED RUH MED KWI BAH MCT AMM BEY CAI HRG SSH RAK CMN TUN TLV JFK EWR LGA BOS IAD ORD LAX SFO MIA ATL DFW SEA LAS YYZ YUL YVR MEX CUN GRU GIG EZE BOG LIM SCL NRT HND KIX ICN GMP PEK PKX PVG SHA HKG TPE BKK DMK HKT CNX SGN HAN KUL SIN CGK DPS MNL DEL BOM BLR MLE CMB KTM SYD MEL AKL JNB CPT NBO ADD ZNZ TAS ALA NQZ SVO DME LED'.split(' '), MAJOR_AP = new Map(MAJOR_LIST.map((c, i) => [c, i]));
const POP_AL = { TR: ['TK', 'PC', 'VF', 'XQ', 'XC'], GB: ['BA', 'U2', 'FR', 'LS', 'VS'], DE: ['LH', 'EW', 'DE', 'FR', 'TK'], US: ['AA', 'DL', 'UA', 'WN', 'B6'], FR: ['AF', 'U2', 'TO', 'FR'], NL: ['KL', 'HV', 'U2'], IT: ['AZ', 'FR', 'U2', 'W6'], ES: ['IB', 'VY', 'UX', 'FR'], AE: ['EK', 'EY', 'FZ', 'G9'], AZ: ['J2', 'TK'], _: ['EK', 'QR', 'TK', 'LH', 'BA', 'AF'] };
const nrm = x => String(x || '').replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase().replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
let AP_IDX = null, AL_IDX = null;
const CITY_TR = (() => { const r = {}; try { for (const [k, v] of Object.entries(CITY_EN)) r[v] = k; } catch (e) {} return r; })();
function apIndex() {
  if (AP_IDX || !TRAVEL) return AP_IDX;
  AP_IDX = Object.entries(TRAVEL.ap).map(([c, v]) => ({ c, city: nrm(v[0]), alt: nrm((typeof CITY_EN !== 'undefined' && CITY_EN[v[0]]) || CITY_TR[v[0]] || ''), name: nrm(v[1]), cc: v[2], rk: MAJOR_AP.has(c) ? MAJOR_AP.get(c) : 900 }));
  return AP_IDX;
}
function apSearch(q, n = 6) {
  const idx = apIndex(), t = nrm(q); if (!idx || !t) return [];
  const up = q.trim().toUpperCase(), out = [];
  for (const a of idx) {
    let sc = null;
    if (a.c === up) sc = 0;
    else if (a.city.startsWith(t) || (a.alt && a.alt.startsWith(t))) sc = 1;
    else if ((' ' + a.name).includes(' ' + t)) sc = 2;
    else if (t.length >= 3 && (a.city.includes(t) || a.name.includes(t) || (a.alt && a.alt.includes(t)))) sc = 3;
    if (sc == null) continue;
    out.push({ a, sc: sc * 1000 + a.rk });
  }
  out.sort((x, y) => x.sc - y.sc || (x.a.city < y.a.city ? -1 : 1));
  return out.slice(0, n).map(({ a }) => ({ v: a.c, code: a.c, t: TRAVEL.ap[a.c][0] + ' – ' + TRAVEL.ap[a.c][1], s: `${flagOf(a.cc) || ''} ${countryName(a.cc) || a.cc}`.trim() }));
}
function alSearch(q, n = 6) {
  if (!TRAVEL) return [];
  if (!AL_IDX) AL_IDX = Object.entries(TRAVEL.al).map(([c, v]) => ({ c, n: nrm(v) }));
  const t = nrm(q), up = q.trim().toUpperCase();
  if (!t) return (POP_AL[HOME_CC] || POP_AL._).filter(c => TRAVEL.al[c]).map(c => ({ v: TRAVEL.al[c], code: c, t: TRAVEL.al[c], s: TX('Sık kullanılan') }));
  const out = [];
  for (const a of AL_IDX) {
    let sc = null;
    if (a.c === up) sc = 0; else if (a.n.startsWith(t)) sc = 1; else if ((' ' + a.n).includes(' ' + t)) sc = 2; else if (t.length >= 3 && a.n.includes(t)) sc = 3;
    if (sc == null) continue;
    const pop = Object.values(POP_AL).some(l => l.includes(a.c));
    out.push({ a, sc: sc * 10 - (pop ? 5 : 0) });
  }
  out.sort((x, y) => x.sc - y.sc || x.a.n.length - y.a.n.length);
  return out.slice(0, n).map(({ a }) => ({ v: TRAVEL.al[a.c], code: a.c, t: TRAVEL.al[a.c], s: TL`Uçuş no: ${a.c}…` }));
}
/* öneri listesi: alanın satırının hemen altında akışta açılır */
function acBind(inp, search, pick, opt = {}) {
  if (!inp) return;
  const host = inp.closest('.row2') || inp.closest('.fld');
  let box = null, items = [];
  const close = () => { if (box) { box.remove(); box = null; } };
  const show = () => {
    items = search(inp.value);
    if (!items.length || (opt.hideExact && items.length === 1 && items[0].code === inp.value.trim().toUpperCase() && opt.hideExact(inp.value))) { close(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'acd'; host.after(box); }
    box.innerHTML = items.map((it, i) => `<button type="button" class="acr" data-i="${i}"><span class="acc">${esc(it.code)}</span><span class="act"><b>${esc(it.t)}</b><small>${esc(it.s || '')}</small></span></button>`).join('');
    $$('.acr', box).forEach(b => {
      b.addEventListener('pointerdown', e => e.preventDefault());
      b.onclick = () => { const it = items[+b.dataset.i]; close(); pick(it); };
    });
  };
  inp.addEventListener('input', show);
  inp.addEventListener('focus', () => { if (opt.onEmpty || inp.value) show(); });
  inp.addEventListener('blur', () => setTimeout(() => { if (opt.onBlur && box && document.activeElement !== inp) opt.onBlur(items); close(); }, 180));
  inp._acClose = close;
}
/* ---------- düzenleme formu: konum kartı ---------- */
function locView(d) {
  const c = hasC(d), src = d.geoLabel || '';
  const fromGoogle = src.startsWith('Google Haritalar'), fromPdf = src.startsWith('PDF'), fromLink = src.startsWith('Bağlantı'), fromGAddr = src.startsWith('Google adresi');
  const parts = src && !fromGoogle && !fromPdf && !fromLink && !fromGAddr ? src.split(',').map(x => x.trim()).filter(Boolean) : [];
  const cityN = cityNames(geoQueries(d).city);
  const cityPart = parts.find(p => cityN.includes(lowerSmart(p))) || parts[parts.length > 3 ? parts.length - 4 : 2] || '';
  const osmSub = [parts[1], cityPart].filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
  if (d.mapUrl) { const nm = src.replace(/^Google (Haritalar|adresi):\s*/, '') || d.title || TX('Konum'), nc1 = c ? nearCity(d.lat, d.lon) : ''; return { st: 'ok', head: nm, sub: TX('Google Haritalar bağlantısı') + (nc1 ? ' · ' + nc1 : '') }; }
  if (!c) return { st: 'no', head: TX('Konum eklenmedi'), sub: d.place || d.title || '' };
  if (fromGAddr) { const nc0 = nearCity(d.lat, d.lon); return { st: d.geoApprox ? 'ap' : 'ok', head: src.slice(15) || d.title || TX('Konum'), sub: TX('Google\'ın verdiği adresten bulundu') + (nc0 ? ' · ' + nc0 : '') }; }
  if (d.geoApprox) return { st: 'ap', head: parts[0] || TX('Yaklaşık konum'), sub: [osmSub, TX('OpenStreetMap')].filter(Boolean).join(' · ') };
  const nc = nearCity(d.lat, d.lon), at = nc ? ' · ' + nc : '';
  if (fromGoogle) return { st: 'ok', head: src.slice(18) || d.title || TX('Seçilen yer'), sub: TX('Google Haritalar\'dan alındı') + at };
  if (fromPdf) return { st: 'ok', head: d.title || TX('Konum'), sub: TX('Biletteki harita bağlantısından') + at };
  if (fromLink) return { st: 'ok', head: d.title || TX('Konum'), sub: TX('Yapıştırılan bağlantıdan') + at };
  if (parts.length) return { st: 'ok', head: parts[0], sub: [osmSub, TX('OpenStreetMap')].filter(Boolean).join(' · ') };
  return { st: 'ok', head: d.title || TX('Konum'), sub: TX('Konum kayıtlı') + at };
}
function locCardHtml(d) {
  const v = locView(d), geoOK = canGeo() && (d.place || d.title);
  return TL`<div class="fld"><label>Konum</label><div class="lcard${d.auto && d.auto.has('lat') ? ' auto' : ''}">
    <div class="lrow${v.st !== 'no' ? ' tap' : ''}" id="locRow"><div class="lpin ${v.st}">${I('map-pin')}</div><div class="lt"><b>${esc(v.head)}${v.st === 'ap' ? TX('<span class="lbadge ap">YAKLAŞIK</span>') : v.st === 'ok' ? '<span class="lbadge ok">✓</span>' : ''}</b>${v.sub ? `<span>${esc(v.sub)}</span>` : ''}</div>
      ${v.st !== 'no' ? TX('<button class="lmore" id="locMore" aria-label="Konum seçenekleri">⋯</button>') : ''}</div>
    ${v.st === 'no' ? TL`<button class="lbtn pri" id="locG">${I('map-pin')} Google Haritalar'da seç</button>
      <div class="llinks">${geoOK ? TX('<button id="locGeo">Adresten otomatik bul</button>') : ''}<button id="locPasteT">Bağlantı yapıştır</button></div>`
      : v.st === 'ap' ? TL`<button class="lbtn amb" id="locG">${I('focus-2')} Tam yeri Google Haritalar'da seç</button>
      <p class="lnote">Tam yer haritada bulunamadı; en yakın yer olarak ${esc(v.head)} gösteriliyor.</p>` : ''}
    <div class="lpaste hidden" id="locPaste"><input class="inp" id="f-loc" placeholder="Harita bağlantısı ya da koordinat" autocomplete="off"><button class="btn" id="locAdd">Ekle</button></div>
  </div></div>`;
}
function bindLocCard(app, d, sync) {
  const openGoogle = async () => {
    sync();
    if (A && !(await metaGet('gmHint'))) {
      const ok = await dialog({ title: TX('Google Haritalar açılıyor'), text: TX('1. Doğru yere dokun<br>2. <b>Paylaş</b>\'a bas<br>3. Listeden <b>DoraGo</b>\'yu seç<br><br>Konum otomatik olarak bu bilete eklenir.'), ok: TX('Tamam, aç'), cancel: TX('Vazgeç') });
      if (!ok) return; await metaSet('gmHint', true);
    }
    const q = d.title && d.place && d.place.toLowerCase().includes(d.title.toLowerCase()) ? d.place : [d.title, d.place].filter(Boolean).join(', ');
    openUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || 'konum')}`, (mapApps().find(a => a.id === 'google') || {}).pkg || '');
  };
  const showPaste = () => { const p = $('#locPaste'); p.classList.remove('hidden'); setTimeout(() => $('#f-loc').focus(), 50); };
  const g = $('#locG'); if (g) g.onclick = openGoogle;
  const pt = $('#locPasteT'); if (pt) pt.onclick = showPaste;
  const row = $('#locRow.tap');
  if (row) row.onclick = e => { if (e.target.closest('#locMore')) return; sync(); showOnMap({ lat: hasC(d) ? +d.lat : '', lon: hasC(d) ? +d.lon : '', url: d.mapUrl || '', name: locView(d).head || d.title || TX('Konum'), address: d.place || '' }); };
  const more = $('#locMore');
  if (more) more.onclick = async () => {
    sync();
    const v = await sheetMenu(TX('Konum'), [
      { icon: I('map'), label: TX('Haritada göster'), value: 'show' },
      { icon: I('refresh'), label: TX('Başka bir yer seç'), sub: TX('Google Haritalar\'da seç → Paylaş → DoraGo'), value: 'pick' },
      { icon: I('link'), label: TX('Bağlantı yapıştır'), value: 'paste' },
      { icon: I('trash'), label: TX('Konumu kaldır'), value: 'del', danger: true },
    ]);
    if (v === 'show') showOnMap({ lat: hasC(d) ? +d.lat : '', lon: hasC(d) ? +d.lon : '', url: d.mapUrl || '', name: locView(d).head || d.title || TX('Konum'), address: d.place || '' });
    else if (v === 'pick') openGoogle();
    else if (v === 'paste') showPaste();
    else if (v === 'del') { d.lat = ''; d.lon = ''; d.mapUrl = ''; d.geoLabel = ''; d.geoApprox = false; d.auto && d.auto.delete('lat'); renderEdit(app); }
  };
  const la = $('#locAdd');
  if (la) la.onclick = async () => {
    sync(); const v = $('#f-loc').value.trim(); if (!v) { toast(TX('Önce bir bağlantı ya da koordinat yapıştır')); return; }
    const sh = await locFromShare(v, d);
    let ll = sh.ll, nm = sh.name || (sh.placeText || '').split(',')[0].trim(), label = nm ? TL`Google Haritalar: ${nm}` : TX('Bağlantıdan eklendi'), approx = false;
    if (!ll && !sh.err && (sh.placeText || nm)) { const fb = await shareFallback({ ...sh, name: nm }, d); if (fb.ll) { ll = fb.ll; label = fb.label; approx = fb.approx !== false; } }
    if (!ll && !sh.link) { toast(sh.err ? TX('Bağlantı açılamadı. İnternet bağlantını kontrol et.') : TX('Bu bağlantıda konum bulunamadı. ') + shareHelp, 4500); return; }
    if (sh.link) { label = nm ? TL`Google Haritalar: ${nm}` : TX('Google Haritalar'); approx = false; }
    Object.assign(d, { lat: ll ? ll.lat : '', lon: ll ? ll.lon : '', mapUrl: sh.link || '', geoLabel: label, geoApprox: approx }); d.auto && d.auto.delete('lat');
    toast(TX('Konum eklendi')); renderEdit(app);
  };
  const lg = $('#locGeo');
  if (lg) lg.onclick = async () => {
    sync();
    if (S.geocode === false && !await dialog({ title: TX('Adresten konum'), text: TX('Adres OpenStreetMap tabanlı servislere gönderilerek konum aranacak (internet gerekir). Ayarlar\'da bu özellik kapalı, bu sefer için arayayım mı?'), ok: TX('Ara') })) return;
    const prev = S.geocode; if (prev === false) S.geocode = true;
    const st = await findLocation(d, '', true);
    if (prev === false) S.geocode = false;
    toast(geoMsg[st] || TX('Konum bulunamadı'), 3500); renderEdit(app);
  };
}

/* tam ekran sayfa görüntüleyici: kaydırarak sayfa değiştir, iki parmakla / çift dokunarak yakınlaştır */
function openLightbox(blobs, start = 0, opts = {}) {
  let wake = null;
  if (opts.bright) { if (S.autoBright) brightness(true); try { if (A && A.keepScreenOn) A.keepScreenOn(true); else if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {}); } catch (e) {} }
  const ov = document.createElement('div'); ov.className = 'lb';
  const urls = blobs.map(b => URL.createObjectURL(b));
  ov.innerHTML = TL`<div class="lb-top"><span class="lb-n"></span><button class="lb-x" aria-label="Kapat">${I('x')}</button></div>
    <div class="lb-track">${urls.map(u => `<div class="lb-s"><img src="${u}" alt="" draggable="false"></div>`).join('')}</div>`;
  document.body.appendChild(ov);
  const track = $('.lb-track', ov), n = $('.lb-n', ov), slides = $$('.lb-s', ov);
  const idx = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const upd = () => { n.textContent = urls.length > 1 ? `${idx() + 1} / ${urls.length}` : ''; };
  requestAnimationFrame(() => { track.scrollLeft = start * track.clientWidth; upd(); });
  track.addEventListener('scroll', upd, { passive: true });
  const close = () => { ov.classList.add('out'); dlgClose = null; if (opts.bright) { brightness(false); try { if (A && A.keepScreenOn) A.keepScreenOn(false); else if (wake) wake.release(); } catch (e) {} } setTimeout(() => { ov.remove(); urls.forEach(u => URL.revokeObjectURL(u)); }, 180); };
  $('.lb-x', ov).onclick = close; dlgClose = close;
  slides.forEach(sl => {
    const img = $('img', sl); let z = { s: 1, x: 0, y: 0 }, pts = new Map(), g = null, lastTap = 0;
    const apply = anim => { img.style.transition = anim ? 'transform .22s' : 'none'; img.style.transform = `translate(${z.x}px,${z.y}px) scale(${z.s})`; track.classList.toggle('zoomed', z.s > 1.01); };
    const clampP = () => { const r = sl.getBoundingClientRect(), mx = (img.offsetWidth * z.s - r.width) / 2, my = (img.offsetHeight * z.s - r.height) / 2; z.x = Math.max(-Math.max(0, mx), Math.min(Math.max(0, mx), z.x)); z.y = Math.max(-Math.max(0, my), Math.min(Math.max(0, my), z.y)); };
    const reset = () => { z = { s: 1, x: 0, y: 0 }; apply(true); };
    sl.addEventListener('pointerdown', e => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; g = { d: Math.hypot(a.x - b.x, a.y - b.y), s: z.s }; }
      else if (pts.size === 1) g = { px: e.clientX, py: e.clientY, x: z.x, y: z.y };
    });
    sl.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && g && g.d) { const [a, b] = [...pts.values()]; z.s = Math.max(1, Math.min(5, g.s * Math.hypot(a.x - b.x, a.y - b.y) / g.d)); clampP(); apply(false); }
      else if (pts.size === 1 && z.s > 1.01 && g && g.px != null) { z.x = g.x + e.clientX - g.px; z.y = g.y + e.clientY - g.py; clampP(); apply(false); }
    });
    const up = e => {
      if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId);
      if (pts.size === 1) { const [a] = [...pts.values()]; g = { px: a.x, py: a.y, x: z.x, y: z.y }; }
      if (pts.size === 0) { if (z.s < 1.05) reset(); g = null; }
      if (e.type === 'pointerup' && pts.size === 0) {
        const now = Date.now();
        if (now - lastTap < 300) { // çift dokunma
          if (z.s > 1.01) reset();
          else { const r = sl.getBoundingClientRect(); z.s = 2.5; z.x = (r.width / 2 - (e.clientX - r.left)) * 1.5; z.y = (r.height / 2 - (e.clientY - r.top)) * 1.5; clampP(); apply(true); }
          lastTap = 0;
        } else lastTap = now;
      }
    };
    ['pointerup', 'pointercancel'].forEach(t => sl.addEventListener(t, up));
    track.addEventListener('scroll', () => { if (z.s > 1 && slides[idx()] !== sl) reset(); }, { passive: true });
  });
}
function renderEdit(app, anim) {
  const d = S.draft, isNew = !d.id;
  const trips = [...new Set(S.tickets.map(t => t.trip).filter(Boolean))];
  const A_ = k => d.auto && d.auto.has(k) ? ' auto' : '';
  const inp = (id, label, k, attrs = '', type = 'text') => `<div class="fld"><label for="f-${id}">${label}</label><input class="inp${A_(k)}" type="${type}" id="f-${id}" data-k="${k}" value="${esc(d[k])}" ${attrs}></div>`;
  let typeFields = '';
  if (d.type === 'ucak') {
    typeFields = TL`
      <div class="row2"><div class="fld"><label for="f-from">Kalkış</label><input class="inp code${A_('from')}" id="f-from" data-k="from" maxlength="40" autocomplete="off" placeholder="örn. IST" value="${esc(d.from)}" autocapitalize="characters"><div class="sub" id="h-from">${esc(apHint(d.from))}</div></div>
        <div class="swap"><button class="icon-btn" id="swap" aria-label="Kalkış ve varışı değiştir">${I('arrows-exchange')}</button></div>
        <div class="fld"><label for="f-to">Varış</label><input class="inp code${A_('to')}" id="f-to" data-k="to" maxlength="40" autocomplete="off" placeholder="örn. FCO" value="${esc(d.to)}" autocapitalize="characters"><div class="sub" id="h-to">${esc(apHint(d.to))}</div></div></div>
      <div class="row2"><div class="fld" style="flex:1.4"><label for="f-airlineName">Havayolu</label><input class="inp${A_('airline')}" id="f-airlineName" data-k="airlineName" autocomplete="off" placeholder="örn. Pegasus" value="${esc(d.airlineName || alName(d.airline))}">
          </div>
        ${inp('flightNo', TX('Uçuş no'), 'flightNo', TX('maxlength="8" placeholder="örn. TK1861" autocapitalize="characters"'))}</div>
      <div class="row2">${inp('date', TX('Tarih'), 'date', '', 'date')}${inp('time', TX('Kalkış saati'), 'time', '', 'time')}</div>
      <div class="row2">${inp('seat', TX('Koltuk'), 'seat', TX('maxlength="5" placeholder="örn. 12A"'))}${inp('gate', TX('Kapı'), 'gate', TX('maxlength="6" placeholder="örn. B12"'))}${inp('ref', 'PNR', 'ref', 'maxlength="12" autocapitalize="characters"')}</div>
      <div class="fld"><label for="f-checkinH">Check-in hatırlatması</label><select class="inp" id="f-checkinH" data-k="checkinH">
        ${[[0, TX('Kapalı')], [24, TX('24 saat önce')], [48, TX('48 saat önce')], [72, TX('72 saat önce')]].map(([v, n]) => `<option value="${v}" ${+d.checkinH === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <div class="sub">Çoğu havayolunda online check-in uçuştan 24 saat önce açılır.</div></div>`;
  } else if (d.type === 'konaklama') {
    const n = nightsBetween(d.date, d.endDate);
    typeFields = `
      <div class="row2">${inp('date', TX('Giriş tarihi'), 'date', '', 'date')}${inp('time', TX('Giriş saati'), 'time', '', 'time')}</div>
      <div class="row2">${inp('endDate', TX('Çıkış tarihi'), 'endDate', `min="${esc(d.date)}"`, 'date')}${inp('endTime', TX('Çıkış saati'), 'endTime', '', 'time')}</div>
      <div class="sub" id="nights" style="margin:-6px 2px 12px">${n > 0 ? TL`${n} gece` : ''}</div>
      ${inp('place', TX('Adres'), 'place', 'maxlength="120"')}
      ${inp('ref', TX('Rezervasyon no'), 'ref', 'maxlength="20"')}`;
  } else {
    typeFields = `
      ${inp('date', isPlace(d.type) ? TX('Tarih (isteğe bağlı)') : TX('Tarih'), 'date', '', 'date')}
      <div class="row2">${inp('time', TX('Başlangıç saati'), 'time', '', 'time')}${inp('endTime', TX('Bitiş saati (isteğe bağlı)'), 'endTime', '', 'time')}</div>
      ${inp('place', d.type === 'ulasim' ? TX('Kalkış / varış') : TX('Yer / mekân'), 'place', 'maxlength="100"')}
      ${isPlace(d.type) ? (d.type === 'yemek' ? inp('ref', TX('Rezervasyon no (isteğe bağlı)'), 'ref', 'maxlength="24"') : '') : `<div class="row2">${inp('seat', d.type === 'ulasim' ? TX('Vagon / koltuk') : TX('Koltuk / sıra'), 'seat', 'maxlength="30"')}${inp('ref', TX('Bilet / rezervasyon no'), 'ref', 'maxlength="24"')}</div>`}`;
  }
  if (d.type !== 'ucak') typeFields += locCardHtml(d);
  const autoCount = d.auto ? d.auto.size : 0;
  app.innerHTML = TL`<div class="page${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="cancel" aria-label="Vazgeç">${I('x')}</button><h2>${isPlace(d.type) ? (isNew ? TX('Yeni yer') : TX('Yeri düzenle')) : isNew ? TX('Yeni bilet') : TX('Bileti düzenle')}</h2></div>
    <div class="form">
      ${d.fromShare ? TL`<div class="autonote">${I('map-pin')} Google Haritalar'dan eklendi. Türünü seç; istersen tarih ve saat ekle (tarihsiz yerler seyahatin "Gezilecekler" listesinde durur).</div>` : autoCount ? TL`<div class="autonote">${I('sparkles')} Biletten ${autoCount} bilgi okundu ve dolduruldu. İşaretli alanları kontrol et.</div>` : ''}
      <div class="fld"><label>Tür</label><div class="types">${TYPES.map(t => `<button class="chip ${d.type === t.k ? 'on' : ''}" data-t="${t.k}">${I(t.ic)} ${t.n}</button>`).join('')}</div></div>
      ${inp('title', d.type === 'konaklama' ? TX('Otel / konaklama adı') : isPlace(d.type) ? TX('Yerin adı') : TX('Başlık'), 'title', `maxlength="80" placeholder="${d.type === 'ucak' ? TX('Boş bırakırsan rota yazılır') : d.type === 'yemek' ? TX('Örn. Sahil restoranı') : d.type === 'gezi' ? TX('Örn. Tarihi merkez yürüyüşü') : TX('Örn. Louvre Müzesi')}"`)}
      ${typeFields}
      <div class="row2"><div class="fld" style="flex:1.6"><label for="f-priceAmt">Fiyat (isteğe bağlı)</label><input class="inp" id="f-priceAmt" data-k="priceAmt" inputmode="decimal" placeholder="Masraflara eklenir" value="${esc(d.priceAmt)}" autocomplete="off"></div>
        <div class="fld"><label for="f-priceCur">Para</label><input class="inp code" id="f-priceCur" data-k="priceCur" list="curl" maxlength="3" autocapitalize="characters" placeholder="${baseCur()}" value="${esc(d.priceCur)}"><datalist id="curl">${CURS.map(c => `<option value="${c}">`).join('')}</datalist></div></div>
      <div class="fld"><label for="tripBtn">Seyahat (isteğe bağlı)</label><input type="hidden" id="f-trip" data-k="trip" value="${esc(d.trip)}">
        <button class="inp tripbtn ${d.trip ? '' : 'empty'}" id="tripBtn" type="button">${I('luggage')}<span>${esc(d.trip || TX('Seyahat seç'))}</span>${I('chevron-down')}</button></div>
      <div class="fld"><label for="f-notes">Not</label><textarea class="inp" id="f-notes" data-k="notes" maxlength="1000">${esc(d.notes)}</textarea></div>
      <div class="fld"><label>${isPlace(d.type) ? TL`Fotoğraflar (isteğe bağlı${d.pages.length ? ' · ' + d.pages.length : ''})` : TL`Sayfalar (${d.pages.length})`}</label><div class="pgrid">
        ${d.pages.map((p, i) => TL`<div class="pg" data-pv="${i}" style="background-image:url('${blobURL('p:' + p.id, p.blob)}')"><button class="x" data-rm="${i}" aria-label="Sayfayı kaldır">${I('x')}</button><span class="n">${i + 1}</span></div>`).join('')}
        <button class="pg add" id="addPg">＋<br>${isPlace(d.type) ? TX('Fotoğraf ekle') : TX('Sayfa ekle')}</button></div></div>
    </div>
    <div class="actions">${isNew ? '' : TX('<button class="btn dan" id="del">Sil</button>')}<button class="btn pri" id="save">${d.multiIdx != null ? TX('Tamam') : TX('Kaydet')}</button></div></div>`;
  if (d.multiIdx != null) { const pg = $('#addPg')?.closest('.fld'); if (pg) pg.remove(); }

  const sync = () => {
    $$('[data-k]', app).forEach(el => { d[el.dataset.k] = el.tagName === 'SELECT' ? +el.value : el.value.trim(); });
    if (d.from) d.from = d.from.toUpperCase(); if (d.to) d.to = d.to.toUpperCase();
    if (d.flightNo) d.flightNo = d.flightNo.toUpperCase().replace(/\s+/g, '');
    if (d.type === 'ucak') {
      const code = (d.airline && alName(d.airline) === d.airlineName ? d.airline : '') || alFind(d.airlineName) || (d.flightNo && TRAVEL && TRAVEL.al[d.flightNo.slice(0, 2)] ? d.flightNo.slice(0, 2) : '');
      d.airline = code || ''; if (code && !d.airlineName) d.airlineName = alName(code);
    }
  };
  $$('[data-k]', app).forEach(el => el.addEventListener('input', () => {
    el.classList.remove('auto');
    if (el.id === 'f-from' || el.id === 'f-to') { const v = el.value.trim(); $('#h-' + el.id.slice(2)).textContent = v.length === 3 && TRAVEL && TRAVEL.ap[v.toUpperCase()] ? apHint(v.toUpperCase()) : ''; }
    if (el.id === 'f-date' || el.id === 'f-endDate') { const n = nightsBetween($('#f-date').value, $('#f-endDate')?.value); const nn = $('#nights'); if (nn) nn.textContent = n > 0 ? TL`${n} gece` : ''; if ($('#f-endDate')) $('#f-endDate').min = $('#f-date').value; }
  }));
  /* 5.24: havalimanı ve havayolu önerileri */
  for (const k of ['from', 'to']) {
    const inp = $('#f-' + k); if (!inp) continue;
    const set = it => { inp.value = it.code; inp.classList.remove('auto'); inp.dispatchEvent(new Event('input')); const h = $('#h-' + k); if (h) h.textContent = apHint(it.code); };
    acBind(inp, q => q.trim().length >= 2 ? apSearch(q) : [], set, {
      hideExact: v => TRAVEL && TRAVEL.ap[v.trim().toUpperCase()],
      onBlur: items => { const v = inp.value.trim(); if (v && !(v.length === 3 && TRAVEL && TRAVEL.ap[v.toUpperCase()]) && items[0]) set(items[0]); else if (v.length === 3) inp.value = v.toUpperCase(); }
    });
    inp.addEventListener('blur', () => { const v = inp.value.trim(); if (v.length === 3 && /^[a-z]{3}$/i.test(v)) inp.value = v.toUpperCase(); });
  }
  const alIn = $('#f-airlineName');
  if (alIn) acBind(alIn, q => alSearch(q), it => { alIn.value = it.v; d.airlineName = it.v; d.airline = it.code; alIn.classList.remove('auto'); }, { onEmpty: true });
  bindLocCard(app, d, sync);
  const tb = $('#tripBtn'); if (tb) tb.onclick = async () => {
    sync();
    const items = tripChoices(d.trip, d.date).map(g => ({ icon: I(g.name === d.trip ? 'circle-check' : 'luggage'), label: g.name, sub: tripSub(g) + (g.past ? TX(' · geçmiş') : ''), value: { t: g.name } }));
    items.push({ icon: I('plus'), label: TX('Yeni seyahat…'), value: { nw: true } });
    if (d.trip) items.push({ icon: I('x'), label: TX('Seyahat yok'), sub: TX('Bileti seyahatten çıkar'), value: { t: '' } });
    const v = await sheetMenu(TX('Seyahat seç'), items); if (!v) return;
    let name = v.t;
    if (v.nw) { name = await newTrip(d.type === 'ucak' && d.to && d.date ? autoTripName(d) : d.date ? `${MONTH_TR[+d.date.slice(5, 7) - 1]} ${d.date.slice(0, 4)}` : ''); if (!name) return; }
    d.trip = name; $('#f-trip').value = name; tb.classList.toggle('empty', !name); $('span', tb).textContent = name || TX('Seyahat seç');
  };
  const sw = $('#swap'); if (sw) sw.onclick = () => { sync(); [d.from, d.to] = [d.to, d.from]; renderEdit(app); };
  $$('[data-t]').forEach(b => b.onclick = () => { sync(); d.type = b.dataset.t; renderEdit(app); });
  $$('.pg[data-pv]').forEach(el => el.onclick = e => { if (e.target.closest('[data-rm]')) return; sync(); openLightbox(d.pages.map(p => p.blob), +el.dataset.pv); });
  $$('[data-rm]').forEach(b => b.onclick = () => {
    sync(); const [p] = d.pages.splice(+b.dataset.rm, 1); if (p && !p.isNew) d.removed.push(p.id); renderEdit(app);
  });
  if ($('#addPg')) $('#addPg').onclick = async () => {
    sync(); const files = await pickFiles('image/*,application/pdf'); if (!files.length) return;
    const { pages } = await filesToPages(files);
    d.pages.push(...pages.map(p => ({ id: uid(), ...p, isNew: true }))); renderEdit(app);
  };
  $('#cancel').onclick = () => cancelEdit();
  $('#save').onclick = async () => {
    sync();
    if (!d.pages.length && !isPlace(d.type)) { toast(TX('En az bir sayfa olmalı. Biletsiz bir yer eklemek için türü Yeme-içme ya da Gezi yap.'), 4000); return; }
    if (isPlace(d.type) && !d.title) { toast(TX('Yerin adını yaz')); return; }
    if (d.type !== 'ucak' && hasC(d) && d.trip) {
      const an = (d.date && tripAnchor(d)) || tripAnchorAny(d), dk = an ? distKm(an, { lat: +d.lat, lon: +d.lon }) : 0;
      if (an && dk > 300) {
        const here = nearCity(d.lat, d.lon) || TX('başka bir şehirde'), there = nearCity(an.lat, an.lon) || TX('başka bir yerde');
        if (!await dialog({ title: TX('Konum doğru mu?'), text: TL`Bu kaydın konumu <b>${esc(here)}</b> (${Math.round(dk)} km uzakta), "${esc(d.trip)}" seyahati ise <b>${esc(there)}</b>.`, ok: TX('Evet, kaydet'), cancel: TX('Konumu düzelt') })) { $('.lcard')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      }
    }
    if (d.type === 'konaklama' && d.endDate && d.date && d.endDate < d.date) { toast(TX('Çıkış tarihi girişten önce olamaz')); return; }
    if (d.multiIdx != null && S.multi) { S.multi.legs[d.multiIdx] = d; S.multi.trip = d.trip || S.multi.trip; S.draft = null; go('multi', 'back'); return; }
    busy(TX('Kaydediliyor…'));
    try {
      const ticket = await buildTicket(d);
      const newPages = d.pages.filter(p => p.isNew).map(p => ({ id: p.id, blob: p.blob, w: p.w, h: p.h }));
      await saveTicketDB(ticket, newPages, pagesInUse(d.removed, d.id));
      S.tickets = S.tickets.filter(t => t.id !== ticket.id).concat(ticket);
      busy(false); S.draft = null; toast(isPlace(ticket.type) ? TX('Yer kaydedildi') : TX('Bilet kaydedildi'));
      S.cur = { t: ticket, pages: d.pages.map(p => ({ id: p.id, blob: p.blob, w: p.w, h: p.h })), zoom: 1 };
      go('view');
      syncReminders(); if (ticket.date) maybeAskNotif();
    } catch (e) { console.error(e); busy(false); toast(TX('Kaydedilemedi: ') + (e.message || e)); }
  };
  const del = $('#del');
  if (del) del.onclick = async () => {
    if (!await dialog({ title: TX('Bilet silinsin mi?'), text: TL`<b>${esc(d.title)}</b> kalıcı olarak silinecek.`, ok: TX('Sil'), danger: true })) return;
    const t = S.tickets.find(x => x.id === d.id);
    await deleteTicketDB(t); S.tickets = S.tickets.filter(x => x.id !== d.id); S.draft = null; S.cur = null;
    toast(TX('Bilet silindi')); go('home', 'back'); syncReminders();
  };
}
async function cancelEdit() {
  const d = S.draft;
  if (d.multiIdx != null && S.multi) { S.draft = null; go('multi', 'back'); return; }
  if (!d.id && !await dialog({ title: TX('Vazgeçilsin mi?'), text: TX('Bu bilet kaydedilmeyecek.'), ok: TX('Vazgeç'), cancel: TX('Düzenlemeye dön'), danger: true })) return;
  S.draft = null;
  if (d.id && S.cur) go('view', 'back'); else go('home', 'back');
}
async function makeThumb(blob) {
  try {
    const bmp = await createImageBitmap(blob); const w = 180, h = Math.round(bmp.height * w / bmp.width);
    const c = document.createElement('canvas'); c.width = w; c.height = Math.min(h, 400);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
    return await canvasBlob(c, 'image/jpeg', 0.75);
  } catch (e) { return null; }
}

/* ================= konum ve haritalar ================= */
let MAPAPPS = null;
function mapApps() {
  if (MAPAPPS) return MAPAPPS;
  try { MAPAPPS = A && A.mapApps ? JSON.parse(A.mapApps()) : IS_IOS ? [{ id: 'apple', pkg: '', name: TX('Apple Haritalar') }, { id: 'google', pkg: '', name: TX('Google Haritalar') }, { id: 'citymapper', pkg: '', name: TX('Citymapper') }] : [{ id: 'google', pkg: '', name: TX('Google Haritalar') }]; } catch (e) { MAPAPPS = []; }
  return MAPAPPS;
}
const hasC = l => l && l.lat !== '' && l.lat != null && !isNaN(+l.lat);
const apLL = c => (TRAVEL && TRAVEL.ap[c] && TRAVEL.ap[c][3] != null ? { lat: TRAVEL.ap[c][3], lon: TRAVEL.ap[c][4] } : { lat: '', lon: '' });
/* Citymapper varış saati: yerel saat, saat dilimi eklenmeden (gidilen şehrin saatiyle yorumlanır) */
function isoLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
/* bir biletin konumları: uçuşta kalkış + varış havalimanı */
function ticketLocs(t) {
  const out = [];
  if (t.type === 'ucak') {
    const intl = t.from && t.to && TRAVEL && TRAVEL.ap[t.from] && TRAVEL.ap[t.to] && TRAVEL.ap[t.from][2] !== TRAVEL.ap[t.to][2];
    const start = t.date && t.time ? at(t.date, t.time) : 0;
    if (t.from) out.push({ label: TX('Kalkış'), icon: I('plane-departure'), name: `${apName(t.from) || t.from} (${t.from})`, address: apCity(t.from), ...apLL(t.from), arriveBy: start ? isoLocal(start - (intl ? 3 : 2) * 3600000) : '', hint: start ? TL`Havalimanında ${intl ? '3' : '2'} saat önce ol` : '' });
    if (t.to) out.push({ label: TX('Varış'), icon: I('plane-arrival'), name: `${apName(t.to) || t.to} (${t.to})`, address: apCity(t.to), ...apLL(t.to) });
  } else if (hasC(t) || t.place || t.mapUrl || t.type === 'konaklama') {
    if (!hasC(t) && !t.place && !t.title) return out;
    const start = t.date && t.time ? at(t.date, t.time) : 0;
    const gName = t.locSrc && t.locSrc.startsWith('Google Haritalar: ') ? t.locSrc.slice(18) : t.locSrc && t.locSrc.startsWith('Google adresi: ') ? t.locSrc.slice(15) : '';
    out.push({ label: t.type === 'konaklama' ? TX('Otel') : TX('Konum'), icon: t.type === 'konaklama' ? I('bed') : I('map-pin'), name: gName || t.title || typeOf(t.type).n, address: t.place || (t.mapUrl && !hasC(t) ? regionCityEn((t.date && tripAnchor(t)) || tripAnchorAny(t)) : ''), url: t.mapUrl || '', lat: hasC(t) ? +t.lat : '', lon: hasC(t) ? +t.lon : '', arriveBy: start ? isoLocal(start) : '' });
  }
  return out;
}
function locQuery(l) { return hasC(l) ? `${l.lat},${l.lon}` : [l.name, l.address].filter(Boolean).join(', '); }
function geoUrl(l) { const e = encodeURIComponent;
  if (!A) return S.mapApp === 'google' || !IS_IOS ? `https://www.google.com/maps/search/?api=1&query=${e(hasC(l) ? `${l.lat},${l.lon}` : locQuery(l))}` : `https://maps.apple.com/?${hasC(l) ? `ll=${l.lat},${l.lon}&q=${e(l.name || TX('Konum'))}` : 'q=' + e(locQuery(l))}`;
  return hasC(l) ? `geo:${l.lat},${l.lon}?q=${l.lat},${l.lon}(${e(l.name || TX('Konum'))})` : `geo:0,0?q=${e(locQuery(l))}`; }
function dirUrl(id, l) {
  const e = encodeURIComponent, c = hasC(l);
  switch (id) {
    case 'google': return `https://www.google.com/maps/dir/?api=1&destination=${e(l.url ? [l.name, l.address].filter(Boolean).join(', ') || locQuery(l) : locQuery(l))}`;
    case 'citymapper': return c ? `citymapper://directions?endcoord=${l.lat},${l.lon}&endname=${e(l.name || '')}${l.address ? '&endaddress=' + e(l.address) : ''}${l.arriveBy ? '&arriveby=' + e(l.arriveBy) : ''}` : null;
    case 'waze': return c ? `https://waze.com/ul?ll=${l.lat},${l.lon}&navigate=yes` : `https://waze.com/ul?q=${e(locQuery(l))}&navigate=yes`;
    case 'moovit': return c ? `moovit://directions?dest_lat=${l.lat}&dest_lon=${l.lon}&dest_name=${e(l.name || '')}&auto_run=true&partner_id=DoraGo` : null;
    case 'apple': return `https://maps.apple.com/?daddr=${e(c ? `${l.lat},${l.lon}` : locQuery(l))}${l.name ? '&q=' + e(l.name) : ''}`;
    case 'yandex': return c ? `yandexmaps://maps.yandex.ru/?rtext=~${l.lat},${l.lon}&rtt=mt` : `yandexmaps://maps.yandex.ru/?text=${e(locQuery(l))}`;
    default: return geoUrl(l);
  }
}
function openUrl(url, pkg = '', chooser = false) {
  S.pickAt = Date.now();
  if (A && A.openLink) A.openLink(url, pkg, chooser);
  else { window.__opened = (window.__opened || []).concat(url); if (/^https?:/i.test(url)) window.open(url, '_blank'); else location.href = url; }
}
function showOnMap(l) {
  const app = mapApps().find(a => a.id === S.mapApp);
  // Google bağlantısı varsa yer her zaman kesin: Google Haritalar'da onu aç
  if (l.url && (!app || app.id === 'google' || !hasC(l))) { openUrl(l.url, (mapApps().find(a => a.id === 'google') || {}).pkg || ''); return; }
  openUrl(geoUrl(l), app ? app.pkg : '', !app);
}
function pickMapApp(l, title) {
  return new Promise(res => {
    const apps = mapApps().filter(a => dirUrl(a.id, l));
    const all = mapApps();
    if (!all.length) { res({ id: 'google', pkg: '' }); return; }
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = TL`<div class="dlg sheet"><h3>${esc(title)}</h3>
      ${apps.map(a => `<button class="item" data-app="${a.id}"><span class="ii">${I({ google: 'map-2', citymapper: 'train', waze: 'car', moovit: 'bus', yandex: 'compass' }[a.id] || 'map-pin')}</span><span class="it">${esc(a.name)}</span></button>`).join('')}
      ${all.length > apps.length ? TL`<p class="sub" style="margin:8px 4px 0">${all.filter(a => !apps.includes(a)).map(a => esc(a.name)).join(', ')} için konumun koordinatı gerekiyor — bileti düzenleyip konum ekleyebilirsin.</p>` : ''}
      <label class="defchk"><input type="checkbox" id="mkdef"> Bunu varsayılan yap</label></div>`;
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    ov.addEventListener('click', async e => {
      const b = e.target.closest('[data-app]');
      if (b) { const a = all.find(x => x.id === b.dataset.app); if ($('#mkdef', ov).checked) { S.mapApp = a.id; await metaSet('mapApp', a.id); toast(TL`${a.name} varsayılan yapıldı`); } close(a); }
      else if (e.target === ov) close(null);
    });
    dlgClose = () => close(null);
    document.body.appendChild(ov);
  });
}
async function directions(l) {
  let app = mapApps().find(a => a.id === S.mapApp);
  if (app && !dirUrl(app.id, l)) app = null; // varsayılan uygulama koordinatsız çalışmıyor
  if (!app) app = await pickMapApp(l, TX('Yol tarifi için uygulama'));
  if (!app) return;
  openUrl(dirUrl(app.id, l), app.pkg || '');
}
function copyText(t) {
  if (A && A.copyText) A.copyText(t); else { try { navigator.clipboard.writeText(t); } catch (e) {} }
  toast(TX('Kopyalandı'));
}
function locBlock(t) {
  const locs = ticketLocs(t); if (!locs.length) return '';
  return `<div class="locs">${locs.map((l, i) => TL`<div class="loc">
    <div class="loc-h"><span class="loc-i">${l.icon}</span><div><small>${esc(l.label)}</small><b>${esc(l.name)}</b>${l.address && l.address !== l.name ? `<span>${esc(l.address)}</span>` : ''}${l.hint ? `<span class="loc-hint">${esc(l.hint)}</span>` : ''}</div></div>
    <div class="loc-a"><button data-lmap="${i}">${I('map')} Haritada aç</button><button data-ldir="${i}" class="pri">${I('navigation')} Yol tarifi</button><button data-lcopy="${i}" aria-label="Adresi kopyala">${I('copy')}</button></div></div>`).join('')}</div>`;
}
function bindLocs(root, t) {
  const locs = ticketLocs(t);
  $$('[data-lmap]', root).forEach(b => b.onclick = () => showOnMap(locs[+b.dataset.lmap]));
  $$('[data-ldir]', root).forEach(b => b.onclick = () => directions(locs[+b.dataset.ldir]));
  $$('[data-lcopy]', root).forEach(b => b.onclick = () => { const l = locs[+b.dataset.lcopy]; copyText([l.name, l.address].filter(Boolean).join(', ') + (l.url ? `\n${l.url}` : hasC(l) ? `\n${l.lat}, ${l.lon}` : '')); });
}
/* uçuş durumu: hesapsız, tek dokunuşla Google / Flightradar24 */
function flightCode(t) { const f = String(t.flightNo || '').replace(/\s+/g, '').toUpperCase(); return /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(f) ? f : ''; }
function flightStatusBlock(t) {
  if (t.type !== 'ucak') return '';
  const f = flightCode(t); if (!f) return '';
  const today = todayStr(), soon = t.date && t.date >= addDays(today, -1) && t.date <= addDays(today, 2);
  return TL`<div class="fscard${soon ? ' soon' : ''}"><div class="fsh">${I('plane-tilt')}<div><b>Uçuş durumu · ${esc(f)}</b><small>${soon ? TX('Rötar, gerçek kalkış, check-in bankosu, kapı ve bagaj bandı') : TX('Rötar ve kapı bilgisi genelde uçuş günü belli olur')}</small></div></div>
    <div class="fsa"><button class="pri" data-fs="trip">${I('external-link')} Trip.com'da gör</button></div>
    <div class="fsb"><button data-fs="google">Google</button><span>·</span><button data-fs="fr24">Flightradar24</button></div></div>`;
}
function openFlightStatus(t, src) {
  const f = flightCode(t); if (!f) return;
  const url = src === 'trip' ? `https://tr.trip.com/flights/status-${f.toLowerCase()}/`
    : src === 'fr24' ? `https://www.flightradar24.com/data/flights/${f.toLowerCase()}`
    : `https://www.google.com/search?hl=tr&q=${encodeURIComponent(f + TX(' uçuş durumu') + (t.date && t.date !== todayStr() ? ` ${+t.date.slice(8)} ${MONTH_TR[+t.date.slice(5, 7) - 1]}` : ''))}`;
  openUrl(url);
}
/* takvim: günün rotası (Google Haritalar, çok duraklı) */
function dayStops(day, items) {
  let origin = null; const stops = [], flights = [];
  for (const t of items) {
    if (t.type === 'konaklama' && t.endDate && t.date < day && day <= t.endDate) { const l = ticketLocs(t)[0]; if (l) origin = l; if (day === t.endDate) stops.push({ l, time: t.endTime || '11:00' }); continue; }
    if (t.type === 'ucak') { if (t.date === day && t.from) flights.push(t); continue; }
    const l = ticketLocs(t)[0]; if (l) stops.push({ l, time: t.time || '99:98' });
  }
  stops.sort((a, b) => a.time < b.time ? -1 : 1);
  if (flights.length) {
    // uçuşlu gün: uçuştan sonrası varış havalimanından başlar, öncesi kalkış havalimanında biter
    flights.sort((a, b) => (a.time || '') < (b.time || '') ? -1 : 1);
    const last = flights[flights.length - 1], first = flights[0];
    const after = stops.filter(x => !last.time || x.time > last.time);
    if (after.length) return { origin: ticketLocs(last)[1] || null, stops: after.map(x => x.l) };
    const before = stops.filter(x => first.time && x.time < first.time);
    return { origin, stops: before.map(x => x.l).concat(ticketLocs(first)[0]) };
  }
  return { origin, stops: stops.map(x => x.l) };
}
function openDayRoute(day, items) {
  const { origin, stops } = dayStops(day, items);
  if (!stops.length) return;
  const e = encodeURIComponent, dest = stops[stops.length - 1], way = stops.slice(0, -1);
  let url = `https://www.google.com/maps/dir/?api=1&destination=${e(locQuery(dest))}`;
  if (origin) url += `&origin=${e(locQuery(origin))}`;
  if (way.length) url += `&waypoints=${e(way.map(locQuery).join('|'))}`;
  const g = mapApps().find(a => a.id === 'google');
  openUrl(url, g ? g.pkg : '');
}
let resolveWait = null;
window.onResolved = u => { const f = resolveWait; resolveWait = null; f && f(u); };
function resolveShort(u) { return new Promise(res => { if (!A || !A.resolveUrl) return res(''); resolveWait = res; A.resolveUrl(u.startsWith('http') ? u : 'https://' + u); setTimeout(() => { if (resolveWait === res) { resolveWait = null; res(''); } }, 15000); }); }

/* ---------- hatırlatmalar (bildirim) ---------- */
function at(dateStr, time) { const [y, m, d] = dateStr.split('-').map(Number); const [hh, mm] = (time || '00:00').split(':').map(Number); return new Date(y, m - 1, d, hh, mm).getTime(); }
function shortDay(ms) { return new Date(ms).toLocaleDateString(LOC, { day: 'numeric', month: 'long', weekday: 'long' }); }
function buildReminders() {
  const N = S.notif, out = [], now = Date.now(), H = N.hours;
  if (!N.on) return out;
  for (const t of S.tickets) {
    if (t.status === 'cancel') continue;
    if (!t.date || (t.endDate || t.date) < todayStr()) continue;
    if (isPlace(t.type) && !t.time) continue;
    const ty = typeOf(t.type), name = t.title || ty.n;
    const start = t.time ? at(t.date, t.time) : null;
    const add = (when, title, text, kind) => { if (when > now + 30000 && when < now + 400 * 86400000) out.push({ at: when, title, text, ticket: t.id, kind, ...(kind !== 'c' && when > now + 0 ? wxNotifFields(t) : {}) }); };
    if (t.type === 'ucak') {
      const route = t.from && t.to ? `${apCity(t.from) || t.from} → ${apCity(t.to) || t.to}` : name;
      const fl = [t.flightNo, t.time].filter(Boolean).join(' · ');
      const ci = start && t.checkinH ? start - t.checkinH * 3600000 : null;
      const dayB = N.dayBefore ? (start ? start - 86400000 : at(t.date, '19:00') - 86400000) : null;
      if (dayB && ci && Math.abs(ci - dayB) < 60000) {
        add(dayB, TX('Yarın uçuşun var · Check-in açıldı ✈️'), TL`${route}${fl ? ' · ' + fl : ''}. Kontrol: check-in, ${pfIntl(t) ? 'pasaport' : 'kimlik'}, şarj, sıvılar.`, 'dc');
      } else {
        if (dayB) add(dayB, TX('Yarın uçuşun var ✈️'), TL`${route}${fl ? ' · ' + fl : ''}. Kontrol: check-in, ${pfIntl(t) ? 'pasaport' : 'kimlik'}, şarj, sıvılar.`, 'd');
        if (ci) add(ci, TX('Check-in açıldı ✈️'), `${route} · ${shortDay(start)} ${t.time}. Online check-in yapabilirsin.`, 'c');
      }
      if (start && H) add(start - H * 3600000, TL`Uçuşuna ${H} saat kaldı ✈️`, [route, t.time && TX('Kalkış ') + t.time, t.gate && TX('Kapı ') + t.gate, t.seat && TX('Koltuk ') + t.seat].filter(Boolean).join(' · '), 'h');
    } else if (t.type === 'konaklama') {
      if (N.dayBefore) add((start || at(t.date, '19:00')) - 86400000, TX('Yarın otel girişin var 🏨'), `${name}${t.time ? TX(' · giriş ') + t.time : ''}`, 'd');
      if (start && H) add(start - H * 3600000, TL`Otel girişine ${H} saat kaldı 🏨`, `${name}${t.place ? ' · ' + t.place : ''}`, 'h');
      else if (!start) add(at(t.date, '09:00'), TX('Bugün otel girişin var 🏨'), name, 'h');
      if (t.endDate && t.endDate > t.date) add(t.endTime ? at(t.endDate, t.endTime) - 2 * 3600000 : at(t.endDate, '09:00'), TX('Bugün çıkış günü 🏨'), `${name}${t.endTime ? TX(' · çıkış ') + t.endTime : ''}`, 'e');
    } else {
      if (N.dayBefore) add(start ? start - 86400000 : at(t.date, '19:00') - 86400000, TL`Yarın: ${ty.i} ${name}`, [t.time, t.place].filter(Boolean).join(' · ') || ty.n, 'd');
      if (start && H) add(start - H * 3600000, TL`${H} saat sonra: ${ty.i} ${name}`, [timeRange(t), t.place, t.seat].filter(Boolean).join(' · ') || ty.n, 'h');
      else if (!start) add(at(t.date, '09:00'), TL`Bugün: ${ty.i} ${name}`, t.place || ty.n, 'h');
    }
  }
  // "Gittin mi?": günün son etkinliğinden sonra ya da ertesi sabah; tek bildirim, gece sessiz
  const AQ = S.askN || { m: 'after', h: 2, t: '09:00' };
  if (AQ.m !== 'off') {
    const days = new Map();
    for (const t of S.tickets) { if (t.status || !t.date) continue; const e = endAt(t); if (e == null || now - e > ASK_WIN) continue; const d = new Date(e), k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; (days.get(k) || days.set(k, []).get(k)).push(t); }
    for (const [day, ts] of days) {
      let fire;
      if (AQ.m === 'morning') fire = at(addDays(day, 1), AQ.t || '09:00');
      else { fire = Math.max(...ts.map(endAt)) + (AQ.h || 2) * 3600000; const h = new Date(fire).getHours(); if (h >= 22) { const d = new Date(fire); fire = at(addDays(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, 1), '09:00'); } else if (h < 8) { const d = new Date(fire); fire = at(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, '09:00'); } }
      if (fire <= now + 30000) continue;
      const ids = ts.map(t => t.id).join(','), names = ts.map(t => t.type === 'ucak' && t.from && t.to ? `${t.from} → ${t.to}` : t.title || typeOf(t.type).n);
      const fd = new Date(fire), fday = `${fd.getFullYear()}-${pad(fd.getMonth() + 1)}-${pad(fd.getDate())}`;
      const lab = fday === day ? TX('Bugün') : addDays(fday, -1) === day ? TX('Dün') : shortDay(at(day, '12:00'));
      out.push({ at: fire, title: TX('Gittin mi?'), text: `${lab}: ${names.join(', ')}`, ticket: 'act:ask:' + ids, kind: 'q', acts: JSON.stringify([{ l: ts.length > 1 ? TX('Hepsi gidildi') : TX('Gittim'), v: 'act:done:' + ids }, { l: ts.length > 1 ? TX('Tek tek seç') : TX('Diğer…'), v: 'act:ask:' + ids }]) });
    }
  }
  for (const t of S.tickets) {
    if (t.status !== 'cancel' || !t.refund || t.refund.state !== 'wait') continue;
    const name = t.title || typeOf(t.type).n, amt = t.refund.amt ? ` (${t.refund.amt} ${curSym(t.refund.cur)})` : '';
    for (const [d, txt] of [[addDays(t.refund.due, -3), TX('3 gün kaldı')], [t.refund.due, TX('bugün son gün')]]) { const w = at(d, '10:00'); if (w > now + 30000) out.push({ at: w, title: TX('İade hatırlatması'), text: TL`${name}${amt}: iade için ${txt}. Geldiyse DoraGo'da "alındı" de.`, ticket: t.id, kind: 'r' }); }
  }
  out.sort((a, b) => a.at - b.at);
  out.push(...docsReminders(now)); out.push(...shopReminders(now));
  return out.slice(0, 200).map((r, i) => ({ id: i + 1, ...r }));
}
function syncReminders(noWx) {
  try { nextHintSave(); } catch (e) {}
  if (!A || !A.scheduleReminders) return 0;
  let n = 0; try { n = A.scheduleReminders(JSON.stringify(buildReminders())); } catch (e) { return 0; }
  // tahminleri önbelleğe alıp yedek hava metniyle yeniden kur (internet yoksa bildirim bunu kullanır)
  if (!noWx && S.wx !== false && S.notif.on) wxPrefetch().then(() => { try { A.scheduleReminders(JSON.stringify(buildReminders())); } catch (e) {} });
  return n;
}
function notifState() { try { return A && A.notifState ? A.notifState() : 'none'; } catch (e) { return 'none'; } }
let notifWait = null;
window.onNotifPerm = st => { const f = notifWait; notifWait = null; f && f(st); };
function requestNotif() {
  return new Promise(res => { if (!A || !A.requestNotifPerm) return res('none'); notifWait = res; S.pickAt = Date.now(); A.requestNotifPerm(); });
}
async function maybeAskNotif() {
  if (!A || !S.notif.on || (await metaGet('notifAsked'))) return;
  if (notifState() !== 'ask') return;
  await metaSet('notifAsked', true);
  await new Promise(r => setTimeout(r, 700));
  if (!await dialog({ title: TX('Hatırlatma gönderelim mi?'), text: TX('Biletinden bir gün ve birkaç saat önce, uçuşlarda da check-in açılınca bildirim gönderelim. Bildirime dokununca bilet açılır.'), ok: TX('Evet, gönder'), cancel: TX('Şimdi değil') })) return;
  const st = await requestNotif();
  if (st === 'granted') { syncReminders(); toast(TX('Hatırlatmalar açık')); }
}

/* ---------- ayarlar ---------- */
function renderSettings(app, anim) {
  const opts = [[0, TX('Hemen')], [30000, TX('30 saniye')], [60000, TX('1 dakika')], [300000, TX('5 dakika')], [900000, TX('15 dakika')], [3600000, TX('1 saat')], [86400000, TX('1 gün')], [-1, TX('Asla')]];
  app.innerHTML = TL`<div class="page${animCls(anim)}">
    <div class="bar"><button class="icon-btn" id="back" aria-label="Geri">←</button><h2>Ayarlar</h2></div>
    ${FIRST_USE && isFounder() ? TL`<div class="founder">${I('award')}<span><b>Erken kullanıcı</b><small>${TL`${new Date(FIRST_USE).toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: 'numeric' })} tarihinden beri DoraGo'dasın · teşekkürler`}</small></span></div>` : ''}
    <div class="gtitle">Dil ve bölge</div>
    <div class="group"><div class="item sel"><span class="ii">${I('language')}</span><span class="it">Dil<small>${LANG === 'tr' ? 'Language' : 'Dil'}</small></span>
      <select id="slang">${LANGS.map(l => `<option value="${l.id}" ${LANG === l.id ? 'selected' : ''}>${l.name}</option>`).join('')}</select></div>
      <div class="item sel"><span class="ii">${I('home')}</span><span class="it">Ev ülkesi<small>Özet, saat farkı, priz</small></span>
      <select id="shome"><option value="${HOME_CC}">${esc(homeName())}</option></select></div>
      <div class="item sel"><span class="ii">${I('cash')}</span><span class="it">Para birimi<small>Masraf toplamları</small></span>
      <select id="basecur">${[...new Set([baseCur(), ...CURS])].map(c => `<option value="${c}" ${baseCur() === c ? 'selected' : ''}>${c}${curSymbol(c) !== c ? ' ' + curSymbol(c) : ''}</option>`).join('')}</select></div></div>
    <div class="gtitle">Görünüm</div>
    <div class="group"><div class="thg">${Object.entries(THEMES).map(([k, T]) => `<button class="thc ${lsGet('dgTheme', 'defter') === k ? 'on' : ''}" data-theme="${k}"><div class="tp"><i style="height:22px;background:${T.p[0]}"></i><i style="flex:1;background:${T.p[1]};padding:6px"><i style="height:100%;border-radius:5px;background:${T.p[2]};display:flex;align-items:center;padding-left:5px"><i style="width:10px;height:10px;border-radius:50%;background:${T.p[3]}"></i></i></i></div>${esc(T.n)}</button>`).join('')}</div>
      <div class="item"><span class="ii">${I('moon')}</span><span class="it">Telefon karanlık moddayken Gece mavisi<small>Telefonun koyu tema ayarını izler</small></span><label class="sw"><input type="checkbox" id="thauto" ${lsGet('dgThemeAuto', false) ? 'checked' : ''}><span></span></label></div></div>
    <div class="gtitle">Güvenlik</div>
    <div class="group">
      <button class="item" id="chg"><span class="ii">${I('key')}</span><span class="it">PIN'i değiştir</span></button>
      <div class="item"><span class="ii">${I('plane-tilt')}</span><span class="it">Giriş ekranında sıradaki yolculuk<small>PIN girmeden "Yarın · İstanbul → İzmir" gibi kısa bir satır gösterir</small></span><label class="sw"><input type="checkbox" id="lkh" ${S.lockHint ? 'checked' : ''}><span></span></label></div>
      ${S.bioAvail ? TL`<div class="item"><span class="ii">${I('fingerprint')}</span><span class="it">Parmak izi ile aç<small>PIN yedek olarak kalır</small></span><label class="sw"><input type="checkbox" id="bio" ${S.bio ? 'checked' : ''}><span></span></label></div>` : ''}
      <div class="item"><span class="ii">${I('lock')}</span><span class="it">Otomatik kilit<small>Uygulamadan çıkınca bu süre sonra PIN sorulur. "Asla": telefonun ekran kilidi yeterli; yedek, PIN değişikliği ve silme yine PIN ister.</small></span>
        <select id="ld">${opts.map(([v, n]) => `<option value="${v}" ${S.lockDelay === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      ${A ? TL`<div class="item"><span class="ii">${I('sun')}</span><span class="it">Tam ekran bilette parlaklığı artır<small>QR kod okutmayı kolaylaştırır; ekran da kapanmaz</small></span><label class="sw"><input type="checkbox" id="ab" ${S.autoBright ? 'checked' : ''}><span></span></label></div>` : ''}
    </div>
    ${A ? TL`<div class="gtitle">Bildirimler</div>
    <div class="group">
      <div class="item"><span class="ii">${I('bell')}</span><span class="it">Hatırlatmalar<small id="nst">${notifHint()}</small></span><label class="sw"><input type="checkbox" id="non" ${S.notif.on ? 'checked' : ''}><span></span></label></div>
      <div class="item"><span class="ii">${I('calendar-event')}</span><span class="it">Bir gün önce hatırlat</span><label class="sw"><input type="checkbox" id="ndb" ${S.notif.dayBefore ? 'checked' : ''}><span></span></label></div>
      <div class="item"><span class="ii">${I('clock')}</span><span class="it">Saatler önce hatırlat</span>
        <select id="nh">${[[0, TX('Kapalı')], [1, TX('1 saat')], [2, TX('2 saat')], [3, TX('3 saat')], [4, TX('4 saat')], [6, TX('6 saat')]].map(([v, n]) => `<option value="${v}" ${S.notif.hours === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <button class="item" id="nask"><span class="ii">${I('help')}</span><span class="it">"Gittin mi?" hatırlatması<small id="naskv">${askLabel()}</small></span></button>
      <button class="item" id="ntest"><span class="ii">${I('flask')}</span><span class="it">Deneme bildirimi gönder<small>Bildirimlerin geldiğini kontrol et</small></span></button>
    </div>` : ''}
    ${mapApps().length ? TL`<div class="gtitle">Haritalar</div>
    <div class="group"><div class="item"><span class="ii">${I('map')}</span><span class="it">Yol tarifi uygulaması<small>Haritada aç ve yol tarifi için</small></span>
      <select id="mapapp"><option value="">Her seferinde sor</option>${mapApps().map(a => `<option value="${a.id}" ${S.mapApp === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      ${canGeo() ? TL`<div class="item"><span class="ii">${I('map-pin')}</span><span class="it">Adresten konum bul<small>Bilet eklerken adres OpenStreetMap tabanlı servislere (Nominatim, Photon) gönderilir; internet gerekir</small></span><label class="sw"><input type="checkbox" id="geo" ${S.geocode ? 'checked' : ''}><span></span></label></div>` : ''}</div>` : ''}
    ${!A ? TL`<div class="gtitle">Hatırlatmalar</div><div class="group"><div class="item"><span class="ii">${I('bell')}</span><span class="it">Takvim hatırlatmaları<small>Web sürümünde bildirim gönderilemiyor. Biletteki <b>Takvim</b> butonu etkinliği 1 gün önce ve ${S.notif && S.notif.hours ? S.notif.hours : 3} saat önce uyarılı olarak telefonun takvimine ekler.</small></span></div></div>` : ''}
    <div class="gtitle">Hava durumu</div>
    <div class="group"><div class="item"><span class="ii">${I('cloud')}</span><span class="it">Hava durumunu göster<small>Biletlerde, seyahatlerde, takvimde ve bildirimlerde. Konumun koordinatı Open-Meteo'ya gönderilir; internet gerekir, son tahmin telefonda saklanır.</small></span><label class="sw"><input type="checkbox" id="wxon" ${S.wx ? 'checked' : ''}><span></span></label></div>
      <div class="item"><span class="ii">${I('photo')}</span><span class="it">Yer fotoğraflarını otomatik getir<small>Müze, otel, restoran gibi biletlerin başlığına Wikipedia/Wikimedia Commons'tan serbest lisanslı fotoğraf. Yalnız yerin adı ve konumu gönderilir; fotoğraf bir kez indirilip telefonda saklanır.</small></span><label class="sw"><input type="checkbox" id="phon" ${phAuto() ? 'checked' : ''}><span></span></label></div></div>
    <div class="gtitle">Bilet okuma</div>
    <div class="group"><div class="item"><span class="ii">${I('scan')}</span><span class="it">Görsellerden metin oku (OCR)<small>Fotoğraf ve ekran görüntüsü biletlerdeki yazıları telefonda, internetsiz okur. Sayfa başına birkaç saniye sürer.</small></span><label class="sw"><input type="checkbox" id="ocr" ${S.ocr ? 'checked' : ''}><span></span></label></div></div>
    <div class="gtitle">Yedek</div>
    <div class="group">
      <button class="item" id="bk"><span class="ii">${I('device-floppy')}</span><span class="it">Yedek al<small>Tüm biletler PIN'inle şifrelenmiş tek dosyaya kaydedilir</small></span></button>
      <button class="item" id="rs"><span class="ii">${I('download')}</span><span class="it">Yedekten geri yükle<small>Mevcut biletler korunur, yeni olanlar eklenir</small></span></button>
    </div>
    <div class="gtitle">Destek</div>
    <div class="group"><button class="item" id="diagBtn"><span class="ii">${I('stethoscope')}</span><span class="it">Tanılama raporu<small>Konum işlemlerinin kaydı; kopyalayıp gönderebilirsin</small></span></button>
      <button class="item" id="privBtn"><span class="ii">${I('lock')}</span><span class="it">Gizlilik politikası<small>Veriler telefonda kalır</small></span></button></div>
    <div class="gtitle">Veri</div>
    <div class="group">
      <div class="item"><span class="ii">${I('chart-pie')}</span><span class="it">Depolama<small id="usage">Hesaplanıyor…</small></span></div>
      <button class="item red" id="wipe"><span class="ii">${I('trash')}</span><span class="it">Tüm verileri sil</span></button>
    </div>
    <p class="about">DoraGo ${APP_VER} · Biletlerin yalnızca bu telefonda saklanır. "Adresten konum bul" açıksa yalnızca adres OpenStreetMap tabanlı servislere (Nominatim, Photon) gönderilir (konum verisi © OpenStreetMap katkıcıları).<br>Telefonu değiştirmeden önce mutlaka yedek al.</p></div>`;
  $('#back').onclick = () => go('home', 'back');
  const bio = $('#bio');
  if (bio) bio.onchange = async () => {
    if (bio.checked) {
      bio.checked = false;
      const pin = await askPin('PIN\'ini gir', TX('Parmak izini açmak için'), async p => await checkPin(p) ? '' : TX('Yanlış PIN'));
      if (!pin) return;
      bio.checked = await enableBio();
    } else { S.bio = false; await metaSet('bio', false); try { A && A.bioDisable(); } catch (e) {} toast(TX('Parmak izi kapatıldı')); }
  };
  const lk = $('#lkh'); if (lk) lk.onchange = () => { S.lockHint = lk.checked; lsSet('lockHintOn', S.lockHint); nextHintSave(); };
  $$('.thc').forEach(b => b.onclick = () => { lsSet('dgTheme', b.dataset.theme); applyTheme(); const y = scrollY; renderSettings(app); window.scrollTo(0, y); });
  const ta = $('#thauto'); if (ta) ta.onchange = () => { lsSet('dgThemeAuto', ta.checked); applyTheme(); const y = scrollY; renderSettings(app); window.scrollTo(0, y); };
  const pho = $('#phon'); if (pho) pho.onchange = () => lsSet('dgPlacePh', pho.checked);
  const wo = $('#wxon'); if (wo) wo.onchange = async () => { S.wx = wo.checked; await metaSet('wx', S.wx); syncReminders(); };
  const oc = $('#ocr'); if (oc) oc.onchange = async () => { S.ocr = oc.checked; await metaSet('ocr', S.ocr); };
  const ge = $('#geo'); if (ge) ge.onchange = async () => { S.geocode = ge.checked; await metaSet('geocode', S.geocode); };
  $('#diagBtn').onclick = showDiag;
  const ma = $('#mapapp'); if (ma) ma.onchange = async () => { S.mapApp = ma.value; await metaSet('mapApp', S.mapApp); toast(TX('Kaydedildi')); };
  const saveN = async () => { await metaSet('notif', S.notif); const n = syncReminders(); const h = $('#nst'); if (h) h.textContent = notifHint(n); };
  const non = $('#non');
  if (non) non.onchange = async () => {
    S.notif.on = non.checked;
    if (non.checked) {
      let st = notifState();
      if (st === 'ask') st = await requestNotif();
      if (st === 'denied' && await dialog({ title: TX('Bildirim izni kapalı'), text: TX('DoraGo\'nun bildirim göndermesi telefon ayarlarından kapatılmış. Açmak için ayarlara gidebilirsin.'), ok: TX('Ayarları aç'), cancel: TX('Vazgeç') })) { S.pickAt = Date.now(); A.openNotifSettings(); }
    }
    saveN();
  };
  const ndb = $('#ndb'); if (ndb) ndb.onchange = () => { S.notif.dayBefore = ndb.checked; saveN(); };
  const nh = $('#nh'); if (nh) nh.onchange = () => { S.notif.hours = +nh.value; saveN(); };
  const nak = $('#nask'); if (nak) nak.onclick = async () => {
    const opts = [['after', 1], ['after', 2], ['after', 3], ['morning', '08:00'], ['morning', '09:00'], ['morning', '10:00'], ['off']];
    const v = await sheetMenu(TX('"Gittin mi?" ne zaman sorulsun?'), opts.map(o => ({ icon: I(o[0] === 'off' ? 'bell-off' : o[0] === 'after' ? 'clock' : 'sun'), label: askLabel({ m: o[0], h: o[1], t: o[1] }), sub: o[0] === 'after' ? TX('Gece 22:00 sonrasına düşerse sabah 09:00') : o[0] === 'off' ? TX('Sadece uygulamada sorulur') : '', value: o })));
    if (!v) return;
    S.askN = v[0] === 'after' ? { m: 'after', h: v[1] } : v[0] === 'morning' ? { m: 'morning', t: v[1] } : { m: 'off' };
    await metaSet('askNotif', S.askN); $('#naskv').textContent = askLabel(); syncReminders(true);
  };
  const nt = $('#ntest'); if (nt) nt.onclick = async () => {
    let st = notifState(); if (st === 'ask') st = await requestNotif();
    if (st !== 'granted') { if (await dialog({ title: TX('Bildirim izni kapalı'), text: TX('Deneme bildirimi için önce telefon ayarlarından DoraGo bildirimlerine izin ver.'), ok: TX('Ayarları aç') })) { S.pickAt = Date.now(); A.openNotifSettings(); } return; }
    const up = sortTickets(S.tickets).up[0];
    A.testNotification(TX('DoraGo deneme bildirimi 🔔'), up ? TL`Sıradaki biletin: ${up.title} · ${fmtDate(up.date)}` : TX('Bildirimler çalışıyor.'), up ? up.id : '');
    toast(TX('Deneme bildirimi gönderildi'));
  };
  $('#slang').onchange = e => { setLang(e.target.value); };
  Promise.all([loadCInfo(), loadWorld()]).then(() => { const h = $('#shome'); if (h) h.innerHTML = ccOptions(HOME_CC); });
  $('#shome').onchange = e => { HOME_CC = e.target.value; lsSet('dgHome', HOME_CC); toast(TL`Ev ülkesi: ${homeName()}`); };
  $('#privBtn').onclick = () => openUrl('https://doragoapp.github.io/privacy.html' + (LANG === 'tr' ? '#tr' : ''));
  $('#basecur').onchange = async e => { lsSet('dgBaseCur', e.target.value); toast(TX('Ana para birimi: ') + e.target.value); refreshFx(true); };
  $('#ld').onchange = async e => { S.lockDelay = +e.target.value; await metaSet('lockDelay', S.lockDelay); toast(TX('Kaydedildi')); };
  const ab = $('#ab'); if (ab) ab.onchange = async () => { S.autoBright = ab.checked; await metaSet('autoBright', S.autoBright); };
  $('#chg').onclick = changePin;
  $('#bk').onclick = backup;
  $('#rs').onclick = restore;
  $('#wipe').onclick = async () => {
    if (!await dialog({ title: TX('Tüm veriler silinsin mi?'), text: TX('Bütün biletler ve PIN silinecek. Bu işlem geri alınamaz.'), ok: TX('Devam'), danger: true })) return;
    const pin = await askPin('PIN\'ini gir', TX('Silmeyi onaylamak için'), async p => await checkPin(p) ? '' : TX('Yanlış PIN'));
    if (!pin) return;
    await wipeAll(); try { A && A.bioDisable(); } catch (e) {} S.bio = false; S.tickets = []; S.unlocked = false; S.loaded = false; S.view = 'home'; $('#app').innerHTML = ''; showSetup();
  };
  (async () => {
    let n = 0, bytes = 0;
    try { const ps = await getAll('pages'); n = ps.length; ps.forEach(p => bytes += p.blob?.size || 0); } catch (e) {}
    const u = $('#usage'); if (u) u.textContent = TL`${S.tickets.length} bilet · ${n} sayfa · ${(bytes / 1048576).toFixed(1)} MB`;
  })();
}

function notifHint(n) {
  const st = notifState();
  if (!S.notif.on) return TX('Kapalı');
  if (st === 'denied') return TX('Telefon ayarlarında bildirim izni kapalı');
  if (st === 'ask') return TX('İzin gerekiyor — açınca sorulacak');
  const c = n ?? buildReminders().length;
  return c ? TL`${c} hatırlatma planlandı` : TX('Planlanmış hatırlatma yok');
}

/* ---------- tanılama raporu ekranı ---------- */
function diagText(list) {
  const f = ms => new Date(ms).toLocaleString(LOC);
  let out = TL`DoraGo ${APP_VER} tanılama raporu · ${f(Date.now())}\nAndroid köprüsü: ${A ? 'var' : 'yok'} · Adresten konum: ${S.geocode ? TX('açık') : TX('kapalı')}\n`;
  if (!list.length) return out + TX('\nKayıt yok. Bir konum paylaşıp tekrar bak.');
  list.slice().reverse().forEach((e, i) => {
    out += TL`\n[${i + 1}] ${f(e.t)} · ${e.kind.toUpperCase()}\n  Bilet: ${e.ticket || '-'}\n`;
    if (e.text) out += TL`  Paylaşılan: ${JSON.stringify(e.text)}\n`;
    out += TL`  Sonuç: ${e.result}\n`;
    if (e.steps) e.steps.forEach(x => { out += `   · ${x}\n`; });
    const r = e.rep;
    if (r) {
      if (r.direct) out += TL`  Koordinat doğrudan metinden okundu${r.farWarn ? TL` (bölgeden ${r.farWarn} km uzak!)` : ''}\n`;
      if (r.timeout) out += TX('  Bağlantı 30 sn içinde yanıt vermedi\n');
      if (r.anchor) out += TL`  Bölge: ${r.anchor.how}${r.anchor.lat != null ? ` (${(+r.anchor.lat).toFixed(3)}, ${(+r.anchor.lon).toFixed(3)})` : ''}\n`;
      if (r.chain && r.chain.length) out += TL`  Yönlendirmeler:\n${r.chain.map(c => '   ' + c).join('\n')}\n`;
      if (r.s != null && !r.direct) out += TL`  Son durum: ${r.s} · sayfa ${r.bodyLen ? Math.round(r.bodyLen / 1024) + ' KB' : 'yok'} · başlık: ${r.title || '-'} · q: ${r.q || '-'}${r.err ? ' · hata: ' + r.err : ''}\n`;
      if (r.cands) {
        out += TL`  Adaylar (${r.cands.length}):\n`;
        r.cands.forEach(c => { out += TL`   ${c.chosen ? '✓' : c.why ? '✗' : '·'} ${(+c.lat).toFixed(5)}, ${(+c.lon).toFixed(5)} · ${c.src}/${c.in} · ada uzaklık ${c.nameDist} · bölgeye ${c.dist == null ? '?' : c.dist + ' km'}${c.why ? ' · elendi: ' + c.why : ''}\n     «${c.ctx}»\n`; });
      }
    }
  });
  return out;
}
async function showDiag() {
  await diagPrune();
  const txt = diagText(DIAG);
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = TL`<div class="dlg sheet diag"><h3>Tanılama raporu</h3><p class="sub" style="margin:0 0 10px">Yalnızca bu telefonda tutulur. İçinde bilet adları ve paylaştığın harita bağlantıları var; kopyalayıp istediğin kişiye gönderebilirsin. Kayıtlar 30 gün sonra kendiliğinden silinir.</p>
    <pre class="diagpre"></pre><div class="row2"><button class="btn" data-a="clr">Temizle</button><button class="btn pri" data-a="copy">Kopyala</button></div></div>`;
  $('.diagpre', ov).textContent = txt;
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]');
    if (b && b.dataset.a === 'copy') { copyText(txt); }
    else if (b && b.dataset.a === 'clr') { if (await dialog({ title: TX('Rapor temizlensin mi?'), text: TX('Tüm tanılama kayıtları silinecek.'), ok: TX('Temizle'), danger: true })) { DIAG = []; await metaSet('diag', []); close(); toast(TX('Rapor temizlendi')); } }
    else if (e.target === ov) close();
  });
  dlgClose = close;
  document.body.appendChild(ov);
}

async function changePin() {
  const old = await askPin(TX('Mevcut PIN'), TX('Önce şu anki PIN\'ini gir'), async p => await checkPin(p) ? '' : TX('Yanlış PIN'));
  if (!old) return;
  const n1 = await askPin(TX('Yeni PIN'), TX('6 haneli yeni PIN\'ini seç'), async p => (/^(\d)\1{5}$/.test(p) || p === '123456' || p === '654321') ? TX('Bu PIN çok kolay') : (p === old ? TX('Yeni PIN eskisiyle aynı') : ''));
  if (!n1) return;
  const n2 = await askPin(TX('Yeni PIN\'i tekrar gir'), TX('Onaylamak için'), async p => p === n1 ? '' : TX('PIN\'ler eşleşmedi'));
  if (!n2) return;
  busy(TX('Kaydediliyor…')); await setPin(n1); busy(false); toast(TX('PIN değiştirildi'));
}

/* ---------- yedek ---------- */
const MAGIC = TE.encode('BILETIM1');
async function backup() {
  if (!S.tickets.length) { toast(TX('Yedeklenecek bilet yok')); return; }
  const pin = await askPin('PIN\'ini gir', TX('Yedek bu PIN ile şifrelenecek'), async p => await checkPin(p) ? '' : TX('Yanlış PIN'));
  if (!pin) return;
  busy(TX('Yedek hazırlanıyor…'));
  try {
    const tickets = [];
    for (const t of await getAll('tickets')) tickets.push({ ...t, thumb: t.thumb ? { type: t.thumb.type, data: B64.enc(await t.thumb.arrayBuffer()) } : null });
    const pages = [];
    for (const p of await getAll('pages')) pages.push({ id: p.id, w: p.w, h: p.h, type: p.blob.type, data: B64.enc(await p.blob.arrayBuffer()) });
    const plain = TE.encode(JSON.stringify({ app: 'biletim', format: 1, at: new Date().toISOString(), tickets, pages, trips: S.trips || [], tripPhotos: (await getTP()), expenses: (await getExp()), shop: (await getShop()), docs: (await getDocs()), wish: (await getWish()), firstUse: await ensureFirstUse() }));
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(pin, salt), plain));
    const out = new Uint8Array(8 + 16 + 12 + ct.length); out.set(MAGIC, 0); out.set(salt, 8); out.set(iv, 24); out.set(ct, 36);
    const name = `dorago-yedek-${todayStr()}.dorago`;
    busy(false);
    if (A) {
      window.onSaveResult = ok => toast(ok ? TX('Yedek kaydedildi') : TX('Yedek kaydedilmedi'));
      S.pickAt = Date.now(); A.saveFile(name, 'application/octet-stream', B64.enc(out));
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out])); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      toast(TX('Yedek indirildi'));
    }
  } catch (e) { console.error(e); busy(false); toast(TX('Yedek alınamadı: ') + (e.message || e)); }
}

async function restore() {
  const [f] = await pickFiles('*/*', false); if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf.length < 40 || TD.decode(buf.subarray(0, 8)) !== 'BILETIM1') { toast(TX('Bu bir DoraGo yedek dosyası değil')); return; }
  const salt = buf.subarray(8, 24), iv = buf.subarray(24, 36), ct = buf.subarray(36);
  const tryPin = async p => { try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(p, salt), ct)); } catch (e) { return null; } };
  let plain = null;
  const pin = await askPin(TX('Yedeğin PIN\'i'), TX('Yedeği alırken kullandığın PIN\'i gir'), async p => { busy(TX('Çözülüyor…')); plain = await tryPin(p); busy(false); return plain ? '' : TX('PIN bu yedeği açmıyor'); });
  if (!pin || !plain) return;
  busy(TX('Geri yükleniyor…'));
  try {
    const data = JSON.parse(TD.decode(plain));
    const have = new Set(S.tickets.map(t => t.id));
    const pageMap = new Map(data.pages.map(p => [p.id, p]));
    let added = 0;
    const hpFix = [];
    for (const t of data.tickets) {
      if (have.has(t.id)) {
        /* var olan bilet: başlık fotoğrafı sayfası eksikse yedekten tamamla (5.23.2) */
        const cur = S.tickets.find(x => x.id === t.id), hid = cur && cur.hph && cur.hph.id;
        if (hid && pageMap.has(hid) && !(await getOne('pages', hid))) { const x = pageMap.get(hid); hpFix.push({ id: x.id, w: x.w, h: x.h, blob: new Blob([B64.dec(x.data)], { type: x.type }) }); }
        continue;
      }
      const newPages = [...(t.pageIds || []), ...(t.hph && t.hph.id ? [t.hph.id] : [])].map(id => pageMap.get(id)).filter(Boolean).map(p => ({ id: p.id, w: p.w, h: p.h, blob: new Blob([B64.dec(p.data)], { type: p.type }) }));
      const ticket = { ...t, thumb: t.thumb ? new Blob([B64.dec(t.thumb.data)], { type: t.thumb.type }) : null };
      await saveTicketDB(ticket, newPages, []); S.tickets.push(ticket); added++;
    }
    if (hpFix.length) await putPages(hpFix);
    let tAdded = 0;
    for (const r of data.trips || []) if (r && r.name && !tripRec(r.name)) { (S.trips = S.trips || []).push(r); tAdded++; }
    if (tAdded) await saveTripRecs();
    if (data.docs) { await getDocs(); const np = []; const pg = id => { const x = id && pageMap.get(id); if (x) np.push({ id: x.id, w: x.w, h: x.h, blob: new Blob([B64.dec(x.data)], { type: x.type }) }); };
      for (const p of data.docs.people || []) { const i = DOCS.people.findIndex(x => x.id === p.id); if (i < 0) { DOCS.people.push(p); (p.ppages || [p.ppage]).forEach(pg); } else if ((p.updatedAt || 0) > (DOCS.people[i].updatedAt || 0)) { DOCS.people[i] = p; (p.ppages || [p.ppage]).forEach(pg); } }
      for (const v of data.docs.visas || []) { const i = DOCS.visas.findIndex(x => x.id === v.id); if (i < 0) { DOCS.visas.push(v); (v.pages || [v.page]).forEach(pg); } else if ((v.updatedAt || 0) > (DOCS.visas[i].updatedAt || 0)) { DOCS.visas[i] = v; (v.pages || [v.page]).forEach(pg); } }
      migrateDocs(DOCS); if (np.length) await putPages(np); await metaSet('docs', DOCS); }
    if (data.firstUse) { const cur = await ensureFirstUse(); if (!cur || data.firstUse < cur) { FIRST_USE = data.firstUse; await metaSet('firstUse', FIRST_USE); } }
    if (data.wish) { await getWish(); for (const [k, v] of Object.entries(data.wish)) if (!WISH[k]) WISH[k] = v; await saveWish(); }
    if (data.expenses) { await getExp(); mergeExp(data.expenses); await saveExp(); }
    if (data.shop) { await getShop(); const have = new Set(Object.values(SHOP).flatMap(r => r.items.map(i => i.ph)).filter(Boolean)); mergeShop(data.shop); const np = []; for (const r of Object.values(data.shop)) for (const i of r.items || []) { const x = i.ph && !have.has(i.ph) && pageMap.get(i.ph); if (x) np.push({ id: x.id, w: x.w, h: x.h, blob: new Blob([B64.dec(x.data)], { type: x.type }) }); } if (np.length) await putPages(np); await saveShop(); }
    if (data.tripPhotos) { await getTP(); const np = []; for (const [k, r] of Object.entries(data.tripPhotos)) { const cur = TP[k] || (TP[k] = { cover: r.cover, items: [], ...(r.cpos ? { cpos: r.cpos } : {}) }); for (const it of r.items || []) { const pg = pageMap.get(it.id); if (!pg || cur.items.some(x => x.id === it.id) || cur.items.length >= PHOTO_MAX) continue; np.push({ id: pg.id, w: pg.w, h: pg.h, blob: new Blob([B64.dec(pg.data)], { type: pg.type }) }); cur.items.push(it); } if (!cur.cover && cur.items[0]) cur.cover = cur.items[0].id; if (!cur.items.length) delete TP[k]; } if (np.length) await putPages(np); await saveTP(); }
    busy(false);
    toast(added ? TL`${added} bilet geri yüklendi` : tAdded ? TL`${tAdded} seyahat geri yüklendi` : hpFix.length ? TL`${hpFix.length} fotoğraf geri yüklendi` : TX('Yedekteki biletler zaten mevcut'), 3500);
    if (tAdded && !added) render();
    if (added) syncReminders();
  } catch (e) { console.error(e); busy(false); toast(TX('Geri yüklenemedi: ') + (e.message || e)); }
}

/* ---------- seyahat dosyası: şifreli .dorago, kod ayrı mesajla gönderilir ---------- */
const TRIP_MAGIC = TE.encode('DORATRP1');
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newShareCode() { const r = crypto.getRandomValues(new Uint8Array(8)); const c = [...r].map(x => CODE_ABC[x % CODE_ABC.length]).join(''); return c.slice(0, 4) + '-' + c.slice(4); }
const normCode = c => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isTripFile = b => b.length > 40 && TD.decode(b.subarray(0, 8)) === 'DORATRP1';
const fmtMB = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
async function shareTrip(name) {
  const ts = S.tickets.filter(t => t.trip === name);
  const pageIds = [...new Set(ts.flatMap(t => t.pageIds || []))];
  const codes = (await metaGet('shareCodes')) || {}, prev = codes[name];
  const mode = await sheetMenu(TL`"${name}" paylaş · ${ts.length} bilet${pageIds.length ? TL`, ${pageIds.length} sayfa` : ''}`, [
    { icon: I('lock'), label: TX('Kodlu paylaş (önerilen)'), sub: prev ? TL`Bu seyahatin kodu: ${prev} · karşı taraf girdiyse tekrar gerekmez` : TX('Kodu ilk seferde ayrı mesajla gönderirsin; güncellemelerde gerekmez'), value: 'code' },
    { icon: I('lock-open'), label: TX('Kodsuz paylaş'), sub: TX('Hızlı; ama dosyayı ele geçiren herkes açabilir'), value: 'open' },
  ]);
  if (!mode) return;
  await getTP(); const phs = (TP[name] && TP[name].items) || [];
  let withPh = false;
  if (phs.length) withPh = await dialog({ title: TX('Anı fotoğrafları da gitsin mi?'), text: TL`${phs.length} fotoğraf dosyaya eklenir (dosya büyür).`, ok: TX('Ekle'), cancel: TX('Ekleme') });
  const code = mode === 'code' ? (prev || newShareCode()) : '';
  if (mode === 'code' && !prev) { codes[name] = code; await metaSet('shareCodes', codes); await rememberCode(code); }
  busy(TX('Seyahat paketleniyor…'));
  try {
    const tickets = [];
    for (const t of ts) tickets.push({ ...t, thumb: t.thumb ? { type: t.thumb.type, data: B64.enc(await t.thumb.arrayBuffer()) } : null });
    const pages = [];
    for (const id of pageIds) { const p = await getOne('pages', id); if (p) pages.push({ id: p.id, w: p.w, h: p.h, type: p.blob.type, data: B64.enc(await p.blob.arrayBuffer()) }); }
    const g = allTrips().find(x => x.name === name) || {}, r = tripRec(name);
    let photos = null;
    if (withPh) { photos = { cover: TP[name].cover, cpos: TP[name].cpos, items: phs, pages: [] }; for (const it of phs) { const p = await getOne('pages', it.id); if (p) photos.pages.push({ id: p.id, w: p.w, h: p.h, type: p.blob.type, data: B64.enc(await p.blob.arrayBuffer()) }); } }
    await getExp(); const expenses = EXP[name] ? { [name]: EXP[name] } : null;
    await getShop(); const shop = SHOP[name] && SHOP[name].items.length ? { [name]: SHOP[name] } : null;
    for (const t of ts) if (t.hph && t.hph.id) { const p = await getOne('pages', t.hph.id); if (p) pages.push({ id: p.id, w: p.w, h: p.h, type: p.blob.type, data: B64.enc(await p.blob.arrayBuffer()) }); }
    if (shop) for (const id of shopPhotoIds(name)) { const p = await getOne('pages', id); if (p) pages.push({ id: p.id, w: p.w, h: p.h, type: p.blob.type, data: B64.enc(await p.blob.arrayBuffer()) }); }
    const plain = TE.encode(JSON.stringify({ app: 'dorago', kind: 'trip', format: 1, photos, expenses, shop, at: new Date().toISOString(), trip: { name, a: (r && r.a) || '', e: (r && r.e) || '', kind: (r && r.kind) || '', range: [g.a || '', g.e || ''] }, tickets, pages }));
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(normCode(code), salt), plain));
    const out = new Uint8Array(36 + ct.length); out.set(TRIP_MAGIC, 0); out.set(salt, 8); out.set(iv, 24); out.set(ct, 36);
    const fname = TL`DoraGo-${name.replace(/[^\p{L}\p{N} ]/gu, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'seyahat'}.dorago`;
    busy(false);
    const msg = TL`DoraGo seyahati: ${name}. Açmak için DoraGo'da + → Seyahat dosyası al.${code && !prev ? TX(' Kodu ayrıca gönderiyorum.') : ''}`;
    let sent = false;
    if (A && A.shareFile) { A.shareFile(fname, 'application/octet-stream', B64.enc(out), msg); sent = true; }
    else {
      const f = new File([out], fname, { type: 'application/octet-stream' });
      try { if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: TL`DoraGo · ${name}`, text: msg }); sent = true; } } catch (e) { if (e && e.name === 'AbortError') return; }
      if (!sent) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = fname; document.body.appendChild(a); a.click(); a.remove(); toast(TX('Dosya indirildi · Dosyalar uygulamasından gönderebilirsin'), 3500); }
    }
    if (code && !prev) setTimeout(() => showShareCode(name, code, out.length), A ? 400 : 0);
    else setTimeout(() => toast(code ? TL`Aynı kodla paylaşıldı (${code}) · karşı taraf tekrar girmeden açar` : TX('Kodsuz paylaşıldı'), 3800), A ? 400 : 0);
  } catch (e) { console.error(e); busy(false); toast(TX('Paylaşılamadı: ') + (e.message || e)); }
}
function showShareCode(name, code, size) {
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = TL`<div class="dlg"><h3>Paylaşım kodu</h3><p>"${esc(name)}" dosyasını (${fmtMB(size)}) açmak için bu kod gerekiyor. Dosyayla <b>aynı mesajda değil</b>, ayrı bir mesajla gönder. Sadece bu seferlik: bu seyahatin sonraki güncellemeleri kod sormadan açılır.</p>
    <div class="scode">${esc(code)}</div>
    <div class="row2"><button class="btn" data-a="copy">${I('copy')} Kopyala</button><button class="btn pri" data-a="send">${I('send')} Kodu gönder</button></div>
    <button class="btn scok" data-a="ok">Tamam</button></div>`;
  const close = () => { ov.remove(); dlgClose = null; };
  ov.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) { if (e.target === ov) close(); return; }
    const txt = TL`DoraGo "${name}" seyahat dosyasının kodu: ${code}`;
    if (b.dataset.a === 'copy') copyText(code);
    else if (b.dataset.a === 'send') { if (A && A.shareText) A.shareText(txt); else if (navigator.share) { try { await navigator.share({ text: txt }); } catch (er) {} } else copyText(code); }
    else close();
  });
  dlgClose = close; document.body.appendChild(ov);
}
async function rememberCode(c) {
  c = normCode(c); if (!c) return;
  const k = ((await metaGet('knownCodes')) || []).filter(x => x !== c); k.unshift(c); await metaSet('knownCodes', k.slice(0, 30));
}
async function receiveTripFile() {
  const [f] = await pickFiles('*/*', false); if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  if (isTripFile(buf)) return importTripFile(buf);
  if (buf.length > 8 && TD.decode(buf.subarray(0, 8)) === 'BILETIM1') { toast(TX('Bu bir yedek dosyası · Ayarlar → Geri yükle'), 3500); return; }
  toast(TX('Bu bir DoraGo seyahat dosyası değil'));
}
function codeDialog(tryCode) {
  return new Promise(res => {
    const ov = document.createElement('div'); ov.className = 'ov';
    ov.innerHTML = TL`<div class="dlg"><h3>Seyahat dosyası</h3><p>Dosyayı gönderen kişinin ayrıca ilettiği kodu gir.</p>
      <input class="inp scin" id="scIn" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-1234"><p class="tde"></p>
      <div class="row2"><button class="btn" data-a="0">Vazgeç</button><button class="btn pri" data-a="1">Aç</button></div></div>`;
    const inp = $('#scIn', ov);
    let busyTry = false;
    const close = v => { ov.remove(); dlgClose = null; res(v); };
    const go = async () => { if (busyTry) return; const c = normCode(inp.value); if (c.length < 8) { $('.tde', ov).textContent = TX('Kod 8 karakter'); return; } busyTry = true; const ok = await tryCode(c); busyTry = false; if (ok) close(true); else { $('.tde', ov).textContent = TX('Kod bu dosyayı açmıyor'); inp.select(); } };
    inp.oninput = () => { $('.tde', ov).textContent = ''; const c = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); inp.value = c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c; };
    ov.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) b.dataset.a === '1' ? go() : close(false); else if (e.target === ov) close(false); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    dlgClose = () => close(false);
    document.body.appendChild(ov); setTimeout(() => inp.focus(), 60);
  });
}
async function importTripFile(buf) {
  if (S.view === 'edit' && S.draft) { toast(TX('Önce açık bileti kaydet ya da vazgeç')); return; }
  const salt = buf.subarray(8, 24), iv = buf.subarray(24, 36), ct = buf.subarray(36);
  let data = null;
  const tryC = async c => { try { return JSON.parse(TD.decode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(c, salt), ct)))); } catch (e) { return null; } };
  busy(TX('Açılıyor…'));
  for (const c of ['', ...((await metaGet('knownCodes')) || []).slice(0, 12)]) { data = await tryC(c); if (data) break; }
  busy(false);
  const p = data ? Promise.resolve(true) : codeDialog(async c => { busy(TX('Çözülüyor…')); try { const pl = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(c, salt), ct)); data = JSON.parse(TD.decode(pl)); await rememberCode(c); } catch (e) { data = null; } busy(false); return !!data; });
  if (!await p || !data || data.kind !== 'trip') return;
  const name = (data.trip && data.trip.name) || TX('Paylaşılan seyahat');
  const tickets = data.tickets || [];
  const isNew = t => !S.tickets.some(x => x.id === t.id);
  const isUpd = t => { const o = S.tickets.find(x => x.id === t.id); return o && (t.updatedAt || 0) > (o.updatedAt || 0); };
  const nNew = tickets.filter(isNew).length, nUpd = tickets.filter(isUpd).length;
  await getTP(); const havePh = new Set(((TP[name] || {}).items || []).map(i => i.id));
  const nPh = Math.min(data.photos && data.photos.items ? data.photos.items.filter(i => !havePh.has(i.id)).length : 0, PHOTO_MAX - havePh.size);
  await getShop(); const sIn = ((data.shop || {})[name] || {}).items || [], sCur = shopRec(name).items;
  const nSh = sIn.filter(i => { const o = sCur.find(x => x.id === i.id); return !o || (i.updatedAt || 0) > (o.updatedAt || 0); }).length;
  if (!nNew && !nUpd && !nPh && !nSh) { toast(TL`"${name}" zaten güncel`); S.tab = 'trips'; await openTrip(name); return; }
  const parts = [nNew && TL`${nNew} yeni bilet`, nUpd && TL`${nUpd} güncellenmiş bilet`, nPh > 0 && TL`${nPh} anı fotoğrafı`, nSh > 0 && TL`${nSh} alınacak`].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' ve $1');
  if (!await dialog({ title: TL`"${name}" eklensin mi?`, text: TL`${parts} DoraGo'na eklenecek.`, ok: TX('Ekle') })) return;
  busy(TX('Seyahat ekleniyor…'));
  try {
    const pageMap = new Map((data.pages || []).map(x => [x.id, x]));
    let n = 0;
    for (const t of tickets) {
      if (!isNew(t) && !isUpd(t)) continue;
      const old = S.tickets.find(x => x.id === t.id);
      const newPages = [...(t.pageIds || []), ...(t.hph && t.hph.id ? [t.hph.id] : [])].map(id => pageMap.get(id)).filter(Boolean).map(x => ({ id: x.id, w: x.w, h: x.h, blob: new Blob([B64.dec(x.data)], { type: x.type }) }));
      const removed = old ? pagesInUse((old.pageIds || []).filter(id => !(t.pageIds || []).includes(id)), t.id) : [];
      const ticket = { ...t, trip: name, thumb: t.thumb ? new Blob([B64.dec(t.thumb.data)], { type: t.thumb.type }) : null };
      await saveTicketDB(ticket, newPages, removed);
      S.tickets = S.tickets.filter(x => x.id !== t.id); S.tickets.push(ticket); n++;
    }
    if (data.photos && data.photos.items) {
      await getTP(); const cur = TP[name] || (TP[name] = { cover: data.photos.cover, items: [], ...(data.photos.cpos ? { cpos: data.photos.cpos } : {}) }); const pm = new Map((data.photos.pages || []).map(x => [x.id, x])); const np = [];
      for (const it of data.photos.items) { if (cur.items.some(x => x.id === it.id) || cur.items.length >= PHOTO_MAX || !pm.get(it.id)) continue; const x = pm.get(it.id); np.push({ id: x.id, w: x.w, h: x.h, blob: new Blob([B64.dec(x.data)], { type: x.type }) }); cur.items.push(it); }
      if (np.length) { await putPages(np); if (!cur.cover) cur.cover = cur.items[0].id; } if (!cur.items.length) delete TP[name]; await saveTP(); PHB.clear();
    }
    if (data.expenses) { await getExp(); mergeExp(data.expenses, name); await saveExp(); }
    if (data.shop && data.shop[name]) { const have = new Set(shopPhotoIds(name)); mergeShop(data.shop, name); const np = []; for (const i of data.shop[name].items || []) { const x = i.ph && !have.has(i.ph) && pageMap.get(i.ph); if (x) np.push({ id: x.id, w: x.w, h: x.h, blob: new Blob([B64.dec(x.data)], { type: x.type }) }); } if (np.length) await putPages(np); await saveShop(); }
    const tr = data.trip || {};
    if ((tr.a || !tickets.length || tr.kind) && !tripRec(name)) { (S.trips = S.trips || []).push({ name, a: tr.a || '', e: tr.e || '', createdAt: Date.now(), ...(tr.kind ? { kind: tr.kind } : {}) }); await saveTripRecs(); }
    else if (tr.kind && tripRec(name) && !tripRec(name).kind) { tripRec(name).kind = tr.kind; await saveTripRecs(); }
    busy(false);
    S.tab = 'trips'; lsSet('tripHintDone', true); await openTrip(name);
    toast(TL`"${name}" eklendi · ${n} bilet`, 3200); syncReminders();
  } catch (e) { console.error(e); busy(false); toast(TX('Eklenemedi: ') + (e.message || e)); }
}

/* ---------- paylaşılan dosyalar ---------- */
function takeShared() {
  if (!A) return;
  if (!S.unlocked) { S.pendingShare = true; return; }
  let s = '';
  busy(TX('Hazırlanıyor…'));
  setTimeout(() => {
    try { s = A.takeShared() || ''; } catch (e) { s = ''; }
    if (!s) { busy(false); return; }
    const i = s.indexOf('|'), mime = s.slice(0, i) || 'application/octet-stream', data = s.slice(i + 1);
    const bytes = B64.dec(data); busy(false);
    if (isTripFile(bytes)) { importTripFile(bytes); return; }
    const isPdf = mime === 'application/pdf' || TD.decode(bytes.subarray(0, 5)) === '%PDF-';
    const file = new File([bytes], isPdf ? TX('Paylaşılan.pdf') : TX('Paylaşılan'), { type: isPdf ? 'application/pdf' : mime });
    if (S.view === 'edit' && S.draft) { toast(TX('Önce açık bileti kaydet ya da vazgeç')); return; }
    if (!isPdf && /^image\//.test(mime)) { sharedImageChoice(file).then(h => { if (!h) startImport([file]); }); return; }
    startImport([file]);
  }, 50);
}
window.onSharedAvailable = takeShared;

/* ---------- bildirimden açılış ---------- */
function openLaunchTicket() {
  if (!A || !A.takeLaunchTicket) return;
  if (!S.unlocked) { S.pendingTicket = true; return; }
  let id = ''; try { id = A.takeLaunchTicket(); } catch (e) {}
  if (id && id.startsWith('act:')) {
    const [, act, list] = id.split(':'), ts = S.tickets.filter(t => (list || '').split(',').includes(t.id) && !t.status);
    if (!ts.length) { toast(TX('Bunlar zaten işaretli')); return; }
    if (S.view !== 'home') go('home');
    if (act === 'done') setStatus(ts.map(t => t.id), 'done');
    else if (ts.length === 1) statusMenu(ts[0]); else reviewDialog(ts, TX('Gittin mi?'), TX('Son etkinlikler'));
    return;
  }
  if (id === 'docs') { openDocs(); return; }
  if (id && id.startsWith('shop:')) { openShop(id.slice(5)); return; }
  if (!id || !S.tickets.find(t => t.id === id)) return;
  if (S.view === 'edit') return;
  openTicket(id);
}
window.onLaunchTicket = openLaunchTicket;

/* ---------- tanılama kaydı (son 20 olay, yalnızca bu telefonda) ---------- */
/* 5.15: ilk kullanım tarihi → "Erken kullanıcı" (ileride Pro'dan önce gelenler sınırsız kalır).
   FOUNDER_CUTOFF: Pro sürümünde belirlenecek (ms); null iken herkes erken kullanıcı. */
const FOUNDER_CUTOFF = null;
let FIRST_USE = null;
async function ensureFirstUse() {
  try {
    if (FIRST_USE == null) FIRST_USE = await metaGet('firstUse');
    if (FIRST_USE) return FIRST_USE;
    let t = Date.now();
    for (const x of S.tickets || []) { const c = x.createdAt || (x.date ? Date.parse(x.date + 'T12:00') : 0); if (c && c < t) t = c; }
    FIRST_USE = t; await metaSet('firstUse', t);
    if (S.view === 'settings') render();
  } catch (e) {}
  return FIRST_USE;
}
const ymdOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isFounder = () => !FOUNDER_CUTOFF || (FIRST_USE && FIRST_USE < FOUNDER_CUTOFF);
let DIAG = null;
const DIAG_DAYS = 30;
/* 5.15: 30 günden eski tanılama kayıtları kendiliğinden silinir (en fazla 20 kayıt da kalır) */
async function diagPrune() {
  try { if (!DIAG) DIAG = (await metaGet('diag')) || []; const lim = Date.now() - DIAG_DAYS * 864e5, n = DIAG.length; DIAG = DIAG.filter(x => (x.t || 0) >= lim); if (DIAG.length !== n) await metaSet('diag', DIAG); } catch (e) {}
}
async function diagLog(e) {
  try {
    if (!DIAG) DIAG = (await metaGet('diag')) || [];
    const lim = Date.now() - DIAG_DAYS * 864e5; DIAG = DIAG.filter(x => (x.t || 0) >= lim);
    DIAG.push({ t: Date.now(), ...e }); if (DIAG.length > 20) DIAG = DIAG.slice(-20);
    await metaSet('diag', DIAG);
  } catch (er) {}
}
/* biletin şehri için çevrimdışı çapa: o şehrin havalimanlarının ortası */
function cityAnchorOffline(city) {
  const names = cityNames(city); if (!names.length || !TRAVEL) return null;
  const pts = Object.values(TRAVEL.ap).filter(v => v[3] != null && names.includes(lowerSmart(v[0]))).map(v => ({ lat: v[3], lon: v[4] }));
  if (!pts.length) return null;
  // aynı adlı başka şehirler olabilir (London, Kanada): en çok havalimanı olan kümeyi al
  let best = [];
  for (const a of pts) { const cl = pts.filter(b => distKm(a, b) <= 100); if (cl.length > best.length) best = cl; }
  return { lat: best.reduce((x, v) => x + v.lat, 0) / best.length, lon: best.reduce((x, v) => x + v.lon, 0) / best.length };
}
/* paylaşılan yer için bölge: biletin mevcut konumu, yoksa seyahat/şehir */
function shareAnchor(d) {
  const a = anchorFor(d); if (a.pt) return a;
  if (hasC(d)) return { pt: { lat: +d.lat, lon: +d.lon }, how: 'biletin konumu' };
  return a;
}
/* tarihsiz kayıtlar için: aynı seyahatin oteli, konumlu bileti ya da ilk uçuşun varışı */
function tripAnchorAny(d) {
  if (!d || !d.trip) return null;
  const ts = S.tickets.filter(t => t.trip === d.trip && t.id !== d.id);
  const ho = ts.find(t => t.type === 'konaklama' && hasC(t)); if (ho) return { lat: +ho.lat, lon: +ho.lon };
  const any = ts.find(t => t.type !== 'ucak' && hasC(t)); if (any) return { lat: +any.lat, lon: +any.lon };
  const fl = ts.filter(t => t.type === 'ucak' && t.to && hasC(apLL(t.to))).sort((a, b) => (a.date || '9') < (b.date || '9') ? -1 : 1)[0];
  if (fl) { const ll = apLL(fl.to); return { lat: +ll.lat, lon: +ll.lon }; }
  return null;
}
function anchorFor(d) {
  if (!d) return { pt: null, how: 'yok' };
  const t = (d.date && tripAnchor(d)) || tripAnchorAny(d); if (t) return { pt: t, how: TX('seyahat (otel/uçuş)') };
  const city = geoQueries(d).city || '';
  const c = cityAnchorOffline(city); if (c) return { pt: c, how: TL`şehir: ${city}` };
  return { pt: null, how: 'bilinmiyor' };
}
/* en yakın şehir (havalimanı listesinden, 80 km içinde) */
function nearCity(lat, lon) {
  if (!TRAVEL || lat === '' || lat == null) return '';
  let best = null, bd = 80;
  for (const v of Object.values(TRAVEL.ap)) { if (v[3] == null) continue; const dk = distKm({ lat: +lat, lon: +lon }, { lat: v[3], lon: v[4] }); if (dk < bd) { bd = dk; best = v[0]; } }
  return best || '';
}
/* Google sayfasındaki adaylardan seçim: bölgeye uzak olanlar elenir; adın yanındakiler öne çıkar */
const SRC_RANK = { place3d4d: 1, param: 1, at: 2, staticmap: 2, nullnull: 4, appinit: 9 };
function chooseCandidate(cands, anchor) {
  // Google sayfasında haritanın açılış merkezi (appinit) telefonun bulunduğu yerdir: ona denk gelen sayfa koordinatları yerin konumu değildir
  const ip = (cands || []).find(c => c.src === 'appinit' && c.in !== 'url');
  const out = (cands || []).map(c => {
    const dist = anchor ? distKm(anchor, c) : null;
    const near = c.nameDist >= 0 && c.nameDist < 400;
    let score = c.in === 'url' ? 0 : (SRC_RANK[c.src] ?? 5) + (near ? -2 + c.nameDist / 400 : 0);
    let why = '';
    if (ip && c.in !== 'url' && distKm(ip, c) < 2) why = TX('telefonun konumu (sayfanın açılış merkezi)');
    else if (anchor && dist > 100) why = TX('bölgeye uzak');
    else if (!anchor && c.in !== 'url' && !near) why = TX('bölge bilinmiyor ve ada yakın değil');
    return { ...c, dist, score, why };
  });
  const ok = out.filter(c => !c.why).sort((a, b) => a.score - b.score);
  return { pick: ok[0] || null, all: out };
}

/* ---------- Google Haritalar vb.'den paylaşılan konum ---------- */
let mapLinkWait = null;
window.onMapLink = j => { const f = mapLinkWait; mapLinkWait = null; f && f(j); };
function resolveMapLinkFull(u) {
  return new Promise(res => {
    if (!A || !A.resolveMapLink) return res(null);
    mapLinkWait = res; A.resolveMapLink(/^https?:/i.test(u) ? u : 'https://' + u);
    setTimeout(() => { if (mapLinkWait === res) { mapLinkWait = null; res(null); } }, 30000);
  }).then(j => { try { return j ? JSON.parse(j) : null; } catch (e) { return null; } });
}
function resolveMapLinkFull(u, hint) {
  return new Promise(res => {
    if (!A || !A.resolveMapLink) return res(null);
    mapLinkWait = res; const url = /^https?:/i.test(u) ? u : 'https://' + u;
    if (A.resolveMapLinkHint) A.resolveMapLinkHint(url, hint || ''); else A.resolveMapLink(url);
    setTimeout(() => { if (mapLinkWait === res) { mapLinkWait = null; res(null); } }, 30000);
  }).then(j => { try { return j ? JSON.parse(j) : null; } catch (e) { return null; } });
}
/* ".../maps/place/Bacchanalia,+1-3+Mount+St,+London+W1K+3NB,+Birleşik+Krallık/data=..." → "Bacchanalia, 1-3 Mount St, …" */
function placeFromUrl(u) {
  const m = /\/maps\/place\/([^/?#]+)/.exec(u || ''); if (!m) return '';
  try { const t = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); return /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(t) ? '' : t; } catch (e) { return ''; }
}
/* bağlantıyı aç ve bölgeye uygun koordinatı seç. Döner {ll, name, q, err, rep, placeText} */
async function locFromLink(u, hint, d) {
  const ll0 = parseMapLink(u); if (ll0) return { ll: ll0, name: '', q: '', err: false, rep: { direct: true } };
  if (A && A.resolveMapLink) {
    let r = await resolveMapLinkFull(u, hint);
    if (r && r.s === 404 && /maps\.app\.goo\.gl/i.test(u) && !/[?&]g_st=/.test(u)) { const r2 = await resolveMapLinkFull(u + (u.includes('?') ? '&' : '?') + 'g_st=ac', hint); if (r2 && r2.s !== 404) r = { ...r2, chain: (r.chain || []).concat([TX('↻ g_st=ac ile tekrar')]).concat(r2.chain || []) }; }
    if (!r) return { ll: null, name: '', q: '', err: true, rep: { timeout: true } };
    const an = anchorFor(d);
    const ch = chooseCandidate(r.cands || (r.lat != null ? [{ lat: r.lat, lon: r.lon, src: 'place3d4d', in: 'url', nameDist: -1 }] : []), an.pt);
    const rep = { s: r.s, chain: r.chain || [], url: r.url, title: r.name, q: r.q, bodyLen: r.bodyLen, err: r.err, anchor: an.pt ? { ...an.pt, how: an.how } : { how: an.how },
      cands: ch.all.map(c => ({ lat: c.lat, lon: c.lon, src: c.src, in: c.in, nameDist: c.nameDist, dist: c.dist == null ? null : Math.round(c.dist), why: c.why, ctx: (c.ctx || '').slice(0, 120), chosen: ch.pick === c || (ch.pick && ch.pick.lat === c.lat && ch.pick.lon === c.lon && ch.pick.src === c.src) })) };
    return { ll: ch.pick ? valid(+ch.pick.lat, +ch.pick.lon) : null, name: r.name || '', q: r.q || '', err: r.s === -1, rep, placeText: placeFromUrl(r.url || '') || r.q || '' };
  }
  const fin = await resolveShort(u);
  return { ll: parseMapLink(fin), name: '', q: '', err: !fin, rep: { legacy: true, url: fin } };
}
/* paylaşılan metin: "Yer adı\nAdres\nhttps://maps.app.goo.gl/…" — d: konumun ekleneceği bilet */
async function locFromShare(txt, d) {
  const urls = txt.match(/https?:\/\/[^\s<>"']+/g) || [];
  const lines = txt.split('\n').map(l => l.replace(/https?:\/\/\S+/g, '').trim()).filter(Boolean);
  let name = lines[0] || '', addr = lines.slice(1).join(', ');
  if (!name) { const m = /\/maps\/place\/([^/@?]+)/.exec(txt); if (m) try { name = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) {} }
  let ll = parseMapLink(txt), q = '', err = false, isMap = false, rep = null, placeText = placeFromUrl(txt);
  if (!ll) {
    const u = urls.find(x => isShortMapLink(x) || /share\.google|google\.[a-z.]+\/maps|maps\.google|goo\.gl|g\.co\/|maps\.apple|openstreetmap|yandex/i.test(x));
    if (u) {
      isMap = true;
      busy(TX('Konum alınıyor…')); const x = await locFromLink(u, name, d); busy(false);
      ll = x.ll; q = x.q; err = x.err; rep = x.rep; if (!name && x.name) name = x.name; if (x.placeText) placeText = x.placeText;
    }
  } else rep = { direct: true };
  // bölge kontrolü (doğrudan koordinatlarda da)
  if (ll && d && rep && rep.direct) { const an = anchorFor(d); if (an.pt && distKm(an.pt, ll) > 300) rep.farWarn = Math.round(distKm(an.pt, ll)); }
  diagLog({ kind: TX('paylaşım'), text: txt.slice(0, 300), ticket: d ? `${d.title || ''} (${d.date || 'tarihsiz'})` : '-', result: ll ? `${ll.lat}, ${ll.lon}` : 'yok', ...(rep ? { rep } : {}) });
  const link = urls.find(x => isShortMapLink(x) || /share\.google|google\.[a-z.]+\/maps|maps\.google|goo\.gl|g\.co\//i.test(x)) || '';
  return { ll, name, addr, q, err, isMap: isMap || !!ll, placeText, link };
}

/* Google'ın verdiği adres metnini OpenStreetMap'te bölgede ara:
   tam adres → bina numarası sadeleştirilmiş → numarasız sokak → posta kodu */
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|\d{5}(?:-\d{4})?|\d{4}\s?[A-Z]{2}|\d{2}-\d{3})\b/;
/* bölgenin şehri, OpenStreetMap için İngilizce adıyla ("Londra" → "London") */
function regionCityEn(pt) {
  if (!pt) return '';
  const c = nearCity(pt.lat, pt.lon); if (!c) return '';
  return CITY_ALIAS[lowerSmart(c)] ? CITY_ALIAS[lowerSmart(c)].replace(/\b\w/g, m => m.toUpperCase()) : c;
}
/* Google yer adlarını Türkçe verirse OpenStreetMap için yaygın kelimeleri İngilizceye çevir */
const TR_EN = [[TX('hayvanat bahçesi'), TX('Zoo')], [TX('bahçeleri'), TX('Gardens')], [TX('bahçesi'), TX('Garden')], [TX('sarayı'), TX('Palace')], [TX('müzesi'), TX('Museum')], [TX('köprüsü'), TX('Bridge')], [TX('parkı'), TX('Park')], [TX('meydanı'), TX('Square')],
  ['katedrali', TX('Cathedral')], ['kulesi', TX('Tower')], [TX('pazarı'), TX('Market')], [TX('çarşısı'), TX('Market')], ['kalesi', TX('Castle')], ['kilisesi', TX('Church')], ['camii', TX('Mosque')], ['galerisi', TX('Gallery')],
  [TX('gölü'), TX('Lake')], ['nehri', TX('River')], ['caddesi', TX('Street')], [TX('sokağı'), TX('Street')], ['tiyatrosu', TX('Theatre')], [TX('operası'), TX('Opera House')], ['akvaryumu', TX('Aquarium')], ['istasyonu', TX('Station')],
  [TX('havalimanı'), TX('Airport')], [TX('plajı'), TX('Beach')], [TX('adası'), TX('Island')], [TX('dağı'), TX('Mountain')], [TX('ormanı'), TX('Forest')], [TX('şelalesi'), TX('Falls')], [TX('anıtı'), TX('Monument')], ['heykeli', TX('Statue')],
  [TX('kütüphanesi'), TX('Library')], [TX('üniversitesi'), TX('University')], [TX('manastırı'), TX('Abbey')], [TX('bazilikası'), TX('Basilica')]];
function trToEn(n) {
  let out = n || '', hit = false;
  for (const [tr, en] of TR_EN) { const re = new RegExp(`(^|\\s)${tr}(?=\\s|$)`, 'iu'); if (re.test(lowerSmart(out))) { out = out.split(/\s+/).map(w => lowerSmart(w) === tr ? en : w).join(' '); if (tr.includes(' ')) out = out.replace(new RegExp(tr, 'iu'), en); hit = true; } }
  return hit ? out.replace(/\s+/g, ' ').trim() : '';
}
async function addressLookup(placeText, name, d) {
  let parts = placeText.split(',').map(x => x.trim()).filter(Boolean);
  let pname = name || '';
  if (name && parts.length && lowerSmart(parts[0]) === lowerSmart(name)) parts = parts.slice(1);
  else if (!name && parts.length === 1 && !/\d/.test(parts[0])) { pname = parts[0]; parts = []; }
  else if (parts.length > 2 && !/\d/.test(parts[0])) { pname = pname || parts[0]; parts = parts.slice(1); } // ilk parça işletme adı
  else if (!pname && parts.length > 1 && !/\d/.test(parts[0])) { pname = parts[0]; parts = parts.slice(1); }
  parts = parts.filter(p => !COUNTRIES.has(lowerSmart(p)));
  if (!parts.length && !pname) return null;
  const addr = parts.join(', '), street = parts[0] || '', rest = parts.slice(1).join(', ');
  const pc = (POSTCODE.exec(addr) || [])[1] || '';
  const an = shareAnchor(d), log = [];
  const city = parts.map(p => p.replace(POSTCODE, '').trim()).filter(Boolean).slice(-1)[0] || regionCityEn(an.pt);
  // gerçek adres mi? (sokak/numara ya da posta kodu) — yalnızca şehir kaldıysa adres sayılmaz
  const hasStreet = /\d/.test(addr) || parts.length > 1 && !!rest;
  const en = trToEn(pname);
  const nameQs = [en, pname].filter(Boolean).flatMap(n => [{ q: [n, city].filter(Boolean).join(', '), approx: false }, ...(city ? [] : [{ q: n, approx: false }])]);
  const qs = [
    ...(hasStreet ? [
      { q: addr, approx: false },
      { q: [street.replace(/^(\d+)\s*[-–]\s*\d+/, '$1'), rest].filter(Boolean).join(', '), approx: false },
    ] : []),
    ...nameQs,
    ...(hasStreet ? [
      { q: [street.replace(/^\d+[a-z]?(\s*[-–]\s*\d+[a-z]?)?\s+/i, ''), rest].filter(Boolean).join(', '), approx: true },
      pc ? { q: [pc, city].filter(Boolean).join(', '), approx: true } : null,
    ] : []),
  ].filter((x, i, a) => x && x.q.length > 3 && (!city || lowerSmart(x.q) !== lowerSmart(city)) && a.findIndex(y => y && y.q === x.q) === i);
  let found = null, errs = 0;
  for (let i = 0; i < qs.length && !found && i < 6; i++) {
    if (i) await sleep(1100);
    const x = await geocodeOnce(qs[i].q, 'n', an.pt);
    if (x.err) errs++;
    // şehrin kendisi (ör. "Londra, İngiltere") yer sonucu sayılmaz
    const isCity = r => city && cityNames(city).some(c => lowerSmart(r.label.split(',')[0]).trim() === c);
    const ok = x.list.find(r => (!an.pt || distKm(an.pt, r) <= 60) && !isCity(r));
    log.push(TL`Nominatim${an.pt ? TX(' (bölgede)') : ''}: "${qs[i].q}" → ${x.err ? TX('bağlantı hatası') : x.list.length + TX(' sonuç')}${ok ? ' · ' + ok.label.slice(0, 60) : ''}`);
    if (ok) found = { lat: ok.lat, lon: ok.lon, label: ok.label, approx: qs[i].approx };
    if (errs >= 2) break;
  }
  diagLog({ kind: 'google adresi', ticket: `${d.title || ''} (${d.date || 'tarihsiz'})`, text: placeText + (en ? TL` · İngilizce: ${en}` : ''), result: found ? `${found.approx ? TX('yaklaşık') : 'adres'} · ${found.lat}, ${found.lon}` : (errs ? TX('bağlantı hatası') : TX('bulunamadı')), steps: log });
  return found;
}
/* koordinat yoksa: paylaşılan ad/adresle OpenStreetMap'te, biletin bölgesinde ara (yaklaşık) */
async function shareFallback(sh, d) {
  if (sh.err) return { st: 'neterr' };
  // yalnızca paylaşılan yerin bilgisiyle ara; biletin kendi adresine geri dönme
  const tmp = { id: d.id, type: d.type, date: d.date, endDate: d.endDate, trip: d.trip, title: sh.name || '', place: sh.addr || sh.q || '', auto: null };
  if (!tmp.title && !tmp.place && !sh.placeText) return { st: 'notfound' };
  const dA = { ...d, lat: '', lon: '', place: d.place || sh.placeText || sh.addr || '' }; // bölge: seyahat, yoksa bağlantıdaki adresin şehri
  if (!tmp.place && sh.placeText) tmp.place = sh.placeText;
  const prev = S.geocode;
  if (prev === false) {
    if (!await dialog({ title: TX('Konum yaklaşık olarak aransın mı?'), text: TX('Google\'ın bağlantısında koordinat yok, yalnızca yerin adı ve adresi var. Bu adresi OpenStreetMap\'te arayıp konumu bulabilirim (Ayarlar\'da bu özellik kapalı, yalnızca bu sefer).'), ok: TX('Ara'), cancel: TX('Hayır') })) return { st: 'off' };
    S.geocode = true;
  }
  let st;
  try {
    if (sh.placeText || sh.name) {
      busy(TX('Adresten konum bulunuyor…'));
      let f = null; try { f = await addressLookup(sh.placeText || sh.name, sh.name, dA); } finally { busy(false); }
      if (f) return { ll: { lat: f.lat, lon: f.lon }, label: TL`Google adresi: ${sh.name || (sh.placeText || '').split(',')[0]}`, approx: f.approx };
    }
    st = (tmp.title || tmp.place) ? await findLocation(tmp, '', true) : 'notfound';
  } finally { if (prev === false) S.geocode = false; }
  if (st === 'ok' || st === 'approx') {
    const an = shareAnchor(dA), dk = an.pt ? distKm(an.pt, { lat: +tmp.lat, lon: +tmp.lon }) : 0;
    if (an.pt && dk > 60) { diagLog({ kind: TX('paylaşım (ad araması)'), ticket: `${d.title || ''} (${d.date || 'tarihsiz'})`, text: tmp.title, result: TL`elendi: bölgeye ${Math.round(dk)} km · ${tmp.geoLabel || ''}`.slice(0, 120), steps: [] }); return { st: 'notfound' }; }
    // bölge bilinmiyorsa sonuç yaklaşık sayılır; kartta şehir görünür, kayıtta uzaklık kontrolü yapılır
    return { ll: { lat: tmp.lat, lon: tmp.lon }, label: tmp.geoLabel, approx: true };
  }
  return { st };
}
/* Google Haritalar paylaşımından yeni yer (biletsiz) */
async function placeFromShare(txt, trip = '') {
  const nm0 = (txt.split('\n').map(l => l.trim()).find(l => l && !/^https?:\/\//.test(l)) || '').slice(0, 80);
  const d0 = { title: nm0, type: 'gezi', place: '', trip };
  const sh = await locFromShare(txt, d0);
  const name = (sh.name || nm0 || '').slice(0, 80);
  // adres: Google'ın verdiği metinden ad ve ülke çıkarılır
  let parts = (sh.placeText || sh.addr || '').split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length && name && lowerSmart(parts[0]) === lowerSmart(name)) parts = parts.slice(1);
  const addr = parts.filter(x => !COUNTRIES.has(lowerSmart(x))).join(', ').slice(0, 100);
  const d1 = { ...d0, title: name, place: addr };
  let ll = sh.ll, label = name ? TL`Google Haritalar: ${name}` : TX('Google Haritalar'), approx = false;
  if (!ll && !sh.err) { const fb = await shareFallback({ ...sh, name }, d1); if (fb.ll) { ll = fb.ll; label = fb.label; approx = fb.approx !== false; } }
  const pre = { title: name, place: addr, trip, fromShare: true, mapUrl: sh.link || '', auto: new Set(['title', ...(addr ? ['place'] : [])]) };
  if (ll) Object.assign(pre, { lat: ll.lat, lon: ll.lon });
  if (ll || sh.link) Object.assign(pre, { geoLabel: name ? TL`Google Haritalar: ${name}` : label, geoApprox: false });
  else toast(sh.err ? TX('İnternete bağlanılamadı; konumu sonra ekleyebilirsin') : TX('Konum bulunamadı; formdan ekleyebilirsin'), 3500);
  newPlace(pre);
}
const shareHelp = TX('Google Haritalar\'da yere uzun bas, üstte çıkan koordinatı kopyala ve ⋯ → Bağlantı yapıştır ile ekle.');
async function takeSharedText() {
  if (!A || !A.takeSharedText) return;
  if (!S.unlocked) { S.pendingText = true; return; }
  let txt = ''; try { txt = A.takeSharedText(); } catch (e) {}
  if (!txt) return;
  if (!/https?:\/\/|-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+/.test(txt)) { toast(TX('Paylaşılan içerikte harita bağlantısı yok'), 3000); return; }
  if (S.shopLoc && S.shopLoc(txt)) return;
  const editing = S.view === 'edit' && S.draft && S.draft.type !== 'ucak';
  let target = editing ? S.draft : null;
  if (!editing && S.sugTrip && Date.now() - S.sugTrip.at < 45 * 60000 && !(S.locTarget && S.locTarget.at > S.sugTrip.at)) return placeFromShare(txt, S.sugTrip.trip);
  if (!target && S.locTarget && Date.now() - S.locTarget.at < 15 * 60000) { target = S.tickets.find(t => t.id === S.locTarget.id) || null; S.locTarget = null; }
  if (!target) {
    const today = todayStr();
    const cand = S.tickets.filter(t => t.type !== 'ucak' && (t.endDate || t.date || today) >= addDays(today, -1))
      .sort((a, b) => (a.date || '9') < (b.date || '9') ? -1 : 1);
    const lt = S.locTarget && Date.now() - S.locTarget.at < 15 * 60000 ? S.tickets.find(t => t.id === S.locTarget.id) : null;
    const lastOpen = lt || (S.cur && S.cur.t && S.cur.t.type !== 'ucak' ? S.cur.t : null);
    if (lastOpen) { const i = cand.findIndex(t => t.id === lastOpen.id); if (i > 0) cand.unshift(cand.splice(i, 1)[0]); else if (i < 0) cand.unshift(lastOpen); }
    if (!cand.length) return placeFromShare(txt);
    const nm = (txt.split('\n').map(l => l.trim()).find(l => l && !/^https?:\/\//.test(l)) || TX('Konum')).slice(0, 60);
    target = await sheetMenu(`${nm} — nereye eklensin?`, [{ icon: I('map-pin-plus'), label: TX('Yeni yer olarak ekle'), sub: TX('Restoran, kafe, gezilecek yer'), value: '__new' }].concat(cand.slice(0, 8).map(t => ({ icon: tDot(t.type, 'sm'), label: t.title || typeOf(t.type).n, sub: [t.date ? fmtDate(t.date) : '', hasC(t) ? TX('konumu var, değişecek') : ''].filter(Boolean).join(' · '), value: t }))));
    if (!target) return;
    if (target === '__new') return placeFromShare(txt);
  }
  const sh = await locFromShare(txt, target);
  const link = sh.link || '', nm = (sh.name || (sh.placeText || '').split(',')[0] || '').trim().slice(0, 80);
  // Google bağlantısı yeri kesin tanımlar; koordinat yalnızca ek bilgi (Citymapper, rotalar)
  let ll = sh.ll, label = TL`Google Haritalar${nm ? ': ' + nm : ''}`, approx = false;
  if (!ll && !sh.err && (sh.placeText || nm)) { const fb = await shareFallback({ ...sh, name: nm }, target); if (fb.ll) { ll = fb.ll; approx = fb.approx !== false; } }
  if (!ll && !link) {
    await dialog({ title: sh.err ? TX('Konum okunamadı') : TX('Bu yer bulunamadı'), text: (sh.err ? TX('İnternete bağlanılamadı.') : TL`"${esc(nm || TX('Paylaşılan yer'))}" bulunamadı.`) + (hasC(target) ? TX(' Biletin konumu değiştirilmedi.') : '') + '<br><br>' + shareHelp, ok: TX('Tamam'), cancel: '' });
    return;
  }
  const loc = { lat: ll ? ll.lat : '', lon: ll ? ll.lon : '', mapUrl: link };
  if (editing) {
    Object.assign(target, loc, { geoLabel: label, geoApprox: approx }); target.auto && target.auto.delete('lat');
    renderEdit($('#app')); toast(TX('Konum eklendi'), 2500);
    setTimeout(() => $('.lcard')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
    return;
  }
  const t = target;
  Object.assign(t, loc, { locSrc: label, locApprox: approx, updatedAt: Date.now() });
  await saveTicketDB(t, [], []);
  toast(TL`Konum "${t.title}" biletine eklendi`, 3000);
  if (S.view === 'view' && S.cur && S.cur.t.id === t.id) render();
}
window.onSharedTextAvailable = takeSharedText;


/* ================= hava durumu (Open-Meteo) ================= */
const WXMEM = {};
const wxIcon = c => c === 0 ? 'sun' : c <= 2 ? 'haze' : c === 3 ? 'cloud' : (c === 45 || c === 48) ? 'cloud-fog' : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) ? 'cloud-rain' : (c >= 71 && c <= 77) || c === 85 || c === 86 ? 'cloud-snow' : c >= 95 ? 'cloud-storm' : 'cloud';
const wxLabel = c => c === 0 ? TX('açık') : c <= 2 ? TX('parçalı bulutlu') : c === 3 ? TX('kapalı') : (c === 45 || c === 48) ? 'sisli' : c >= 51 && c <= 57 ? TX('çiseli') : c >= 61 && c <= 67 ? TX('yağmurlu') : c >= 71 && c <= 77 ? TX('karlı') : c >= 80 && c <= 82 ? TX('sağanak') : c === 85 || c === 86 ? TX('kar sağanağı') : c >= 95 ? TX('fırtınalı') : '';
const wxWet = (c, p) => (p != null && p >= 50) || (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const wxKey = (lat, lon) => `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
const r0 = x => Math.round(x);
async function wxGet(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch (e) { return null; }
}
/* 16 günlük tahmin; 3 saatten eskiyse yenilenir, internet yoksa son kayıt kullanılır */
const WXFLY = {};
function wxForecast(lat, lon) {
  const k = 'wx:' + wxKey(lat, lon);
  return WXFLY[k] || (WXFLY[k] = wxForecast_(lat, lon).finally(() => { delete WXFLY[k]; }));
}
async function wxForecast_(lat, lon) {
  const k = 'wx:' + wxKey(lat, lon);
  let c = WXMEM[k] || await metaGet(k);
  if (c) WXMEM[k] = c;
  if (S.wx === false || (c && Date.now() - c.t < 3 * 3600000)) return c || null;
  const j = await wxGet(`https://api.open-meteo.com/v1/forecast?latitude=${(+lat).toFixed(4)}&longitude=${(+lon).toFixed(4)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&hourly=temperature_2m,precipitation_probability,weather_code&timezone=auto&forecast_days=16`);
  if (j && j.daily && j.daily.time) { c = { t: Date.now(), d: j.daily, h: j.hourly }; WXMEM[k] = c; metaSet(k, c); }
  return c || null;
}
/* mevsim ortalaması: son 3 yılın aynı günleri (±3 gün) */
async function wxNormals(lat, lon, from, to) {
  const k = `wxn:${wxKey(lat, lon)}:${from.slice(5)}:${to.slice(5)}`;
  let c = WXMEM[k] || await metaGet(k);
  if (c) return (WXMEM[k] = c);
  if (S.wx === false) return null;
  const y = +todayStr().slice(0, 4), shift = (d, yy) => `${yy}${d.slice(4)}`;
  const st = addDays(shift(from, y - 3), -3), en = addDays(shift(to, y - 1), 3);
  if (en >= addDays(todayStr(), -6)) return null;
  const j = await wxGet(`https://archive-api.open-meteo.com/v1/archive?latitude=${(+lat).toFixed(3)}&longitude=${(+lon).toFixed(3)}&start_date=${st}&end_date=${en}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`);
  if (!j || !j.daily || !j.daily.time) return null;
  c = { d: j.daily }; WXMEM[k] = c; metaSet(k, c);
  return c;
}
function wxNormFor(n, date) {
  if (!n) return null;
  const md = date.slice(5), d = n.d, mx = [], mn = [], wet = [];
  for (let i = 0; i < d.time.length; i++) {
    const t = d.time[i], cand = `${t.slice(0, 4)}-${md}`;
    if (Math.abs(nightsBetween(cand, t)) > 3 || d.temperature_2m_max[i] == null) continue;
    mx.push(d.temperature_2m_max[i]); mn.push(d.temperature_2m_min[i]); wet.push((d.precipitation_sum[i] || 0) >= 1 ? 1 : 0);
  }
  if (!mx.length) return null;
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { kind: 'norm', max: avg(mx), min: avg(mn), wetPct: r0(avg(wet) * 100) };
}
/* bir gün için: tahmin varsa tahmin, 16 günden uzaksa mevsim ortalaması */
async function wxDays(lat, lon, dates) {
  const today = todayStr(), out = {};
  const fut = dates.filter(d => d >= today); if (!fut.length) return out;
  const fc = await wxForecast(lat, lon);
  const far = [];
  for (const d of fut) {
    const i = fc && fc.d ? fc.d.time.indexOf(d) : -1;
    if (i >= 0 && fc.d.temperature_2m_max[i] != null) out[d] = { kind: 'fc', max: fc.d.temperature_2m_max[i], min: fc.d.temperature_2m_min[i], code: fc.d.weather_code[i], prob: fc.d.precipitation_probability_max ? fc.d.precipitation_probability_max[i] : null, wind: fc.d.wind_speed_10m_max ? fc.d.wind_speed_10m_max[i] : null, age: fc.t };
    else if (nightsBetween(today, d) > 13) far.push(d);
  }
  if (far.length) { const n = await wxNormals(lat, lon, far[0], far[far.length - 1]); for (const d of far) { const v = wxNormFor(n, d); if (v) out[d] = v; } }
  return out;
}
function wxHourOf(lat, lon, date, time) {
  const c = WXMEM['wx:' + wxKey(lat, lon)]; if (!c || !c.h || !time) return null;
  const i = c.h.time.indexOf(`${date}T${time.slice(0, 2)}:00`); if (i < 0 || c.h.temperature_2m[i] == null) return null;
  return { temp: c.h.temperature_2m[i], code: c.h.weather_code[i], prob: c.h.precipitation_probability ? c.h.precipitation_probability[i] : null };
}
/* biletin hava konumu: uçuşta varış havalimanı, yoksa biletin konumu, yoksa seyahatteki konum / şehir */
function wxLocFor(t, day) {
  if (t.type === 'ucak') { const ll = apLL(t.to); return hasC(ll) ? { lat: +ll.lat, lon: +ll.lon, city: apCity(t.to) || t.to } : null; }
  if (hasC(t)) return { lat: +t.lat, lon: +t.lon, city: nearCity(t.lat, t.lon) };
  const a = tripAnchor({ ...t, date: day || t.date }) || cityAnchorOffline(geoQueries(t).city || '');
  return a ? { lat: a.lat, lon: a.lon, city: nearCity(a.lat, a.lon) } : null;
}
function wxDayLabel(d) { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTH_TR[m - 1].slice(0, 3)}`; }
/* bilet ekranı: özet kartında hava etiketi */
async function fillWxViewer(t) {
  const box = $('#wxv'); if (!box || S.wx === false) return;
  const loc = wxLocFor(t); if (!loc) { box.remove(); return; }
  const day = t.date < todayStr() ? todayStr() : t.date;
  const W = await wxDays(loc.lat, loc.lon, [day]), w = W[day];
  if (!$('#wxv')) return;
  if (!w) { box.remove(); return; }
  const hr = w.kind === 'fc' && t.type !== 'konaklama' && t.type !== 'ucak' ? wxHourOf(loc.lat, loc.lon, day, t.time) : null;
  const wet = w.kind === 'fc' && wxWet(hr ? hr.code : w.code, hr ? hr.prob : w.prob);
  const temp = w.kind === 'norm' ? `${r0(w.max)}°/${r0(w.min)}° ort.` : hr ? `${r0(hr.temp)}°` : `${r0(w.max)}°/${r0(w.min)}°`;
  box.innerHTML = `${I(w.kind === 'fc' ? wxIcon(hr ? hr.code : w.code) : 'temperature')}<b>${temp}</b>${loc.city ? `<small>${esc(loc.city)}</small>` : ''}`;
  box.title = w.kind === 'fc' ? wxLabel(hr ? hr.code : w.code) : TX('son 3 yılın ortalaması');
  if (wet) box.insertAdjacentHTML('afterend', TL`<span class="vch umbch">${I('umbrella')}<b>Şemsiye al</b></span>`);
}
/* kartlar: tarih satırının sonunda küçük hava bilgisi */
async function fillCardWx(root) {
  if (S.wx === false) return;
  fillDayWx(root);
  const els = $$('.cwx[data-wx]:not([data-done])', root || document); if (!els.length) return;
  const groups = new Map(), today = todayStr();
  for (const el of els) {
    el.dataset.done = '1';
    const t = S.tickets.find(x => x.id === el.dataset.wx); if (!t || !t.date) continue;
    const loc = wxLocFor(t); if (!loc) continue;
    const day = t.date < today ? today : t.date, k = wxKey(loc.lat, loc.lon);
    if (!groups.has(k)) groups.set(k, { loc, items: [] });
    groups.get(k).items.push({ el, t, day });
  }
  for (const g of groups.values()) {
    const W = await wxDays(g.loc.lat, g.loc.lon, [...new Set(g.items.map(x => x.day))]);
    for (const { el, t, day } of g.items) {
      const w = W[day]; if (!w || !el.isConnected) continue;
      const pre = el.classList.contains('solo') ? '' : ' · ';
      if (w.kind === 'norm') { el.innerHTML = `${pre}${I('temperature')}${r0(w.max)}° <i>ort.</i>`; continue; }
      const hr = t.type !== 'konaklama' && t.type !== 'ucak' ? wxHourOf(g.loc.lat, g.loc.lon, day, t.time) : null;
      const code = hr ? hr.code : w.code, prob = hr ? hr.prob : w.prob, temp = hr ? hr.temp : w.max;
      el.innerHTML = `${pre}${I(wxIcon(code))}${r0(temp)}°${prob != null && prob >= 30 ? ` ${pct(prob)}` : ''}`;
      el.title = wxLabel(code);
    }
  }
}
async function fillDayWx(root) {
  for (const el of $$('.dwx[data-wx]:not([data-done])', root || document)) {
    el.dataset.done = '1';
    const t = S.tickets.find(x => x.id === el.dataset.wx), day = el.dataset.day; if (!t) continue;
    const loc = wxLocFor(t, day); if (!loc) continue;
    const w = (await wxDays(loc.lat, loc.lon, [day]))[day]; if (!w || !el.isConnected) continue;
    if (w.kind === 'norm') { el.innerHTML = `${I('temperature')}${r0(w.max)}°/${r0(w.min)}° <i>ort.</i>`; el.title = TX('son 3 yılın ortalaması'); continue; }
    el.innerHTML = `${I(wxIcon(w.code))}${r0(w.max)}°/${r0(w.min)}°${w.prob != null && w.prob >= 30 ? ` <i>${pct(w.prob)}</i>` : ''}`;
    el.title = wxLabel(w.code) + (loc.city ? ' · ' + loc.city : '');
  }
}
/* bildirim için: yerel tarih/saat ve yedek metin (son kayıtlı tahminden) */
function wxNotifFields(t) {
  if (S.wx === false) return {};
  const loc = wxLocFor(t); if (!loc || !t.date) return {};
  const o = { wlat: +(+loc.lat).toFixed(4), wlon: +(+loc.lon).toFixed(4), wdate: t.date, whour: t.type !== 'ucak' && t.type !== 'konaklama' && t.time ? +t.time.slice(0, 2) : -1 };
  const c = WXMEM['wx:' + wxKey(loc.lat, loc.lon)];
  if (c && c.d) {
    const hr = o.whour >= 0 ? wxHourOf(loc.lat, loc.lon, t.date, t.time) : null, i = c.d.time.indexOf(t.date);
    if (hr) o.wfb = `${r0(hr.temp)}° ${wxLabel(hr.code)}${hr.prob != null ? TL`, ${pct(hr.prob)} yağış` : ''}${wxWet(hr.code, hr.prob) ? TX(' · şemsiye al') : ''}`;
    else if (i >= 0 && c.d.temperature_2m_max[i] != null) { const cd = c.d.weather_code[i], pr = c.d.precipitation_probability_max ? c.d.precipitation_probability_max[i] : null; o.wfb = `${r0(c.d.temperature_2m_max[i])}°/${r0(c.d.temperature_2m_min[i])}° ${wxLabel(cd)}${pr != null ? TL`, ${pct(pr)} yağış` : ''}${wxWet(cd, pr) ? TX(' · şemsiye al') : ''}`; }
  }
  return o;
}
/* bildirimler kurulmadan önce yaklaşan biletlerin tahminini önbelleğe al */
async function wxPrefetch() {
  if (S.wx === false) return;
  const lim = addDays(todayStr(), 15), seen = new Set();
  for (const t of S.tickets) {
    if (!t.date || t.date < todayStr() || t.date > lim) continue;
    const l = wxLocFor(t); if (!l) continue; const k = wxKey(l.lat, l.lon); if (seen.has(k)) continue; seen.add(k);
    await wxForecast(l.lat, l.lon);
  }
}

/* ---------- geri tuşu ---------- */
window.onBack = function () {
  if (dlgClose) { dlgClose(); return; }
  const mk = $('.modal-kp'); if (mk) { mk.querySelector('[data-k="close"]')?.click(); return; }
  if (!S.unlocked || busyEl) { if (!S.unlocked) A && A.exit(); return; }
  if (S.view === 'edit') { cancelEdit(); return; }
  if (S.view === 'multi') { cancelMulti(); return; }
  if ($('.sheet')) { $('.sheet').closest('.ov').click(); return; }
  if (S.view === 'home' && S.sel) { S.sel = null; render(); return; }
  if (S.view === 'view' || S.view === 'settings' || S.view === 'stats' || S.view === 'pack' || S.view === 'cinfo' || S.view === 'phr' || S.view === 'exp' || S.view === 'shop') { go('home', 'back'); return; }
  if (S.view === 'trip') { S.retTrip = null; go('home', 'back'); return; }
  if (S.view === 'world') { if (S.wDrawer) { S.wDrawer = false; const d = $('#wdr'); if (d) d.classList.remove('open'); return; } go(S.worldRet && S.worldRet !== 'world' ? S.worldRet : 'home', 'back'); return; }
  if (S.view === 'docs') { if (S.docPid) { S.docPid = null; render(); } else go('home', 'back'); return; }
  if (S.tab !== START_TAB) { S.tab = START_TAB; S.anim = 'back'; render(); window.scrollTo(0, 0); return; }
  if (S.q || S.filter !== 'all' || S.trip || S.tkind) { S.q = ''; S.filter = 'all'; S.trip = ''; S.tkind = ''; render(); return; }
  A && A.exit();
};

/* ================= web: çevrimdışı çalışma (service worker) ================= */
/* web sürümü: yeni sürüm arka planda iner; uygulama öne geldikçe kontrol edilir, inince kendini yeniler */
function reloadForUpdate() {
  if (S.view === 'edit' || S.view === 'multi' || document.querySelector('.ov, .busy')) { S.pendingReload = true; return; }
  lsSet('justUpdated', true); if (S.unlocked) lsSet('lastActive', Date.now());
  location.reload();
}
if (!A && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadCtl = !!navigator.serviceWorker.controller; let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadCtl || reloading) return; reloading = true; reloadForUpdate(); });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const check = () => { try { reg.update(); } catch (e) {} };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); else if (S.pendingReload && S.view !== 'edit' && S.view !== 'multi') { S.pendingReload = false; lsSet('justUpdated', true); location.reload(); } });
    window.addEventListener('focus', check);
    setInterval(check, 30 * 60000);
  }).catch(() => {});
  if (lsGet('justUpdated', false)) { lsSet('justUpdated', false); setTimeout(() => toast(TX('Yeni sürüm yüklendi'), 2600), 1200); }
}
/* ================= başlat ================= */
(async function init() {
  try {
    if (!window.indexedDB || !window.crypto || !crypto.subtle) throw new Error(TX('Bu cihaz desteklenmiyor'));
    const hash = await metaGet('pinHash');
    try { S.bioAvail = !!(A && A.bioAvailable && A.bioAvailable()); } catch (e) { S.bioAvail = false; }
    S.bio = S.bioAvail && !!(await metaGet('bio'));
    if (A) { try { if (A.hasShared()) S.pendingShare = true; } catch (e) {} try { if (A.hasSharedText && A.hasSharedText()) S.pendingText = true; } catch (e) {} }
    try { A && A.setLang && A.setLang(LANG); } catch (e) {}
    if (!hash) { if (!LANG_SET || lsGet('dgWiz', null)) await regionWizard(); showSetup(); }
    else {
      // 5.13 öncesi kurulum: Türkçe / Türkiye olarak sabitle
      if (!LANG_SET) { lsSet('dgLang', 'tr'); if (lsGet('dgHome', null) == null) lsSet('dgHome', 'TR'); if (LANG !== 'tr') { location.reload(); return; } }
      // seçilen kilit süresi uygulama yeniden başlatıldığında da geçerli: süre dolmadıysa PIN sorma
      const ld = (await metaGet('lockDelay')) ?? 60000, last = lsGet('lastActive', 0);
      preload();
      if (ld === -1 || (ld > 0 && last && Date.now() - last < ld && Date.now() >= last)) { S.lockDelay = ld; await unlock(); }
      else showLock();
    }
  } catch (e) {
    document.body.innerHTML = TL`<div class="empty"><h3>Uygulama başlatılamadı</h3><p>${esc(e.message || e)}</p></div>`;
  }
})();
