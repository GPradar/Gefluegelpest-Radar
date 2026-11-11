/* Service Worker: Offline-Modus, tägliche Hintergrund-Prüfung, Benachrichtigungen */
const CACHE = 'gpr-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icon.svg', 'icon-192.png', 'manifest.webmanifest'];
const CTX_KEY = 'gpr-context'; // Einstellungen + bekannter Stand, von der App übergeben

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== CTX_KEY).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isData = url.pathname.endsWith('.json') || url.pathname.endsWith('.geojson') || url.origin !== location.origin;
  if (isData) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
  } else {
    // App-Dateien: Cache zuerst, im Hintergrund aktualisieren
    e.respondWith(caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((r) => { if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

/* ---- Kontext von der App speichern ---- */
async function getCtx() {
  const r = await (await caches.open(CTX_KEY)).match('ctx');
  return r ? r.json() : null;
}
async function setCtx(ctx) {
  await (await caches.open(CTX_KEY)).put('ctx', new Response(JSON.stringify(ctx), { headers: { 'content-type': 'application/json' } }));
}
self.addEventListener('message', (e) => {
  if (e.data?.type === 'context') e.waitUntil(setCtx(e.data.ctx));
});

/* ---- Tägliche Prüfung im Hintergrund (Android/Chrome, installierte App) ---- */
const DAY = 86400000;
const parse = (s) => s ? new Date(s + 'T00:00:00') : null;
function liftDate(o, estDays) { const a = parse(o.aufgehoben_am); if (a) return a; const d = parse(o.festgestellt_am); return d ? new Date(d.getTime() + estDays * DAY) : null; }
function km(a1, o1, a2, o2) { const r = Math.PI / 180, R = 6371; const x = Math.sin((a2 - a1) * r / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin((o2 - o1) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }

async function backgroundCheck() {
  const ctx = await getCtx();
  if (!ctx || !ctx.home || !ctx.notify) return;
  const res = await fetch('data/outbreaks.json', { cache: 'no-store' });
  if (!res.ok) return;
  const data = await res.json();
  (await caches.open(CACHE)).put('data/outbreaks.json', new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const now = {}; const events = [];
  for (const o of data.faelle || []) {
    const ags = String(o.ags).padStart(5, '0');
    const c = ctx.centroids[ags];
    const lat = o.lat ?? c?.[1], lon = o.lon ?? c?.[0];
    const own = ags === ctx.ags;
    if (!own && (lat == null || km(ctx.home[1], ctx.home[0], lat, lon) > ctx.radius)) continue;
    const ld = liftDate(o, ctx.estDays);
    const st = ld && ld <= today ? 'aufgehoben' : 'aktiv';
    now[o.id] = st;
    const name = ctx.names[ags] || ags;
    if (ctx.known && !(o.id in ctx.known) && st === 'aktiv') events.push({ t: `Neuer ${o.seuche === 'nd' ? 'Newcastle' : 'Geflügelpest'}-Fall in deinem Gebiet`, b: `${o.seuche === 'nd' ? 'Newcastle-Krankheit' : o.kategorie === 'wildvogel' ? 'Wildvogel' : 'Hausgeflügel'}, ${name}`, tag: o.id + 'new' });
    if (ctx.known?.[o.id] === 'aktiv' && st === 'aufgehoben') events.push({ t: 'Entwarnung: Sperrzone aufgehoben', b: `${name}${o.aufgehoben_am ? '' : ' (geschätzt)'}`, tag: o.id + 'lifted' });
  }
  ctx.known = now;
  await setCtx(ctx);
  for (const ev of events) await self.registration.showNotification(ev.t, { body: ev.b, icon: 'icon-192.png', badge: 'icon-192.png', tag: ev.tag });
}

self.addEventListener('periodicsync', (e) => { if (e.tag === 'gpr-daily') e.waitUntil(backgroundCheck()); });

// Push-Nachrichten vom Server (spätere Ausbaustufe)
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Geflügelpest-Radar', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Geflügelpest-Radar', { body: d.body, icon: 'icon-192.png', tag: d.tag }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => list[0]?.focus() || self.clients.openWindow('./#gebiet')));
});
