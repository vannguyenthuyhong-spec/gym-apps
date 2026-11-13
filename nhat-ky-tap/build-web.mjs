// Builds the static site for Vercel from nhat-ky-tap.html (the same page also publishes as a claude.ai artifact).
// Usage: node build-web.mjs  ->  writes ./web/{index.html, manifest.webmanifest, icon.svg, sw.js, vercel.json}
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'web');
const page = await readFile(join(here, 'nhat-ky-tap.html'), 'utf8');

const head = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#A8203E">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Nhật ký tập">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="./icon.svg">
<style>
:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}
</style>
</head>
<body>
`;
const tail = `
<script>
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
</script>
</body>
</html>
`;

const manifest = {
  name: 'Nhật Ký Tập Gym',
  short_name: 'Nhật ký tập',
  description: 'Tập theo giáo án người mới, tự tập lại bài PT đã dạy và ghi nhật ký tiến bộ',
  lang: 'vi',
  start_url: './#today',
  display: 'standalone',
  background_color: '#F5F1F2',
  theme_color: '#A8203E',
  icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
};

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#A8203E"/>
<rect x="96" y="176" width="44" height="160" rx="14" fill="#fff"/>
<rect x="372" y="176" width="44" height="160" rx="14" fill="#fff"/>
<rect x="148" y="206" width="30" height="100" rx="10" fill="#fff"/>
<rect x="334" y="206" width="30" height="100" rx="10" fill="#fff"/>
<rect x="178" y="242" width="156" height="28" rx="8" fill="#fff"/>
</svg>
`;

// Network-first for the page (always newest version when online), cache fallback when offline.
const sw = `const CACHE = 'nhat-ky-tap-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest', './icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match('./'))));
});
`;

const vercel = {
  cleanUrls: true,
  headers: [
    { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'same-origin' }] },
  ],
};

await mkdir(out, { recursive: true });
await writeFile(join(out, 'index.html'), head + page + tail);
await writeFile(join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
await writeFile(join(out, 'icon.svg'), icon);
await writeFile(join(out, 'sw.js'), sw);
await writeFile(join(out, 'vercel.json'), JSON.stringify(vercel, null, 2));
console.log('Built', out);
