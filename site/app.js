import { STRINGS } from './i18n.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const state = {
  lang: params.get('lang') || store.get('lang') || 'he',
  demo: params.has('demo'),
  data: null,
  history: [],
  locs: [],
  highlight: null,
  showBelow: false,
  coal: new Set(),
  locQuery: '',
  locLimit: 25,
  nextFetch: 0,
  error: false,
};
const REFRESH_MS = 60_000;
const BLOC_ORDER = ['coalition', 'other', 'arab', 'opposition'];

const $ = id => document.getElementById(id);
const T = () => STRINGS[state.lang];
const fmt = n => new Intl.NumberFormat(T().locale).format(Math.round(n));
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tpl = (s, n) => s.replace('{n}', fmt(n));
const name = p => (state.lang === 'he' ? p.he : p.en);
const altName = p => (state.lang === 'he' ? p.en : p.he);
const leader = p => (state.lang === 'he' ? p.leaderHe : p.leaderEn);
const time = iso => new Date(iso).toLocaleString(T().locale, { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

// ---------------------------------------------------------------------------
// Data loading — GitHub Pages copy, plus the raw GitHub copy (updated the
// moment the workflow pushes, before Pages redeploys). The newer one wins.
// ---------------------------------------------------------------------------
function rawBase() {
  const meta = document.querySelector('meta[name="raw-base"]')?.content;
  if (meta) return meta;
  if (!location.hostname.endsWith('.github.io')) return null;
  const owner = location.hostname.split('.')[0];
  const seg = location.pathname.split('/').filter(Boolean)[0];
  const repo = seg && !seg.includes('.') ? seg : location.hostname;
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/site/data/`;
}

async function getJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function load() {
  const bases = state.demo ? ['data/demo/'] : ['data/', rawBase()].filter(Boolean);
  const got = await Promise.allSettled(bases.map(b => getJson(b + 'results.json').then(r => ({ b, r }))));
  const ok = got.filter(g => g.status === 'fulfilled').map(g => g.value);
  if (!ok.length) { state.error = true; render(); return; }
  const best = ok.sort((a, b) => new Date(b.r.updatedAt) - new Date(a.r.updatedAt))[0];
  const [h, l] = await Promise.allSettled([getJson(best.b + 'history.json'), getJson(best.b + 'localities.json')]);
  state.error = false;
  state.data = best.r;
  state.history = h.status === 'fulfilled' ? h.value : [];
  state.locs = l.status === 'fulfilled' ? l.value : [];
  render();
}

function schedule() {
  if (state.demo) return;
  state.nextFetch = Date.now() + REFRESH_MS;
  setTimeout(async () => { await load().catch(() => {}); schedule(); }, REFRESH_MS);
}

// ---------------------------------------------------------------------------
// Helpers on the data
// ---------------------------------------------------------------------------
const hasVotes = () => state.data && state.data.status !== 'waiting' && state.data.totals.valid > 0;
const seated = () => (state.data?.parties || []).filter(p => p.seats > 0);
const byId = id => state.data?.parties.find(p => p.id === id);
const blocMeta = k => state.data?.blocs?.[k] || { he: k, en: k, color: '#64748B', seats: 0 };

function seatOrder() {
  const rank = p => BLOC_ORDER.indexOf(p.bloc) < 0 ? 1 : BLOC_ORDER.indexOf(p.bloc);
  return [...seated()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? a.seats - b.seats : b.seats - a.seats));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function applyLang() {
  const t = T();
  document.documentElement.lang = state.lang;
  document.documentElement.dir = t.dir;
  document.title = state.lang === 'he' ? 'בחירות 2026 · תוצאות הבחירות לכנסת ה-26' : 'Israel Elections 2026 · 26th Knesset results';
  document.querySelectorAll('[data-t]').forEach(el => {
    const v = el.dataset.t.split('.').reduce((o, k) => o?.[k], t);
    if (typeof v === 'string') el.textContent = v;
  });
  $('locSearch').placeholder = t.search;
  $('srcLink').href = state.data?.election?.officialSite || 'https://votes26.bechirot.gov.il/';
  renderTheme();
}

function renderTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('themeIco').innerHTML = dark
    ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>';
  $('themeLabel').textContent = dark ? T().themeLight : T().themeDark;
  $('themeBtn').title = $('themeLabel').textContent;
}

function render() {
  applyLang();
  renderHero();
  if (!state.data) return;
  renderStats();
  renderHemicycle();
  renderBlocs();
  renderParties();
  renderCoalition();
  renderChart();
  renderLocalities();
}

function renderHero() {
  const t = T();
  const d = state.data;
  const s = state.error && !d ? 'stale' : d?.status || 'loading';
  const before = d && d.status === 'waiting' && Date.now() < new Date(d.election.pollsClose).getTime();
  $('status').dataset.s = s;
  $('statusText').textContent = state.error && !d ? t.error : before ? t.status.before : t.status[s] || t.loading;

  const meta = [];
  if (d?.updatedAt && d.status !== 'waiting') meta.push(`<span>${t.updated} <b>${time(d.updatedAt)}</b></span>`);
  if (!state.demo && state.nextFetch) meta.push(`<span>${t.nextCheck} <b>${Math.max(0, Math.ceil((state.nextFetch - Date.now()) / 1000))}</b> ${t.seconds}</span>`);
  $('heroMeta').innerHTML = meta.join('<span aria-hidden="true">·</span>');

  const banner = $('banner');
  banner.className = 'banner';
  banner.style.flexDirection = '';
  if (state.demo) {
    banner.hidden = false;
    banner.classList.add('demo');
    banner.innerHTML = `<span>${t.demoBanner}</span><a class="btn" href="?${state.lang === 'en' ? 'lang=en' : ''}">${t.demoExit}</a>`;
  } else if (d?.status === 'waiting') {
    banner.hidden = false;
    const cd = before ? countdown(new Date(d.election.pollsClose).getTime() - Date.now()) : '';
    banner.innerHTML = `${cd}<span>${t.waitingBody}</span><a class="btn" href="?demo=1${state.lang === 'en' ? '&lang=en' : ''}">${t.demoOpen}</a>`;
    banner.style.flexDirection = 'column';
  } else {
    banner.hidden = true;
  }
}

function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const parts = state.lang === 'he' ? ['שעות', 'דקות', 'שניות'] : ['hours', 'min', 'sec'];
  const v = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return `<div class="countdown">${v.map((x, i) => `<div><b>${String(x).padStart(2, '0')}</b><span>${parts[i]}</span></div>`).join('')}</div>`;
}

function renderStats() {
  const t = T().stats;
  const d = state.data;
  const live = hasVotes();
  const tot = d.totals;
  const dash = '—';
  const turnout = tot.turnout || 0;
  const C = 2 * Math.PI * 18;
  const tiles = [
    { k: t.valid, v: live ? fmt(tot.valid) : dash },
    {
      k: t.turnout, v: live ? pct(turnout, 1) : dash, h: t.turnoutHint,
      ring: `<svg class="ring" viewBox="0 0 44 44"><defs><linearGradient id="ringGrad"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#A855F7"/></linearGradient></defs><circle class="track" cx="22" cy="22" r="18"/><circle class="val" cx="22" cy="22" r="18" ${turnout ? '' : 'visibility="hidden"'} stroke-dasharray="${C * turnout} ${C}" transform="rotate(-90 22 22)"/></svg>`,
    },
    tot.ballotBoxesReported
      ? { k: t.boxes, v: live ? fmt(tot.ballotBoxesReported) : dash, h: tot.ballotBoxes > tot.ballotBoxesReported ? `/ ${fmt(tot.ballotBoxes)}` : '' }
      : { k: t.localities, v: live ? fmt(tot.localities) : dash },
    { k: t.threshold, v: pct(d.election.threshold), h: live ? `${fmt(d.thresholdVotes)} ${t.thresholdHint}` : '' },
    { k: t.measure, v: live ? fmt(d.measure) : dash, h: t.measureHint },
  ];
  $('stats').innerHTML = tiles.map((x, i) => `<div class="stat reveal" style="animation-delay:${i * 60}ms">${x.ring || ''}<div class="k">${x.k}</div><div class="v">${x.v}</div><div class="h">${x.h || '&nbsp;'}</div></div>`).join('');
}

// --- hemicycle -------------------------------------------------------------
const SEATS = (() => {
  const total = 120, rows = 6, cx = 200, cy = 200, R = 188, r0 = 0.42;
  const radii = Array.from({ length: rows }, (_, i) => r0 + (1 - r0) * (i / (rows - 1)));
  const sum = radii.reduce((a, b) => a + b, 0);
  const counts = radii.map(r => Math.round((total * r) / sum));
  counts[rows - 1] += total - counts.reduce((a, b) => a + b, 0);
  // rows[i] = seats of row i, ordered left → right.
  const rowsPts = radii.map((r, i) => Array.from({ length: counts[i] }, (_, j) => {
    const a = Math.PI * (1 - j / (counts[i] - 1));
    return { x: cx + R * r * Math.cos(a), y: cy - R * r * Math.sin(a) };
  }));
  return { rows: rowsPts, counts };
})();
let lastSeatKey = '';

// Assigns parties to seats as clean wedges: every party gets a contiguous run in
// each row, proportional to the row length, with exact seat totals.
function wedgeColors(order) {
  const { rows, counts } = SEATS;
  const out = rows.map(r => new Array(r.length).fill(null));
  let prev = counts.map(() => 0);
  let cum = 0;
  for (const p of order) {
    cum += p.seats;
    const ideal = counts.map(n => (n * cum) / 120);
    const b = ideal.map((x, i) => Math.max(prev[i], Math.floor(x)));
    let sum = b.reduce((s, v) => s + v, 0);
    while (sum < cum) {
      let bi = -1;
      b.forEach((v, i) => { if (v < counts[i] && (bi < 0 || ideal[i] - v > ideal[bi] - b[bi])) bi = i; });
      b[bi]++; sum++;
    }
    while (sum > cum) {
      let bi = -1;
      b.forEach((v, i) => { if (v > prev[i] && (bi < 0 || ideal[i] - v < ideal[bi] - b[bi])) bi = i; });
      b[bi]--; sum--;
    }
    b.forEach((end, i) => { for (let j = prev[i]; j < end; j++) out[i][j] = p; });
    prev = b;
  }
  return out;
}

function renderHemicycle() {
  const t = T();
  const rtl = t.dir === 'rtl';
  const order = seatOrder();
  const colors = wedgeColors(order);
  const key = order.map(p => p.id + p.seats).join() + state.lang;
  const animate = key !== lastSeatKey;
  lastSeatKey = key;

  const svg = $('hemi');
  const seats = [];
  SEATS.rows.forEach((row, i) => row.forEach((pt, j) => {
    // RTL: the first party starts on the right, matching the reading direction.
    const p = colors[i][rtl ? row.length - 1 - j : j];
    const delay = animate ? Math.round((j / row.length) * 700 + i * 40) : 0;
    seats.push(`<circle class="seat${p ? '' : ' empty'}${p && state.highlight === p.id ? ' hl' : ''}${animate ? ' pop' : ''}" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="7.6" ${p ? `fill="${p.color}" data-id="${esc(p.id)}"` : ''} style="animation-delay:${delay}ms"/>`);
  }));
  svg.innerHTML = `<title id="hemiTitle">${esc(t.knesset)}</title>` + seats.join('') + '<line class="maj" x1="200" y1="8" x2="200" y2="120"/>';
  svg.classList.toggle('dim', !!state.highlight);

  const blocs = Object.entries(state.data.blocs).filter(([, b]) => b.seats > 0).sort((a, b) => b[1].seats - a[1].seats);
  const hl = state.highlight && byId(state.highlight);
  if (hl) {
    $('hemiCenter').innerHTML = `<b style="color:${hl.color}">${hl.seats}</b><span>${esc(name(hl))}</span>`;
  } else if (blocs.length) {
    const [k, b] = blocs[0];
    $('hemiCenter').innerHTML = `<b style="color:${b.color}">${b.seats}</b><span>${esc(state.lang === 'he' ? b.he : b.en)}</span>`;
  } else {
    $('hemiCenter').innerHTML = `<b>120</b><span>${t.seats}</span>`;
  }

  $('legend').innerHTML = order.map(p => `<button type="button" data-id="${esc(p.id)}" class="${state.highlight === p.id ? 'on' : ''}"><i style="background:${p.color}"></i>${esc(name(p))} <b>${p.seats}</b></button>`).join('');
}

function bindHemicycle() {
  const tip = $('tip');
  const wrap = document.querySelector('.hemi-wrap');
  $('hemi').addEventListener('pointermove', e => {
    const id = e.target.dataset?.id;
    if (!id) { tip.hidden = true; return; }
    const p = byId(id);
    const r = wrap.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${e.clientX - r.left}px`;
    tip.style.top = `${e.clientY - r.top}px`;
    tip.innerHTML = `<span style="color:${p.color}">●</span> ${esc(name(p))} · <b>${p.seats}</b> ${T().seats}`;
  });
  $('hemi').addEventListener('pointerleave', () => (tip.hidden = true));
  $('hemi').addEventListener('click', e => e.target.dataset?.id && toggleHighlight(e.target.dataset.id));
  $('legend').addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) toggleHighlight(b.dataset.id);
  });
}

function toggleHighlight(id) {
  state.highlight = state.highlight === id ? null : id;
  renderHemicycle();
  renderParties();
}

// --- blocs -----------------------------------------------------------------
function renderBlocs() {
  const t = T();
  const blocs = BLOC_ORDER.map(k => [k, blocMeta(k)]).filter(([k, b]) => k !== 'other' || b.seats > 0);
  const total = blocs.reduce((s, [, b]) => s + b.seats, 0) || 1;
  const stack = `<div class="stack">${blocs.filter(([, b]) => b.seats).map(([, b]) => `<span style="flex-grow:${b.seats};background:${b.color}" title="${esc(state.lang === 'he' ? b.he : b.en)}">${b.seats}</span>`).join('')}</div>`;
  const rows = blocs.map(([k, b]) => {
    const members = (state.data.parties || []).filter(p => p.bloc === k && p.seats > 0);
    const segs = members.map(p => `<span style="width:${(p.seats / Math.max(b.seats, 1)) * 100}%;background:${p.color}" title="${esc(name(p))} ${p.seats}"></span>`).join('');
    return `<div class="bloc">
      <div class="bloc-top"><span><i style="background:${b.color}"></i>${esc(state.lang === 'he' ? b.he : b.en)}</span><b>${b.seats} <small>${t.seats}</small></b></div>
      <div class="track"><div class="fill" style="width:${(b.seats / 120) * 100}%">${segs}</div><div class="mark"></div></div>
    </div>`;
  }).join('');
  $('blocs').innerHTML = (total > 1 ? stack : '') + rows;

  const pairs = (state.data.agreements || []).map(([a, b]) => [byId(a), byId(b)]).filter(([a, b]) => a && b && (a.bloc !== 'other' || b.bloc !== 'other'));
  $('surplus').innerHTML = `<h3>${t.surplus}</h3><ul>${pairs.map(([a, b]) => `<li><i style="background:${a.color}"></i>${esc(name(a))} ⇄ <i style="background:${b.color}"></i>${esc(name(b))}</li>`).join('')}</ul>`;
}

// --- parties ---------------------------------------------------------------
function partyRow(p, i) {
  const t = T();
  const live = hasVotes();
  const th = state.data.election.threshold;
  const maxPct = Math.max(0.2, ...state.data.parties.map(x => x.pct)) * 1.05;
  let delta;
  if (p.seats2022 == null) delta = `<span class="delta new">${t.newList}</span>`;
  else if (!live) delta = `<span class="delta same">${p.seats2022}</span>`;
  else {
    const dd = p.seats - p.seats2022;
    delta = `<span class="delta ${dd > 0 ? 'up' : dd < 0 ? 'down' : 'same'}">${dd > 0 ? '▲ ' + dd : dd < 0 ? '▼ ' + -dd : '='}</span>`;
  }
  const hints = [];
  if (live && p.toGain) hints.push(`<span>${p.passed ? '↑' : '⚑'} ${tpl(p.passed ? t.toGain : t.toPass, p.toGain)}</span>`);
  if (live && p.toLose) hints.push(`<span>↓ ${tpl(t.toLose, p.toLose)}</span>`);
  const sub = [leader(p), altName(p)].filter(Boolean).join(' · ');
  return `<button type="button" class="party reveal${p.passed || !live ? '' : ' below'}${state.highlight === p.id ? ' on' : ''}" data-id="${esc(p.id)}" style="--c:${p.color};--th:${(th / maxPct) * 100}%;animation-delay:${Math.min(i, 14) * 35}ms">
    <span class="bar"></span>
    <span class="nm"><b>${esc(name(p))}<span class="tag">${esc(p.id)}</span></b><small>${esc(sub)}</small></span>
    <span class="pctcol"><span class="row"><b>${live ? pct(p.pct) : '—'}</b><span>${live ? fmt(p.votes) : ''}</span></span><span class="pbar"><span style="width:${(p.pct / maxPct) * 100}%"></span><i></i></span></span>
    <span class="seats"><b>${live ? p.seats : '—'}</b><small>${t.seats}</small></span>
    ${delta}
    ${hints.length ? `<span class="hint">${hints.join('')}</span>` : ''}
  </button>`;
}

function renderParties() {
  const t = T();
  const live = hasVotes();
  const all = state.data.parties || [];
  let main, below;
  if (live) {
    main = all.filter(p => p.passed);
    below = all.filter(p => !p.passed && p.votes > 0);
  } else {
    main = all.filter(p => p.bloc !== 'other' || p.id === 'ך');
    below = [];
  }
  let html = main.map(partyRow).join('');
  if (state.showBelow && below.length) html += `<div class="sep">${t.belowThreshold}</div>` + below.map((p, i) => partyRow(p, i + main.length)).join('');
  $('parties').innerHTML = html;
  const btn = $('belowBtn');
  btn.hidden = !below.length;
  btn.textContent = `${state.showBelow ? t.hideBelow : t.showBelow} (${below.length})`;
}

// --- coalition builder -----------------------------------------------------
function renderCoalition() {
  const t = T();
  const parties = seated();
  for (const id of [...state.coal]) if (!byId(id)?.seats) state.coal.delete(id);
  const total = parties.filter(p => state.coal.has(p.id)).reduce((s, p) => s + p.seats, 0);
  const has = total >= 61;
  const sel = parties.filter(p => state.coal.has(p.id));
  $('coalMeter').innerHTML = `
    <div class="coal-num"><b>${total}</b><span class="of">/ 120</span>
      <span class="badge ${has ? 'yes' : 'no'}">${has ? '✓ ' + t.coalitionHas : tpl(t.coalitionMissing, 61 - total)}</span></div>
    <div class="track"><div class="fill" style="width:${(total / 120) * 100}%">${sel.map(p => `<span style="width:${(p.seats / Math.max(total, 1)) * 100}%;background:${p.color}"></span>`).join('')}</div><div class="mark"></div></div>`;
  const presets = [
    ['coalition', ['coalition']],
    ['opposition', ['opposition']],
    ['opposition+arab', ['opposition', 'arab']],
  ].filter(([, bl]) => parties.some(p => bl.includes(p.bloc)));
  $('presets').innerHTML = parties.length ? `<small>${t.presets}:</small>` + presets.map(([k, bl]) => `<button type="button" data-preset="${bl.join(',')}">${bl.map(b => esc(state.lang === 'he' ? blocMeta(b).he : blocMeta(b).en)).join(' + ')}</button>`).join('') : '';
  $('coalChips').innerHTML = parties.length
    ? parties.map(p => `<button type="button" class="cchip" style="--c:${p.color}" data-id="${esc(p.id)}" aria-pressed="${state.coal.has(p.id)}"><i></i>${esc(name(p))}<em>${p.seats}</em></button>`).join('')
    : `<div class="empty">${t.status.waiting}</div>`;
}

// --- count progress chart --------------------------------------------------
function renderChart() {
  const t = T();
  const h = state.history.filter(x => x.valid > 0);
  const el = $('chart');
  if (h.length < 2) { el.innerHTML = `<div class="empty">${hasVotes() ? '…' : t.status.waiting}</div>`; return; }
  const ids = seated().map(p => p.id);
  const W = 520, H = 260, L = 28, Rm = 96, Tm = 12, B = 26;
  const xs = h.map(x => x.valid);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const maxY = Math.max(10, ...h.flatMap(x => Object.values(x.seats))) + 2;
  const X = v => L + ((v - x0) / Math.max(1, x1 - x0)) * (W - L - Rm);
  const Y = v => Tm + (1 - v / maxY) * (H - Tm - B);
  const grid = [];
  for (let v = 0; v <= maxY; v += maxY > 30 ? 10 : 5) grid.push(`<line class="gl" x1="${L}" x2="${W - Rm}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`);
  const xl = `<text class="axis" x="${L}" y="${H - 6}">${fmt(x0)}</text><text class="axis" x="${W - Rm}" y="${H - 6}" text-anchor="end">${fmt(x1)}</text>`;
  // Labels at the line ends, nudged apart so they don't overlap.
  const ends = ids.map(id => ({ p: byId(id), y: Y(h[h.length - 1].seats[id] || 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const lines = ids.map(id => {
    const p = byId(id);
    const d = h.map((x, i) => `${i ? 'L' : 'M'}${X(x.valid).toFixed(1)},${Y(x.seats[id] || 0).toFixed(1)}`).join('');
    return `<path class="ln" d="${d}" stroke="${p.color}" opacity="${state.highlight && state.highlight !== id ? 0.15 : 1}"/>`;
  }).join('');
  const labels = ends.map(({ p, y }) => `<text class="lb" x="${W - Rm + 8}" y="${y + 4}" fill="${p.color}">${p.seats} ${esc(name(p).slice(0, 14))}</text>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" direction="ltr" role="img" aria-label="${esc(t.progress)}">${grid.join('')}${xl}${lines}${labels}</svg>`;
}

// --- localities ------------------------------------------------------------
function renderLocalities() {
  const t = T();
  const q = state.locQuery.trim();
  const rows = state.locs.filter(l => l.name && l.valid > 0 && (!q || l.name.includes(q)));
  if (!rows.length) { $('loc').innerHTML = `<div class="empty">${t.noLoc}</div>`; $('locMore').hidden = true; return; }
  const show = rows.slice(0, state.locLimit);
  $('loc').innerHTML = `<table><thead><tr><th>${t.colLoc.name}</th><th class="hide-sm">${t.colLoc.turnout}</th><th class="hide-sm">${t.colLoc.valid}</th><th>${t.colLoc.leader}</th></tr></thead><tbody>${show.map(l => {
    const top = l.top.map(([id, v]) => ({ p: byId(id) || { color: '#64748B', he: id, en: id }, v }));
    const lead = top[0];
    return `<tr><td class="n">${esc(l.name)}</td><td class="hide-sm">${l.eligible ? pct(l.voters / l.eligible, 1) : '—'}</td><td class="hide-sm">${fmt(l.valid)}</td>
      <td>${lead ? `<div class="lead"><i style="background:${lead.p.color}"></i>${esc(name(lead.p))} · ${pct(lead.v / l.valid, 0)}</div>` : ''}
      <div class="mini">${top.map(({ p, v }) => `<span style="width:${(v / l.valid) * 100}%;background:${p.color}" title="${esc(name(p))} ${pct(v / l.valid, 1)}"></span>`).join('')}</div></td></tr>`;
  }).join('')}</tbody></table>`;
  $('locMore').hidden = rows.length <= state.locLimit;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function bind() {
  $('langBtn').addEventListener('click', () => {
    state.lang = state.lang === 'he' ? 'en' : 'he';
    store.set('lang', state.lang);
    const u = new URL(location.href);
    u.searchParams.delete('lang');
    if (state.lang === 'en') u.searchParams.set('lang', 'en');
    history.replaceState(null, '', u);
    render();
  });
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#070B18' : '#F4F6FC';
    store.set('theme', next);
    renderTheme();
  });
  $('parties').addEventListener('click', e => {
    const b = e.target.closest('.party');
    if (b) toggleHighlight(b.dataset.id);
  });
  $('belowBtn').addEventListener('click', () => { state.showBelow = !state.showBelow; renderParties(); });
  $('coalChips').addEventListener('click', e => {
    const b = e.target.closest('.cchip');
    if (!b) return;
    state.coal.has(b.dataset.id) ? state.coal.delete(b.dataset.id) : state.coal.add(b.dataset.id);
    renderCoalition();
  });
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const blocs = b.dataset.preset.split(',');
    state.coal = new Set(seated().filter(p => blocs.includes(p.bloc)).map(p => p.id));
    renderCoalition();
  });
  $('clearCoal').addEventListener('click', () => { state.coal.clear(); renderCoalition(); });
  $('locSearch').addEventListener('input', e => { state.locQuery = e.target.value; state.locLimit = 25; renderLocalities(); });
  $('locMore').addEventListener('click', () => { state.locLimit += 50; renderLocalities(); });
  bindHemicycle();
  // Clock tick: countdown + "next check in".
  setInterval(() => renderHero(), 1000);
}

bind();
applyLang();
load().catch(() => { state.error = true; render(); }).finally(schedule);
