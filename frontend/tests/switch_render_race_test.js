// Интеграционный тест гонки при быстром переключении табов списков.
// Сценарий из жизни: открыт список RUS, пользователь несколько раз кликает
// RUS <-> CRYPTO и останавливается на CRYPTO. Из-за того, что render()
// асинхронный (ждёт цены), а syncListWithDb может отрисовать данные ПОВЕРХ
// ещё не перерисованного DOM предыдущего списка, пользователь видел
// мигание: сначала строки RUS, потом CRYPTO.
//
// Проверки:
// 1) switchList мгновенно очищает контейнер от строк предыдущего списка;
// 2) ответ БД по НЕактивному списку никогда не рисует в чужой DOM;
// 3) ранний ответ БД по активному списку не оставляет в DOM строк
//    предыдущего списка (проверка после await цен — до diff-цикла);
// 4) финальный DOM = тикеры CRYPTO.
//
// Прогоняет РЕАЛЬНЫЕ state.js + ui.js через node:vm; для ui.js используется
// упрощённая DOM-эмуляция (полноэкранную см. в render_diff_test.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- Мини-DOM (упрощённый, только для render-цикла) ----------
class El {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this.id = '';
    this._html = '';
    this._text = '';
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...c) => c.forEach(x => this._classes.add(x)),
    remove: (...c) => c.forEach(x => this._classes.delete(x)),
    toggle: (c, force) => { const on = force === undefined ? !this._classes.has(c) : !!force; on ? this._classes.add(c) : this._classes.delete(c); },
    contains: (c) => this._classes.has(c),
  };
  get textContent() { return String(this._html).replace(/<[^>]*>/g, '') + this._text; }
  set innerHTML(v) {
    this._html = String(v);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    // строкаticker-item содержит крестик удаления — buildRowElement вешает на
    // него слушатель через querySelector('.ticker-remove'), эмулируем узел
    if (/ticker-remove/.test(this._html)) {
      const x = new El('span');
      x.className = 'ticker-remove';
      x.parentNode = this; this.children.push(x);
    }
  }
  get innerHTML() { return this._html; }
  appendChild(n) {
    if (n.parentNode && n.parentNode !== this) n.remove();
    n.parentNode = this; this.children.push(n); return n;
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode && n.parentNode !== this) n.remove();
    let i = this.children.indexOf(ref);
    if (i < 0) i = this.children.length;
    n.parentNode = this; this.children.splice(i, 0, n); return n;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
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
  addEventListener() {}
  querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; }
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, '');
    return this.children.filter(c => c._classes.has(cls));
  }
  closest() { return null; }
  setAttribute(k, v) { if (k.startsWith('data-')) this.dataset[k.slice(5)] = v; }
}
function clearEl(el) { for (const c of el.children) c.parentNode = null; el.children = []; el._html = ''; }

const nodesById = {};
function makeEl(id, tag) { const e = new El(tag); e.id = id; nodesById[id] = e; return e; }
const container = makeEl('ticker-list', 'div');
makeEl('tradingview_chart', 'div');
makeEl('list-selector', 'select');
makeEl('news-panel', 'div');

// ---------- Окружение sandbox ----------
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Object, Array,
  String, Number, Error, RegExp, encodeURIComponent, decodeURIComponent,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    getElementById: (id) => nodesById[id] || null,
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
    createTextNode: (t) => { const n = new El('#text'); n._text = String(t); return n; },
  },
  location: { protocol: 'http:', port: '' },
  API_BASE: 'http://test',
  fetch: async () => ({ ok: false, status: 500 }),
  log: () => {},
  createChart: () => {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Управляемый «медленный» fetch для GET /api/watchlist/{id}: резолвится
// только по команде теста (имитация очереди сетевых ответов).
const pending = {};   // listId -> массив resolver'ов
const dbData = {
  RUS:    { list_id: 'RUS',    name: 'RUS',    symbols: ['MOEX:SBER', 'MOEX:GAZP'], active_symbol: 'MOEX:SBER', items: [] },
  CRYPTO: { list_id: 'CRYPTO', name: 'CRYPTO', symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'], active_symbol: 'BINANCE:BTCUSDT', items: [] },
};
vm.runInContext(`
window.fetchWithTimeout = function(url, options = {}) {
  const m = String(url).match(/\\/api\\/watchlist\\/([^?]+)$/);
  if (!m || options.method) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }
  const listId = decodeURIComponent(m[1]);
  return new Promise((resolve) => {
    window.__pending[listId] = window.__pending[listId] || [];
    window.__pending[listId].push(() => resolve(
      { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(window.__dbData[listId])) }
    ));
  });
};
`, sandbox);
sandbox.__pending = pending;
sandbox.__dbData = dbData;

// Реальные исходники: api.js (fetchWithTimeout/fetchTickerData объявляются в
// ui/state зависимостях), затем state.js, затем ui.js.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'), sandbox);

// fetchTickerData — мгновенная заглушка (цены не суть этого теста).
vm.runInContext(`window.fetchTickerData = async (sym) => ({ price: 100, changeValue: 1, changeDay: 0.1 });`, sandbox);

// Помечаем все узлы контейнера, чтобы отличать строки RUS от строк CRYPTO.
function domSymbols() {
  return container.children.map(c => c.dataset.symbol || '');
}

(async () => {
  // Исходное состояние: оба списка известны (названия уже подтянуты), но
  // составы в кэше пустые — как при первом открытии раздела.
  sandbox.appState.lists = {
    RUS:    { name: 'RUS',    tickers: [], activeSymbol: '', collapsedSections: [] },
    CRYPTO: { name: 'CRYPTO', tickers: [], activeSymbol: '', collapsedSections: [] },
  };
  sandbox.appState.activeListId = 'RUS';

  // --- Клик 1: открыть RUS (switchList запускает render + syncListWithDb)
  const pRender1 = sandbox.switchList('RUS'); // render внутри async — не ждём
  assert(container.children.length === 0, 'Клик RUS: контейнер мгновенно очищен (сброс кэша узлов)');
  assert(pending.RUS && pending.RUS.length === 1, 'Клик RUS: запрос состава списка ушёл');

  // Ответ RUS приходит — список наполняется и рисуется.
  pending.RUS.shift()();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert(domSymbols().includes('MOEX:SBER'), 'Ответ RUS применён: SBER в DOM');

  // --- Быстрые клики RUS <-> CRYPTO (3-4 раза), остановились на CRYPTO.
  sandbox.switchList('CRYPTO');
  sandbox.switchList('RUS');
  sandbox.switchList('CRYPTO');
  sandbox.switchList('RUS');
  sandbox.switchList('CRYPTO');
  // Каждый клик запускал свой запрос; в очереди висят медленные ответы.
  assert(sandbox.appState.activeListId === 'CRYPTO', 'Активный список — CRYPTO');
  assert(pending.CRYPTO.length >= 1 && pending.RUS.length >= 1, 'Запросы обоих списков в полёте');

  // Размотка промисов/макрозадач.
  const tick = () => new Promise(r => setTimeout(r, 0));

  // --- Отвечаем на запросы последних кликов в ПРАВИЛЬНОМ порядке: сначала
  // активный CRYPTO (его данные должны примениться и отрисоваться), затем
  // устаревшие ответы по неактивному RUS.
  while (pending.CRYPTO.length) pending.CRYPTO.shift()();
  for (let i = 0; i < 5; i++) await tick();
  assert(domSymbols().includes('BINANCE:BTCUSDT'),
    'Ответ CRYPTO применён: BTCUSDT в DOM');

  // --- Последние ответы по НЕактивному RUS: serial-защита syncListWithDb +
  // «render только для активного таба» — чужой DOM не трогаем ни данными,
  // ни перерисовкой. (Первый ответ RUS был легитимным и уже отработан.)
  const beforeDom = domSymbols();
  while (pending.RUS.length > 1) pending.RUS.shift()();
  pending.RUS.shift()();
  for (let i = 0; i < 5; i++) await tick();
  assert(JSON.stringify(domSymbols()) === JSON.stringify(beforeDom),
    'Поздние ответы RUS не тронули DOM активного CRYPTO');

  // --- КЛЮЧЕВАЯ ПРОВЕРКА: отмена «висящего» render при переключении табов.
  // Порядок событий — ровно как в баге RUS -> CRYPTO:
  //   1) активен RUS, запускаем render-A: он ждёт цены RUS (медленные),
  //      DOM до этого момента НЕ трогает;
  //   2) быстрый клик CRYPTO: рендер нового списка должен мгновенно очистить
  //      контейнер и нарисовать CRYPTO (цены быстрые);
  //   3) медленные цены RUS наконец приходят -> render-A обязан прерваться
  //      ДО diff-цикла (проверка смены списка сразу после await цен).
  // Если бы проверка стояла ПОСЛЕ diff-цикла (как было раньше), render-A
  // переставил/дополнил бы DOM строками RUS — пользователь видел бы список
  // RUS поверх загруженного CRYPTO (исходный баг).
  sandbox.appState.activeListId = 'RUS';
  sandbox.appState.lists.RUS.tickers = ['MOEX:SBER', 'MOEX:GAZP'];
  // Задержка ФИКСИРУЕТСЯ при старте fetch и не меняется от последующих
  // переключений таба: window.__slowSymbols — объект «тикер -> мс», который
  // тест заполняет перед каждым render (как реальная сеть: запрос уже ушёл).
  vm.runInContext(`window.fetchTickerData = async (sym) => {
    const d = (window.__slowSymbols || {})[sym] || 0;
    await new Promise(res => setTimeout(res, d));
    return { price: 100, changeValue: 1, changeDay: 0.1 };
  };`, sandbox);
  vm.runInContext(`window.__slowSymbols = { 'MOEX:SBER': 60, 'MOEX:GAZP': 60 };`, sandbox);
  const pRenderA = sandbox.render();      // render-A: ждёт цены 60мс, потом diff
  await tick();
  assert(domSymbols().length === 0, 'render-A ещё не трогал DOM (ждёт цены RUS)');

  // Мгновенный клик CRYPTO: состав уже в кэше (ответ БД был раньше).
  // Эмулируем полный switchList(CRYPTO): activeListId + render (цены быстрые).
  sandbox.appState.activeListId = 'CRYPTO';
  sandbox.appState.lists.CRYPTO.tickers = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];
  vm.runInContext(`window.__slowSymbols = {};`, sandbox); // цены CRYPTO — мгновенно
  const pRenderB = sandbox.render();       // render-B: чистит DOM, рисует CRYPTO
  await pRenderB;
  await tick();
  const afterB = domSymbols();
  assert(afterB.includes('BINANCE:BTCUSDT') && !afterB.includes('MOEX:SBER'),
    'После клика CRYPTO в DOM только строки CRYPTO: ' + JSON.stringify(afterB));

  await pRenderA;                          // цены RUS пришли -> render-A обязан самовыпилиться
  for (let i = 0; i < 5; i++) await tick();
  const midSwap = domSymbols();
  assert(midSwap.includes('BINANCE:BTCUSDT') && midSwap.includes('BINANCE:ETHUSDT'),
    'Отменённый render-A не испортил DOM активного CRYPTO: ' + JSON.stringify(midSwap));
  assert(!midSwap.includes('MOEX:SBER') && !midSwap.includes('MOEX:GAZP'),
    'Медленный ответ RUS НЕ нарисовал тикеры RUS поверх CRYPTO (исходный баг)');

  // --- Отдельная проверка механизма отмены: render, во время ожидания цен
  // которого пользователь успел переключить список, обязан прерваться ДО
  // diff-цикла и восстановить DOM (строки активного на момент старта списка
  // остаются на местах, строки другого списка не появляются).
  sandbox.appState.activeListId = 'RUS';
  sandbox.appState.lists.RUS.tickers = ['MOEX:SBER', 'MOEX:GAZP'];
  vm.runInContext(`window.__slowSymbols = { 'MOEX:SBER': 30, 'MOEX:GAZP': 30 };`, sandbox);
  const pRender = sandbox.render();
  await new Promise(r => setTimeout(r, 5)); // diff ещё не начался (ждём цены)
  // Переключаемся на CRYPTO «в середине» render(RUS)
  sandbox.appState.activeListId = 'CRYPTO';
  sandbox.appState.lists.CRYPTO.tickers = ['BINANCE:BTCUSDT'];
  sandbox.render(); // этот тоже ждёт цены; выполнится позже
  await pRender;
  await new Promise(r => setTimeout(r, 80));
  const mid = domSymbols();
  assert(!mid.includes('MOEX:SBER'), 'Прерванный render(RUS) не оставил строки RUS в DOM активного CRYPTO');
  assert(mid.includes('BINANCE:BTCUSDT'), 'DOM активного CRYPTO отрисован своим render');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
