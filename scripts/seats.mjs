// Knesset seat allocation — Bader-Ofer method with surplus-vote agreements.
// Ported from amiram/Elections (Source/js/controllers.js → calcMandates), rewritten
// as a pure function and with the pair-splitting step done per the Elections Law
// (D'Hondt between the two lists of an agreement).
//
// Usage as a module:
//   allocateSeats(parties, agreements, { threshold: 0.0325, seats: 120 })
//     parties    : [{ id, votes }]
//     agreements : [[idA, idB], ...]
//   → { seats: { id: n }, thresholdVotes, measure, passed: Set<id> }
//
// Run `node scripts/seats.mjs --test` to verify against the official 2022 result.

export function allocateSeats(parties, agreements = [], { threshold = 0.0325, seats = 120 } = {}) {
  const total = parties.reduce((s, p) => s + p.votes, 0);
  const thresholdVotes = total * threshold;
  const passing = parties.filter(p => p.votes > 0 && p.votes >= thresholdVotes);
  const passed = new Set(passing.map(p => p.id));
  const result = Object.fromEntries(parties.map(p => [p.id, 0]));
  if (!passing.length) return { seats: result, thresholdVotes, measure: 0, passed };

  const passingVotes = passing.reduce((s, p) => s + p.votes, 0);
  const measure = passingVotes / seats;

  // Agreements count only when both lists passed the threshold.
  const pairOf = new Map();
  for (const [a, b] of agreements) {
    if (passed.has(a) && passed.has(b) && !pairOf.has(a) && !pairOf.has(b)) {
      pairOf.set(a, [a, b]);
      pairOf.set(b, [a, b]);
    }
  }

  // Allocation units: single lists, or two lists joined by an agreement.
  const units = [];
  const seen = new Set();
  for (const p of passing) {
    if (seen.has(p.id)) continue;
    const ids = pairOf.get(p.id) ?? [p.id];
    ids.forEach(id => seen.add(id));
    const members = ids.map(id => passing.find(x => x.id === id));
    const votes = members.reduce((s, m) => s + m.votes, 0);
    const base = members.reduce((s, m) => s + Math.floor(m.votes / measure), 0);
    units.push({ ids, members, votes, seats: base });
  }

  // Remaining seats one at a time to the highest average votes / (seats + 1).
  let remaining = seats - units.reduce((s, u) => s + u.seats, 0);
  while (remaining-- > 0) {
    let best = units[0];
    for (const u of units) {
      if (u.votes / (u.seats + 1) > best.votes / (best.seats + 1)) best = u;
    }
    best.seats++;
  }

  // Split each unit's seats among its lists (D'Hondt within the agreement).
  for (const u of units) {
    if (u.members.length === 1) {
      result[u.ids[0]] = u.seats;
      continue;
    }
    const got = u.members.map(() => 0);
    for (let k = 0; k < u.seats; k++) {
      let bi = 0;
      for (let i = 1; i < u.members.length; i++) {
        if (u.members[i].votes / (got[i] + 1) > u.members[bi].votes / (got[bi] + 1)) bi = i;
      }
      got[bi]++;
    }
    u.members.forEach((m, i) => (result[m.id] = got[i]));
  }

  return { seats: result, thresholdVotes, measure, passed };
}

// For every list: how many extra votes it needs to gain one seat (or to pass the
// threshold), and how many it can lose before dropping one. Mirrors calcAll in
// amiram/Elections, using a binary search over the vote count.
export function seatSensitivity(parties, agreements, opts) {
  const base = allocateSeats(parties, agreements, opts).seats;
  const withVotes = (id, delta) =>
    allocateSeats(parties.map(p => (p.id === id ? { ...p, votes: Math.max(0, p.votes + delta) } : p)), agreements, opts).seats[id];

  const out = {};
  for (const p of parties) {
    if (!p.votes) continue;
    const current = base[p.id];
    // Votes needed to gain a seat: smallest delta where seats > current.
    let lo = 0, hi = Math.max(1000, p.votes);
    while (withVotes(p.id, hi) <= current && hi < 1e8) hi *= 2;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (withVotes(p.id, mid) > current) hi = mid; else lo = mid;
    }
    const toGain = hi;
    let toLose = null;
    if (current > 0) {
      lo = 0; hi = p.votes;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (withVotes(p.id, -mid) < current) hi = mid; else lo = mid;
      }
      toLose = hi;
    }
    out[p.id] = { toGain, toLose };
  }
  return out;
}

// --- self test: official 25th Knesset (2022) results -------------------------
if (process.argv[1] && process.argv[1].endsWith('seats.mjs') && process.argv.includes('--test')) {
  const votes2022 = {
    likud: 1115336, yeshatid: 847435, rz: 516470, mamlachti: 432482, shas: 392964,
    utj: 280194, yb: 213687, raam: 194047, hadash: 178735, avoda: 175992,
    meretz: 150793, balad: 138617, bayit: 56775, other: 4764742 - 4693527,
  };
  const expected = { likud: 32, yeshatid: 24, rz: 14, mamlachti: 12, shas: 11, utj: 7, yb: 6, raam: 5, hadash: 5, avoda: 4, meretz: 0, balad: 0, bayit: 0, other: 0 };
  const agreements = [['likud', 'rz'], ['yeshatid', 'mamlachti'], ['shas', 'utj'], ['avoda', 'meretz']];
  const parties = Object.entries(votes2022).map(([id, votes]) => ({ id, votes }));
  const { seats } = allocateSeats(parties, agreements);
  let ok = true;
  for (const [id, n] of Object.entries(expected)) {
    const mark = seats[id] === n ? '✓' : '✗';
    if (seats[id] !== n) ok = false;
    console.log(`${mark} ${id.padEnd(10)} expected ${String(n).padStart(2)}  got ${String(seats[id]).padStart(2)}`);
  }
  const sum = Object.values(seats).reduce((a, b) => a + b, 0);
  console.log(`total seats: ${sum}`);
  if (!ok || sum !== 120) { console.error('FAILED'); process.exit(1); }
  console.log('PASSED — matches the official 2022 result');
}
