import assert from 'node:assert/strict';
import { optimize, simulate } from '../assets/js/optimizer.js';
import { fallbackMatrix } from '../assets/js/geo.js';

const places = [
  { name: 'Dépôt (Nation)', lat: 48.8483, lon: 2.3958 },
  { name: 'La Défense', lat: 48.8918, lon: 2.2389 },
  { name: 'Bastille', lat: 48.8531, lon: 2.3691 },
  { name: 'Montparnasse', lat: 48.8422, lon: 2.3219 },
  { name: 'Saint-Denis', lat: 48.9362, lon: 2.3574 },
  { name: 'Vincennes', lat: 48.8476, lon: 2.4370 },
  { name: 'Issy', lat: 48.8244, lon: 2.2730 },
];

const matrix = fallbackMatrix(places, 30);

const ctxWith = (fixed) => ({
  durations: matrix.durations,
  distances: matrix.distances,
  stops: places.slice(1).map((_, i) => ({ duration: 30, fixedMinutes: fixed[i] ?? null })),
  startMinutes: 8 * 60 + 30,
  returnToStart: true,
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('une tournée libre est au moins aussi courte que l\'ordre de saisie', () => {
  const ctx = ctxWith([]);
  const naive = simulate([0, 1, 2, 3, 4, 5], ctx);
  const best = optimize(ctx);
  assert.ok(best.travelMinutes < naive.travelMinutes, 'aucun gain de trajet');
  assert.equal(best.order.length, 6);
  assert.deepEqual([...best.order].sort(), [0, 1, 2, 3, 4, 5]);
});

test('les heures imposées sont tenues exactement', () => {
  const ctx = ctxWith([null, null, 11 * 60, null, 9 * 60 + 30, null]);
  const best = optimize(ctx);
  assert.ok(best.feasible);
  for (const item of best.items) {
    const fixed = ctx.stops[item.stopIdx].fixedMinutes;
    if (fixed != null) assert.ok(Math.abs(item.start - fixed) < 1e-6, 'heure imposée décalée');
  }
});

test('deux heures imposées incompatibles sont signalées, pas masquées', () => {
  const ctx = ctxWith([9 * 60, 9 * 60, null, null, null, null]);
  const best = optimize(ctx);
  assert.equal(best.feasible, false);
  assert.ok(best.lateness > 0);
});

test('un rendez-vous flexible n\'est jamais démarré avant l\'arrivée', () => {
  const ctx = ctxWith([]);
  const best = optimize(ctx);
  for (const item of best.items) assert.ok(item.start >= item.arrive - 1e-9);
});

const manyPoints = Array.from({ length: 14 }, (_, i) => ({
  lat: 48.8 + ((i * 37) % 20) / 100,
  lon: 2.2 + ((i * 53) % 25) / 100,
}));
const bigMatrix = fallbackMatrix([places[0], ...manyPoints], 30);
const bigCtx = {
  durations: bigMatrix.durations,
  distances: bigMatrix.distances,
  stops: manyPoints.map((_, i) => ({
    duration: 20,
    fixedMinutes: i === 3 ? 12 * 60 : i === 9 ? 15 * 60 : null,
  })),
  startMinutes: 8 * 60,
  returnToStart: false,
};

test('au-delà du seuil exhaustif, l\'heuristique reste faisable et améliorante', () => {
  const naive = simulate(manyPoints.map((_, i) => i), bigCtx);
  const best = optimize(bigCtx);
  assert.ok(best.feasible, 'contraintes non tenues sur 14 arrêts');
  assert.ok(best.travelMinutes < naive.travelMinutes, 'aucun gain sur 14 arrêts');
});

test('deux exécutions rendent le même itinéraire', () => {
  assert.deepEqual(optimize(bigCtx).order, optimize(bigCtx).order);
});

test('une tournée vide ou à un seul arrêt ne casse pas', () => {
  const ctx = ctxWith([]);
  assert.equal(simulate([], ctx).travelMinutes, 0);
  assert.equal(optimize({ ...ctx, stops: [ctx.stops[0]] }).items.length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests réussis`);
process.exit(failed ? 1 : 0);
