const DEPOT = 0;

const matrixIndex = (stopIdx) => stopIdx + 1;

function leg(ctx, from, to) {
  const seconds = ctx.durations[from]?.[to] ?? 0;
  const meters = ctx.distances?.[from]?.[to] ?? 0;
  return { minutes: seconds / 60, meters };
}

/**
 * Déroule une tournée dans le temps. Un rendez-vous à heure imposée n'avance jamais :
 * arriver en avance produit de l'attente, arriver après produit du retard (solution rejetée).
 */
export function simulate(order, ctx) {
  let clock = ctx.startMinutes;
  let cursor = DEPOT;
  let travelMinutes = 0;
  let travelMeters = 0;
  let lateness = 0;
  let waiting = 0;
  const items = [];

  for (const stopIdx of order) {
    const node = matrixIndex(stopIdx);
    const hop = leg(ctx, cursor, node);
    travelMinutes += hop.minutes;
    travelMeters += hop.meters;

    const arrive = clock + hop.minutes;
    const stop = ctx.stops[stopIdx];
    let start = arrive;
    let wait = 0;
    let late = 0;

    if (stop.fixedMinutes != null) {
      if (arrive <= stop.fixedMinutes) {
        start = stop.fixedMinutes;
        wait = stop.fixedMinutes - arrive;
      } else {
        late = arrive - stop.fixedMinutes;
      }
    }

    const end = start + stop.duration;
    items.push({ stopIdx, travelMinutes: hop.minutes, travelMeters: hop.meters, arrive, start, end, wait, late });

    waiting += wait;
    lateness += late;
    clock = end;
    cursor = node;
  }

  let ret = null;
  if (ctx.returnToStart && order.length) {
    const hop = leg(ctx, cursor, DEPOT);
    travelMinutes += hop.minutes;
    travelMeters += hop.meters;
    clock += hop.minutes;
    ret = { travelMinutes: hop.minutes, travelMeters: hop.meters, arrive: clock };
  }

  return {
    order: [...order],
    items,
    ret,
    travelMinutes,
    travelMeters,
    waiting,
    lateness,
    endMinutes: clock,
    feasible: lateness < 1e-9,
  };
}

function score(s) {
  return [s.lateness, s.endMinutes, s.travelMinutes];
}

function better(a, b) {
  const x = score(a);
  const y = score(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] < y[i] - 1e-9) return true;
    if (x[i] > y[i] + 1e-9) return false;
  }
  return false;
}

function permute(items, visit) {
  const arr = [...items];
  const walk = (k) => {
    if (k === 1) return visit(arr);
    for (let i = 0; i < k; i++) {
      walk(k - 1);
      const swap = k % 2 === 0 ? i : 0;
      [arr[swap], arr[k - 1]] = [arr[k - 1], arr[swap]];
    }
  };
  if (arr.length === 0) visit(arr);
  else walk(arr.length);
}

function nearestNeighbour(ctx, indices) {
  const remaining = new Set(indices);
  const order = [];
  let cursor = DEPOT;
  while (remaining.size) {
    let best = null;
    let bestCost = Infinity;
    for (const idx of remaining) {
      const cost = leg(ctx, cursor, matrixIndex(idx)).minutes;
      if (cost < bestCost) {
        bestCost = cost;
        best = idx;
      }
    }
    order.push(best);
    remaining.delete(best);
    cursor = matrixIndex(best);
  }
  return order;
}

function byFixedTimeFirst(ctx, indices) {
  const fixed = indices.filter((i) => ctx.stops[i].fixedMinutes != null)
    .sort((a, b) => ctx.stops[a].fixedMinutes - ctx.stops[b].fixedMinutes);
  const flexible = indices.filter((i) => ctx.stops[i].fixedMinutes == null);

  const order = [...fixed];
  for (const idx of flexible) {
    let bestOrder = null;
    let bestSchedule = null;
    for (let pos = 0; pos <= order.length; pos++) {
      const candidate = [...order.slice(0, pos), idx, ...order.slice(pos)];
      const schedule = simulate(candidate, ctx);
      if (!bestSchedule || better(schedule, bestSchedule)) {
        bestSchedule = schedule;
        bestOrder = candidate;
      }
    }
    order.splice(0, order.length, ...bestOrder);
  }
  return order;
}

function localSearch(order, ctx, maxPasses = 60) {
  let current = simulate(order, ctx);
  const n = order.length;

  for (let pass = 0; pass < maxPasses; pass++) {
    let bestMove = null;

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const reversed = [...current.order];
        reversed.splice(i, j - i + 1, ...current.order.slice(i, j + 1).reverse());
        const schedule = simulate(reversed, ctx);
        if (better(schedule, bestMove || current)) bestMove = schedule;
      }
    }

    for (let len = 1; len <= Math.min(3, n); len++) {
      for (let i = 0; i + len <= n; i++) {
        const rest = [...current.order];
        const segment = rest.splice(i, len);
        for (let pos = 0; pos <= rest.length; pos++) {
          if (pos === i) continue;
          const candidate = [...rest.slice(0, pos), ...segment, ...rest.slice(pos)];
          const schedule = simulate(candidate, ctx);
          if (better(schedule, bestMove || current)) bestMove = schedule;
        }
      }
    }

    if (!bestMove) break;
    current = bestMove;
  }

  return current;
}

function shuffled(arr, random) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Seed fixe : deux optimisations d'une même saisie doivent rendre le même itinéraire.
function seededRandom(seed = 0x2f6e2b1) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export const EXHAUSTIVE_LIMIT = 9;

export function optimize(ctx) {
  const indices = ctx.stops.map((_, i) => i);
  if (indices.length <= 1) return simulate(indices, ctx);

  if (indices.length <= EXHAUSTIVE_LIMIT) {
    let best = null;
    permute(indices, (candidate) => {
      const schedule = simulate(candidate, ctx);
      if (!best || better(schedule, best)) best = schedule;
    });
    return best;
  }

  const random = seededRandom();
  const seeds = [indices, nearestNeighbour(ctx, indices), byFixedTimeFirst(ctx, indices)];
  for (let i = 0; i < 8; i++) seeds.push(shuffled(indices, random));

  let best = null;
  for (const seed of seeds) {
    const schedule = localSearch(seed, ctx);
    if (!best || better(schedule, best)) best = schedule;
  }
  return best;
}
