/* Geflügelpest-Radar – App-Logik (ohne externe Bibliotheken) */
'use strict';

const CONFIG = {
  // Reihenfolge = Fallback-Kette. Am besten die Datei lokal in data/ ablegen (siehe README).
  geojsonUrls: [
    'data/kreise.geojson',
    'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-germany-kreis/exports/geojson?lang=de'
  ],
  outbreaksUrl: 'data/outbreaks.json',
  defaultRadiusKm: 30,
  recentlyLiftedDays: 30,
  refreshMinutes: 30,
  // Mindestdauer der Überwachungszone nach EU-VO 2020/687 (nur Schätzung, falls kein Aufhebungsdatum bekannt)
  estZoneDays: 30
};

const LAENDER = {
  '01': 'Schleswig-Holstein', '02': 'Hamburg', '03': 'Niedersachsen', '04': 'Bremen',
  '05': 'Nordrhein-Westfalen', '06': 'Hessen', '07': 'Rheinland-Pfalz', '08': 'Baden-Württemberg',
  '09': 'Bayern', '10': 'Saarland', '11': 'Berlin', '12': 'Brandenburg',
  '13': 'Mecklenburg-Vorpommern', '14': 'Sachsen', '15': 'Sachsen-Anhalt', '16': 'Thüringen'
};

const CHECKLIST = [
  'Betrieb/Haltung beim Veterinäramt und bei der Tierseuchenkasse angemeldet',
  'Futter, Einstreu und Tränkwasser für Wildvögel unzugänglich',
  'Bei Aufstallungspflicht: Tiere im Stall oder unter dichter Abdeckung mit Seitenbegrenzung',
  'Eigene Stallkleidung und -schuhe, die den Stall nicht verlassen',
  'Desinfektionsmatte bzw. Schuhdesinfektion am Stalleingang',
  'Besucher auf das Nötigste beschränken und dokumentieren',
  'Kein Kontakt zu fremdem Geflügel oder Wildvögeln vor dem Stallbesuch',
  'Schadnager und Wildtiere vom Stall fernhalten',
  'Tierverluste und Legeleistung täglich notieren',
  'Telefonnummer des Veterinäramts griffbereit'
];

const DAY = 86400000;
const $ = (s) => document.querySelector(s);

const store = {
  get(k, d) { try { const v = localStorage.getItem('gpr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gpr.' + k, JSON.stringify(v)); } catch { /* egal */ } }
};

const state = {
  kreise: [],           // {ags, name, land, polys:[[ring...]], bbox, centroid:[lon,lat]}
  byAgs: new Map(),
  outbreaks: [],
  meta: {},
  settings: Object.assign({ ags: '', lat: null, lon: null, radius: CONFIG.defaultRadiusKm, notify: false },
                          store.get('settings', {})),
  selected: null,
  filter: { g: true, w: true },
  view: { x: 0, y: 0, w: 1, h: 1 },
  home: null
};

/* ---------- Hilfsfunktionen ---------- */
const parseDate = (s) => s ? new Date(s + 'T00:00:00') : null;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const fmtDate = (d) => d ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isGefluegel = (o) => o.kategorie !== 'wildvogel';

function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, R = 6371;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Status eines Falls: 'aktiv' | 'aufgehoben' */
function estLift(o) {
  const d = parseDate(o.festgestellt_am);
  return d ? new Date(d.getTime() + CONFIG.estZoneDays * DAY) : null;
}
/** Amtliches Aufhebungsdatum oder – falls unbekannt – Schätzung */
const liftDate = (o) => parseDate(o.aufgehoben_am) || estLift(o);
function statusOf(o) {
  const lifted = liftDate(o);
  return lifted && lifted <= today() ? 'aufgehoben' : 'aktiv';
}

/* ---------- Geodaten ---------- */
function pickProp(props, keys) {
  for (const k of keys) {
    if (props[k] != null) { const v = Array.isArray(props[k]) ? props[k][0] : props[k]; if (v !== '') return String(v); }
  }
  return '';
}

function normalizeKreise(geo) {
  const out = [];
  for (const f of geo.features || []) {
    const p = f.properties || {};
    let ags = pickProp(p, ['ags', 'AGS', 'krs_code', 'RS', 'rs', 'ARS', 'id']).replace(/\D/g, '');
    if (ags.length > 5) ags = ags.slice(0, 5);
    if (ags.length === 4) ags = '0' + ags;
    if (ags.length !== 5) continue;
    const name = pickProp(p, ['name', 'krs_name_short', 'krs_name', 'GEN', 'NAME_3']);
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) continue;
    let minX = 180, minY = 90, maxX = -180, maxY = -90, sx = 0, sy = 0, n = 0;
    for (const poly of polys) for (const [x, y] of poly[0]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      sx += x; sy += y; n++;
    }
    const existing = out.find((k) => k.ags === ags); // manche Quellen teilen Kreise in mehrere Features
    if (existing) { existing.polys.push(...polys); continue; }
    out.push({ ags, name: name || ags, land: LAENDER[ags.slice(0, 2)] || '', polys,
               bbox: [minX, minY, maxX, maxY], centroid: [sx / n, sy / n] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return out;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function kreisAt(lon, lat) {
  return state.kreise.find((k) => lon >= k.bbox[0] && lon <= k.bbox[2] && lat >= k.bbox[1] && lat <= k.bbox[3] &&
    k.polys.some((poly) => pointInRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => pointInRing(lon, lat, h))));
}

/* ---------- Laden ---------- */
async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  return r.json();
}

const IS_FILE = location.protocol === 'file:';
async function loadGeo() {
  for (const url of CONFIG.geojsonUrls) {
    if (IS_FILE && !/^https?:/.test(url)) continue; // lokale Dateien sind per Doppelklick nicht ladbar
    try {
      const k = normalizeKreise(await fetchJson(url));
      if (k.length) return k;
    } catch (e) { console.warn('Geodaten nicht geladen:', e.message); }
  }
  return [];
}

async function loadOutbreaks() {
  const data = window.GPR_DATA || await fetchJson(CONFIG.outbreaksUrl);
  state.meta = data.meta || {};
  state.outbreaks = (data.faelle || []).filter((o) => o && o.ags).map((o) => ({ ...o, ags: String(o.ags).padStart(5, '0') }));
}

/* ---------- Gebiet & Warnungen ---------- */
function homePoint() {
  const s = state.settings;
  if (s.lat != null && s.lon != null) return [s.lon, s.lat];
  const k = state.byAgs.get(s.ags);
  return k ? k.centroid : null;
}

/** Fälle im Gebiet: eigener Kreis + Fälle, deren Kreis-Mittelpunkt (oder Koordinate) im Umkreis liegt */
function areaOutbreaks() {
  const s = state.settings, hp = homePoint();
  if (!hp) return [];
  return state.outbreaks.map((o) => {
    const k = state.byAgs.get(o.ags);
    const lat = o.lat ?? k?.centroid[1], lon = o.lon ?? k?.centroid[0];
    const dist = lat != null ? haversine(hp[1], hp[0], lat, lon) : Infinity;
    return { o, dist, own: o.ags === s.ags };
  }).filter((x) => x.own || x.dist <= s.radius)
    .sort((a, b) => (statusOf(a.o) === 'aktiv' ? 0 : 1) - (statusOf(b.o) === 'aktiv' ? 0 : 1) || a.dist - b.dist);
}

/** Vergleicht mit dem letzten bekannten Stand und meldet neue Fälle und Aufhebungen. */
function detectChanges() {
  if (!state.settings.ags) return [];
  const area = areaOutbreaks();
  const prev = store.get('known', null); // { id: 'aktiv'|'aufgehoben' }
  const now = {};
  const events = [];
  for (const { o, dist } of area) {
    const st = statusOf(o);
    now[o.id] = st;
    if (prev) {
      if (!(o.id in prev) && st === 'aktiv') events.push({ type: 'new', o, dist });
      if (prev[o.id] === 'aktiv' && st === 'aufgehoben') events.push({ type: 'lifted', o, dist });
    }
  }
  // Fall ist aus dem Gebiet verschwunden (z. B. Datensatz entfernt) → nicht melden, nur Stand aktualisieren
  store.set('known', now);
  return events;
}

function kreisName(ags) { return state.byAgs.get(ags)?.name || ags; }

function eventText(ev) {
  const art = isGefluegel(ev.o) ? 'Hausgeflügel' : 'Wildvogel';
  return ev.type === 'new'
    ? { title: 'Neuer Geflügelpest-Fall in deinem Gebiet', body: `${art}, ${kreisName(ev.o.ags)} (festgestellt ${fmtDate(parseDate(ev.o.festgestellt_am))})` }
    : { title: 'Entwarnung: Sperrzone aufgehoben', body: `${art}, ${kreisName(ev.o.ags)} – ${ev.o.aufgehoben_am ? 'aufgehoben am ' + fmtDate(parseDate(ev.o.aufgehoben_am)) : 'vermutlich seit ca. ' + fmtDate(estLift(ev.o)) + ' (Schätzung)'}` };
}

async function notify(events) {
  const box = $('#alerts');
  for (const ev of events) {
    const t = eventText(ev);
    const el = document.createElement('div');
    el.className = 'alert ' + (ev.type === 'new' ? 'new' : 'lifted');
    el.innerHTML = `<div><b>${esc(t.title)}</b><br>${esc(t.body)}</div><button type="button" aria-label="Schließen">✕</button>`;
    el.querySelector('button').onclick = () => el.remove();
    box.prepend(el);
    if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) reg.showNotification(t.title, { body: t.body, icon: 'icon.svg', tag: ev.o.id + ev.type });
        else new Notification(t.title, { body: t.body, icon: 'icon.svg' });
      } catch { /* Benachrichtigung nicht möglich – Banner reicht */ }
    }
  }
}

/* ---------- Rendering: Mein Gebiet ---------- */
function outbreakItem(o, extra = '') {
  const st = statusOf(o);
  const tag = st === 'aufgehoben' ? '<span class="tag l">aufgehoben</span>'
    : isGefluegel(o) ? '<span class="tag g">Hausgeflügel</span>' : '<span class="tag w">Wildvogel</span>';
  const lift = st === 'aufgehoben'
    ? (o.aufgehoben_am ? `Aufgehoben am ${fmtDate(parseDate(o.aufgehoben_am))}` : `Vermutlich abgelaufen seit ca. ${fmtDate(estLift(o))} (Schätzung – amtliche Aufhebung nicht bekannt)`)
    : o.aufgehoben_am ? `Aufhebung geplant: ${fmtDate(parseDate(o.aufgehoben_am))}`
    : `Aufhebung frühestens ca. ${fmtDate(estLift(o))} (Schätzung)`;
  const src = o.quelle ? ` · <a href="${esc(o.quelle)}" target="_blank" rel="noopener">Quelle</a>` : '';
  return `<div class="item">
    <div class="title">${tag}${esc(kreisName(o.ags))}${extra}</div>
    <div class="small">${esc(o.tierart || '')}${o.tierart ? ' · ' : ''}festgestellt ${fmtDate(parseDate(o.festgestellt_am))}${o.subtyp ? ' · ' + esc(o.subtyp) : ''}</div>
    <div class="small muted">${lift}${src}</div>${o.hinweis ? `<div class="small muted">ℹ️ ${esc(o.hinweis)}</div>` : ''}
  </div>`;
}

function renderArea() {
  const s = state.settings;
  const card = $('#areaStatus');
  const k = state.byAgs.get(s.ags);
  if (!k) {
    card.className = 'status-card';
    card.innerHTML = '<h1>Mein Gebiet</h1><p>Wähle unten deinen Landkreis oder nutze deinen Standort, um Warnungen zu erhalten.</p>';
    $('#areaList').innerHTML = '<p class="muted">Noch kein Landkreis gewählt.</p>';
    return;
  }
  const area = areaOutbreaks();
  const active = area.filter((x) => statusOf(x.o) === 'aktiv');
  const ownActive = active.filter((x) => x.own);
  const where = `${esc(k.name)} + ${s.radius} km Umkreis`;
  if (ownActive.length) {
    card.className = 'status-card alarm';
    card.innerHTML = `<h1>Achtung</h1><p class="big">${ownActive.length} aktive${ownActive.length === 1 ? 'r Fall' : ' Fälle'} in deinem Landkreis</p><p class="small">${where}. Beachte die Allgemeinverfügung deines Veterinäramts.</p>`;
  } else if (active.length) {
    card.className = 'status-card warn';
    card.innerHTML = `<h1>Erhöhte Wachsamkeit</h1><p class="big">${active.length} aktive${active.length === 1 ? 'r Fall' : ' Fälle'} im Umkreis</p><p class="small">${where}</p>`;
  } else {
    card.className = 'status-card ok';
    card.innerHTML = `<h1>Keine aktiven Fälle</h1><p class="big">In deinem Gebiet ist derzeit kein Fall gemeldet.</p><p class="small">${where}</p>`;
  }
  $('#areaList').innerHTML = area.length
    ? area.map((x) => outbreakItem(x.o, x.own ? ' <span class="muted small">(dein Kreis)</span>' : ` <span class="muted small">(${Math.round(x.dist)} km)</span>`)).join('')
    : '<p class="muted">Keine Fälle in diesem Gebiet in den vorliegenden Daten.</p>';
  $('#vetHint').textContent = `Dein Veterinäramt: Landkreis bzw. Stadt ${k.name}. Die Telefonnummer findest du auf der Website deiner Kreisverwaltung.`;
}

/* ---------- Rendering: Karte ---------- */
const LAT0 = 51.2, KX = Math.cos(LAT0 * Math.PI / 180);
const proj = (lon, lat) => [lon * KX, -lat];

function kreisColor(ags) {
  const list = state.outbreaks.filter((o) => o.ags === ags && (isGefluegel(o) ? state.filter.g : state.filter.w));
  const active = list.filter((o) => statusOf(o) === 'aktiv');
  if (active.some(isGefluegel)) return 'var(--red)';
  if (active.length) return 'var(--orange)';
  const recent = list.some((o) => statusOf(o) === 'aufgehoben' && today() - liftDate(o) <= CONFIG.recentlyLiftedDays * DAY);
  return recent ? 'var(--lifted)' : 'var(--none)';
}

function renderMap() {
  const wrap = $('#mapWrap');
  if (!state.kreise.length) {
    wrap.innerHTML = `<div class="pad"><p><b>Die Landkreis-Karte konnte nicht automatisch geladen werden.</b></p>
      <p class="small">1. <a href="${CONFIG.geojsonUrls[1]}" target="_blank" rel="noopener">Kreisgrenzen herunterladen</a> (Datei speichern).<br>
      2. Hier auswählen: <input type="file" accept=".geojson,.json,application/geo+json" id="geoFile"></p></div>`;
    $('#geoFile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { setKreise(normalizeKreise(JSON.parse(await f.text()))); }
      catch { toast('Die Datei konnte nicht gelesen werden.'); }
    };
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const paths = state.kreise.map((k) => {
    let d = '';
    for (const poly of k.polys) for (const ring of poly) {
      d += ring.map(([lon, lat], i) => {
        const [x, y] = proj(lon, lat);
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        return (i ? 'L' : 'M') + x.toFixed(3) + ' ' + y.toFixed(3);
      }).join('') + 'Z';
    }
    const cls = [k.ags === state.selected ? 'sel' : '', k.ags === state.settings.ags ? 'home' : ''].join(' ').trim();
    return `<path d="${d}" fill="${kreisColor(k.ags)}" data-ags="${k.ags}" fill-rule="evenodd"${cls ? ` class="${cls}"` : ''}><title>${esc(k.name)}</title></path>`;
  }).join('');
  state.home = { x: minX - .1, y: minY - .1, w: maxX - minX + .2, h: maxY - minY + .2 };
  if (state.view.w === 1) state.view = { ...state.home };
  const hp = homePoint();
  const me = hp && state.settings.lat != null ? (() => { const [x, y] = proj(hp[0], hp[1]); return `<circle class="me" cx="${x}" cy="${y}" r="0.04"/>`; })() : '';
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Karte der Landkreise">${paths}${me}</svg>`;
  applyView();
  bindMapEvents(wrap.querySelector('svg'));
}

function applyView() {
  const svg = $('#mapWrap svg'); if (!svg) return;
  const v = state.view;
  svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
}
function zoom(f, cx, cy) {
  const v = state.view;
  cx ??= v.x + v.w / 2; cy ??= v.y + v.h / 2;
  const w = Math.min(Math.max(v.w * f, state.home.w / 40), state.home.w * 1.5);
  const h = w * v.h / v.w;
  state.view = { x: cx - (cx - v.x) * w / v.w, y: cy - (cy - v.y) * h / v.h, w, h };
  applyView();
}

function bindMapEvents(svg) {
  let drag = null, moved = false;
  const toSvg = (e) => { const r = svg.getBoundingClientRect(), v = state.view;
    const s = Math.max(v.w / r.width, v.h / r.height);
    const ox = (r.width * s - v.w) / 2, oy = (r.height * s - v.h) / 2;
    return [v.x - ox + (e.clientX - r.left) * s, v.y - oy + (e.clientY - r.top) * s, s]; };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = toSvg(e); zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, x, y); }, { passive: false });
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, v: { ...state.view } }; moved = false; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; svg.classList.add('dragging'); }
    if (!moved) return;
    const [, , s] = toSvg(e);
    state.view = { ...drag.v, x: drag.v.x - dx * s, y: drag.v.y - dy * s };
    applyView();
  });
  svg.addEventListener('pointerup', (e) => {
    svg.classList.remove('dragging');
    if (drag && !moved) {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const ags = t?.dataset?.ags; if (ags) selectKreis(ags);
    }
    drag = null;
  });
}

function selectKreis(ags) {
  state.selected = ags;
  document.querySelectorAll('#mapWrap path.sel').forEach((p) => p.classList.remove('sel'));
  document.querySelector(`#mapWrap path[data-ags="${ags}"]`)?.classList.add('sel');
  const k = state.byAgs.get(ags), list = state.outbreaks.filter((o) => o.ags === ags);
  const box = $('#kreisDetail'); box.hidden = false;
  box.innerHTML = `<h2>${esc(k?.name || ags)} <span class="muted small">${esc(k?.land || '')}</span></h2>
    <div class="list">${list.length ? list.map((o) => outbreakItem(o)).join('') : '<p class="muted">Keine Fälle in den vorliegenden Daten.</p>'}</div>
    <div class="row"><button class="btn secondary" type="button" id="setHome">Als mein Landkreis festlegen</button></div>`;
  $('#setHome').onclick = () => { setHomeKreis(ags, true); switchView('gebiet'); };
}

/* ---------- Rendering: Statistik ---------- */
function seasonStart() {
  // Saison: 1. Oktober bis 30. September
  const d = today(), y = d.getMonth() >= 9 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 9, 1);
}
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

function renderStats() {
  const weeks = 12, end = weekStart(today()), start = new Date(end.getTime() - (weeks - 1) * 7 * DAY);
  const bins = Array.from({ length: weeks }, (_, i) => ({ d: new Date(start.getTime() + i * 7 * DAY), g: 0, w: 0 }));
  for (const o of state.outbreaks) {
    const d = parseDate(o.festgestellt_am); if (!d) continue;
    const i = Math.floor((weekStart(d) - start) / (7 * DAY));
    if (i >= 0 && i < weeks) bins[i][isGefluegel(o) ? 'g' : 'w']++;
  }
  const max = Math.max(1, ...bins.map((b) => b.g + b.w));
  const W = 420, H = 210, pl = 26, pb = 30, bw = (W - pl) / weeks;
  const y = (v) => (H - pb) - v / max * (H - pb - 10);
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  let svg = ticks.map((t) => `<line x1="${pl}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#e2ded4"/><text x="${pl - 6}" y="${y(t) + 4}" font-size="11" text-anchor="end" fill="#66706a">${t}</text>`).join('');
  bins.forEach((b, i) => {
    const x = pl + i * bw + 3, w = bw - 6;
    if (b.g) svg += `<rect x="${x}" y="${y(b.g)}" width="${w}" height="${y(0) - y(b.g)}" fill="#c8372d" rx="2"><title>KW ab ${fmtDate(b.d)}: ${b.g} Hausgeflügel</title></rect>`;
    if (b.w) svg += `<rect x="${x}" y="${y(b.g + b.w)}" width="${w}" height="${y(b.g) - y(b.g + b.w)}" fill="#e08a1e" rx="2"><title>KW ab ${fmtDate(b.d)}: ${b.w} Wildvögel</title></rect>`;
    if (i % 3 === 0) svg += `<text x="${x + w / 2}" y="${H - 14}" font-size="11" text-anchor="middle" fill="#66706a">${b.d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</text>`;
  });
  $('#weekChart').innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fälle pro Woche">${svg}</svg></div>
    <div class="legend"><span><i class="sw sw-g"></i>Hausgeflügel</span><span><i class="sw sw-w"></i>Wildvögel</span></div>`;

  const ss = seasonStart(), rows = {};
  for (const o of state.outbreaks) {
    const d = parseDate(o.festgestellt_am); if (!d || d < ss) continue;
    const land = LAENDER[o.ags.slice(0, 2)] || 'unbekannt';
    rows[land] ??= { g: 0, w: 0, a: 0 };
    rows[land][isGefluegel(o) ? 'g' : 'w']++;
    if (statusOf(o) === 'aktiv') rows[land].a++;
  }
  const entries = Object.entries(rows).sort((a, b) => (b[1].g + b[1].w) - (a[1].g + a[1].w));
  $('#landTable').innerHTML = entries.length
    ? `<table><thead><tr><th>Bundesland</th><th>Hausgeflügel</th><th>Wildvögel</th><th>aktiv</th></tr></thead><tbody>${
        entries.map(([l, r]) => `<tr><td>${esc(l)}</td><td>${r.g}</td><td>${r.w}</td><td>${r.a}</td></tr>`).join('')}</tbody></table>
       <p class="muted small">Saison ab ${fmtDate(ss)}.</p>`
    : '<p class="muted">Keine Fälle in dieser Saison.</p>';
}

/* ---------- Biosicherheit ---------- */
function renderChecklist() {
  const done = store.get('checklist', {});
  $('#checklist').innerHTML = CHECKLIST.map((t, i) =>
    `<li><label><input type="checkbox" data-i="${i}"${done[i] ? ' checked' : ''}><span>${esc(t)}</span></label></li>`).join('');
  $('#checklist').onchange = (e) => { const i = e.target.dataset.i; if (i == null) return; done[i] = e.target.checked; store.set('checklist', done); };
}

/* ---------- Einstellungen ---------- */
function saveSettings() { store.set('settings', state.settings); setTimeout(syncWorker, 0); }

function setHomeKreis(ags, clearPoint) {
  state.settings.ags = ags;
  if (clearPoint) { state.settings.lat = null; state.settings.lon = null; }
  saveSettings();
  store.set('known', null);   // neuer Bezugspunkt → Ausgangsstand neu aufnehmen, keine Altmeldungen
  detectChanges();
  $('#kreisSelect').value = ags;
  renderAll();
}

function bindSettings() {
  const sel = $('#kreisSelect');
  sel.innerHTML = (state.kreise.length ? '<option value="">– bitte wählen –</option>' : '<option value="">– zuerst Landkreis-Karte laden (Tab „Karte“) –</option>') +
    state.kreise.map((k) => `<option value="${k.ags}">${esc(k.name)} (${esc(k.land)})</option>`).join('');
  sel.value = state.settings.ags;
  sel.onchange = () => setHomeKreis(sel.value, true);

  const r = $('#radiusInput');
  r.value = state.settings.radius; $('#radiusLabel').textContent = r.value;
  r.oninput = () => { $('#radiusLabel').textContent = r.value; };
  r.onchange = () => { state.settings.radius = +r.value; saveSettings(); store.set('known', null); detectChanges(); renderArea(); };

  $('#locateBtn').onclick = () => {
    if (!navigator.geolocation) return toast('Standort wird von diesem Browser nicht unterstützt.');
    $('#locateBtn').disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      $('#locateBtn').disabled = false;
      const { latitude: lat, longitude: lon } = pos.coords;
      const k = kreisAt(lon, lat);
      if (!k) return toast('Dein Standort liegt außerhalb der bekannten Landkreise.');
      state.settings.lat = +lat.toFixed(3); state.settings.lon = +lon.toFixed(3); // grob gerundet, Datenschutz
      setHomeKreis(k.ags, false);
    }, () => { $('#locateBtn').disabled = false; toast('Standort nicht verfügbar. Bitte Landkreis manuell wählen.'); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 3600000 });
  };

  $('#notifyBtn').onclick = async () => {
    if (!('Notification' in window)) return toast('Benachrichtigungen werden hier nicht unterstützt. Auf dem iPhone: App zuerst zum Home-Bildschirm hinzufügen.');
    const p = await Notification.requestPermission();
    state.settings.notify = p === 'granted'; saveSettings(); renderNotifyState();
  };
  renderNotifyState();
}

function renderNotifyState() {
  const ok = state.settings.notify && 'Notification' in window && Notification.permission === 'granted';
  $('#notifyState').textContent = ok ? 'aktiv ✓' : ('Notification' in window && Notification.permission === 'denied' ? 'im Browser blockiert' : '');
  $('#notifyBtn').disabled = ok;
}

function toast(msg) { notifyBanner(msg); }
function notifyBanner(msg) {
  const el = document.createElement('div'); el.className = 'alert lifted';
  el.innerHTML = `<div>${esc(msg)}</div><button type="button" aria-label="Schließen">✕</button>`;
  el.querySelector('button').onclick = () => el.remove();
  $('#alerts').prepend(el); setTimeout(() => el.remove(), 8000);
}

/* ---------- Navigation ---------- */
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
}

function renderAll() {
  renderArea(); renderMap(); renderStats();
  $('#demoBanner').hidden = !state.meta.demo;
  const upd = state.meta.stand ? new Date(state.meta.stand) : null;
  $('#dataStamp').textContent = upd ? 'Stand: ' + upd.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '';
}

function setKreise(list, initial) {
  state.kreise = list;
  state.byAgs = new Map(list.map((k) => [k.ags, k]));
  state.view = { x: 0, y: 0, w: 1, h: 1 };
  bindSettings();
  if (!initial) { if (!list.length) return toast('In der Datei wurden keine Landkreise gefunden.'); renderAll(); detectChanges(); }
}

/** Übergibt Einstellungen an den Service Worker für die tägliche Hintergrund-Prüfung */
async function syncWorker() {
  if (IS_FILE || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const centroids = {}, names = {};
    for (const k of state.kreise) { centroids[k.ags] = [+k.centroid[0].toFixed(3), +k.centroid[1].toFixed(3)]; names[k.ags] = k.name; }
    const notify = state.settings.notify && 'Notification' in window && Notification.permission === 'granted';
    reg.active?.postMessage({ type: 'context', ctx: {
      home: homePoint(), ags: state.settings.ags, radius: state.settings.radius, notify,
      estDays: CONFIG.estZoneDays, centroids, names, known: store.get('known', null) } });
    if (notify && 'periodicSync' in reg) {
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (!perm || perm.state === 'granted') await reg.periodicSync.register('gpr-daily', { minInterval: 24 * 3600000 });
    }
  } catch (e) { console.warn('Hintergrund-Prüfung nicht verfügbar:', e.message); }
}

async function refresh() {
  try {
    await loadOutbreaks();
    renderAll();
    await notify(detectChanges());
    syncWorker();
  } catch (e) {
    console.error(e);
    $('#dataStamp').textContent = 'Daten nicht erreichbar';
  }
}

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installEvent = e;
  const b = document.querySelector('#installBtn'); if (b) b.hidden = false;
});
window.addEventListener('appinstalled', () => { const b = document.querySelector('#installBtn'); if (b) b.hidden = true; });

async function init() {
  const ib = document.querySelector('#installBtn');
  if (ib) ib.onclick = async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; ib.hidden = true; };
  document.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => switchView(b.dataset.view));
  const h = location.hash.slice(1); if (['gebiet', 'karte', 'statistik', 'schutz'].includes(h)) switchView(h);
  $('#fltGefluegel').onchange = (e) => { state.filter.g = e.target.checked; renderMap(); };
  $('#fltWild').onchange = (e) => { state.filter.w = e.target.checked; renderMap(); };
  $('#zoomIn').onclick = () => zoom(1 / 1.4);
  $('#zoomOut').onclick = () => zoom(1.4);
  $('#zoomReset').onclick = () => { state.view = { ...state.home }; applyView(); };
  renderChecklist();

  setKreise(await loadGeo(), true);
  await refresh();

  setInterval(refresh, CONFIG.refreshMinutes * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator && !IS_FILE) {
    // Offline-Fähigkeit + Benachrichtigungen. Echte Push-Meldungen bei geschlossener App: siehe README (Stufe 2).
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
