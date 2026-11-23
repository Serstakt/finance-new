// Тест раздела «Тест график» (js/test_chart.js): оконная загрузка (?slice=1)
// с фолбэком на хранилище, автозагрузка последнего графика, сегмент ТФ,
// догрузка истории при скролле влево (loadMore/applyMoreData), сохранение
// viewport при смене данных, сброс вида (двойной клик / правый клик →
// «Reset chart»: дефолтные масштаб/сдвиг + scrollToRealTime; правый клик
// по фигуре удаляет её без «Reset chart», Ctrl+Z убирает последнюю
// фигуру), индикаторы (dropdown + чипы: добавить, настроить периоды,
// убрать; в главное окно — стеком isStack: 9.6 при isStack=false затирает
// индикаторов панели), volume-гистограмма
// в главном окне (вкл. по умолчанию, draw с нормировкой по видимой области,
// метка на оси под курсором), поллинг, сохранение разметки по тикеру
// в localStorage, note бэкенда о деградации источника, диалог настроек
// вместо window.prompt (заметка на графике и периоды индикатора: Enter
// применяет, отмена/ошибки inline), тип графика (свечи/бары/линия/области
// через candle.type) и режим шкалы цены (normal/log/percentage + кнопка-
// переключатель «авто»: включить/выключить автоподгонку оси) с сохранением
// выбора в localStorage, точность инструмента по данным (дешёвые тикеры
// типа SHIBUSDT: шапка/легенда/метки max/min не схлопываются в «0.00»).
// Облик/поведение TradingView: фигуры без меток на осях (встроенные
// шаблоны пере-регистрированы без needDefaultX/YAxisFigure), догоняющий
// клик (быстрый последний клик фигуры, проглоченный окном dblclick 9.6,
// достраивает фигуру без лишнего клика «мимо»), guard сброса вида на
// dblclick сразу после достройки, точность осей под-окон по размаху
// шкалы (ось MACD «4,000.0000» → «4,000»), статус-тост с автоскрытием
// (info 6 с / warn 15 с / ошибка сама не гаснет, фаза затухания).
// Доработки P3 по аналогии с TradingView: отсчёт до закрытия бара в
// шапке («· ЧЧ:ММ:СС», тик раз в секунду), undo/redo разметки (стек
// операций создать/удалить/сдвинуть/очистить + стрелки в шапке,
// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y), Escape снимает недостроенную фигуру
// и разоружает взведённый инструмент, контекстное меню богаче
// («Скопировать цену» по курсору, «Снимок PNG», «Удалить всю разметку»),
// русская ось времени через setCustomApi ({formatDate}: «Июнь» вместо
// «2026-06», дни числом, кроссхейр ДД.ММ.ГГГГ), поллинг Binance 5 с,
// Pointer Events у кисти/измерителя и догоняющего клика (тач-устройства),
// fmtVol с триллионами (2355.79B → 2.36T).
// Мини-DOM + fake klinecharts — в стиле остальных тестов проекта
// (node:vm без браузера).
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
    this.dataset = {}; this._listeners = {}; this._listenerList = {};
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
  // Слушателей одного типа может быть несколько (на холсте висят и
  // обработчик кисти/измерителя, и догоняющий клик фигуры) — «_listeners»
  // оставлен как диспетчер, вызывающий всех зарегистрированных
  addEventListener(t, cb) {
    const list = (this._listenerList[t] = this._listenerList[t] || []);
    if (!list.includes(cb)) list.push(cb);
    this._listeners[t] = (...args) => {
      for (const fn of this._listenerList[t] || []) fn(...args);
    };
  }
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
  'tc-sym-countdown': new El('span'),
  'tc-legend': new El('div'),
  'tc-leg-o': new El('span'),
  'tc-leg-h': new El('span'),
  'tc-leg-l': new El('span'),
  'tc-leg-c': new El('span'),
  'tc-leg-v': new El('span'),
  'tc-vol-axis': new El('div'),
  // сброс вида: холст + контекстное меню «Reset chart» (+ новые пункты:
  // скопировать цену, снимок PNG, удалить всю разметку)
  'tc-chart-stage': new El('div'),
  'tc-ctx-menu': new El('div'),
  'tc-ctx-reset': new El('button'),
  'tc-ctx-copy': new El('button'),
  'tc-ctx-shot': new El('button'),
  'tc-ctx-clear': new El('button'),
  // undo/redo разметки (стрелки в шапке как в TradingView)
  'tc-undo': new El('button'),
  'tc-redo': new El('button'),
  // тип графика (сегмент иконок) + шкала цены (log/%/авто)
  'tc-type-candles': new El('button'),
  'tc-type-bars': new El('button'),
  'tc-type-line': new El('button'),
  'tc-type-area': new El('button'),
  'tc-scale-log': new El('button'),
  'tc-scale-pct': new El('button'),
  'tc-scale-auto': new El('button'),
  // диалог настроек (заметка/периоды) вместо window.prompt
  'tc-settings-modal': new El('div'),
  'tc-settings-title': new El('div'),
  'tc-settings-label': new El('div'),
  'tc-settings-input': new El('input'),
  'tc-settings-textarea': new El('textarea'),
  'tc-settings-error': new El('div'),
  'tc-settings-apply': new El('button'),
  'tc-settings-cancel': new El('button'),
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
const createdStacks = {}; // isStack индикаторов: 9.6 при isStack=false затирает панель
const indInstances = {};
// progress-рисование (догоняющий клик): активный progress-объект 9.6
let fakeProgressInfo = null;
let progressCompleted = 0;
const fakeOverlayStore = {
  isDrawing: () => fakeDrawing,
  getProgressInstanceInfo: () => fakeProgressInfo,
  progressInstanceComplete: () => {
    if (fakeProgressInfo) { fakeProgressInfo = null; progressCompleted++; }
  },
  updateProgressInstanceInfo: (paneId, appointPaneFlag) => {
    if (fakeProgressInfo) {
      fakeProgressInfo.paneId = paneId;
      if (appointPaneFlag !== undefined) fakeProgressInfo.appointPaneFlag = appointPaneFlag;
    }
  },
};

const chart = {
  applyNewData: (d, more) => { applied = d.slice(); moreState = (more === undefined ? true : more); callOrder.push(['applyNewData', d.length]); },
  // русская ось времени: перехват setCustomApi ({formatDate}) 9.6
  setCustomApi: api => { Object.assign(customApi, api); },
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
    const o = { id, name: opts.name, extendData: opts.extendData,
      points: (opts.points || []).slice(), opts,
      // undo/redo сдвига: живой Overlay 9.6 умеет setPoints — полный
      // набор точек переводит его в завершённый режим
      setPoints(pts) { this.points = pts.slice(); },
    };
    overlayStore.set(id, o);
    if (!opts.points || !opts.points.length) {
      // без точек — progress-режим 9.6 (кликами ждёт остальные точки);
      // колбэки, как у реального OverlayImp, живут прямо на объекте
      Object.assign(o, {
        currentStep: 1,
        totalStep: (registeredOverlays[opts.name] || {}).totalStep || 2,
        onDrawEnd: opts.onDrawEnd,
        isDrawing() { return this.currentStep !== -1; },
        isStart() { return this.currentStep === 1; },
        forceComplete() { this.currentStep = -1; },
      });
      fakeProgressInfo = { paneId: 'candle_pane', instance: o, appointPaneFlag: false };
    }
    return id;
  },
  getOverlayById: id => {
    const o = overlayStore.get(id);
    return o && !o.removed ? o : null;
  },
  removeOverlay: id => {
    for (const o of overlayStore.values()) {
      if (o.removed || (id !== undefined && o.id !== id)) continue;
      o.removed = true;
      if (fakeProgressInfo && fakeProgressInfo.instance === o) fakeProgressInfo = null;
      o.opts.onRemoved && o.opts.onRemoved({ overlay: o });
    }
  },
  // press-drag захват кисти/измерителя: конвертация координат контейнера
  // в точки (шаг бара 8 px, сутки на бар) + доступ к DOM и перерисовка.
  // Вне загруженных свечей timestamp нет — как в живой библиотеке.
  getDom: () => ({
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  }),
  convertFromPixel: (coords) => coords.map(c => {
    const dataIndex = Math.round(c.x / 8);
    const inRange = dataIndex >= 0 && dataIndex < applied.length;
    return {
      dataIndex,
      timestamp: inRange ? Date.UTC(2026, 10, 18) + dataIndex * 86400000 : null,
      value: 300 - c.y,
    };
  }),
  updatePane: () => { updatePaneCalls++; },
  createIndicator: (name, isStack, pane) => {
    createdIndicators[name] = pane;
    createdStacks[name] = isStack;
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
  // сброс вида: возврат к последней свече после дефолтных масштаба/сдвига
  scrollToRealTime: () => { callOrder.push(['scrollToRealTime']); },
  // тип графика/шкала: partial-стили запоминаем для проверок
  setStyles: s => { styleCalls.push(s); },
  // точность инструмента (ось цены, метки max/min свечи): 9.6 — {price, volume}
  setPrecision: p => { precisions.push(p); },
  // автоскейл: ось цены главной панели с флагом автоподгона (9.6
  // снимает его при перетаскивании шкалы, setStyles с yAxis.type
  // возвращает, кнопка «авто»-переключатель снимает через set…Flag)
  _candlePane: {
    getAxisComponent: () => ({
      getAutoCalcTickFlag: () => autoCalcTickFlag,
      setAutoCalcTickFlag: f => { autoCalcTickFlag = f; },
    }),
  },
  // сброс вида/догоняющий клик: OverlayStore 9.6 (isDrawing для guard'а
  // dblclick, progress-инстанс для завершения фигуры последним кликом)
  getChartStore: () => ({ getOverlayStore: () => fakeOverlayStore }),
  // геометрия панелей (paneIdAtY для догоняющего клика: точка фигуры —
  // только клик в панель свечей, не в под-окно или ось времени)
  _drawPanes: [
    { _id: 'candle_pane', getId: () => 'candle_pane', _bounding: { top: 0, height: 400 } },
    { _id: 'x_axis_pane', getId: () => 'x_axis_pane', _bounding: { top: 400, height: 30 } },
  ],
};
let fakeDrawing = false;
let autoCalcTickFlag = true; // автоподгонка шкалы цены включена по умолчанию
const styleCalls = [];
const customApi = {}; // setCustomApi ({formatDate}) — русская ось времени
const precisions = []; // точность инструмента: setPrecision({price, volume}) 9.6
const actions = {};
let registeredIndicator = null; // спек индикатора volume-гистограммы из registerIndicator
const registeredOverlays = {}; // кастомные overlay-шаблоны (стрелка/кисть/измеритель)
let updatePaneCalls = 0;
const klinecharts = {
  init: () => chart,
  registerOverlay: tpl => { registeredOverlays[tpl.name] = tpl; },
  registerIndicator: ind => { registeredIndicator = ind; },
};

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
const setTimeoutCapturing = (cb, ms) => { timeouts.push({ cb, ms, done: false }); return timeouts.length; };
const clearTimeoutCapturing = id => { if (timeouts[id - 1]) timeouts[id - 1].done = true; };

let domReadyCb = null;
const docListeners = {}; // click/keydown и др. — закрытие контекстного меню
const winListeners = {}; // mousemove/mouseup window — press-drag кисти/измерителя
const sandbox = {
  document: {
    readyState: 'loading', hidden: false,
    getElementById: id => els[id] || null,
    createElement: tag => new El(tag),
    addEventListener: (t, cb) => { if (t === 'DOMContentLoaded') domReadyCb = cb; docListeners[t] = cb; },
  },
  window: { fetchWithTimeout, addEventListener: (t, cb) => { winListeners[t] = cb; }, prompt: () => null },
  localStorage, klinecharts,
  API_BASE: '',
  console, setInterval, clearInterval,
  setTimeout: setTimeoutCapturing, clearTimeout: clearTimeoutCapturing,
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

  // 0a0) Вид при init: применены сохранённые (здесь — дефолтные) тип
  //      графика и режим шкалы цены
  assert(styleCalls.length >= 2 && styleCalls[0].candle && styleCalls[0].candle.type === 'candle_solid'
    && styleCalls[1].yAxis && styleCalls[1].yAxis.type === 'normal',
    'вид при init: применены дефолтные тип (свечи) и режим шкалы (обычная)');

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
  assert(precisions.length === 0,
    'точность: обычные цены (2 знака) — setPrecision не зовётся, дефолт 9.6 совпадает');

  // 0a3) Кроссхейр: легенда следует за курсором, с курсора — на последнюю
  actions['onCrosshairChange']({ kLineData: applied[0] }); // курсор на свечу 18-го
  assert(els['tc-leg-c'].textContent === '305.00' && els['tc-leg-o'].textContent === '300.00',
    'легенда: под курсором — значения свечи 18-го');
  actions['onCrosshairChange']({ kLineData: applied[applied.length - 1] }); // ушли с графика
  assert(els['tc-leg-c'].textContent === '308.00', 'легенда: уход курсора вернул последнюю свечу');

  // 0a4) Русская ось времени (setCustomApi {formatDate}): «Июнь» вместо
  //      «2026-06», дни числом, полная дата в кроссхейре — ДД.ММ.ГГГГ
  const junLocal = new Date(2026, 5, 1, 14, 30); // локальная 1 июня — TZ-независимо
  assert(typeof customApi.formatDate === 'function',
    'ось времени: setCustomApi с formatDate применён при init');
  assert(customApi.formatDate(null, junLocal.getTime(), 'YYYY-MM') === 'Июнь',
    'ось времени: месячный тик печатается словом («Июнь», было «2026-06»)');
  assert(customApi.formatDate(null, junLocal.getTime(), 'MM-DD') === '01',
    'ось времени: дневной тик — число дня');
  assert(customApi.formatDate(null, junLocal.getTime(), 'YYYY') === '2026',
    'ось времени: годовой тик — цифры (эвристика формы первого тика)');
  assert(customApi.formatDate(null, junLocal.getTime(), 'HH:mm') === '14:30',
    'ось времени: внутридневной тик — ЧЧ:мм');
  assert(customApi.formatDate(null, junLocal.getTime(), 'YYYY-MM-DD HH:mm') === '01.06.2026 14:30',
    'кроссхейр/тултип: полная дата в формате ДД.ММ.ГГГГ ЧЧ:мм');
  assert(customApi.formatDate(null, NaN, 'YYYY-MM-DD') === '',
    'ось времени: битый timestamp — пустая строка вместо «Invalid Date»');

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
  ovS.opts.onDrawEnd({ overlay: ovS });
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

  // 2a) Отсчёт до закрытия бара (тег «287,45 · 00:32:41» в TradingView):
  //     живая свеча (дневная, началась час назад) — в шапке «· ЧЧ:ММ:СС»;
  //     заодно fmtVol с триллионами (оборот SHIBUSDT печатался «2355.79B»)
  const localBegin = (msAgo) => {
    const d = new Date(Date.now() - msAgo);
    const p2 = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
      + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  els['test-chart-ticker-input'].value = 'GAZP';
  fetchQueue = [{
    symbol: 'MOEX:GAZP', interval: 24, name: 'Газпром',
    candles: [
      { begin: localBegin(25 * 3600000), open: 139, high: 141, low: 138, close: 140, volume: 1 },
      { begin: localBegin(3600000), open: 141, high: 145, low: 140, close: 143, volume: 2355790000000 },
    ],
  }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  assert(/^· \d{2}:\d{2}:\d{2}$/.test(els['tc-sym-countdown'].textContent),
    'отсчёт: живая свеча — в шапке «· ЧЧ:ММ:СС» до закрытия бара');
  assert(els['tc-leg-v'].textContent === '2.36T',
    'fmtVol: триллионы форматируются — 2.36T (было «2355.79B»)');
  timers[0].cb(); // тик отсчёта раз в секунду — не падает, формат держится
  assert(/^· \d{2}:\d{2}:\d{2}$/.test(els['tc-sym-countdown'].textContent),
    'отсчёт: секундный тик пересчитывает остаток');

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
  assert(els['tc-sym-countdown'].textContent === '',
    'отсчёт: остывшие данные (свечи не в будущем) — тик до закрытия скрыт');

  // 5a) Статус-тост (как сообщения в TradingView): обычное сообщение само
  //     гаснет — таймер 6 с, фаза затухания, затем очистка текста
  const infoToast = timeouts[timeouts.length - 1]; // последний статус — info «разметка восстановлена»
  assert(infoToast && infoToast.ms === 6000, 'тост: обычному сообщению заведён таймер автоскрытия 6 с');
  assert(timeouts.some(t => t.ms === 15000),
    'тост: предупреждение (note бэкенда из шага 1) держится дольше — 15 с');
  infoToast.cb();
  assert(els['test-chart-status']._classes.has('fade-out') && statusOf().text.length > 0,
    'тост: перед очисткой — фаза затухания, текст ещё на месте');
  const fadeClear = timeouts.filter(t => t.ms === 300).pop();
  assert(fadeClear != null, 'тост: после затухания запланирована очистка текста');
  fadeClear.cb();
  assert(statusOf().text === '' && !els['test-chart-status']._classes.has('fade-out'),
    'тост: после затухания текст очищен, класс снят');

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
  const unlock = timeouts.filter(t => t.ms === 3000);
  assert(unlock.length === 1, 'loadMore сбой: запланирована отложенная разблокировка (3 с)');
  unlock[0].cb();
  assert(moreState === true, 'loadMore сбой: после разблокировки доборка снова включена');

  // 9) Смена ТФ того же тикера: сегмент кнопок, без дубликатов разметки
  callOrder.length = 0;
  sandbox.window.tcSetInterval('7');
  assert(els['tc-tf-7']._classes.has('active') && !els['tc-tf-24']._classes.has('active'),
    'ТФ: активная кнопка переключилась на 1н');
  assert(/interval=7/.test(fetchUrls[fetchUrls.length - 1]), 'ТФ: перезагрузка графика с новым интервалом');
  assert(liveOverlays().length === 1, 'смена ТФ: разметка осталась на графике (без дублей)');

  // 10) Индикаторы: добавление в нужные панели, настройка периодов, удаление
  //     (чип volume-гистограммы включён по умолчанию и всегда в списке)
  assert(createdIndicators['VOL_MAIN'] && createdIndicators['VOL_MAIN'].id === 'candle_pane',
    'volume: гистограмма включена по умолчанию в главном окне');
  assert(els['tc-indicator-chips'].children.some(c => c.children[0].textContent === 'VOL_MAIN'),
    'volume: чип гистограммы показан среди включённых индикаторов');
  assert(JSON.stringify(registeredIndicator.calc()) === '[]',
    'volume: без result-значений — ценовая шкала главной панели не растягивается');
  sandbox.window.tcAddIndicator('RSI');
  assert(createdIndicators['RSI'] && createdIndicators['RSI'].id === 'tc_ind_RSI',
    'индикаторы: RSI создан в собственном под-окне');
  assert(els['tc-indicator-chips'].children.length === 2, 'индикаторы: чип добавлен (вместе с volume)');
  sandbox.window.tcAddIndicator('MA');
  assert(createdIndicators['MA'].id === 'candle_pane', 'индикаторы: MA создан в главном окне');
  assert(els['tc-indicator-chips'].children.length === 3, 'индикаторы: второй чип добавлен');
  // isStack=true для главного окна обязателен: в 9.6 IndicatorStore.addInstance
  // при isStack=false делает paneInstances.clear() — MA затирал бы volume
  assert(createdStacks['MA'] === true && createdStacks['VOL_MAIN'] === true,
    'индикаторы: MA и volume в главное окно стеком (isStack) — не затирают друг друга');
  assert(createdStacks['RSI'] === false,
    'индикаторы: RSI в собственном под-окне — не стек');

  // 10a) Диалог настроек индикатора вместо window.prompt: клик по имени
  //      чипа открывает модальное окно с текущими периодами, «Применить»
  //      вызывает overrideIndicator, ошибка валидации остаётся inline
  const btnTool = () => new El('button');
  const chipRsi = els['tc-indicator-chips'].children.find(c => c.children[0].textContent === 'RSI');
  const modalEl = els['tc-settings-modal'];
  chipRsi.children[0]._listeners.click();
  assert(modalEl._classes.has('active'), 'диалог: клик по имени индикатора открыл модальное окно');
  assert(els['tc-settings-title'].textContent.includes('RSI'), 'диалог: имя индикатора в заголовке');
  assert(els['tc-settings-input'].value === '14' && els['tc-settings-input'].style.display !== 'none',
    'диалог: текущие периоды подставлены в однострочное поле');
  els['tc-settings-input'].value = '21';
  els['tc-settings-apply']._listeners.click();
  assert(overrides.length === 1 && overrides[0].name === 'RSI' &&
    JSON.stringify(overrides[0].calcParams) === '[21]',
    'диалог: «Применить» применил периоды через overrideIndicator');
  assert(!modalEl._classes.has('active'), 'диалог: после применения окно закрыто');
  assert(indInstances['RSI'].calcParams.length === 1 && indInstances['RSI'].calcParams[0] === 21,
    'индикаторы: параметры RSI реально обновлены в инстансе');

  // Неверные периоды: inline-ошибка, окно не закрывается, override нет
  chipRsi.children[0]._listeners.click();
  els['tc-settings-input'].value = 'abc';
  els['tc-settings-apply']._listeners.click();
  assert(modalEl._classes.has('active') && els['tc-settings-error'].style.display !== 'none'
    && els['tc-settings-error'].textContent.length > 0,
    'диалог: неверные периоды — inline-ошибка, окно осталось открытым');
  assert(overrides.length === 1, 'диалог: при ошибке валидации override не вызван');
  // Отмена закрывает окно, ничего не меняя
  els['tc-settings-cancel']._listeners.click();
  assert(!modalEl._classes.has('active') && overrides.length === 1,
    'диалог: «Отмена» закрыла окно, параметры не изменились');

  // 10b) Диалог заметки на графике (инструмент «Т»): многострочное поле,
  //      «Применить» создаёт simpleAnnotation с обрезанным текстом
  const noteBtn = btnTool();
  sandbox.window.tcDrawOverlay('text', noteBtn);
  assert(noteBtn._classes.has('active') && modalEl._classes.has('active'),
    'заметка: инструмент активен, диалог открыт');
  assert(els['tc-settings-input'].style.display === 'none'
    && els['tc-settings-textarea'].style.display !== 'none',
    'заметка: текст вводится в многострочном поле');
  els['tc-settings-textarea'].value = '  Цель 320  ';
  els['tc-settings-apply']._listeners.click();
  const noteOv = liveOverlays().find(o => o.name === 'simpleAnnotation');
  assert(noteOv && noteOv.extendData === 'Цель 320',
    'заметка: текст обрезан и попал в extendData simpleAnnotation');
  assert(!modalEl._classes.has('active'), 'заметка: после применения диалог закрыт');
  chart.removeOverlay(noteOv.id);

  // Пустой текст: inline-ошибка, объект не создан; Escape отменяет
  // и снимает активный инструмент (window-обработчик, как в браузере)
  const noteBtn2 = btnTool();
  sandbox.window.tcDrawOverlay('text', noteBtn2);
  els['tc-settings-textarea'].value = '   ';
  els['tc-settings-apply']._listeners.click();
  assert(modalEl._classes.has('active')
    && !liveOverlays().find(o => o.name === 'simpleAnnotation'),
    'заметка: пустой текст — inline-ошибка, объект не создан');
  assert(els['tc-settings-error'].textContent.includes('текст'),
    'заметка: текст ошибки про пустой ввод');
  winListeners.keydown({ key: 'Escape' });
  assert(!modalEl._classes.has('active') && !noteBtn2._classes.has('active'),
    'заметка: Escape закрыл диалог и снял активный инструмент');

  // Клик по фону (мимо карточки) — тоже отмена
  sandbox.window.tcDrawOverlay('text', btnTool());
  modalEl._listeners.click({ target: modalEl });
  assert(!modalEl._classes.has('active'), 'заметка: клик по фону отменил диалог');

  chipRsi.children[1]._listeners.click(); // × — убрать
  assert(JSON.stringify(removedIndicators[0]) === JSON.stringify(['tc_ind_RSI', 'RSI']),
    'индикаторы: удаление передаёт (paneId, name) как требует API 9.6');
  assert(els['tc-indicator-chips'].children.length === 2, 'индикаторы: чип удалён (volume остался)');

  // 10a) Volume-гистограмма: draw с нормировкой по видимой области и
  //      метка на оси, следующая за кроссхейром (облик TradingView)
  const volRects = [];
  const volCtx = {
    fillStyle: null,
    fillRect: (x, y, w, h) => volRects.push([x, y, w, h, volCtx.fillStyle]),
  };
  const volList = [
    { volume: 100, close: 10, open: 9 }, // свеча вверх
    { volume: 200, close: 8, open: 11 }, // свеча вниз
    { volume: 0, close: 5, open: 5 },    // нулевой объём — столбика нет
  ];
  const volDraw = ({ from, to }) => registeredIndicator.draw({
    ctx: volCtx,
    kLineDataList: volList,
    visibleRange: { from, to },
    bounding: { top: 0, width: 300, height: 100 },
    barSpace: { bar: 10, halfBar: 5, gapBar: 8, halfGapBar: 4 },
    xAxis: { convertToPixel: i => i * 10 },
  });
  volDraw({ from: 0, to: 2 });
  assert(volRects.length === 2, 'volume: нарисовано 2 столбика, нулевой объём пропущен');
  assert(JSON.stringify(volRects[0]) === JSON.stringify([-4, 90, 8, 10, 'rgba(38, 166, 154, 0.5)']),
    'volume: столбик вверх — полупрозрачный зелёный, высота 10px из 20% панели');
  assert(JSON.stringify(volRects[1]) === JSON.stringify([6, 80, 8, 20, 'rgba(239, 83, 80, 0.5)']),
    'volume: столбик вниз — полупрозрачный красный, высота по максимуму видимой области');
  volRects.length = 0;
  volDraw({ from: 0, to: 0 }); // виден один бар — нормировка по нему
  assert(JSON.stringify(volRects[0]) === JSON.stringify([-4, 80, 8, 20, 'rgba(38, 166, 154, 0.5)']),
    'volume: нормировка пересчитана по максимуму видимой области');
  volDraw({ from: 0, to: 2 }); // вернуть полную геометрию для метки на оси

  // Метка на оси: значение и верх столбика под курсором, цвет по свече
  actions['onCrosshairChange']({ kLineData: volList[0], paneId: 'candle_pane' });
  assert(els['tc-vol-axis'].textContent === '100' && els['tc-vol-axis'].style.top === '90px' &&
    els['tc-vol-axis']._classes.has('show') && els['tc-vol-axis']._classes.has('up') &&
    !els['tc-vol-axis']._classes.has('down'),
    'volume: метка на оси — 100 на высоте столбика, зелёная');
  actions['onCrosshairChange']({ kLineData: volList[1], paneId: 'candle_pane' });
  assert(els['tc-vol-axis'].textContent === '200' && els['tc-vol-axis'].style.top === '80px' &&
    els['tc-vol-axis']._classes.has('down') && !els['tc-vol-axis']._classes.has('up'),
    'volume: метка следует за курсором, красная на столбике вниз');
  actions['onCrosshairChange']({ kLineData: volList[0] }); // paneId нет — курсор ушёл с графика
  assert(!els['tc-vol-axis']._classes.has('show') && els['tc-vol-axis'].textContent === '',
    'volume: уход курсора прячет метку на оси');

  sandbox.window.tcRemoveIndicator('VOL_MAIN');
  assert(JSON.stringify(removedIndicators[removedIndicators.length - 1]) ===
      JSON.stringify(['candle_pane', 'VOL_MAIN']),
    'volume: удаление передаёт (candle_pane, VOL_MAIN)');
  actions['onCrosshairChange']({ kLineData: volList[0], paneId: 'candle_pane' });
  assert(!els['tc-vol-axis']._classes.has('show'), 'volume: метка скрыта, пока гистограмма выключена');
  sandbox.window.tcAddIndicator('VOL_MAIN');
  assert(createdIndicators['VOL_MAIN'] && createdIndicators['VOL_MAIN'].id === 'candle_pane' &&
    statusOf().text.includes('Гистограмма объёма включена'),
    'volume: включается обратно через dropdown в главном окне');

  // 11) Binance: период поллинга 5 с (ближе к потоку TV), UTC-метки парсятся
  els['test-chart-ticker-input'].value = 'BINANCE:BTCUSDT';
  fetchQueue = [{
    symbol: 'BINANCE:BTCUSDT', interval: 7, name: 'Bitcoin',
    candles: [{ begin: '2026-11-19T00:00:00Z', open: 95000, high: 96000, low: 94000, close: 95500, volume: 1 }],
  }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  assert(Number.isFinite(applied[applied.length - 1].timestamp), 'Binance: UTC begin парсится в timestamp');
  assert(statusOf().text.includes('5 с'), 'Binance: статус обещает автообновление 5 с');
  assert(els['tc-sym-code'].textContent === 'BTCUSDT' && els['tc-sym-name'].textContent === 'Bitcoin',
    'шапка: префикс BINANCE: скрыт, имя монеты показано');
  assert(els['tc-sym-tf'].textContent === '1н', 'шапка: ТФ 1н для interval=7');
  assert(els['tc-sym-price'].textContent === '95,500.00', 'шапка: цена с разделением разрядов');
  assert(els['tc-sym-change'].textContent === '' && !els['tc-sym-change']._classes.has('up'),
    'шапка: дельты нет, когда предыдущей свечи нет');
  assert(precisions.length === 0,
    'точность: BTC с целыми ценами в тестовых данных — пол 2 знака, setPrecision не звался');

  // 11a) Дешёвый инструмент (BINANCE:SHIBUSDT ~0.0000154): точность
  //      определяется по данным — 2 знака давали «O 0.00 H 0.00 …»
  const sat = (day, close) => ({
    begin: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
    open: close, high: close, low: close, close, volume: 1,
  });
  els['test-chart-ticker-input'].value = 'BINANCE:SHIBUSDT';
  fetchQueue = [{
    symbol: 'BINANCE:SHIBUSDT', interval: 24,
    // 0.0000154 → 7 знаков; 0.000000154 библиотека печатает «1.54e-7» —
    // экспонента: 7 порядков + 2 разряда мантиссы = 9 знаков (максимум)
    candles: [sat(18, 0.000000154), sat(19, 0.0000154)],
  }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  assert(precisions.length === 1 && precisions[0].price === 9 && precisions[0].volume === 0,
    'точность: для SHIB setPrecision({price: 9}) вызван один раз');
  assert(els['tc-sym-price'].textContent === '0.000015400',
    'точность: шапка показывает 0.000015400 вместо «0.00»');
  assert(els['tc-leg-o'].textContent === '0.000015400' && els['tc-leg-c'].textContent === '0.000015400',
    'точность: легенда O/C не схлопывается в нули');
  assert(els['tc-sym-change'].textContent.startsWith('+0.000015246'),
    'точность: дельта с теми же знаками, что и цена');

  // 12) Ошибка загрузки неизвестного тикера — статус ошибки
  els['test-chart-ticker-input'].value = 'ZZZZ';
  fetchQueue = [
    { symbol: 'MOEX:ZZZZ', interval: 7, error: 'Тикер не найден' }, // slice
    { symbol: 'MOEX:ZZZZ', interval: 7, error: 'Тикер не найден' }, // фолбэк
  ];
  const toastTimersBefore = timeouts.length;
  await sandbox.window.loadTestChartCandles();
  assert(statusOf().err && statusOf().text.includes('не найден'), 'неизвестный тикер: ошибка в статусе');
  // +1 — только info «Загрузка свечей…»; сама ошибка таймер автоскрытия не заводит
  assert(timeouts.length === toastTimersBefore + 1,
    'тост: ошибка сама не гаснет — таймер автоскрытия не заведён');

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
  assert(applied.length === 2 && applied[applied.length - 1].close === 0.0000154,
    'отложка: старый график ещё на месте (SHIB из шага 11a), свечи не перезагружены');
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
  assert(precisions.length === 2 && precisions[1].price === 2 && precisions[1].volume === 0,
    'точность: возврат к «дорогому» инструменту — setPrecision вернул 2 знака');

  // 14) Сброс вида (как в TradingView): «улетевшие» зум/сдвиг возвращаются
  //     к дефолтам, снятым с инстанса при init, + scrollToRealTime.
  //     Дефолты в fake-инстансе: barSpace 8, offsetRight 50 (на момент init).
  //     Пауза — выходим из guard-окна dblclick после достройки фигуры
  //     в шаге 0b (как в браузере: dblclick приходит через десятки мс)
  await new Promise(r => setTimeout(r, 360));
  barSpace = 25; offsetRight = 180; // масштаб/сдвиг «улетели»
  sandbox.window.tcResetChartView();
  assert(barSpace === 8 && offsetRight === 50, 'сброс: дефолтные масштаб (8) и сдвиг (50) возвращены');
  const names = callOrder.map(c => c[0]);
  const bsI = names.lastIndexOf('setBarSpace');
  const orI = names.lastIndexOf('setOffsetRightDistance');
  const srtI = names.lastIndexOf('scrollToRealTime');
  assert(bsI !== -1 && orI === bsI + 1 && srtI === orI + 1,
    'сброс: порядок setBarSpace → setOffsetRightDistance → scrollToRealTime');
  assert(statusOf().text.includes('сброшен') && !statusOf().err,
    'сброс: статус сообщает об успешном сбросе вида');

  // 14a) Двойной клик по холсту — тот же сброс
  barSpace = 25; offsetRight = 180;
  els['tc-chart-stage']._listeners.dblclick({ preventDefault: () => {} });
  assert(barSpace === 8 && offsetRight === 50, 'сброс: двойной клик возвращает дефолтный вид');

  // 14a2) Двойной клик во время рисования фигуры вид НЕ сбрасывает —
  //       иначе быстрый двухкликовый инструмент (линия/стрелка) сбивал
  //       бы собственное рисование
  barSpace = 25; offsetRight = 180;
  fakeDrawing = true;
  els['tc-chart-stage']._listeners.dblclick({ preventDefault: () => {} });
  assert(barSpace === 25 && offsetRight === 180,
    'сброс: во время рисования фигуры двойной клик не сбрасывает вид');
  fakeDrawing = false;
  els['tc-chart-stage']._listeners.dblclick({ preventDefault: () => {} });
  assert(barSpace === 8 && offsetRight === 50,
    'сброс: после завершения рисования двойной клик снова сбрасывает вид');

  // 14b) Правый клик — своё меню «Reset chart» вместо браузерного
  const stageEl = els['tc-chart-stage'];
  const menuEl = els['tc-ctx-menu'];
  stageEl._listeners.contextmenu({ clientX: 500, clientY: 300, preventDefault: () => {} });
  assert(menuEl._classes.has('show'), 'меню: правый клик открыл контекстное меню');
  assert(menuEl.style.left === '500px' && menuEl.style.top === '300px',
    'меню: без геометрии холста позиция ставится у курсора как есть');
  assert(docListeners.click && docListeners.keydown, 'меню: обработчики закрытия навешены на document');

  // Прижим внутрь холста: курсор у правого/нижнего края — меню не обрезается
  stageEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 });
  menuEl.offsetWidth = 150; menuEl.offsetHeight = 36;
  stageEl._listeners.contextmenu({ clientX: 900, clientY: 500, preventDefault: () => {} });
  assert(menuEl.style.left === '442px' && menuEl.style.top === '356px',
    'меню: позиция прижата внутрь границ холста (600×400, меню 150×36)');
  assert(menuEl._classes.has('show'), 'меню: повторный правый клик переоткрывает меню');

  // Клик по пункту — сброс вида
  els['tc-ctx-reset']._listeners.click();
  assert(barSpace === 8 && offsetRight === 50 && statusOf().text.includes('сброшен'),
    'меню: клик по «Reset chart» сбросил вид');
  docListeners.click(); // клик всплывает в document — меню закрывается
  assert(!menuEl._classes.has('show'), 'меню: клик по пункту закрыл меню');

  // Escape закрывает, чужая клавиша — нет; клик мимо (document click) тоже
  stageEl._listeners.contextmenu({ clientX: 100, clientY: 100, preventDefault: () => {} });
  assert(menuEl._classes.has('show'), 'меню: переоткрыто для проверки клавиатуры');
  docListeners.keydown({ key: 'a' });
  assert(menuEl._classes.has('show'), 'меню: чужая клавиша меню не закрывает');
  docListeners.keydown({ key: 'Escape' });
  assert(!menuEl._classes.has('show'), 'меню: Escape закрыл меню');
  stageEl._listeners.contextmenu({ clientX: 100, clientY: 100, preventDefault: () => {} });
  docListeners.click();
  assert(!menuEl._classes.has('show'), 'меню: клик вне меню закрыл его');

  // 14c) Правый клик по фигуре удаляет её силами библиотеки (колбэк
  //      onRightClick срабатывает на mousedown непосредственно перед
  //      contextmenu) — «Reset chart» в этом случае не открывается
  const delBtn = new El('button');
  sandbox.window.tcDrawOverlay('segment', delBtn);
  const ovDel = [...overlayStore.values()].reverse().find(o => o.name === 'segment');
  assert(typeof ovDel.opts.onRightClick === 'function',
    'меню: у фигур навешен колбэк onRightClick');
  assert(ovDel.opts.onRightClick({ overlay: ovDel }) === false,
    'меню: onRightClick возвращает false — библиотека удаляет фигуру штатно');
  stageEl._listeners.contextmenu({ clientX: 200, clientY: 200, preventDefault: () => {} });
  assert(!menuEl._classes.has('show'),
    'меню: правый клик по фигуре не открывает «Reset chart»');
  chart.removeOverlay(ovDel.id); // библиотека удалила фигуру этим же кликом

  // Окно подавления истекло — правый клик мимо фигур снова открывает меню
  await new Promise(r => setTimeout(r, 360));
  stageEl._listeners.contextmenu({ clientX: 200, clientY: 200, preventDefault: () => {} });
  assert(menuEl._classes.has('show'),
    'меню: правый клик мимо фигур по-прежнему открывает «Reset chart»');
  docListeners.click();

  // 14d) Ctrl+Z — убрать последнюю нарисованную фигуру (как в TradingView)
  const undoBtn = new El('button');
  sandbox.window.tcDrawOverlay('segment', undoBtn);
  const ovUndo = [...overlayStore.values()].reverse().find(o => o.name === 'segment');
  ovUndo.points = [
    { timestamp: Date.UTC(2026, 10, 19), value: 140, dataIndex: 0 },
    { timestamp: Date.UTC(2026, 10, 20), value: 145, dataIndex: 1 },
  ];
  ovUndo.opts.onDrawEnd({ overlay: ovUndo });
  const beforeUndo = liveOverlays().length;
  docListeners.keydown({ ctrlKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  assert(liveOverlays().length === beforeUndo - 1 && statusOf().text.includes('удалена'),
    'Ctrl+Z: последняя фигура удалена, статус сообщает об этом');
  // Фокус в поле ввода — сочетание не должно трогать разметку
  docListeners.keydown({
    ctrlKey: true, key: 'z', code: 'KeyZ',
    target: els['test-chart-ticker-input'], preventDefault: () => {},
  });
  assert(liveOverlays().length === beforeUndo - 1,
    'Ctrl+Z: при фокусе в поле ввода разметка не тронута');
  // Без Ctrl — тоже
  docListeners.keydown({ key: 'z', preventDefault: () => {} });
  assert(liveOverlays().length === beforeUndo - 1,
    'Ctrl+Z: без Ctrl разметка не тронута');

  // 14e) Escape как в TradingView: снимает режим рисования — недостроенная
  //      фигура удаляется (removeOverlay по id прогресс-объекта 9.6 сам
  //      сбрасывает _progressInstanceInfo), инструмент отжимается;
  //      взведённая кисть разоружается; без активного рисования — no-op
  const escBtn = btnTool();
  sandbox.window.tcDrawOverlay('segment', escBtn);
  assert(escBtn._classes.has('active') && fakeProgressInfo !== null,
    'Esc: рисование сегмента ждёт точки');
  const segsBeforeEsc = liveOverlays().filter(o => o.name === 'segment').length;
  docListeners.keydown({ key: 'Escape', preventDefault: () => {} });
  assert(liveOverlays().filter(o => o.name === 'segment').length === segsBeforeEsc - 1,
    'Esc: недостроенная фигура удалена с холста');
  assert(fakeProgressInfo === null,
    'Esc: прогресс-режим библиотеки сброшен — рисование не «застревает»');
  assert(!escBtn._classes.has('active'), 'Esc: подсветка инструмента снята');
  assert(statusOf().text.includes('отменено'), 'Esc: статус сообщает об отмене рисования');
  const brushEsc = btnTool();
  sandbox.window.tcDrawOverlay('tc-brush', brushEsc);
  assert(brushEsc._classes.has('active'), 'Esc: кисть взведена');
  docListeners.keydown({ key: 'Escape', preventDefault: () => {} });
  assert(!brushEsc._classes.has('active'), 'Esc: взведённая кисть разоружена');
  assert(!liveOverlays().find(o => o.name === 'tc-brush' && o.points.length === 2),
    'Esc: кисть без пути ничего не создала');
  const statusBeforeEscNoop = statusOf().text;
  docListeners.keydown({ key: 'Escape', preventDefault: () => {} });
  assert(statusOf().text === statusBeforeEscNoop,
    'Esc: без активного рисования и меню — ничего не происходит');

  // 15) Полный инструментарий разметки (как в TradingView): кастомные
  //     шаблоны зарегистрированы, встроенные создаются своими именами
  assert(registeredOverlays['tc-arrow'] && registeredOverlays['tc-arrow'].totalStep === 3,
    'стрелка: кастомный overlay (2 точки) зарегистрирован');
  assert(registeredOverlays['tc-brush'] && registeredOverlays['tc-brush'].totalStep === 2,
    'кисть: кастомный overlay зарегистрирован');
  assert(registeredOverlays['tc-measure'] && registeredOverlays['tc-measure'].totalStep === 3,
    'измеритель: кастомный overlay (2 точки) зарегистрирован');

  const gazpMarkup = () => (JSON.parse(store.get('test_chart_markup') || '{}')['GAZP'] || []);
  // press-drag на Pointer Events: pointerdown ловится на холсте (capture),
  // pointermove/pointerup — на window (мышь, тач и стилус одним потоком)
  const stageMDn = (ev) => els['tc-chart-stage']._listeners.pointerdown({
    button: 0, preventDefault: () => {}, stopPropagation: () => {}, ...ev,
  });
  const stageMMove = (ev) => winListeners.pointermove(ev);
  const stageMUp = (ev) => winListeners.pointerup(ev);

  const btnH = btnTool();
  sandbox.window.tcDrawOverlay('horizontalStraightLine', btnH);
  assert(liveOverlays().some(o => o.name === 'horizontalStraightLine')
    && btnH._classes.has('active') && statusOf().text.includes('по всей ширине'),
    'горизонтальная линия: встроенный overlay создан, иконка активна, подсказка про ширину');
  chart.removeOverlay(liveOverlays().find(o => o.name === 'horizontalStraightLine').id);

  const btnV = btnTool();
  sandbox.window.tcDrawOverlay('verticalStraightLine', btnV);
  assert(liveOverlays().some(o => o.name === 'verticalStraightLine')
    && statusOf().text.includes('по всей высоте'),
    'вертикальная линия: создана, подсказка про высоту');
  chart.removeOverlay(liveOverlays().find(o => o.name === 'verticalStraightLine').id);

  const btnC = btnTool();
  sandbox.window.tcDrawOverlay('priceChannelLine', btnC);
  assert(liveOverlays().some(o => o.name === 'priceChannelLine') && statusOf().text.includes('3 раза'),
    'канал: priceChannelLine создан, подсказка про 3 точки');
  chart.removeOverlay(liveOverlays().find(o => o.name === 'priceChannelLine').id);

  const btnA = btnTool();
  sandbox.window.tcDrawOverlay('tc-arrow', btnA);
  const arrowOv = liveOverlays().find(o => o.name === 'tc-arrow');
  assert(arrowOv && statusOf().text.includes('стрелка'),
    'стрелка: кастомный overlay создан через tcDrawOverlay');
  chart.removeOverlay(arrowOv.id);

  // 16) Геометрия figures шаблонов
  const arrowFigs = registeredOverlays['tc-arrow'].createPointFigures({
    coordinates: [{ x: 100, y: 200 }, { x: 180, y: 120 }],
  });
  const arrowTip = arrowFigs.find(f => f.type === 'polygon');
  assert(arrowFigs.length === 2 && arrowFigs[0].type === 'line' && arrowTip,
    'стрелка: figures — линия + наконечник-многоугольник');
  assert(arrowTip.attrs.coordinates[0].x === 180 && arrowTip.attrs.coordinates[0].y === 120,
    'стрелка: наконечник при конечной точке');

  const brushFigs = registeredOverlays['tc-brush'].createPointFigures({
    coordinates: [{ x: 1, y: 1 }, { x: 5, y: 2 }, { x: 9, y: 4 }],
  });
  assert(brushFigs.length === 1 && brushFigs[0].type === 'line'
    && brushFigs[0].attrs.coordinates.length === 3,
    'кисть: figures — ломаная через все точки');

  const measFigs = registeredOverlays['tc-measure'].createPointFigures({
    coordinates: [{ x: 100, y: 200 }, { x: 180, y: 120 }],
    overlay: { points: [
      { timestamp: Date.UTC(2026, 10, 18), value: 100 },
      { timestamp: Date.UTC(2026, 10, 21), value: 110 },
    ] },
    barSpace: { bar: 8 }, precision: 2, thousandsSeparator: ' ',
  });
  const measRect = measFigs.find(f => f.type === 'rect');
  const measTexts = measFigs.filter(f => f.type === 'text').map(f => f.attrs.text);
  assert(measRect && measRect.attrs.x === 100 && measRect.attrs.y === 120
    && measRect.attrs.width === 80 && measRect.attrs.height === 80,
    'измеритель: прямоугольник растянут между двумя точками');
  assert(measRect && measRect.styles.borderColor === '#26a69a',
    'измеритель: рост цены — зелёная рамка');
  assert(measTexts.some(t => t.includes('+10.00 (+10.00%)')),
    'измеритель: дельта цены и проценты в подписи');
  assert(measTexts.some(t => t.includes('10 баров') && t.includes('3д')),
    'измеритель: число баров и длительность в подписи');

  // 17) Кисть: press-drag — зажали, повели, отпустили
  const brushBtn = btnTool();
  sandbox.window.tcDrawOverlay('tc-brush', brushBtn);
  assert(brushBtn._classes.has('active') && statusOf().text.includes('Кисть'),
    'кисть: инструмент активирован с подсказкой');
  stageMDn({ clientX: 100, clientY: 200 });
  const brushOv = liveOverlays().find(o => o.name === 'tc-brush');
  assert(brushOv && brushOv.points.length === 2,
    'кисть: при нажатии создана с двумя стартовыми точками');
  stageMMove({ clientX: 110, clientY: 210 });
  assert(brushOv.points.length === 3 && updatePaneCalls > 0,
    'кисть: движение добавляет точку и перерисовывает панель');
  stageMMove({ clientX: 111, clientY: 210 });
  assert(brushOv.points.length === 3,
    'кисть: сдвиг меньше порога (2 px) точку не добавляет');
  stageMMove({ clientX: 130, clientY: 180 });
  assert(brushOv.points.length === 4,
    'кисть: следующее движение добавляет ещё точку');
  stageMUp({});
  assert(!brushBtn._classes.has('active'),
    'кисть: после отпускания иконка отжалась');
  assert(gazpMarkup().length === 1 && gazpMarkup()[0].name === 'tc-brush'
    && gazpMarkup()[0].points.length === 4,
    'кисть: путь сохранён в localStorage по тикеру GAZP');
  assert(Number.isFinite(gazpMarkup()[0].points[0].timestamp)
    && Number.isFinite(gazpMarkup()[0].points[0].value),
    'кисть: точки сериализованы как timestamp/value');

  // 18) Кисть: клик без движения — объект удаляется, хлам не сохраняется
  const brushBtn2 = btnTool();
  sandbox.window.tcDrawOverlay('tc-brush', brushBtn2);
  stageMDn({ clientX: 100, clientY: 200 });
  const degId = liveOverlays().find(o => o.name === 'tc-brush' && o.id !== brushOv.id).id;
  stageMUp({});
  assert(chart.getOverlayById(degId) === null,
    'кисть: клик без движения удалил объект');
  assert(gazpMarkup().length === 1 && gazpMarkup()[0].points.length === 4,
    'кисть: пустой клик не изменил сохранённую разметку');
  assert(statusOf().text.includes('зажмите кнопку'),
    'кисть: подсказка при пустом клике');

  // 19) Измеритель: растягивание, временный характер, удаление кликом
  const measBtn = btnTool();
  sandbox.window.tcDrawOverlay('tc-measure', measBtn);
  assert(measBtn._classes.has('active'), 'измеритель: инструмент активирован');
  stageMDn({ clientX: 100, clientY: 150 });
  const measOv = liveOverlays().find(o => o.name === 'tc-measure');
  assert(measOv, 'измеритель: при нажатии создан');
  stageMMove({ clientX: 180, clientY: 120 });
  assert(measOv.points.length === 2 && measOv.points[1].value === 300 - 120,
    'измеритель: вторая точка следует за курсором');
  stageMUp({});
  assert(!measBtn._classes.has('active') && liveOverlays().find(o => o.name === 'tc-measure'),
    'измеритель: построен, иконка отжалась, объект ещё живёт');
  // Клик по холсту — измерение исчезает и в localStorage не попадает
  stageMDn({ clientX: 100, clientY: 150 });
  assert(!liveOverlays().find(o => o.name === 'tc-measure'),
    'измеритель: следующий клик по холсту убрал его (как в TradingView)');
  assert(gazpMarkup().length === 1 && gazpMarkup()[0].name === 'tc-brush',
    'измеритель: в localStorage не сохраняется — разметка состоит только из кисти');

  // 20) Переключение инструмента снимает активную кисть/измеритель:
  //     mousedown после выбора другого инструмента кисть не рисует
  const brushBtn3 = btnTool();
  sandbox.window.tcDrawOverlay('tc-brush', brushBtn3);
  assert(brushBtn3._classes.has('active'), 'кисть: повторная активация');
  const segBtn = btnTool();
  sandbox.window.tcDrawOverlay('segment', segBtn);
  stageMDn({ clientX: 200, clientY: 200 });
  stageMMove({ clientX: 220, clientY: 220 });
  stageMUp({});
  assert(!liveOverlays().find(o => o.name === 'tc-brush' && o.id !== brushOv.id),
    'переключение: активная кисть снята, mousedown рисует обычный segment');
  chart.removeOverlay(liveOverlays().find(o => o.name === 'segment').id);

  // 21) Точки за последней свечой (правое поле графика): захват идёт по
  //     dataIndex (timestamp за границами данных библиотека не отдаёт),
  //     сериализация синтезирует время с флагом f:1, восстановление
  //     переводит время обратно в dataIndex — точка остаётся «в будущем»
  const brushBtn4 = btnTool();
  sandbox.window.tcDrawOverlay('tc-brush', brushBtn4);
  stageMDn({ clientX: 100, clientY: 200 }); // dataIndex 13 — правее 2 свечей GAZP
  // только что созданная кисть — ровно 2 точки (кисть из теста 17 уже с 4)
  const futureOv = liveOverlays().find(o => o.name === 'tc-brush'
    && o.points.length === 2 && o.points[0].dataIndex === 13);
  assert(futureOv && futureOv.points[0].timestamp === undefined
    && Number.isFinite(futureOv.points[0].vts),
  'кисть: точка за последней свечой — dataIndex + синтезированное время, без timestamp');
  stageMMove({ clientX: 130, clientY: 190 });
  assert(futureOv.points.length === 3 && futureOv.points[2].dataIndex === 16,
    'кисть: движение в правом поле добавляет точку с dataIndex 16');
  stageMUp({});
  const brushSpecs = gazpMarkup().filter(s => s.name === 'tc-brush');
  const fSpec = brushSpecs[brushSpecs.length - 1];
  const gazpLast = applied[applied.length - 1];
  assert(fSpec && fSpec.points.length === 3 && fSpec.points.every(p => p.f === 1),
    'кисть: путь целиком в правом поле сохранён с флагами f:1');
  assert(fSpec.points[0].timestamp === gazpLast.timestamp + (13 - (applied.length - 1)) * 86400000,
    'кисть: синтезированное время = последняя свеча + (dataIndex - lastIndex) * интервал ТФ');

  // Измеритель у точек без timestamp считает длительность по vts
  const measVtsFigs = registeredOverlays['tc-measure'].createPointFigures({
    coordinates: [{ x: 0, y: 200 }, { x: 80, y: 240 }],
    overlay: { points: [
      { dataIndex: 0, vts: Date.UTC(2026, 10, 18), value: 100 },
      { dataIndex: 10, vts: Date.UTC(2026, 10, 28), value: 90 },
    ] },
    barSpace: { bar: 8 }, precision: 2, thousandsSeparator: ' ',
  });
  const measVtsTexts = measVtsFigs.filter(f => f.type === 'text').map(f => f.attrs.text);
  assert(measVtsTexts.some(t => t.includes('-10.00')),
    'измеритель: дельта цены считается у точек без timestamp (по vts)');
  assert(measVtsTexts.some(t => t.includes('10д')),
    'измеритель: длительность считается у точек без timestamp (по vts)');

  // Восстановление: f:1 → dataIndex, точка остаётся в правом поле
  els['test-chart-ticker-input'].value = 'SBER';
  fetchQueue = [{ symbol: 'MOEX:SBER', interval: 24, candles: [candle(19, 315)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  els['test-chart-ticker-input'].value = 'GAZP';
  fetchQueue = [{ symbol: 'MOEX:GAZP', interval: 24, candles: [candle(19, 141), candle(20, 143)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  const restoredFuture = liveOverlays().find(o => o.name === 'tc-brush'
    && o.points.some(p => p.dataIndex === 16 && p.timestamp === undefined));
  assert(restoredFuture, 'кисть: f-точки восстановлены как dataIndex (16) без timestamp');
  assert(statusOf().text.includes('разметка восстановлена'),
    'статус: разметка GAZP с правопольными точками восстановлена');

  // 22) Тип графика и режим шкалы цены (как в TradingView): сегмент типов
  //     (candle.type 9.6), кластер шкалы (yAxis.type) с сохранением выбора
  styleCalls.length = 0;
  sandbox.window.tcSetChartType('line');
  const lineStyles = styleCalls[styleCalls.length - 1].candle;
  assert(lineStyles.type === 'area' &&
    lineStyles.area.backgroundColor.every(g => g.color === 'rgba(41, 98, 255, 0)'),
    'тип «Линия»: area-тип по close с полностью прозрачной заливкой');
  assert(lineStyles.priceMark.high.show === false && lineStyles.priceMark.low.show === false,
    'тип «Линия»: метки max/min свечи скрыты (как в TradingView)');
  assert(els['tc-type-line']._classes.has('active') && !els['tc-type-candles']._classes.has('active'),
    'тип «Линия»: кнопка сегмента активна, свечи отжаты');
  assert(JSON.parse(store.get('test_chart_view')).type === 'line',
    'тип графика сохранён в localStorage');

  sandbox.window.tcSetChartType('bars');
  assert(styleCalls[styleCalls.length - 1].candle.type === 'ohlc', 'тип «Бары»: candle.type=ohlc');
  sandbox.window.tcSetChartType('area');
  const areaStyles22 = styleCalls[styleCalls.length - 1].candle;
  assert(areaStyles22.type === 'area' &&
    areaStyles22.area.backgroundColor[1].color === 'rgba(41, 98, 255, 0.22)',
    'тип «Области»: заливка TV-синим видна');
  sandbox.window.tcSetChartType('candles');
  const candleStyles22 = styleCalls[styleCalls.length - 1].candle;
  assert(candleStyles22.type === 'candle_solid' && candleStyles22.priceMark.high.show === true,
    'тип «Свечи»: candle_solid, метки max/min возвращены');
  assert(JSON.parse(store.get('test_chart_view')).type === 'candles',
    'тип графика сохранён в localStorage');

  // Шкала цены: log и % взаимоисключающие режимы (yAxis.type 9.6, как в TV)
  sandbox.window.tcSetScaleMode('log');
  assert(styleCalls[styleCalls.length - 1].yAxis.type === 'log', 'шкала: log через yAxis.type');
  assert(els['tc-scale-log']._classes.has('active') && !els['tc-scale-pct']._classes.has('active'),
    'шкала: активен только log');
  sandbox.window.tcSetScaleMode('percentage');
  assert(styleCalls[styleCalls.length - 1].yAxis.type === 'percentage', 'шкала: проценты');
  assert(els['tc-scale-pct']._classes.has('active') && !els['tc-scale-log']._classes.has('active'),
    'шкала: переключение на % сняло активность log');
  assert(JSON.parse(store.get('test_chart_view')).scale === 'percentage',
    'режим шкалы сохранён в localStorage');

  // Автомасштаб: перетаскивание шкалы цены сняло автоподгонку (ручной
  // масштаб, как в TV) — отпускание кнопки гасит «авто»; кнопка «авто» —
  // переключатель: возвращает автоподгонку и, что важнее, выключает её
  // (тем же флагом, что и перетаскивание оси — шкала фиксируется)
  autoCalcTickFlag = false;
  winListeners.pointerup();
  assert(!els['tc-scale-auto']._classes.has('active'),
    'автоскейл: перетаскивание шкалы сняло автоподгонку, кнопка «авто» отжалась');
  styleCalls.length = 0;
  sandbox.window.tcAutoSizeScale(); // выключена → включить
  assert(styleCalls.length === 1 && styleCalls[0].yAxis.type === 'percentage',
    'автоскейл: «авто» возвращает автоподгонку setStyles с текущим режимом шкалы');
  autoCalcTickFlag = true; // setStyles в 9.6 сам возвращает флаг оси
  sandbox.window.tcAutoSizeScale(); // включена → выключить
  assert(autoCalcTickFlag === false && !els['tc-scale-auto']._classes.has('active')
    && statusOf().text.includes('выключен'),
    'автоскейл: повторный клик по «авто» выключает автоподгонку (шкала зафиксирована)');
  sandbox.window.tcAutoSizeScale(); // выключена → снова включить
  assert(styleCalls[styleCalls.length - 1].yAxis.type === 'percentage'
    && statusOf().text.includes('включён'),
    'автоскейл: зафиксированную шкалу можно вернуть под автоподгонку');
  autoCalcTickFlag = true; // setStyles в 9.6 сам возвращает флаг оси
  winListeners.pointerup(); // отпускание кнопки актуализирует состояние «авто»
  assert(els['tc-scale-auto']._classes.has('active'),
    'автоскейл: после возврата автоподгонки кнопка снова активна');

  // 22a) Выбор переживает «перезагрузку»: повторный DOMContentLoaded
  //      подтягивает тип/шкалу из localStorage и синхронизирует кнопки
  sandbox.window.tcSetChartType('area');
  sandbox.window.tcSetScaleMode('log');
  els['tc-type-area']._classes.delete('active');
  els['tc-scale-log']._classes.delete('active');
  fetchQueue = [{ symbol: 'MOEX:GAZP', interval: 24, candles: [candle(20, 143)] }];
  domReadyCb(); // повторная инициализация страницы
  await flush();
  assert(els['tc-type-area']._classes.has('active') && els['tc-scale-log']._classes.has('active')
    && els['tc-scale-auto']._classes.has('active'),
    'вид: после «перезагрузки» восстановлены область + log из localStorage');

  // 23) Фигуры без меток на осях (как в TradingView): встроенные шаблоны
  //     пере-регистрированы — осевые метки выключены, ручки точек остались;
  //     геометрия фигур совпадает с библиотечной
  for (const name of ['segment', 'horizontalStraightLine', 'verticalStraightLine',
    'horizontalRayLine', 'priceChannelLine', 'fibonacciLine']) {
    const tpl = registeredOverlays[name];
    assert(tpl && tpl.needDefaultPointFigure === true
      && tpl.needDefaultXAxisFigure === false && tpl.needDefaultYAxisFigure === false,
      `оси: ${name} без осевых меток (синие теги при выделении), с ручками точек`);
  }
  const segFigs23 = registeredOverlays['segment'].createPointFigures({
    coordinates: [{ x: 10, y: 20 }, { x: 60, y: 80 }],
  });
  assert(segFigs23.length === 1 && segFigs23[0].type === 'line',
    'оси: segment — линия между двумя точками');
  const rayFigs23 = registeredOverlays['horizontalRayLine'].createPointFigures({
    coordinates: [{ x: 100, y: 50 }, { x: 200, y: 50 }],
    bounding: { width: 300, height: 100 },
  });
  assert(rayFigs23[0].attrs.coordinates[1].x === 300,
    'оси: горизонтальный луч тянется к правому краю');
  const pclFigs23 = registeredOverlays['priceChannelLine'].createPointFigures({
    coordinates: [{ x: 0, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 60 }],
    bounding: { width: 200, height: 200 },
  });
  assert(pclFigs23.length === 1 && pclFigs23[0].attrs.length === 3,
    'оси: канал — граница, параллель и продолжение по третьей точке');
  const fibFigs23 = registeredOverlays['fibonacciLine'].createPointFigures({
    coordinates: [{ x: 100, y: 50 }, { x: 300, y: 100 }],
    overlay: { points: [{ timestamp: 1, value: 100 }, { timestamp: 2, value: 50 }] },
    bounding: { width: 400, height: 200 },
    precision: { price: 2 }, thousandsSeparator: ' ',
  });
  assert(fibFigs23.length === 2 && fibFigs23[0].type === 'line' && fibFigs23[1].type === 'text'
    && fibFigs23[0].attrs.length === 7 && fibFigs23[1].attrs.length === 7,
    'оси: уровни Фибоначчи — 7 линий с подписями');
  assert(fibFigs23[1].attrs[0].text.includes('100.00 (100.0%)'),
    'оси: подпись уровня Фибоначчи 100% с ценой');

  // 24) Догоняющий клик: быстрый последний клик фигуры (9.6 глотает его в
  //     окне dblclick — ни click, ни dblclick) достраивает фигуру без
  //     лишнего клика «мимо»: точка ставится тем же кликом, объект
  //     переводится в готовые, инструмент отжимается, разметка сохраняется
  //     (две свечи: точка клика уйдёт в правое поле, как в живом графике)
  els['test-chart-ticker-input'].value = 'GAZP';
  fetchQueue = [{ symbol: 'MOEX:GAZP', interval: 24, candles: [candle(19, 141), candle(20, 143)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  const btnQ = btnTool();
  sandbox.window.tcDrawOverlay('segment', btnQ);
  const ovQ = liveOverlays().find(o => o.name === 'segment' && o.currentStep !== undefined);
  assert(ovQ && btnQ._classes.has('active'), 'догоняющий клик: инструмент активен, рисование ждёт точек');
  // клик 1 библиотека приняла: первая точка встала, шаг продвинулся
  ovQ.points.push({ timestamp: Date.UTC(2026, 10, 19), value: 140, dataIndex: 1 });
  ovQ.currentStep = 2;
  // клик 2 — проглочен (окно dblclick): нажатие и отпускание в одном месте
  // (клик), дальше 6 px от нажатия он бы считался перетаскиванием холста
  els['tc-chart-stage']._listeners.pointerdown({ button: 0, clientX: 420, clientY: 160, preventDefault: () => {}, stopPropagation: () => {} });
  els['tc-chart-stage']._listeners.pointerup({ button: 0, clientX: 421, clientY: 161 });
  const swallowedTimer = timeouts.filter(t => t.ms === 60).pop();
  assert(swallowedTimer, 'догоняющий клик: проверка проглоченного клика запланирована');
  swallowedTimer.cb();
  assert(ovQ.points.length === 2, 'догоняющий клик: вторая точка поставлена тем же кликом');
  assert(ovQ.currentStep === -1, 'догоняющий клик: рисование завершено');
  assert(progressCompleted === 1 && fakeProgressInfo === null,
    'догоняющий клик: объект переведён из progress-режима в готовые');
  assert(!btnQ._classes.has('active'), 'догоняющий клик: инструмент отжался без клика «мимо»');
  const gazpSegs24 = gazpMarkup().filter(s => s.name === 'segment');
  assert(gazpSegs24.length === 1 && gazpSegs24[0].points.length === 2,
    'догоняющий клик: разметка сохранена сразу после последнего клика');
  // 26) Двойной клик сразу после достроенной фигуры — часть рисования,
  //     вид не сбрасывает (вне guard-окна сбрасывает — см. 14a)
  barSpace = 25; offsetRight = 180;
  els['tc-chart-stage']._listeners.dblclick({ preventDefault: () => {} });
  assert(barSpace === 25 && offsetRight === 180,
    'сброс: dblclick сразу после достроенной фигуры вид не сбрасывает');
  chart.removeOverlay(ovQ.id);

  // 25) Догоняющий клик — негативные сценарии
  const progressCompleted25 = progressCompleted;
  // a) клик дошёл до библиотеки (точка уже встала) — дубля не будет
  const btnR25 = btnTool();
  sandbox.window.tcDrawOverlay('segment', btnR25);
  const ovR25 = liveOverlays().find(o => o.name === 'segment' && o.currentStep !== undefined && o !== ovQ);
  els['tc-chart-stage']._listeners.pointerdown({ button: 0, clientX: 100, clientY: 100, preventDefault: () => {}, stopPropagation: () => {} });
  els['tc-chart-stage']._listeners.pointerup({ button: 0, clientX: 101, clientY: 101 });
  ovR25.points.push({ timestamp: Date.UTC(2026, 10, 19), value: 140, dataIndex: 1 });
  ovR25.currentStep = 2;
  timeouts.filter(t => t.ms === 60).pop().cb();
  assert(ovR25.points.length === 1 && progressCompleted === progressCompleted25,
    'догоняющий клик: обработанный библиотекой клик не дублируется');
  chart.removeOverlay(ovR25.id);
  // b) перетаскивание холста (drag дальше 6 px) кликом не считается
  const btnS25 = btnTool();
  sandbox.window.tcDrawOverlay('segment', btnS25);
  const ovS25 = liveOverlays().find(o => o.name === 'segment' && o.currentStep !== undefined && o !== ovQ);
  ovS25.points.push({ timestamp: Date.UTC(2026, 10, 19), value: 140, dataIndex: 1 });
  ovS25.currentStep = 2;
  const timeoutsBefore25 = timeouts.length;
  els['tc-chart-stage']._listeners.pointerdown({ button: 0, clientX: 100, clientY: 100, preventDefault: () => {}, stopPropagation: () => {} });
  els['tc-chart-stage']._listeners.pointerup({ button: 0, clientX: 260, clientY: 100 });
  assert(timeouts.length === timeoutsBefore25,
    'догоняющий клик: перетаскивание холста точку не ставит');
  chart.removeOverlay(ovS25.id);
  // c) клик вне панели свечей (ось времени/под-окно) точкой фигуры не будет:
  //    шаг не продвинулся (клик проглочен), но панель чужая — не кормим
  const btnT25 = btnTool();
  sandbox.window.tcDrawOverlay('segment', btnT25);
  const ovT25 = liveOverlays().find(o => o.name === 'segment' && o.currentStep !== undefined && ![ovQ, ovR25, ovS25].includes(o));
  ovT25.points.push({ timestamp: Date.UTC(2026, 10, 19), value: 140, dataIndex: 1 });
  ovT25.currentStep = 2;
  els['tc-chart-stage']._listeners.pointerdown({ button: 0, clientX: 300, clientY: 415, preventDefault: () => {}, stopPropagation: () => {} });
  els['tc-chart-stage']._listeners.pointerup({ button: 0, clientX: 301, clientY: 415 });
  timeouts.filter(t => t.ms === 60).pop().cb();
  assert(ovT25.points.length === 1 && ovT25.currentStep === 2 && progressCompleted === progressCompleted25,
    'догоняющий клик: клик вне панели свечей фигуру не достраивает');
  chart.removeOverlay(ovT25.id);

  // 27) Точность осей под-окон: размах шкалы MACD ~8000 → целые подписи
  //     (библиотечная точность 4 печатала «4,000.0000», читавшееся как
  //     «±4,000,000»); настройка — после первого кадра с экстремумом оси
  chart._drawPanes.push({
    _id: 'tc_ind_MACD', getId: () => 'tc_ind_MACD',
    _axis: { getExtremum: () => ({ min: -4000, max: 4000 }) },
  });
  sandbox.window.tcAddIndicator('MACD');
  assert(createdIndicators['MACD'] && createdIndicators['MACD'].id === 'tc_ind_MACD',
    'MACD: создан в собственном под-окне');
  const overridesBefore27 = overrides.length;
  timeouts.filter(t => t.ms === 400).forEach(t => t.cb()); // «первый кадр»
  assert(overrides.length > overridesBefore27,
    'точность оси: отложенная настройка выполнена после раскладки');
  assert(overrides.some(o => o.name === 'MACD' && o.precision === 0),
    'точность оси: MACD ±4000 → подписи без дробной части (precision 0)');

  // 28) Undo/redo разметки (стрелки в шапке как в TradingView): стек
  //     операций создать/удалить/сдвинуть/очистить; Ctrl+Z / Ctrl+Y /
  //     Ctrl+Shift+Z; смена тикера сбрасывает историю; пункты контекстного
  //     меню (копия цены, снимок PNG, очистка) и их undo-ability
  els['test-chart-ticker-input'].value = 'SBER';
  fetchQueue = [{ symbol: 'MOEX:SBER', interval: 24, candles: [candle(19, 315)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  els['test-chart-ticker-input'].value = 'GAZP';
  fetchQueue = [{ symbol: 'MOEX:GAZP', interval: 24, candles: [candle(19, 141), candle(20, 143)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();

  // a) создать → в стеке; стрелки в шапке: undo активна, redo пуста
  const segBtn28 = btnTool();
  sandbox.window.tcDrawOverlay('segment', segBtn28);
  const ov28 = liveOverlays().find(o => o.name === 'segment' && o.currentStep !== undefined);
  ov28.points = [
    { timestamp: Date.UTC(2026, 10, 19), value: 140, dataIndex: 0 },
    { timestamp: Date.UTC(2026, 10, 20), value: 145, dataIndex: 1 },
  ];
  ov28.opts.onDrawEnd({ overlay: ov28 });
  assert(!els['tc-undo'].disabled && els['tc-redo'].disabled,
    'undo/redo: создание в стеке — стрелка undo активна, redo погашена');

  // b) Ctrl+Z удаляет созданное, стек пустеет, redo готова
  docListeners.keydown({ ctrlKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  assert(chart.getOverlayById(ov28.id) === null && statusOf().text.includes('удалена'),
    'undo: Ctrl+Z удалил созданную фигуру, статус об отмене создания');
  assert(els['tc-undo'].disabled && !els['tc-redo'].disabled,
    'undo: стек пуст — undo погасла, redo активна');

  // c) Ctrl+Y возвращает фигуру с точками
  docListeners.keydown({ ctrlKey: true, key: 'y', code: 'KeyY', preventDefault: () => {} });
  const redo28 = liveOverlays().find(o => o.name === 'segment');
  assert(redo28 && redo28.points.length === 2 && redo28.points[1].value === 145,
    'redo: Ctrl+Y вернул фигуру с точками');
  assert(!els['tc-undo'].disabled && els['tc-redo'].disabled,
    'redo: операция вернулась в стек undo, redo снова пуста');

  // d) сдвинуть: onPressedMoveStart/End пишут операцию с до/после-снимками
  const beforeMove28 = JSON.stringify(redo28.points);
  redo28.opts.onPressedMoveStart({ overlay: redo28 });
  redo28.points = [
    { timestamp: Date.UTC(2026, 10, 19), value: 150, dataIndex: 0 },
    { timestamp: Date.UTC(2026, 10, 20), value: 155, dataIndex: 1 },
  ];
  redo28.opts.onPressedMoveEnd({ overlay: redo28 });
  docListeners.keydown({ ctrlKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  assert(JSON.stringify(redo28.points) === beforeMove28,
    'undo: перетаскивание отменено — точки вернулись на место');
  docListeners.keydown({ ctrlKey: true, shiftKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  assert(redo28.points[0].value === 150 && redo28.points[1].value === 155,
    'redo (Ctrl+Shift+Z): перетаскивание повторено');

  // e) удалить правым кликом (силами библиотеки) → Ctrl+Z возвращает
  const hlineBtn28 = btnTool();
  sandbox.window.tcDrawOverlay('horizontalStraightLine', hlineBtn28);
  const hline28 = liveOverlays().find(o => o.name === 'horizontalStraightLine' && o.currentStep !== undefined);
  hline28.points = [{ timestamp: Date.UTC(2026, 10, 20), value: 143, dataIndex: 1 }];
  hline28.opts.onDrawEnd({ overlay: hline28 });
  chart.removeOverlay(hline28.id);
  assert(chart.getOverlayById(hline28.id) === null,
    'undo/redo: фигура удалена правым кликом (как в браузере)');
  docListeners.keydown({ ctrlKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  const back28 = liveOverlays().find(o => o.name === 'horizontalStraightLine');
  assert(back28 && back28.points.length === 1 && back28.points[0].value === 143
    && statusOf().text.includes('возвращена'),
    'undo: удалённая правым кликом фигура возвращена');

  // f) очистить: операция «очистить» целиком обратима кнопками шапки
  const markupCnt28 = gazpMarkup().length;
  const liveCnt28 = liveOverlays().length;
  assert(liveCnt28 > 0, 'undo/redo: к очистке есть разметка (кисти + фигуры)');
  sandbox.window.tcClearOverlays();
  assert(liveOverlays().length === 0 && gazpMarkup().length === 0,
    'очистка: холст и хранилище пусты');
  sandbox.window.tcUndo(); // кнопка undo в шапке (onclick="tcUndo()")
  assert(liveOverlays().length === liveCnt28 && gazpMarkup().length === markupCnt28,
    'undo (кнопка шапки): очистка отменена — разметка восстановлена в холст и хранилище');
  sandbox.window.tcRedo(); // кнопка redo (onclick="tcRedo()")
  assert(liveOverlays().length === 0 && gazpMarkup().length === 0,
    'redo (кнопка шапки): разметка снова удалена');

  // g) контекстное меню богаче одного «Reset chart»: копия цены, снимок
  //    PNG, очистка (возвратная через Ctrl+Z); без цены под курсором
  //    пункт копирования гасится
  stageEl._listeners.contextmenu({ clientX: 300, clientY: 150, preventDefault: () => {} });
  assert(menuEl._classes.has('show') && !els['tc-ctx-copy'].disabled,
    'меню: открыто, цена под курсором найдена — «Скопировать цену» активна');
  els['tc-ctx-copy']._listeners.click();
  assert(statusOf().err && statusOf().text.includes('Буфер'),
    'меню: без clipboard API — честная ошибка копирования');
  els['tc-ctx-shot']._listeners.click();
  assert(statusOf().text.includes('Снимок'),
    'меню: снимок PNG — без canvas-ов (мини-DOM) честный статус');
  els['tc-ctx-clear']._listeners.click();
  assert(liveOverlays().length === 0 && statusOf().text.includes('Разметка удалена'),
    'меню: «Удалить всю разметку» очистило холст');
  docListeners.keydown({ ctrlKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  assert(liveOverlays().length === liveCnt28,
    'меню: очистка из контекстного меню возвращается Ctrl+Z');
  docListeners.click(); // закрыть меню

  // h) смена тикера сбрасывает историю undo/redo (стек чужой разметки
  //    не переезжает на новый график)
  els['test-chart-ticker-input'].value = 'SBER';
  fetchQueue = [{ symbol: 'MOEX:SBER', interval: 24, candles: [candle(19, 315)] }];
  await sandbox.window.loadTestChartCandles();
  await flush();
  assert(els['tc-undo'].disabled && els['tc-redo'].disabled,
    'undo/redo: смена тикера сбросила историю — обе стрелки погашены');
  docListeners.keydown({ ctrlKey: true, key: 'z', code: 'KeyZ', preventDefault: () => {} });
  assert(statusOf().text.includes('Отменять нечего'),
    'undo/redo: пустой стек — статус «Отменять нечего»');

  if (failures) { console.error(`\n${failures} FAILURES`); process.exit(1); }
  console.log('\nALL PASS');
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
