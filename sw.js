
const C = 'fc-relma-v2';

// Lista de recursos que SIEMPRE se cachean al instalar
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@3.11.0/dist/email.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(C).then(c => c.addAll(PRECACHE).catch(err => console.warn('Precache parcial:', err)))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

// Red primero (con timeout), caché fallback. Supabase SIEMPRE por red.
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  if (url.hostname.endsWith('supabase.co')) return;

  // Timeout de 8s para evitar cuelgues en datos móviles lentos
  const fetchConTimeout = fetch(r, { signal: AbortSignal.timeout(8000) });

  e.respondWith(
    fetchConTimeout
      .then(res => {
        if (res.ok) {
          const cp = res.clone();
          caches.open(C).then(c => c.put(r, cp));
        }
        return res;
      })
      .catch(() => caches.match(r).then(hit => hit || caches.match('./index.html')))
  );
});
