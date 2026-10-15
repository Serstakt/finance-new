// Интеграционный тест инкрементальной отрисовки watchlist (keyed diffing).
// Прогоняет РЕАЛЬНЫЕ ui.js + api.js через node:vm с самописной DOM-эмиуляцией
// и проверяет, что строки не пересоздаются, а обновляются точечно.
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
    this.offsetWidth = 10; // для read-forcе рестарта анимации
    this.disabled = false; this.value = ''; this.placeholder = '';
    this.id = ''; this._liveKids = new Set(); this._textHtml = null;
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
    if (this._textHtml !== null) return this._textHtml.replace(/<[^>]*>/g, '');
    if (this.children.length === 0) return this._text;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) {
    // как в реальном DOM: удаляем детей, но атрибуты (class/id/data-*) сохраняются
    for (const c of this.children) c.parentNode = null;
    this.children = []; this._text = String(v); this._invalidate();
  }
  get innerHTML() { return this._html || ''; }
  set innerHTML(v) {
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
    const i = p._kids.indexOf(this);
    if (i >= 0) p._kids.splice(i, 1);
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
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] : null;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') { this.id = String(v); if (!nodesById[this.id]) nodesById[this.id] = this; } if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev = {}) { (this.listeners[type] || []).forEach(fn => { try { fn({ stopPropagation() {}, preventDefault() {}, target: this, currentTarget: this, ...ev }); } catch (e) { console.error('HANDLER ERROR:', e.message); } }); }
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
  _parsed() {
    if (!this._parsedCache) {
      this._parsedCache = [];
      const collect = (html) => {
        // упрощённый разбор: только теги верхнего уровня фрагмента (без вложенных одноимённых)
        const re = /<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*?)\/>|<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*?)>(?:(?!<\3[ >])[\s\S])*?<\/\3>/g;
        for (const m of html.matchAll(re)) {
          const tag = m[1] || m[3], attrs = m[2] || m[4];
          if (/^(script|style)$/i.test(tag)) continue;
          // если такой узел реально ДО СИХ ПОР ребёнок этого элемента — берём его
          // «живой» потомок с совпадающим классом (или id) — переиспользуем его
          const wantCls = (/class="([^"]*)"/.exec(attrs) || [])[1] || '';
          const wantId = (/\bid="([^"]*)"/.exec(attrs) || [])[1] || '';
          const live = [...this._liveKids].find(k => k.parentNode === this && (
            (wantId ? k.id === wantId : false) ||
            (!wantId && wantCls && k.className.split(/\s+/).filter(Boolean).join(' ') === wantCls.split(/\s+/).filter(Boolean).join(' '))
          ));
          if (live) { this._parsedCache.push(live); continue; }
          const el = new Node(tag);
          for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
          const openEnd = html.indexOf('>', m.index);
          if (/^span$/i.test(tag)) {
            // span у нас всегда с плоским содержимым — берём до ПЕРВОГО закрывающего тега
            const closeIdx = html.indexOf(`</${tag}>`, openEnd);
            if (closeIdx >= 0) el._textHtml = html.slice(openEnd + 1, closeIdx);
          } else {
            const closeIdx = html.lastIndexOf(`</${tag}>`);
            if (closeIdx >= 0) el._textHtml = html.slice(openEnd + 1, closeIdx);
          }
          this._parsedCache.push(el);
        }
      };
      collect(this._html || '');
      // children, добавленные через appendChild/parseFragment — тоже в индекс
      this._walk((n) => { if (!this._parsedCache.includes(n)) this._parsedCache.push(n); });
    }
    return this._parsedCache;
  }
  _invalidate() { this._parsedCache = null; for (let p = this.parentNode; p; p = p.parentNode) p._parsedCache = null; }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
  querySelectorAll(sel) {
    const sels = sel.split(',').map(x => x.trim());
    const direct = sels.some(s => s.startsWith(':scope >'));
    const out = [];
    const test = (n) => sels.some(s => n._matches(s));
    if (direct) { for (const c of this.children) if (test(c)) out.push(c); return out; }
    for (const n of this._parsed()) if (test(n)) out.push(n);
    return out;
  }
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
  for (const cm of inner.matchAll(/<(\w+)(?![\s\S]*<\/\1>[\s\S]*<\/\1>)[^>]*(?:\/>|>[\s\S]*?<\/\1>)/g)) {
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
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  document: {
    getElementById: (id) => nodesById[id] || null,
    createElement: (tag) => new Node(tag),
    querySelectorAll: () => [],
    addEventListener() {}, body: { style: {} },
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

// заглушки зависимостей из state.js/main.js
vm.runInContext(`
  window.appState = { activeListId: 'default', lists: { default: { name: 'Тест', tickers: [], activeSymbol: '', collapsedSections: [] } }, favorites: {}, notes: {} };
  window.currentSort = { field: null, direction: 'asc' };
  window.activePickerSymbol = null;
  window.FLAG_COLORS = { red: { hex: '#ef5350' }, blue: { hex: '#2962ff' } };
  window.AUTO_REFRESH_INTERVAL = 120000;
  window.getCurrentList = () => appState.lists[appState.activeListId];
  window.saveState = () => {};
  window.populateListSelector = () => {};
  window.setCollapsedInDb = () => {};
  window.removeTickerFromDb = () => {};
  window.saveOrderToDb = () => {};
  window.setNoteInDb = async () => true;
  window.syncAlertsWithDb = () => {};
  window.loadTickerNews = () => {};
  window.createChartCalls = [];
  window.createChart = function(sym) { createChartCalls.push(sym); document.getElementById('tradingview_chart').dataset.activeSymbol = sym; };
`, sandbox);

// реальные исходники
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'), sandbox);

// подменяем fetchTickerData управляемой заглушкой
const priceStore = {};
vm.runInContext(`window.fetchTickerData = async (sym) => {
  window.__fetchCount = (window.__fetchCount || 0) + 1;
  const d = priceStore[sym];
  return d === undefined ? null : d;
}`, sandbox);
sandbox.priceStore = priceStore;

(async () => {
  const list = sandbox.appState.lists.default;
  list.tickers = ['SECTION:Росия', 'SBER', 'GAZP', 'BINANCE:BTCUSDT'];
  priceStore['SBER'] = { price: 300, changeValue: 1.5, changeDay: 0.5 };
  priceStore['GAZP'] = { price: 120, changeValue: -0.5, changeDay: -0.4 };
  priceStore['BINANCE:BTCUSDT'] = { price: 70000, changeValue: 100, changeDay: 0.1 };

  await sandbox.render();
  assert(container.children.length === 4, 'Отрисованы 4 узла (секция + 3 тикера)');
  const sberEntry = sandbox.__rowsCache.map.get('SBER');
  const gazpEntry = sandbox.__rowsCache.map.get('GAZP');
  const secNode = sandbox.__rowsCache.map.get('SECTION:Росия');
  assert(!!sberEntry && !!gazpEntry && !!secNode, 'Кэш узлов заполнен');
  assert(sberEntry.el.querySelector('#price-SBER').textContent.includes('300'), 'Цена SBER отображена');

  // --- Автообновление БЕЗ изменения цен: те же самые DOM-узлы, без пересоздания ---
  const before = container.children.slice();
  const innerBefore = sberEntry.el.innerHTML;
  await sandbox.render();
  assert(container.children.every((c, i) => c === before[i]), 'DOM-узлы НЕ пересозданы при равных данных');
  assert(sandbox.__rowsCache.map.get('SBER').el === sberEntry.el, 'Строка SBER — тот же объект');
  assert(sberEntry.el.innerHTML === innerBefore, 'innerHTML строки не менялся');

  // --- Цена изменилась: обновился только текст, узел прежний ---
  priceStore['SBER'] = { price: 301, changeValue: 1.5, changeDay: 0.5 };
  await sandbox.render();
  assert(sandbox.__rowsCache.map.get('SBER').el === sberEntry.el, 'Узел сохранён после изменения цены');
  assert(sberEntry.el.querySelector('#price-SBER').textContent.includes('301'), 'Новая цена записана инкрементально');
  assert(sberEntry.el.querySelector('#price-SBER')._classes.has('price-flash'), 'Включена flash-подсветка изменившейся цены');

  // --- Сбой сети: предыдущая цена остаётся на месте (без мигания ошибкой) ---
  delete priceStore['SBER'];
  await sandbox.render();
  assert(sberEntry.el.querySelector('#price-SBER').textContent.includes('301'), 'При временном сбое MOEX старая цена сохранена');

  // --- Удаление тикера (клик по «×» строки) -> удаление узла из DOM и кэша ---
  gazpEntry.el.querySelector('.ticker-remove').fire('click');
  await new Promise(r => setTimeout(r, 0)); // дождаться async-обработчика
  await sandbox.render();
  assert(!container.children.includes(gazpEntry.el), 'Удалённый тикер убран из DOM');
  assert(!sandbox.__rowsCache.map.has('GAZP'), 'Кэш узлов почищен (нет утечки)');

  // --- Смена списка: полный сброс кэша и контейнера ---
  sandbox.appState.lists.other = { name: 'Другой', tickers: ['LKOH'], activeSymbol: '', collapsedSections: [] };
  sandbox.appState.activeListId = 'other';
  priceStore['LKOH'] = { price: 6000, changeValue: 10, changeDay: 0.2 };
  await sandbox.render();
  assert(container.children.length === 1 && container.children[0].dataset.symbol === 'LKOH', 'При смене списка DOM пересобран корректно');

  // --- Свёрнутый раздел: применён display:none без полной перерисовки ---
  sandbox.appState.activeListId = 'default';
  list.collapsedSections = ['SECTION:Росия'];
  await sandbox.render();
  const sberEl = sandbox.__rowsCache.map.get('SBER').el;
  assert(sberEl.style.display === 'none', 'Строки свёрнутого раздела скрыты');
  assert(secNode.querySelector('.section-collapse-btn').textContent === '\u25b6', 'Стрелка секции переключена на свёрнутую');

  // --- График: createChart вызывается только при СМЕНЕ активного тикера ---
  const chartCallsBefore = sandbox.createChartCalls.length;
  priceStore['SBER'] = { price: 302, changeValue: 1.5, changeDay: 0.5 };
  await sandbox.render();
  assert(sandbox.createChartCalls.length === chartCallsBefore, 'createChart НЕ вызывалась при автообновлении цен');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
