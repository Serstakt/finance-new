// Тест тепловой карты «Главная» (js/heatmap.js).
// Прогоняет РЕАЛЬНЫЕ api.js + heatmap.js через node:vm с самописной
// DOM-эмуляцией и проверяет:
//   * squarified treemap: покрытие ≈ 100%, без пересечений, aspect ratio ограничен;
//   * classifyAssetType (зеркало классификации бэкенда);
//   * цветовая шкала hmColor (нейтраль/знак/clamp/размах периода);
//   * загрузку состава всех списков (дедуп тикеров) и источники данных
//     по периодам: «день» → /api/prices/batch, «неделя» → /api/heatmap/changes;
//   * рендер зон/плиток, пороги читаемости, пометку partial;
//   * клик-роутинг symbol → список (тот же путь, что клик по строке watchlist).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- Мини-DOM (минимум для heatmap.js) ----------
class Node {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this._kids = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this.listeners = {};
    this._text = '';
    this._html = '';
    this.id = '';
    this.offsetWidth = 120;   // для расчёта позиции тултипа
    this.offsetHeight = 60;
    this.clientWidth = 600;   // дефолт для зон групп (тест перезадаёт area явно)
    this.clientHeight = 380;
  }
  get children() { return this._kids; }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...c) => c.forEach(x => this._classes.add(x)),
    remove: (...c) => c.forEach(x => this._classes.delete(x)),
    toggle: (c, force) => { const on = force === undefined ? !this._classes.has(c) : !!force; on ? this._classes.add(c) : this._classes.delete(c); return on; },
    contains: (c) => this._classes.has(c),
  };
  get textContent() { return this._text || (this._html ? this._html.replace(/<[^>]*>/g, '') : ''); }
  set textContent(v) { this._kids = []; this._text = String(v); this._html = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._kids = []; this._html = String(v); this._text = ''; }
  appendChild(n) {
    if (n.parentNode) n.remove();
    n.parentNode = this;
    this._kids.push(n);
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode._kids.indexOf(this);
    if (i >= 0) this.parentNode._kids.splice(i, 1);
    this.parentNode = null;
  }
  setAttribute(k, v) { if (k === 'class') this.className = v; if (k === 'id') this.id = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  closest(sel) {
    const cls = sel.replace(/^\./, '');
    let n = this;
    while (n) { if (n._classes.has(cls)) return n; n = n.parentNode; }
    return null;
  }
  _descendants(out) { for (const c of this._kids) { out.push(c); c._descendants(out); } return out; }
  querySelector(sel) {
    if (!sel.startsWith('.')) return null;
    const cls = sel.slice(1);
    return this._descendants([]).find(n => n._classes.has(cls)) || null;
  }
}

// ---------- Окружение ----------
const nodesById = {};
function makeEl(id, tag) { const e = new Node(tag); e.id = id; nodesById[id] = e; return e; }
const area = makeEl('watchlist-heatmap', 'div');
area.clientWidth = 800;
area.clientHeight = 400;
makeEl('heatmap-legend-bar', 'div');
makeEl('heatmap-legend-min', 'span');
makeEl('heatmap-legend-max', 'span');
const tooltip = makeEl('heatmap-tooltip', 'div');

// Кнопки периода и сортировки — document.querySelectorAll(...) возвращает их
const periodBtns = ['day', 'week', 'month'].map(p => {
  const b = new Node('button');
  b.className = p === 'day' ? 'hm-period-btn active' : 'hm-period-btn';
  b.dataset.period = p;
  return b;
});
const sortBtns = ['list', 'gainers', 'losers'].map(s => {
  const b = new Node('button');
  b.className = s === 'list' ? 'hm-sort-btn active' : 'hm-sort-btn';
  b.dataset.sort = s;
  return b;
});

const storage = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } },
  sessionStorage: { getItem: () => 'home', setItem() {}, removeItem() {} },
  document: {
    hidden: false,
    getElementById: (id) => nodesById[id] || null,
    createElement: (tag) => new Node(tag),
    querySelectorAll: (sel) => {
      if (sel === '.hm-period-btn') return periodBtns;
      if (sel === '.hm-sort-btn') return sortBtns;
      return [];
    },
    addEventListener() {},
    body: new Node('body'),
    head: new Node('head'),
  },
  location: { protocol: 'http:', port: '8000' },
  innerWidth: 1200, innerHeight: 800,
  addEventListener() {}, // window.addEventListener('resize') в bindHeatmapEvents
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  Date, Math, JSON, Promise, encodeURIComponent, Map, Set, String, Number, Object, Array, RegExp, Infinity,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// заглушки приложений вокруг карты
vm.runInContext(`
  window.appState = {
    activeListId: 'default',
    lists: {
      default: { name: 'Основной', tickers: ['MOEX:SBER', 'MOEX:IMOEX'], activeSymbol: 'MOEX:SBER', collapsedSections: [] },
      crypto: { name: 'Крипта', tickers: ['BINANCE:BTCUSDT'], activeSymbol: '', collapsedSections: [] },
    },
    favorites: {}, notes: {},
  };
  window.getCurrentList = () => appState.lists[appState.activeListId];
  window.navigateTo = (page) => navCalls.push(page);
  window.switchList = (id) => switchCalls.push(id);
  window.syncListWithDb = async () => {};
  window.setActiveSymbolInDb = (listId, sym, immediate) => { activeSymCalls.push([listId, sym, !!immediate]); return true; };
  window.createChart = (sym) => { createChartCalls.push(sym); };
  window.findListWithTicker = () => null;
  window.log = () => {};
  window.navCalls = []; window.switchCalls = []; window.activeSymCalls = []; window.createChartCalls = [];
`, sandbox);

// Ответы «сети»: тест кладёт payload в очередь по подстроке URL.
const urlLog = [];
const responses = [
  { match: 'watchlists/symbols', body: { symbols_by_list: {
    default: ['MOEX:GAZP', 'MOEX:SBER', 'MOEX:IMOEX'], // GAZP в списке ПЕРВЫЙ —
    // важно для сортировки: порядок «по списку» [GAZP, SBER] отличим от «роста»
    crypto: ['BINANCE:BTCUSDT', 'MOEX:SBER'], // SBER в двух списках — проверка дедупа
  } } },
  { match: 'prices/batch', body: { prices: {
    'MOEX:GAZP': { symbol: 'MOEX:GAZP', price: 120.4, changeDay: -3, changeValue: -3.7 },
    'MOEX:SBER': { symbol: 'MOEX:SBER', price: 254.5, changeDay: 1.5, changeValue: 3.8 },
    'MOEX:IMOEX': { symbol: 'MOEX:IMOEX', price: 3200, changeDay: -0.6, changeValue: -19 },
    'BINANCE:BTCUSDT': { symbol: 'BINANCE:BTCUSDT', price: 96000, changeDay: 0.2, changeValue: 190 },
  } } },
  { match: 'heatmap/changes', body: { changes: {
    'MOEX:GAZP': { changePct: -30, partial: false },
    'MOEX:SBER': { changePct: 5, partial: true },
    'MOEX:IMOEX': { changePct: -2, partial: false },
    'BINANCE:BTCUSDT': { changePct: -12.5, partial: false },
  } } },
];
sandbox.fetch = async (url) => {
  urlLog.push(String(url));
  const hit = responses.find(r => String(url).includes(r.match));
  return { ok: !!hit, status: hit ? 200 : 404, json: async () => (hit ? hit.body : {}) };
};

// реальные исходники
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'heatmap.js'), 'utf8'), sandbox);

// алиас для вызовов window.* из этого файла (sandbox.window === sandbox)
const window = sandbox.window;

// ---------- 1. SQUARIFIED TREEMAP (чистая математика, без DOM) ----------
{
  const entries = Array.from({ length: 24 }, (_, i) => ({ key: 'k' + i, weight: 1 }));
  const rects = window.hmSquarify(entries, { x: 0, y: 0, w: 800, h: 400 });
  assert(rects.length === 24, 'squarify: все элементы размещены');
  const total = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert(Math.abs(total - 800 * 400) / (800 * 400) < 0.01, 'squarify: покрытие ≈ 100%');
  let overlap = false, maxRatio = 0;
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      if (a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 &&
          a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6) overlap = true;
    }
    maxRatio = Math.max(maxRatio, a.w / a.h, a.h / a.w);
  }
  assert(!overlap, 'squarify: нет пересечений');
  assert(maxRatio <= 8, `squarify: aspect ratio ограничен (max ${maxRatio.toFixed(2)} <= 8)`);
  const weights = [{ key: 'a', weight: 4 }, { key: 'b', weight: 1 }];
  const rw = window.hmSquarify(weights, { x: 0, y: 0, w: 400, h: 200 });
  const big = rw.find(r => r.key === 'a'), small = rw.find(r => r.key === 'b');
  assert(big && small && Math.abs(big.w * big.h / (small.w * small.h) - 4) < 0.05,
    'squarify: площади пропорциональны весам (4:1)');
}

// ---------- 2. ТИП АКТИВА ----------
assert(window.classifyAssetType('BINANCE:BTCUSDT') === 'crypto', 'тип: BINANCE: -> крипта');
assert(window.classifyAssetType('MOEX:IMOEX') === 'index', 'тип: IMOEX -> индекс');
assert(window.classifyAssetType('IMOEX') === 'index', 'тип: индекс без префикса');
assert(window.classifyAssetType('USD000UTSTOM') === 'currency', 'тип: валютная пара');
assert(window.classifyAssetType('MOEX:CNYRUB') === 'currency', 'тип: *RUB -> валюта');
assert(window.classifyAssetType('MOEX:SBER') === 'stock', 'тип: SBER -> акция');

// ---------- 3. ЦВЕТ hmColor ----------
assert(window.hmColor(null, 'day') === '#454b59', 'цвет: нет данных — нейтральный серый');
assert(window.hmColor(0, 'day') === 'rgb(62, 67, 79)', 'цвет: 0 — нейтральный базовый');
const up = window.hmColor(2, 'day'), down = window.hmColor(-2, 'day');
assert(up.includes('166') && up.startsWith('rgb(38'), 'цвет: +lim — зелёный #26a69a');
assert(down.startsWith('rgb(239'), 'цвет: -lim — красный #ef5350');
assert(window.hmColor(99, 'day') === window.hmColor(2, 'day'), 'цвет: clamp по размаху периода');
assert(window.hmColor(2, 'week') !== window.hmColor(2, 'day'), 'цвет: размах зависит от периода');

// ---------- 4. ЗАГРУЗКА СОСТАВА СПИСКОВ (дедуп) ----------
(async () => {
  await window.loadHeatmap();
  assert(urlLog.some(u => u.includes('/api/watchlists/symbols')), 'загрузка: GET /api/watchlists/symbols уходит');
  const syms = window.collectHeatmapSymbols ? await window.collectHeatmapSymbols() : [];
  // collectHeatmapSymbols возвращает массив {symbol, lists}; после loadHeatmap он уже собран
  assert(syms.length === 4, `дедуп: SBER в двух списках не задваивается (4 уникальных, получено ${syms.length})`);
  const sber = syms.find(s => s.symbol === 'MOEX:SBER');
  assert(sber && sber.lists.length === 2, 'дедуп: SBER знает оба списка');

  // ---------- 5. РЕНДЕР: ЗОНЫ И ПЛИТКИ ----------
  // let: после сортировочных пересборок (6.5) ссылки обновляются на живые узлы
  let groups = area.children.filter(c => c._classes.has('hm-group'));
  // Типы в тестовых данных: stock (GAZP+SBER), index (IMOEX), crypto (BTCUSDT)
  assert(groups.length === 3, `рендер: три зоны по типам активов (получено ${groups.length})`);
  let allTiles = [];
  const areaProblems = [];
  for (const g of groups) {
    const inner = g.querySelector('.hm-group-area');
    const tiles = inner.children.filter(c => c._classes.has('hm-tile'));
    allTiles.push(...tiles);
    const sum = tiles.reduce((s, t) => s + parseFloat(t.style.width) * parseFloat(t.style.height), 0);
    const box = inner.clientWidth * inner.clientHeight;
    if (Math.abs(sum - box) / box > 0.01) areaProblems.push(box);
  }
  assert(allTiles.length === 4, `рендер: 4 плитки (получено ${allTiles.length})`);
  assert(areaProblems.length === 0, 'рендер: плитки зоны покрывают её без пустот');
  const labels = groups.map(g => g.querySelector('.hm-group-label').textContent);
  assert(labels.some(l => l.startsWith('Крипта')), 'рендер: зона «Крипта» подписана');
  assert(labels.some(l => /Акции|Индексы/.test(l)), 'рендер: зоны акций/индексов подписаны');

  // ---------- 6. ПЕРИОД «ДЕНЬ»: цены из /api/prices/batch ----------
  assert(urlLog.some(u => u.includes('/api/prices/batch')), 'день: цены из /api/prices/batch');
  assert(window.hmPeriodChangeOf('MOEX:SBER') === 1.5, 'день: changeDay = источник цвета');
  let sberTile = allTiles.find(t => t.dataset.symbol === 'MOEX:SBER');
  assert(sberTile.style.background === window.hmColor(1.5, 'day'), 'день: плитка окрашена hmColor(changeDay)');
  assert(!sberTile._classes.has('hm-partial'), 'день: пометки partial нет');

  // Текущая цена на плитке (правый нижний угол, .hm-price)
  const sberPriceEl = sberTile.querySelector('.hm-price');
  assert(!!sberPriceEl && sberPriceEl.textContent.includes('254,5'),
    `день: цена на плитке SBER (получено «${sberPriceEl && sberPriceEl.textContent}»)`);
  const btcPriceEl = allTiles.find(t => t.dataset.symbol === 'BINANCE:BTCUSDT').querySelector('.hm-price');
  assert(!!btcPriceEl && btcPriceEl.textContent.includes('96'),
    'день: цена крипты на плитке BTCUSDT');

  // ---------- 6.5 СОРТИРОВКА ПЛИТОК (внутри зоны «Акции»: GAZP -3, SBER +1.5) ----------
  // Порядок читаем каждый раз ЗАНОВО из area: renderHeatmap пересобирает
  // DOM, старые ссылки на группы/плитки открепляются (как в реальном браузере).
  const stockOrder = () => {
    const g = area.children.filter(c => c._classes.has('hm-group'))
      .find(gr => gr.querySelector('.hm-group-area').children
        .some(c => c.dataset.symbol === 'MOEX:SBER'));
    return g.querySelector('.hm-group-area').children
      .filter(c => c._classes.has('hm-tile')).map(c => c.dataset.symbol);
  };

  assert(JSON.stringify(stockOrder()) === JSON.stringify(['MOEX:GAZP', 'MOEX:SBER']),
    `сортировка «По списку»: как в watchlist — GAZP первый (получено ${stockOrder()})`);

  window.setHeatmapSort('gainers');
  assert(JSON.stringify(stockOrder()) === JSON.stringify(['MOEX:SBER', 'MOEX:GAZP']),
    `сортировка «Рост ↓»: SBER (+1,5%) перед GAZP (-3%) (получено ${stockOrder()})`);
  assert(storage['heatmap_sort'] === 'gainers', 'сортировка: режим сохранён в localStorage');
  assert(sortBtns.find(b => b.dataset.sort === 'gainers')._classes.has('active'),
    'сортировка: кнопка «Рост ↓» активна');

  window.setHeatmapSort('losers');
  assert(JSON.stringify(stockOrder()) === JSON.stringify(['MOEX:GAZP', 'MOEX:SBER']),
    `сортировка «Падение ↑»: GAZP (-3%) перед SBER (+1,5%) (получено ${stockOrder()})`);

  window.setHeatmapSort('list');
  assert(JSON.stringify(stockOrder()) === JSON.stringify(['MOEX:GAZP', 'MOEX:SBER']),
    'сортировка: возврат к «По списку» восстанавливает порядок списков');

  // Серия пересборок карты позади — обновляем ссылки на живые узлы для секций ниже
  groups = area.children.filter(c => c._classes.has('hm-group'));
  allTiles = [];
  for (const g of groups) {
    const inner = g.querySelector('.hm-group-area');
    allTiles.push(...inner.children.filter(c => c._classes.has('hm-tile')));
  }
  sberTile = allTiles.find(t => t.dataset.symbol === 'MOEX:SBER');

  // ---------- 7. ПЕРИОД «НЕДЕЛЯ»: /api/heatmap/changes ----------
  urlLog.length = 0;
  window.setHeatmapPeriod('week');
  await Promise.resolve(); await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
  assert(storage['heatmap_period'] === 'week', 'период: выбор сохранён в localStorage');
  assert(urlLog.some(u => u.includes('/api/heatmap/changes') && u.includes('period=week')),
    'неделя: GET /api/heatmap/changes?period=week уходит');
  assert(urlLog.some(u => u.includes('/api/prices/batch')),
    'неделя: цены тоже обновляются (плитка показывает текущую цену во всех периодах)');
  assert(window.hmPeriodChangeOf('MOEX:SBER') === 5, 'неделя: значение из свечного расчёта');
  assert(sberTile._classes.has('hm-partial'), 'неделя: partial-плитка помечена пунктиром');
  assert(sberTile.style.background === window.hmColor(5, 'week'), 'неделя: плитка перекрашена по новой шкале');
  const btcTile = allTiles.find(t => t.dataset.symbol === 'BINANCE:BTCUSDT');
  assert(btcTile.style.background === window.hmColor(-12.5, 'week'), 'неделя: clamp -12.5 на шкале ±7 — как -7');
  assert(periodBtns.find(b => b.dataset.period === 'week')._classes.has('active'), 'период: кнопка «Неделя» активна');
  assert(!periodBtns.find(b => b.dataset.period === 'day')._classes.has('active'), 'период: кнопка «День» неактивна');

  // Легенда перестроилась под размах недели (±7%)
  const grad = nodesById['heatmap-legend-bar'].style.background || '';
  assert(grad.startsWith('linear-gradient'), 'легенда: градиент из цветов hmColor построен');

  // ---------- 8. ПОРОГИ ЧИТАЕМОСТИ ----------
  // 48×56: меньше порогов цены (70×48) и % (62×42), больше порога тикера (42×26)
  sberTile.style.width = '48px'; sberTile.style.height = '56px';
  window.updateHeatmapColors();
  assert(sberTile._classes.has('no-change') && sberTile._classes.has('no-price')
    && !sberTile._classes.has('no-label'),
    'пороги: узкая плитка прячет % и цену, но держит тикер');
  sberTile.style.width = '20px'; sberTile.style.height = '12px';
  window.updateHeatmapColors();
  assert(sberTile._classes.has('no-label'), 'пороги: мелкая плитка без подписей (только цвет)');

  // ---------- 9. TOOLTIP ----------
  window.showHeatmapTooltip('MOEX:SBER', 100, 100);
  const tipHtml = tooltip.innerHTML || '';
  assert(tipHtml.includes('SBER'), 'tooltip: тикер показан');
  assert(tipHtml.includes('За неделю'), 'tooltip: подпись периода');
  assert(tipHtml.includes('частичный'), 'tooltip: пометка частичного расчёта');
  window.hideHeatmapTooltip();
  assert(tooltip.style.display === 'none', 'tooltip: скрывается по mouseleave');

  // ---------- 10. КЛИК ПО ПЛИТКЕ -> WATCHLIST ----------
  // (а) тикер уже в активном списке
  window.openHeatmapSymbol('MOEX:SBER');
  assert(window.navCalls.includes('watchlist'), 'клик: переход на Watchlist');
  assert(window.createChartCalls.includes('MOEX:SBER'), 'клик: график открывается');
  assert(window.activeSymCalls.some(c => c[0] === 'default' && c[1] === 'MOEX:SBER'),
    'клик: активный тикер сохраняется в БД');

  // (б) тикер из другого списка — переключение списка
  window.navCalls.length = 0; window.switchCalls.length = 0;
  window.openHeatmapSymbol('BINANCE:BTCUSDT');
  assert(window.navCalls.includes('watchlist'), 'клик (чужой список): переход на Watchlist');
  assert(window.switchCalls.includes('crypto'), `клик (чужой список): switchList('crypto') уходит`);
  assert(window.activeSymCalls.some(c => c[0] === 'crypto' && c[1] === 'BINANCE:BTCUSDT'),
    'клик (чужой список): активный тикер пишется в тот же список');

  if (failures) { console.error(`\n${failures} TEST(S) FAILED`); process.exit(1); }
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
