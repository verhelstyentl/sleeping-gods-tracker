'use strict';

// Repo settings for saving. On <owner>.github.io/<repo>/ owner and repo are detected automatically.
const CONFIG = { owner: '', repo: '', branch: 'main', path: 'data.json', atlas: 'atlas.json' };

const LS = { token: 'sgt-token', repo: 'sgt-repo', draft: 'sgt-draft' };
const TABS = ['overview', 'locations', 'keywords'];
const STATUS = { ready: 'Ready', locked: 'Needs keyword', cleared: 'Done' };
const STATUS_ORDER = { ready: 0, locked: 1, cleared: 2 };

let data = emptyData();
let atlas = {}; // location number -> { page, name } from atlas.json
let mode = 'view'; // 'view' | 'local' | 'github'
let conn = null;
let remoteSha = null;
let dirty = false;
let saving = false;
let queuedSave = null; // commit message of a save requested while another was running
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
const ui = { q: '', status: 'all', sort: 'visited' };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = k => String(k ?? '').trim().toUpperCase();
const splitKw = s => s.split(/[,+]/).map(norm).filter(Boolean);
const uid = () => Math.random().toString(36).slice(2, 10);
const num = v => (v === '' || v == null || isNaN(v)) ? Infinity : Number(v);
const byNumber = (a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
const fmtDate = d => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
// A datetime-local input wants local time without a zone, e.g. 2026-11-20T21:30.
const localInput = d => { const t = new Date(d); return new Date(t - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const editing = () => mode !== 'view';

function emptyData() {
  return { version: 4, updatedAt: null, keywords: [], locations: [] };
}

// A quest is a keyword plus its quest card number; gainedAt links it to the location that gave it.
function migrate(d) {
  const keywords = (d.keywords ?? []).map(k => ({ name: norm(k.name), quest: String(k.quest ?? ''), done: !!k.done, gainedAt: locNumber(k.gainedAt ?? ''), note: k.note ?? '' })).filter(k => k.name);
  const locations = (d.locations ?? []).map(l => {
    const number = locNumber(l.number ?? '');
    let notes = l.notes ?? '';
    // Version 4 notes ports and other map notes; add them once to locations logged before that.
    if ((d.version ?? 1) < 4) notes = [...mapNotes(number).filter(m => !notes.toLowerCase().includes(m.toLowerCase())), notes].filter(Boolean).join('\n');
    // Version 1 stored quests on the location; fold them into the keyword list.
    for (const q of l.quests ?? []) {
      const name = norm(q.keyword);
      if (!name) { notes = [notes, `Quest: ${q.name}`].filter(Boolean).join('\n'); continue; }
      let k = keywords.find(x => x.name === name);
      if (!k) keywords.push(k = { name, quest: '', done: false, gainedAt: '', note: '' });
      k.quest ||= /^#?\d+$/.test(String(q.name ?? '').trim()) ? String(q.name).trim().replace(/^#/, '') : '';
      k.gainedAt ||= number;
      k.done ||= !!q.done;
    }
    return {
      // The id ends up in HTML attributes; anything but a plain uid() gets a new one.
      id: typeof l.id === 'string' && /^[a-z0-9]+$/i.test(l.id) ? l.id : uid(),
      number,
      name: l.name ?? '',
      atlasPage: String(l.atlasPage ?? ''),
      options: (l.options ?? []).map(o => ({ keywords: (o.keywords ?? []).map(norm).filter(Boolean), done: !!o.done, note: o.note ?? '' })),
      adventures: (l.adventures ?? []).map(a => ({ card: cardNumber(a.card ?? ''), name: a.name ?? a.note ?? '' })).filter(a => a.card),
      notes,
      dungeonDone: !!l.dungeonDone,
      // Visits came after locations; until then, adding a location meant we had just been there.
      visits: (l.visits ?? [l.created]).filter(Boolean).sort(),
      created: l.created ?? '',
      updated: l.updated ?? '',
    };
  });
  return { version: 4, updatedAt: d.updatedAt ?? null, keywords, locations };
}

// ---------- Derived state ----------

const owned = () => new Map(data.keywords.map(k => [k.name, k]));
const locNumber = s => String(s).trim().replace(/^#/, '').toUpperCase();
const cardNumber = s => String(s).trim().replace(/^#/, '');
const mapEntry = n => atlas[locNumber(n)] ?? {};
const atlasOf = loc => loc.atlasPage || mapEntry(loc.number).page || '';
const hasDungeon = loc => !!mapEntry(loc.number).dungeon;
const lastVisit = loc => loc.visits.at(-1) ?? '';
// Notes a location starts with, from the map: its port and any extra note (e.g. 188's zoo).
const mapNotes = n => [mapEntry(n).port && `Port: ${mapEntry(n).name}`, mapEntry(n).note].filter(Boolean);

function optionState(o, have) {
  if (o.done) return 'done';
  return o.keywords.every(k => have.has(k)) ? 'open' : 'locked';
}

function locationStatus(loc, have) {
  const states = loc.options.map(o => optionState(o, have));
  if (states.includes('open') || (hasDungeon(loc) && !loc.dungeonDone)) return 'ready';
  if (states.includes('locked')) return 'locked';
  return 'cleared';
}

const questsAt = loc => data.keywords.filter(k => k.gainedAt === loc.number);
const byQuest = (a, b) => (a.done - b.done) || (num(a.quest) - num(b.quest)) || a.name.localeCompare(b.name);

// Keywords that unticked options need but we don't have yet.
function wantedKeywords(have) {
  const map = new Map();
  for (const loc of data.locations) {
    for (const o of loc.options) {
      if (o.done) continue;
      for (const k of o.keywords) {
        if (have.has(k)) continue;
        if (!map.has(k)) map.set(k, { name: k, locs: new Map() });
        map.get(k).locs.set(loc.id, loc);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const usages = name => data.locations.flatMap(loc => loc.options.filter(o => o.keywords.includes(name)).map(o => ({ loc, o })));

function matches(loc, q) {
  if (!q) return true;
  if (q.startsWith('#')) return loc.number === locNumber(q);
  const hay = [
    loc.number, loc.name || mapEntry(loc.number).name, loc.notes, atlasOf(loc) && 'p' + atlasOf(loc),
    ...loc.options.flatMap(o => [...o.keywords, o.note]),
    ...loc.adventures.flatMap(a => ['adventure ' + a.card, a.name]),
    hasDungeon(loc) && 'dungeon',
    ...questsAt(loc).flatMap(k => [k.name, k.quest && 'card' + k.quest]),
  ].join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

// ---------- Rendering helpers ----------

function kwChip(k, have) {
  const h = have.get(k);
  const title = h ? `We have this keyword · ${h.quest ? `quest card #${h.quest}` : 'card # unknown'}` : 'We don’t have this keyword yet';
  return `<span class="kw ${h ? 'have' : 'miss'}" title="${esc(title)}">${esc(k)}</span>`;
}

const optChips = (o, have) => o.keywords.length
  ? `<span class="chips">${o.keywords.map(k => kwChip(k, have)).join('<span class="plus">+</span>')}</span>`
  : `<span class="chips"><span class="kw none" title="No keyword needed">none</span></span>`;

function tick(on, action, attrs, label) {
  if (!editing()) return `<span class="tick ${on ? 'on' : ''}" role="img" aria-label="${on ? 'Done' : 'Not done'}"></span>`;
  return `<button class="tick ${on ? 'on' : ''}" data-action="${action}" ${attrs} aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}"></button>`;
}

const locRef = (loc, done = false) =>
  `<button class="locref ${done ? 'done' : ''}" data-action="goto-loc" data-loc="${esc(loc.id)}" title="${esc(loc.name)}">#${esc(loc.number)}</button>`;

function locRefByNumber(n) {
  const loc = data.locations.find(l => l.number === locNumber(n));
  return loc ? locRef(loc) : `#${esc(n)}`;
}

const locTitle = loc => esc(loc.name || mapEntry(loc.number).name || `Location ${loc.number}`);
const empty = msg => `<p class="empty">${msg}</p>`;

const advChip = a => `<span class="adv" title="Adventure card ${esc(a.card)}">#${esc(a.card)}</span>`;
const cardLabel = k => `<span class="meta">${k.quest ? `card #${esc(k.quest)}` : '<span class="hint">card # unknown</span>'}</span>`;
const kwTick = k => tick(k.done, 'toggle-kw', `data-kw="${esc(k.name)}"`, k.done ? 'Mark quest open' : 'Mark quest complete');

function questItem(k, have) {
  return `<li class="${k.done ? 'done' : ''}">
    ${kwTick(k)}
    ${kwChip(k.name, have)}
    ${cardLabel(k)}
    ${k.gainedAt ? `<span class="meta push">from ${locRefByNumber(k.gainedAt)}</span>` : ''}
  </li>`;
}

function wantedList(wanted, have) {
  if (!wanted.length) return empty('Nothing — no location is waiting on a keyword we lack.');
  return `<ul class="list">${wanted.map(w => `<li>
    ${kwChip(w.name, have)}
    <span class="meta">needed at ${[...w.locs.values()].sort(byNumber).map(l => locRef(l)).join(' ')}</span>
    ${editing() ? `<button class="btn sm push" data-action="got-kw" data-kw="${esc(w.name)}">We got it</button>` : ''}
  </li>`).join('')}</ul>`;
}

// ---------- Views ----------

function viewOverview(have) {
  const ready = data.locations.filter(l => locationStatus(l, have) === 'ready').sort(byNumber);
  const open = data.keywords.filter(k => !k.done).sort(byQuest);
  const stats = [
    [data.keywords.length, 'Keywords'],
    [data.locations.length, 'Locations'],
    [ready.length, 'Ready to visit'],
    [open.length, 'Open quests'],
  ].map(([n, label]) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`).join('');

  const readyHtml = ready.length ? `<ul class="list">${ready.map(loc => `<li>
      <button class="locrow" data-action="goto-loc" data-loc="${esc(loc.id)}">
        <span class="locnum sm">${esc(loc.number)}</span>
        <span><b>${locTitle(loc)}</b>${atlasOf(loc) ? `<small>Atlas p. ${esc(atlasOf(loc))}</small>` : ''}</span>
      </button>
      <span class="chips push">
        ${loc.options.filter(o => optionState(o, have) === 'open').map(o => optChips(o, have)).join('<span class="sep">or</span>')}
        ${hasDungeon(loc) && !loc.dungeonDone ? '<span class="dgn">Dungeon</span>' : ''}
      </span>
    </li>`).join('')}</ul>` : empty('Nothing waiting right now. New keywords will unlock more options.');

  const advs = data.locations.flatMap(loc => loc.adventures.map(a => ({ loc, a })))
    .sort((x, y) => (num(x.a.card) - num(y.a.card)) || byNumber(x.loc, y.loc));
  const advHtml = advs.length ? `<ul class="list">${advs.map(({ loc, a }) => `<li>
      ${advChip(a)}<span>${esc(a.name)}</span><span class="meta push">from ${locRef(loc)}</span>
    </li>`).join('')}</ul>` : empty('No adventure cards yet.');

  return `<div class="stats">${stats}</div>
    <div class="cols">
      <div>
        <section class="section"><h2>Ready to visit <small>options we can do now</small></h2>${readyHtml}</section>
        <section class="section"><h2>Adventure cards <small>${advs.length}</small></h2>${advHtml}</section>
      </div>
      <div>
        <section class="section"><h2>Open quests</h2>${open.length ? `<ul class="list">${open.map(k => questItem(k, have)).join('')}</ul>` : empty('No open quests.')}</section>
        <section class="section"><h2>Keywords we need</h2>${wantedList(wantedKeywords(have), have)}</section>
      </div>
    </div>`;
}

function locCard(loc, have) {
  const st = locationStatus(loc, have);
  const n = loc.visits.length;
  const edited = loc.updated || loc.created;
  const when = {
    visited: n && `${n > 1 ? `${n} visits, last` : 'visited'} ${fmtDate(lastVisit(loc))}`,
    added: loc.created && `added ${fmtDate(loc.created)}`,
    modified: edited && `edited ${fmtDate(edited)}`,
  }[ui.sort];
  const sub = [atlasOf(loc) && `Atlas p. ${esc(atlasOf(loc))}`, when].filter(Boolean).join(' · ');
  const opts = loc.options.map((o, i) => {
    const s = optionState(o, have);
    return `<li class="${s}">
      ${tick(o.done, 'toggle-opt', `data-loc="${esc(loc.id)}" data-i="${i}"`, o.done ? 'Mark option not done' : 'Tick off option')}
      ${optChips(o, have)}
      ${s === 'open' && o.keywords.length ? '<span class="avail">can do now</span>' : ''}
      ${o.note ? `<span class="note">${esc(o.note)}</span>` : ''}
    </li>`;
  }).join('');
  const advs = loc.adventures.map(a => `<li>${advChip(a)}${a.name ? `<span>${esc(a.name)}</span>` : ''}</li>`).join('');
  const quests = questsAt(loc).sort(byQuest).map(k => `<li class="${k.done ? 'done' : ''}">
      ${kwTick(k)}
      ${kwChip(k.name, have)}
      ${cardLabel(k)}
    </li>`).join('');
  return `<article class="card">
    <header>
      <span class="locnum">${esc(loc.number)}</span>
      <div class="title"><h3>${locTitle(loc)}${hasDungeon(loc) ? '<span class="dgn">Dungeon</span>' : ''}</h3>${sub ? `<span class="atlas">${sub}</span>` : ''}</div>
      <span class="status ${st}">${STATUS[st]}</span>
    </header>
    ${opts ? `<h4>Options</h4><ul>${opts}</ul>` : ''}
    ${quests ? `<h4>Quests</h4><ul>${quests}</ul>` : ''}
    ${advs ? `<h4>Adventure cards</h4><ul>${advs}</ul>` : ''}
    ${hasDungeon(loc) ? `<h4>Dungeon</h4><ul><li class="${loc.dungeonDone ? 'done' : ''}">
      ${tick(loc.dungeonDone, 'toggle-dungeon', `data-loc="${esc(loc.id)}"`, loc.dungeonDone ? 'Mark dungeon not done' : 'Tick off dungeon')}
      <span class="dgn">Dungeon</span>${loc.dungeonDone ? '' : '<span class="avail">can be done</span>'}
    </li></ul>` : ''}
    ${loc.notes ? `<p class="notes">${esc(loc.notes)}</p>` : ''}
    ${editing() ? `<div class="actions">
      <button class="link" data-action="edit-loc" data-loc="${esc(loc.id)}">Edit</button>
      <button class="link" data-action="visit" data-loc="${esc(loc.id)}" title="We were here again: log a visit now">Log visit</button>
    </div>` : ''}
  </article>`;
}

function locList(have) {
  if (!data.locations.length) return empty(editing() ? 'No locations yet — add the first one you visited.' : 'No locations logged yet.');
  const status = l => locationStatus(l, have);
  // Locations without timestamps predate them; array order is the order they were added.
  const index = new Map(data.locations.map((l, i) => [l, i]));
  const newest = time => (a, b) => (time(b) || '').localeCompare(time(a) || '') || index.get(b) - index.get(a);
  const sorters = {
    number: byNumber,
    visited: newest(lastVisit),
    added: newest(l => l.created),
    modified: newest(l => l.updated || l.created),
    atlas: (a, b) => (num(atlasOf(a)) - num(atlasOf(b))) || byNumber(a, b),
    status: (a, b) => (STATUS_ORDER[status(a)] - STATUS_ORDER[status(b)]) || byNumber(a, b),
  };
  const list = data.locations
    .filter(l => (ui.status === 'all' || status(l) === ui.status) && matches(l, ui.q.trim()))
    .sort(sorters[ui.sort]);
  return list.length ? `<div class="grid">${list.map(l => locCard(l, have)).join('')}</div>` : empty('No locations match.');
}

function viewLocations(have) {
  const counts = { all: data.locations.length, ready: 0, locked: 0, cleared: 0 };
  data.locations.forEach(l => counts[locationStatus(l, have)]++);
  const seg = ['all', 'ready', 'locked', 'cleared'].map(s =>
    `<button data-action="status" data-v="${s}" class="${ui.status === s ? 'active' : ''}">${s === 'all' ? 'All' : STATUS[s]} <span class="n">${counts[s]}</span></button>`).join('');
  const sorts = [['visited', 'Visited'], ['number', 'Number'], ['status', 'Status']]
    .map(([v, l]) => `<button data-action="sort" data-v="${v}" class="${ui.sort === v ? 'active' : ''}">${l}</button>`).join('');
  // Less used sorts sit in a menu, which shows "More…" until one of them is picked.
  const more = [['added', 'Added'], ['modified', 'Modified'], ['atlas', 'Atlas']];
  const inMore = more.some(([v]) => v === ui.sort);
  const moreSel = `<select data-input="sort" class="${inMore ? 'active' : ''}" aria-label="More sort options">
      <option value="" disabled hidden ${inMore ? '' : 'selected'}>More…</option>
      ${more.map(([v, l]) => `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>`;
  return `<div class="toolbar fill">
      <input class="search" type="search" data-input="q" value="${esc(ui.q)}" placeholder="Search… (#12 = exact)" title="Search number, name, keyword… (#12 = exact)" aria-label="Search locations">
      <div class="seg" role="group" aria-label="Filter by status">${seg}</div>
      <div class="seg" role="group" aria-label="Sort"><span class="lbl" aria-hidden="true">Sort</span>${sorts}${moreSel}</div>
      ${editing() ? '<button class="btn primary" data-action="new-loc">+ Location</button>' : ''}
    </div>
    <div id="locList">${locList(have)}</div>`;
}

function keywordTable(kws, have) {
  const withNotes = kws.some(k => k.note);
  const cell = (cls, label, html) => `<td class="${cls}${html ? '' : ' blank'}" data-label="${label}">${html || '—'}</td>`;
  const row = k => `<tr class="${k.done ? 'done' : ''}">
      <td class="c-tick">${kwTick(k)}</td>
      <td class="c-kw">${kwChip(k.name, have)}</td>
      <td class="c-card" data-label="Card">${k.quest ? `#${esc(k.quest)}` : '<span class="hint">?</span>'}</td>
      ${cell('c-gained', 'Gained at', k.gainedAt && locRefByNumber(k.gainedAt))}
      ${cell('c-used', 'Used at', usages(k.name).map(({ loc, o }) => locRef(loc, o.done)).join(''))}
      ${withNotes ? cell('c-note', 'Note', esc(k.note)) : ''}
      ${editing() ? `<td class="c-edit"><button class="link" data-action="edit-kw" data-kw="${esc(k.name)}">Edit</button></td>` : ''}
    </tr>`;
  const open = kws.filter(k => !k.done);
  const done = kws.filter(k => k.done);
  const cols = 5 + withNotes + editing();
  return `<table class="kwtable">
    <thead><tr>
      <th class="c-tick"><span class="sr-only">Complete</span></th><th>Keyword</th><th>Card</th><th>Gained at</th><th>Used at</th>
      ${withNotes ? '<th>Note</th>' : ''}${editing() ? '<th class="c-edit"><span class="sr-only">Edit</span></th>' : ''}
    </tr></thead>
    <tbody>${open.map(row).join('')}</tbody>
    ${done.length ? `<tbody><tr class="group"><th colspan="${cols}">Complete · ${done.length}</th></tr>${done.map(row).join('')}</tbody>` : ''}
  </table>`;
}

function viewKeywords(have) {
  const kws = [...data.keywords].sort(byQuest);
  const complete = kws.filter(k => k.done).length;
  const add = editing() ? `<form class="toolbar" data-form="add-kw">
      <input class="search" name="kw" list="kwAll" required autocomplete="off" placeholder="New keyword" aria-label="New keyword">
      <input class="search short" name="quest" autocomplete="off" placeholder="Card #" aria-label="Quest card number (if known)">
      <input class="search short" name="gainedAt" autocomplete="off" placeholder="Gained at #" aria-label="Gained at location number">
      <button class="btn primary">Add keyword</button>
    </form>` : '';
  return `${add}
    <section class="section"><h2>Keywords &amp; quests <small>${kws.length}${complete ? ` · ${complete} complete` : ''}</small></h2>${kws.length ? keywordTable(kws, have) : empty('No keywords yet.')}</section>
    <section class="section"><h2>Still looking for <small>needed by location options</small></h2>${wantedList(wantedKeywords(have), have)}</section>`;
}

const VIEWS = { overview: viewOverview, locations: viewLocations, keywords: viewKeywords };

function render() {
  const have = owned();
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.v === tab));
  const counts = { locations: data.locations.length, keywords: data.keywords.filter(k => !k.done).length };
  document.querySelectorAll('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count]; });
  $('#view').innerHTML = VIEWS[tab](have);
  $('#kwAll').innerHTML = [...new Set([...have.keys(), ...wantedKeywords(have).map(w => w.name)])].sort()
    .map(k => `<option value="${esc(k)}">`).join('');
  renderChrome();
}

function renderChrome() {
  $('#updated').textContent = data.updatedAt ? `Last saved ${fmtDate(data.updatedAt)}` : '';
  if (!editing()) {
    $('#topActions').innerHTML = '';
    $('#footActions').innerHTML = '<button class="link" data-action="editor">Editor login</button>';
    return;
  }
  const state = saving ? 'Saving…' : dirty ? 'Unsaved changes' : mode === 'github' ? 'All changes saved' : 'Editing locally';
  const label = mode === 'github' ? 'Save' : 'Download data.json';
  const disabled = saving || (mode === 'github' && !dirty);
  $('#topActions').innerHTML = `<span class="save-state ${dirty ? 'dirty' : ''}">${state}</span>
    <button class="btn ${dirty ? 'primary' : ''}" data-action="save" ${disabled ? 'disabled' : ''}>${label}</button>`;
  $('#footActions').innerHTML = `<button class="link" data-action="disconnect">${mode === 'github' ? `Log out (${esc(conn.owner)}/${esc(conn.repo)})` : 'Stop editing'}</button>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------- Mutations ----------

// Passing a message saves to GitHub right away, with that message as the commit message.
function commit(message) {
  dirty = true;
  store.set(LS.draft, JSON.stringify({ data, at: Date.now() }));
  render();
  if (message && mode === 'github') save(message);
}

const findLoc = id => data.locations.find(l => l.id === id);
const touch = loc => { loc.updated = new Date().toISOString(); commit(); };

function addKeyword(name, gainedAt = '', quest = '') {
  const n = norm(name);
  if (!n) return false;
  if (data.keywords.some(k => k.name === n)) { toast(`${n} is already in the list`); return false; }
  data.keywords.push({ name: n, quest: cardNumber(quest), done: false, gainedAt: locNumber(gainedAt), note: '' });
  commit(`Add keyword ${n}`);
  toast(`Added ${n}`);
  return true;
}

function renameKeyword(from, to) {
  for (const loc of data.locations) {
    loc.options.forEach(o => { o.keywords = o.keywords.map(k => k === from ? to : k); });
  }
}

// ---------- Location dialog ----------

const optRowHtml = (o, kind) => `<li data-kind="${kind}">
  <label class="c-chk"><input type="checkbox" name="done" ${o.done ? 'checked' : ''}>Done</label>
  <span class="c-main">${kind === 'none'
    ? '<span class="kw none">none</span><span class="hint">no keyword needed</span>'
    : `<input name="keywords" list="kwAll" autocomplete="off" value="${esc(o.keywords.join(', '))}" placeholder="KEYWORD (comma for several)" aria-label="Keywords">`}</span>
  <input class="c-extra" name="note" autocomplete="off" value="${esc(o.note)}" placeholder="Note" aria-label="Note">
  <button type="button" class="c-x" data-action="remove-row" aria-label="Remove">✕</button>
</li>`;

const advRowHtml = a => `<li data-kind="adv">
  <span class="c-main"><input name="card" autocomplete="off" inputmode="numeric" value="${esc(a.card)}" placeholder="Adventure card #" aria-label="Adventure card number"></span>
  <input class="c-extra" name="advname" autocomplete="off" value="${esc(a.name)}" placeholder="Name" aria-label="Adventure card name">
  <button type="button" class="c-x" data-action="remove-row" aria-label="Remove">✕</button>
</li>`;

// The row keeps the exact timestamp, so saving doesn't round untouched visits to the minute.
const visitRowHtml = iso => `<li data-kind="visit" data-iso="${esc(iso)}">
  <span class="c-main"><input type="datetime-local" name="visit" value="${localInput(iso)}" aria-label="Visited at"></span>
  <button type="button" class="c-x" data-action="remove-row" aria-label="Remove">✕</button>
</li>`;

const questRowHtml = k => `<li data-kind="quest">
  <label class="c-chk"><input type="checkbox" name="done" ${k.done ? 'checked' : ''}>Done</label>
  <span class="c-main"><input name="qkw" list="kwAll" autocomplete="off" value="${esc(k.name)}" placeholder="KEYWORD" aria-label="Keyword"></span>
  <input class="c-extra" name="qcard" autocomplete="off" value="${esc(k.quest)}" placeholder="Card # (if known)" aria-label="Quest card number">
  <button type="button" class="c-x" data-action="remove-row" aria-label="Remove">✕</button>
</li>`;

function appendRow(list, html) {
  list.insertAdjacentHTML('beforeend', html);
  list.lastElementChild.querySelector('input:not([type=checkbox])')?.focus();
}

function openLocDialog(id) {
  const loc = id ? findLoc(id) : null;
  const f = $('#locForm');
  const el = f.elements;
  f.dataset.id = loc?.id ?? '';
  $('#locTitle').textContent = loc ? `Location #${loc.number}` : 'New location';
  el.number.value = loc?.number ?? '';
  el.atlasPage.value = loc?.atlasPage ?? '';
  el.locName.value = loc?.name ?? '';
  el.notes.value = loc?.notes ?? '';
  el.notes.dataset.auto = '';
  el.dungeonDone.checked = !!loc?.dungeonDone;
  suggestFromMap();
  // A new location is one we're visiting now.
  $('#visitRows').innerHTML = (loc ? loc.visits : [new Date().toISOString()]).map(visitRowHtml).join('');
  $('#optRows').innerHTML = (loc?.options ?? []).map(o => optRowHtml(o, o.keywords.length ? 'kw' : 'none')).join('');
  $('#advRows').innerHTML = (loc?.adventures ?? []).map(advRowHtml).join('');
  $('#questRows').innerHTML = (loc ? questsAt(loc).sort(byQuest) : []).map(questRowHtml).join('');
  $('#locForm [data-action=delete-loc]').hidden = !loc;
  $('#locDialog').showModal();
  if (!loc) el.number.focus();
}

// A quest row's card # comes from the keyword list when the keyword is already known.
function suggestCard(li) {
  const card = li.querySelector('[name=qcard]');
  if (card.value && !card.dataset.auto) return;
  const k = data.keywords.find(x => x.name === norm(li.querySelector('[name=qkw]').value));
  card.value = k?.quest ?? '';
  card.dataset.auto = card.value ? '1' : '';
}

function suggestFromMap() {
  const el = $('#locForm').elements;
  const m = mapEntry(el.number.value);
  el.atlasPage.placeholder = m.page ? `${m.page} (from map)` : '';
  el.locName.placeholder = m.name ? `${m.name} (from map)` : 'Optional';
  $('#dungeonField').hidden = !m.dungeon;
  // Notes start with the map's notes for this location, unless they were already written.
  if (!el.notes.value || el.notes.dataset.auto) {
    el.notes.value = mapNotes(el.number.value).join('\n');
    el.notes.dataset.auto = el.notes.value ? '1' : '';
  }
}

function saveLocDialog() {
  const f = $('#locForm');
  const el = f.elements;
  const id = f.dataset.id;
  const number = locNumber(el.number.value);
  if (!number) { toast('A location needs a number'); el.number.focus(); return false; }
  if (data.locations.some(l => l.number === number && l.id !== id)) { toast(`Location #${number} already exists`); el.number.focus(); return false; }
  const field = (li, name) => li.querySelector(`[name=${name}]`);
  const options = [...$('#optRows').children].map(li => {
    const keywords = li.dataset.kind === 'none' ? [] : splitKw(field(li, 'keywords').value);
    if (li.dataset.kind === 'kw' && !keywords.length) return null;
    return { keywords, done: field(li, 'done').checked, note: field(li, 'note').value.trim() };
  }).filter(Boolean);
  const adventures = [...$('#advRows').children]
    .map(li => ({ card: cardNumber(field(li, 'card').value), name: field(li, 'advname').value.trim() }))
    .filter(a => a.card);
  const quests = [...$('#questRows').children]
    .map(li => ({ name: norm(field(li, 'qkw').value), quest: cardNumber(field(li, 'qcard').value), done: field(li, 'done').checked }))
    .filter(q => q.name);
  const visits = [...$('#visitRows').children].map(li => {
    const v = field(li, 'visit').value;
    return !v ? '' : v === localInput(li.dataset.iso) ? li.dataset.iso : new Date(v).toISOString();
  }).filter(Boolean).sort();
  const m = mapEntry(number);
  const loc = { id: id || uid(), number, name: el.locName.value.trim() || m.name || '', atlasPage: el.atlasPage.value.trim() || m.page || '', options, adventures, notes: el.notes.value.trim(), dungeonDone: !!m.dungeon && el.dungeonDone.checked, visits };
  const i = data.locations.findIndex(l => l.id === loc.id);
  const now = new Date().toISOString();
  Object.assign(loc, { created: i >= 0 ? data.locations[i].created : now, updated: now });
  // Quests are keywords linked by gainedAt: unlink the old ones, then add or update each row.
  if (i >= 0) data.keywords.forEach(k => { if (k.gainedAt === data.locations[i].number) k.gainedAt = ''; });
  for (const q of quests) {
    let k = data.keywords.find(x => x.name === q.name);
    if (!k) data.keywords.push(k = { name: q.name, quest: '', done: false, gainedAt: '', note: '' });
    Object.assign(k, q, { quest: q.quest || k.quest, gainedAt: number });
  }
  if (i >= 0) data.locations[i] = loc; else data.locations.push(loc);
  commit(`${i >= 0 ? 'Edit' : 'Add'} location #${number}`);
  return true;
}

// ---------- Keyword dialog ----------

function openKwDialog(name) {
  const k = data.keywords.find(x => x.name === name);
  if (!k) return;
  const f = $('#kwForm');
  f.dataset.kw = k.name;
  f.elements.kwName.value = k.name;
  f.elements.quest.value = k.quest;
  f.elements.gainedAt.value = k.gainedAt;
  f.elements.note.value = k.note;
  $('#kwDialog').showModal();
}

function saveKwDialog() {
  const f = $('#kwForm');
  const k = data.keywords.find(x => x.name === f.dataset.kw);
  const name = norm(f.elements.kwName.value);
  if (!name) return false;
  if (name !== k.name) {
    if (data.keywords.some(x => x.name === name)) { toast(`${name} is already in the list`); return false; }
    renameKeyword(k.name, name);
    k.name = name;
  }
  k.quest = cardNumber(f.elements.quest.value);
  k.gainedAt = locNumber(f.elements.gainedAt.value);
  k.note = f.elements.note.value.trim();
  commit(`Edit keyword ${k.name}`);
  return true;
}

// ---------- Loading & saving ----------

const b64encode = s => { let bin = ''; new TextEncoder().encode(s).forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin); };
const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${conn.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).message || res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function repoSettings() {
  try { const saved = JSON.parse(store.get(LS.repo)); if (saved?.owner) return saved; } catch {}
  let { owner, repo, branch } = CONFIG;
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    const seg = location.pathname.split('/').filter(Boolean)[0];
    owner ||= m[1];
    repo ||= seg && !seg.includes('.') ? seg : location.hostname;
  }
  return { owner, repo, branch };
}

function restoreDraft() {
  let draft;
  try { draft = JSON.parse(store.get(LS.draft)); } catch {}
  if (!draft?.data) return;
  if (JSON.stringify(migrate(draft.data)) === JSON.stringify(data)) { store.del(LS.draft); return; }
  if (confirm(`There are unsaved changes in this browser from ${fmtDate(draft.at)}. Restore them?`)) {
    data = migrate(draft.data);
    dirty = true;
  } else {
    store.del(LS.draft);
  }
}

async function connect(c) {
  conn = c;
  await gh(`/repos/${c.owner}/${c.repo}`);
  try {
    const file = await gh(`/repos/${c.owner}/${c.repo}/contents/${CONFIG.path}?ref=${encodeURIComponent(c.branch)}`);
    data = migrate(JSON.parse(b64decode(file.content)));
    remoteSha = file.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
    data = emptyData();
    remoteSha = null;
  }
  store.set(LS.token, c.token);
  store.set(LS.repo, JSON.stringify({ owner: c.owner, repo: c.repo, branch: c.branch }));
  mode = 'github';
  dirty = false;
  restoreDraft();
  render();
}

async function save(message = 'Update campaign tracker') {
  if (saving) { queuedSave = message; return; }
  data.updatedAt = new Date().toISOString();
  const json = JSON.stringify(data, null, 2) + '\n';
  if (mode === 'local') {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
      download: 'data.json',
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    dirty = false;
    store.del(LS.draft);
    renderChrome();
    toast('Downloaded data.json — commit it to the repository to publish');
    return;
  }
  saving = true;
  renderChrome();
  try {
    const res = await gh(`/repos/${conn.owner}/${conn.repo}/contents/${CONFIG.path}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64encode(json), branch: conn.branch, ...(remoteSha ? { sha: remoteSha } : {}) }),
    });
    remoteSha = res.content.sha;
    dirty = false;
    store.del(LS.draft);
    toast('Saved — viewers see it within a minute or two');
  } catch (e) {
    toast(e.status === 409 ? 'data.json changed on GitHub since you loaded it. Log out and back in to reload it.' : `Save failed: ${e.message}`);
  } finally {
    saving = false;
    renderChrome();
    if (queuedSave) { const next = queuedSave; queuedSave = null; save(next); }
  }
}

async function load() {
  const get = path => fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' })
    .then(res => { if (!res.ok) throw new Error(res.status); return res.json(); });
  // The atlas has to be in before the data is migrated (port notes come from it).
  const [map, saved] = await Promise.allSettled([get(CONFIG.atlas), get(CONFIG.path)]);
  atlas = map.value ?? {};
  try {
    if (saved.status === 'rejected') throw saved.reason;
    data = migrate(saved.value);
    render();
  } catch {
    render();
    $('#view').insertAdjacentHTML('afterbegin', `<p class="empty">Couldn’t load <code>${CONFIG.path}</code>. If you opened the file directly, serve the folder instead (e.g. <code>python3 -m http.server</code>).</p>`);
  }
  const token = store.get(LS.token);
  if (token) {
    connect({ ...repoSettings(), token }).catch(e => {
      mode = 'view';
      conn = null;
      toast(`Editor login failed: ${e.message}`);
      render();
    });
  }
}

// ---------- Events ----------

const actions = {
  tab(el) { tab = el.dataset.v; history.replaceState(null, '', '#' + tab); render(); window.scrollTo(0, 0); },
  status(el) { ui.status = el.dataset.v; render(); },
  sort(el) { ui.sort = el.dataset.v; render(); },
  'goto-loc'(el) {
    const loc = findLoc(el.dataset.loc);
    $('dialog[open]')?.close();
    tab = 'locations';
    ui.q = '#' + loc.number;
    ui.status = 'all';
    history.replaceState(null, '', '#locations');
    render();
    window.scrollTo(0, 0);
  },
  'toggle-opt'(el) { const loc = findLoc(el.dataset.loc); const o = loc.options[el.dataset.i]; o.done = !o.done; touch(loc); },
  'toggle-kw'(el) { const k = data.keywords.find(x => x.name === el.dataset.kw); k.done = !k.done; commit(); },
  'new-loc'() { openLocDialog(null); },
  'edit-loc'(el) { openLocDialog(el.dataset.loc); },
  'add-opt'() { appendRow($('#optRows'), optRowHtml({ keywords: [], done: false, note: '' }, 'kw')); },
  'add-none'() { appendRow($('#optRows'), optRowHtml({ keywords: [], done: false, note: '' }, 'none')); },
  'toggle-dungeon'(el) { const loc = findLoc(el.dataset.loc); loc.dungeonDone = !loc.dungeonDone; touch(loc); },
  visit(el) {
    const loc = findLoc(el.dataset.loc);
    loc.visits.push(new Date().toISOString());
    commit(`Visit location #${loc.number}`);
    toast(`Logged a visit to #${loc.number}`);
  },
  'add-visit'() { appendRow($('#visitRows'), visitRowHtml(new Date().toISOString())); },
  'add-adv'() { appendRow($('#advRows'), advRowHtml({ card: '', name: '' })); },
  'add-quest'() { appendRow($('#questRows'), questRowHtml({ name: '', quest: '', done: false })); },
  'remove-row'(el) { el.closest('li').remove(); },
  'delete-loc'() {
    const loc = findLoc($('#locForm').dataset.id);
    if (!confirm(`Delete location #${loc.number}${loc.name ? ` (${loc.name})` : ''}? Its keywords stay in the list.`)) return;
    data.locations = data.locations.filter(l => l !== loc);
    $('#locDialog').close();
    commit(`Delete location #${loc.number}`);
  },
  'edit-kw'(el) { openKwDialog(el.dataset.kw); },
  'delete-kw'() {
    const name = $('#kwForm').dataset.kw;
    if (!confirm(`Remove ${name} from the keywords we have? Locations that need it will show it as missing again.`)) return;
    data.keywords = data.keywords.filter(k => k.name !== name);
    $('#kwDialog').close();
    commit(`Remove keyword ${name}`);
  },
  'got-kw'(el) { addKeyword(el.dataset.kw); },
  'close-dialog'(el) { el.closest('dialog').close(); },
  editor() {
    const f = $('#connectForm');
    const s = repoSettings();
    f.elements.owner.value = s.owner;
    f.elements.repo.value = s.repo;
    f.elements.branch.value = s.branch || 'main';
    $('#connectError').hidden = true;
    $('#connectDialog').showModal();
    (s.owner && s.repo ? f.elements.token : f.elements.owner).focus();
  },
  'edit-local'() {
    $('#connectDialog').close();
    mode = 'local';
    restoreDraft();
    render();
    toast('Editing locally — use “Download data.json” to export your changes');
  },
  save() { save(); },
  disconnect() {
    if (dirty && !confirm('You have unsaved changes. They stay as a draft in this browser. Leave the editor anyway?')) return;
    store.del(LS.token);
    location.reload();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});

document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

document.addEventListener('input', e => {
  if (e.target.dataset.input === 'q') { ui.q = e.target.value; $('#locList').innerHTML = locList(owned()); }
  if (e.target.dataset.input === 'sort') { ui.sort = e.target.value; render(); }
  if (e.target === $('#locForm').elements.number) suggestFromMap();
  if (e.target.name === 'qkw') suggestCard(e.target.closest('li'));
  if (e.target.name === 'qcard' || e.target.name === 'notes') e.target.dataset.auto = '';
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'locForm') {
    if (saveLocDialog()) $('#locDialog').close();
  } else if (f.id === 'kwForm') {
    if (saveKwDialog()) $('#kwDialog').close();
  } else if (f.dataset.form === 'add-kw') {
    if (addKeyword(f.elements.kw.value, f.elements.gainedAt.value, f.elements.quest.value)) $('[data-form=add-kw] [name=kw]').focus();
  } else if (f.id === 'connectForm') {
    const el = f.elements;
    const c = { owner: el.owner.value.trim(), repo: el.repo.value.trim(), branch: el.branch.value.trim() || 'main', token: el.token.value.trim() };
    if (!c.owner || !c.repo || !c.token) return;
    const btn = f.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      await connect(c);
      $('#connectDialog').close();
      el.token.value = '';
      toast('Connected — remember to hit Save after making changes');
    } catch (err) {
      conn = null;
      $('#connectError').textContent = err.status === 401 ? 'GitHub rejected this token.'
        : err.status === 404 ? 'Repository not found, or the token has no access to it.' : `Couldn’t connect: ${err.message}`;
      $('#connectError').hidden = false;
    } finally {
      btn.disabled = false;
    }
  }
});

window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

load();
