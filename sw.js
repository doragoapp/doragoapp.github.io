/* DoraGo web: çevrimdışı çalışma. Biletler bu dosyada değil, telefonun kendi deposunda (IndexedDB) durur. */
const VER = 'dorago-web-34';
const CORE = ['./', 'index.html', 'i18n.js', 'lang-en.js', 'app.js', 'extract.js', 'icons.js', 'logo.png', 'travel.json', 'pdf.min.mjs', 'pdf.worker.min.mjs', 'zxing.min.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
// OCR dosyaları büyük (~10 MB): kurulumdan sonra arka planda indirilir
const LATER = ['world.js', 'countries.js', 'visa.js', 'ocr/tesseract.min.js', 'ocr/worker.min.js', 'ocr/tesseract-core-simd-lstm.wasm.js', 'ocr/tesseract-core-lstm.wasm.js', 'ocr/lang/tur.traineddata.gz', 'ocr/lang/eng.traineddata.gz'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VER) await caches.delete(k);
    await self.clients.claim();
    const c = await caches.open(VER);
    for (const u of LATER) { try { if (!(await c.match(u))) await c.add(new Request(u, { cache: 'reload' })); } catch (er) {} }
  })());
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return; // hava durumu, harita vb. internetten
  e.respondWith((async () => {
    const c = await caches.open(VER);
    const hit = await c.match(r, { ignoreSearch: true });
    if (hit) return hit;
    try { const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return res; }
    catch (er) { return (r.mode === 'navigate' && await c.match('index.html')) || Response.error(); }
  })());
});
