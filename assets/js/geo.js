const NOMINATIM = 'https://nominatim.openstreetmap.org';
export const DEFAULT_OSRM = 'https://router.project-osrm.org';

const geocodeCache = new Map();

export class GeoError extends Error {}

async function getJson(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new GeoError(`HTTP ${res.status}`);
  return res.json();
}

export async function searchAddress(query, signal) {
  const key = query.trim().toLowerCase();
  if (key.length < 3) return [];
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=6&accept-language=fr&q=${encodeURIComponent(query)}`;
  const raw = await getJson(url, signal);
  const results = raw.map((r) => ({
    label: shortLabel(r),
    address: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
  geocodeCache.set(key, results);
  return results;
}

function shortLabel(r) {
  const a = r.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.municipality || a.county;
  const head = street || a.name || r.name;
  return [head, city].filter(Boolean).join(', ') || r.display_name;
}

const EARTH_RADIUS_KM = 6371;
// Le trajet routier réel dépasse la distance à vol d'oiseau; facteur usuel en zone mixte.
const DETOUR_FACTOR = 1.3;

export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function fallbackMatrix(points, speedKmh) {
  const n = points.length;
  const durations = [];
  const distances = [];
  for (let i = 0; i < n; i++) {
    durations.push(new Array(n).fill(0));
    distances.push(new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const km = haversineKm(points[i], points[j]) * DETOUR_FACTOR;
      distances[i][j] = km * 1000;
      durations[i][j] = (km / speedKmh) * 3600;
    }
  }
  return { durations, distances, source: 'estimation' };
}

const coordList = (points) => points.map((p) => `${p.lon},${p.lat}`).join(';');

export async function fetchMatrix(points, { osrmUrl = DEFAULT_OSRM, fallbackSpeed = 45, signal } = {}) {
  try {
    const url = `${osrmUrl.replace(/\/$/, '')}/table/v1/driving/${coordList(points)}?annotations=duration,distance`;
    const data = await getJson(url, signal);
    if (data.code !== 'Ok' || !data.durations) throw new GeoError(data.message || 'Réponse OSRM invalide');
    return { durations: data.durations, distances: data.distances, source: 'osrm' };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return fallbackMatrix(points, fallbackSpeed);
  }
}

export async function fetchRouteGeometry(points, { osrmUrl = DEFAULT_OSRM, signal } = {}) {
  if (points.length < 2) return null;
  try {
    const url = `${osrmUrl.replace(/\/$/, '')}/route/v1/driving/${coordList(points)}?overview=full&geometries=geojson`;
    const data = await getJson(url, signal);
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null;
  }
}
