const KEY = 'rdvoptimiser.v1';

export const defaultState = () => ({
  depot: null,
  startDate: '',
  startTime: '08:30',
  defaultDuration: 30,
  returnToStart: false,
  osrmUrl: '',
  fallbackSpeed: 45,
  stops: [],
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* mode privé ou quota plein : la perte de session est acceptable */
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* idem */
  }
}

export const makeStop = (place) => ({
  id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  label: place.label,
  address: place.address,
  lat: place.lat,
  lon: place.lon,
  duration: null,
  fixed: false,
  fixedTime: '',
});

export function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function toClock(minutes) {
  const total = Math.round(minutes);
  const day = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(day / 60);
  const m = day % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}
