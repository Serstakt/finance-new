// Регрессионный тест бага «счётчики разделов обновляются только после
// перезагрузки страницы». Проверяет, что вызов applySectionCollapse в onEnd
// drag&drop (main.js) пересчитывает .section-count в моменте: тикер RTKM
// перетащили из «Новый раздел» (20) в «Информационные технологии» (5) —
// счётчики должны стать 19 и 6 СРАЗУ, без render() и без перезагрузки.
//
// Гоняет РЕАЛЬНЫЙ ui.js через node:vm (та же мини-DOM-эмуляция, что в
// render_diff_test.js) + статическую проверку, что вызов не удалён из main.js.
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
    this._textHtml = null;
    this._html = '';
    this._parsedCache = null;
    this.offsetWidth = 10;
    this.disabled = false; this.value = ''; this.placeholder = '';
    this.id = ''; this._liveKids = new Set();
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
  get textContent() {
    const kids = this.children.filter(c => c.tagName !== '#TEXT-DROP');
    if (kids.length > 0) return kids.map(c => c.textContent).join('');
    if (this._text) return this._text;
    if (this._textHtml !== null) return this._textHtml.replace(/<[^>]*>/g, '');
    return '';
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = []; this._text = String(v); this._invalidate();
  }
  get innerHTML() { return this._html || ''; }
  set innerHTML(v) {
    for (const c of this._kids) c.parentNode = null;
    this._html = v; this._textHtml = String(v); this._kids = []; this._liveKids.clear(); this._invalidate();
    for (const m of String(v).matchAll(/<(\w+)([^>]*)>(?:(?!<\/\1>)[\s\S])*?<\/\1>/g)) {
      const child = parseFragment(m[0]);
      if (child) { child.parentNode = this; this.children.push(child); }
    }
  }
  appendChild(n) { if (n.parentNode && n.parentNode !== this) n.remove(); n.parentNode = this; this._kids.push(n); this._liveKids.add(n); this._invalidate(); return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode && n.parentNode !== this) n.remove();
    let idx = this._kids.indexOf(ref);
    if (idx < 0) idx = this._kids.length;
    n.parentNode = this; this._kids.splice(idx, 0, n);
    this._liveKids.add(n);
    this._invalidate();
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    p._liveKids.delete(this);
    p._invalidate();
    this.parentNode = null;
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') { this.id = String(v); } if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev = {}) {
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    const evt = { type, target: this, bubbles: true, stopPropagation() {}, preventDefault() {}, ...ev };
    for (const n of path) {
      evt.currentTarget = n;
      for (const fn of (n.listeners[type] || [])) {
        try { fn(evt); } catch (e) { console.error('HANDLER ERROR:', e.message); }
      }
    }
  }
  closest(sel) {
    const cls = sel.replace(/^\./, '');
    let n = this;
    while (n) { if (n._classes.has(cls)) return n; n = n.parentNode; }
    return null;
  }
  _matches(sel) {
    sel = sel.trim();
    if (sel.startsWith(':scope >')) sel = sel.slice(8).trim();
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const m = /^([\w-]*)\.([\w-]+)$/.exec(sel);
    if (m) return (!m[1] || this.tagName === m[1].toUpperCase()) && this._classes.has(m[2]);
    if (/^\./.test(sel)) return this._classes.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  _walk(fn) { for (const c of this.children) { fn(c); c._walk(fn); } }
  _invalidate() { this._parsedCache = null; for (let p = this.parentNode; p; p = p.parentNode) p._parsedCache = null; }
  _descendants(out) { for (const c of this.children) { out.push(c); c._descendants(out); } return out; }
  querySelectorAll(sel) {
    const sels = sel.split(',').map(x => x.trim());
    const direct = sels.some(s => s.startsWith(':scope >'));
    const out = [];
    const test = (n) => sels.some(s => n._matches(s));
    if (direct) { for (const c of this.children) if (test(c)) out.push(c); return out; }
    const seenN = new Set();
    for (const n of this._descendants([])) {
      if (!seenN.has(n)) { seenN.add(n); if (test(n)) out.push(n); }
    }
    return out;
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
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

// Перестановка узла внутри родителя с семантикой РЕАЛЬНОГО DOM:
// узел снимается со старой позиции и вставляется перед ref.
// (Mini-DOM insertBefore при переносе внутри одного родителя дублирует ссылку,
// поэтому Sortable-move эмулируем вручную.)
function moveNode(parent, node, ref) {
  const kids = parent.children;
  const oldIdx = kids.indexOf(node);
  if (oldIdx >= 0) kids.splice(oldIdx, 1);
  let idx = ref ? kids.indexOf(ref) : -1;
  if (idx < 0) idx = kids.length;
  node.parentNode = parent;
  kids.splice(idx, 0, node);
  parent._invalidate();
}

// ---------- Окружение ----------
const nodesById = {};
function makeEl(id, tag) { const e = new Node(tag); e.id = id; nodesById[id] = e; return e; }
const container = makeEl('ticker-list', 'div');
makeEl('tradingview_chart', 'div');
makeEl('notes-editor', 'textarea');
makeEl('notes-editor-status', 'div');
makeEl('news-panel', 'div');
makeEl('news-list', 'div');
makeEl('notes-list', 'div');
makeEl('debug-panel', 'div');
makeEl('list-selector', 'select');
makeEl('countdown', 'span');

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
  fetch: async () => ({ ok: false, status: 500 }),
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  Date, Math, JSON, Promise, encodeURIComponent, Map, Set, String, Number, Object, Array, RegExp, Infinity,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// заглушки зависимостей из state.js/main.js (ui.js остаётся реальным)
vm.runInContext(`
  window.appState = { activeListId: 'default', lists: { default: { name: 'Тест', tickers: [], activeSymbol: '', collapsedSections: [] } }, favorites: {}, notes: {} };
  window.currentSort = { field: null, direction: 'asc' };
  window.activePickerSymbol = null;
  window.FLAG_COLORS = { red: { hex: '#ef5350' }, blue: { hex: '#2962ff' } };
  window.getCurrentList = () => appState.lists[appState.activeListId];
  window.saveState = () => {};
  window.setActiveSymbolInDb = () => {};
  window.populateListSelector = () => {};
  window.setCollapsedInDb = () => {};
  window.removeTickerFromDb = () => {};
  window.saveOrderToDb = () => {};
  window.moveOrderToDb = async () => true;
  window.setNoteInDb = async () => true;
  window.syncAlertsWithDb = () => {};
  window.loadTickerNews = () => {};
  window.log = () => {};
  window.createChart = () => {};
`, sandbox);

// реальные исходники (api.js нужен buildRowElement'у, как в render_diff_test)
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'), sandbox);
// отключаем lightweight-ветку, чтобы render() всегда шёл по полному пути
vm.runInContext('window.CACHE_DURATION = 0;', sandbox);

// Управляемый источник цен вместо сети
const priceStore = {};
sandbox.priceStore = priceStore;
vm.runInContext(`window.fetchTickerData = async function(symbol) {
  if (symbol.startsWith('SECTION:')) return null;
  return priceStore[symbol] !== undefined ? priceStore[symbol] : null;
}`, sandbox);

// Символ DOM-узла строки/заголовка через кэш рендера (в мини-DOM нет
// селекторов по атрибутам, а main.js берёт [data-symbol] — результат тот же).
function symOfNode(node) {
  for (const [sym, v] of sandbox.__rowsCache.map) {
    const el = v && v.el ? v.el : v;
    if (el === node) return sym;
  }
  return null;
}
function counterOf(sym) {
  const node = sandbox.__rowsCache.map.get(sym);
  const el = node && node.el ? node.el : node;
  return el.querySelector('.section-count').textContent.trim();
}

(async () => {
  const list = sandbox.appState.lists.default;
  const IT = ['SBER', 'YDEX', 'OZON', 'VKCO', 'SMLT'];                       // 5 тикеров
  const REST = ['RTKM', 'MTSS', 'MGNT', 'ROSN', 'LKOH', 'NVTK', 'GMKN',      // 20 тикеров
                'PLZL', 'ALRS', 'CHMF', 'SNGS', 'TRNFP', 'AFLT', 'HYDR',
                'FEES', 'RASP', 'BSPB', 'MAGN', 'NLMK', 'PHOR'];
  list.tickers = ['SECTION:Информационные технологии', ...IT,
                  'SECTION:Новый раздел', ...REST];
  REST.forEach((s, i) => { priceStore[s] = { price: 100 + i, changeValue: 1, changeDay: 0.5 }; });
  IT.forEach((s, i) => { priceStore[s] = { price: 200 + i, changeValue: 1, changeDay: 0.5 }; });

  await sandbox.render();
  assert(counterOf('SECTION:Информационные технологии') === '5', 'До перетаскивания: счётчик ИТ = 5');
  assert(counterOf('SECTION:Новый раздел') === '20', 'До перетаскивания: счётчик «Новый раздел» = 20');

  // --- Пользователь перетащил RTKM в «Информационные технологии» ---
  // 1) Sortable передвинул DOM-узел: RTKM встал последним в блоке ИТ
  const rtkmNode = sandbox.__rowsCache.map.get('RTKM').el;
  const novHeader = sandbox.__rowsCache.map.get('SECTION:Новый раздел');
  moveNode(container, rtkmNode, novHeader);

  // 2) onEnd в main.js: пересобираем порядок по DOM и кладём в состояние
  const newList = [];
  container.children.forEach(item => { const s = symOfNode(item); if (s) newList.push(s); });
  sandbox.getCurrentList().tickers = newList;

  // 3) onEnd в main.js (исправление): счётчики пересчитываются сразу
  if (typeof sandbox.applySectionCollapse === 'function') sandbox.applySectionCollapse(sandbox.getCurrentList());

  // --- Проверки «в моменте», БЕЗ render() и БЕЗ перезагрузки страницы ---
  assert(counterOf('SECTION:Информационные технологии') === '6', 'Счётчик ИТ обновился 5 → 6 сразу после drop');
  assert(counterOf('SECTION:Новый раздел') === '19', 'Счётчик «Новый раздел» обновился 20 → 19 сразу после drop');
  assert(rtkmNode.style.display !== 'none', 'Перетащенная строка видима (раздел не свёрнут)');

  const kids = container.children.slice();
  const idxIT = kids.indexOf(sandbox.__rowsCache.map.get('SECTION:Информационные технологии'));
  const idxRTKM = kids.indexOf(rtkmNode);
  const idxNov = kids.indexOf(novHeader);
  assert(idxIT < idxRTKM && idxRTKM < idxNov, 'RTKM в DOM находится внутри блока ИТ');

  // --- Свернутый раздел: строка, брошенная внутрь, скрывается, счётчик растёт ---
  list.collapsedSections = ['SECTION:Новый раздел'];
  const sberNode = sandbox.__rowsCache.map.get('SBER').el;
  const mtssNode = sandbox.__rowsCache.map.get('MTSS').el;
  moveNode(container, sberNode, mtssNode); // SBER бросили в свёрнутый «Новый раздел» (после его заголовка)
  const nl2 = [];
  container.children.forEach(item => { const s = symOfNode(item); if (s) nl2.push(s); });
  sandbox.getCurrentList().tickers = nl2;
  sandbox.applySectionCollapse(sandbox.getCurrentList());
  assert(counterOf('SECTION:Новый раздел') === '20', 'Счётчик свёрнутого раздела: 19 → 20 сразу после drop');
  assert(counterOf('SECTION:Информационные технологии') === '5', 'Счётчик ИТ при этом: 6 → 5 сразу после drop');
  assert(sberNode.style.display === 'none', 'Строка, брошенная в свёрнутый раздел, скрыта');

  // --- Статическая защита: вызов не удалён из onEnd в main.js ---
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  const anchor = mainSrc.indexOf('getCurrentList().tickers = newList;');
  assert(anchor >= 0, 'main.js: найден onEnd drag&drop');
  const after = mainSrc.slice(anchor, anchor + 700);
  assert(/applySectionCollapse\s*\(\s*getCurrentList\(\)\s*\)/.test(after),
         'main.js: onEnd вызывает applySectionCollapse сразу после обновления состояния');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
