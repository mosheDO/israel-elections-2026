// End-to-end check of the fetcher's parsing with a CSV that uses the real 2026
// expb.csv header (published by the CEC on 2026-10-13). Writes to a temp copy
// of the repo so site/data is untouched.
//   node scripts/test-parse.mjs
import { mkdtemp, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'elections-'));
for (const d of ['scripts', 'config']) await cp(path.join(ROOT, d), path.join(tmp, d), { recursive: true });

// Offline: only the local raw/ files.
const cfgPath = path.join(tmp, 'config', 'election-2026.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
cfg.sources = { localities: ['raw/expc.csv'], ballots: ['raw/expb.csv'] };
await writeFile(cfgPath, JSON.stringify(cfg));

const header = 'סמל ועדה,ברזל,שם ישוב,סמל ישוב,קלפי,ריכוז,שופט,בזב,מצביעים,פסולים,כשרים,חיצוניות,קלפי אחרת,אמת,ב,בד,בי,בקר,ג,ד,די,דרך,ה,ודם,ז,זך,זץ,ט,י,יק,ך,כן,ל,מחל,ני,נף,נץ,נקי,נר,עם,פה,צבי,צדק,צף,ק,קה,קך,קץ,רץ,רק,שס,';
const cols = header.split(',');
const parties = cols.slice(13).filter(Boolean);
const share = { 'מחל': 22, 'דרך': 20, 'רק': 14, 'אמת': 8, 'שס': 7, 'ג': 6, 'ב': 6, 'ט': 5, 'ל': 6, 'ודם': 5, 'עם': 4, 'די': 2, 'צבי': 1 };
const rows = [];
for (let b = 1; b <= 40; b++) {
  const valid = 500;
  const votes = parties.map(p => Math.round((share[p] || 0) * valid / 106));
  const sum = votes.reduce((a, c) => a + c, 0);
  const city = b <= 20 ? ['ירושלים', 3000] : ['"תל אביב - יפו"', 5000];
  rows.push([1, '', city[0], city[1], b + '.0', 1, 1, 700, sum + 3, 3, sum, 0, 0, ...votes, ''].join(','));
}
const csv = '﻿' + [header, ...rows].join('\r\n') + '\r\n';
await mkdir(path.join(tmp, 'raw'), { recursive: true });
await writeFile(path.join(tmp, 'raw', 'expb.csv'), csv);

const out = execFileSync(process.execPath, [path.join(tmp, 'scripts', 'fetch-results.mjs')], { encoding: 'utf8' });
console.log(out.trim());
const res = JSON.parse(await readFile(path.join(tmp, 'site', 'data', 'results.json'), 'utf8'));
const locs = JSON.parse(await readFile(path.join(tmp, 'site', 'data', 'localities.json'), 'utf8'));
const seatSum = res.parties.reduce((s, p) => s + p.seats, 0);
const unknown = res.parties.find(p => p.id === 'צבי');
const checks = [
  ['status is live', res.status === 'live'],
  ['120 seats allocated', seatSum === 120],
  ['meta columns not treated as parties', !res.parties.some(p => ['חיצוניות', 'קלפי אחרת', 'ברזל', 'קלפי'].includes(p.id))],
  ['unknown letters kept with fallback name', unknown && unknown.he === 'רשימה צבי'],
  ['ballot boxes counted', res.totals.ballotBoxesReported === 40],
  ['quoted locality name parsed', locs.some(l => l.name === 'תל אביב - יפו')],
  ['valid votes summed', res.totals.valid === locs.reduce((s, l) => s + l.valid, 0)],
];
let ok = true;
for (const [n, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${n}`); ok &&= pass; }
if (!ok) process.exit(1);
console.log('PASSED');
