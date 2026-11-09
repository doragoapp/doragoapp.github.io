// DoraGo dil desteği. Kaynak metinler Türkçe; diğer diller sözlükle (window.I18N[lang]) çevrilir.
// TX('metin') düz metin/HTML, TL`şablon ${x}` şablon metni. Sözlükte olmayan parça olduğu gibi kalır.
(function () {
  const ls = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const sup = ['tr', 'en'];
  let lang = ls('dgLang');
  if (!sup.includes(lang)) lang = null; // henüz seçilmemiş → ilk açılışta karar verilir (app.js)
  const navLang = ((navigator.languages && navigator.languages[0]) || navigator.language || 'tr').toLowerCase();
  const guess = navLang.startsWith('tr') ? 'tr' : 'en';
  const L = lang || guess;
  window.LANGS = [{ id: 'tr', name: 'Türkçe' }, { id: 'en', name: 'English' }];
  window.LANG = L;
  window.LANG_SET = !!lang;
  window.NAV_LANG = navLang;
  window.LOC = L === 'tr' ? 'tr-TR' : (navLang.startsWith('en') ? navLang : 'en-GB');
  try { document.documentElement.lang = L; } catch (e) {}
  if (L !== 'tr') { try { document.write('<script src="lang-' + L + '.js"><\/script>'); } catch (e) {} }
  const D = () => (window.I18N && window.I18N[L]) || null;
  const PRE = /^[\s·•,:;()\[\]\-–—\/|+×*№#…]+/, SUF = /[\s·•,:;()\[\]\-–—\/|+×*…]+$/;
  const tr1 = (s, d) => {
    if (!s || !/\p{L}/u.test(s)) return s;
    if (d[s] != null) return d[s];
    const p = (s.match(PRE) || [''])[0], rest = s.slice(p.length), q = (rest.match(SUF) || [''])[0], core = rest.slice(0, rest.length - q.length);
    if (core && d[core] != null) return p + d[core] + q;
    return s;
  };
  const ATTR = new Set(['title', 'placeholder', 'aria-label', 'alt', 'data-hint']);
  // HTML'i tanıyarak çevir: etiket dışındaki metin parçaları + tırnaklı öznitelik değerleri
  function trPieces(pieces, d) {
    const out = []; let inTag = false, q = '', an = false;
    for (const s of pieces) {
      let o = '', buf = '';
      const flush = () => { if (buf) { o += tr1(buf, d); buf = ''; } };
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === q) { if (an) flush(); else { o += buf; buf = ''; } q = ''; o += c; } else buf += c; continue; }
        if (inTag) { if (c === '"' || c === "'") { q = c; const m = o.match(/([\w-]+)\s*=\s*$/); an = !!(m && ATTR.has(m[1].toLowerCase())); o += c; } else { if (c === '>') inTag = false; o += c; } continue; }
        if (c === '<' && /[a-zA-Z\/!]/.test(s[i + 1] || '')) { flush(); inTag = true; o += c; continue; }
        buf += c;
      }
      if (q && !an) { o += buf; buf = ''; } else flush();
      out.push(o);
    }
    return out;
  }
  window.I18N_PIECES = trPieces;
  // İngilizcede "1 days" → "1 day"
  const SG = { days: 'day', nights: 'night', hours: 'hour', tickets: 'ticket', trips: 'trip', flights: 'flight', countries: 'country', cities: 'city', people: 'person', items: 'item', photos: 'photo', months: 'month', years: 'year', reminders: 'reminder', minutes: 'minute', times: 'time', museums: 'museum', places: 'place', expenses: 'expense', visas: 'visa', pages: 'page', stamps: 'stamp' };
  const PL = new RegExp('(^|[^\\d.,])1 (' + Object.keys(SG).join('|') + ')\\b', 'g');
  const fixPl = s => (L === 'en' && s.indexOf('1 ') >= 0) ? s.replace(PL, (m, a, w) => a + '1 ' + SG[w]) : s;
  const cache = new Map(), tcache = new WeakMap();
  window.TX = s => {
    if (L === 'tr' || typeof s !== 'string') return s;
    const d = D(); if (!d) return s;
    let r = cache.get(s); if (r === undefined) { r = fixPl(trPieces([s], d)[0]); cache.set(s, r); }
    return r;
  };
  window.TL = (strs, ...vals) => {
    let st = strs;
    if (L !== 'tr') {
      const d = D();
      if (d) {
        st = tcache.get(strs);
        if (!st) {
          const k = strs.length > 1 ? strs.join('{}') : null;
          st = k && d[k] != null ? { full: d[k] } : trPieces(strs, d);
          tcache.set(strs, st);
        }
        if (st.full) return fixPl(st.full.replace(/\{(\d+)\}/g, (m, i) => vals[+i] == null ? '' : vals[+i]));
      }
    }
    let o = st[0]; for (let i = 0; i < vals.length; i++) o += vals[i] + st[i + 1];
    return L === 'en' ? fixPl(o) : o;
  };
  // index.html içindeki sabit metinler
  window.i18nDom = root => {
    if (L === 'tr') return; const d = D(); if (!d) return;
    const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    const ns = []; while (w.nextNode()) ns.push(w.currentNode);
    for (const n of ns) { if (n.parentNode && /^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) continue; const v = tr1(n.nodeValue, d); if (v !== n.nodeValue) n.nodeValue = v; }
    for (const el of (root || document.body).querySelectorAll('[placeholder],[title],[aria-label]')) for (const a of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute(a); if (v) { const t = tr1(v, d); if (t !== v) el.setAttribute(a, t); } }
  };
})();
