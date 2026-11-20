// Тест раздела «Тест график» (js/test_chart.js): оконная загрузка (?slice=1)
// с фолбэком на хранилище, автозагрузка последнего графика, сегмент ТФ,
// догрузка истории при скролле влево (loadMore/applyMoreData), сохранение
// viewport при смене данных, индикаторы (dropdown + чипы: добавить, настроить
// периоды, убрать), поллинг, сохранение разметки по тикеру в localStorage,
// note бэкенда о деградации источника. Мини-DOM + fake klinecharts —
// в стиле остальных тестов проекта (node:vm без браузера).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
};
const flush = () => new Promise(r => setTimeout(r, 10));

// ---------- Мини-DOM ----------
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = ''; this.textContent = ''; this.value = ''; this.title = '';
    this.className = ''; this._classes = new Set(); this.style = {};
    this.children = []; this.parentNode = null; this.offsetParent = {};
    this.dataset = {}; this._listeners = {};
  }
  get classList() {
    const cls = this._classes;
    return {
      toggle: (c, force) => { ((force === undefined) ? !cls.has(c) : force) ? cls.add(c) : cls.delete(c); },
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
    };
  }
  set innerHTML(v) { if (!v) this.children = []; }
  get innerHTML() { return 'x'; }
  addEventListener(t, cb) { this._listeners[t] = cb; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  querySelectorAll(sel) { return sel === '.widget-fallback' ? [] : []; }
}

const els = {
  'test-chart-ticker-input': new El('input'),
  'test-chart-load-btn': new El('button'),
  'test-chart-status': new El('div'),
  'test-chart-kline': new El('div'),
  'tc-indicator-select': new El('select'),
  'tc-indicator-chips': new El('span'),
  // шапка символа + легенда OHLCV (облик TradingView)
  'tc-sym-code': new El('span'),
  'tc-sym-name': new El('span'),
  'tc-sym-tf': new El('span'),
  'tc-sym-price': new El('span'),
  'tc-sym-change': new El('span'),
  'tc-legend': new El('div'),
  'tc-leg-o': new El('span'),
  'tc-leg-h': new El('span'),
  'tc-leg-l': new El('span'),
  'tc-leg-c': new El('span'),
  'tc-leg-v': new El('span'),
};
for (const tf of ['60', '24', '7', '31']) els[`tc-tf-${tf}`] = new El('button');

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

// ---------- Fake klinecharts ----------
const overlayStore = new Map(); // id -> overlay
let ovSeq = 0;
let applied = []; const updated = []; const callOrder = [];
let barSpace = 8, offsetRight = 50, moreState = null;
let loadMoreCb = null;
const removedIndicators = []; const overrides = []; const createdIndicators = {};
const indInstances = {};

const chart = {
  applyNewData: (d, more) => { applied = d.slice(); moreState = (more === undefined ? true : more); callOrder.push(['applyNewData', d.length]); },
  applyMoreData: (list, more) => {
    applied = list.concat(applied); moreState = (more === undefined ? true : more);
    callOrder.push(['applyMoreData', list.length]);
  },
  updateData: d => {
    const i = applied.findIndex(x => x.timestamp === d.timestamp);
    if (i >= 0) applied[i] = d; else applied.push(d);
    updated.push(d);
  },
  getDataList: () => applied,
  getBarSpace: () => barSpace,
  setBarSpace: v => { barSpace = v; callOrder.push(['setBarSpace', v]); },
  getOffsetRightDistance: () => offsetRight,
  setOffsetRightDistance: v => { offsetRight = v; callOrder.push(['setOffsetRightDistance', v]); },
  loadMore: cb => { loadMoreCb = cb; },
  createOverlay: opts => {
    const id = 'ov' + (++ovSeq);
    overlayStore.set(id, { id, name: opts.name, extendData: opts.extendData,
      points: (opts.points || []).slice(), opts });
    return id;
  },
  getOverlayById: id => overlayStore.get(id) || null,
  removeOverlay: () => {
    for (const o of overlayStore.values()) {
      if (!o.removed) { o.removed = true; o.opts.onRemoved && o.opts.onRemoved({ overlay: o }); }
    }
  },
  createIndicator: (name, isStack, pane) => {
    createdIndicators[name] = pane;
    indInstances[name] = { name, calcParams: [14] };
    return 'ind_' + name;
  },
  removeIndicator: (paneId, name) => {
    removedIndicators.push([paneId, name]);
    delete indInstances[name];
  },
  getIndicatorByPaneId: (paneId, name) => indInstances[name] || null,
  overrideIndicator: (ov, paneId, cb) => {
    if (indInstances[ov.name]) indInstances[ov.name].calcParams = ov.calcParams;
    overrides.push(ov);
    if (cb) cb();
  },
  createIndicatorPaneGuard: null,
  // subscribeAction: легенда OHLCV подписывается на кроссхейр
  subscribeAction: (type, cb) => { actions[type] = cb; },
};
const actions = {};
const klinecharts = { init: () => chart, registerOverlay: () => {} };

// ---------- Fake fetch, таймеры, prompt ----------
let fetchQueue = []; const fetchUrls = [];
const fetchWithTimeout = async url => {
  fetchUrls.push(url);
  const item = fetchQueue.shift();
  if (!item) throw new Error('no queued response');
  return { json: async () => item };
};
const timers = []; const timeouts = [];
const setInterval = cb => { timers.push({ cb }); return timers.length; };
const clearInterval = () => {};
const setTimeoutCapturing = (cb, ms) => { timeouts.push({ cb, ms }); return timeouts.length; };

let domReadyCb = null;
const sandbox = {
  document: {
    readyState: 'loading', hidden: false,
    getElementById: id => els[id] || null,
    createElement: tag => new El(tag),
    addEventListener: (t, cb) => { if (t === 'DOMContentLoaded') domReadyCb = cb; },
  },
  window: { fetchWithTimeout, addEventListener: () => {}, prompt: () => null },
  localStorage, klinecharts,
  API_BASE: '',
  console, setInterval, clearInterval, setTimeout: setTimeoutCapturing,
};
vm.createContext(sandbox);
const SRC = path.join(__dirname, '..', 'js', 'test_chart.js');
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);

const statusOf = () => ({
  text: els['test-chart-status'].textContent,
  warn: els['test-chart-status']._classes.has('warn'),
  err: els['test-chart-status']._classes.has('error'),
});
const liveOverlays = () => [...overlayStore.values()].filter(o => !o.removed);
const candle = (day, close, month = 11) => ({
  begin: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00:00`,
  open: close - 5, high: close + 5, low: close - 7, close, volume: 10,
});

(async () => {
  // 0) Автозагрузка последнего графика при открытии страницы.
  //    (loadTestChartCandles срабатывает на DOMContentLoaded без ручного клика)
  store.set('test_chart_last', JSON.stringify({ ticker: 'SBER', interval: 24 }));
  fetchQueue = [{
    symbol: 'MOEX:SBER', interval: 24, name: 'Сбербанк',
    candles: [candle(18, 305), candle(19, 308)],
  }];
  domReadyCb(); // DOMContentLoaded → autoLoadLastChart
  await flush();
  assert(els['test-chart-ticker-input'].value === 'SBER', 'автозагрузка: тикер подставлен в поле');
  assert(els['tc-tf-24']._classes.has('active'), 'автозагрузка: кнопка ТФ 1д активна');
  assert(applied.length === 2, 'автозагрузка: график SBER построен без клика');
  assert(/slice=1/.test(fetchUrls[fetchUrls.length - 1]), 'начальная загрузка: оконный режим slice=1');
  assert(loadMoreCb != null, 'loadMore: callback зарегистрирован');
  assert(JSON.parse(store.get('test_chart_last')).ticker === 'SBER', 'последний график сохранён в localStorage');

  // 0a) Шапка символа (облик TradingView): код · имя · ТФ + цена с дельтой
  assert(els['tc-sym-code'].textContent === 'SBER', 'шапка: код SBER');
  assert(els['tc-sym-name'].textContent === 'Сбербанк' && els['tc-sym-name'].style.display !== 'none',
    'шапка: имя инструмента из candles-ответа показано');
  assert(els['tc-sym-tf'].textContent === '1д', 'шапка: ТФ подписан как 1д');
  assert(els['tc-sym-price'].textContent === '308.00', 'шапка: крупная последняя цена 308.00');
  assert(els['tc-sym-change'].textContent === '+3.00 (+0.98%)' && els['tc-sym-change']._classes.has('up'),
    'шапка: дельта +3.00 (+0.98%) зелёным');

  // 0a2) Легенда OHLCV по последней свече, цвет по направлению
  assert(els['tc-leg-o'].textContent === '303.00' && els['tc-leg-h'].textContent === '313.00' &&
    els['tc-leg-l'].textContent === '301.00' && els['tc-leg-c'].textContent === '308.00' &&
    els['tc-leg-v'].textContent === '10',
    'легенда: O/H/L/C/Vol последней свечи');
  assert(els['tc-legend']._classes.has('up') && !els['tc-legend']._classes.has('down'),
    'легенда: класс направления up (close >= open)');

  // 0a3) Кроссхейр: легенда следует за курсором, с курсора — на последнюю
  actions['onCrosshairChange']({ kLineData: applied[0] }); // курсор на свечу 18-го
  assert(els['tc-leg-c'].textContent === '305.00' && els['tc-leg-o'].textContent === '300.00',
    'легенда: под курсором — значения свечи 18-го');
  actions['onCrosshairChange']({ kLineData: applied[applied.length - 1] }); // ушли с графика
  assert(els['tc-leg-c'].textContent === '308.00', 'легенда: уход курсора вернул последнюю свечу');

  // 0b) Разметка на SBER: onDrawEnd сохраняет в localStorage; иконка
  //     инструмента на вертикальной панели активна до конца рисования
  const toolBtn = new El('button');
  sandbox.window.tcDrawOverlay('segment', toolBtn);
  assert(toolBtn._classes.has('active'), 'панель разметки: иконка инструмента подсвечена');
  const ovS = [...overlayStore.values()].reverse().find(o => o.name === 'segment');
  ovS.points = [
    { timestamp: Date.UTC(2026, 10, 18), value: 300, dataIndex: 0 },
    { timestamp: Date.UTC(2026, 10, 19), value: 310, dataIndex: 1 },
  ];
  ovS.opts.onDrawEnd();
  assert(!toolBtn._classes.has('active'), 'панель разметки: подсветка снята после построения фигуры');
  const saved0 = JSON.parse(store.get('test_chart_markup'));
  assert(saved0['SBER'] && saved0['SBER'].length === 1 && saved0['SBER'][0].name === 'segment',
    'onDrawEnd сохранил разметку SBER в localStorage');

  // 1) Срез пуст → фолбэк на полный запрос через хранилище с note
  els['test-chart-ticker-input'].value = 'GAZP';
  fetchQueue = [
    { symbol: 'MOEX:GAZP', interval: 24, candles: [] },                       // slice: пусто
    { symbol: 'MOEX:GAZP', interval: 24,
      note: 'Источник недоступен (boom); отдаём накопленную историю',
      candles: [candle(18, 140), candle(19, 142)] },
  ];
  await sandbox.window.loadTestChartCandles();
  await flush();
  const st1 = statusOf();
  assert(fetchUrls[fetchUrls.length - 1] === '/api/candles/GAZP?interval=24',
    'фолбэк: второй запрос без slice (полный, через хранилище)');
  assert(st1.warn && !st1.err, 'note бэкенда — warn, не error');
  assert(st1.text.includes('накопленную историю'), 'текст note попал в статус');
  assert(els['tc-sym-code'].textContent === 'GAZP' && els['tc-sym-name'].style.display === 'none',
    'шапка: без имени в ответе имя скрыто, код сменился на GAZP');

  // 2) Поллинг: обновление последней свечи + дописывание новой
  fetchQueue = [{
    symbol: 'MOEX:GAZP', interval: 24,
    candles: [candle(19, 148), candle(20, 150)],
  }];
  const t0 = timers[timers.length - 1];
  await t0.cb(); await flush();
  assert(updated.length === 2, 'поллинг: updateData вызван 2 раза (обновление + новая)');
  assert(applied.length === 3 && applied[2].close === 150, 'поллинг: новая свеча дописана');
  assert(/from=\d{4}-\d{2}-\d{2}/.test(fetchUrls[fetchUrls.length - 1]), 'поллинг: from= дата последней свечи');
  assert(statusOf().text.includes('обновлено'), 'поллинг: статус обновлён');
  assert(els['tc-sym-price'].textContent === '150.00' && els['tc-sym-change'].textContent === '+2.00 (+1.35%)',
    'шапка: цена и дельта обновились на тике поллинга');

  // 3) Разметка: у SBER уже сохранена (шаг 0b), у GAZP пока пусто
  const saved = JSON.parse(store.get('test_chart_markup'));
  assert(saved['SBER'] && saved['SBER'].length === 1, 'разметка SBER в localStorage перед сменой тикера');

  // 4) Пользователь настроил вид: зум и сдвиг от правого края
  barSpace = 15; offsetRight = 120;

  // 5) Смена тикера на SBER: разметка SBER восстанавливается, viewport восстановлен
  els['test-chart-ticker-input'].value = 'SBER';
  callOrder.length = 0;
  fetchQueue = [{ symbol: 'MOEX:SBER', interval: 24, candles: [candle(19, 315), candle(20, 318)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  assert(liveOverlays().length === 1, 'смена тикера: разметка SBER восстановлена с графика');
  assert(JSON.parse(store.get('test_chart_markup'))['SBER'].length === 1,
    'смена тикера: разметка SBER осталась в localStorage');
  const applyIdx = callOrder.map(c => c[0]).lastIndexOf('applyNewData');
  const bsIdx = callOrder.map(c => c[0]).indexOf('setBarSpace');
  const orIdx = callOrder.map(c => c[0]).indexOf('setOffsetRightDistance');
  assert(applyIdx !== -1 && bsIdx > applyIdx && orIdx > bsIdx,
    'viewport: setBarSpace и setOffsetRightDistance после applyNewData, в нужном порядке');
  assert(barSpace === 15 && offsetRight === 120, 'viewport: зум и сдвиг восстановлены');
  assert(statusOf().text.includes('разметка восстановлена: 1'), 'статус сообщает о восстановлении разметки SBER');
  assert(els['tc-sym-price'].textContent === '318.00' && els['tc-sym-change'].textContent === '+3.00 (+0.95%)',
    'шапка: цена и дельта пересчитаны для новых данных');

  // 6) Догрузка истории при скролле влево (loadMore)
  const oldestTs = applied[0].timestamp; // свеча за 19-е
  fetchQueue = [{
    symbol: 'MOEX:SBER', interval: 24,
    candles: [candle(18, 305), candle(19, 315)], // одна старше oldest, одна совпадает (отфильтруется)
  }];
  await loadMoreCb(oldestTs); await flush();
  assert(/from=1900-01-01&till=\d{4}-\d{2}-\d{2}&slice=1/.test(fetchUrls[fetchUrls.length - 1]),
    'loadMore: запрошен срез старше старшей свечи (from+till+slice)');
  assert(applied.length === 3 && applied[0].close === 305,
    'loadMore: старая свеча добавлена, дубль отфильтрован');
  assert(statusOf().text.includes('+1 свечей истории'), 'loadMore: статус сообщает о дозагрузке');
  assert(moreState === true, 'loadMore: hasMore=true, доборка осталась включённой');

  // 7) История исчерпана: пустой ответ отключает доборку
  fetchQueue = [{ symbol: 'MOEX:SBER', interval: 24, candles: [] }];
  await loadMoreCb(applied[0].timestamp); await flush();
  assert(applied.length === 3, 'loadMore исчерпан: график не изменился');
  assert(moreState === false, 'loadMore исчерпан: more=false — доборка отключена');

  // 8) Сбой сети: _loading разблокируется отложенным applyMoreData([], true)
  fetchQueue = []; // fetch бросит 'no queued response'
  await loadMoreCb(applied[0].timestamp); await flush();
  assert(timeouts.length === 1 && timeouts[0].ms === 3000, 'loadMore сбой: запланирована отложенная разблокировка (3 с)');
  timeouts[0].cb();
  assert(moreState === true, 'loadMore сбой: после разблокировки доборка снова включена');

  // 9) Смена ТФ того же тикера: сегмент кнопок, без дубликатов разметки
  callOrder.length = 0;
  sandbox.window.tcSetInterval('7');
  assert(els['tc-tf-7']._classes.has('active') && !els['tc-tf-24']._classes.has('active'),
    'ТФ: активная кнопка переключилась на 1н');
  assert(/interval=7/.test(fetchUrls[fetchUrls.length - 1]), 'ТФ: перезагрузка графика с новым интервалом');
  assert(liveOverlays().length === 1, 'смена ТФ: разметка осталась на графике (без дублей)');

  // 10) Индикаторы: добавление в нужные панели, настройка периодов, удаление
  sandbox.window.tcAddIndicator('RSI');
  assert(createdIndicators['RSI'] && createdIndicators['RSI'].id === 'tc_ind_RSI',
    'индикаторы: RSI создан в собственном под-окне');
  assert(els['tc-indicator-chips'].children.length === 1, 'индикаторы: чип добавлен');
  sandbox.window.tcAddIndicator('MA');
  assert(createdIndicators['MA'].id === 'candle_pane', 'индикаторы: MA создан в главном окне');
  assert(els['tc-indicator-chips'].children.length === 2, 'индикаторы: второй чип добавлен');

  sandbox.window.prompt = () => '21';
  const chipRsi = els['tc-indicator-chips'].children.find(c => c.children[0].textContent === 'RSI');
  chipRsi.children[0]._listeners.click(); // клик по имени — настройка периодов
  assert(overrides.length === 1 && overrides[0].name === 'RSI' &&
    JSON.stringify(overrides[0].calcParams) === '[21]',
    'индикаторы: клик по чипу открывает периоды и применяет overrideIndicator');
  assert(indInstances['RSI'].calcParams.length === 1 && indInstances['RSI'].calcParams[0] === 21,
    'индикаторы: параметры RSI реально обновлены в инстансе');

  sandbox.window.prompt = () => null; // отмена в промпте
  chipRsi.children[0]._listeners.click();
  assert(overrides.length === 1, 'индикаторы: отмена промпта не меняет параметры');

  chipRsi.children[1]._listeners.click(); // × — убрать
  assert(JSON.stringify(removedIndicators[0]) === JSON.stringify(['tc_ind_RSI', 'RSI']),
    'индикаторы: удаление передаёт (paneId, name) как требует API 9.6');
  assert(els['tc-indicator-chips'].children.length === 1, 'индикаторы: чип удалён');

  // 11) Binance: период поллинга 8 с, UTC-метки парсятся
  els['test-chart-ticker-input'].value = 'BINANCE:BTCUSDT';
  fetchQueue = [{
    symbol: 'BINANCE:BTCUSDT', interval: 7, name: 'Bitcoin',
    candles: [{ begin: '2026-11-19T00:00:00Z', open: 95000, high: 96000, low: 94000, close: 95500, volume: 1 }],
  }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  assert(Number.isFinite(applied[applied.length - 1].timestamp), 'Binance: UTC begin парсится в timestamp');
  assert(statusOf().text.includes('8 с'), 'Binance: статус обещает автообновление 8 с');
  assert(els['tc-sym-code'].textContent === 'BTCUSDT' && els['tc-sym-name'].textContent === 'Bitcoin',
    'шапка: префикс BINANCE: скрыт, имя монеты показано');
  assert(els['tc-sym-tf'].textContent === '1н', 'шапка: ТФ 1н для interval=7');
  assert(els['tc-sym-price'].textContent === '95,500.00', 'шапка: цена с разделением разрядов');
  assert(els['tc-sym-change'].textContent === '' && !els['tc-sym-change']._classes.has('up'),
    'шапка: дельты нет, когда предыдущей свечи нет');

  // 12) Ошибка загрузки неизвестного тикера — статус ошибки
  els['test-chart-ticker-input'].value = 'ZZZZ';
  fetchQueue = [
    { symbol: 'MOEX:ZZZZ', interval: 7, error: 'Тикер не найден' }, // slice
    { symbol: 'MOEX:ZZZZ', interval: 7, error: 'Тикер не найден' }, // фолбэк
  ];
  await sandbox.window.loadTestChartCandles();
  assert(statusOf().err && statusOf().text.includes('не найден'), 'неизвестный тикер: ошибка в статусе');

  // 13) Скрытый раздел: автозагрузка откладывается до показа (navigateTo).
  //     klinecharts.init при 0×0 ломает раскладку панелей — свечи сжимаются
  //     в полосу у верхнего края и не раскладываются обратно.
  els['test-chart-kline'].offsetParent = null; // раздел «Тест график» скрыт
  store.set('test_chart_last', JSON.stringify({ ticker: 'GAZP', interval: 24 }));
  fetchQueue = [];
  const urlsBeforePending = fetchUrls.length;
  domReadyCb(); // повторный DOMContentLoaded → autoLoadLastChart при скрытом разделе
  await flush();
  assert(els['test-chart-ticker-input'].value === 'GAZP', 'отложка: тикер подставлен в поле');
  assert(applied.length === 1 && applied[applied.length - 1].close === 95500,
    'отложка: старый график ещё на месте, свечи не перезагружены');
  assert(fetchUrls.length === urlsBeforePending,
    'отложка: запрос свечей не ушёл, пока раздел скрыт');
  assert(!statusOf().text.includes('GAZP'),
    'отложка: загрузка GAZP не стартовала (статус не тронут)');

  // Показ раздела → navigateTo → tcSectionShown → отложенная загрузка
  els['test-chart-kline'].offsetParent = {};
  fetchQueue = [{
    symbol: 'MOEX:GAZP', interval: 24, name: 'Газпром',
    candles: [candle(19, 141), candle(20, 143)],
  }];
  sandbox.window.navigateTo('test-chart');
  await flush();
  assert(applied.length === 2 && applied[applied.length - 1].close === 143,
    'отложка: после показа раздела график GAZP загружен');
  assert(els['tc-sym-name'].textContent === 'Газпром', 'отложка: имя инструмента показано в шапке');

  if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
  console.log('\nALL PASS');
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
