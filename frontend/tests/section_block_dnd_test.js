// Регрессионный тест: перетаскивание заголовка раздела должно переносить
// раздел ВМЕСТЕ с его тикерами, а сам заголовок не должен вставать внутрь
// чужого блока (иначе оставшиеся тикеры этого блока «переехали» бы в
// перетаскиваемый раздел). В плоском списке раздел — это заголовок и все
// строки до следующего заголовка; Sortable тянет только сам узел заголовка,
// поэтому main.js в onEnd ставит блок вручную через ui.js: resolveSectionDrop
// (sectionFollowerNodes + snapSectionDropIndex).
//
// Гоняет РЕАЛЬНЫЙ ui.js через node:vm (та же мини-DOM-эмуляция, что в
// section_counter_dnd_test.js) + статическую проверку, что хелперы не
// выпали из onStart/onEnd в main.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- Мини-DOM ----------
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
  // Нужен хелперу ui.js: moveSectionBlockAfterHeader вставляет перед
  // anchor.nextSibling (в реальном DOM текстовых узлов между div нет)
  get nextSibling() { return this.nextElementSibling; }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] : null;
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

// Перестановка узла внутри родителя с семантикой РЕАЛЬНОГО DOM.
// (Mini-DOM insertBefore при переносе внутри одного родителя дублирует ссылку,
// поэтому перемещение Sortable эмулируем вручную.)
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
makeEl('wl-chart-area', 'div');
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
  window.moveBlockOrderToDb = async () => true;
  window.setNoteInDb = async () => true;
  window.syncAlertsWithDb = () => {};
  window.loadTickerNews = () => {};
  window.log = () => {};
  window.createChart = () => {};
`, sandbox);

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'), sandbox);
vm.runInContext('window.CACHE_DURATION = 0;', sandbox);

const priceStore = {};
sandbox.priceStore = priceStore;
vm.runInContext(`window.fetchTickerData = async function(symbol) {
  if (symbol.startsWith('SECTION:')) return null;
  return priceStore[symbol] !== undefined ? priceStore[symbol] : null;
}`, sandbox);

// Символы строк в порядке DOM
function domSymbols() {
  return container.children
    .map(n => (n.dataset && n.dataset.symbol) || null)
    .filter(Boolean);
}

// Эмуляция onEnd из main.js: собрать порядок по DOM → в состояние
function collectIntoState() {
  sandbox.getCurrentList().tickers = domSymbols();
}

function counterOf(sym) {
  const node = sandbox.__rowsCache.map.get(sym);
  const el = node && node.el ? node.el : node;
  return el.querySelector('.section-count').textContent.trim();
}

// Эмуляция onStart+drop+onEnd из main.js для перетаскивания ЗАГОЛОВКА
function dragSection(headerSym, dropBeforeNodeOrNull) {
  const header = sandbox.__rowsCache.map.get(headerSym);
  const followers = sandbox.sectionFollowerNodes(header); // onStart
  moveNode(container, header, dropBeforeNodeOrNull);      // Sortable переносит только узел
  sandbox.resolveSectionDrop(header, followers);          // onEnd: блок + границы разделов
  collectIntoState();
  sandbox.applySectionCollapse(sandbox.getCurrentList());
  return followers;
}

// Сборка нового состава с чистого контейнера: мини-DOM insertBefore при
// перестановке внутри родителя дублирует узлы, поэтому diff-перерисовку
// поверх изменённого порядка не используем.
async function renderFresh(tickers) {
  sandbox.getCurrentList().tickers = tickers;
  sandbox.__rowsCache = { map: new sandbox.Map(), listId: '__fresh__' };
  await sandbox.render();
}

(async () => {
  const list = sandbox.appState.lists.default;
  const A = ['A1', 'A2', 'A3'];
  const B = ['B1', 'B2', 'B3', 'B4'];
  list.tickers = ['SECTION:Альфа', ...A, 'SECTION:Бета', ...B];
  [...A, ...B].forEach((s, i) => { priceStore[s] = { price: 100 + i, changeValue: 1, changeDay: 0.5 }; });

  await sandbox.render();
  const headerA = sandbox.__rowsCache.map.get('SECTION:Альфа');
  const headerB = sandbox.__rowsCache.map.get('SECTION:Бета');

  assert(sandbox.sectionFollowerNodes(headerA).length === 3, 'sectionFollowerNodes: у раздела Альфа 3 тикера');
  assert(sandbox.sectionFollowerNodes(headerB).length === 4, 'sectionFollowerNodes: у раздела Бета 4 тикера');
  assert(sandbox.sectionFollowerNodes(sandbox.__rowsCache.map.get('A1').el).length === 0,
         'sectionFollowerNodes: у обычной строки тикера спутников нет');

  // --- Сценарий 1: раздел Альфа тянут в самый низ, за тикеры Беты ---
  dragSection('SECTION:Альфа', null);
  assert(domSymbols().join(',') === 'SECTION:Бета,B1,B2,B3,B4,SECTION:Альфа,A1,A2,A3',
         'Раздел переехал вместе с тикерами: Бета(4) → Альфа(3)');
  assert(list.tickers.join(',') === domSymbols().join(','), 'Состояние совпадает с DOM после drop');
  assert(counterOf('SECTION:Бета') === '4', 'Счётчик Беты остался 4');
  assert(counterOf('SECTION:Альфа') === '3', 'Счётчик Альфы остался 3');
  assert(sandbox.sectionFollowerNodes(headerA).map(n => n.dataset.symbol).join(',') === 'A1,A2,A3',
         'Тикеры Альфы идут сразу за её заголовком');

  // --- Сценарий 2: снап ВВЕРХ — бросили сразу после заголовка Беты ---
  // Без снапа раздел встал бы внутрь блока Беты и «забрал» её тикеры B1..B4.
  dragSection('SECTION:Альфа', sandbox.__rowsCache.map.get('B1').el);
  assert(domSymbols().join(',') === 'SECTION:Альфа,A1,A2,A3,SECTION:Бета,B1,B2,B3,B4',
         'Бросок внутрь блока Беты подтянут к его началу (перед заголовок)');
  assert(counterOf('SECTION:Бета') === '4', 'Бета не потеряла тикеры при снапе вверх');
  assert(counterOf('SECTION:Альфа') === '3', 'Альфа не «украла» тикеры Беты');

  // --- Сценарий 3: снап ВНИЗ — бросили ближе к концу блока Беты ---
  dragSection('SECTION:Альфа', sandbox.__rowsCache.map.get('B3').el);
  assert(domSymbols().join(',') === 'SECTION:Бета,B1,B2,B3,B4,SECTION:Альфа,A1,A2,A3',
         'Бросок в середину блока Беты подтянут к его концу');
  assert(counterOf('SECTION:Бета') === '4', 'Бета не потеряла тикеры при снапе вниз');

  // --- Сценарий 4: заголовок протащили внутрь своего же блока — блок не рвётся ---
  const before = domSymbols().join(',');
  dragSection('SECTION:Альфа', sandbox.__rowsCache.map.get('A1').el);
  assert(domSymbols().join(',') === before, 'Заголовок, брошенный внутри своего блока, возвращается на место');

  // --- Сценарий 5: свёрнутый раздел переезжает вместе с (скрытыми) тикерами ---
  list.collapsedSections = ['SECTION:Альфа'];
  sandbox.applySectionCollapse(list);
  assert(sandbox.__rowsCache.map.get('A1').el.style.display === 'none', 'Тикеры свёрнутого раздела скрыты');
  dragSection('SECTION:Альфа', sandbox.__rowsCache.map.get('SECTION:Бета'));
  assert(domSymbols().join(',') === 'SECTION:Альфа,A1,A2,A3,SECTION:Бета,B1,B2,B3,B4',
         'Свёрнутый раздел переехал вместе с тикерами');
  assert(sandbox.__rowsCache.map.get('A1').el.style.display === 'none',
         'Свёрнутость сохранена после переезда');
  assert(counterOf('SECTION:Альфа') === '3', 'Счётчик свёрнутого раздела не поехал');

  // --- Сценарий 6: ПУСТОЙ раздел не забирает тикеры чужого блока ---
  delete list.collapsedSections;
  await renderFresh(['SECTION:Бета', ...B, 'SECTION:Пусто']);
  dragSection('SECTION:Пусто', sandbox.__rowsCache.map.get('B1').el);
  assert(domSymbols().join(',') === 'SECTION:Пусто,SECTION:Бета,B1,B2,B3,B4',
         'Пустой раздел, брошенный внутрь блока, встал перед ним');
  assert(counterOf('SECTION:Бета') === '4', 'Пустой раздел не забрал тикеры Беты');

  // --- Сценарий 7: перенос раздела с одним тикером ---
  await renderFresh(['SECTION:Гамма', 'G1', 'SECTION:Дельта']);
  dragSection('SECTION:Гамма', null);
  assert(domSymbols().join(',') === 'SECTION:Дельта,SECTION:Гамма,G1',
         'Раздел с одним тикером переезжает вместе с ним');

  // --- Сценарий 8: тикеры до первого заголовка разделу не принадлежат —
  // drop среди них не снапится, раздел встаёт именно туда (он «начинается здесь»)
  ['T1', 'T2', 'T3'].forEach((s, i) => { priceStore[s] = { price: 50 + i, changeValue: 0, changeDay: 0 }; });
  await renderFresh(['T1', 'T2', 'T3', 'SECTION:Бета', ...B]);
  dragSection('SECTION:Бета', sandbox.__rowsCache.map.get('T2').el);
  assert(domSymbols().join(',') === 'T1,SECTION:Бета,B1,B2,B3,B4,T2,T3',
         'Drop среди тикеров без раздела не подтягивается к границе');

  // --- Статическая защита: main.js реально использует хелперы блока ---
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  const startIdx = mainSrc.indexOf('onStart:');
  assert(startIdx >= 0, 'main.js: Sortable.onStart присутствует');
  assert(/sectionFollowerNodes\s*\(\s*evt\.item\s*\)/.test(mainSrc.slice(startIdx, startIdx + 900)),
         'main.js: onStart запоминает тикеры раздела через sectionFollowerNodes');
  assert(/resolveSectionDrop\s*\(\s*evt\.item\s*,\s*dragBlock\.followers\s*\)/.test(mainSrc),
         'main.js: onEnd ставит блок раздела через resolveSectionDrop (со снапом к границам)');
  assert(/moveBlockOrderToDb\s*\(\s*appState\.activeListId\s*,\s*blockSymbols\s*,\s*targetIndex\s*\)/.test(mainSrc),
         'main.js: блок сохраняется одним запросом moveBlockOrderToDb');
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  assert(/snapSectionDropIndex/.test(uiSrc) && /section-header/.test(uiSrc),
         'ui.js: snapSectionDropIndex ищет границы по заголовкам разделов');
  const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8');
  assert(/\/api\/watchlist\/move-block/.test(stateSrc),
         'state.js: moveBlockOrderToDb ходит в /api/watchlist/move-block');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
