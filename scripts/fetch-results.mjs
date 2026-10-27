#!/usr/bin/env node
// Fetches the Central Elections Committee result files for the 26th Knesset,
// computes seats and writes the JSON files the site reads (site/data/*.json).
//
//   node scripts/fetch-results.mjs                one fetch
//   node scripts/fetch-results.mjs --watch 90     fetch every 90 s (Ctrl+C to stop)
//   node scripts/fetch-results.mjs --watch 60 --duration 4 --push
//                                                 loop for 4 minutes, git commit + push on change
//   node scripts/fetch-results.mjs --final        mark the current data as final results
//   node scripts/fetch-results.mjs --demo         write demo data to site/data/demo/
//
// Zero dependencies — Node 20+.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateSeats, seatSensitivity } from './seats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'site', 'data');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const config = JSON.parse(await readFile(path.join(ROOT, 'config', 'election-2026.json'), 'utf8'));
const partyMeta = JSON.parse(await readFile(path.join(ROOT, 'config', 'parties-2026.json'), 'utf8'));

// Column headers in the CEC files that are not party ballot letters.
const META = {
  committee: ['סמל ועדה'],
  name: ['שם ישוב'],
  code: ['סמל ישוב'],
  eligible: ['בזב'],
  voters: ['מצביעים'],
  invalid: ['פסולים'],
  valid: ['כשרים'],
  box: ['קלפי', 'מספר קלפי'],
};
const NON_PARTY = new Set(['סמל ועדה', 'שם ישוב', 'סמל ישוב', 'בזב', 'מצביעים', 'פסולים', 'כשרים', 'ריכוז', 'שופט', 'קלפי', 'מספר קלפי', 'ברזל', 'ת. עדכון', 'ת.עדכון', 'סמל קלפי', 'חיצוניות', 'קלפי אחרת']);

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

// ---------------------------------------------------------------------------
// Download / read
// ---------------------------------------------------------------------------

function decode(buf) {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1255').decode(bytes);
  }
}

function looksLikeCsv(text) {
  const head = text.slice(0, 600).trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<html') || head.includes('<!doctype')) return false;
  const firstLine = text.split(/\r?\n/, 1)[0];
  return firstLine.includes(',') && /כשרים|בזב|מצביעים/.test(firstLine);
}

async function loadFirst(sources) {
  for (const src of sources) {
    try {
      let buf;
      if (/^https?:/.test(src)) {
        const res = await fetch(src, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            Accept: 'text/csv,text/plain,*/*',
            'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
            Referer: config.officialSite,
            'Cache-Control': 'no-cache',
          },
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) { log(`  ${src} → HTTP ${res.status}`); continue; }
        buf = await res.arrayBuffer();
      } else {
        const file = path.join(ROOT, src);
        if (!existsSync(file)) continue;
        buf = await readFile(file);
      }
      const text = decode(buf);
      if (!looksLikeCsv(text)) { log(`  ${src} → not a results CSV (blocked or HTML page)`); continue; }
      log(`  ${src} → ok (${(text.length / 1024).toFixed(0)} KB)`);
      return { src, text };
    } catch (e) {
      log(`  ${src} → ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
    }
  }
  return null;
}

// RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

const num = v => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Turns a CEC CSV into { rows: [{ name, code, eligible, voters, invalid, valid, votes: {letters: n} }], partyCols }
function readResultsCsv(text) {
  const [header, ...lines] = parseCsv(text);
  const h = header.map(x => x.replace(/^﻿/, '').trim());
  const idx = key => h.findIndex(x => META[key].includes(x));
  const col = Object.fromEntries(Object.keys(META).map(k => [k, idx(k)]));
  const validAt = col.valid;
  const partyCols = h
    .map((name, i) => ({ name, i }))
    .filter(({ name, i }) =>
      name && !NON_PARTY.has(name) && !/^unnamed/i.test(name) &&
      (partyMeta.parties[name] || (i > validAt && /^[א-ת"״'׳]{1,5}$/.test(name))));

  const rows = lines.map(r => {
    const votes = {};
    for (const { name, i } of partyCols) votes[name] = num(r[i]);
    const valid = col.valid >= 0 ? num(r[col.valid]) : Object.values(votes).reduce((a, b) => a + b, 0);
    return {
      name: col.name >= 0 ? (r[col.name] || '').trim() : '',
      code: col.code >= 0 ? String(num(r[col.code])) : '',
      box: col.box >= 0 ? (r[col.box] || '').trim() : '',
      eligible: col.eligible >= 0 ? num(r[col.eligible]) : 0,
      voters: col.voters >= 0 ? num(r[col.voters]) : 0,
      invalid: col.invalid >= 0 ? num(r[col.invalid]) : 0,
      valid,
      votes,
    };
  });
  return { rows, partyCols: partyCols.map(p => p.name) };
}

// ---------------------------------------------------------------------------
// Build the JSON the site uses
// ---------------------------------------------------------------------------

function partyInfo(id) {
  const m = partyMeta.parties[id] || {};
  return {
    id,
    he: m.he || `רשימה ${id}`,
    en: m.en || `List "${id}"`,
    leaderHe: m.leaderHe || '',
    leaderEn: m.leaderEn || '',
    color: m.color || '#64748B',
    bloc: m.bloc || 'other',
    seats2022: m.seats2022 ?? null,
  };
}

function build({ localities, ballots, source, status }) {
  // Aggregate per locality (from expc, or from expb when expc is missing).
  let locRows = localities?.rows;
  if (!locRows && ballots) {
    const byCode = new Map();
    for (const b of ballots.rows) {
      const k = b.code || b.name;
      const l = byCode.get(k) || { name: b.name, code: b.code, eligible: 0, voters: 0, invalid: 0, valid: 0, votes: {} };
      l.eligible += b.eligible; l.voters += b.voters; l.invalid += b.invalid; l.valid += b.valid;
      for (const [p, v] of Object.entries(b.votes)) l.votes[p] = (l.votes[p] || 0) + v;
      byCode.set(k, l);
    }
    locRows = [...byCode.values()];
  }
  locRows = locRows || [];

  const ids = new Set([...Object.keys(partyMeta.parties), ...(localities?.partyCols || []), ...(ballots?.partyCols || [])]);
  const votes = Object.fromEntries([...ids].map(id => [id, 0]));
  const totals = { eligible: 0, voters: 0, invalid: 0, valid: 0, localities: 0, ballotBoxes: 0, ballotBoxesReported: 0 };
  for (const l of locRows) {
    totals.eligible += l.eligible; totals.voters += l.voters; totals.invalid += l.invalid; totals.valid += l.valid;
    if (l.voters > 0) totals.localities++;
    for (const [p, v] of Object.entries(l.votes)) votes[p] = (votes[p] || 0) + v;
  }
  if (ballots) {
    totals.ballotBoxes = ballots.rows.length;
    totals.ballotBoxesReported = ballots.rows.filter(b => b.voters > 0).length;
  }
  const partyVotesSum = Object.values(votes).reduce((a, b) => a + b, 0);
  if (!totals.valid) totals.valid = partyVotesSum;
  totals.turnout = totals.eligible ? totals.voters / totals.eligible : 0;

  const opts = { threshold: config.threshold, seats: config.seats };
  const list = [...ids].map(id => ({ id, votes: votes[id] || 0 }));
  const alloc = allocateSeats(list, config.surplusAgreements, opts);
  const sens = partyVotesSum ? seatSensitivity(list.filter(p => p.votes > 0), config.surplusAgreements, opts) : {};

  const parties = list
    .map(p => ({
      ...partyInfo(p.id),
      votes: p.votes,
      pct: partyVotesSum ? p.votes / partyVotesSum : 0,
      seats: alloc.seats[p.id] || 0,
      passed: alloc.passed.has(p.id),
      toGain: sens[p.id]?.toGain ?? null,
      toLose: sens[p.id]?.toLose ?? null,
    }))
    .sort((a, b) => b.seats - a.seats || b.votes - a.votes || (partyMeta.parties[b.id] ? 1 : 0) - (partyMeta.parties[a.id] ? 1 : 0));

  const blocs = {};
  for (const [k, b] of Object.entries(partyMeta.blocs)) blocs[k] = { ...b, seats: 0, votes: 0 };
  for (const p of parties) {
    const b = blocs[p.bloc] || blocs.other;
    b.seats += p.seats; b.votes += p.votes;
  }

  const locs = locRows
    .filter(l => l.voters > 0 || l.valid > 0)
    .map(l => ({
      name: l.name, code: l.code, eligible: l.eligible, voters: l.voters, valid: l.valid,
      top: Object.entries(l.votes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4),
    }))
    .sort((a, b) => b.valid - a.valid);

  return {
    results: {
      status: partyVotesSum ? status : 'waiting',
      election: { date: config.electionDate, pollsClose: config.pollsClose, seats: config.seats, threshold: config.threshold, officialSite: config.officialSite },
      source,
      totals,
      thresholdVotes: Math.ceil(alloc.thresholdVotes),
      measure: Math.round(alloc.measure),
      parties,
      blocs,
      agreements: config.surplusAgreements,
    },
    localities: locs,
  };
}

const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function readJson(file, def) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return def; }
}

async function writeOutputs(dir, { results, localities }, historyEntry) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
  await writeFile(path.join(dir, 'localities.json'), JSON.stringify(localities));
  if (historyEntry) {
    const history = await readJson(path.join(dir, 'history.json'), []);
    history.push(historyEntry);
    await writeFile(path.join(dir, 'history.json'), JSON.stringify(history.slice(-400)));
  }
}

function snapshot(results) {
  return {
    t: results.updatedAt,
    valid: results.totals.valid,
    seats: Object.fromEntries(results.parties.filter(p => p.seats > 0).map(p => [p.id, p.seats])),
  };
}

// One fetch → write if anything changed. Returns true when files changed.
async function runOnce() {
  log('fetching results…');
  const prev = await readJson(path.join(DATA, 'results.json'), null);
  const [loc, bal] = await Promise.all([loadFirst(config.sources.localities), loadFirst(config.sources.ballots)]);
  const final = flag('final');

  if (!loc && !bal) {
    if (final && prev && prev.status !== 'waiting') {
      prev.status = 'final';
      await writeFile(path.join(DATA, 'results.json'), JSON.stringify(prev, null, 1));
      log('marked existing data as final');
      return true;
    }
    if (!prev || prev.status === 'waiting') {
      if (!prev) {
        const empty = build({ localities: null, ballots: null, source: null, status: 'waiting' });
        empty.results.updatedAt = new Date().toISOString();
        await writeOutputs(DATA, empty, null);
        await writeFile(path.join(DATA, 'history.json'), '[]');
        log('no results published yet — wrote "waiting" state');
        return true;
      }
      log('no results published yet (still waiting)');
      return false;
    }
    // Only flag as stale after 15 min without fresh data, so a blocked cloud runner
    // doesn't override data pushed by a runner that can reach the committee.
    if (prev.status === 'live' && Date.now() - new Date(prev.updatedAt).getTime() > 15 * 60000) {
      prev.status = 'stale';
      await writeFile(path.join(DATA, 'results.json'), JSON.stringify(prev, null, 1));
      log('all sources failed — marked data as stale');
      return true;
    }
    log('all sources failed — keeping last data');
    return false;
  }

  const sourceHash = hash((loc?.text || '') + '|' + (bal?.text || ''));
  const status = final ? 'final' : 'live';
  if (prev && prev.sourceHash === sourceHash && (prev.status === status || (prev.status === 'waiting' && !final))) {
    log('no change since last update');
    return false;
  }

  const out = build({
    localities: loc ? readResultsCsv(loc.text) : null,
    ballots: bal ? readResultsCsv(bal.text) : null,
    source: [loc?.src, bal?.src].filter(Boolean),
    status,
  });
  out.results.sourceHash = sourceHash;
  out.results.updatedAt = new Date().toISOString();
  const changedData = !prev || prev.sourceHash !== sourceHash;
  await writeOutputs(DATA, out, changedData && out.results.status !== 'waiting' ? snapshot(out.results) : null);
  const top = out.results.parties.filter(p => p.seats).map(p => `${p.en} ${p.seats}`).join(', ');
  log(`updated — ${out.results.totals.valid.toLocaleString()} valid votes · ${top}`);
  return true;
}

function gitPush() {
  const sh = c => execSync(c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  try {
    sh('git add site/data');
    if (!sh('git status --porcelain site/data')) return;
    sh(`git commit -m "Live results update ${new Date().toISOString().slice(0, 16)}Z"`);
    try { sh('git pull --rebase -X theirs'); } catch { /* offline or no upstream — push will tell */ }
    sh('git push');
    log('pushed to GitHub');
  } catch (e) {
    log('git push failed:', (e.stderr?.toString() || e.message).split('\n')[0]);
  }
}

// ---------------------------------------------------------------------------
// Demo data — realistic numbers based on the final pre-election polls,
// so the site can be previewed before polls close (site/?demo=1).
// ---------------------------------------------------------------------------

async function writeDemo() {
  const share = { // approx. vote share from the last polls (Channel 12/13, Kantar, 22–23 Oct 2026)
    'דרך': 0.181, 'מחל': 0.168, 'רק': 0.118, 'אמת': 0.075, 'ודם': 0.071, 'ב': 0.064, 'שס': 0.062,
    'ל': 0.060, 'ג': 0.056, 'ט': 0.051, 'עם': 0.043, 'די': 0.027, 'ך': 0.026, 'זך': 0.009, 'ני': 0.006,
    'צף': 0.002, 'בי': 0.001, 'קך': 0.001,
  };
  let seed = 26;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const towns = [
    ['ירושלים', 3000, 620000, { 'ג': 2.6, 'שס': 1.7, 'מחל': 1.1, 'ב': 1.4, 'ודם': 0.3, 'אמת': 0.5 }],
    ['תל אביב - יפו', 5000, 430000, { 'אמת': 2.6, 'דרך': 1.5, 'רק': 1.3, 'מחל': 0.7, 'ג': 0.2, 'ב': 0.4 }],
    ['חיפה', 4000, 230000, { 'אמת': 1.6, 'ל': 1.9, 'ודם': 1.3, 'ג': 0.3 }],
    ['ראשון לציון', 8300, 200000, { 'ל': 1.4, 'מחל': 1.1 }],
    ['פתח תקווה', 7900, 180000, { 'מחל': 1.1, 'רק': 1.1 }],
    ['אשדוד', 70, 170000, { 'ל': 2.1, 'שס': 1.6, 'ג': 1.3, 'מחל': 1.3, 'אמת': 0.4 }],
    ['נתניה', 7400, 170000, { 'מחל': 1.4, 'שס': 1.4 }],
    ['בני ברק', 6100, 120000, { 'ג': 8.5, 'שס': 3.2, 'מחל': 0.1, 'דרך': 0.05, 'אמת': 0.02 }],
    ['באר שבע', 9000, 160000, { 'מחל': 1.6, 'ב': 1.4, 'ל': 1.4, 'שס': 1.3 }],
    ['חולון', 6600, 150000, { 'מחל': 1.2, 'דרך': 1.1 }],
    ['רמת גן', 8600, 130000, { 'דרך': 1.3, 'אמת': 1.3, 'רק': 1.2 }],
    ['רחובות', 8400, 110000, { 'רק': 1.2 }],
    ['נצרת', 7300, 60000, { 'ודם': 9.5, 'עם': 3.5, 'מחל': 0.02, 'דרך': 0.05 }],
    ['רהט', 1161, 45000, { 'עם': 15, 'ודם': 3, 'מחל': 0.01, 'דרך': 0.02 }],
    ['אום אל-פחם', 2710, 40000, { 'ודם': 10, 'עם': 6, 'מחל': 0.01 }],
    ['מודיעין-מכבים-רעות', 1200, 75000, { 'רק': 1.9, 'דרך': 1.5, 'אמת': 1.2, 'ב': 0.4 }],
    ['כפר סבא', 6900, 80000, { 'דרך': 1.5, 'אמת': 1.6, 'רק': 1.3 }],
    ['אילת', 2600, 40000, { 'מחל': 1.3, 'ל': 1.3 }],
    ['בית שמש', 2610, 80000, { 'ג': 4, 'שס': 2.4, 'ב': 1.2, 'דרך': 0.3 }],
    ['אריאל', 3570, 15000, { 'ט': 2.2, 'ב': 2, 'ל': 1.6, 'מחל': 1.3 }],
    ['מעטפות חיצוניות', 9999, 0, {}],
  ];
  const ids = Object.keys(share);
  const steps = 10;
  const history = [];
  let out;
  const start = new Date('2026-10-27T22:30:00+02:00').getTime();
  const allTowns = towns.map(([name, code, size, bias]) => {
    const eligible = size || 260000;
    const turnout = 0.62 + rnd() * 0.16;
    const w = ids.map(id => share[id] * (bias[id] ?? 1) * (0.85 + rnd() * 0.3));
    const sum = w.reduce((a, b) => a + b, 0);
    return { name, code: String(code), eligible, turnout, w: w.map(x => x / sum) };
  });
  // National remainder so totals feel like a real election (~6.9M eligible).
  allTowns.push({ name: 'שאר הארץ (הדגמה)', code: '0', eligible: 6900000 - allTowns.reduce((s, t) => s + t.eligible, 0), turnout: 0.69, w: ids.map(id => share[id]) });

  for (let s = 1; s <= steps; s++) {
    const frac = s === steps ? 1 : Math.min(1, (s / steps) ** 1.2 + rnd() * 0.04);
    const rows = allTowns.map(t => {
      const f = Math.min(1, frac * (0.8 + rnd() * 0.4));
      const eligible = Math.round(t.eligible * Math.min(1, f));
      const voters = t.code === '9999' ? (s === steps ? 250000 : 0) : Math.round(eligible * t.turnout);
      const invalid = Math.round(voters * 0.006);
      const valid = voters - invalid;
      const votes = {};
      ids.forEach((id, i) => (votes[id] = Math.round(valid * t.w[i])));
      return { name: t.name, code: t.code, eligible, voters, invalid, valid, votes };
    });
    out = build({ localities: { rows, partyCols: ids }, ballots: null, source: ['demo'], status: 'demo' });
    out.results.status = 'demo';
    out.results.updatedAt = new Date(start + s * 25 * 60000).toISOString();
    out.results.totals.ballotBoxes = 13800;
    out.results.totals.ballotBoxesReported = Math.round(13800 * frac);
    history.push(snapshot(out.results));
  }
  const dir = path.join(DATA, 'demo');
  await writeOutputs(dir, out, null);
  await writeFile(path.join(dir, 'history.json'), JSON.stringify(history));
  log(`demo data written to ${path.relative(ROOT, dir)}`);
  for (const p of out.results.parties.filter(p => p.seats)) log(`  ${p.en.padEnd(32)} ${String(p.seats).padStart(3)}  ${(p.pct * 100).toFixed(2)}%`);
}

// ---------------------------------------------------------------------------

if (flag('demo')) {
  await writeDemo();
} else {
  const watch = Number(opt('watch', 0));
  const durationMs = Number(opt('duration', 0)) * 60000;
  const t0 = Date.now();
  let changedAny = false;
  do {
    const changed = await runOnce();
    changedAny ||= changed;
    if (changed && flag('push')) gitPush();
    if (!watch || (durationMs && Date.now() - t0 + watch * 1000 > durationMs)) break;
    await new Promise(r => setTimeout(r, watch * 1000));
  } while (true);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changedAny}\n`);
}
