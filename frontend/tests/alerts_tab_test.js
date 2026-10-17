// Интеграционный тест вкладки «Алерты» раздела WATCHLIST.
// Прогоняет РЕАЛЬНЫЕ frontend/js/api.js + frontend/js/ui.js через node:vm
// с мини-DOM и проверяет, что после добавления нового алерта список на
// вкладке обновляется (не показывает «Нет алертов для этого тикера»), а
// также корректно реагирует на смену выбранного тикера и отмену алерта.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failures++; }
}

// ---------- Мини-DOM (достаточный для кода алертов) ----------
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
    this.disabled = false; this.value = ''; this.placeholder = '';
    this.id = ''; this._html = '';
  }
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
  // ---- Поддержка innerHTML с вложенными одноимёнными тегами (<table><tr><td>) ----
  static _parseFragment(html) {
    const out = [];
    const stack = [{ kids: out }];
    const VOID = new Set(['br', 'img', 'input', 'hr']);
    const re = /<(\/?)(\w+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
    for (const m of String(html).matchAll(re)) {
      if (m[4] !== undefined) {
        const t = m[4];
        if (t.trim()) {
          const top = stack[stack.length - 1];
          const last = top.kids[top.kids.length - 1];
          if (last && !(last instanceof Node)) last.text += t;
          else top.kids.push({ text: t });
        }
        continue;
      }
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tag) { stack.length = i; break; }
        }
        continue;
      }
      const node = new Node(tag);
      for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(a[1], a[2]);
      stack[stack.length - 1].kids.push(node);
      if (!VOID.has(tag) && !m[3].endsWith('/')) stack.push({ tag, kids: node._kids, node });
    }
    return out;
  }
  get textContent() {
    if (this._html) return String(this._html).replace(/<[^>]*>/g, '');
    if (this.children.length === 0) return this._text;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) { this.children = []; this._text = String(v); this._html = ''; }
  get innerHTML() {
    if (this._html) return this._html;
    if (this._kids.length === 0) return this._text;
    return this._kids.map(k => (k instanceof Node ? k.innerHTML : k.text)).join('');
  }
  set innerHTML(v) {
    this._html = ''; this._text = '';
    this._kids = Node._parseFragment(String(v));
    for (const k of this._kids) if (k instanceof Node) k.parentNode = this;
  }
  appendChild(n) { n.parentNode = this; this._kids.push(n); return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); const i = this._kids.indexOf(ref); this._kids.splice(i < 0 ? this._kids.length : i, 0, n); n.parentNode = this; return n; }
  remove() { if (!this.parentNode) return; const i = this.parentNode._kids.indexOf(this); if (i >= 0) this.parentNode._kids.splice(i, 1); this.parentNode = null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'class') this.className = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev = {}) {
    (this.listeners[type] || []).forEach(fn => {
      try { fn({ stopPropagation() {}, preventDefault() {}, target: this, currentTarget: this, closest: () => null, ...ev }); }
      catch (e) { console.error('HANDLER ERROR:', e.message); }
    });
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    const out = [];
    const walk = (n) => { for (const k of n._kids) { if (k._classes.has(cls)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
}

// ---------- Окружение ----------
const nodesById = {};
function makeEl(id, tag) { const e = new Node(tag); e.id = id; nodesById[id] = e; return e; }

makeEl('alerts-list', 'div');
makeEl('news-panel', 'div');
makeEl('news-list', 'div');
makeEl('notes-list', 'div');
makeEl('ticker-list', 'div');
makeEl('tradingview_chart', 'div');
makeEl('alert-modal', 'div');
makeEl('alert-symbol-name', 'span');
makeEl('alert-condition', 'select');
makeEl('alert-target-price', 'input');
makeEl('alert-delete-btn', 'button');
makeEl('debug-panel', 'div');
makeEl('list-selector', 'select');
makeEl('countdown', 'span');

const sessionStore = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: {
    getItem: (k) => sessionStore[k] ?? null,
    setItem: (k, v) => { sessionStore[k] = String(v); },
    removeItem: (k) => { delete sessionStore[k]; },
  },
  document: {
    getElementById: (id) => nodesById[id] || null,
    createElement: (tag) => new Node(tag),
    querySelectorAll: () => [],
    addEventListener() {}, body: { style: {} },
    head: new Node('head'),
    createTextNode: (t) => { const n = new Node('#text'); n._text = String(t); return n; },
  },
  location: { protocol: 'http:', port: '8000' },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  Date, Math, JSON, Promise, encodeURIComponent, Map, Set, String, Number, Object, Array, RegExp, Infinity,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// ---- Мок БД алертов (эмулирует backend /api/alerts) ----
let dbRows = [];
let nextId = 1;
async function mockFetch(url, opts = {}) {
  const u = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = (opts.method || 'GET').toUpperCase();
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (u === '/api/alerts' && method === 'POST') {
    const p = JSON.parse(opts.body);
    const row = { id: nextId++, symbol: p.symbol, condition: p.condition, target: p.target,
                  status: 'active', created_at: '2026-10-17T10:00:00', triggered_price: null };
    dbRows.unshift(row);
    return json(row);
  }
  if (/^\/api\/alerts\/\d+\/cancel$/.test(u) && method === 'POST') {
    const id = Number(/\/api\/alerts\/(\d+)\//.exec(u)[1]);
    const row = dbRows.find(r => r.id === id);
    if (!row) return { ok: false, status: 404, json: async () => ({}) };
    row.status = 'cancelled';
    return json(row);
  }
  if (u === '/api/alerts' && method === 'GET') return json({ alerts: dbRows.slice() });
  if (u === '/api/alerts/check' && method === 'POST') return json({ triggered: [] });
  return { ok: false, status: 500, json: async () => ({ detail: 'not mocked: ' + u }) };
}
sandbox.fetch = mockFetch;

vm.createContext(sandbox);

// заглушки зависимостей из state.js/main.js
vm.runInContext(`
  window.appState = { activeListId: 'default', lists: { default: { name: 'Тест', tickers: ['SBER', 'GAZP'], activeSymbol: 'SBER', collapsedSections: [] } }, favorites: {}, notes: {} };
  window.currentSort = { field: null, direction: 'asc' };
  window.FLAG_COLORS = {};
  window.ALERTS_KEY = 'price_alerts';
  window.getCurrentList = () => appState.lists[appState.activeListId];
  window.saveState = () => {};
  window.setActiveSymbolInDb = () => {};
  window.populateListSelector = () => {};
  window.removeTickerFromDb = () => {};
  window.log = () => {};
  window.playAlertSound = () => {};
  window.loadTickerNews = () => {};
  window.createChart = () => {};
`, sandbox);

// реальные исходники
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'), sandbox);

// строка SBER в списке — чтобы openAlertModal/saveAlert имели «цену»
const sberRow = new Node('div');
sberRow.className = 'ticker-item';
sberRow.setAttribute('data-symbol', 'SBER');
nodesById['ticker-list'].appendChild(sberRow);
const priceEl = new Node('div');
priceEl.id = 'price-SBER';
priceEl.textContent = '300';
nodesById['price-SBER'] = priceEl;

const alertsContainer = nodesById['alerts-list'];
// Список алертов на вкладке: узлы добавляются через appendChild (не парсятся
// из innerHTML), поэтому берём детей контейнера напрямую.
const contentText = () => {
  const wrap = alertsContainer.children.find(c => c._classes.has('alerts-tab-content'));
  return wrap ? (wrap.innerHTML || wrap.children.map(k => k.innerHTML).join('\n')) : '';
};

(async () => {
  // Вкладка «Алерты» открыта, выбран SBER, алертов в БД нет
  sessionStore.bottomTab = 'alerts';
  await sandbox.renderAlertsTab('SBER');
  assert(contentText().includes('Нет алертов'), 'Без алертов показывается «Нет алертов»');

  // --- Сценарий 1: добавление алерта через модалку (openAlertModal -> saveAlert)
  await sandbox.openAlertModal('SBER');
  nodesById['alert-condition'].value = 'above';
  nodesById['alert-target-price'].value = '310';
  await sandbox.saveAlert();
  assert(dbRows.length === 1 && dbRows[0].symbol === 'SBER', 'Алерт создан в «БД»');
  assert(!contentText().includes('Нет алертов'),
    'После сохранения вкладка НЕ показывает «Нет алертов для этого тикера»');
  assert(contentText().includes('310') && contentText().includes('В работе'),
    'Список содержит новый активный алерт ≥ 310');

  // --- Сценарий 2: гонка — пользователь успел выбрать другой тикер во время записи
  nodesById['alert-condition'].value = 'below';
  nodesById['alert-target-price'].value = '290';
  const cur = sandbox.appState.lists.default;
  await sandbox.openAlertModal('SBER');       // вкладка синхронизируется на SBER
  cur.activeSymbol = 'GAZP';                  // «успели» переключиться на GAZP до saveAlert
  await sandbox.saveAlert();
  assert(dbRows.length === 2, 'Второй алерт создан в «БД»');
  // Вкладка относится к выбранному тикеру: после гонки выбран GAZP, а алерт
  // создан для SBER — на вкладке (GAZP) чужой алерт не показывается.
  assert(!contentText().includes('290') && contentText().includes('Нет алертов'),
    'После гонки вкладка показывает только алерты выбранного тикера (GAZP — «Нет алертов»)');
  // Тот же алерт ≤ 290 виден, когда выбран его тикер (SBER).
  cur.activeSymbol = 'SBER';
  await sandbox.renderAlertsTab('SBER');
  assert(contentText().includes('290') && !contentText().includes('310'),
    'Алерт ≤ 290 виден на вкладке своего тикера (SBER), чужой (310/GAZP) скрыт');

  // --- Сценарий 2б: открытие модалки для другого тикера при открытой вкладке
  // синхронизирует выбранный тикер со списком на вкладке
  sberRow.fire('click');
  cur.activeSymbol = 'GAZP';
  await sandbox.openAlertModal('SBER');
  assert(cur.activeSymbol === 'SBER',
    'Открытие модалки для другого тикера синхронизирует выбранный тикер со списком на вкладке');

  // --- Сценарий 3: кеш пуст (первый рендер после перезагрузки) — данные подтягиваются из БД
  sandbox.dbAlerts = [];
  await sandbox.renderAlertsTab('SBER');
  assert(contentText().includes('310') && contentText().includes('290'),
    'При пустом кеше вкладка подтягивает алерты из БД и рисует их');

  // --- Сценарий 4: отмена алерта обновляет список
  const activeRow = dbRows.filter(r => r.status === "active").pop();
  await sandbox.cancelAlert(activeRow.id, 'SBER');
  assert(contentText().includes('Отменено'), 'После отмены статус в списке обновлён');

  // --- Сценарий 5: смена выбранного тикера обновляет вкладку
  cur.activeSymbol = 'GAZP';
  sandbox.dbAlerts = []; // пусть renderAlertsTab сам сходит в БД
  await sandbox.renderAlertsTab('GAZP');
  assert(contentText().includes('Нет алертов'), 'Для тикера без алертов — сообщение «Нет алертов»');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
