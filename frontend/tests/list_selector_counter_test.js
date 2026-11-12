// Регрессионный тест бага «в селекторе списков (list-selector-toggle) у
// неактивных списков не отображается счётчик тикеров».
//
// Причина: populateListSelector показывал счётчик только при
// list.tickers.length > 0, но состав (tickers) подтягивается из БД только для
// АКТИВНОГО списка (syncListWithDb). Остальные списки приходят из
// loadListNamesFromDb с tickers: [] — их пункты меню оставались без счётчика.
//
// Фикс: /api/watchlists возвращает ticker_counts {list_id: n}; фронтенд хранит
// их в list.tickerCount и показывает в селекторе для списков с незагруженным
// составом. Для списков с загруженным составом (synced) счётчик считается по
// tickers, причём SECTION-заголовки не считаются.
//
// Гоняет РЕАЛЬНЫЕ api.js + state.js через node:vm (та же мини-DOM-эмуляция,
// что в render_diff_test.js / section_counter_dnd_test.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- Мини-DOM (сокращённая копия из render_diff_test.js) ----------
class Node {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this._kids = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this._attrs = {};
    this.listeners = {};
    this._text = '';
    this.offsetWidth = 10;
    this.disabled = false; this.value = ''; this.placeholder = '';
    this.id = ''; this._liveKids = new Set(); this._textHtml = null;
  }
  getBoundingClientRect() { return { width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50 }; }
  get children() { return this._kids; }
  set children(v) { this._kids = v; }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...c) => c.forEach(x => this._classes.add(x)),
    remove: (...c) => c.forEach(x => this._classes.delete(x)),
    toggle: (c, force) => { const on = force === undefined ? !this._classes.has(c) : !!force; on ? this._classes.add(c) : this._classes.delete(c); return on; },
    contains: (c) => this._classes.has(c),
  };
  get textContent() {
    const kids = this.children.filter(c => c.tagName !== '#TEXT-DROP');
    if (kids.length > 0) return kids.map(c => c.textContent).join('');
    if (this._text) return this._text;
    if (this._textHtml !== null) return this._textHtml.replace(/<[^>]*>/g, '');
    return '';
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = []; this._text = String(v);
  }
  get innerHTML() { return this._html || ''; }
  set innerHTML(v) {
    for (const c of this._kids) c.parentNode = null;
    this._html = v; this._textHtml = String(v); this._kids = []; this._liveKids.clear();
    for (const m of String(v).matchAll(/<(\w+)([^>]*)>(?:(?!<\/\1>)[\s\S])*?<\/\1>/g)) {
      const child = parseFragment(m[0]);
      if (child) { child.parentNode = this; this.children.push(child); }
    }
  }
  appendChild(n) { if (n.parentNode && n.parentNode !== this) n.remove(); n.parentNode = this; this._kids.push(n); this._liveKids.add(n); return n; }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    p._liveKids.delete(this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') { this.id = String(v); } if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  _matches(sel) {
    sel = sel.trim();
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const m = /^([\w-]*)\.([\w-]+)$/.exec(sel);
    if (m) return (!m[1] || this.tagName === m[1].toUpperCase()) && this._classes.has(m[2]);
    if (/^\./.test(sel)) return this._classes.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  _descendants(out) { for (const c of this.children) { out.push(c); c._descendants(out); } return out; }
  querySelectorAll(sel) {
    const sels = sel.split(',').map(x => x.trim());
    const out = [];
    const test = (n) => sels.some(s => n._matches(s));
    for (const n of this._descendants([])) { if (test(n)) out.push(n); }
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function parseFragment(html) {
  const m = /^<(\w+)([^>]*)>/.exec(html.trim());
  if (!m) return null;
  const el = new Node(m[1]);
  el.className = (/class="([^"]*)"/.exec(m[2]) || [])[1] || '';
  for (const a of m[2].matchAll(/(?:^|\s)([\w-]+)="([^"]*)"/g)) {
    if (a[1] !== 'class') el.setAttribute(a[1], a[2]);
  }
  const inner = html.replace(/^<(\w+)[^>]*>/, '').replace(new RegExp(`</${m[1]}>$`), '');
  for (const cm of inner.matchAll(/<(svg|span|div|a|button|polyline|path|circle|rect|line|img)\b(?:(?!<\/\1>)[\s\S])*?(?:\/>|>[\s\S]*?<\/\1>)/g)) {
    const child = parseFragment(cm[0]);
    if (child) { child.parentNode = el; el.children.push(child); }
  }
  el._text = inner.replace(/<[^>]*>/g, '').trim();
  el._html = html;
  return el;
}

// ---------- Окружение ----------
const nodesById = {};
function makeEl(id, tag) { const e = new Node(tag); e.id = id; nodesById[id] = e; return e; }
// Кастомный селектор как в index.html: #list-selector > toggle + menu
const wrapEl = makeEl('list-selector', 'div');
const toggleEl = makeEl('list-selector-toggle', 'button');
const menuEl = makeEl('list-selector-menu', 'div');
wrapEl.appendChild(toggleEl);
wrapEl.appendChild(menuEl);
makeEl('countdown', 'span');

// Управляемый ответ /api/watchlists (об actionTypes выше — на каждый вызов)
let watchlistsPayload = { lists: {}, ticker_counts: {} };
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  innerWidth: 1200, innerHeight: 800,
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    getElementById: (id) => nodesById[id] || null,
    createElement: (tag) => new Node(tag),
    querySelectorAll: () => [],
    addEventListener() {}, body: new Node('body'),
    head: new Node('head'), createTextNode: (t) => { const n = new Node('#text'); n._text = String(t); return n; },
  },
  location: { protocol: 'http:', port: '8000' },
  fetch: async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('/api/watchlists')
      ? watchlistsPayload
      : {}),
  }),
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  Date, Math, JSON, Promise, encodeURIComponent, Map, Set, String, Number, Object, Array, RegExp, Infinity,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// реальные исходники: api.js даёт fetchWithTimeout/API_BASE, state.js —
// populateListSelector и loadListNamesFromDb (остальное не используется)
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8'), sandbox);

// ---------- Помощники ----------
function optionOf(listId) {
  return menuEl.children.find(o => o.dataset.listId === listId) || null;
}
function optionText(listId) {
  const o = optionOf(listId);
  return o ? o.textContent.trim() : null;
}

(async () => {
  const A = sandbox.appState;

  // --- Сценарий 1: состав неактивного списка не загружен, счётчик из БД ---
  A.activeListId = 'default';
  A.lists = {
    // активный список: состав загружен (synced), есть SECTION-заголовок
    default: { name: 'RUS', tickers: ['SECTION:Технологии', 'SBER', 'MOEX', 'GAZP'], activeSymbol: 'SBER', collapsedSections: [], synced: true },
    // неактивный список: состав НЕ загружен (как после loadListNamesFromDb),
    // счётчик пришёл из /api/watchlists → ticker_counts
    crypto: { name: 'CRYPTO', tickers: [], activeSymbol: '', collapsedSections: [], tickerCount: 13 },
  };
  sandbox.populateListSelector();

  assert(toggleEl.textContent.includes('RUS (3)'),
    'Кнопка селектора (активный список): «RUS (3)» — SECTION-заголовок не считается');
  assert(!toggleEl.textContent.includes('RUS (4)'),
    'Кнопка селектора: старое поведение (подсчёт SECTION как тикера) устранено');
  assert(optionText('crypto') === 'CRYPTO (13)',
    'Пункт меню неактивного списка показывает счётчик из БД: «CRYPTO (13)»');
  assert(optionText('default') === 'RUS (3)',
    'Пункт меню активного списка: «RUS (3)»');

  // --- Сценарий 2: пустой список и список без счётчика из БД ---
  A.lists.empty = { name: 'Пустой', tickers: [], activeSymbol: '', collapsedSections: [], synced: true, tickerCount: 0 };
  A.lists.old = { name: 'Старый', tickers: [], activeSymbol: '', collapsedSections: [] }; // tickerCount не приходил (старый бэкенд)
  sandbox.populateListSelector();
  assert(optionText('empty') === 'Пустой',
    'Пустой список (synced, 0 тикеров) — счётчик не показывается');
  assert(optionText('old') === 'Старый',
    'Список без tickerCount из БД — счётчик не показывается (совместимость)');

  // --- Сценарий 3: loadListNamesFromDb кладёт счётчики в appState ---
  A.lists = {
    default: { name: 'RUS', tickers: ['SBER', 'MOEX'], activeSymbol: 'SBER', collapsedSections: [], synced: true },
  };
  watchlistsPayload = {
    lists: { default: 'RUS', crypto: 'CRYPTO', nano: 'NANO' },
    ticker_counts: { default: 33, crypto: 13, nano: 7 },
  };
  await sandbox.loadListNamesFromDb();

  assert(A.lists.crypto && A.lists.crypto.tickerCount === 13,
    'loadListNamesFromDb: созданный список получает tickerCount из ответа');
  assert(A.lists.nano && A.lists.nano.tickerCount === 7,
    'loadListNamesFromDb: второй список получает свой tickerCount');
  assert(A.lists.default.tickerCount === 33,
    'loadListNamesFromDb: существующий список тоже получает tickerCount');
  assert(optionText('crypto') === 'CRYPTO (13)',
    'После loadListNamesFromDb пункт меню crypto показывает «CRYPTO (13)»');
  assert(optionText('nano') === 'NANO (7)',
    'После loadListNamesFromDb пункт меню nano показывает «NANO (7)»');
  // активный список пересчитывает по своему (загруженному) составу, а не по
  // tickerCount из БД — в нём 2 тикера
  assert(optionText('default') === 'RUS (2)',
    'Активный список считается по загруженному составу, а не по tickerCount');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
