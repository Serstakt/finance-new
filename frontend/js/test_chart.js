// Раздел «Тест график»: свечи MOEX ISS (user status NOT AUTHORIZED —
// данные с задержкой ~15 мин) и крипто-пары Binance (BINANCE:BTCUSDT,
// реальное время) рисуются библиотекой KLineChart.
// Ввод тикера — по образцу формы добавления в watchlist: поле + кнопка,
// отправка по Enter. Данные идут через бэкенд: GET /api/candles/{symbol}.
//
// Поведение в духе TradingView:
//   - начальная загрузка — последнее окно истории (~600 баров, бэкенд
//     ?slice=1 отдаёт только срез источника, пишуя его в хранилище);
//     при неудаче источника — полный запрос через накопленное хранилище;
//   - скролл влево дозагружает старые экраны (instance.loadMore → бэкенд
//     from/till пагинация);
//   - последняя свеча «тикует»: поллинг через updateData (Binance 8 с,
//     MOEX 60 с) с инкрементом from от даты последней свечи;
//   - масштаб и сдвиг от правого края переживают смену тикера/ТФ
//     (getBarSpace/getOffsetRightDistance → set… после applyNewData);
//   - разметка (overlay) хранится по тикеру в localStorage и
//     восстанавливается при возврате к тикеру;
//   - последний тикер/ТФ автозагружаются при открытии страницы;
//   - облик TradingView: вертикальная панель инструментов разметки слева
//     (иконки SVG инлайном), шапка символа (код · имя · ТФ + последняя
//     цена с дельтой, имя приходит в candles-ответе бэкенда), легенда
//     OHLCV в углу холста следует за кроссхейром (subscribeAction
//     onCrosshairChange, в 9.6 payload несёт kLineData);
//   - volume-гистограмма включена по умолчанию: полупрозрачные столбики
//     в главном окне (кастомный индикатор VOL_MAIN, нормировка по максимуму
//     видимой области), своя метка на оси цены под курсором и легенда
//     «Объем» (значение обновляется вместе с OHLC);
//   - сброс вида как в TradingView: двойной клик по графику или правый
//     клик → контекстное меню «Reset chart» возвращает дефолтные масштаб
//     и сдвиг от правого края (снимаются с инстанса сразу после init)
//     и прокручивает график к последней свече (scrollToRealTime) —
//     «улетевший» зум/сдвиг всегда можно вернуть. Правый клик по фигуре
//     меню не открывает (библиотека этим же кликом удаляет фигуру),
//     последнюю фигуру также убирает Ctrl+Z;
//   - тип графика как в TradingView: сегмент «свечи/бары/линия/области»
//     (candle.type 9.6: линия и области — area-тип, у линии заливка
//     прозрачная; метки max/min у линий скрываются, как в TV);
//   - шкала цены как в TradingView: кластер «log / % / авто» у правого
//     края холста (yAxis.type normal|log|percentage, режимы
//     взаимоисключающие и только для панели свечей). Перетаскивание шкалы
//     цены снимает автоподгонку оси (autoCalcTickFlag → ручной масштаб,
//     как в TV), кнопка «авто» — переключатель: возвращает автоподгонку
//     или замораживает шкалу по текущей области; тип и режим переживают
//     перезагрузку (localStorage);
//   - диалог настроек вместо window.prompt (чужеродный и блокирует
//     вкладку): текст заметки и периоды индикатора вводятся в модальном
//     окне в стиле приложения — Enter применяет, Escape/клик по фону
//     отменяет, ошибки валидации показываются inline;
//   - фигура фиксируется последним кликом, как в TradingView: быстрый
//     (до 500 мс после предыдущего) клик KLineChart 9.6 проглатывает —
//     окно двойного клика в SyntheticEvent съедает mouseup, не
//     диспетчеризуя ни click, ни dblclick. Недостроенную фигуру доигрываем
//     сами: через мгновение после отпускания кнопки видно, дошла ли точка
//     до рисования, и если нет — точка ставится этим же кликом;
//   - оси не подсвечиваются от нарисованного: встроенные шаблоны фигур
//     (segment и др.) пере-регистрируются без осевых меток
//     (needDefaultXAxisFigure/YAxisFigure=false) — у TradingView при
//     выделении фигуры теги на осях не появляются;
//   - точность подписей осей под-окон подбирается по размаху шкалы
//     (у библиотечных индикаторов по умолчанию precision 4 — ось MACD
//     печатает «4,000.0000», читающееся как «±4,000,000»);
//   - компоновка как в TradingView: график занимает почти весь экран —
//     поиск символа, ТФ, тип и индикаторы стоят в одной шапке карточки
//     графика, подсказка раздела свёрнута в кнопку «?», статус живёт
//     поверх холста и высоты не съедает.

(() => {
  let chartInstance = null;
  let lastTicker = null; // последний успешно введённый тикер (сохранение разметки, guard поллинга)
  let lastTs = null; // timestamp последней свечи — точка инкремента поллинга
  let pollTimer = null;
  let pollKey = null; // 'TICKER|interval' — поллинг останавливается, если данные сменились
  let overlayIds = []; // id созданных overlay — для сериализации разметки
  let lastDrawEndAt = 0; // Date.now() последнего завершения фигуры — guard сброса вида на dblclick
  let currentInterval = 24; // активный ТФ (60|24|7|31)
  // Активные индикаторы: name -> paneId. В 9.6 removeIndicator требует
  // (paneId, name) — поэтому храним оба.
  const indicators = new Map();

  // Периоды поллинга: у Binance реальные тики, поэтому часто; ISS и так
  // отдаёт котировки с задержкой ~15 мин — чаще 60 с смысла нет.
  const POLL_MS = { binance: 8000, moex: 60000 };
  // Разметка в localStorage: { TICKER: [{ name, extendData, points: [{timestamp, value}] }] }
  const MARKUP_LS_KEY = 'test_chart_markup';
  // Последний открытый график (автозагрузка при открытии страницы)
  const LAST_LS_KEY = 'test_chart_last';
  // Начальное окно истории в днях (~600 баров; дозагрузка старых — loadMore)
  const TF_LOOKBACK_DAYS = { 60: 40, 24: 600, 7: 4200, 31: 18000 };
  // Индикаторы, живущие в главном окне со свечами; остальные — в своих под-окнах
  const MAIN_PANE_INDICATORS = new Set(['MA', 'EMA', 'BOLL', 'SAR', 'BBI', 'AVP', 'VOL_MAIN']);

  // ---- Тип графика и режим шкалы цены (как в TradingView) ----
  // Типы: candles|bars|line|area → candle.type 9.6 (candle_solid|ohlc|area).
  // «Линия» — тот же area-тип по цене закрытия, но с прозрачной заливкой;
  // у линий/областей метки max/min свечи скрываются (в TradingView линии
  // их не имеют). Шкала: normal|log|percentage → yAxis.type (режимы
  // взаимоисключающие и действуют только на панель свечей — как в TV).
  // Перетаскивание шкалы цены библиотека превращает в ручной масштаб
  // (autoCalcTickFlag=false), setStyles с yAxis.type возвращает
  // автоподгонку — на этом построены и смена режима, и кнопка «авто».
  // Выбор переживает перезагрузку страницы (localStorage).

  const VIEW_LS_KEY = 'test_chart_view';
  const LINE_COLOR = '#2962ff';
  const CHART_TYPE_LABELS = { candles: 'Свечи', bars: 'Бары', line: 'Линия', area: 'Области' };
  // Заливка area-типа: прозрачная у «линии», TV-синяя у «областей»
  const areaStyles = (transparent) => ({
    lineSize: 2,
    lineColor: LINE_COLOR,
    value: 'close',
    backgroundColor: [
      { offset: 0, color: transparent ? 'rgba(41, 98, 255, 0)' : 'rgba(41, 98, 255, 0.01)' },
      { offset: 1, color: transparent ? 'rgba(41, 98, 255, 0)' : 'rgba(41, 98, 255, 0.22)' },
    ],
  });
  const CHART_TYPE_STYLES = {
    candles: { type: 'candle_solid', priceMark: { high: { show: true }, low: { show: true } } },
    bars: { type: 'ohlc', priceMark: { high: { show: true }, low: { show: true } } },
    line: { type: 'area', priceMark: { high: { show: false }, low: { show: false } }, area: areaStyles(true) },
    area: { type: 'area', priceMark: { high: { show: false }, low: { show: false } }, area: areaStyles(false) },
  };
  const SCALE_MODES = ['normal', 'log', 'percentage'];
  const SCALE_LABELS = { normal: 'обычная', log: 'логарифмическая', percentage: 'проценты' };

  let chartType = 'candles'; // активный тип графика (candles|bars|line|area)
  let scaleMode = 'normal';  // режим шкалы цены (normal|log|percentage)

  const loadSavedView = () => {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_LS_KEY) || '{}');
      if (CHART_TYPE_STYLES[v.type]) chartType = v.type;
      if (SCALE_MODES.includes(v.scale)) scaleMode = v.scale;
    } catch (e) { /* битый JSON — остаются дефолты */ }
  };

  const saveView = () => {
    try {
      localStorage.setItem(VIEW_LS_KEY, JSON.stringify({ type: chartType, scale: scaleMode }));
    } catch (e) { /* localStorage недоступен — вид не сохранится */ }
  };

  const syncTypeButtons = () => {
    for (const t of Object.keys(CHART_TYPE_STYLES)) {
      const btn = document.getElementById(`tc-type-${t}`);
      if (btn) btn.classList.toggle('active', chartType === t);
    }
  };

  // Ось цены главной панели — внутреннее API 9.6 (как getChartStore в
  // isOverlayDrawing): нужен только флаг автоподгона; недоступен —
  // считаем автоскейл включённым
  const candlePaneAxis = () => {
    try {
      const pane = chartInstance && chartInstance._candlePane;
      const axis = pane && typeof pane.getAxisComponent === 'function'
        ? pane.getAxisComponent() : null;
      return axis && typeof axis.getAutoCalcTickFlag === 'function' ? axis : null;
    } catch (e) { return null; }
  };

  // Автоподгонка шкалы: перетаскивание оси цены снимает её (setExtremum),
  // setStyles с yAxis.type возвращает — кнопка «авто» переключает туда и
  // обратно (см. tcAutoSizeScale ниже)
  const isAutoScaleOn = () => {
    const axis = candlePaneAxis();
    return !axis || axis.getAutoCalcTickFlag() !== false;
  };

  const syncScaleButtons = () => {
    const logBtn = document.getElementById('tc-scale-log');
    if (logBtn) logBtn.classList.toggle('active', scaleMode === 'log');
    const pctBtn = document.getElementById('tc-scale-pct');
    if (pctBtn) pctBtn.classList.toggle('active', scaleMode === 'percentage');
    const autoBtn = document.getElementById('tc-scale-auto');
    if (autoBtn) autoBtn.classList.toggle('active', isAutoScaleOn());
  };

  const applyChartType = () => {
    if (!chartInstance) return;
    // setStyles в 9.6 сливает partial-стили: у линии/областей каждый раз
    // задаём area целиком, прозрачная заливка линии не «прилипла» к others
    chartInstance.setStyles({ candle: CHART_TYPE_STYLES[chartType] });
  };

  // Смена режима шкалы заодно сбрасывает ручной масштаб: в 9.6 setStyles
  // с yAxis.type возвращает autoCalcTickFlag в true — шкала заново
  // подгоняется по видимой области (как смена масштаба в TradingView)
  const applyScaleMode = () => {
    if (!chartInstance) return;
    chartInstance.setStyles({ yAxis: { type: scaleMode } });
  };

  window.tcSetChartType = function (type) {
    if (!CHART_TYPE_STYLES[type]) return;
    chartType = type;
    applyChartType();
    syncTypeButtons();
    saveView();
    setStatus(`Тип графика: ${CHART_TYPE_LABELS[type]}`);
  };

  window.tcSetScaleMode = function (mode) {
    if (!SCALE_MODES.includes(mode)) return;
    scaleMode = mode;
    applyScaleMode();
    syncScaleButtons();
    saveView();
    setStatus(`Шкала цены: ${SCALE_LABELS[mode]}`);
  };

  // Кнопка-переключатель (как «auto» на шкале цены в TradingView): если
  // автоподгонка выключена — включает (setStyles с текущим режимом шкалы
  // возвращает autoCalcTickFlag), если включена — выключает, замораживая
  // шкалу по текущей видимой области: Axis.setAutoCalcTickFlag(false)
  // работает так же, как перетаскивание оси (Axis.setExtremum → флаг
  // false), но не меняет экстремум — шкала остаётся как есть и больше
  // не подгоняется, пока кнопку не нажмут снова
  window.tcAutoSizeScale = function () {
    if (!getChartInstance()) return;
    if (isAutoScaleOn()) {
      const axis = candlePaneAxis();
      if (!axis || typeof axis.setAutoCalcTickFlag !== 'function') {
        // Внутреннее API оси недоступно — выключить автоподгонку нечем
        setStatus('Автомасштаб: шкала уже подгоняется по видимой области');
        return;
      }
      axis.setAutoCalcTickFlag(false);
      // Перерисовать панель (UpdateLevel.Drawer в 9.6.0 = 3), чтобы ось
      // перерисовалась не дожидаясь следующего тика/движения курсора
      if (typeof chartInstance.updatePane === 'function') chartInstance.updatePane(3);
      setStatus('Автомасштаб выключен: шкала зафиксирована по текущей области');
    } else {
      // setStyles с текущим режимом шкалы возвращает автоподгонку оси
      applyScaleMode();
      setStatus('Автомасштаб включён: шкала подгоняется по видимой области');
    }
    // Актуализируем кнопку на случай, если состояние оси изменилось мимо
    // mouseup (например, из другого обработчика библиотеки)
    syncScaleButtons();
  };


  // ---- Volume-гистограмма в главном окне (как в TradingView) ----
  // Кастомный индикатор VOL_MAIN: полупрозрачные столбики объёма поверх
  // нижней части ценовой панели. Значений в result нет (figures: [],
  // calc: []): диапазон оси главной панели в 9.6 учитывает значения figures
  // главного индикатора — миллионы объёма растянули бы ценовую шкалу.
  // Всё рисование — в draw: столбики нормируются по максимуму ВИДИМОЙ
  // области и пересчитываются на каждом кадре (скролл/зум меняют высоты,
  // как в TV). Геометрия запоминается в volScale — по ней HTML-метка
  // tc-vol-axis ставится на верх столбика под курсором.

  const VOL_MAIN = 'VOL_MAIN';
  // Самый высокий столбик — 20% высоты ценовой панели (пропорции TV)
  const VOL_MAX_HEIGHT_RATIO = 0.2;
  const VOL_BAR_COLORS = {
    up: 'rgba(38, 166, 154, 0.5)',
    down: 'rgba(239, 83, 80, 0.5)',
  };
  let volScale = null; // { top, height, unitPx } — панель и px на единицу объёма

  const registerVolumeIndicator = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerIndicator({
      name: VOL_MAIN,
      shortName: 'Объем',
      figures: [],
      calc: () => [],
      draw: ({ ctx, kLineDataList, visibleRange, bounding, barSpace, xAxis }) => {
        volScale = null;
        if (!kLineDataList || !kLineDataList.length || !barSpace || !bounding) return false;
        const from = Math.max(0, visibleRange.from);
        const to = Math.min(kLineDataList.length - 1, visibleRange.to);
        if (from > to) return false;
        let volMax = 0;
        for (let i = from; i <= to; i++) {
          const v = kLineDataList[i].volume;
          if (Number.isFinite(v) && v > volMax) volMax = v;
        }
        if (!(volMax > 0)) return false;
        // Координаты draw — локальные относительно canvas панели: низ
        // панели = bounding.height; bounding.top — та же точка в координатах
        // контейнера графика (для позиции HTML-метки на оси)
        const unitPx = (bounding.height * VOL_MAX_HEIGHT_RATIO) / volMax;
        volScale = { top: bounding.top, height: bounding.height, unitPx };
        for (let i = from; i <= to; i++) {
          const k = kLineDataList[i];
          const v = k.volume;
          if (!Number.isFinite(v) || v <= 0) continue;
          const h = Math.max(1, v * unitPx);
          const x = xAxis.convertToPixel(i);
          // Ширина — gapBar, как у встроенных bar-фигур индикаторов
          ctx.fillStyle = k.close >= k.open ? VOL_BAR_COLORS.up : VOL_BAR_COLORS.down;
          ctx.fillRect(x - barSpace.gapBar / 2, bounding.height - h, barSpace.gapBar, h);
        }
        return false; // figures нет — встроенному рисованию перекрыть нечего
      },
    });
  };

  // Кастомный прямоугольник: в KLineChart v9.6 нет встроенного шаблона
  // overlay «rect» (rect — только тип фигуры), поэтому регистрируем свой
  // шаблон из двух точек с фигурой-прямоугольником между ними.
  const registerRectOverlay = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerOverlay({
      name: 'tc-rect',
      totalStep: 3, // 2 точки: противоположные углы
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: true,
      needDefaultYAxisFigure: true,
      createPointFigures: ({ coordinates }) => {
        if (!coordinates || coordinates.length < 2) return [];
        const [a, b] = coordinates;
        return [{
          type: 'rect',
          attrs: {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y),
          },
          styles: {
            style: 'stroke_fill',
            color: 'rgba(41, 98, 255, 0.12)',
            borderColor: '#2962ff',
            size: 1,
          },
        }];
      },
    });
  };

  // Стрелка (как «Стрелка» в TradingView): отрезок из двух точек с
  // треугольным наконечником во второй точке, ориентированным по
  // направлению линии. Стандартный режим рисования KLineChart:
  // клик — начало, второй клик — конец.
  const ARROW_COLOR = '#2962ff';
  const registerArrowOverlay = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerOverlay({
      name: 'tc-arrow',
      totalStep: 3, // 2 точки: начало → конец
      needDefaultPointFigure: true,
      createPointFigures: ({ coordinates }) => {
        if (!coordinates || coordinates.length < 2) return [];
        const [a, b] = coordinates;
        // Наконечник: равнобедренный треугольник при вершине b,
        // ось — вдоль a→b (длина 10 px, полуугол ~26°)
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const len = 10, half = 0.45;
        const wing = (off) => ({
          x: b.x - len * Math.cos(ang + off),
          y: b.y - len * Math.sin(ang + off),
        });
        return [
          {
            type: 'line',
            attrs: { coordinates: [a, b] },
            styles: { style: 'stroke', color: ARROW_COLOR, size: 1.6 },
          },
          {
            type: 'polygon',
            attrs: { coordinates: [b, wing(half), wing(-half)] },
            styles: { style: 'fill', color: ARROW_COLOR },
          },
        ];
      },
    });
  };

  // Кисть (свободное рисование, как «Brush» в TradingView): ломаная из
  // произвольного числа точек. Стандартный click-flow KLineChart не даёт
  // промежуточных точек, поэтому захват пути делает сам tcDrawOverlay:
  // зажали кнопку — создали overlay с одной точкой, повели — дописываем
  // точки в живой инстанс (getOverlayById + updatePane), отпустили —
  // готово. totalStep 2: точки ставятся программно и рисование не
  // «ждёт» второго клика.
  const BRUSH_COLOR = '#2962ff';
  // Минимальная дистанция между соседними точками кисти (px) —
  // ограничивает размер массива points при хранении в localStorage
  const BRUSH_MIN_STEP_PX = 2;
  const registerBrushOverlay = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerOverlay({
      name: 'tc-brush',
      totalStep: 2,
      needDefaultPointFigure: false, // кружки на узлах кисти не нужны
      createPointFigures: ({ coordinates }) => {
        if (!coordinates || coordinates.length < 2) return [];
        return [{
          type: 'line',
          attrs: { coordinates },
          styles: { style: 'stroke', color: BRUSH_COLOR, size: 2 },
        }];
      },
    });
  };

  // Формат цены с точностью инструмента и разделителем тысяч
  // (precision/thousandsSeparator приходят в createPointFigures)
  const formatPriceValue = (v, precision, thousandsSeparator) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const p = Number.isFinite(precision) ? precision : 2;
    const fixed = Math.abs(n).toFixed(p);
    const parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator || ' ');
    return (n < 0 ? '-' : '') + parts.join('.');
  };

  // Русское склонение числа баров: 1 бар, 2 бара, 5 баров, 21 бар
  const pluralBars = (n) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'бар';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'бара';
    return 'баров';
  };

  // Измеритель (как «Measure» в TradingView): прямоугольник между двумя
  // точками с дельтой цены (и %), числом баров и длительностью. Цвет —
  // по направлению движения. Ставится программно тем же press-drag
  // захватом, что и кисть. Постоянной разметкой не становится: клик по
  // графику после измерения его убирает (поведение TradingView), в
  // localStorage он не пишется (см. serializeOverlays).
  const MEASURE_COLORS = {
    up: { fill: 'rgba(38, 166, 154, 0.18)', border: '#26a69a' },
    down: { fill: 'rgba(239, 83, 80, 0.18)', border: '#ef5350' },
  };
  // Человекочитаемая длительность между двумя метками времени («5д 3ч»)
  const fmtTimeSpan = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min}м`;
    const hours = Math.floor(min / 60);
    if (hours < 48) return `${hours}ч ${min % 60}м`;
    const days = Math.floor(hours / 24);
    if (days < 61) return `${days}д`;
    return `${(days / 30.44).toFixed(1)}М`;
  };
  const registerMeasureOverlay = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerOverlay({
      name: 'tc-measure',
      totalStep: 3, // 2 точки
      needDefaultPointFigure: false,
      createPointFigures: ({ coordinates, overlay, barSpace, precision, thousandsSeparator }) => {
        if (!coordinates || coordinates.length < 2) return [];
        const [a, b] = coordinates;
        const [p0, p1] = overlay.points;
        if (!p0 || !p1 || p0.value == null || p1.value == null) return [];
        const up = p1.value >= p0.value;
        const cs = MEASURE_COLORS[up ? 'up' : 'down'];
        const fmtPrice = (v) => formatPriceValue(v, precision, thousandsSeparator);
        const delta = p1.value - p0.value;
        const sign = up ? '+' : '';
        const pct = p0.value ? (delta / p0.value) * 100 : 0;
        const bars = barSpace && barSpace.bar
          ? Math.round(Math.abs(b.x - a.x) / barSpace.bar)
          : 0;
        // Точки в правом поле timestamp не имеют — длительность по vts
        const ts0 = p0.timestamp ?? p0.vts ?? 0;
        const ts1 = p1.timestamp ?? p1.vts ?? 0;
        const span = fmtTimeSpan(Math.abs(ts1 - ts0));
        const priceText = `${sign}${fmtPrice(delta)} (${sign}${pct.toFixed(2)}%)`;
        const timeText = `${bars} ${pluralBars(bars)}${span ? ` · ${span}` : ''}`;
        const cx = (a.x + b.x) / 2;
        const top = Math.min(a.y, b.y);
        const bottom = Math.max(a.y, b.y);
        return [
          {
            type: 'rect',
            attrs: {
              x: Math.min(a.x, b.x),
              y: top,
              width: Math.abs(b.x - a.x),
              height: Math.abs(b.y - a.y),
            },
            styles: {
              style: 'stroke_fill',
              color: cs.fill,
              borderColor: cs.border,
              size: 1,
            },
          },
          // Дельта цены — плашкой у верхней грани, бары/длительность —
          // у нижней (цвет плашки по направлению, как в TradingView).
          // Фон по умолчанию у text-figure синий (#1677FF) — перекрываем.
          { type: 'text', attrs: { x: cx, y: top + 16, text: priceText }, styles: { style: 'fill', color: '#fff', size: 12, backgroundColor: cs.border, borderColor: cs.border } },
          { type: 'text', attrs: { x: cx, y: bottom - 8, text: timeText }, styles: { style: 'fill', color: '#fff', size: 12, backgroundColor: cs.border, borderColor: cs.border } },
        ];
      },
    });
  };

  // ---- Фигуры без меток на осях (как в TradingView) ----
  // Встроенные шаблоны KLineChart 9.6 (segment и др.) включают
  // needDefaultXAxisFigure/needDefaultYAxisFigure: при выделении фигуры на
  // ценовой и временной осях появляются синие теги её точек. У TradingView
  // оси от нарисованного не подсвечиваются, поэтому шаблоны пере-регистрируются
  // под теми же именами (registerOverlay заменяет встроенный) с выключенными
  // осевыми фигурами. Кружки-ручки точек (needDefaultPointFigure) остаются —
  // за них фигуру можно перетаскивать. Геометрия фигур и хелперы скопированы
  // из исходников библиотеки v9.6.0 (klinecharts, Apache-2.0) без изменений.

  // y = k·x + b по двум точкам (extension/figure/line.ts)
  const getLinearSlopeIntercept = (c1, c2) => {
    const difX = c1.x - c2.x;
    if (difX !== 0) {
      const k = (c1.y - c2.y) / difX;
      return [k, c1.y - k * c1.x];
    }
    return null;
  };

  // Параллельные линии канала (extension/overlay/parallelStraightLine.ts)
  const getParallelLines = (coordinates, bounding, extendParallelLineCount = 0) => {
    const lines = [];
    if (coordinates.length > 1) {
      if (coordinates[0].x === coordinates[1].x) {
        const startY = 0;
        const endY = bounding.height;
        lines.push({ coordinates: [{ x: coordinates[0].x, y: startY }, { x: coordinates[0].x, y: endY }] });
        if (coordinates.length > 2) {
          lines.push({ coordinates: [{ x: coordinates[2].x, y: startY }, { x: coordinates[2].x, y: endY }] });
          const distance = coordinates[0].x - coordinates[2].x;
          for (let i = 0; i < extendParallelLineCount; i++) {
            const d = distance * (i + 1);
            lines.push({ coordinates: [{ x: coordinates[0].x + d, y: startY }, { x: coordinates[0].x + d, y: endY }] });
          }
        }
      } else {
        const startX = 0;
        const endX = bounding.width;
        const [k, b] = getLinearSlopeIntercept(coordinates[0], coordinates[1]);
        lines.push({ coordinates: [{ x: startX, y: startX * k + b }, { x: endX, y: endX * k + b }] });
        if (coordinates.length > 2) {
          const b1 = coordinates[2].y - k * coordinates[2].x;
          lines.push({ coordinates: [{ x: startX, y: startX * k + b1 }, { x: endX, y: endX * k + b1 }] });
          const distance = b - b1;
          for (let i = 0; i < extendParallelLineCount; i++) {
            const b2 = b + distance * (i + 1);
            lines.push({ coordinates: [{ x: startX, y: startX * k + b2 }, { x: endX, y: endX * k + b2 }] });
          }
        }
      }
    }
    return lines;
  };

  const registerCleanAxisOverlays = () => {
    if (typeof klinecharts === 'undefined') return;
    const handles = { // ручки точек остаются, метки осей — выключены
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
    };
    klinecharts.registerOverlay({
      ...handles,
      name: 'segment',
      totalStep: 3,
      createPointFigures: ({ coordinates }) => coordinates.length === 2
        ? [{ type: 'line', attrs: { coordinates } }]
        : [],
    });
    klinecharts.registerOverlay({
      ...handles,
      name: 'horizontalStraightLine',
      totalStep: 2,
      createPointFigures: ({ coordinates, bounding }) => [{
        type: 'line',
        attrs: { coordinates: [{ x: 0, y: coordinates[0].y }, { x: bounding.width, y: coordinates[0].y }] },
      }],
    });
    klinecharts.registerOverlay({
      ...handles,
      name: 'verticalStraightLine',
      totalStep: 2,
      createPointFigures: ({ coordinates, bounding }) => [{
        type: 'line',
        attrs: { coordinates: [{ x: coordinates[0].x, y: 0 }, { x: coordinates[0].x, y: bounding.height }] },
      }],
    });
    klinecharts.registerOverlay({
      ...handles,
      name: 'horizontalRayLine',
      totalStep: 3,
      createPointFigures: ({ coordinates, bounding }) => {
        const coordinate = { x: 0, y: coordinates[0].y };
        if (coordinates[1] !== undefined && coordinates[0].x < coordinates[1].x) {
          coordinate.x = bounding.width;
        }
        return [{ type: 'line', attrs: { coordinates: [coordinates[0], coordinate] } }];
      },
      performEventPressedMove: ({ points, performPoint }) => {
        points[0].value = performPoint.value;
        points[1].value = performPoint.value;
      },
      performEventMoveForDrawing: ({ currentStep, points, performPoint }) => {
        if (currentStep === 2) {
          points[0].value = performPoint.value;
        }
      },
    });
    klinecharts.registerOverlay({
      ...handles,
      name: 'priceChannelLine',
      totalStep: 4,
      createPointFigures: ({ coordinates, bounding }) => [
        { type: 'line', attrs: getParallelLines(coordinates, bounding, 1) },
      ],
    });
    klinecharts.registerOverlay({
      ...handles,
      name: 'fibonacciLine',
      totalStep: 3,
      createPointFigures: ({ coordinates, bounding, overlay, precision, thousandsSeparator }) => {
        const points = overlay.points;
        if (!coordinates || !coordinates.length) return [];
        const lines = [];
        const texts = [];
        const startX = 0;
        const endX = bounding.width;
        if (coordinates.length > 1 && points[0].value !== undefined && points[1].value !== undefined) {
          const percents = [1, 0.786, 0.618, 0.5, 0.382, 0.236, 0];
          const yDif = coordinates[0].y - coordinates[1].y;
          const valueDif = points[0].value - points[1].value;
          const pricePrecision = precision && Number.isFinite(precision.price) ? precision.price : 2;
          percents.forEach(percent => {
            const y = coordinates[1].y + yDif * percent;
            const value = formatPriceValue((points[1].value ?? 0) + valueDif * percent, pricePrecision, thousandsSeparator);
            lines.push({ coordinates: [{ x: startX, y }, { x: endX, y }] });
            texts.push({
              x: startX,
              y,
              text: `${value} (${(percent * 100).toFixed(1)}%)`,
              baseline: 'bottom',
            });
          });
        }
        return [
          { type: 'line', attrs: lines },
          { type: 'text', isCheckEvent: false, attrs: texts },
        ];
      },
    });
  };

  // Все кастомные overlay-шаблоны (прямоугольник, стрелка, кисть,
  // измеритель) + пере-регистрация встроенных без осевых меток.
  // registerOverlay идемпотентен — безопасно звать повторно.
  const registerCustomOverlays = () => {
    registerRectOverlay();
    registerArrowOverlay();
    registerBrushOverlay();
    registerMeasureOverlay();
    registerCleanAxisOverlays();
  };

  // Статус — тост, как сообщения в TradingView: висит поверх холста, но не
  // вечно. Обычные сообщения гаснут через 6 с, предупреждения (деградация
  // источника) держатся дольше — 15 с, ошибки не скрываются сами (их должен
  // заменить следующий статус — так «Ошибка: …» не потеряется незаметно).
  // Активный поллинг каждые 8 с перезапускает таймер — живой график держит
  // свой «обновлено HH:MM:SS» видимым, затухает после последнего обновления.
  const STATUS_TTL_MS = { info: 6000, warn: 15000 };
  const STATUS_FADE_MS = 300;
  let statusHideTimer = null;

  const setStatus = (text, isError = false, isWarn = false) => {
    const el = document.getElementById('test-chart-status');
    if (!el) return;
    if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = null; }
    el.classList.remove('fade-out');
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.toggle('warn', !isError && isWarn);
    if (isError || !text) return;
    statusHideTimer = setTimeout(() => {
      statusHideTimer = null;
      el.classList.add('fade-out');
      statusHideTimer = setTimeout(() => {
        statusHideTimer = null;
        el.textContent = '';
        el.classList.remove('fade-out', 'warn');
      }, STATUS_FADE_MS);
    }, isWarn ? STATUS_TTL_MS.warn : STATUS_TTL_MS.info);
  };

  // Префикс биржи выбирает источник данных на бэкенде: MOEX: (акции ISS) или
  // BINANCE: (крипто-пары, спот). Без префикса считаем тикером Мосбиржи.
  const normalizeTicker = (raw) =>
    String(raw || '').trim().toUpperCase().replace('MOEX:', '');

  const isBinanceTicker = (ticker) => ticker.startsWith('BINANCE:');

  // Локальная дата 'YYYY-MM-DD' — граница суток для from/till бэкенда
  const fmtDay = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const getChartInstance = () => {
    if (typeof klinecharts === 'undefined') {
      setStatus('⚠ Библиотека KLineChart не загрузилась (CDN cdn.jsdelivr.net недоступен)', true);
      return null;
    }
    registerCustomOverlays();
    registerVolumeIndicator();
    const el = document.getElementById('test-chart-kline');
    if (!el) return null;
    if (!chartInstance) {
      // Убираем заглушку «Введите тикер…» — контейнер теперь под canvas графика
      el.querySelectorAll('.widget-fallback').forEach(f => f.remove());
      chartInstance = klinecharts.init(el, {
        styles: {
          // Горизонтальная сетка едва заметна, вертикальный пунктир
          // (линии по меткам дат оси времени) отключён совсем
          grid: {
            horizontal: { color: '#1e222d' },
            vertical: { show: false },
          },
          candle: {
            bar: {
              upColor: '#26a69a', downColor: '#ef5350',
              upBorderColor: '#26a69a', downBorderColor: '#ef5350',
              upWickColor: '#26a69a', downWickColor: '#ef5350',
            },
            // Встроенную строку OHLC гасим: в 9.6 standard-tooltip рисуется
            // безусловно, подавить его можно только парой showType 'rect' +
            // showRule 'none' (isDrawTooltip = false). Вместо него — своя
            // легенда .tc-legend в левом верхнем углу, как в TradingView.
            tooltip: { showType: 'rect', showRule: 'none' },
          },
          indicator: {
            // Значения индикаторов (MA, RSI…) оставляем, но опускаем ниже
            // строки легенды (дефолтный marginTop 8 пересекался бы с ней)
            tooltip: { showType: 'standard', showRule: 'always', text: { marginTop: 26 } },
          },
          xAxis: { tickText: { color: '#787b86' }, tickLine: { color: '#2a2e39' } },
          yAxis: { tickText: { color: '#787b86' }, tickLine: { color: '#2a2e39' } },
          crosshair: {
            horizontal: { text: { backgroundColor: '#434651' } },
            vertical: { text: { backgroundColor: '#434651' } },
          },
        },
      });
      // Доступ к instance извне замыкания — для отладки. Сериализация
      // разметки живёт в этом замыкании (overlayIds), наружу не торчит.
      window.testChartInstance = chartInstance;
      // Сохранённый вид (тип графика + режим шкалы) применяем сразу —
      // состояние уже прочитано из localStorage на DOMContentLoaded
      applyChartType();
      applyScaleMode();
      // Дефолтный вид для сброса: снимаем до первого applyNewData и до
      // restoreViewport пользовательских зума/сдвига — это чистые дефолты
      defaultViewport = {
        barSpace: chartInstance.getBarSpace(),
        offsetRight: chartInstance.getOffsetRightDistance(),
      };
      // Volume-гистограмма включена по умолчанию (как в TradingView);
      // выключается чипом, включается обратно через dropdown индикаторов.
      // isStack=true обязателен: в 9.6 IndicatorStore.addInstance при
      // isStack=false делает paneInstances.clear() — каждый следующий
      // индикатор главного окна стирал бы предыдущих (гистограмма объёма
      // исчезала при добавлении MA/EMA/BOLL…, чип при этом оставался)
      if (!indicators.has(VOL_MAIN)) {
        const id = chartInstance.createIndicator(VOL_MAIN, true, { id: 'candle_pane' });
        if (id) {
          indicators.set(VOL_MAIN, 'candle_pane');
          renderIndicatorChips();
        }
      }
      // Легенда OHLCV следует за кроссхейром (как в TradingView). При уходе
      // курсора KLineChart отдаёт последнюю свечу — легенда «возвращается».
      if (typeof chartInstance.subscribeAction === 'function') {
        chartInstance.subscribeAction('onCrosshairChange', (ev) => {
          if (ev && ev.kLineData) {
            renderLegend(ev.kLineData);
            // paneId пуст, когда курсор ушёл с графика (при этом отдаётся
            // последняя свеча) — метку объёма на оси в этом случае прячем
            renderVolumeAxisLabel(ev.kLineData, ev.paneId !== undefined);
          }
        });
      }
    }
    return chartInstance;
  };

  // ---- Viewport: пережить applyNewData без «прыжка» графика ----
  // applyNewData сбрасывает видимую область в дефолт (правый край),
  // а addData по пустому списку ещё и возвращает правый отступ к дефолту.
  // Zoom (barSpace, px на бар) и сдвиг от правого края (px) сохраняем
  // до загрузки и восстанавливаем после — вид остаётся как в TradingView.

  const saveViewport = () => {
    try {
      return {
        barSpace: chartInstance.getBarSpace(),
        offsetRight: chartInstance.getOffsetRightDistance(),
      };
    } catch (e) { return null; }
  };

  const restoreViewport = (vp) => {
    if (!vp) return;
    try {
      // Порядок важен: offsetRightDistance пересчитывается в барах от
      // текущего barSpace
      chartInstance.setBarSpace(vp.barSpace);
      chartInstance.setOffsetRightDistance(vp.offsetRight);
    } catch (e) { /* стейт ещё не готов — останется дефолтный вид */ }
  };

  // ---- Сброс вида (как в TradingView): двойной клик / правый клик →
  // «Reset chart» ---- Дефолтные масштаб и сдвиг снимаются с инстанса
  // сразу после init (6 и 50 в 9.6.0, но снимаем свои — устойчиво к
  // смене дефолтов библиотеки), сброс возвращает их и прокручивает
  // график к последней свече. Иначе «улетевший» зум/сдвиг не вернуть.

  let defaultViewport = null; // { barSpace, offsetRight } — библиотечные дефолты

  const resetChartView = () => {
    const instance = getChartInstance();
    if (!instance || !defaultViewport) return;
    if (!lastTicker || !instance.getDataList().length) {
      setStatus('Сброс вида: сначала загрузите график');
      return;
    }
    try {
      instance.setBarSpace(defaultViewport.barSpace);
      instance.setOffsetRightDistance(defaultViewport.offsetRight);
      // К последней свече (правый край), как «Reset chart» в TradingView
      if (typeof instance.scrollToRealTime === 'function') instance.scrollToRealTime();
      setStatus(`Вид графика сброшен · ${sourceNote(lastTicker)}`);
    } catch (e) {
      setStatus(`Сброс вида не удался: ${e.message || e}`, true);
    }
  };
  window.tcResetChartView = resetChartView;

  // ---- Контекстное меню «Reset chart» (облик TradingView) ----
  // Открывается правым кликом по холсту, позиционируется у курсора с
  // прижимом внутрь границ холста. Закрытие: клик где угодно, Escape,
  // resize окна. KLineChart сам подавляет браузерное меню (preventDefault
  // на своём контейнере) — своё мы вешаем выше, на .tc-chart-stage.

  let ctxMenuOpen = false;
  // Date.now() последнего правого клика, попавшего по фигуре: библиотека
  // зовёт колбэк onRightClick на mousedown (удаляет объект/отменяет
  // рисование), а contextmenu всплывает на холсте сразу после — по нему
  // понимаем, что «Reset chart» в этот момент открывать не нужно
  let lastOverlayRightClickAt = 0;

  const hideCtxMenu = () => {
    const menu = document.getElementById('tc-ctx-menu');
    if (menu) menu.classList.remove('show');
    ctxMenuOpen = false;
  };

  const showCtxMenu = (x, y) => {
    const menu = document.getElementById('tc-ctx-menu');
    const stage = document.getElementById('tc-chart-stage');
    if (!menu) return;
    // Прижим внутрь холста, чтобы меню не обрезалось краем контейнера;
    // без геометрии (мини-DOM тестов) ставим как есть
    const rect = typeof (stage && stage.getBoundingClientRect) === 'function'
      ? stage.getBoundingClientRect() : null;
    if (rect) {
      const menuW = menu.offsetWidth || 150;
      const menuH = menu.offsetHeight || 36;
      const margin = 8;
      let px = x - rect.left;
      let py = y - rect.top;
      px = Math.min(Math.max(px, margin), rect.width - menuW - margin);
      py = Math.min(Math.max(py, margin), rect.height - menuH - margin);
      menu.style.left = `${Math.round(px)}px`;
      menu.style.top = `${Math.round(py)}px`;
    } else {
      menu.style.left = `${Math.round(x)}px`;
      menu.style.top = `${Math.round(y)}px`;
    }
    menu.classList.add('show');
    ctxMenuOpen = true;
  };

  // Идёт ли сейчас рисование фигуры (progress-режим KLineChart): двойной
  // клик во время построения — это просто второй клик инструмента, сброс
  // вида в этот момент сбивал бы рисование (в TradingView двойной клик
  // по графику во время рисования вид не сбрасывает)
  const isOverlayDrawing = () => {
    if (!chartInstance || typeof chartInstance.getChartStore !== 'function') return false;
    try {
      const store = chartInstance.getChartStore();
      const overlayStore = store && typeof store.getOverlayStore === 'function'
        ? store.getOverlayStore() : null;
      return !!(overlayStore && typeof overlayStore.isDrawing === 'function' && overlayStore.isDrawing());
    } catch (e) { return false; }
  };

  const bindResetViewUi = () => {
    const stage = document.getElementById('tc-chart-stage');
    const menu = document.getElementById('tc-ctx-menu');
    if (!stage || stage.dataset.resetViewBound) return;
    stage.dataset.resetViewBound = '1';
    // Двойной клик — сброс вида (как в TradingView), но не во время
    // рисования и не сразу после достроенной фигуры: быстрый двойной клик —
    // часть двухкликового инструмента (последняя точка или degenerate-фигура)
    stage.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!isOverlayDrawing() && Date.now() - lastDrawEndAt >= 350) resetChartView();
    });
    // Правый клик — своё меню вместо браузерного. Правый клик по фигуре
    // библиотека обрабатывает сама (удаляет её / отменяет рисование —
    // onRightClick сработал на mousedown непосредственно перед этим
    // contextmenu): «Reset chart» в этом случае не открываем, а уже
    // открытое меню прячем
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (Date.now() - lastOverlayRightClickAt < 350) {
        hideCtxMenu();
        return;
      }
      showCtxMenu(e.clientX, e.clientY);
    });
    const item = menu && document.getElementById('tc-ctx-reset');
    if (item) {
      // Клик по пункту: сброс произойдёт до закрытия (клик всплывает в
      // document-обработчик ниже — он только прячет меню)
      item.addEventListener('click', () => resetChartView());
    }
    // Закрытие меню: клик где угодно, Escape, изменение размера окна.
    // Ctrl+Z — убрать последнюю нарисованную фигуру (как в TradingView):
    // только при видимом разделе, без открытого диалога, ввода в полях
    // и незавершённого рисования
    document.addEventListener('click', () => { if (ctxMenuOpen) hideCtxMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape' && ctxMenuOpen) hideCtxMenu();
      if (!e || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      // «z» любой раскладки: key на русской раскладке — «я», code от неё не зависит
      if (!(e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) return;
      const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (dialogCtx || isOverlayDrawing() || stageToolDrawing) return;
      if (!chartSectionVisible()) return;
      if (undoLastOverlay()) {
        e.preventDefault();
        setStatus('Последняя фигура удалена (Ctrl+Z)');
      } else {
        setStatus('Отменять нечего: разметки на графике нет');
      }
    });
    window.addEventListener('resize', () => { if (ctxMenuOpen) hideCtxMenu(); });
  };

  // ---- Ctrl+Z: убрать последнюю нарисованную фигуру (как в TradingView) ----
  // Дублирует правый клик по фигуре: на плотной разметке попасть точно
  // по линии сложнее, чем нажать сочетание. onRemoved из overlayCallbacks
  // сам вычистит overlayIds и сохранит разметку.
  const undoLastOverlay = () => {
    if (!chartInstance) return false;
    for (let i = overlayIds.length - 1; i >= 0; i--) {
      const id = overlayIds[i];
      if (!chartInstance.getOverlayById(id)) continue; // удалён раньше (правый клик, «Очистить»)
      if (id === measureLiveId) measureLiveId = null;
      removeStageOverlay(id);
      return true;
    }
    return false;
  };
  window.tcUndoLastOverlay = undoLastOverlay;

  // ---- Диалог настроек (текст заметки, периоды индикатора) ----
  // Замена window.prompt: тот выглядит чужеродно и блокирует вкладку.
  // Модальное окно в стиле приложения: Enter — применить, Escape/клик по
  // фону/«Отмена» — закрыть без изменений. Колбэк apply(value) возвращает
  // true (применено — окно закрывается) или строку с ошибкой валидации
  // (окно остаётся открытым, ошибка показывается inline).

  let dialogCtx = null; // { apply, cancel } текущего диалога

  const hideSettingsDialog = () => {
    const modal = document.getElementById('tc-settings-modal');
    if (modal) modal.classList.remove('active');
    dialogCtx = null;
  };

  const cancelSettingsDialog = () => {
    if (dialogCtx && typeof dialogCtx.cancel === 'function') dialogCtx.cancel();
    hideSettingsDialog();
  };

  const openSettingsDialog = ({ title, label, value = '', textarea = false, placeholder = '', apply, cancel }) => {
    const modal = document.getElementById('tc-settings-modal');
    const input = document.getElementById('tc-settings-input');
    const area = document.getElementById('tc-settings-textarea');
    if (!modal || !input || !area) return false;
    dialogCtx = { apply, cancel };
    const titleEl = document.getElementById('tc-settings-title');
    if (titleEl) titleEl.textContent = title || '';
    const labelEl = document.getElementById('tc-settings-label');
    if (labelEl) {
      labelEl.textContent = label || '';
      labelEl.style.display = label ? '' : 'none';
    }
    const errEl = document.getElementById('tc-settings-error');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    // Однострочное поле или многострочное — второй элемент прячется
    input.style.display = textarea ? 'none' : '';
    area.style.display = textarea ? '' : 'none';
    input.value = textarea ? '' : value;
    area.value = textarea ? value : '';
    input.placeholder = placeholder;
    area.placeholder = placeholder;
    modal.classList.add('active');
    if (typeof (textarea ? area : input).focus === 'function') {
      (textarea ? area : input).focus();
    }
    return true;
  };

  const applySettingsDialog = () => {
    if (!dialogCtx) { hideSettingsDialog(); return; }
    const input = document.getElementById('tc-settings-input');
    const area = document.getElementById('tc-settings-textarea');
    const value = area && area.style.display !== 'none' ? area.value : (input ? input.value : '');
    const result = typeof dialogCtx.apply === 'function' ? dialogCtx.apply(value) : true;
    if (result === true) { hideSettingsDialog(); return; }
    const errEl = document.getElementById('tc-settings-error');
    if (errEl) {
      errEl.textContent = typeof result === 'string' ? result : 'Проверьте введённое значение';
      errEl.style.display = '';
    }
  };

  const bindSettingsDialog = () => {
    const modal = document.getElementById('tc-settings-modal');
    if (!modal || modal.dataset.dialogBound) return;
    modal.dataset.dialogBound = '1';
    const applyBtn = document.getElementById('tc-settings-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => applySettingsDialog());
    const cancelBtn = document.getElementById('tc-settings-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelSettingsDialog());
    // Enter/Escape при фокусе в поле; Escape работает и вне поля —
    // слушаем на window (document keydown занят меню «Reset chart»)
    const fieldKeydown = (e) => {
      if (e && e.key === 'Enter') { e.preventDefault(); applySettingsDialog(); }
      else if (e && e.key === 'Escape') cancelSettingsDialog();
    };
    for (const id of ['tc-settings-input', 'tc-settings-textarea']) {
      const field = document.getElementById(id);
      if (field) field.addEventListener('keydown', fieldKeydown);
    }
    window.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape' || !dialogCtx) return;
      const modalEl = document.getElementById('tc-settings-modal');
      if (modalEl && modalEl.classList.contains('active')) cancelSettingsDialog();
    });
    // Клик по фону (мимо карточки диалога) — отмена
    modal.addEventListener('click', (e) => {
      if (e && e.target === modal) cancelSettingsDialog();
    });
  };

  // ---- Разметка: сохранение/восстановление по тикеру (localStorage) ----

  const loadSavedOverlays = (ticker) => {
    try {
      const all = JSON.parse(localStorage.getItem(MARKUP_LS_KEY) || '{}');
      return Array.isArray(all[ticker]) ? all[ticker] : [];
    } catch (e) { return []; }
  };

  const saveOverlaysToStorage = (ticker, specs) => {
    try {
      const all = JSON.parse(localStorage.getItem(MARKUP_LS_KEY) || '{}');
      if (specs && specs.length) all[ticker] = specs; else delete all[ticker];
      localStorage.setItem(MARKUP_LS_KEY, JSON.stringify(all));
    } catch (e) { /* localStorage недоступен/переполнен — разметка не сохранится */ }
  };

  // Сериализация через публичный API: getOverlayStore в v9.6 — внутренний
  // метод ChartStore, наружу отданы createOverlay/getOverlayById/removeOverlay.
  // Собираем specs и заодно чистим overlayIds от уже удалённых объектов.
  const serializeOverlays = () => {
    if (!chartInstance) return [];
    const specs = [];
    overlayIds = overlayIds.filter(id => {
      const o = chartInstance.getOverlayById(id);
      if (!o) return false; // объект удалён (в т.ч. контекстным меню) — забываем id
      if (o.name === 'tc-measure') return true; // жив, но временнЫй — не сохраняем
      const points = (o.points || [])
        .filter(p => p && p.value != null && (p.timestamp != null || Number.isFinite(p.dataIndex)))
        .map(p => {
          // Обычная точка — по времени; точка за пределами данных —
          // синтезированное время + флаг f:1 (см. блок stageEventPoint)
          if (p.timestamp != null) return { timestamp: p.timestamp, value: p.value };
          const vts = synthVirtualTs(p) ?? p.vts ?? null;
          return vts == null ? null : { timestamp: vts, value: p.value, f: 1 };
        })
        .filter(Boolean);
      if (points.length) specs.push({ name: o.name, extendData: o.extendData ?? null, points });
      return true;
    });
    return specs;
  };

  const persistOverlays = () => {
    if (!lastTicker) return;
    saveOverlaysToStorage(lastTicker, serializeOverlays());
  };

  // Активный инструмент на вертикальной панели (иконка подсвечена синим,
  // как выбранный инструмент в TradingView). Снимается после построения
  // фигуры, её удаления или «Очистить».
  let activeToolBtn = null;
  const clearToolActive = () => {
    if (activeToolBtn) {
      activeToolBtn.classList.remove('active');
      activeToolBtn = null;
    }
  };
  const setToolActive = (btn) => {
    clearToolActive();
    if (btn) {
      btn.classList.add('active');
      activeToolBtn = btn;
    }
  };

  // Колбэки жизненного цикла overlay → автосохранение. onDrawEnd — фигура
  // достроена, onPressedMoveEnd — точку перетащили, onDeselected — сняли
  // выделение (страховка после правок), onRemoved — удаление любым способом
  // (контекстное меню по правому клику, «Очистить»). lastDrawEndAt — guard
  // сброса вида: двойной клик сразу после достройки фигуры (двухкликовые
  // инструменты) — часть рисования, а не «Reset chart».
  const overlayCallbacks = () => ({
    onDrawEnd: () => {
      lastDrawEndAt = Date.now();
      clearToolActive();
      persistOverlays();
    },
    onPressedMoveEnd: () => persistOverlays(),
    onDeselected: () => persistOverlays(),
    onRightClick: () => {
      // Правый клик попал по фигуре: библиотека на mousedown зовёт колбэк
      // и удаляет объект (или отменяет рисование), если колбэк вернул не
      // true. false — штатное удаление; момент запоминаем, чтобы следом
      // всплывшее contextmenu не открывало «Reset chart»
      lastOverlayRightClickAt = Date.now();
      return false;
    },
    onRemoved: (e) => {
      const id = e && e.overlay && e.overlay.id;
      if (id) overlayIds = overlayIds.filter(x => x !== id);
      clearToolActive();
      persistOverlays();
    },
  });

  const restoreOverlays = (ticker) => {
    let restored = 0;
    for (const s of loadSavedOverlays(ticker)) {
      if (!s || !s.name || !Array.isArray(s.points) || !s.points.length) continue;
      // Измеритель — временнЫй объект, в localStorage попадать не должен
      // (страховка на случай разметки из старых сборок)
      if (s.name === 'tc-measure') continue;
      // «Будущие» точки (f:1 — за последней свечой): timestampToDataIndex
      // в 9.6 зажимает к ближайшему бару, поэтому переводим время в
      // dataIndex сами — точка останется в правом поле графика
      const points = s.points.map(p => {
        if (!p || p.value == null || p.timestamp == null) return null;
        if (p.f === 1) {
          const list = chartInstance.getDataList();
          const interval = barIntervalMs();
          if (!list.length || !interval) return null;
          const last = list[list.length - 1];
          return {
            dataIndex: (list.length - 1)
              + Math.round((p.timestamp - last.timestamp) / interval),
            value: p.value,
          };
        }
        // points с timestamp/value рисуются сразу, без режима рисования:
        // Overlay.setPoints сам переводит timestamp в dataIndex
        return { timestamp: p.timestamp, value: p.value };
      }).filter(Boolean);
      if (!points.length) continue;
      const id = chartInstance.createOverlay({
        name: s.name,
        extendData: s.extendData ?? undefined,
        points,
        ...overlayCallbacks(),
      });
      if (id) { overlayIds.push(id); restored++; }
    }
    return restored;
  };

  // ---- Данные: маппинг свечей и поллинг ----

  // ISS: begin "2026-11-05 06:00:00" (время Мосбиржи). Парсим как есть
  // в локальном времени — для тестового графика этого достаточно.
  // Binance: begin "2026-11-05T00:00:00Z" (UTC с 'Z') — Date() парсит
  // такую строку как UTC, что даёт корректные метки времени.
  const toKline = (c) => ({
    timestamp: new Date(String(c.begin).replace(' ', 'T')).getTime(),
    open: c.open, high: c.high, low: c.low, close: c.close,
    volume: c.volume || 0,
    turnover: c.value || 0,
  });

  const stopPolling = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pollKey = null;
  };

  const sourceNote = (ticker) => isBinanceTicker(ticker)
    ? 'данные Binance (реальное время)'
    : 'данные ISS с задержкой ~15 мин';

  // ---- Шапка символа и легенда OHLCV (облик TradingView) ----
  // Шапка над графиком: код · имя (name из candles-ответа бэкенда) · ТФ +
  // крупная последняя цена с цветной дельтой к предыдущей свече. Легенда
  // поверх холста показывает O/H/L/C/Vol свечи под курсором (crosshair),
  // без курсора — последнюю. Значения окрашены по направлению свечи.

  const TF_LABELS = { 60: '1ч', 24: '1д', 7: '1н', 31: '1М' };

  // Точность инструмента — как в TradingView, определяется автоматически по
  // данным: максимум десятичных знаков среди цен загруженных свечей
  // (BINANCE:SHIBUSDT ~0.0000154 → 7 знаков, SBER → 2). Одна переменная
  // кормит и шапку/легенду (fmtNum), и сам график — setPrecision({price})
  // меняет ось цены, метки max/min свечи и подписи фигур.
  let pricePrecision = 2;
  // Тики мельче 1e-10 у биржевых инструментов не встречаются
  const PRICE_PRECISION_CAP = 10;

  const fmtNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n)
      ? n.toLocaleString('en-US', { minimumFractionDigits: pricePrecision, maximumFractionDigits: pricePrecision })
      : '—';
  };

  const fmtVol = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
    return String(n);
  };

  // Десятичные разряды числа: «315.55» → 2; малые числа библиотека печатает
  // экспонентой («1.54e-7» → 7 порядков + 2 разряда мантиссы = 9)
  const countDecimals = (n) => {
    const s = String(Math.abs(n));
    if (s.includes('e-')) {
      const [mantissa, exp] = s.split('e-');
      const mantissaDecimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
      return Number(exp) + mantissaDecimals;
    }
    return s.includes('.') ? s.split('.')[1].length : 0;
  };

  // Пересчёт точности под свежие данные. setPrecision перестраивает график
  // целиком — зовём только при смене значения (в 9.6 аргумент — {price,
  // volume}, ось цены свечной панели и метки max/min читают .price).
  const applyPricePrecision = (list) => {
    if (!chartInstance || !list || !list.length) return;
    let max = 0;
    for (const k of list) {
      for (const v of [k.open, k.high, k.low, k.close]) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          const d = countDecimals(n);
          if (d > max) max = d;
        }
      }
    }
    // Пол 2 знаков: у большинства инструментов источник и так отдаёт 2+,
    // а инструменты с целочисленным тиком получают прежний вид «308.00»
    const p = Math.min(Math.max(max, 2), PRICE_PRECISION_CAP);
    if (p === pricePrecision) return;
    pricePrecision = p;
    try { chartInstance.setPrecision({ price: pricePrecision, volume: 0 }); } catch (e) {}
  };

  // Тикер для шапки: без технического префикса источника (BINANCE:BTCUSDT → BTCUSDT)
  const displayTicker = (ticker) =>
    isBinanceTicker(ticker) ? ticker.replace('BINANCE:', '') : ticker;

  // Код/ТФ показываем сразу (ещё до ответа бэкенда), цену — прочерком
  const setHeaderSymbol = (ticker, interval) => {
    const code = document.getElementById('tc-sym-code');
    if (!code) return;
    code.textContent = displayTicker(ticker);
    const name = document.getElementById('tc-sym-name');
    if (name) { name.textContent = ''; name.style.display = 'none'; }
    const tf = document.getElementById('tc-sym-tf');
    if (tf) tf.textContent = TF_LABELS[interval] || '';
    const price = document.getElementById('tc-sym-price');
    if (price) price.textContent = '—';
    const change = document.getElementById('tc-sym-change');
    if (change) { change.textContent = ''; change.classList.remove('up', 'down'); }
  };

  // Имя инструмента из candles-ответа (две строки на бэкенде): «Сбербанк»,
  // «Bitcoin»; нет имени (источник не отдал) — span скрывается вместе с «·»
  const applySymbolName = (data) => {
    const name = data && data.name ? String(data.name) : '';
    const nameEl = document.getElementById('tc-sym-name');
    if (!nameEl) return;
    nameEl.textContent = name;
    nameEl.style.display = name ? '' : 'none';
  };

  // Цена + дельта к предыдущей свече: «+10.00 (+3.25%)» зелёным/красным
  const updateSymbolQuote = (list) => {
    const priceEl = document.getElementById('tc-sym-price');
    const changeEl = document.getElementById('tc-sym-change');
    if (!priceEl || !list || !list.length) return;
    const last = list[list.length - 1];
    priceEl.textContent = fmtNum(last.close);
    if (!changeEl) return;
    const prev = list.length > 1 ? list[list.length - 2] : null;
    if (!prev || !Number.isFinite(prev.close) || !prev.close) {
      changeEl.textContent = '';
      changeEl.classList.remove('up', 'down');
      return;
    }
    const delta = last.close - prev.close;
    const pct = (delta / prev.close) * 100;
    const up = delta >= 0;
    const sign = up ? '+' : '';
    changeEl.textContent = `${sign}${delta.toFixed(pricePrecision)} (${sign}${pct.toFixed(2)}%)`;
    changeEl.classList.toggle('up', up);
    changeEl.classList.toggle('down', !up);
  };

  const renderLegend = (k) => {
    const root = document.getElementById('tc-legend');
    if (!root || !k) return;
    const up = k.close >= k.open;
    root.classList.toggle('up', up);
    root.classList.toggle('down', !up);
    const vals = {
      'tc-leg-o': fmtNum(k.open),
      'tc-leg-h': fmtNum(k.high),
      'tc-leg-l': fmtNum(k.low),
      'tc-leg-c': fmtNum(k.close),
      'tc-leg-v': fmtVol(k.volume),
    };
    for (const [id, text] of Object.entries(vals)) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }
  };

  // Метка объёма на оси цены (как в TradingView): тег со значением столбика
  // под курсором. Позиция по вертикали — верх столбика на гистограммной
  // шкале (нижние 20% панели), геометрия — из последнего draw индикатора
  // (canvas оси у KLineChart отдельный, нарисовать туда из draw нельзя).
  // show=false (курсор ушёл/индикатор выключен/объёма нет) — тег прячется.
  const renderVolumeAxisLabel = (k, show) => {
    const el = document.getElementById('tc-vol-axis');
    if (!el) return;
    const vol = Number(k && k.volume);
    const on = !!(show && volScale && indicators.has(VOL_MAIN)
      && Number.isFinite(vol) && vol > 0);
    const up = on && k.close >= k.open;
    el.classList.toggle('show', on);
    el.classList.toggle('up', up);
    el.classList.toggle('down', on && !up);
    if (!on) { el.textContent = ''; return; }
    el.textContent = fmtVol(vol);
    el.style.top = `${Math.round(volScale.top + volScale.height - vol * volScale.unitPx)}px`;
  };

  // Легенда + цена из текущих данных графика (последняя свеча). Заодно
  // пересчитываем точность инструмента (шкала могла уйти с новыми данными)
  // и точность осей под-окон — шкалы сдвинулись с новыми данными
  const refreshChartReadouts = () => {
    if (!chartInstance) return;
    const list = chartInstance.getDataList();
    applyPricePrecision(list);
    renderLegend(list.length ? list[list.length - 1] : null);
    updateSymbolQuote(list);
    for (const name of indicators.keys()) tuneSubPaneAxisPrecision(name);
  };

  const pollOnce = async (ticker, interval) => {
    if (!chartInstance || lastTs == null) return;
    try {
      // from = дата последней свечи в локальном времени: бэкенд перекачает
      // её (свеча ещё формируется) и всё, что новее. Чужой пояс даёт
      // смещение на день — безвредно, лишняя свеча отфильтруется ниже.
      const from = fmtDay(new Date(lastTs));
      const url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}`
        + `?interval=${interval}&from=${from}`;
      const response = await window.fetchWithTimeout(url, {}, 30000);
      const data = await response.json();
      if (data.error || !data.candles || !data.candles.length) return;

      let changed = 0;
      for (const c of data.candles) {
        const k = toKline(c);
        if (Number.isNaN(k.timestamp) || k.timestamp < lastTs) continue;
        // timestamp последней свечи — updateData её обновит (свеча тикает),
        // больший — допишет новую
        chartInstance.updateData(k);
        changed++;
        if (k.timestamp > lastTs) lastTs = k.timestamp;
      }
      if (changed) {
        const time = new Date().toLocaleTimeString('ru-RU');
        setStatus(`График ${ticker} · свечей: ${chartInstance.getDataList().length} · `
          + `${sourceNote(ticker)} · обновлено ${time}`);
        // Последняя свеча тикнула — обновить цену в шапке и легенду
        refreshChartReadouts();
      }
    } catch (e) {
      // сетевые сбои поллинга не тревожат статус, но в консоль попадают —
      // молчаливое проглатывание прячет реальные ошибки
      console.debug('Поллинг свечей не удался:', e);
    }
  };

  const startPolling = (ticker, interval) => {
    stopPolling();
    const key = `${ticker}|${interval}`;
    pollKey = key;
    const period = isBinanceTicker(ticker) ? POLL_MS.binance : POLL_MS.moex;
    pollTimer = setInterval(() => {
      // Данные сменились (ввели другой тикер/ТФ) — этот таймер больше не нужен
      if (pollKey !== key) { stopPolling(); return; }
      // Пропускаем тик, пока раздел или вкладка не видны — гасим фоновую нагрузку
      const el = document.getElementById('test-chart-kline');
      if (document.hidden || !el || el.offsetParent === null) return;
      pollOnce(ticker, interval);
    }, period);
  };

  // ---- Догрузка истории при скролле влево (как в TradingView) ----
  // loadMore срабатывает, когда левый край видимой области дошёл до первой
  // свечи: получаем timestamp самой старой свечи на графике, запрашиваем у
  // бэкенда срез СТАРШЕ неё (?slice=1&from=1900-01-01&till=дата_олdest-1) и
  // prepend-им через applyMoreData. from далеко в прошлом обязателен: без
  // него бэкенд подставил бы дату последней свечи (from > till → пусто).
  // Ответ без «сарых» свечей — история источника исчерпана: more=false,
  // доборка отключается. Сбой сети снимает _loading повторным пустым
  // applyMoreData с задержкой — без этого loadMore заблокирован навсегда.

  let loadMoreKey = null; // 'TICKER|interval' на момент запроса — ответ после смены данных отбрасывается

  const loadMoreHistory = async (oldestTs) => {
    if (!chartInstance || lastTicker == null || oldestTs == null) return;
    const ticker = lastTicker;
    const interval = currentInterval;
    const key = `${ticker}|${interval}`;
    loadMoreKey = key;

    const tillDate = new Date(oldestTs - 86400000); // сутки назад от старшей свечи
    const url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}`
      + `?interval=${interval}&from=1900-01-01&till=${fmtDay(tillDate)}&slice=1`;

    try {
      const response = await window.fetchWithTimeout(url, {}, 60000);
      const data = await response.json();
      // За время запроса тикер/ТФ сменили — данные уже не к этому графику
      if (loadMoreKey !== key || lastTicker !== ticker) return;
      if (data.error) {
        chartInstance.applyMoreData([], false); // источник не отдал историю — отключаем доборку
        setStatus(`⚠ История старше не подгрузилась: ${data.error}`, false, true);
        return;
      }
      const older = (data.candles || []).map(toKline)
        .filter(k => !Number.isNaN(k.timestamp) && k.timestamp < oldestTs)
        .sort((a, b) => a.timestamp - b.timestamp);
      // hasMore: если источник что-то вернул — вероятно, есть и ещё старше
      chartInstance.applyMoreData(older, older.length > 0);
      if (older.length) {
        setStatus(`График ${ticker} · свечей: ${chartInstance.getDataList().length} · `
          + `${sourceNote(ticker)} · +${older.length} свечей истории`);
      }
    } catch (e) {
      // Разблокируем повторную попытку с задержкой (см. комментарий выше)
      setTimeout(() => {
        if (chartInstance && loadMoreKey === key) chartInstance.applyMoreData([], true);
      }, 3000);
      console.debug('Догрузка истории не удалась:', e);
    }
  };

  window.loadTestChartCandles = async function () {
    const input = document.getElementById('test-chart-ticker-input');
    const ticker = normalizeTicker(input && input.value);
    if (!ticker) {
      setStatus('Введите тикер: акция (SBER) или крипто-пара (BINANCE:BTCUSDT)', true);
      return;
    }
    const interval = currentInterval;

    const instance = getChartInstance();
    if (!instance) return;

    setStatus(`Загрузка свечей ${ticker}…`);

    try {
      // Оконная загрузка: последний экран истории (~600 баров) через
      // ?slice=1 — бэкенд возвращает только срез источника, без всего
      // хранилища. Старые экраны дозагрузит loadMore при скролле влево.
      const lookback = TF_LOOKBACK_DAYS[interval] || 600;
      const from = fmtDay(new Date(Date.now() - lookback * 86400000));
      let url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}`
        + `?interval=${interval}&from=${from}&slice=1`;
      let response = await window.fetchWithTimeout(url, {}, 60000);
      let data = await response.json();

      // Срез пуст или источник сбойнул — фолбэк на полный запрос через
      // накопленное хранилище (бэкенд сам отдаст историю с note о деградации)
      if (data.error || !data.candles || !data.candles.length) {
        url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}?interval=${interval}`;
        response = await window.fetchWithTimeout(url, {}, 60000);
        data = await response.json();
      }

      if (data.error) {
        setStatus(`Ошибка: ${data.error}`, true);
        return;
      }
      if (!data.candles || !data.candles.length) {
        setStatus(`Для тикера ${ticker} свечи не найдены`, true);
        return;
      }

      // Шапка символа: код/ТФ и имя инструмента (name из candles-ответа)
      setHeaderSymbol(ticker, interval);
      applySymbolName(data);

      const klineData = data.candles.map(toKline)
        .filter(c => !Number.isNaN(c.timestamp))
        // KLineChart требует возрастающих меток времени
        .sort((a, b) => a.timestamp - b.timestamp);

      // Смена тикера: сохранить разметку старого и снять объекты перед
      // новыми данными (applyNewData их не удаляет — они «переехали» бы на
      // чужой график; смену ТФ в пределах тикера разметка переживает —
      // точки привязаны к времени, как рисунки в TradingView). lastTicker
      // сбрасываем ДО removeOverlay: сработавшие при удалении onRemoved
      // не должны перезаписать только что сохранённое.
      const symbolChanged = lastTicker !== ticker;
      if (lastTicker && symbolChanged) {
        saveOverlaysToStorage(lastTicker, serializeOverlays());
        lastTicker = null;
        instance.removeOverlay();
        overlayIds = [];
        // press-drag объекты (измеритель) тоже ушли с холста — забываем id
        measureLiveId = null;
        stageToolOverlayId = null;
      }

      // Вид графика (масштаб + сдвиг) не должен прыгать при смене данных
      const vp = saveViewport();
      instance.applyNewData(klineData, true);
      lastTs = klineData.length ? klineData[klineData.length - 1].timestamp : null;
      lastTicker = ticker;
      restoreViewport(vp);
      // Смена тикера/ТФ: вертикальную шкалу вернём к автоподгонке — новые
      // цены могли не попасть в зажатый ручной масштаб (в TradingView при
      // смене символа шкала тоже подгоняется заново)
      if (!isAutoScaleOn()) applyScaleMode();
      // Геометрия гистограммы устарела до первого перерисовывания draw —
      // метку на оси прячем (вернётся при движении курсора)
      renderVolumeAxisLabel(null, false);
      // Шапка (цена/дельта) и легенда — по свежим данным
      refreshChartReadouts();

      // Доборка старых экранов при скролле влево (переввод callback — идемпотентно)
      instance.loadMore((oldestTs) => loadMoreHistory(oldestTs));

      // Последний график — для автозагрузки при следующем открытии страницы
      try { localStorage.setItem(LAST_LS_KEY, JSON.stringify({ ticker, interval })); } catch (e) {}

      const restored = symbolChanged ? restoreOverlays(ticker) : 0;
      startPolling(ticker, interval);

      const liveNote = isBinanceTicker(ticker)
        ? `автообновление каждые ${POLL_MS.binance / 1000} с`
        : `автообновление каждые ${POLL_MS.moex / 1000} с`;
      // note бэкенда — деградация: источник недоступен, отдаём накопленную
      // историю (может быть устаревшей). Показываем предупреждением.
      const base = `График ${ticker} · свечей: ${klineData.length} · ${sourceNote(ticker)} · ${liveNote}`;
      if (data.note) setStatus(`⚠ ${data.note} — ${base}`, false, true);
      else setStatus(restored ? `${base} · разметка восстановлена: ${restored}` : base);
    } catch (e) {
      setStatus(`Не удалось загрузить свечи: ${e.message || e}`, true);
    }
  };

  // ---- Таймфреймы: сегмент 1ч/1д/1н/1М вместо select ----

  const syncTfButtons = () => {
    for (const tf of ['60', '24', '7', '31']) {
      const btn = document.getElementById(`tc-tf-${tf}`);
      if (btn) btn.classList.toggle('active', String(currentInterval) === tf);
    }
  };

  window.tcSetInterval = function (tf) {
    const value = parseInt(tf, 10);
    if (![60, 24, 7, 31].includes(value)) return;
    currentInterval = value;
    syncTfButtons();
    // ТФ в шапке символа обновляем сразу, не дожидаясь перезагрузки
    const tfEl = document.getElementById('tc-sym-tf');
    if (tfEl) tfEl.textContent = TF_LABELS[value] || '';
    // Как в TradingView: клик по ТФ сразу перезагружает график выбранного тикера
    if (lastTicker) window.loadTestChartCandles();
    else setStatus(`Таймфрейм: ${document.getElementById(`tc-tf-${value}`)?.textContent || value}`);
  };

  // ---- Кисть и измеритель: press-drag захват на холсте (как в TV) ----
  // KLineChart строит фигуры по кликам и промежуточных точек пути не
  // даёт, поэтому для кисти и измерителя захват ведём сами: mousedown
  // перехватывается на .tc-chart-stage в фазе CAPTURE (stopPropagation
  // не даёт библиотеке начать прокрутку графика), mousemove/mouseup —
  // на window, чтобы рисование не срывалось при выходе курсора за край.
  // Объект создаётся сразу с ДВУМЯ совпадающими точками: он валиден
  // (points.length >= totalStep - 1 → не «progress»-режим) и рисует
  // прямоугольник нулевого размера, который дальше растягивается
  // мутацией живого инстанса (getOverlayById + updatePane).

  let armedStageTool = null;    // 'tc-brush' | 'tc-measure' — ожидает нажатия
  let stageToolDrawing = false; // идёт press-drag захват
  let stageToolOverlayId = null;
  let measureLiveId = null;     // построенный измеритель — убирается следующим кликом
  let lastCaptureXY = null;     // последняя точка кисти в px контейнера

  const STAGE_TOOL_HINTS = {
    'tc-brush': 'Кисть: зажмите кнопку мыши, нарисуйте линию и отпустите',
    'tc-measure': 'Измеритель: зажмите кнопку мыши, растяните область и отпустите; клик по графику уберёт измерение',
  };

  // ---- Точки за пределами данных (правое поле за последней свечой) ----
  // convertFromPixel за границами загруженных свечей отдаёт только
  // dataIndex (timestamp = null): рендер KLineChart для таких точек
  // использует dataIndex, а timestamp при рендере зажался бы к последнему
  // бару (timestampToDataIndex → binarySearchNearest). Поэтому живая
  // точка хранит dataIndex + синтезированное время vts (последняя свеча +
  // (dataIndex - lastIndex) * интервал ТФ), сериализация пишет vts с
  // флагом f:1, восстановление переводит время обратно в dataIndex.

  const barIntervalMs = () => {
    const list = chartInstance && chartInstance.getDataList ? chartInstance.getDataList() : [];
    return list.length > 1
      ? Math.max(1, list[list.length - 1].timestamp - list[list.length - 2].timestamp)
      : null;
  };

  const synthVirtualTs = (p) => {
    const list = chartInstance && chartInstance.getDataList ? chartInstance.getDataList() : [];
    const interval = barIntervalMs();
    if (!list.length || !interval || !Number.isFinite(p.dataIndex)) return null;
    const last = list[list.length - 1];
    return Math.round(last.timestamp + (p.dataIndex - (list.length - 1)) * interval);
  };

  // Экранное событие → точка графика (timestamp/value) + координаты в
  // системе контейнера. absolute: true — в convertFromPixel y считается
  // от верха контейнера графика (панель у KLineChart со своим offset).
  const stageEventPoint = (e) => {
    if (!chartInstance) return null;
    const dom = typeof chartInstance.getDom === 'function' ? chartInstance.getDom()
      : document.getElementById('test-chart-kline');
    const rect = dom && typeof dom.getBoundingClientRect === 'function'
      ? dom.getBoundingClientRect() : null;
    if (!rect || typeof chartInstance.convertFromPixel !== 'function' || e.clientX == null) return null;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pts = chartInstance.convertFromPixel([{ x, y }], { paneId: 'candle_pane', absolute: true });
    const p = Array.isArray(pts) ? pts[0] : pts;
    if (!p || !Number.isFinite(p.value) || !Number.isFinite(p.dataIndex)) return null;
    const point = { value: p.value };
    if (p.timestamp != null && Number.isFinite(p.timestamp)) {
      point.timestamp = p.timestamp;
    } else {
      // Правое поле за последней свечой (или до первой): индекс +
      // синтезированное время для длительности измерителя и сериализации
      point.dataIndex = p.dataIndex;
      const vts = synthVirtualTs(p);
      if (vts == null) return null;
      point.vts = vts;
    }
    return { point, x, y };
  };

  const removeStageOverlay = (id) => {
    if (!chartInstance || id == null) return;
    // onRemoved в overlayCallbacks сам вычистит overlayIds и сохранит разметку
    chartInstance.removeOverlay(id);
  };

  const removeLiveMeasure = () => {
    if (measureLiveId == null) return;
    removeStageOverlay(measureLiveId);
    measureLiveId = null;
  };

  const disarmStageTool = () => {
    armedStageTool = null;
    clearToolActive();
  };

  // Перерисовать панель с overlay после мутации точек. UpdateLevel.Overlay
  // в 9.6.0 = 1 (числом: enum наружу не отдаётся).
  const redrawOverlayPane = () => {
    if (chartInstance && typeof chartInstance.updatePane === 'function') {
      chartInstance.updatePane(1);
    }
  };

  const onStageMouseDown = (e) => {
    // Измеритель построен и инструмент не активен — клик его убирает
    // (поведение TradingView), остальное событие пропускаем дальше.
    if (!armedStageTool && measureLiveId != null) {
      removeLiveMeasure();
      return;
    }
    if (!armedStageTool || stageToolDrawing || !chartInstance) return;
    if (e.button !== undefined && e.button !== 0) return; // только ЛКМ
    const hit = stageEventPoint(e);
    if (!hit) return; // вне данных (нет свечей/вне оси) — ведём себя как обычно
    // Не даём KLineChart начать прокрутку/перетаскивание холста
    e.preventDefault();
    e.stopPropagation();
    const name = armedStageTool;
    const id = chartInstance.createOverlay({
      name,
      points: [hit.point, hit.point],
      ...overlayCallbacks(),
    });
    if (!id) { disarmStageTool(); return; }
    overlayIds.push(id);
    if (name === 'tc-measure') measureLiveId = id;
    stageToolOverlayId = id;
    stageToolDrawing = true;
    lastCaptureXY = { x: hit.x, y: hit.y };
  };

  const onStageMouseMove = (e) => {
    if (!stageToolDrawing || !stageToolOverlayId || !chartInstance) return;
    const ov = chartInstance.getOverlayById(stageToolOverlayId);
    if (!ov) return;
    const hit = stageEventPoint(e);
    if (!hit) return;
    if (armedStageTool === 'tc-brush') {
      // Пишем точку не чаще, чем раз в BRUSH_MIN_STEP_PX — иначе
      // массив points в localStorage распухает на каждый пиксель
      const dx = hit.x - lastCaptureXY.x, dy = hit.y - lastCaptureXY.y;
      if (dx * dx + dy * dy < BRUSH_MIN_STEP_PX * BRUSH_MIN_STEP_PX) return;
      lastCaptureXY = { x: hit.x, y: hit.y };
      ov.points.push(hit.point);
    } else {
      // Измеритель: вторая точка следует за курсором
      if (ov.points.length < 2) ov.points.push(hit.point);
      else ov.points[1] = hit.point;
    }
    redrawOverlayPane();
  };

  const onStageMouseUp = () => {
    // Перетаскивание шкалы цены снимает автоподгонку оси (ручной масштаб)
    // — актуализируем кнопку «авто» на каждом отпускании кнопки мыши
    syncScaleButtons();
    if (!stageToolDrawing) return;
    stageToolDrawing = false;
    const id = stageToolOverlayId;
    stageToolOverlayId = null;
    lastCaptureXY = null;
    const name = armedStageTool;
    disarmStageTool();
    const ov = id != null && chartInstance ? chartInstance.getOverlayById(id) : null;
    if (!ov) return;
    // Объект создан с двумя совпадающими точками: «движения не было» =
    // у кисти не появилась третья точка, у измерителя точки не разошлись
    // (за последней свечой у точек нет timestamp — сравниваем dataIndex)
    const [pt0, pt1] = ov.points || [];
    const stretched = !!(pt0 && pt1
      && (pt0.timestamp !== pt1.timestamp || pt0.dataIndex !== pt1.dataIndex
        || pt0.value !== pt1.value));
    if (name === 'tc-brush' && (!ov.points || ov.points.length < 3)) {
      // Клик без движения — рисовать нечего
      removeStageOverlay(id);
      setStatus('Кисть: зажмите кнопку мыши и ведите курсор по графику');
    } else if (name === 'tc-brush') {
      // Готовый путь кисти — постоянная разметка, сохраняем по тикеру
      persistOverlays();
    } else if (name === 'tc-measure' && !stretched) {
      measureLiveId = null;
      removeStageOverlay(id);
      setStatus('Измеритель: зажмите кнопку мыши и растяните область');
    } else if (name === 'tc-measure') {
      setStatus('Измерение готово — клик по графику уберёт его');
    }
  };

  // ---- Догоняющий клик: фигура фиксируется последним кликом (как в TV) ----
  // KLineChart 9.6 строит фигуры по кликам, но SyntheticEvent держит окно
  // двойного клика (~500 мс): второй mouseup в этом окне дальше ~5 px от
  // первого не диспетчеризуется вовсе — ни click, ни dblclick. Быстрый
  // последний клик фигуры пропадает, рисование «застревает» и кажется,
  // что нужен лишний клик мимо. Догоняем сами: после отпускания кнопки
  // (клик = нажатие и отжатие ближе ~6 px, не drag) ждём мгновение и
  // смотрим, дошла ли точка до рисования; если нет — ставим её этим же
  // кликом и завершаем фигуру штатными шагами библиотеки.

  // Максимальное смещение нажатия→отжатия, при котором это клик (px)
  const STAGE_CLICK_MAX_DRAG_PX = 6;
  // Задержка проверки: обработка mouseup у библиотеки синхронная, к этому
  // моменту её решение (принять клик / проглотить) уже принято
  const STAGE_CLICK_SETTLE_MS = 60;
  // Шаг рисования с флагом «рисование окончено» в Overlay 9.6
  const OVERLAY_DRAW_STEP_FINISHED = -1;

  let stageClickDownXY = null; // координаты нажатой кнопки — отсекаем drag

  const overlayStoreApi = () => {
    try {
      const store = typeof chartInstance.getChartStore === 'function'
        ? chartInstance.getChartStore() : null;
      return store && typeof store.getOverlayStore === 'function'
        ? store.getOverlayStore() : null;
    } catch (e) { return null; }
  };

  // Активное рисование (progress-режим): { paneId, instance } или null
  const progressDrawingInfo = () => {
    const store = overlayStoreApi();
    const info = store && typeof store.getProgressInstanceInfo === 'function'
      ? store.getProgressInstanceInfo() : null;
    const ov = info && info.instance;
    return ov && typeof ov.isDrawing === 'function' && ov.isDrawing() ? info : null;
  };

  // Панель графика под вертикальной координатой: клик в под-окно
  // индикатора или ось времени последней точкой фигуры быть не может
  const paneIdAtY = (y) => {
    try {
      for (const p of (chartInstance._drawPanes || [])) {
        const b = p._bounding;
        const id = typeof p.getId === 'function' ? p.getId() : p._id;
        if (b && id && y >= b.top && y <= b.top + b.height) return id;
      }
    } catch (e) { /* геометрия панелей недоступна */ }
    return null;
  };

  // Поставить точку в недостроенную фигуру и продвинуть шаг рисования —
  // ровно то, что делает библиотека в своём обработчике клика
  // (eventMoveForDrawing → performEventMoveForDrawing → nextStep)
  const feedDrawingPoint = (info, srcPoint) => {
    const store = overlayStoreApi();
    const ov = info.instance;
    const point = {};
    if (srcPoint.timestamp !== undefined) point.timestamp = srcPoint.timestamp;
    if (srcPoint.dataIndex !== undefined) point.dataIndex = srcPoint.dataIndex;
    if (srcPoint.value !== undefined) point.value = srcPoint.value;
    // Первый клик вообще: назначаем панель, как делает библиотека
    if (typeof ov.isStart === 'function' && ov.isStart()
      && store && typeof store.updateProgressInstanceInfo === 'function'
      && info.paneId != null) {
      store.updateProgressInstanceInfo(info.paneId, true);
    }
    ov.points[ov.currentStep - 1] = point;
    if (typeof ov.performEventMoveForDrawing === 'function') {
      ov.performEventMoveForDrawing({
        currentStep: ov.currentStep,
        mode: ov.mode,
        points: ov.points,
        performPointIndex: ov.currentStep - 1,
        performPoint: point,
      });
    }
    if (ov.currentStep === ov.totalStep - 1) ov.currentStep = OVERLAY_DRAW_STEP_FINISHED;
    else ov.currentStep += 1;
    if (!ov.isDrawing()) {
      // Фигура достроена: переводим из progress-режима в готовые объекты,
      // onDrawEnd снимет подсветку инструмента и сохранит разметку
      if (store && typeof store.progressInstanceComplete === 'function') {
        store.progressInstanceComplete();
      }
      if (typeof ov.onDrawEnd === 'function') ov.onDrawEnd({ overlay: ov });
      // Панель перерисовываем сами: в штатном потоке библиотеки это делает
      // обработчик клика, который у проглоченного клика не вызывался
      redrawOverlayPane();
    }
  };

  // Клик «пропал»: если шаг рисования не изменился с момента отжатия —
  // это проглоченное окно dblclick (библиотека, приняв клик, продвигает
  // currentStep), ставим точку сами. Длину points не проверяем: слот
  // последней точки уже занят превью от mousemove, длина всегда
  // totalStep - 1, тогда как currentStep честно отличает проглоченный
  // клик от принятого.
  const completeSwallowedDrawingClick = (stepBefore, hit) => {
    if (!chartInstance || !hit || stepBefore == null
      || stepBefore === OVERLAY_DRAW_STEP_FINISHED) return;
    const info = progressDrawingInfo();
    if (!info) return;
    const ov = info.instance;
    if (ov.currentStep !== stepBefore) return; // клик дошёл — шаг продвинут
    if (paneIdAtY(hit.y) !== info.paneId) return;
    feedDrawingPoint(info, hit.point);
    redrawOverlayPane();
  };

  const onStageClickDown = (e) => {
    stageClickDownXY = e && (e.button === undefined || e.button === 0)
      ? { x: e.clientX, y: e.clientY }
      : null;
  };

  const onStageClickUp = (e) => {
    const down = stageClickDownXY;
    stageClickDownXY = null;
    if (!down || !e || (e.button !== undefined && e.button !== 0)) return;
    // Перетаскивание (прокрутка холста, двигание точки фигуры) — не клик
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (dx * dx + dy * dy > STAGE_CLICK_MAX_DRAG_PX * STAGE_CLICK_MAX_DRAG_PX) return;
    // Press-drag кисти/измерителя живёт своей жизнью (см. блок выше)
    if (armedStageTool || stageToolDrawing) return;
    const info = progressDrawingInfo();
    if (!info) return;
    const stepBefore = info.instance.currentStep;
    const hit = stageEventPoint(e);
    setTimeout(() => completeSwallowedDrawingClick(stepBefore, hit), STAGE_CLICK_SETTLE_MS);
  };

  const bindStageTools = () => {
    const stage = document.getElementById('tc-chart-stage');
    if (!stage || stage.dataset.stageToolsBound) return;
    stage.dataset.stageToolsBound = '1';
    stage.addEventListener('mousedown', onStageMouseDown, true);
    window.addEventListener('mousemove', onStageMouseMove);
    window.addEventListener('mouseup', onStageMouseUp);
    // Клик по холсту (capture): координаты нажатия/отжатия для догоняющего
    // клика — figура фиксируется последним кликом без лишнего «мимо»
    stage.addEventListener('mousedown', onStageClickDown, true);
    stage.addEventListener('mouseup', onStageClickUp, true);
  };


  // ---- Панель разметки: рисование нативных overlay-объектов KLineChart ----
  // Клик по иконке на вертикальной панели включает инструмент: следующий
  // клик(и) по графику ставят точки фигуры. Правый клик по готовой фигуре
  // удаляет её (стандартное поведение KLineChart). Кисть и измеритель —
  // через press-drag захват (см. блок выше).
  window.tcDrawOverlay = function (name, btn) {
    const instance = getChartInstance();
    if (!instance) return;
    // Переключение инструмента снимает активный press-drag захват:
    // иначе mousedown после выбора другого инструмента рисовал бы кисть
    armedStageTool = null;
    // Кисти и измерителю нужны данные: точки привязываются к времени
    if (name === 'tc-brush' || name === 'tc-measure') {
      const hasData = typeof instance.getDataList !== 'function' || instance.getDataList().length > 0;
      if (!hasData) {
        setStatus('Сначала загрузите график — инструменту нужны свечи', true);
        return;
      }
      setToolActive(btn);
      // Активация инструмента убирает «висящее» измерение (как в TV),
      // чтобы старый прямоугольник не остался на графике навсегда
      removeLiveMeasure();
      armedStageTool = name;
      setStatus(STAGE_TOOL_HINTS[name]);
      return;
    }
    // Подсветка активного инструмента — как выбранная иконка в TradingView
    setToolActive(btn);
    if (name === 'text') {
      // Текст заметки вводится в модальном диалоге (окно настроек в духе
      // TradingView), не в window.prompt — тот выглядит чужеродно и
      // блокирует вкладку
      const opened = openSettingsDialog({
        title: 'Заметка на графике',
        label: 'Текст заметки',
        textarea: true,
        placeholder: 'Например: цель 320 ₽',
        apply: (text) => {
          const t = String(text || '').trim();
          if (!t) return 'Введите текст заметки';
          // В 9.6 нет шаблона «text» — используем встроенную аннотацию
          // simpleAnnotation: содержимое берётся из extendData (строка)
          const id = instance.createOverlay({
            name: 'simpleAnnotation', extendData: t, ...overlayCallbacks(),
          });
          if (id) overlayIds.push(id);
          setStatus('Кликните по свече — текст привяжется к её цене');
          return true;
        },
        // Отмена/Escape — снять активный инструмент: рисовать без текста
        // нечего (после успешного ввода подсветку снимет onDrawEnd)
        cancel: () => clearToolActive(),
      });
      if (!opened) clearToolActive();
      return;
    }
    const hints = {
      segment: 'Кликните по графику 2 раза — начало и конец отрезка',
      horizontalRayLine: 'Кликните по графику — уровень поставится на эту цену',
      horizontalStraightLine: 'Кликните по графику — линия пройдёт по всей ширине на этой цене',
      verticalStraightLine: 'Кликните по графику — линия пройдёт по всей высоте на этом времени',
      'tc-rect': 'Кликните по графику 2 раза — противоположные углы прямоугольника',
      'tc-arrow': 'Кликните по графику 2 раза — стрелка от начала к концу',
      priceChannelLine: 'Кликните по графику 3 раза — две точки задают границу канала, третья — его ширину',
      fibonacciLine: 'Кликните по графику 2 раза — уровни 0.236…∞ между ценами',
    };
    const id = instance.createOverlay({ name, ...overlayCallbacks() });
    if (id) overlayIds.push(id);
    setStatus(hints[name] || 'Кликните по графику, чтобы поставить фигуру');
  };

  window.tcClearOverlays = function () {
    if (!chartInstance) return;
    // Снимаем активный инструмент press-drag захвата (если был)
    armedStageTool = null;
    stageToolDrawing = false;
    stageToolOverlayId = null;
    measureLiveId = null;
    chartInstance.removeOverlay();
    overlayIds = [];
    clearToolActive();
    persistOverlays();
    setStatus('Разметка удалена');
  };

  // ---- Индикаторы: dropdown всех встроенных + чипы с настройкой периодов ----
  // В 9.6.0 removeIndicator требует (paneId, name?) — раньше передавали имя
  // как paneId, и выключение индикатора было no-op.

  // ---- Точность подписей осей под-окон (как в TradingView) ----
  // У индикаторов KLineChart без своей precision значение по умолчанию — 4:
  // ось MACD по BTC печатает «4,000.0000», при беглом взгляде читающееся
  // как «±4,000,000». Подбираем десятичность по размаху шкалы под-окна:
  // сотни и больше — целые, десятки — один знак, единицы — два, доли —
  // четыре. Главную панель не трогаем (у свечей своя точность инструмента).
  const SUB_PANE_PRECISION_SPANS = [[100, 0], [10, 1], [0.2, 2], [0, 4]];

  const tuneSubPaneAxisPrecision = (name) => {
    if (!chartInstance) return;
    const paneId = indicators.get(name);
    if (!paneId || paneId === 'candle_pane') return;
    try {
      const inst = chartInstance.getIndicatorByPaneId(paneId, name);
      const pane = (chartInstance._drawPanes || [])
        .find(p => (typeof p.getId === 'function' ? p.getId() : p._id) === paneId);
      const axis = pane && pane._axis;
      const ext = axis && typeof axis.getExtremum === 'function' ? axis.getExtremum() : null;
      if (!inst || !ext || !Number.isFinite(ext.min) || !Number.isFinite(ext.max)) return;
      const span = Math.abs(ext.max - ext.min);
      const precision = (SUB_PANE_PRECISION_SPANS.find(([min]) => span >= min) || [0, 4])[1];
      if (inst.precision !== precision) chartInstance.overrideIndicator({ name, precision });
    } catch (e) { /* internals 9.6 недоступны — остаётся библиотечная точность */ }
  };

  const paneForIndicator = (name) => MAIN_PANE_INDICATORS.has(name)
    ? { id: 'candle_pane' }
    : { id: `tc_ind_${name}`, height: 90 };

  const renderIndicatorChips = () => {
    const host = document.getElementById('tc-indicator-chips');
    if (!host) return;
    host.innerHTML = '';
    for (const [name, paneId] of indicators) {
      const chip = document.createElement('span');
      chip.className = 'tc-ind-chip';
      // Подпись чипа — shortName живого инстанса («Объем» у гистограммы),
      // нет инстанса — имя индикатора
      let label = name;
      try {
        const inst = chartInstance && chartInstance.getIndicatorByPaneId(paneId, name);
        if (inst && inst.shortName) label = inst.shortName;
      } catch (e) { /* инстанс недоступен — остаётся имя */ }
      const nm = document.createElement('span');
      nm.className = 'tc-ind-name';
      nm.textContent = label;
      nm.title = name === VOL_MAIN ? label : `${name} — настройки периодов`;
      nm.addEventListener('click', () => window.tcConfigureIndicator(name));
      const x = document.createElement('span');
      x.className = 'tc-ind-close';
      x.textContent = '×';
      x.title = `Убрать ${name}`;
      x.addEventListener('click', () => window.tcRemoveIndicator(name));
      chip.appendChild(nm);
      chip.appendChild(x);
      chip.dataset.paneId = paneId;
      host.appendChild(chip);
    }
  };

  // Добавление индикатора: MA/EMA/BOLL/SAR — на свечи, остальные —
  // в собственные под-окна (isStack=false, уникальный paneId на имя)
  window.tcAddIndicator = function (name) {
    const instance = getChartInstance();
    if (!instance || !name) return;
    if (indicators.has(name)) { setStatus(`Индикатор ${name} уже включён`); return; }
    const pane = paneForIndicator(name);
    // Стек для главного окна (см. комментарий к volume при init): в 9.6
    // IndicatorStore.addInstance при isStack=false затирает индикаторов
    // панели, поэтому MA/EMA/BOLL… добавляются поверх гистограммы, а не
    // вместо неё. Под-окна каждый раз создаются новые — там не важно.
    const id = instance.createIndicator(name, pane.id === 'candle_pane', pane);
    if (!id) { setStatus(`Индикатор ${name} не поддерживается библиотекой`, true); return; }
    indicators.set(name, pane.id);
    renderIndicatorChips();
    // Точность оси под-окна — после первого расчёта и раскладки: экстремум
    // оси появляется с первым кадром, раньше его просто нет
    setTimeout(() => tuneSubPaneAxisPrecision(name), 400);
    const select = document.getElementById('tc-indicator-select');
    if (select) select.value = '';
    setStatus(name === VOL_MAIN
      ? 'Гистограмма объёма включена'
      : `Индикатор ${name} включён — клик по названию открывает периоды`);
  };

  window.tcRemoveIndicator = function (name) {
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    if (!instance || !paneId) return;
    instance.removeIndicator(paneId, name);
    indicators.delete(name);
    renderIndicatorChips();
    if (name === VOL_MAIN) renderVolumeAxisLabel(null, false);
    setStatus(name === VOL_MAIN
      ? 'Гистограмма объёма выключена'
      : `Индикатор ${name} выключен`);
  };

  // Настройка периодов (как клик по названию индикатора в TradingView):
  // текущие значения берём из живого инстанса, правим через overrideIndicator.
  // Ввод в модальном диалоге (window.prompt выглядит чужеродно и блокирует
  // вкладку); ошибка валидации показывается inline, окно не закрывается
  window.tcConfigureIndicator = function (name) {
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    if (!instance || !paneId) return;
    if (name === VOL_MAIN) {
      setStatus('У гистограммы объёма нет настроек периодов');
      return;
    }
    let current = '';
    try {
      const inst = instance.getIndicatorByPaneId(paneId, name);
      if (inst && Array.isArray(inst.calcParams) && inst.calcParams.length) {
        current = inst.calcParams.join(', ');
      }
    } catch (e) { /* инстанс не найден — диалог откроется с дефолтом */ }
    openSettingsDialog({
      title: `Настройки ${name}`,
      label: `Периоды через запятую${current ? ` · сейчас: ${current}` : ''}`,
      value: current || '14',
      apply: (raw) => {
        const params = String(raw).split(',').map(s => parseFloat(s.trim()))
          .filter(n => Number.isFinite(n) && n > 0);
        if (!params.length) {
          return 'Нужны положительные числа через запятую — например 14 или 7, 25';
        }
        instance.overrideIndicator({ name, calcParams: params });
        setStatus(`${name}: периоды ${params.join(', ')} применены`);
        return true;
      },
    });
  };

  // ---- Стартовые слушатели ----

  // klinecharts.init измеряет контейнер в момент вызова. Автозагрузка
  // последнего графика стреляет на DOMContentLoaded, когда активной может
  // быть другая страница («Главная»): контейнер 0×0, панель свечей
  // раскладывается в нулевую высоту, и после показа раздела свечи остаются
  // сжатыми в полосу у верхнего края (ResizeObserver растягивает канвас,
  // но раскладку панелей не пересчитывает). Поэтому загрузка в скрытом
  // разделе откладывается до первого показа, а уже созданный график при
  // показе пересобирается через resize().
  let pendingAutoload = false;

  const chartSectionVisible = () => {
    const el = document.getElementById('test-chart-kline');
    return !!(el && el.offsetParent !== null);
  };

  // Вызывается из navigateTo при первом показе раздела (декоратор ниже)
  window.tcSectionShown = function () {
    if (!chartSectionVisible()) return;
    // Меню могло остаться открытым при уходе с раздела — прячем (позиция устарела)
    hideCtxMenu();
    if (pendingAutoload) {
      pendingAutoload = false;
      autoLoadLastChart();
    } else if (chartInstance && typeof chartInstance.resize === 'function') {
      // Раздел снова виден — пересобрать панели под реальные размеры
      chartInstance.resize();
    }
  };

  const autoLoadLastChart = () => {
    let last = null;
    try { last = JSON.parse(localStorage.getItem(LAST_LS_KEY) || 'null'); } catch (e) {}
    if (!last || !last.ticker) return;
    const input = document.getElementById('test-chart-ticker-input');
    if (input) input.value = last.ticker;
    if (last.interval && TF_LOOKBACK_DAYS[last.interval]) currentInterval = last.interval;
    syncTfButtons();
    if (!chartSectionVisible()) { pendingAutoload = true; return; }
    window.loadTestChartCandles();
  };

  // Показ раздела — как в portfolio.js: оборачиваем navigateTo, чтобы
  // отложить/догрузить график именно в момент, когда контейнер имеет размер
  const originalNavigateTo = window.navigateTo;
  window.navigateTo = function (pageName) {
    const result = typeof originalNavigateTo === 'function'
      ? originalNavigateTo(pageName) : undefined;
    if (pageName === 'test-chart') window.tcSectionShown();
    return result;
  };

  document.addEventListener('DOMContentLoaded', () => {
    registerCustomOverlays();
    registerVolumeIndicator();
    syncTfButtons();
    // Сохранённый вид (тип графика + режим шкалы) читаем до первой
    // загрузки: init графика применит его стилями (apply…Type/ScaleMode)
    loadSavedView();
    syncTypeButtons();
    syncScaleButtons();
    // Сброс вида (двойной клик / правый клик → «Reset chart»), захват
    // кисти/измерителя и диалог настроек — слушатели защищены от
    // повторного навешивания
    bindResetViewUi();
    bindStageTools();
    bindSettingsDialog();
    const input = document.getElementById('test-chart-ticker-input');
    const btn = document.getElementById('test-chart-load-btn');
    if (btn) btn.addEventListener('click', () => window.loadTestChartCandles());
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') window.loadTestChartCandles();
      });
    }
    const select = document.getElementById('tc-indicator-select');
    if (select) select.addEventListener('change', () => window.tcAddIndicator(select.value));
    // Открываем график, который был открыт последним (как в TradingView)
    autoLoadLastChart();
    // Страховочные сохранения разметки: перед выгрузкой вкладки и при
    // сворачивании/переключении вкладки (перетаскивание точек без
    // onPressedMoveEnd всё равно попадёт в один из этих моментов).
    window.addEventListener('beforeunload', () => persistOverlays());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) persistOverlays();
    });
  });
})();
