import { searchAddress, fetchMatrix, fetchRouteGeometry, DEFAULT_OSRM } from './geo.js';
import { optimize, simulate } from './optimizer.js';
import {
  load, save, clear, defaultState, makeStop,
  toMinutes, toClock, formatDuration, formatDistance,
} from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let state = load();
let lastPlan = null;
let map = null;
let mapLayer = null;

/* ---------- thème ---------- */

const THEME_KEY = 'rdvoptimiser.theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

applyTheme(
  (() => {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  })() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
);

$('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  if (lastPlan) renderMap(lastPlan);
});

/* ---------- autocomplétion d'adresse ---------- */

function attachAutocomplete(root, onPick) {
  const input = root.querySelector('input');
  const list = root.querySelector('.ac-list');
  let results = [];
  let active = -1;
  let timer = null;
  let controller = null;

  const close = () => { list.hidden = true; list.innerHTML = ''; active = -1; };

  const paint = () => {
    list.innerHTML = results
      .map((r, i) => `<li role="option" aria-selected="${i === active}" data-i="${i}">${esc(r.label)}</li>`)
      .join('');
    list.hidden = false;
  };

  const run = async (query) => {
    controller?.abort();
    controller = new AbortController();
    list.hidden = false;
    list.innerHTML = '<li class="loading">Recherche…</li>';
    try {
      results = await searchAddress(query, controller.signal);
      if (!results.length) {
        list.innerHTML = '<li class="none">Aucune adresse trouvée</li>';
        return;
      }
      active = -1;
      paint();
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.innerHTML = '<li class="none">Recherche indisponible</li>';
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 3) { close(); return; }
    timer = setTimeout(() => run(query), 500);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !results.length) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onPick(results[active < 0 ? 0 : active], input);
      close();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    onPick(results[Number(li.dataset.i)], input);
    close();
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ---------- formulaire ---------- */

function hydrateForm() {
  $('start-date').value = state.startDate || new Date().toISOString().slice(0, 10);
  $('start-time').value = state.startTime;
  $('default-duration').value = state.defaultDuration;
  $('duration-range').value = Math.min(180, state.defaultDuration);
  $('return-home').checked = state.returnToStart;
  $('osrm-url').value = state.osrmUrl;
  $('osrm-url').placeholder = DEFAULT_OSRM;
  $('fallback-speed').value = state.fallbackSpeed;
  if (state.depot) {
    $('depot-input').value = state.depot.label;
    showDepot();
  }
}

function showDepot() {
  const el = $('depot-resolved');
  if (!state.depot) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = state.depot.address;
}

function commit() {
  save(state);
  renderStops();
}

attachAutocomplete(document.querySelector('[data-ac="depot"]'), (place, input) => {
  state.depot = place;
  input.value = place.label;
  showDepot();
  commit();
});

attachAutocomplete(document.querySelector('[data-ac="stop"]'), (place, input) => {
  state.stops.push(makeStop(place));
  input.value = '';
  commit();
});

$('start-date').addEventListener('change', (e) => { state.startDate = e.target.value; save(state); });
$('start-time').addEventListener('change', (e) => { state.startTime = e.target.value || '08:00'; save(state); });

$('default-duration').addEventListener('input', (e) => {
  state.defaultDuration = Number(e.target.value) || 30;
  $('duration-range').value = Math.min(180, state.defaultDuration);
  commit();
});

$('duration-range').addEventListener('input', (e) => {
  state.defaultDuration = Number(e.target.value);
  $('default-duration').value = state.defaultDuration;
  commit();
});

$('return-home').addEventListener('change', (e) => { state.returnToStart = e.target.checked; save(state); });
$('osrm-url').addEventListener('change', (e) => { state.osrmUrl = e.target.value.trim(); save(state); });
$('fallback-speed').addEventListener('change', (e) => { state.fallbackSpeed = Number(e.target.value) || 45; save(state); });

$('reset').addEventListener('click', () => {
  if (!confirm('Effacer le point de départ et tous les rendez-vous ?')) return;
  state = defaultState();
  lastPlan = null;
  clear();
  $('depot-input').value = '';
  $('summary').hidden = true;
  $('timeline').innerHTML = '';
  hydrateForm();
  renderStops();
  renderMap(null);
});

/* ---------- liste des rendez-vous ---------- */

function renderStops() {
  const list = $('stop-list');
  $('stop-count').textContent = state.stops.length;
  $('stop-empty').hidden = state.stops.length > 0;
  $('optimize').disabled = state.stops.length < 2 || !state.depot;

  list.innerHTML = state.stops.map((s, i) => `
    <li class="stop ${s.fixed ? 'is-fixed' : ''}" data-id="${s.id}">
      <div class="stop-head">
        <span class="stop-order">${i + 1}</span>
        <span class="stop-label">${esc(s.label)}<small>${esc(s.address)}</small></span>
        <span class="stop-tools">
          <button type="button" data-act="up" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" title="Descendre" ${i === state.stops.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="del" class="del" title="Supprimer">✕</button>
        </span>
      </div>
      <div class="stop-opts">
        <label title="Durée du rendez-vous">
          ⏱
          <input type="number" data-act="duration" min="5" max="480" step="5"
                 value="${s.duration ?? state.defaultDuration}"> min
        </label>
        <label title="Ce rendez-vous ne peut pas être décalé">
          <input type="checkbox" data-act="fixed" ${s.fixed ? 'checked' : ''}> heure imposée
        </label>
        ${s.fixed ? `<input type="time" data-act="fixedTime" value="${esc(s.fixedTime)}">` : ''}
      </div>
    </li>`).join('');
}

$('stop-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.stop').dataset.id;
  const i = state.stops.findIndex((s) => s.id === id);
  if (i < 0) return;

  if (btn.dataset.act === 'del') state.stops.splice(i, 1);
  if (btn.dataset.act === 'up' && i > 0) state.stops.splice(i - 1, 0, state.stops.splice(i, 1)[0]);
  if (btn.dataset.act === 'down' && i < state.stops.length - 1) state.stops.splice(i + 1, 0, state.stops.splice(i, 1)[0]);
  commit();
});

$('stop-list').addEventListener('change', (e) => {
  const field = e.target.closest('[data-act]');
  if (!field || field.tagName === 'BUTTON') return;
  const stop = state.stops.find((s) => s.id === field.closest('.stop').dataset.id);
  if (!stop) return;

  if (field.dataset.act === 'duration') stop.duration = Number(field.value) || state.defaultDuration;
  if (field.dataset.act === 'fixedTime') stop.fixedTime = field.value;
  if (field.dataset.act === 'fixed') {
    stop.fixed = field.checked;
    if (stop.fixed && !stop.fixedTime) stop.fixedTime = suggestFixedTime(stop);
  }
  commit();
});

// Pré-remplit l'heure imposée avec le créneau déjà planifié, arrondi aux 5 minutes.
function suggestFixedTime(stop) {
  const item = lastPlan?.schedule.items.find((it) => it.stop.id === stop.id);
  if (!item) return state.startTime;
  return toClock(Math.round(item.start / 5) * 5);
}

/* ---------- optimisation ---------- */

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function buildContext(matrix) {
  return {
    durations: matrix.durations,
    distances: matrix.distances,
    stops: state.stops.map((s) => ({
      duration: s.duration ?? state.defaultDuration,
      fixedMinutes: s.fixed && s.fixedTime ? toMinutes(s.fixedTime) : null,
    })),
    startMinutes: toMinutes(state.startTime) ?? 8 * 60,
    returnToStart: state.returnToStart,
  };
}

// Le plan garde une référence aux rendez-vous, pas leur position : la liste peut être réordonnée
// derrière lui sans que le résultat affiché ne désigne le mauvais arrêt.
const decorate = (schedule) => ({
  ...schedule,
  items: schedule.items.map((item) => ({
    ...item,
    stop: state.stops[item.stopIdx],
    originalIndex: item.stopIdx,
  })),
});

$('optimize').addEventListener('click', async () => {
  const btn = $('optimize');
  const missing = state.stops.filter((s) => s.fixed && !s.fixedTime);
  if (missing.length) {
    setStatus(`Heure imposée manquante : ${missing.map((s) => s.label).join(', ')}.`, true);
    return;
  }

  btn.disabled = true;
  setStatus('Calcul des temps de trajet…');

  try {
    const points = [state.depot, ...state.stops].map((p) => ({ lat: p.lat, lon: p.lon }));
    const matrix = await fetchMatrix(points, {
      osrmUrl: state.osrmUrl || DEFAULT_OSRM,
      fallbackSpeed: state.fallbackSpeed,
    });

    setStatus('Recherche du meilleur ordre…');
    const ctx = buildContext(matrix);
    const before = simulate(state.stops.map((_, i) => i), ctx);
    const schedule = optimize(ctx);

    setStatus('Tracé de l\u2019itinéraire…');
    const plan = decorate(schedule);
    const ordered = [state.depot, ...plan.items.map((it) => it.stop)];
    if (state.returnToStart) ordered.push(state.depot);
    const geometry = await fetchRouteGeometry(ordered.map((p) => ({ lat: p.lat, lon: p.lon })), {
      osrmUrl: state.osrmUrl || DEFAULT_OSRM,
    });

    lastPlan = { schedule: plan, before, source: matrix.source, geometry, ordered };
    renderPlan(lastPlan);
    setStatus(matrix.source === 'osrm' ? '' : 'Temps estimés (serveur de routage injoignable).', matrix.source !== 'osrm');
  } catch (err) {
    console.error(err);
    setStatus(`Échec du calcul : ${err.message}`, true);
  } finally {
    btn.disabled = state.stops.length < 2 || !state.depot;
  }
});

/* ---------- rendu du plan ---------- */

function renderPlan(plan) {
  renderSummary(plan);
  renderTimeline(plan);
  renderMap(plan);
}

function delta(current, previous, unitFormatter) {
  const diff = current - previous;
  if (Math.abs(diff) < 0.5) return '<span class="delta">inchangé</span>';
  const cls = diff < 0 ? 'good' : 'bad';
  return `<span class="delta ${cls}">${diff < 0 ? '−' : '+'}${unitFormatter(Math.abs(diff))}</span>`;
}

function renderSummary(plan) {
  const { schedule, before } = plan;
  const dayLength = schedule.endMinutes - (toMinutes(state.startTime) ?? 0);

  $('summary').hidden = false;
  $('summary').innerHTML = `
    <div class="stat">
      <b>${formatDuration(schedule.travelMinutes)}</b>
      <span>Trajet total · ${delta(schedule.travelMinutes, before.travelMinutes, formatDuration)}</span>
    </div>
    <div class="stat">
      <b>${formatDistance(schedule.travelMeters)}</b>
      <span>Distance · ${delta(schedule.travelMeters, before.travelMeters, formatDistance)}</span>
    </div>
    <div class="stat">
      <b>${formatDuration(schedule.waiting)}</b>
      <span>Attente cumulée · ${delta(schedule.waiting, before.waiting, formatDuration)}</span>
    </div>
    <div class="stat">
      <b>${toClock(schedule.endMinutes)}</b>
      <span>Fin de tournée · journée de ${formatDuration(dayLength)}</span>
    </div>
    <div class="summary-actions">
      <button class="btn ghost small" type="button" data-act="apply">Appliquer cet ordre à ma liste</button>
      <button class="btn ghost small" type="button" data-act="ics">Exporter (.ics)</button>
      <button class="btn ghost small" type="button" data-act="copy">Copier l\u2019itinéraire</button>
      <button class="btn ghost small" type="button" data-act="gmaps">Ouvrir dans Google Maps</button>
    </div>`;
}

$('summary').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !lastPlan) return;
  if (act === 'apply') {
    state.stops = lastPlan.schedule.items.map((it) => it.stop);
    commit();
    setStatus('Ordre appliqué à la liste.');
  }
  if (act === 'ics') downloadIcs(lastPlan);
  if (act === 'copy') copyItinerary(lastPlan);
  if (act === 'gmaps') openGoogleMaps(lastPlan);
});

function renderTimeline(plan) {
  const { schedule } = plan;
  const start = toMinutes(state.startTime) ?? 0;
  const parts = [];

  if (!schedule.feasible) {
    const late = schedule.items.filter((it) => it.late > 0)
      .map((it) => `${esc(it.stop.label)} (+${formatDuration(it.late)})`);
    parts.push(`<div class="banner">Aucun ordre ne respecte toutes les heures imposées.
      Retard inévitable sur&nbsp;: ${late.join(', ')}. Desserrez une contrainte ou raccourcissez une durée.</div>`);
  }

  const firstWait = schedule.items[0]?.wait ?? 0;
  parts.push(`
    <div class="tl-item is-depot">
      <div class="tl-time"><b>${toClock(start)}</b><span>départ</span></div>
      <div class="tl-body">
        <h3>Point de départ</h3>
        <p>${esc(state.depot.address)}</p>
        ${firstWait > 5 ? `<div class="badges"><span class="badge wait">Vous pouvez partir à ${toClock(start + firstWait)}</span></div>` : ''}
      </div>
    </div>`);

  schedule.items.forEach((item, position) => {
    const stop = item.stop;
    const badges = [];
    if (stop.fixed && stop.fixedTime) badges.push('<span class="badge fixed">Heure imposée</span>');
    else badges.push('<span class="badge flex">Flexible</span>');
    if (item.wait > 0.5) badges.push(`<span class="badge wait">Attente ${formatDuration(item.wait)}</span>`);
    if (item.late > 0.5) badges.push(`<span class="badge fixed">Retard ${formatDuration(item.late)}</span>`);
    if (item.originalIndex !== position) badges.push(`<span class="badge moved">Déplacé · était n°${item.originalIndex + 1}</span>`);

    parts.push(legRow(item.travelMinutes, item.travelMeters));
    parts.push(`
      <div class="tl-item ${stop.fixed ? 'is-fixed' : ''}">
        <div class="tl-time">
          <b>${toClock(item.start)}</b>
          <span>→ ${toClock(item.end)}</span>
        </div>
        <div class="tl-body">
          <h3>${position + 1}. ${esc(stop.label)}</h3>
          <p>${esc(stop.address)}</p>
          <div class="badges">${badges.join('')}</div>
        </div>
      </div>`);
  });

  if (schedule.ret) {
    parts.push(legRow(schedule.ret.travelMinutes, schedule.ret.travelMeters));
    parts.push(`
      <div class="tl-item is-depot">
        <div class="tl-time"><b>${toClock(schedule.ret.arrive)}</b><span>retour</span></div>
        <div class="tl-body"><h3>Retour au point de départ</h3><p>${esc(state.depot.address)}</p></div>
      </div>`);
  }

  $('timeline').innerHTML = parts.join('');
}

const legRow = (minutes, meters) =>
  `<div class="leg">🚗 ${formatDuration(minutes)} · ${formatDistance(meters)}</div>`;

/* ---------- carte ---------- */

function renderMap(plan) {
  if (!map) {
    map = L.map('map', { scrollWheelZoom: false }).setView([46.6, 2.4], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
  }

  mapLayer?.remove();
  if (!plan) return;

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const fixedColor = getComputedStyle(document.documentElement).getPropertyValue('--fixed').trim();
  mapLayer = L.layerGroup().addTo(map);

  const markers = [];
  const depotIcon = L.divIcon({
    className: '',
    html: `<div style="background:#111;color:#fff;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:700 11px system-ui;border:2px solid #fff">D</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
  markers.push(L.marker([state.depot.lat, state.depot.lon], { icon: depotIcon })
    .bindPopup(`<b>Départ</b><br>${esc(state.depot.address)}`));

  plan.schedule.items.forEach((item, position) => {
    const stop = item.stop;
    const color = stop.fixed ? fixedColor : accent;
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:${color};color:#fff;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:700 12px system-ui;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${position + 1}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    markers.push(L.marker([stop.lat, stop.lon], { icon })
      .bindPopup(`<b>${position + 1}. ${esc(stop.label)}</b><br>${toClock(item.start)} → ${toClock(item.end)}<br>${esc(stop.address)}`));
  });

  markers.forEach((m) => m.addTo(mapLayer));

  const path = plan.geometry || plan.ordered.map((p) => [p.lat, p.lon]);
  const line = L.polyline(path, {
    color: accent,
    weight: 4,
    opacity: .75,
    dashArray: plan.geometry ? null : '6 8',
  }).addTo(mapLayer);

  map.fitBounds(line.getBounds().pad(0.15));
}

/* ---------- exports ---------- */

function itineraryText(plan) {
  const lines = [`Tournée du ${$('start-date').value} — départ ${toClock(toMinutes(state.startTime))} depuis ${state.depot.address}`];
  plan.schedule.items.forEach((item, position) => {
    const stop = item.stop;
    lines.push(`${position + 1}. ${toClock(item.start)}–${toClock(item.end)} · ${stop.label}`);
    lines.push(`   ${stop.address}`);
    lines.push(`   trajet ${formatDuration(item.travelMinutes)} · ${formatDistance(item.travelMeters)}${stop.fixed ? ' · heure imposée' : ''}`);
  });
  if (plan.schedule.ret) lines.push(`Retour ${toClock(plan.schedule.ret.arrive)} · ${state.depot.address}`);
  lines.push(`Total trajet ${formatDuration(plan.schedule.travelMinutes)} · ${formatDistance(plan.schedule.travelMeters)}`);
  return lines.join('\n');
}

async function copyItinerary(plan) {
  try {
    await navigator.clipboard.writeText(itineraryText(plan));
    setStatus('Itinéraire copié.');
  } catch {
    setStatus('Copie refusée par le navigateur.', true);
  }
}

const icsStamp = (dateStr, minutes) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 0, minutes, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
};

function downloadIcs(plan) {
  const date = $('start-date').value || new Date().toISOString().slice(0, 10);
  const fold = (s) => s.replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const events = plan.schedule.items.map((item, position) => {
    const stop = item.stop;
    return [
      'BEGIN:VEVENT',
      `UID:${stop.id}-${date}@rdvoptimiser`,
      `DTSTAMP:${icsStamp(date, 0)}Z`,
      `DTSTART:${icsStamp(date, item.start)}`,
      `DTEND:${icsStamp(date, item.end)}`,
      `SUMMARY:${fold(`${position + 1}. ${stop.label}`)}`,
      `LOCATION:${fold(stop.address)}`,
      `DESCRIPTION:${fold(`Trajet précédent : ${formatDuration(item.travelMinutes)} (${formatDistance(item.travelMeters)})`)}`,
      'END:VEVENT',
    ].join('\r\n');
  });

  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RdvOptimiser//FR', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `tournee-${date}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

function openGoogleMaps(plan) {
  const points = plan.ordered.map((p) => `${p.lat},${p.lon}`);
  const origin = points.shift();
  const destination = points.pop();
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'driving' });
  if (points.length) params.set('waypoints', points.join('|'));
  if (points.length > 9) setStatus('Google Maps ignore les étapes au-delà de la 9ᵉ.', true);
  window.open(`https://www.google.com/maps/dir/?${params}`, '_blank', 'noopener');
}

/* ---------- démarrage ---------- */

hydrateForm();
renderStops();
renderMap(null);
