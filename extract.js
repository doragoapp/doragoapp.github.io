'use strict';
/* DoraGo — biletten bilgi çıkarma (PDF metni + biniş kartı barkodu) */

let TRAVEL = null, _travelP = null;
function loadTravel() {
  if (!_travelP) _travelP = fetch('travel.json').then(r => r.json()).then(d => (TRAVEL = cityLang(d))).catch(() => (TRAVEL = { ap: {}, al: {} }));
  return _travelP;
}
/* 5.13: travel.json'daki Türkçe şehir adları; diğer dillerde uluslararası adlar */
const CITY_EN = { 'Londra': 'London', 'Roma': 'Rome', 'Münih': 'Munich', 'Atina': 'Athens', 'Viyana': 'Vienna', 'Brüksel': 'Brussels', 'Cenevre': 'Geneva', 'Zürih': 'Zurich', 'Kopenhag': 'Copenhagen', 'Lizbon': 'Lisbon', 'Varşova': 'Warsaw', 'Prag': 'Prague', 'Moskova': 'Moscow', 'Venedik': 'Venice', 'Milano': 'Milan', 'Napoli': 'Naples', 'Floransa': 'Florence', 'Köln': 'Cologne', 'Lefkoşa': 'Nicosia', 'Selanik': 'Thessaloniki', 'Bükreş': 'Bucharest', 'Belgrad': 'Belgrade', 'Üsküp': 'Skopje', 'Saraybosna': 'Sarajevo', 'Tiflis': 'Tbilisi', 'Bakü': 'Baku', 'Kahire': 'Cairo', 'Şam': 'Damascus', 'Bağdat': 'Baghdad', 'Tahran': 'Tehran', 'Kudüs': 'Jerusalem', 'Mekke': 'Mecca', 'Cidde': 'Jeddah', 'Riyad': 'Riyadh', 'Pekin': 'Beijing', 'Seul': 'Seoul', 'Yeni Delhi': 'New Delhi', 'Singapur': 'Singapore', 'Cakarta': 'Jakarta', 'Sidney': 'Sydney', 'Stokholm': 'Stockholm', 'Lahey': 'The Hague', 'Lüksemburg': 'Luxembourg', 'Strazburg': 'Strasbourg', 'Marsilya': 'Marseille', 'Barselona': 'Barcelona', 'Valensiya': 'Valencia', 'Edinburg': 'Edinburgh', 'Budapeşte': 'Budapest', 'Sofya': 'Sofia', 'Kişinev': 'Chisinau', 'Taşkent': 'Tashkent', 'Semerkant': 'Samarkand', 'Almatı': 'Almaty', 'Bişkek': 'Bishkek', 'Aşkabat': 'Ashgabat', 'Duşanbe': 'Dushanbe', 'Erivan': 'Yerevan', 'Beyrut': 'Beirut', 'Tunus': 'Tunis', 'Cezayir': 'Algiers', 'Trablus': 'Tripoli', 'Kazablanka': 'Casablanca', 'Marakeş': 'Marrakesh', 'Bordo': 'Bordeaux', 'Tuluz': 'Toulouse', 'Torino': 'Turin', 'Cenova': 'Genoa', 'Bolonya': 'Bologna', 'Krakov': 'Krakow', 'Daşoguz': 'Dashoguz', 'Turkıstan': 'Turkistan', 'Nürnberg': 'Nuremberg', 'Hamburg': 'Hamburg', 'Lahor': 'Lahore', 'Halep': 'Aleppo', 'Kandahar': 'Kandahar', 'Kabil': 'Kabul', 'Bağdad': 'Baghdad', 'Kuveyt': 'Kuwait City', 'Maskat': 'Muscat', 'Hong Kong': 'Hong Kong', 'Brezilya': 'Brazil' };
function cityLang(d) {
  const L = (typeof window !== 'undefined' && window.LANG) || 'tr';
  if (L !== 'tr' && d && d.ap) for (const k in d.ap) { const v = d.ap[k], c = v[0]; if (!c) continue; if (CITY_EN[c]) v[0] = CITY_EN[c]; else if (/^İ/.test(c)) v[0] = 'I' + c.slice(1); }
  return d;
}
const apCity = c => (TRAVEL && TRAVEL.ap[c] ? TRAVEL.ap[c][0] : '');
const apName = c => (TRAVEL && TRAVEL.ap[c] ? TRAVEL.ap[c][1] : '');
const alName = c => (TRAVEL && TRAVEL.al[c] ? TRAVEL.al[c] : '');
function alFind(text) {
  if (!TRAVEL || !text) return '';
  const t = lowerSmart(text).trim();
  if (/^[a-z0-9]{2}$/i.test(text.trim()) && TRAVEL.al[text.trim().toUpperCase()]) return text.trim().toUpperCase();
  const ALIAS = { 'thy': 'TK', 'turkish airlines': 'TK', 'türk hava yolları': 'TK', 'turk hava yollari': 'TK', 'anadolujet': 'VF', 'ajet': 'VF', 'pegasus': 'PC', 'sunexpress': 'XQ', 'corendon': 'XC', 'lufthansa': 'LH', 'ryanair': 'FR', 'wizz': 'W6', 'easyjet': 'U2', 'emirates': 'EK', 'qatar': 'QR', 'klm': 'KL', 'air france': 'AF', 'british airways': 'BA', 'ita airways': 'AZ', 'alitalia': 'AZ', 'swiss': 'LX', 'austrian': 'OS', 'aegean': 'A3', 'vueling': 'VY', 'iberia': 'IB', 'eurowings': 'EW', 'flydubai': 'FZ', 'azerbaijan airlines': 'J2' };
  for (const [k, v] of Object.entries(ALIAS)) if (t.includes(k)) return v;
  for (const [code, name] of Object.entries(TRAVEL.al)) if (name.length >= 5 && t === lowerSmart(name)) return code;
  return '';
}

/* ---------- barkod (QR / Aztec / PDF417) ---------- */
let _zxP = null;
function loadZXing() {
  if (!_zxP) _zxP = new Promise((res, rej) => {
    if (window.ZXing) return res(window.ZXing);
    const s = document.createElement('script'); s.src = 'zxing.min.js';
    s.onload = () => res(window.ZXing); s.onerror = rej; document.head.appendChild(s);
  });
  return _zxP;
}
async function readBarcodes(blob) {
  const out = [];
  try {
    const Z = await loadZXing();
    const bmp = await createImageBitmap(blob);
    for (const max of [1600, 1000, 2400]) {
      const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data, lum = new Uint8ClampedArray(w * h);
      for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.AZTEC, Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.DATA_MATRIX]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      const r = new Z.MultiFormatReader(); r.setHints(hints);
      try {
        const res = r.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, w, h))));
        if (res && res.getText()) { out.push(res.getText()); break; }
      } catch (e) { /* bu ölçekte bulunamadı */ }
      if (s === 1 && max >= Math.max(bmp.width, bmp.height)) break;
    }
    bmp.close && bmp.close();
  } catch (e) { console.warn('barkod', e); }
  return out;
}

/* IATA biniş kartı (BCBP) */
function julianToDate(jd) {
  if (!(jd >= 1 && jd <= 366)) return '';
  const now = new Date(); now.setHours(0, 0, 0, 0);
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(y, 0, jd), diff = (d - now) / 86400000;
    if (diff >= -45 && diff <= 320) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return '';
}
function bcbpLeg(x) {
  // x: PNR(7) from(3) to(3) carrier(3) flight(5) julian(3) class(1) seat(4) seq(5) status(1) varSize(2)
  const from = x.slice(7, 10), to = x.slice(10, 13);
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return null;
  const car = x.slice(13, 16).trim(), fno = x.slice(16, 21).trim().replace(/^0+/, '');
  const seat = x.slice(25, 29).trim().replace(/^0+/, '');
  return { from, to, airline: car, flightNo: car + fno, seat: /^\d{1,3}[A-Z]$/.test(seat) ? seat : '', ref: x.slice(0, 7).trim(), date: julianToDate(parseInt(x.slice(21, 24), 10)) };
}
/* IATA biniş kartı (BCBP), birden fazla bacak destekli */
function parseBCBP(s) {
  if (!s || !/^M[1-9]/.test(s) || s.length < 58) return null;
  const n = +s[1], legs = [];
  const first = bcbpLeg(s.slice(23, 60)); if (!first) return null;
  legs.push(first);
  let pos = 60 + (parseInt(s.slice(58, 60), 16) || 0);
  for (let k = 1; k < n && pos + 37 <= s.length; k++) {
    const leg = bcbpLeg(s.slice(pos, pos + 37)); if (!leg) break;
    legs.push(leg); pos += 37 + (parseInt(s.slice(pos + 35, pos + 37), 16) || 0);
  }
  return { ...first, legs, name: s.slice(2, 22).trim() };
}

/* ---------- konum ---------- */
// "N 051° 30.789, W 00° 10.675" (derece-dakika), DMS ya da ondalık
function parseGPS(t) {
  if (!t) return null;
  let m = /([NS])\s*0*(\d{1,2})\s*°\s*(\d{1,2}(?:[.,]\d+)?)\s*['′]?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*["″])?[\s,;]*([EWDB])\s*0*(\d{1,3})\s*°\s*(\d{1,2}(?:[.,]\d+)?)\s*['′]?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*["″])?/i.exec(t);
  if (m) {
    const f = v => parseFloat(String(v || 0).replace(',', '.'));
    let lat = +m[2] + f(m[3]) / 60 + f(m[4]) / 3600, lon = +m[6] + f(m[7]) / 60 + f(m[8]) / 3600;
    if (/s/i.test(m[1])) lat = -lat; if (/[wb]/i.test(m[5])) lon = -lon;
    return valid(lat, lon);
  }
  m = /(?:gps|koordinat|coordinates?|konum|location)[^\d-]{0,25}(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/i.exec(t);
  if (m) return valid(+m[1], +m[2]);
  return null;
}
function valid(lat, lon) { return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? { lat: +lat.toFixed(6), lon: +lon.toFixed(6) } : null; }
/* Google Haritalar / Apple / OSM bağlantısı ya da düz koordinat */
function parseMapLink(u) {
  if (!u) return null;
  u = u.trim();
  let m = /^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/.exec(u); if (m) return valid(+m[1], +m[2]);
  try { u = decodeURIComponent(u); } catch (e) {}
  m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(u); if (m) return valid(+m[1], +m[2]);
  m = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(u); if (m) return valid(+m[1], +m[2]);
  m = /[?&](?:q|ll|query|destination|daddr|center|sll)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(u); if (m) return valid(+m[1], +m[2]);
  m = /geo:(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(u); if (m && !(+m[1] === 0 && +m[2] === 0)) return valid(+m[1], +m[2]);
  m = /[#&]map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/.exec(u); if (m) return valid(+m[1], +m[2]);
  return parseGPS(u);
}
const isShortMapLink = u => /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i.test((u || '').trim());

/* ---------- metinden bilgi ---------- */
// Türkçe harf içeren kelimeler Türkçe kurallarla, diğerleri İngilizce kurallarla küçültülür
// ("BOOKING" → "booking", "KALKIŞ" → "kalkış"); uzunluk korunur
const lowerSmart = t => (t || '').replace(/[^\s]+/g, w => /[çğöşüÇĞÖŞÜıİ]/.test(w) ? w.toLocaleLowerCase('tr') : w.toLowerCase());
// pdf.js bazı PDF'lerde Türkçe harfleri ayrı parça verir: "Birle ş ik", "CHECK- İ N"
function normText(t) {
  return (t || '').normalize('NFKC').replace(/\u00a0/g, ' ')
    .replace(/(\S) ([çğıöşüÇĞİÖŞÜ]) (?=\p{L})/gu, '$1$2')
    .replace(/(^|\s)([çğıöşüÇĞİÖŞÜ]) (?=\p{L})/gmu, '$1$2')
    .replace(/(\p{L}) ([çğıöşüÇĞİÖŞÜ])(?=[\s.,:;)]|$)/gmu, '$1$2')
    .replace(/[ \t]+\n/g, '\n');
}
const MONTHS = { oca: 1, jan: 1, şub: 2, sub: 2, feb: 2, mar: 3, nis: 4, apr: 4, may: 5, haz: 6, jun: 6, tem: 7, jul: 7, ağu: 8, agu: 8, aug: 8, eyl: 9, sep: 9, eki: 10, oct: 10, kas: 11, nov: 11, ara: 12, dec: 12 };
function findDates(s) {
  const out = []; let m;
  const push = (y, mo, d, at) => { y = +y; if (y < 100) y += 2000; mo = +mo; d = +d; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2040) out.push({ v: `${y}-${pad(mo)}-${pad(d)}`, at }); };
  const r1 = /\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/g; while ((m = r1.exec(s))) push(m[3], m[2], m[1], m.index);
  const r2 = /\b(20\d{2})-(\d{2})-(\d{2})\b/g; while ((m = r2.exec(s))) push(m[1], m[2], m[3], m.index);
  const r3 = /\b(\d{1,2})\s*(oca|şub|sub|mar|nis|may|haz|tem|ağu|agu|eyl|eki|kas|ara|jan|feb|apr|jun|jul|aug|sep|oct|nov|dec)[a-zçğıöşü]*\.?,?\s*'?(20\d{2}|\d{2})?\b/g;
  while ((m = r3.exec(s))) {
    let y = m[3];
    if (!y) { const now = new Date(), cand = new Date(now.getFullYear(), MONTHS[m[2]] - 1, +m[1]); y = (now - cand) / 86400000 > 30 ? now.getFullYear() + 1 : now.getFullYear(); }
    push(y, MONTHS[m[2]], m[1], m.index);
  }
  const r4 = /\b(oca|şub|mar|nis|may|haz|tem|ağu|eyl|eki|kas|ara|jan|feb|apr|jun|jul|aug|sep|oct|nov|dec)[a-zçğıöşü]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g;
  while ((m = r4.exec(s))) push(m[3], MONTHS[m[1]], m[2], m.index);
  return out.sort((a, b) => a.at - b.at);
}
const TIME_RE = /(?<![\d.\/])\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?![.\/]\d)/;
const g = re => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
/* last=true: "00:00 - 11:00" gibi aralıkta sondakini al (çıkış için) */
function timeAfter(s, re, span = 40, last = false) {
  let m; const R = g(re);
  while ((m = R.exec(s))) {
    const seg = s.slice(m.index, m.index + m[0].length + span);
    const rng = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(seg);
    if (rng && last) return `${pad(rng[3])}:${rng[4]}`;
    const t = TIME_RE.exec(seg);
    if (t) return `${pad(t[1])}:${t[2]}`;
  }
  return '';
}
function dateAfter(dates, s, re, span = 60) {
  let m; const R = g(re);
  while ((m = R.exec(s))) {
    const d = dates.find(x => x.at >= m.index && x.at <= m.index + m[0].length + span);
    if (d) return d.v;
  }
  return '';
}
/* PDF metninde birden fazla uçuş (gidiş-dönüş, aktarmalı, çok yolculu tekrarlar) */
function findLegs(raw, s, dates) {
  const marks = []; let m;
  const pair = /\b([A-Z]{3})\s*(?:-|–|—|→|->|>|\/|to)\s*([A-Z]{3})\b/g;
  const pairs = [];
  while ((m = pair.exec(raw))) if (TRAVEL.ap[m[1]] && TRAVEL.ap[m[2]] && m[1] !== m[2]) pairs.push({ from: m[1], to: m[2], at: m.index, end: m.index + m[0].length });
  const par = /\(\s*([A-Z]{3})\s*\)/g;
  while ((m = par.exec(raw))) if (TRAVEL.ap[m[1]]) marks.push({ c: m[1], at: m.index });
  let legs = [];
  if (marks.length >= 4) for (let i = 0; i + 1 < marks.length; i += 2) { if (marks[i].c !== marks[i + 1].c) legs.push({ from: marks[i].c, to: marks[i + 1].c, at: marks[i].at, mid: marks[i + 1].at }); else i--; }
  else if (pairs.length >= 2) legs = pairs.map(p => ({ from: p.from, to: p.to, at: p.at, mid: p.end }));
  if (legs.length < 2) return [];
  // metin konumları s (küçük harf) ile aynı: name + '\n' öneki kadar kaydır
  const shift = s.length - raw.length;
  const fr = /\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{2,4})\b/g, fls = [];
  while ((m = fr.exec(raw))) if (TRAVEL.al[m[1]]) fls.push({ v: m[1] + m[2], al: m[1], at: m.index });
  const out = [];
  legs.forEach((l, i) => {
    const endAt = i + 1 < legs.length ? legs[i + 1].at : raw.length;
    const d = dates.find(x => x.at - shift >= l.at && x.at - shift < endAt);
    let time = '';
    if (d) { const t = TIME_RE.exec(s.slice(d.at, d.at + 30)); if (t) time = `${pad(t[1])}:${t[2]}`; }
    const f = fls.find(x => x.at >= l.at && x.at < endAt) || [...fls].reverse().find(x => x.at < l.at && (i === 0 || x.at > legs[i - 1].at));
    out.push({ from: l.from, to: l.to, date: d ? d.v : '', time, flightNo: f ? f.v : '', airline: f ? f.al : '', seat: '' });
  });
  const seen = new Set();
  return out.filter(l => { const k = l.from + l.to + l.date + l.flightNo; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.date + a.time) < (b.date + b.time) ? -1 : 1);
}

/* tablo düzeni: "Rezervasyon No | Bilet No" başlık satırı, değerler 1-2 satır aşağıda */
function tableValue(lines, labelRe, valRe) {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const cols = lines[i].trim().split(/\s{2,}/);
    const ci = Math.max(0, cols.findIndex(c => labelRe.test(c)));
    for (let k = i + 1; k <= i + 3 && k < lines.length; k++) {
      const vals = lines[k].trim().split(/\s{2,}/);
      if (vals.length >= 2 && valRe.test(vals[ci] || '')) return vals[ci];
      const hit = vals.find(v => valRe.test(v)); if (hit && vals.length >= 2) return hit;
    }
  }
  return '';
}
function pickLine(lines, re, max = 70) {
  for (const l of lines) { const t = l.trim(); if (t.length >= 3 && t.length <= max && re.test(t)) return t; }
  return '';
}
function afterLabel(s, re) {
  // değer olarak başka bir etiket ("Product Code:") gelirse atla
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); let m;
  while ((m = g.exec(s))) {
    let v = m[m.length - 1].trim().replace(/\s{2,}.*/, '');
    if (!v || /:\s*$/.test(v)) continue;
    // yan sütundaki bir sonraki etiketten ("London Eye Time: 15:30") öncesini al
    v = v.replace(/\s+(time|saat|date|tarih|travel date|visit date|ref(?:erence)?|bilet no|ticket(?: no| type)?|seat|koltuk|price|fiyat|total|name|ad soyad|option|code|kod|tickets|quantity|adet)\s*:.*$/i, '').trim();
    if (v) return v;
  }
  return '';
}

function detectType(s) {
  if (/booking\.com|airbnb|hostelworld|agoda|hotels\.com/.test(s)) return 'konaklama';
  if (/boarding|biniş kartı|binis karti|uçuş|ucus|flight|pnr|\bgate\s*[:#]?\s*[a-z]?\d|havayolu|airlines|pegasus|ajet|türk hava|turkish airlines|sunexpress|e-ticket receipt|itinerary/.test(s)) return 'ucak';
  if (/otel|hotel|konaklama|check-in date|giriş tarihi|booking\.com|airbnb|hostel|resort|check-out|çıkış tarihi|gece|night/.test(s)) return 'konaklama';
  if (/müze|muze|museum|müzekart|ören yeri|oren yeri|saray|palace|gallery|galeri|sergi|exhibition/.test(s)) return 'muze';
  if (/tcdd|yht|tren|train|otobüs|otobus|\bbus\b|sefer|metro|ferry|vapur|feribot|peron|platform/.test(s)) return 'ulasim';
  if (/konser|concert|etkinlik|event|tiyatro|theatre|theater|festival|maç|match|stadyum|stadium|biletix|passo|ticket|opera|sinema|cinema/.test(s)) return 'etkinlik';
  return 'diger';
}

/**
 * text: PDF metni (satır sonlarıyla), codes: okunan barkodlar, name: dosya adı
 * Döner: { type, title, date, time, endDate, endTime, from, to, airline, airlineName, flightNo, seat, gate, ref, place, filled:[alanlar] }
 */
/* "03:30 PM" → "15:30", "12:15 am" → "00:15" */
function ampm(t) {
  return String(t || '').replace(/\b(0?[1-9]|1[0-2])[:.]([0-5]\d)\s*([ap])\.?\s?m\b\.?/gi, (m, h, mi, ap) => {
    h = +h % 12; if (/p/i.test(ap)) h += 12; return `${String(h).padStart(2, '0')}:${mi}`;
  });
}
async function extractInfo(text, codes, name, links = []) {
  await loadTravel();
  text = ampm(text);
  // Gmail / e-posta çıktısının başlık satırları (gönderen, alıcı, gönderim saati) bilete ait değil
  const raw = normText(text).split('\n').filter(l => !(/<[^>\s]+@[^>\s]+>/.test(l) || /^\s*(alıcı|kime|to|cc|bcc|kimden|from)\s*:/i.test(l) || /^\s*\d+\s+(ileti|mesaj|messages?)\s*$/i.test(l))).join('\n');
  const s = lowerSmart((name || '') + '\n' + raw);
  const lines = raw.split(/\n+/);
  const r = { type: detectType(s) };
  const today = todayStr();

  // biniş kartı barkodu: en güvenilir kaynak
  const bc = codes.map(parseBCBP).find(Boolean);
  if (bc) {
    r.type = 'ucak'; Object.assign(r, { from: bc.from, to: bc.to, airline: bc.airline, flightNo: bc.flightNo, seat: bc.seat, ref: bc.ref }); if (bc.date) r.date = bc.date;
    if (bc.legs.length > 1) r.segments = bc.legs.map(l => ({ ...l, time: '', gate: '' }));
  }

  // ödeme / satın alma / düzenleme tarihlerini dışarıda bırak
  const NOT_EVENT = /(ödeme|odeme|payment|paid|booked on|booking date|rezervasyon tarihi|işlem tarihi|issue[d]?|düzenleme|purchase|satın alma|satin alma|sipariş tarihi|order date|fatura|invoice|doğum|birth)/g;
  const bad = []; { let m; while ((m = NOT_EVENT.exec(s))) bad.push(m.index); }
  const dates = findDates(s).filter(d => !bad.some(b => d.at > b && d.at - b < 45));
  const futureFirst = () => { const f = dates.map(d => d.v).filter(v => v >= today).sort(); return f[0] || dates.map(d => d.v).sort().pop() || ''; };

  if (r.type === 'ucak') {
    if (!r.from || !r.to) {
      const codesFound = []; let m;
      const pair = /\b([A-Z]{3})\s*(?:-|–|—|→|->|>|\/|to)\s*([A-Z]{3})\b/g;
      while ((m = pair.exec(raw))) if (TRAVEL.ap[m[1]] && TRAVEL.ap[m[2]] && m[1] !== m[2]) { codesFound.push(m[1], m[2]); break; }
      if (!codesFound.length) {
        const par = /\(\s*([A-Z]{3})\s*\)/g;
        while ((m = par.exec(raw))) if (TRAVEL.ap[m[1]] && !codesFound.includes(m[1])) codesFound.push(m[1]);
      }
      if (codesFound.length >= 2) { r.from = r.from || codesFound[0]; r.to = r.to || codesFound[1]; }
    }
    if (!r.flightNo) {
      const fr = /\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{2,4})\b/g; let m, best = null;
      while ((m = fr.exec(raw))) {
        if (!TRAVEL.al[m[1]]) continue;
        const near = /flight|uçuş|ucus|sefer|flt/i.test(raw.slice(Math.max(0, m.index - 25), m.index));
        if (!best || near) { best = m; if (near) break; }
      }
      if (best) { r.flightNo = best[1] + best[2]; r.airline = r.airline || best[1]; }
    }
    if (!r.airline) r.airline = alFind(s.match(/turkish airlines|türk hava yolları|anadolujet|ajet|pegasus|sunexpress|corendon|lufthansa|ryanair|wizz|easyjet|emirates|qatar|klm|air france|british airways|ita airways|swiss|austrian|aegean|vueling|iberia|eurowings|flydubai/)?.[0] || '');
    if (!r.date) r.date = dateAfter(dates, s, /(departure date|departure time|kalkış tarihi|kalkış zamanı|kalkis tarihi|flight date|uçuş tarihi|ucus tarihi|gidiş tarihi|travel date|seyahat tarihi)/) || futureFirst();
    r.time = timeAfter(s, /(departure|kalkış saati|kalkış|kalkis|dep\.?|std|departs)/) || timeAfter(s, /(boarding|biniş|binis)/) || (TIME_RE.exec(s) ? (([, h, mm]) => `${pad(h)}:${mm}`)(TIME_RE.exec(s)) : '');
    if (!r.seat) { const m = /(seat|koltuk)\s*(no\.?|number)?\s*[:.]?\s*(\d{1,2}[a-k])\b/i.exec(s); if (m) r.seat = m[3].toUpperCase(); }
    if (!r.ref) r.ref = tableValue(lines, /(rezervasyon no|reservation no|booking ref|pnr)/i, /^(?=.*[A-Z])[A-Z0-9]{5,8}$/);
    { const m = /(gate|kapı|kapi)\s*(no\.?)?\s*[:.]?\s*([a-z]?\d{1,3}[a-z]?)\b/i.exec(s); if (m) r.gate = m[3].toUpperCase(); }
    if (!r.ref) { const m = /(pnr|booking ref(?:erence)?|booking (?:code|number)|reservation (?:code|number)|rezervasyon (?:kodu|numarası|numarasi|no)|confirmation (?:number|code)|onay kodu|bilet kodu)\s*(no\.?|kodu)?\s*[:#.]?\s*([a-z0-9]{5,8})\b/i.exec(s); if (m && /\d/.test(m[3]) || m && /^[a-z]{6}$/i.test(m[3])) r.ref = m[3].toUpperCase(); }
    r.airlineName = alName(r.airline) || '';
    if (r.from && r.to) r.title = `${apCity(r.from) || r.from} → ${apCity(r.to) || r.to}`;
    if (!r.segments) { const legs = findLegs(raw, s, dates); if (legs.length > 1) r.segments = legs.map(l => ({ ...l, ref: l.ref || r.ref, gate: '' })); }
    if (r.segments) {
      r.segments.forEach(l => { l.airlineName = alName(l.airline) || r.airlineName; l.title = `${apCity(l.from) || l.from} → ${apCity(l.to) || l.to}`; l.ref = l.ref || r.ref; });
      Object.assign(r, r.segments[0]);
    }
  } else if (r.type === 'konaklama') {
    const CI = /(check-?in|giriş tarihi|giriş|giris|arrival|varış)/, CO = /(check-?out|çıkış tarihi|çıkış|cikis|departure|ayrılış)/;
    let a = dateAfter(dates, s, CI), b = dateAfter(dates, s, CO);
    if (!a || !b || b <= a) {
      const uniq = [...new Set(dates.map(d => d.v))].sort();
      const fut = uniq.filter(v => v >= today);
      const cand = fut.length >= 2 ? fut : uniq;
      if (cand.length >= 2) { a = cand[0]; b = cand.find(v => v > a && (new Date(v) - new Date(a)) / 86400000 <= 60) || ''; }
      else a = a || cand[0] || '';
    }
    r.date = a; r.endDate = b && b > a ? b : '';
    r.time = timeAfter(s, CI, 70);
    r.endTime = timeAfter(s, CO, 70, true);
    if (r.time && r.time === r.endTime) r.endTime = '';
    // ad: adres satırının hemen üstündeki kısa satır; yoksa otel kelimesi geçen kısa başlık
    const ai = lines.findIndex(l => /^\s*(adres|address)\b/i.test(l));
    for (let k = ai - 1; k >= 0 && k >= ai - 3; k--) { const l = lines[k].trim(); if (l.length >= 3 && l.length <= 60 && !/[:@]/.test(l)) { r.title = l; break; } }
    if (!r.title) {
      const hn = lines.map(l => l.trim()).find(l => l.length >= 3 && l.length <= 50 && /\b(hotel|otel|resort|hostel|suites?|inn|apart|residence|pansiyon)\b/i.test(l) && !/[.:!?]$/.test(l) && l.split(/\s+/).length <= 6 && !/booking\.com|airbnb|check|tarih|date|wi-?fi|genelinde|mevcut/i.test(l));
      if (hn) r.title = hn.replace(/^(otel|hotel)\s*(adı|name)?\s*:\s*/i, '');
    }
    if (ai >= 0) {
      let addr = lines[ai].replace(/^\s*(adres|address)\s*:?\s*/i, '').trim();
      for (let k = ai + 1; k <= ai + 2 && k < lines.length; k++) { const l = lines[k].trim(); if (!l || l.length > 70 || /[:@]/.test(l) || /^(telefon|phone|tel|gps|e-?posta|e-?mail|fax|web)/i.test(l) || /(giriş|çıkış|check|tarih|date|gece|night|rezervasyon|booking|onay)/i.test(l)) break; addr += ' ' + l; }
      r.place = addr.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').slice(0, 140);
    }
    { const m = /(onay numarası|onay numarasi|onay no|rezervasyon (?:no|numarası|kodu)|booking (?:number|id|reference)|confirmation (?:number|code)|reservation (?:number|code))\s*[:#.]?\s*([a-z0-9][a-z0-9.\- ]{3,20}[a-z0-9])/i.exec(s); if (m) r.ref = m[2].replace(/[.\s]/g, '').toUpperCase(); }
    { const m = /\bpin(?: kodu| code)?\s*[:#]?\s*(\d{4,6})\b/i.exec(s); if (m) r.notes = `Rezervasyon PIN kodu: ${m[1]}`; }
    { const g = parseGPS(raw); if (g) { r.lat = g.lat; r.lon = g.lon; } }
  } else {
    r.date = futureFirst();
    const dAt = dates.find(x => x.v === r.date);
    if (dAt) {
      // tarihin hemen yanındaki saat; "14:00 - 15:00" ya da "14:00 - 20/11/2026 15:00" aralığı ise bitiş saati
      const seg = s.slice(dAt.at, dAt.at + 50), tm = TIME_RE.exec(seg.slice(0, 28));
      if (tm) {
        r.time = `${pad(tm[1])}:${tm[2]}`;
        const rg = /^\s*[-–—]\s*(?:\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(seg.slice(tm.index + tm[0].length));
        if (rg) r.endTime = `${pad(rg[1])}:${rg[2]}`;
      }
    }
    if (!r.time) r.time = timeAfter(s, /(saat|time|başlangıç|baslangic|start|kapı açılış|doors|seans|session)/, 25);
    if (!r.time) { const m = TIME_RE.exec(s.slice(dates.length ? dates[0].at : 0)) || TIME_RE.exec(s); r.time = m ? `${pad(m[1])}:${m[2]}` : ''; }
    r.place = afterLabel(raw, /(meeting point|meeting place|buluşma noktası|buluşma yeri|venue|mekan|mekân|salon|location|konum|yer|adres|address)\s*:\s*([^\n]{3,100})/i);
    if (!r.place && dAt) {
      // tarih satırının hemen altında "Mekân adı, Şehir" biçiminde satır
      const li = lines.findIndex(l => lowerSmart(l).includes(s.slice(dAt.at, dAt.at + 8)));
      for (let k = li + 1; li >= 0 && k <= li + 2 && k < lines.length; k++) {
        const l = lines[k].trim();
        if (/^[^\d£$€₺:@]{3,70},\s*[^\d£$€₺:@]{2,40}$/.test(l)) { r.place = l; break; }
      }
    }
    { const mm = /(seat|koltuk|sıra|row|blok|block|tribün)\s*(no\.?)?\s*[:.]?\s*([a-z0-9-]{1,8}(?:\s*(?:sıra|row|koltuk|seat)\s*[:.]?\s*[a-z0-9-]{1,6})*)/i.exec(raw); if (mm) r.seat = mm[3].trim(); }
    { const mm = /(bilet no|ticket (?:no|number|id)|sipariş no|order (?:no|number|id|reference)|rezervasyon (?:no|kodu|numarası)|booking\s+(?:ref(?:erence)?|no|number|id)|confirmation (?:no|number|code)|reference (?:no|number))\s*[:#.]?\s*([a-z0-9-]{4,20})\b/i.exec(s); if (mm && /\d/.test(mm[2])) r.ref = mm[2].toUpperCase(); }
    if (!r.ref) { // OCR: etiket ile kod arasına başka kelimeler girebilir; yakındaki harf+rakam kodu al
      const kw = /reference|referans|confirmation|onay kodu|rezervasyon kodu|booking/ig; let k;
      while (!r.ref && (k = kw.exec(raw))) { const mm = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])([A-Z0-9]{6,12})\b/.exec(raw.slice(k.index, k.index + 160)); if (mm) r.ref = mm[1]; }
    }
    if (/^gmail\s*-/i.test(name || '') && lines[0]) r.title = lines[0].trim().replace(/\s+\d{5,}$/, '').slice(0, 70);
    else { // e-posta ekran görüntüsü: konu satırı "N ileti" satırının hemen üstünde
      const all = normText(text).split('\n').map(l => l.trim()), k = all.findIndex(l => /^\d+\s+(ileti|mesaj|messages?)$/i.test(l));
      const subj = k > 0 ? all.slice(0, k).reverse().find(l => l.length > 3) : '';
      if (subj) r.title = subj.replace(/\s+\d{5,}$/, '').slice(0, 70);
    }
    const ev = afterLabel(raw, /(etkinlik(?: adı)?|event(?: name)?|konser|concert|oyun|gösteri|show|sergi|exhibition|e-?bilet|e-?ticket|film|maç|product|attraction|activity|tour(?: name)?|ürün|aktivite|tur)\s*:\s*([^\n]{3,60})/i);
    if (ev) r.title = ev;
  }
  if (r.type !== 'ucak' && r.type !== 'konaklama') { const g = parseGPS(raw); if (g) { r.lat = g.lat; r.lon = g.lon; } }
  // PDF içindeki tıklanabilir harita bağlantıları
  if (r.type !== 'ucak' && !r.lat) {
    for (const u of links) {
      const ll = parseMapLink(u);
      if (ll) { r.lat = ll.lat; r.lon = ll.lon; break; }
      if (!r.mapShort && isShortMapLink(u)) r.mapShort = u;
      const q = /(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.apple\.com)[^?#]*[?&](?:q|query|daddr|address)=([^&#]+)/i.exec(u);
      if (q && !r.place) { try { r.place = decodeURIComponent(q[1].replace(/\+/g, ' ')).slice(0, 140); } catch (e) {} }
    }
  }
  r.filled = Object.keys(r).filter(k => !['type', 'filled', 'airlineName', 'segments', 'lon', 'mapShort'].includes(k) && r[k]);
  return r;
}
