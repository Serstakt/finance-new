// График раздела Watchlist (переехал из «Тест график», заменил виджет
// TradingView): свечи Мосбиржи (при заданном MOEX_API_TOKEN —
// авторизованный ISS Algopack apim.moex.com, без задержки; при сбое токена
// — анонимный iss.moex.com с лагом ~15 мин) и крипто-пары Binance
// (BINANCE:BTCUSDT, реальное время) рисуются библиотекой KLineChart.
// Тикер приходит из выбранной строки watchlist (ui.js createChart(symbol)
// зовёт window.wlChartLoad(symbol)) и вводится вручную в поле шапки
// графика: значение подставляется из списка, свой код загружается по
// Enter. Данные идут через бэкенд: GET /api/candles/{symbol}.
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
//   - выбранный в списке тикер загружается сразу при показе раздела,
//     выбранный ТФ переживает перезагрузку (localStorage);
//   - облик TradingView: вертикальная панель инструментов разметки слева
//     (иконки SVG инлайном), шапка символа (тикер — поле ввода, ТФ,
//     тип, индикаторы), легенда OHLCV в углу холста (имя инструмента +
//     O/H/L/C/Vol) следует за кроссхейром (subscribeAction
//     onCrosshairChange, в 9.6 payload несёт kLineData);
//   - volume-гистограмма включена по умолчанию: полупрозрачные столбики
//     в главном окне (кастомный индикатор VOL_MAIN, нормировка по максимуму
//     видимой области), строка «Объем» в легенде (значение обновляется
//     вместе с OHLC; метки на оси цены у объёма нет — дублировала легенду);
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
//   - шкала цены как в TradingView: режимы normal|log|percentage
//     (yAxis.type, взаимоисключающие и только для панели свечей) спрятаны
//     в дропдаун шестерёнки у правого края холста — столбик из трёх кнопок
//     закрывал значения оси цены. Перетаскивание шкалы цены снимает
//     автоподгонку оси (autoCalcTickFlag → ручной масштаб, как в TV),
//     пункт «авто» — переключатель: возвращает автоподгонку или
//     замораживает шкалу по текущей области; тип и режим переживают
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
//   - компоновка как в TradingView: тикер (поле ввода), ТФ, тип и
//     индикаторы стоят в одной шапке, статус живёт поверх холста
//     и высоты не съедает; размеры ровно как у прежнего виджета TradingView
//     — область графика занимает тот же слот #chart-container (вся ширина,
//     без рамки и внешних отступов), холст догоняет resize окна, тягу
//     ресайзера панели списка и смену высоты шапки после загрузки данных
//     (у библиотеки слежения за контейнером нет);
//   - легенды индикаторов прямо на графике (как в TradingView): строка
//     «ИМЯ(параметры) значения ×» на каждой панели — имя открывает
//     периоды, × убирает индикатор (закрытие не в шапке рядом со списком,
//     а рядом с названием на холсте); значения следуют за кроссхейром,
//     встроенный тултип индикаторов отключён (наслаивался бы на легенды);
//   - отсчёт до закрытия бара как тег «287,45 · 00:32:41» в TV, на всех
//     ТФ: раз в секунду обновляется остаток до следующей границы сетки
//     ТФ (календарная проекция от последней свечи; после закрытия
//     рынка — до открытия следующего бара), компактно: «6д15ч» /
//     «3ч40м» / «23м15с» — две старшие единицы;
//   - undo/redo разметки: стек операций создать/удалить/сдвинуть/очистить
//     (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y и две стрелки в шапке) — удалённая
//     правым кликом фигура возвращается, как в TradingView;
//   - панель настроек выбранной разметки (как строка настроек фигуры в
//     TradingView): клик по фигуре (или её достройка) показывает плавающую
//     строку у фигуры — три дропдауна (цвет: палитра + «Свой цвет…»,
//     толщина, стиль линии; триггер показывает текущее значение иконкой)
//     и корзина (удалить выделенную фигуру); клик мимо фигуры панель
//     закрывает, правки применяются overlay.setStyles и переживают
//     перезагрузку (styles в сериализации разметки);
//   - Escape снимает рисование: недостроенная фигура убирается, режим
//     рисования выключается (взведённая кисть/измеритель разоружаются);
//   - контекстное меню правого клика богаче одного «Reset chart»:
//     «Скопировать цену» (цена под курсором через convertFromPixel),
//     «Снимок PNG» (композиция canvas'ов контейнера в dataURL — публичного
//     getSnapshot в 9.6 нет) и «Удалить всю разметку»;
//   - ось времени по-русски: месяцы словами на границах («Июнь»), дни
//     числом, дата в кроссхейре ДД.ММ.ГГГГ — библиотека печатает жёстко
//     en-формат («2026-06»), единственная публичная точка — setCustomApi;
//   - кисть/измеритель и клики рисования — на Pointer Events (мышь,
//     тач-устройства и стилус одним потоком событий, touch-action: none
//     гасит браузерные жесты на холсте);
//   - поллинг Binance 5 с (ближе к потоку TV), MOEX 15 с через apim
//     (токен Algopack, без задержки) или 60 с через анонимный ISS —
//     период подбирается по source в ответе бэкенда;
//   - объем сбоку (VOL_SIDE — «профиль объёма» по видимой области):
//     горизонтальные столбики вдоль шкалы цены (объём свечей делится
//     между пересекаемыми ценовыми уровнями пропорционально перекрытию,
//     бычий/медвежий объём разными цветами), включается в dropdown
//     «Индикаторы», настройки (уровни/ширина/цвета) в диалоге индикатора;
//   - сравнение инструментов (кнопка «Сравнить» в шапке, как Compare в
//     TradingView): линия другого тикера нормируется к масштабу основного
//     графика (в точке привязки цены совпадают), значения в легенде —
//     в масштабе основного инструмента и % от точки привязки; до 5 линий,
//     набор хранится по тикеру и восстанавливается при возврате к нему
//     (wl_chart_compares);
//   - редактирование индикаторов как в TradingView: клик по названию
//     в легенде или ⚙ открывает диалог «Входные данные» (периоды) /
//     «Стиль» (цвета линий/гистограмм, толщина); изменения применяются
//     через overrideIndicator и переживают перезагрузку (wl_chart_indicators:
//     настройки применяются при каждом добавлении, набор включённых
//     индикаторов тоже восстанавливается — как шаблоны индикаторов в TV).

(() => {
  let chartInstance = null;
  let lastTicker = null; // последний успешно загруженный тикер (сохранение разметки, guard поллинга)
  let pendingSymbol = null; // тикер, запрошенный из списка, пока раздел был скрыт — грузится при показе
  let lastSource = null; // источник свежих свечей ('apim'|'iss'|'binance') — из candles-ответа
  let lastTs = null; // timestamp последней свечи — точка инкремента поллинга
  let pollTimer = null;
  let pollKey = null; // 'TICKER|interval' — поллинг останавливается, если данные сменились
  let pollPeriod = null; // активный период таймера поллинга (мс) — смена источника перезапускает его
  let overlayIds = []; // id созданных overlay — для сериализации разметки
  let lastDrawEndAt = 0; // Date.now() последнего завершения фигуры — guard сброса вида на dblclick
  let currentInterval = 24; // активный ТФ (60|24|7|31)
  // Активные индикаторы: name -> paneId. В 9.6 removeIndicator требует
  // (paneId, name) — поэтому храним оба.
  const indicators = new Map();

  // Периоды поллинга: у Binance реальные тики — 5 с (ближе к потоку
  // TradingView, без websockets). MOEX зависит от источника свечей:
  // apim (токен Algopack, данные без задержки) — 15 с; анонимный ISS
  // отдаёт котировки с лагом ~15 мин — чаще 60 с смысла нет. Источник
  // известен из ответа бэкенда (source: 'apim'|'iss') и может смениться
  // на ходу (отказ токена → откат на ISS) — pollOnce перезапускает поллинг.
  const POLL_MS = { binance: 5000, moex: 60000, moexApim: 15000 };
  // Разметка в localStorage: { TICKER: [{ name, extendData, points: [{timestamp, value}] }] }
  const MARKUP_LS_KEY = 'wl_chart_markup';
  // Начальное окно истории в днях (~600 баров; дозагрузка старых — loadMore)
  const TF_LOOKBACK_DAYS = { 60: 40, 24: 600, 7: 4200, 31: 18000 };
  // Индикаторы, живущие в главном окне со свечами; остальные — в своих под-окнах
  const MAIN_PANE_INDICATORS = new Set(['MA', 'EMA', 'BOLL', 'SAR', 'BBI', 'AVP', 'VOL_MAIN', 'VOL_SIDE']);

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

  const VIEW_LS_KEY = 'wl_chart_view';
  const LINE_COLOR = '#2962ff';
  const CHART_TYPE_LABELS = { candles: 'Свечи', bars: 'Бары', line: 'Линия', area: 'Области' };
  // Иконки типов графика (SVG инлайном) — один источник для триггера
  // дропдауна и пунктов меню (в меню — «иконка + название», как в
  // TradingView; там кнопка стиля тоже показывает выбранный тип иконкой)
  const TYPE_ICONS = {
    candles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3M8 18v3"/><rect x="5.5" y="6" width="5" height="12" rx="1"/><path d="M16 5v3M16 16v3"/><rect x="13.5" y="8" width="5" height="8" rx="1"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16"/><path d="M4 7.5h3"/><path d="M7 14h3"/><path d="M17 6v14"/><path d="M14 9.5h3"/><path d="M17 16h3"/></svg>',
    line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16.5 6-6.5 4.5 4L21 5.5"/></svg>',
    area: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16.5 6-6.5 4.5 4L21 5.5"/><path d="M3 20v-3.5l6-6.5 4.5 4L21 5.5V20Z" fill="currentColor" fill-opacity="0.18" stroke="none"/></svg>',
  };
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
  // priceMark.last во всех типах: пунктирная линия текущей цены на холсте
  // видна (как в TradingView), а встроенный тег цены на шкале отключён —
  // вместо него своё поле «цена + отсчёт» (одна плашка,
  // см. syncAxisPriceTag), иначе два тега наслаивались бы
  const CHART_TYPE_STYLES = {
    candles: { type: 'candle_solid', priceMark: { high: { show: true }, low: { show: true }, last: { show: true, line: { show: true }, tag: { show: false } } } },
    bars: { type: 'ohlc', priceMark: { high: { show: true }, low: { show: true }, last: { show: true, line: { show: true }, tag: { show: false } } } },
    line: { type: 'area', priceMark: { high: { show: false }, low: { show: false }, last: { show: true, line: { show: true }, tag: { show: false } } }, area: areaStyles(true) },
    area: { type: 'area', priceMark: { high: { show: false }, low: { show: false }, last: { show: true, line: { show: true }, tag: { show: false } } }, area: areaStyles(false) },
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
      // Выбранный ТФ переживает перезагрузку (символ приходит из списка)
      if (TF_LOOKBACK_DAYS[v.interval]) currentInterval = v.interval;
    } catch (e) { /* битый JSON — остаются дефолты */ }
  };

  const saveView = () => {
    try {
      localStorage.setItem(VIEW_LS_KEY, JSON.stringify({ type: chartType, scale: scaleMode, interval: currentInterval }));
    } catch (e) { /* localStorage недоступен — вид не сохранится */ }
  };

  const syncTypeButtons = () => {
    // Триггер дропдауна — иконка выбранного типа (как кнопка стиля в
    // TradingView), заголовок с названием для подсказки
    const trigger = document.getElementById('tc-type-toggle');
    if (trigger) {
      trigger.innerHTML = TYPE_ICONS[chartType] || '';
      trigger.title = `Тип графика: ${CHART_TYPE_LABELS[chartType] || chartType}`;
    }
    // Активный пункт меню подсвечен (id прежние: tc-type-candles и т.д.)
    for (const t of Object.keys(CHART_TYPE_STYLES)) {
      const item = document.getElementById(`tc-type-${t}`);
      if (item) {
        item.classList.toggle('active', chartType === t);
        if (typeof item.setAttribute === 'function') {
          item.setAttribute('aria-selected', chartType === t ? 'true' : 'false');
        }
      }
    }
  };

  // ---- Дропдаун типа графика (как в TradingView) ----
  // Триггер показывает иконку выбранного типа, меню — список «иконка +
  // название». Закрытие: выбор пункта, клик мимо и Escape — оба события
  // ловят ОБЩИЕ document-обработчики из bindResetViewUi (hideTypeMenu),
  // чтобы не плодить слушателей документа.

  const hideTypeMenu = () => {
    const menu = document.getElementById('tc-type-menu');
    if (!menu || !menu.classList.contains('open')) return false;
    menu.classList.remove('open');
    const toggle = document.getElementById('tc-type-toggle');
    if (toggle && typeof toggle.setAttribute === 'function') {
      toggle.setAttribute('aria-expanded', 'false');
    }
    return true;
  };

  const buildTypeDropdown = () => {
    const root = document.getElementById('tc-type-dropdown');
    const toggle = document.getElementById('tc-type-toggle');
    const menu = document.getElementById('tc-type-menu');
    if (!root || !toggle || !menu || root.dataset.typeDropdownBound) return;
    root.dataset.typeDropdownBound = '1';
    // Пункты меню строим из того же источника, что и иконку триггера:
    // иконка + название; активность пункта ведёт syncTypeButtons
    for (const t of Object.keys(CHART_TYPE_STYLES)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tc-type-item';
      item.id = `tc-type-${t}`;
      item.dataset.type = t; // тип для обработчика выбора в menu-click
      const icon = document.createElement('span');
      icon.className = 'tc-type-icon';
      icon.innerHTML = TYPE_ICONS[t] || '';
      const label = document.createElement('span');
      label.className = 'tc-type-label';
      label.textContent = CHART_TYPE_LABELS[t] || t;
      item.appendChild(icon);
      item.appendChild(label);
      menu.appendChild(item);
    }
    // Триггер: открыть/закрыть меню. Заодно гасим контекстное меню графика,
    // если открыто (его document-обработчик не увидит этот клик —
    // stopPropagation ниже). stopPropagation нужен, чтобы общий
    // «клик мимо — закрыть» тут же не погасил только что открытое меню
    toggle.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (ctxMenuOpen) hideCtxMenu();
      if (menu.classList.contains('open')) {
        hideTypeMenu();
        return;
      }
      menu.classList.add('open');
      if (typeof toggle.setAttribute === 'function') {
        toggle.setAttribute('aria-expanded', 'true');
      }
    });
    // Выбор пункта: tcSetChartType применит тип (стили/сохранение вида/
    // статус), меню закрываем. Клик всплывает и в document-обработчик,
    // но target внутри #tc-type-dropdown — «клик мимо» не сработает
    menu.addEventListener('click', (e) => {
      const item = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('.tc-type-item') : null;
      if (!item || !item.dataset.type) return;
      window.tcSetChartType(item.dataset.type);
      hideTypeMenu();
    });
  };

  // ---- Дропдаун шкалы цены (шестерёнка у правого края холста) ----
  // Автомасштаб, log и % спрятаны в меню, чтобы не закрывать значения
  // оси цены (столбик кнопок наслаивался на шкалу). Пункты живут в
  // разметке с прежними id (tc-scale-auto/log/pct) — onclick-атрибуты
  // применяют режим, syncScaleButtons ведёт подсветку активного. Закрытие:
  // выбор пункта, клик мимо и Escape — общие document-обработчики из
  // bindResetViewUi (hideScaleMenu), как у дропдауна типа графика.

  const hideScaleMenu = () => {
    const menu = document.getElementById('tc-scale-menu');
    if (!menu || !menu.classList.contains('open')) return false;
    menu.classList.remove('open');
    const toggle = document.getElementById('tc-scale-toggle');
    if (toggle && typeof toggle.setAttribute === 'function') {
      toggle.setAttribute('aria-expanded', 'false');
    }
    return true;
  };

  const buildScaleDropdown = () => {
    const root = document.getElementById('tc-scale-dropdown');
    const toggle = document.getElementById('tc-scale-toggle');
    const menu = document.getElementById('tc-scale-menu');
    if (!root || !toggle || !menu || root.dataset.scaleDropdownBound) return;
    root.dataset.scaleDropdownBound = '1';
    // Триггер: открыть/закрыть меню. Заодно гасим контекстное меню графика,
    // если открыто; stopPropagation не даёт общему «клик мимо — закрыть»
    // тут же погасить только что открытое меню
    toggle.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (ctxMenuOpen) hideCtxMenu();
      if (menu.classList.contains('open')) {
        hideScaleMenu();
        return;
      }
      menu.classList.add('open');
      if (typeof toggle.setAttribute === 'function') {
        toggle.setAttribute('aria-expanded', 'true');
      }
    });
    // Выбор пункта: режим применит onclick-атрибут кнопки (клик всплывает
    // из неё в меню) — здесь только закрываем меню
    menu.addEventListener('click', () => hideScaleMenu());
  };

  // ---- Дропдаун «Индикаторы» в шапке (как кнопка Indicators в TradingView)
  // ---- Триггер — иконка ƒx + подпись, меню — те же группы, что были в
  // select: «На графике цены» и «В под-окнах». Включённые индикаторы
  // подсвечены, клик по пункту переключает (добавить/убрать). Закрытие:
  // выбор, клик мимо и Escape — общие document-обработчики из
  // bindResetViewUi (hideIndicatorMenu), как у дропдаунов типа и шкалы.

  // Группы меню: имя индикатора → подпись (VOL_MAIN/VOL_SIDE переименованы,
  // как были в option списка; остальные — имена библиотечных индикаторов)
  const INDICATOR_MENU_GROUPS = [
    { title: 'На графике цены', items: { MA: 'MA', EMA: 'EMA', BOLL: 'BOLL', SAR: 'SAR', BBI: 'BBI', VOL_MAIN: 'Объем (гистограмма)', VOL_SIDE: 'Объем сбоку (профиль)' } },
    { title: 'В под-окнах', items: { VOL: 'VOL', MACD: 'MACD', RSI: 'RSI', KDJ: 'KDJ', WR: 'WR', CCI: 'CCI', DMI: 'DMI', OBV: 'OBV', ROC: 'ROC', DMA: 'DMA', BIAS: 'BIAS', TRIX: 'TRIX' } },
  ];

  const hideIndicatorMenu = () => {
    const menu = document.getElementById('tc-ind-menu');
    if (!menu || !menu.classList.contains('open')) return false;
    menu.classList.remove('open');
    const toggle = document.getElementById('tc-ind-toggle');
    if (toggle && typeof toggle.setAttribute === 'function') {
      toggle.setAttribute('aria-expanded', 'false');
    }
    return true;
  };

  // Подсветка включённых: зовётся из renderIndicatorLegends — она вызывается
  // и при добавлении/удалении индикатора, и при init
  const syncIndicatorMenu = () => {
    const menu = document.getElementById('tc-ind-menu');
    if (!menu) return;
    for (const item of menu.children) {
      if (item.dataset && item.dataset.ind) {
        item.classList.toggle('active', indicators.has(item.dataset.ind));
      }
    }
  };

  const buildIndicatorDropdown = () => {
    const root = document.getElementById('tc-ind-dropdown');
    const toggle = document.getElementById('tc-ind-toggle');
    const menu = document.getElementById('tc-ind-menu');
    if (!root || !toggle || !menu || root.dataset.indDropdownBound) return;
    root.dataset.indDropdownBound = '1';
    // Пункты из тех же групп, что были option'ы select: заголовок группы —
    // не кликабелен, пункт — кнопка с data-ind
    for (const group of INDICATOR_MENU_GROUPS) {
      const title = document.createElement('div');
      title.className = 'tc-ind-menu-title';
      title.textContent = group.title;
      menu.appendChild(title);
      for (const [name, label] of Object.entries(group.items)) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'tc-ind-item';
        item.dataset.ind = name; // имя для переключения в обработчике ниже
        item.textContent = label;
        item.title = indicators.has(name) ? `Убрать ${label}` : `Добавить ${label}`;
        menu.appendChild(item);
      }
    }
    // Триггер: открыть/закрыть меню. Заодно гасим контекстное меню графика,
    // если открыто; stopPropagation не даёт общему «клик мимо — закрыть»
    // тут же погасить только что открытое меню
    toggle.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (ctxMenuOpen) hideCtxMenu();
      if (menu.classList.contains('open')) {
        hideIndicatorMenu();
        return;
      }
      menu.classList.add('open');
      if (typeof toggle.setAttribute === 'function') {
        toggle.setAttribute('aria-expanded', 'true');
      }
    });
    // Клик по пункту — переключить индикатор (включён → убрать, иначе
    // добавить) и обновить подсветку. Клик всплывает и в document-обработчик,
    // но target внутри #tc-ind-dropdown — «клик мимо» не сработает
    menu.addEventListener('click', (e) => {
      const item = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('.tc-ind-item') : null;
      if (!item || !item.dataset.ind) return;
      const name = item.dataset.ind;
      if (indicators.has(name)) window.tcRemoveIndicator(name);
      else window.tcAddIndicator(name);
      syncIndicatorMenu();
    });
    syncIndicatorMenu();
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

  // ---- Плотность меток оси цены (как в TradingView) ----
  // KLineChart 9.6 делит диапазон шкалы на 8 частей: в Axis._calcTickInterval
  // жёстко вшит делитель 8, настройки плотности у стилей yAxis нет — на
  // панелях обычной высоты выходит 6-8 меток, цены стоят ~80 px друг от
  // друга и шкала выглядит «пустой». Метод перекрывается на самом инстансе
  // оси (own property затеняет prototype-метод; имена методов в собранном
  // бандле не минифицируются — проверено на klinecharts.min.js 9.6.0).
  // Делим на 16: меток 12-16, как у TradingView; встроенный фильтр
  // optimalTicks (соседние метки ближе 2× размера шрифта ≈ 24 px отбрасываются)
  // такие зазоры не режет, а на низкой панели он же мягко деградирует
  // плотность к прежней — естественный ограничитель.
  const Y_AXIS_TICK_DIVISOR = 16;

  // «Округление» шага тиков до 1/2/…/8 × 10^k и его десятичность — копии
  // nice() и getPrecision() из исходников библиотеки v9.6.0
  // (common/utils/number.ts, Apache-2.0): они не экспортируются, а
  // перекрытый _calcTickInterval обязан вернуть шаг того же вида, что и
  // оригинал, иначе ось (log/%, малые цены) поедет
  const niceTickStep = (value) => {
    const exponent = Math.floor(Math.log10(value));
    const exp10 = Math.pow(10, exponent);
    const f = value / exp10; // 1 <= f < 10
    let nf = 0;
    if (f < 1.5) nf = 1;
    else if (f < 2.5) nf = 2;
    else if (f < 3.5) nf = 3;
    else if (f < 4.5) nf = 4;
    else if (f < 5.5) nf = 5;
    else if (f < 6.5) nf = 6;
    else nf = 8;
    return exponent >= -20
      ? Number((nf * exp10).toFixed(exponent < 0 ? -exponent : 0))
      : nf * exp10;
  };
  const tickStepPrecision = (value) => {
    const s = String(value);
    const e = s.indexOf('e');
    if (e > 0) {
      const p = Number(s.slice(e + 1));
      return p < 0 ? -p : 0;
    }
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - 1 - dot;
  };

  // Перекрытие метода расчёта шага тиков — идемпотентно, зовётся один раз
  // сразу после init (ось главной панели живёт всю жизнь графика,
  // пересоздаётся только вместе с инстансом)
  const densifyPriceAxisTicks = () => {
    const axis = candlePaneAxis();
    if (!axis || typeof axis._calcTickInterval !== 'function' || axis._tcDensified) return;
    axis._tcDensified = true;
    axis._calcTickInterval = function (range) {
      const interval = niceTickStep(range / Y_AXIS_TICK_DIVISOR);
      return [interval, tickStepPrecision(interval)];
    };
  };

  // ---- Перетаскивание шкалы цены не срывается при уходе курсора с оси ----
  // KLineChart 9.6 в pressedMouseMoveEvent заново ищет виджет под курсором и
  // тянет шкалу, только пока это тот же виджет, где нажали кнопку. Курсор
  // ушёл с узкой полосы оси цены (на график, соседнюю панель, за край
  // холста) — масштабирование замирает: захват «сбрасывается», хотя кнопка
  // ещё зажата. В TradingView шкала тянется, пока держат кнопку, где бы ни
  // был курсор. Перекрывается _findWidgetByEvent инстанса событий графика
  // (chartInstance._chartEvent, own-свойство затеняет prototype-метод —
  // имена методов в бандле не минифицируются, см. densifyPriceAxisTicks):
  // пока нажатие живёт на виджете оси цены (_mouseDownWidget выставляется
  // в mousedown и сбрасывается в mouseup библиотеки), он и возвращается —
  // перетаскивание продолжается по всей странице. Нажатие вне оси живёт по
  // прежним правилам. Инстанс недоступен (сменилось внутреннее API) —
  // остаётся поведение библиотеки
  const pinYAxisDragCapture = () => {
    try {
      const ev = chartInstance && chartInstance._chartEvent;
      if (!ev || ev._tcAxisDragPinned) return;
      if (typeof ev._findWidgetByEvent !== 'function') return;
      ev._tcAxisDragPinned = true;
      const findWidgetByEvent = ev._findWidgetByEvent.bind(ev);
      ev._findWidgetByEvent = function (e) {
        const down = this._mouseDownWidget;
        if (down && typeof down.getName === 'function' && down.getName() === 'yAxis'
          && typeof down.getPane === 'function') {
          return { pane: down.getPane(), widget: down };
        }
        return findWidgetByEvent(e);
      };
    } catch (e) { /* internals сменились — остаётся поведение библиотеки */ }
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
  // как в TV). Значение под курсором показывает строка «Объем» легенды
  // OHLCV — метки на оси цены у объёма нет (дублировала легенду).

  const VOL_MAIN = 'VOL_MAIN';
  // Дефолтные настройки гистограммы (редактируются в диалоге индикатора,
  // как в TradingView: клик по названию в легенде). Живут в extendData
  // индикатора — custom-draw читает их оттуда; сохранение/применение —
  // в блоке настроек индикаторов (IND_EDIT)
  const VOL_MAIN_DEFAULT_EXTEND = {
    maxHeight: 0.2, // самый высокий столбик — 20% высоты ценовой панели
    upColor: 'rgba(38, 166, 154, 0.5)',
    downColor: 'rgba(239, 83, 80, 0.5)',
  };

  const registerVolumeIndicator = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerIndicator({
      name: VOL_MAIN,
      // shortName пуст: встроенный tooltip индикатора печатает именно
      // shortName; значение объёма показывает наша HTML-строка «Объем N»
      // в легенде OHLCV (тултипы отключены — см. блок стилей init)
      shortName: '',
      figures: [],
      calc: () => [],
      draw: ({ ctx, kLineDataList, visibleRange, bounding, barSpace, xAxis, indicator }) => {
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
        const ext = { ...VOL_MAIN_DEFAULT_EXTEND, ...(indicator && indicator.extendData) };
        // Координаты draw — локальные относительно canvas панели:
        // низ панели = bounding.height
        const unitPx = (bounding.height * ext.maxHeight) / volMax;
        for (let i = from; i <= to; i++) {
          const k = kLineDataList[i];
          const v = k.volume;
          if (!Number.isFinite(v) || v <= 0) continue;
          const h = Math.max(1, v * unitPx);
          const x = xAxis.convertToPixel(i);
          // Ширина — gapBar, как у встроенных bar-фигур индикаторов
          ctx.fillStyle = k.close >= k.open ? ext.upColor : ext.downColor;
          ctx.fillRect(x - barSpace.gapBar / 2, bounding.height - h, barSpace.gapBar, h);
        }
        return false; // figures нет — встроенному рисованию перекрыть нечего
      },
    });
  };

  // ---- Объем сбоку (профиль объёма по видимой области, как в TV) ----
  // Кастомный индикатор VOL_SIDE: горизонтальные столбики объёма вдоль
  // шкалы цены — объём распределяется по ценовым уровням видимых свечей
  // (свеча с диапазоном low..high вносит долю своего объёма в каждый
  // пересекаемый уровень пропорционально перекрытию), столбики растут
  // от правого края панели влево. Цвета — бычий/медвежий объём (направление
  // свечи-источника), друг за другом в одном столбике. figures пусты:
  // значения в ось цены не попадают (нормировка «по максимуму уровня»,
  // миллионы объёма не растягивают шкалу), всё рисование — в draw.
  // Пересчитывается на каждом кадре — скролл/зум меняют и уровни, и ширину.

  const VOL_SIDE = 'VOL_SIDE';
  const VOL_SIDE_DEFAULT_EXTEND = {
    bins: 24,      // число ценовых уровней видимой области
    maxWidth: 0.18, // самый длинный столбик — 18% ширины панели
    upColor: 'rgba(38, 166, 154, 0.45)',
    downColor: 'rgba(239, 83, 80, 0.45)',
  };

  const registerSideVolumeIndicator = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerIndicator({
      name: VOL_SIDE,
      shortName: '',
      figures: [],
      calc: () => [],
      draw: ({ ctx, kLineDataList, visibleRange, bounding, yAxis, indicator }) => {
        if (!kLineDataList || !kLineDataList.length || !bounding) return false;
        if (!yAxis || typeof yAxis.convertToPixel !== 'function') return false;
        const from = Math.max(0, visibleRange.from);
        const to = Math.min(kLineDataList.length - 1, visibleRange.to);
        if (from > to) return false;
        const ext = { ...VOL_SIDE_DEFAULT_EXTEND, ...(indicator && indicator.extendData) };
        const bins = Math.max(4, Math.min(60, Math.round(ext.bins) || 24));
        const maxWidthRatio = Math.max(0.05, Math.min(0.5, Number(ext.maxWidth) || 0.18));
        // Диапазон цен видимых свечей
        let pMin = Infinity;
        let pMax = -Infinity;
        for (let i = from; i <= to; i++) {
          const k = kLineDataList[i];
          if (Number.isFinite(k.low) && k.low < pMin) pMin = k.low;
          if (Number.isFinite(k.high) && k.high > pMax) pMax = k.high;
        }
        if (!Number.isFinite(pMin) || !Number.isFinite(pMax) || !(pMax > pMin)) return false;
        const binH = (pMax - pMin) / bins;
        const upVol = new Array(bins).fill(0);
        const downVol = new Array(bins).fill(0);
        const clampedBin = (v) => Math.max(0, Math.min(bins - 1, Math.floor((v - pMin) / binH)));
        for (let i = from; i <= to; i++) {
          const k = kLineDataList[i];
          const v = k.volume;
          if (!Number.isFinite(v) || v <= 0) continue;
          const lo = Number.isFinite(k.low) ? k.low : pMin;
          const hi = Number.isFinite(k.high) ? k.high : pMax;
          const up = k.close >= k.open;
          const first = clampedBin(lo);
          const last = clampedBin(hi);
          const span = hi - lo;
          if (!(span > 0)) {
            // doji-свеча без диапазона — весь объём в один уровень
            if (up) upVol[first] += v; else downVol[first] += v;
            continue;
          }
          for (let b = first; b <= last; b++) {
            // доля объёма — по перекрытию [lo, hi] с уровнем b
            const bLo = pMin + b * binH;
            const bHi = bLo + binH;
            const overlap = Math.min(hi, bHi) - Math.max(lo, bLo);
            if (overlap <= 0) continue;
            const share = v * (overlap / span);
            if (up) upVol[b] += share; else downVol[b] += share;
          }
        }
        let volMax = 0;
        for (let b = 0; b < bins; b++) {
          const t = upVol[b] + downVol[b];
          if (t > volMax) volMax = t;
        }
        if (!(volMax > 0)) return false;
        const maxW = bounding.width * maxWidthRatio;
        for (let b = 0; b < bins; b++) {
          const total = upVol[b] + downVol[b];
          if (!(total > 0)) continue;
          const w = Math.max(1, (total / volMax) * maxW);
          const yHi = yAxis.convertToPixel(pMin + (b + 1) * binH);
          const yLo = yAxis.convertToPixel(pMin + b * binH);
          const y = Math.min(yHi, yLo);
          const h = Math.max(1, Math.abs(yLo - yHi) - 1); // зазор 1px между уровнями
          // бычий объём — у правого края, медвежий — продолжение влево
          const wUp = total > 0 ? w * (upVol[b] / total) : 0;
          if (wUp >= 0.5) {
            ctx.fillStyle = ext.upColor;
            ctx.fillRect(bounding.width - wUp, y, wUp, h);
          }
          const wDown = w - wUp;
          if (wDown >= 0.5) {
            ctx.fillStyle = ext.downColor;
            ctx.fillRect(bounding.width - w, y, wDown, h);
          }
        }
        return false; // figures нет — встроенному рисованию перекрыть нечего
      },
    });
  };

  // Кастомный прямоугольник: в KLineChart v9.6 нет встроенного шаблона
  // overlay «rect» (rect — только тип фигуры), поэтому регистрируем свой
  // шаблон из двух точек с фигурой-прямоугольником между ними. Стили
  // фигуры читаются из styles инстанса (line/rect-ключи) — их пишет
  // панель настроек разметки; по умолчанию — прежний вид (синий TV).
  const RECT_DEFAULT_STYLES = {
    color: 'rgba(41, 98, 255, 0.12)',
    borderColor: '#2962ff',
    borderSize: 1,
    borderStyle: 'solid',
    borderDashedValue: [2, 2],
  };
  const registerRectOverlay = () => {
    if (typeof klinecharts === 'undefined') return;
    klinecharts.registerOverlay({
      name: 'tc-rect',
      totalStep: 3, // 2 точки: противоположные углы
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: true,
      needDefaultYAxisFigure: true,
      createPointFigures: ({ coordinates, overlay }) => {
        if (!coordinates || coordinates.length < 2) return [];
        const [a, b] = coordinates;
        const st = { ...RECT_DEFAULT_STYLES, ...((overlay && overlay.styles && overlay.styles.rect) || {}) };
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
            color: st.color,
            borderColor: st.borderColor,
            borderSize: st.borderSize,
            borderStyle: st.borderStyle,
            borderDashedValue: st.borderDashedValue,
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
      createPointFigures: ({ coordinates, overlay }) => {
        if (!coordinates || coordinates.length < 2) return [];
        const [a, b] = coordinates;
        // Цвет/толщина/стиль — из styles инстанса (панель настроек
        // разметки), по умолчанию — прежний вид
        const st = (overlay && overlay.styles && overlay.styles.line) || {};
        const color = st.color ?? ARROW_COLOR;
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
            styles: {
              style: st.style ?? 'solid',
              color,
              size: st.size ?? 1.6,
              dashedValue: st.dashedValue ?? [2, 2],
            },
          },
          {
            type: 'polygon',
            attrs: { coordinates: [b, wing(half), wing(-half)] },
            styles: { style: 'fill', color },
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
      createPointFigures: ({ coordinates, overlay }) => {
        if (!coordinates || coordinates.length < 2) return [];
        // Цвет/толщина/стиль — из styles инстанса (панель настроек
        // разметки), по умолчанию — прежний вид
        const st = (overlay && overlay.styles && overlay.styles.line) || {};
        return [{
          type: 'line',
          attrs: { coordinates },
          styles: {
            style: st.style ?? 'solid',
            color: st.color ?? BRUSH_COLOR,
            size: st.size ?? 2,
            dashedValue: st.dashedValue ?? [2, 2],
          },
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
    const el = document.getElementById('watchlist-chart-status');
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

  // ---- Ось времени по-русски (как в TradingView) ----
  // Библиотека форматирует метки времени через Intl, жёстко собранный с
  // локалью «en» (setLocale на даты не влияет): месячные тики печатаются
  // «2026-04» вместо «Июнь». Публичная точка перехвата — setCustomApi
  // ({formatDate}); ей пользуются ось времени, кроссхейр и тултип.
  // Форматы оси: 'HH:mm' | 'MM-DD' | 'YYYY-MM' | 'YYYY'; первый тик
  // библиотека до-думывает, сравнивая текст соседних тиков (оптимальная
  // метка перекрывает эвристику формы «2026-04»), поэтому строкам можно
  // придавать любой вид. Дни — числом («22»), месяцы — словом («Июнь»),
  // полная дата в кроссхейре — ДД.ММ.ГГГГ.

  const pad2 = (n) => String(n).padStart(2, '0');
  const RU_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

  const customFormatDate = (dateTimeFormat, timestamp, format) => {
    const d = new Date(Number(timestamp));
    if (Number.isNaN(d.getTime())) return '';
    const tok = {
      YYYY: String(d.getFullYear()),
      MM: pad2(d.getMonth() + 1),
      DD: pad2(d.getDate()),
      HH: pad2(d.getHours()),
      mm: pad2(d.getMinutes()),
      ss: pad2(d.getSeconds()),
    };
    switch (format) {
      case 'YYYY-MM': return RU_MONTHS[d.getMonth()]; // «Июнь» на границе месяца
      case 'MM-DD': return tok.DD;                    // «22» — число дня
      case 'YYYY-MM-DD': return `${tok.DD}.${tok.MM}.${tok.YYYY}`;
      case 'YYYY-MM-DD HH:mm': return `${tok.DD}.${tok.MM}.${tok.YYYY} ${tok.HH}:${tok.mm}`;
      default: return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => tok[t]);
    }
  };

  const getChartInstance = () => {
    if (typeof klinecharts === 'undefined') {
      setStatus('⚠ Библиотека KLineChart не загрузилась (CDN cdn.jsdelivr.net недоступен)', true);
      return null;
    }
    registerCustomOverlays();
    registerVolumeIndicator();
    registerSideVolumeIndicator();
    const el = document.getElementById('watchlist-kline');
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
            // Пунктир текущей цены виден, встроенный тег на шкале выключен:
            // своё поле «цена + отсчёт» рисует syncAxisPriceTag поверх холста
            priceMark: { last: { show: true, line: { show: true }, tag: { show: false } } },
            // Встроенную строку OHLC гасим: в 9.6 standard-tooltip рисуется
            // безусловно, подавить его можно только парой showType 'rect' +
            // showRule 'none' (isDrawTooltip = false). Вместо него — своя
            // легенда .tc-legend в левом верхнем углу, как в TradingView.
            tooltip: { showType: 'rect', showRule: 'none' },
          },
          indicator: {
            // Встроенный тултип индикаторов (shortName + значения на холсте,
            // showRule 'none' → isDrawTooltip=false) отключён: вместо него
            // свои HTML-легенды на каждой панели — «ИМЯ(параметры)
            // значения ×» с кнопкой закрытия рядом с названием
            // (см. renderIndicatorLegends)
            tooltip: { showRule: 'none' },
          },
          // Границы осей без линии: у библиотеки axisLine по умолчанию
          // светло-серый (#DDDDDD) — на тёмном фоне читался как белая
          // полоса вдоль осей даты и цены. В TradingView рамки осей нет.
          xAxis: { axisLine: { show: false }, tickText: { color: '#787b86' }, tickLine: { color: '#2a2e39' } },
          yAxis: { axisLine: { show: false }, tickText: { color: '#787b86' }, tickLine: { color: '#2a2e39' } },
          crosshair: {
            horizontal: { text: { backgroundColor: '#434651' } },
            vertical: { text: { backgroundColor: '#434651' } },
          },
        },
      });
      // Доступ к instance извне замыкания — для отладки. Сериализация
      // разметки живёт в этом замыкании (overlayIds), наружу не торчит.
      window.watchlistChartInstance = chartInstance;
      // Русская ось времени (см. блок customFormatDate выше)
      if (typeof chartInstance.setCustomApi === 'function') {
        chartInstance.setCustomApi({ formatDate: customFormatDate });
      }
      // Сохранённый вид (тип графика + режим шкалы) применяем сразу —
      // состояние уже прочитано из localStorage на DOMContentLoaded
      applyChartType();
      applyScaleMode();
      // Плотные метки оси цены (см. блок densifyPriceAxisTicks) — до
      // первой загрузки данных, чтобы ось сразу строилась с делителем 16
      densifyPriceAxisTicks();
      // Захват шкалы цены не срывается при уходе курсора с полосы оси
      // (см. блок pinYAxisDragCapture)
      pinYAxisDragCapture();
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
        const id = chartInstance.createIndicator(indicatorCreateOptions(VOL_MAIN), true, { id: 'candle_pane' });
        if (id) {
          indicators.set(VOL_MAIN, 'candle_pane');
          renderIndicatorLegends();
        }
      }
      // Включённые индикаторы прошлой сессии (как в TradingView: набор
      // индикаторов переживает перезагрузку) — VOL_MAIN уже добавлена выше.
      // Настройки (периоды/стили) применяются внутри tcAddIndicator
      const savedEnabled = loadIndicatorStore().enabled;
      if (Array.isArray(savedEnabled)) {
        for (const name of savedEnabled) {
          if (!indicators.has(name)) window.tcAddIndicator(name);
        }
      }
      // Легенда OHLCV и легенды индикаторов следуют за кроссхейром (как в
      // TradingView). При уходе курсора KLineChart отдаёт последнюю свечу —
      // легенды «возвращаются».
      if (typeof chartInstance.subscribeAction === 'function') {
        chartInstance.subscribeAction('onCrosshairChange', (ev) => {
          if (ev && ev.kLineData) {
            renderLegend(ev.kLineData);
          }
          renderIndicatorLegendValues(ev && ev.kLineData ? ev.kLineData : null);
        });
        // Сдвиг/зум меняют положение цены на шкале — отсчёт под тегом
        // последней цены догоняет (секундный тик подстрахует, если тип
        // события этой версией библиотеки не отдаётся); панель настроек
        // разметки двигается вместе с фигурой
        for (const evName of ['onScroll', 'onZoom', 'onPaneMouseZoom']) {
          chartInstance.subscribeAction(evName, () => {
            renderCountdown();
            repositionDrawSettings();
          });
        }
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
  // Цена под курсором на момент открытия меню — для «Скопировать цену»;
  // null (курсор вне данных/осей) — пункт гасится
  let ctxMenuPrice = null;

  const syncCtxCopyItem = () => {
    const item = document.getElementById('tc-ctx-copy');
    if (!item) return;
    const on = ctxMenuPrice != null;
    item.disabled = !on;
    item.classList.toggle('disabled', !on);
  };

  const copyCtxPrice = () => {
    if (ctxMenuPrice == null) return;
    const text = fmtNum(ctxMenuPrice);
    const clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text)
        .then(() => setStatus(`Скопировано в буфер: ${text}`))
        .catch(() => setStatus('Не удалось скопировать цену', true));
    } else {
      setStatus('Буфер обмена недоступен в этом браузере', true);
    }
  };

  // Снимок PNG (как «Сохранить изображение графика» в TradingView):
  // публичного getSnapshot в 9.6 нет — сливаем canvas'ы контейнера в
  // один offscreen (фон + drawImage каждого слоя по его смещению,
  // масштаб — devicePixelRatio) и отдаём как dataURL на скачивание.
  const takeChartSnapshot = () => {
    if (!chartInstance || !lastTicker) {
      setStatus('Снимок: сначала загрузите график', true);
      return;
    }
    const dom = typeof chartInstance.getDom === 'function' ? chartInstance.getDom()
      : document.getElementById('watchlist-kline');
    const canvases = dom && typeof dom.querySelectorAll === 'function'
      ? dom.querySelectorAll('canvas') : [];
    if (!canvases || !canvases.length) {
      setStatus('Снимок: холсты графика не найдены', true);
      return;
    }
    const rect = typeof dom.getBoundingClientRect === 'function'
      ? dom.getBoundingClientRect() : null;
    if (!rect || !rect.width || !rect.height) {
      setStatus('Снимок: контейнер графика пуст', true);
      return;
    }
    const out = document.createElement('canvas');
    if (!out || typeof out.getContext !== 'function') {
      setStatus('Снимок: canvas недоступен в этом браузере', true);
      return;
    }
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    out.width = Math.round(rect.width * dpr);
    out.height = Math.round(rect.height * dpr);
    const ctx = out.getContext('2d');
    if (!ctx) {
      setStatus('Снимок: canvas недоступен в этом браузере', true);
      return;
    }
    ctx.fillStyle = '#131722';
    ctx.fillRect(0, 0, out.width, out.height);
    for (const c of canvases) {
      ctx.drawImage(c, (c.offsetLeft || 0) * dpr, (c.offsetTop || 0) * dpr,
        (c.offsetWidth || 0) * dpr, (c.offsetHeight || 0) * dpr);
    }
    const link = document.createElement('a');
    link.download = `${displayTicker(lastTicker) || 'chart'}_${fmtDay(new Date())}.png`;
    link.href = out.toDataURL('image/png');
    link.click();
    setStatus(`Снимок графика сохранён: ${link.download}`);
  };

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
    // открытое меню прячем. Заодно ловим цену под курсором — для пункта
    // «Скопировать цену»
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (Date.now() - lastOverlayRightClickAt < 350) {
        hideCtxMenu();
        return;
      }
      const hit = typeof stageEventPoint === 'function' ? stageEventPoint(e) : null;
      ctxMenuPrice = hit ? hit.point.value : null;
      syncCtxCopyItem();
      showCtxMenu(e.clientX, e.clientY);
    });
    // Клик по пункту: действие произойдёт до закрытия (клик всплывает в
    // document-обработчик ниже — он только прячет меню)
    const bindCtxItem = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    bindCtxItem('tc-ctx-reset', () => resetChartView());
    bindCtxItem('tc-ctx-copy', copyCtxPrice);
    bindCtxItem('tc-ctx-shot', takeChartSnapshot);
    bindCtxItem('tc-ctx-clear', () => window.tcClearOverlays());
    // Закрытие меню: клик где угодно, Escape, изменение размера окна.
    // Тот же клик/Escape гасят и открытые меню дропдаунов типа графика
    // и шкалы цены (hide…Menu вернёт true, только если меню было открыто).
    // Escape — также отмена недостроенной фигуры (как в TradingView:
    // Esc снимает режим рисования) и разоружение взведённого инструмента.
    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — undo/redo разметки: только при
    // видимом разделе, без открытого диалога, ввода в полях и незавершённого
    // рисования
    document.addEventListener('click', (e) => {
      const typeMenu = document.getElementById('tc-type-menu');
      if (typeMenu && typeMenu.classList.contains('open')
        && !(e && e.target && typeof e.target.closest === 'function'
          && e.target.closest('#tc-type-dropdown'))) {
        hideTypeMenu();
      }
      const scaleMenu = document.getElementById('tc-scale-menu');
      if (scaleMenu && scaleMenu.classList.contains('open')
        && !(e && e.target && typeof e.target.closest === 'function'
          && e.target.closest('#tc-scale-dropdown'))) {
        hideScaleMenu();
      }
      const indMenu = document.getElementById('tc-ind-menu');
      if (indMenu && indMenu.classList.contains('open')
        && !(e && e.target && typeof e.target.closest === 'function'
          && e.target.closest('#tc-ind-dropdown'))) {
        hideIndicatorMenu();
      }
      // Меню панели настроек разметки: закрыть при клике мимо панели
      // (клики по триггерам/пунктам не «мимо» — target внутри #tc-draw-settings)
      if (anyDrawSettingsMenuOpen()
        && !(e && e.target && typeof e.target.closest === 'function'
          && e.target.closest('#tc-draw-settings'))) {
        hideDrawSettingsMenus();
      }
      if (ctxMenuOpen) hideCtxMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key === 'Escape') {
        if (hideTypeMenu()) return;
        if (hideScaleMenu()) return;
        if (hideIndicatorMenu()) return;
        // Меню панели настроек разметки — раньше контекстного меню и
        // отмены рисования (как в TV: Esc сначала закрывает меню)
        if (hideDrawSettingsMenus()) return;
        if (ctxMenuOpen) { hideCtxMenu(); return; }
        if (dialogCtx) return; // открытый диалог закроет window-обработчик
        if (cancelActiveDrawing()) {
          e.preventDefault();
          setStatus('Рисование отменено (Escape)');
        }
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      // «z»/«y» любой раскладки: key на русской — «я»/«н», code не зависит
      const isZ = e.code === 'KeyZ' || ['z', 'Z', 'я', 'Я'].includes(e.key);
      const isY = e.code === 'KeyY' || ['y', 'Y', 'н', 'Н'].includes(e.key);
      if (!isZ && !isY) return;
      const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (dialogCtx || isOverlayDrawing() || stageToolDrawing) return;
      if (!chartSectionVisible()) return;
      // Ctrl+Shift+Z и Ctrl+Y — redo, Ctrl+Z — undo
      const wantsRedo = isY || e.shiftKey;
      const done = wantsRedo ? performRedo() : performUndo();
      if (done) {
        e.preventDefault();
        setStatus(wantsRedo ? done.redoMessage : done.undoMessage);
      } else {
        setStatus(wantsRedo
          ? 'Повторять нечего: отменённых операций нет'
          : 'Отменять нечего: разметки на графике нет');
      }
    });
    window.addEventListener('resize', () => { if (ctxMenuOpen) hideCtxMenu(); });
    // Окно изменилось — холст переложится под новый размер (у библиотеки
    // своего слежения за контейнером нет, см. блок resizeChartSoon)
    window.addEventListener('resize', resizeChartSoon);
  };

  // ---- Undo/redo разметки (стрелки в шапке, как в TradingView) ----
  // Стек операций создать/удалить/сдвинуть/очистить: удалённая правым
  // кликом фигура возвращается Ctrl+Z, отменённое создание — Ctrl+Y
  // (или Ctrl+Shift+Z), кнопки-стрелки в шапке дублируют сочетания.
  // Свои мутации (сам undo/redo, отмена рисования по Escape, очистка
  // как операция) не пишутся в стек повторно — guard opsMuted; измеритель
  // и пустая кисть временнЫе, в истории не живут.

  const OPS_LIMIT = 100; // кисть пишет десятки точек — стек конечен
  const undoStack = [];
  const redoStack = [];
  let opsMuted = false; // true — мутации разметки в стек не попадают

  const syncUndoButtons = () => {
    const u = document.getElementById('tc-undo');
    const r = document.getElementById('tc-redo');
    if (u) { u.disabled = !undoStack.length; u.classList.toggle('disabled', !undoStack.length); }
    if (r) { r.disabled = !redoStack.length; r.classList.toggle('disabled', !redoStack.length); }
  };

  const pushOp = (op) => {
    undoStack.push(op);
    if (undoStack.length > OPS_LIMIT) undoStack.shift();
    redoStack.length = 0; // новая операция обрывает ветку redo
    syncUndoButtons();
  };

  const performUndo = () => {
    const op = undoStack.pop();
    if (!op) return null;
    opsMuted = true;
    try { op.undo(); } finally { opsMuted = false; }
    redoStack.push(op);
    syncUndoButtons();
    persistOverlays();
    return op;
  };

  const performRedo = () => {
    const op = redoStack.pop();
    if (!op) return null;
    opsMuted = true;
    try { op.redo(); } finally { opsMuted = false; }
    undoStack.push(op);
    syncUndoButtons();
    persistOverlays();
    return op;
  };

  // Восстановить фигуру из сериализованного вида (undo удаления, redo
  // создания, отмена очистки): точки переводятся как при восстановлении
  // разметки (timestamp/value, «будущие» f:1 — обратно в dataIndex)
  const recreateOverlay = (specs, oldId) => {
    if (!chartInstance || !specs || !specs.name) return null;
    if (oldId != null) overlayIds = overlayIds.filter((x) => x !== oldId);
    const points = convertSpecPoints(specs.points);
    if (!points.length) return null;
    const id = chartInstance.createOverlay({
      name: specs.name,
      extendData: specs.extendData ?? undefined,
      styles: normalizeSpecStyles(specs.styles) ?? undefined,
      points,
      ...overlayCallbacks(),
    });
    if (!id) return null;
    overlayIds.push(id);
    return id;
  };

  // Фабрики операций. currentId/currentIds мутируют: redo создания должно
  // удалить именно воссозданный объект, а не исчезнувший старый
  const opAdd = (id, specs) => {
    const op = {
      kind: 'add',
      currentId: id,
      undoMessage: 'Фигура удалена (отмена создания, Ctrl+Z)',
      redoMessage: 'Создание фигуры повторено',
    };
    op.undo = () => { removeStageOverlay(op.currentId); };
    op.redo = () => { op.currentId = recreateOverlay(specs, op.currentId); };
    return op;
  };

  const opRemove = (id, specs) => {
    const op = {
      kind: 'remove',
      currentId: id,
      undoMessage: 'Удаление отменено — фигура возвращена',
      redoMessage: 'Фигура снова удалена (повтор операции)',
    };
    op.undo = () => { op.currentId = recreateOverlay(specs, op.currentId); };
    op.redo = () => { removeStageOverlay(op.currentId); };
    return op;
  };

  const opMove = (id, before, after) => {
    const op = {
      kind: 'move',
      currentId: id,
      undoMessage: 'Перетаскивание фигуры отменено',
      redoMessage: 'Перетаскивание фигуры повторено',
    };
    const apply = (specs) => {
      const ov = chartInstance && chartInstance.getOverlayById(op.currentId);
      if (!ov || typeof ov.setPoints !== 'function') return;
      ov.setPoints(convertSpecPoints(specs.points));
      redrawOverlayPane();
    };
    op.undo = () => apply(before);
    op.redo = () => apply(after);
    return op;
  };

  const opClear = (specsList) => {
    const op = {
      kind: 'clear',
      currentIds: [],
      undoMessage: 'Очистка отменена — разметка восстановлена',
      redoMessage: 'Разметка снова удалена (повтор операции)',
    };
    op.undo = () => {
      op.currentIds = specsList.map((s) => recreateOverlay(s)).filter(Boolean);
    };
    op.redo = () => {
      for (const id of op.currentIds) removeStageOverlay(id);
      op.currentIds = [];
    };
    return op;
  };

  window.tcUndo = function () {
    if (!chartInstance) return false;
    const op = performUndo();
    setStatus(op ? op.undoMessage : 'Отменять нечего: разметки на графике нет');
    return !!op;
  };

  window.tcRedo = function () {
    if (!chartInstance) return false;
    const op = performRedo();
    setStatus(op ? op.redoMessage : 'Повторять нечего: отменённых операций нет');
    return !!op;
  };

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

  // Сериализованный вид одной фигуры (для localStorage и стека undo/redo)
  const overlaySpec = (o) => {
    if (!o) return null;
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
    // Styles инстанса (цвет/толщина/стиль из панели настроек разметки):
    // непустой объект — в сериализацию (с миграцией 'dash' → 'dashed'),
    // выбор переживает перезагрузку
    const styles = o.styles && typeof o.styles === 'object'
      && Object.keys(o.styles).length ? normalizeSpecStyles(o.styles) : null;
    return points.length ? { name: o.name, extendData: o.extendData ?? null, styles, points } : null;
  };

  const serializeOverlays = () => {
    if (!chartInstance) return [];
    const specs = [];
    overlayIds = overlayIds.filter(id => {
      const o = chartInstance.getOverlayById(id);
      if (!o) return false; // объект удалён (в т.ч. контекстным меню) — забываем id
      if (o.name === 'tc-measure') return true; // жив, но временнЫй — не сохраняем
      const spec = overlaySpec(o);
      if (spec) specs.push(spec);
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

  // Колбэки жизненного цикла overlay → автосохранение и стек undo/redo.
  // onDrawEnd — фигура достроена (операция «создать»), onPressedMoveStart/
  // End — точку тащат/отпустили (операция «сдвинуть»: до-снимок на старте,
  // после-снимок на финише), onDeselected — сняли выделение (страховка
  // после правок), onRemoved — удаление любым способом (правый клик,
  // контекстное меню) — операция «удалить», которую вернёт Ctrl+Z.
  // lastDrawEndAt — guard сброса вида: двойной клик сразу после достройки
  // фигуры (двухкликовые инструменты) — часть рисования, а не «Reset chart».

  // ВременнЫе объекты, удаление которых историю не пополняет: измеритель
  // и пустая кисть (клик без движения — рисовать нечего)
  const isTemporaryOverlay = (o) => !o || o.name === 'tc-measure'
    || (o.name === 'tc-brush' && (!o.points || o.points.length < 3));

  const moveBeforeSpecs = new Map(); // id фигуры → сериализованный вид до перетаскивания

  const overlayCallbacks = () => ({
    onDrawEnd: (e) => {
      lastDrawEndAt = Date.now();
      clearToolActive();
      if (!opsMuted && e && e.overlay && !isTemporaryOverlay(e.overlay)) {
        const specs = overlaySpec(e.overlay);
        if (specs) pushOp(opAdd(e.overlay.id, specs));
      }
      persistOverlays();
      // Достроенная фигура выделяется тем же кликом — показываем панель
      // настроек сразу («при нанесении разметки», как в TradingView)
      if (e && e.overlay) showDrawSettings(e.overlay);
    },
    // Выделение фигуры (клик по ней) — панель настроек у фигуры; клик
    // мимо (onDeselected) или удаление (onRemoved) панель закрывают
    onSelected: (e) => { if (e && e.overlay) showDrawSettings(e.overlay); },
    onDeselected: () => {
      hideDrawSettings();
      persistOverlays(); // страховка после правок (как раньше)
    },
    onPressedMoveStart: (e) => {
      if (opsMuted || !e || !e.overlay) return;
      moveBeforeSpecs.set(e.overlay.id, overlaySpec(e.overlay));
    },
    onPressedMoveEnd: (e) => {
      if (!opsMuted && e && e.overlay && !isTemporaryOverlay(e.overlay)) {
        const before = moveBeforeSpecs.get(e.overlay.id);
        const after = overlaySpec(e.overlay);
        if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
          pushOp(opMove(e.overlay.id, before, after));
        }
      }
      moveBeforeSpecs.delete(e && e.overlay ? e.overlay.id : undefined);
      persistOverlays();
    },
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
      hideDrawSettings();
      // Удаление фигуры любым способом становится операцией — Ctrl+Z её
      // вернёт. Свои снятия (undo/redo, отмена рисования, очистка) замьючены
      if (!opsMuted && id != null && !isTemporaryOverlay(e.overlay)) {
        const specs = overlaySpec(e.overlay);
        if (specs) pushOp(opRemove(id, specs));
      }
      persistOverlays();
    },
  });

  // Точки сериализованного вида → точки живого объекта: timestamp/value
  // рисуются сразу, «будущие» (f:1 — за последней свечой) переводятся
  // в dataIndex: timestampToDataIndex в 9.6 зажимает к ближайшему бару,
  // поэтому время в индекс переводим сами — точка останется в правом поле
  const convertSpecPoints = (specPoints) => (specPoints || []).map(p => {
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
    return { timestamp: p.timestamp, value: p.value };
  }).filter(Boolean);

  const restoreOverlays = (ticker) => {
    let restored = 0;
    for (const s of loadSavedOverlays(ticker)) {
      if (!s || !s.name || !Array.isArray(s.points) || !s.points.length) continue;
      // Измеритель — временнЫй объект, в localStorage попадать не должен
      // (страховка на случай разметки из старых сборок)
      if (s.name === 'tc-measure') continue;
      const points = convertSpecPoints(s.points);
      if (!points.length) continue;
      const id = chartInstance.createOverlay({
        name: s.name,
        extendData: s.extendData ?? undefined,
        styles: normalizeSpecStyles(s.styles) ?? undefined,
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
    pollPeriod = null;
  };

  // Период поллинга MOEX — по фактическому источнику свечей: apim без
  // задержки опрашивается чаще (15 с), лагающий анонимный ISS — раз в минуту
  const moexPollPeriod = () => (lastSource === 'apim' ? POLL_MS.moexApim : POLL_MS.moex);

  // Примечание об источнике в статусе графика — по фактическому источнику
  // последней подкачки (source из ответа бэкенда), не по тикеру: MOEX-акции
  // с токеном Algopack идут через apim без задержки, а анонимный ISS —
  // с лагом ~15 мин; source может смениться на ходу (отказ токена)
  const sourceNote = (ticker) => {
    if (isBinanceTicker(ticker)) return 'данные Binance (реальное время)';
    return lastSource === 'apim'
      ? 'данные MOEX Algopack (реальное время)'
      : 'данные ISS с задержкой ~15 мин';
  };

  // ---- Шапка символа и легенда OHLCV (облик TradingView) ----
  // Шапка над графиком: код · имя (name из candles-ответа бэкенда) · ТФ +
  // крупная последняя цена с цветной дельтой к предыдущей свече. Легенда
  // поверх холста показывает O/H/L/C/Vol свечи под курсором (crosshair),
  // без курсора — последнюю. Значения окрашены по направлению свечи.

  // Дублирующий ТФ из шапки убран (активный ТФ виден на сегменте кнопок),
  // прежние подписи TF_LABELS больше не нужны

  // ---- Отсчёт до закрытия свечи (тег «287,45 · 00:32:41» в TradingView) ----
  // Закрытие текущего бара — следующая граница сетки ТФ ПОСЛЕ текущего
  // момента, построенная КАЛЕНДАРНЫМ шагом от открытия последней свечи
  // (+1 час, +1 сутки, +1 неделя к понедельнику, +1 месяц к 1-му числу).
  // Наивный «lastTs + интервал между двумя последними свечами» ломается
  // на разрывах сессий и выходных: часовые бары после закрытия рынка
  // уходят в минус (отсчёт пропадает), суточные свечи через выходные
  // дают интервал 96 ч, месячные дрейфуют (в месяце 28–31 день).
  // Проекция по календарю показывает отсчёт на ВСЕХ ТФ, как в TradingView:
  // после закрытия рынка он идёт к следующей границе (на часовых — «до
  // открытия следующего бара»), а у баров длиннее суток в метке появляется
  // префикс дней «Nд ЧЧ:ММ:СС». Скрытый раздел и фоновая вкладка не тикают.

  let countdownTimer = null;

  // Календарный шаг сетки ТФ от метки ts к следующей границе. Шаг от
  // самой метки свечи (а не от «сейчас») сохраняет привязку сетки к её
  // часовому поясу: у Binance метки UTC («…Z») — сутки прибавляются к
  // полуночи UTC, у ISS — к локальной; у недельных и месячных баров
  // сдвиг на часовые пояса не теряется.
  const calendarStep = (ts) => {
    const d = new Date(ts);
    switch (currentInterval) {
      case 60: // часовые бары открываются в начале часа
        d.setMinutes(0, 0, 0);
        return d.getTime() + 3600000;
      case 24: // суточные — в полночь
        d.setHours(0, 0, 0, 0);
        return d.getTime() + 86400000;
      case 31: // месячные — 1-го числа следующего месяца
        return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      default: // 7: недельные открываются в понедельник (0 = пн)
        d.setHours(0, 0, 0, 0);
        return d.getTime() - ((d.getDay() + 6) % 7) * 86400000 + 7 * 86400000;
    }
  };

  // Ближайшая граница впереди: один шаг закрывает текущий бар; если его
  // закрытие уже позади (разрыв сессий, остывшие данные) — шагаем дальше
  // до границы в будущем (лимит — страховка от вечного цикла)
  const nextBarCloseTs = () => {
    if (lastTs == null) return null;
    let ts = calendarStep(lastTs);
    for (let i = 0; ts <= Date.now() && i < 1000; i++) ts = calendarStep(ts);
    return ts;
  };

  // Компактный отсчёт из двух старших единиц: «6д15ч» (недельные/месячные
  // бары), «3ч40м» (дневные), «23м15с» (часовые) — тик остаётся живым и на
  // внутридневных ТФ, а длинные остатки не занимают пол-оси
  const fmtCountdown = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (days > 0) return `${days}д${hours}ч`;
    if (hours > 0) return `${hours}ч${pad2(minutes)}м`;
    return `${minutes}м${pad2(seconds)}с`;
  };

  const renderCountdown = () => {
    const el = document.getElementById('tc-sym-countdown');
    if (!el) return;
    let text = '';
    if (lastTs != null && chartSectionVisible() && !document.hidden) {
      const closeTs = nextBarCloseTs();
      const remain = closeTs != null ? closeTs - Date.now() : null;
      if (remain != null && remain > 0) text = fmtCountdown(remain);
    }
    if (el.textContent !== text) el.textContent = text;
    syncAxisPriceTag();
  };

  // Позиция курсора на холсте ({x, y} в координатах контейнера графика)
  // — ведётся в pointermove/pointerleave (см. bindChartPointerTracking).
  // Нужна, чтобы плашка последней цены уступала место метке цены
  // кроссхейра, когда обе оказываются на одной высоте
  let chartPointer = null;

  // Половина высоты метки цены кроссхейра на оси (рисует библиотека на
  // канвасе): шрифт 12 + паддинги 4+4 + рамка 2×1 ≈ 22 px
  const CROSSHAIR_LABEL_HALF = 11;

  const onChartPointerMove = (e) => {
    const dom = chartInstance && typeof chartInstance.getDom === 'function'
      ? chartInstance.getDom() : document.getElementById('watchlist-kline');
    const rect = dom && typeof dom.getBoundingClientRect === 'function'
      ? dom.getBoundingClientRect() : null;
    if (!rect || e.clientX == null) return;
    chartPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    syncAxisPriceTag();
  };

  const onChartPointerLeave = () => {
    if (chartPointer == null) return;
    chartPointer = null;
    syncAxisPriceTag();
  };

  // Слежение за курсором на холсте: привязывается один раз к контейнеру
  // графика (наследник — канвасы библиотеки). pointerleave = кроссхейр
  // скрыт библиотекой (mouseLeaveEvent → setCrosshair()) — плашка
  // возвращается на свою цену
  const bindChartPointerTracking = () => {
    const dom = document.getElementById('watchlist-kline');
    if (!dom || dom.dataset.chartPointerBound) return;
    dom.dataset.chartPointerBound = '1';
    dom.addEventListener('pointermove', onChartPointerMove);
    dom.addEventListener('pointerleave', onChartPointerLeave);
  };

  // Поле «цена + отсчёт» на шкале цены — ОДНА плашка в цвет направления
  // последней свечи: сверху цена, отсчёт — просто строкой ниже (как тег
  // «287,45 · 00:32:41» в TradingView, только колонкой). Встроенный тег
  // цены библиотеки отключён (priceMark.last.show=false) — иначе два
  // тега наслаивались бы. Позиция по Y — внутреннее API оси главной
  // панели (convertToPixel последней цены), плашка центрируется на цене.
  // По X плашка вровень с оси цены: габариты виджета оси даёт публичный
  // getSize(paneId, 'yAxis') — ширина плашки равна ширине оси, правый
  // край прижат к краю оси (как тег цены в TradingView), вертикаль не
  // выходит за пределы панели свечей. API недоступен — прежнее поведение:
  // плашка у правого края холста. Цена вне видимого диапазона — поле
  // прячется. Обновляется раз в секунду, на сдвиг/зум (подписки в init)
  // и на каждое движение курсора по холсту — между кадрами положение
  // может отставать на пиксели.
  const syncAxisPriceTag = () => {
    const tag = document.getElementById('tc-axis-price-tag');
    if (!tag) return;
    const list = chartInstance ? chartInstance.getDataList() : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last || lastTs == null || !chartSectionVisible()) {
      tag.style.top = '-9999px';
      return;
    }
    const axis = candlePaneAxis();
    const px = axis && typeof axis.convertToPixel === 'function'
      ? axis.convertToPixel(last.close) : null;
    const stage = document.getElementById('tc-chart-stage');
    const stageW = stage ? stage.clientWidth : 0;
    const stageH = stage ? stage.clientHeight : 0;
    if (!Number.isFinite(px) || stageH <= 0) { tag.style.top = '-9999px'; return; }
    // Габариты оси цены: getSize(paneId, 'yAxis') — {left, top, width,
    // height} координат контейнера (поля right/bottom/top у виджета оси
    // не заполняются — остаются нулями из фабрики bounding, правый край и
    // низ считаем сами). top/bottom = пределы панели свечей — плашка не
    // заезжает на ось времени и не улетает выше панели.
    let topBound = 2;
    let bottomBound = stageH;
    let axisRect = null;
    try {
      const b = typeof chartInstance.getSize === 'function'
        ? chartInstance.getSize('candle_pane', 'yAxis') : null;
      if (b && Number.isFinite(b.left) && Number.isFinite(b.width) && b.width > 0) axisRect = b;
    } catch (e) { /* internals недоступны — остаётся прижатие к краю холста */ }
    let widthStyle = '';
    let rightStyle = '';
    if (axisRect) {
      const axisRight = axisRect.left + axisRect.width;
      const axisTop = Number.isFinite(axisRect.top) ? axisRect.top : 0;
      const axisBottom = axisTop + (Number.isFinite(axisRect.height) ? axisRect.height : stageH);
      widthStyle = `${Math.round(axisRect.width)}px`;
      rightStyle = `${Math.max(0, Math.round(stageW - axisRight))}px`;
      topBound = axisTop;
      bottomBound = axisBottom;
    } // иначе — CSS-дефолт (right: 4px), точную геометрию дать нечем
    // Метка цены кроссхейра на оси главной панели: библиотека рисует её,
    // пока курсор над областью свечей этой панели (или идёт прокрутка
    // холста с зажатой кнопкой). DOM-плашка стоит поверх канваса —
    // на одной высоте с меткой она закрывает цену под курсором. Как в
    // TradingView: плашка отступает на минимальный зазор от метки (метка
    // приоритетна — ею водит пользователь), а у края панели, где обе не
    // помещаются, прячется целиком — иначе снова перекроет метку.
    let crosshairY = null;
    if (chartPointer) {
      try {
        const main = typeof chartInstance.getSize === 'function'
          ? chartInstance.getSize('candle_pane', 'main') : null;
        if (main && Number.isFinite(main.left) && Number.isFinite(main.width)
          && Number.isFinite(main.top) && Number.isFinite(main.height)
          && chartPointer.x >= main.left && chartPointer.x <= main.left + main.width
          && chartPointer.y >= main.top && chartPointer.y <= main.top + main.height) {
          crosshairY = chartPointer.y;
        }
      } catch (e) { /* internals недоступны — плашка не уступает */ }
    }
    // Центрируем плашку (~34px) на цене, у краёв панели прижимаем внутрь
    const half = 17;
    let center = px;
    let gap = 0; // зазор, на который плашка отступила от метки кроссхейра
    if (crosshairY != null) {
      gap = half + CROSSHAIR_LABEL_HALF;
      const dy = crosshairY - px;
      if (Math.abs(dy) < gap) center = dy >= 0 ? crosshairY - gap : crosshairY + gap;
      else gap = 0;
    }
    const top = Math.min(Math.max(center - half, topBound + 2), Math.max(topBound + 2, bottomBound - half * 2 - 2));
    const hidden = gap > 0 && Math.abs(crosshairY - (top + half)) < gap;
    // Пишем только изменившиеся свойства: sync зовётся на каждом
    // движении курсора, лишние записи стилей дают лишние reflow
    const topStyle = `${Math.round(top)}px`;
    if (tag.style.top !== topStyle) tag.style.top = topStyle;
    if (tag.style.width !== widthStyle) tag.style.width = widthStyle;
    if (tag.style.right !== rightStyle) tag.style.right = rightStyle;
    if (tag.style.visibility !== (hidden ? 'hidden' : '')) tag.style.visibility = hidden ? 'hidden' : '';
    const up = last.close >= last.open;
    if (tag.classList.contains('up') !== up) tag.classList.toggle('up', up);
    if (tag.classList.contains('down') !== !up) tag.classList.toggle('down', !up);
  };

  const startCountdownTimer = () => {
    if (countdownTimer != null) return; // идемпотентно: DOMContentLoaded бывает не раз
    countdownTimer = setInterval(renderCountdown, 1000);
  };

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
    // Триллионы реальны: суточный оборот SHIBUSDT печатался «2355.79B»
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
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

  // Тикер для поля шапки: как есть (BINANCE:BTCUSDT остаётся с префиксом —
  // это готовый к вводу код), без технического MOEX: (его срезает
  // normalizeTicker). Поле под фокусом не трогаем — пользователь печатает
  const syncTickerInput = (ticker) => {
    const inp = document.getElementById('tc-sym-input');
    if (!inp || document.activeElement === inp) return;
    if (inp.value !== ticker) inp.value = ticker || '';
  };

  // Код показываем сразу (ещё до ответа бэкенда), имя — прочерком.
  // Дублирующий ТФ из шапки убран (активный ТФ виден на сегменте)
  const setHeaderSymbol = (ticker, interval) => {
    syncTickerInput(ticker);
    const name = document.getElementById('tc-sym-name');
    if (name) { name.textContent = ''; name.style.display = 'none'; }
    // Цена прежнего тикера в поле на шкале гасится сразу — свежая
    // придёт с первыми данными (updateSymbolQuote)
    const price = document.getElementById('tc-sym-price');
    if (price) price.textContent = '';
    const change = document.getElementById('tc-leg-change');
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

  // ---- Изменение в легенде — как в списке watchlist ----
  // Список показывает официальную дневную дельту источника (MOEX:
  // LASTTOPREVPRICE/CHANGE к цене прошлого закрытия, крипта: изменение
  // за 24 ч) — ручка /api/prices/{symbol}. Дельта «последняя свеча минус
  // предыдущая» отличается от неё даже на дневном ТФ: у MOEX вечерняя
  // сессия вливается в свечу следующего дня, и close предыдущей свечи не
  // равен официальной цене закрытия (SBER: -1.06 по свечам против -1,17
  // в списке). Поэтому дельту берём из той же ручки, что и список
  // (fetchSymbolQuote, обновляется на поллинге), а расчёт по свечам
  // остаётся фолбэком на случай сбоя ручки.

  let dailyQuote = null;       // {changeValue, changeDay} текущего тикера (как в списке)
  let dailyQuoteTicker = null; // тикер, к которому относится dailyQuote — защита от гонки смены

  // ru-формат числа как в списке (ui.js formatNumber): запятая, фикс. знаки
  const fmtListNum = (n, decimals) => Number(n).toLocaleString('ru-RU',
    { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  // Дельта со знаком «+/-» в формате списка (ui.js formatChange):
  // проценты — 2 знака, числа — адаптивная точность инструмента
  // (window.autoPriceDecimals из ui.js: дешёвая крипта при фикс. 4 знаках
  // печаталась «0,0000»). decimalsOverride — явная десятичность (фолбэк
  // по свечам печатает дельту с точностью инструмента, как раньше)
  const fmtListChange = (v, isPercent, decimalsOverride) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const decimals = decimalsOverride != null
      ? decimalsOverride
      : (isPercent ? 2
        : (typeof window.autoPriceDecimals === 'function'
          ? window.autoPriceDecimals(n)
          : (Math.abs(n) < 1 ? 4 : 2)));
    const sign = n >= 0 ? '+' : '';
    return `${sign}${fmtListNum(n, decimals)}`;
  };

  // Котировка из ручки списка: changeValue/changeDay официальной дельты.
  // Свой try/catch — сбой ручки не мешает графику (легенда останется
  // на расчёте по свечам). Запускается до запроса свечей в load/poll —
  // ответ применяется, только если тикер к тому моменту не сменился
  // (загружен или ещё грузится — ответ часто приходит раньше свечей).
  const isQuoteTickerCurrent = (ticker) => lastTicker === ticker
    || (typeof loadInFlightKey === 'string' && loadInFlightKey.startsWith(`${ticker}|`));

  const fetchSymbolQuote = (ticker) => {
    const url = `${API_BASE}/api/prices/${encodeURIComponent(ticker)}`;
    return window.fetchWithTimeout(url, {}, 30000)
      .then(r => r.json())
      .then(data => {
        if (data && !data.error && isQuoteTickerCurrent(ticker)) {
          dailyQuoteTicker = ticker;
          dailyQuote = {
            changeValue: Number.isFinite(Number(data.changeValue)) ? Number(data.changeValue) : null,
            changeDay: Number.isFinite(Number(data.changeDay)) ? Number(data.changeDay) : null,
          };
          // Легенда обновится сразу, не дожидаясь следующего тика поллинга
          updateSymbolQuote(chartInstance ? chartInstance.getDataList() : []);
        }
      })
      .catch(e => { console.debug('Котировка для легенды не получена:', e); });
  };

  // Дельта в легенде на холсте (после «Закр»). Источник — котировка из
  // ручки списка (dailyQuote): те же числа и тот же ru-формат, что в
  // строке watchlist («-1,17 (-0,40%)»). Нет котировки (ручка сбойнула/
  // ещё грузится) — расчёт по последним двум свечам того же формата.
  // Текущую цену показывает цветной тег на шкале цены
  const updateSymbolQuote = (list) => {
    const priceEl = document.getElementById('tc-sym-price');
    const changeEl = document.getElementById('tc-leg-change');
    // Цена — верхняя строка поля «цена + отсчёт» на шкале цены: всегда из
    // данных графика (последняя свеча), независимо от источника дельты
    if (priceEl && list && list.length) priceEl.textContent = fmtNum(list[list.length - 1].close);
    if (!changeEl) return;
    const render = (text, up) => {
      changeEl.textContent = text || '';
      changeEl.classList.toggle('up', !!text && up);
      changeEl.classList.toggle('down', !!text && !up);
    };
    // Котировка списка: value/pct приходят готовыми — только формат.
    // Окрашивание — по направлению дельты (как в списке)
    if (dailyQuote && dailyQuoteTicker === lastTicker
      && (dailyQuote.changeValue != null || dailyQuote.changeDay != null)) {
      const valuePart = fmtListChange(dailyQuote.changeValue, false);
      const pctPart = fmtListChange(dailyQuote.changeDay, true);
      const up = (dailyQuote.changeValue ?? dailyQuote.changeDay) >= 0;
      render(`${valuePart || '—'} (${pctPart || '—'}%)`, up);
    } else {
      // Фолбэк: дельта к предыдущей свече (последний известный ориентир)
      if (!list || !list.length) { render('', false); return; }
      const last = list[list.length - 1];
      const prev = list.length > 1 ? list[list.length - 2] : null;
      if (!prev || !Number.isFinite(prev.close) || !prev.close) { render('', false); return; }
      const delta = last.close - prev.close;
      const pct = (delta / prev.close) * 100;
      render(`${fmtListChange(delta, false, pricePrecision)} (${fmtListChange(pct, true)}%)`, delta >= 0);
    }
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
    syncVolumeLegend();
  };

  // Строка «Объем N» в легенде живёт вместе с гистограммой: чип убран —
  // строка и её ⚙/× (закрытие и настройки на графике, рядом с названием —
  // как у прочих индикаторов) прячутся, гистограмма возвращена — показываются
  const syncVolumeLegend = () => {
    const on = indicators.has(VOL_MAIN);
    const row = document.getElementById('tc-leg-volume-row');
    if (row) row.style.display = on ? '' : 'none';
    const close = document.getElementById('tc-leg-volume-close');
    if (close) close.style.display = on ? '' : 'none';
    const gear = document.getElementById('tc-leg-volume-gear');
    if (gear) gear.style.display = on ? '' : 'none';
  };

  // Метки объёма на оси цены больше нет: значение под курсором показывает
  // только строка «Объем» легенды OHLCV (тег на оси дублировал её)

  // ---- Пересчёт размеров холста ----
  // KLineChart 9.6 не следит за контейнером сам (ни ResizeObserver, ни
  // слушателя window-resize внутри библиотеки): холст перераскладывается
  // только явным resize(). Без этого после загрузки данных шапка карточки
  // при появлении цены/легенды могла сменить высоту переноса строк — холст
  // оставался в старых габаритах и ось времени уезжала за край окна.
  let resizeChartTimer = null;

  const resizeChartSoon = () => {
    if (!chartInstance || typeof chartInstance.resize !== 'function') return;
    if (resizeChartTimer != null) clearTimeout(resizeChartTimer);
    resizeChartTimer = setTimeout(() => {
      resizeChartTimer = null;
      if (chartInstance && typeof chartInstance.resize === 'function') {
        chartInstance.resize();
        // Панели переложились — легенды индикаторов догоняют верх своей панели
        updateIndicatorLegendPositions();
        // Геометрия оси цены сменилась вместе с холстом — плашка
        // «цена + отсчёт» выравнивается по новой оси не дожидаясь
        // секундного тика (syncAxisPriceTag вызывается и оттуда)
        syncAxisPriceTag();
        // Панель настроек разметки держится у своей фигуры — позиция
        // пересчитывается под новые габариты холста
        repositionDrawSettings();
      }
    }, 50);
  };

  // Легенда + цена из текущих данных графика (последняя свеча). Заодно
  // пересчитываем точность инструмента (шкала могла уйти с новыми данными)
  // и точность осей под-окон — шкалы сдвинулись с новыми данными;
  // значения в легендах индикаторов — по последней свече; отсчёт до
  // закрытия бара перезапускается вместе с lastTs; высота шапки
  // с обновлёнными значениями могла смениться — догоняем размер холста
  const refreshChartReadouts = () => {
    if (!chartInstance) return;
    const list = chartInstance.getDataList();
    const lastBar = list.length ? list[list.length - 1] : null;
    applyPricePrecision(list);
    renderLegend(lastBar);
    renderIndicatorLegendValues(lastBar);
    updateIndicatorLegendPositions();
    updateSymbolQuote(list);
    renderCountdown();
    for (const name of indicators.keys()) tuneSubPaneAxisPrecision(name);
    resizeChartSoon();
  };

  const pollOnce = async (ticker, interval) => {
    if (!chartInstance || lastTs == null) return;
    try {
      // from = дата последней свечи в локальном времени: бэкенд перекачает
      // её (свеча ещё формируется) и всё, что новее. Чужой пояс даёт
      // смещение на день — безвредно, лишняя свеча отфильтруется ниже.
      const from = fmtDay(new Date(lastTs));
      // Дельта легенды держится в одном темпе со списком: котировка
      // официальной дельты запрашивается тем же тиком, что и свечи
      fetchSymbolQuote(ticker);
      const url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}`
        + `?interval=${interval}&from=${from}`;
      const response = await window.fetchWithTimeout(url, {}, 30000);
      const data = await response.json();
      if (data.error || !data.candles || !data.candles.length) return;

      // Источник подкачки мог смениться (apim отклонил токен — бэкенд
      // откатился на анонимный ISS, и наоборот): запоминаем и перезапускаем
      // поллинг с периодом нового источника — ISS не дёргаем каждые 15 с.
      // Текущий тик дорабатывает до конца: clearInterval не мешает уже
      // идущему колбэку, свечи из ответа терять не хотелось бы
      if (data.source && data.source !== lastSource) {
        lastSource = data.source;
        if (!isBinanceTicker(ticker) && moexPollPeriod() !== pollPeriod) {
          startPolling(ticker, interval);
        }
      }

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
    const period = isBinanceTicker(ticker) ? POLL_MS.binance : moexPollPeriod();
    pollPeriod = period;
    pollTimer = setInterval(() => {
      // Данные сменились (ввели другой тикер/ТФ) — этот таймер больше не нужен
      if (pollKey !== key) { stopPolling(); return; }
      // Пропускаем тик, пока раздел или вкладка не видны — гасим фоновую нагрузку
      const el = document.getElementById('watchlist-kline');
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

  // Загрузка свечей выбранного в списке тикера (символ приходит из
  // ui.js createChart — клик по строке, смена списка, открытие раздела).
  // Пока раздел скрыт (контейнер без размеров), запрос откладывается до
  // первого показа — см. pendingSymbol и wlChartSectionShown.
  let loadInFlightKey = null; // 'TICKER|interval' текущей загрузки — дедуп повторных вызовов

  window.wlChartLoad = async function (symbol) {
    const ticker = normalizeTicker(symbol);
    if (!ticker) {
      setStatus('Тикер не выбран: кликните по строке списка', true);
      return;
    }
    // Поле тикера в шапке отражает выбор сразу (и до фактической загрузки,
    // отложенной до показа раздела)
    syncTickerInput(ticker);
    pendingSymbol = ticker;
    if (!chartSectionVisible()) return;
    // Раздел виден — загрузка началась: отложка больше не нужна
    pendingSymbol = null;
    const interval = currentInterval;
    const key = `${ticker}|${interval}`;
    // Тот же тикер/ТФ уже грузится (клик по выбранной строке, страховка
    // из navigateTo поверх render()) — второй запрос не нужен
    if (loadInFlightKey === key) return;
    loadInFlightKey = key;
    const done = () => { if (loadInFlightKey === key) loadInFlightKey = null; };

    const instance = getChartInstance();
    if (!instance) { done(); return; }

    setStatus(`Загрузка свечей ${ticker}…`);

    // Сравнения прежнего графика: спецификации сохраняются по тикеру
    // (вернутся при возврате к нему), линии снимаются — их данные
    // привязаны к интервалу и набору свечей прежнего графика
    const comparePrevTicker = lastTicker;
    if (comparePrevTicker) {
      saveCompareSpecs(comparePrevTicker, serializeCompareSpecs());
      for (const name of [...compareSeries.keys()]) {
        try { instance.removeIndicator('candle_pane', name); } catch (e) { /* уже удалён */ }
      }
      compareSeries.clear();
    }

    // Дельта для легенды — из ручки списка (см. блок над updateSymbolQuote):
    // прежняя котировка сбрасывается сразу, свежая придёт параллельно свечам
    dailyQuote = null;
    dailyQuoteTicker = null;
    fetchSymbolQuote(ticker);

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

      // Источник свежей подкачки ('apim'|'iss'|'binance'): заметка в статусе
      // и период поллинга MOEX подстраиваются по нему. В пути фолбэка
      // (отдача накопленного хранилища) source нет — данные могут быть
      // устаревшими, прежнее значение сбрасываем
      lastSource = data.source || null;

      // За время запроса выбрали другой тикер/ТФ — ответ уже не к этому графику
      if (loadInFlightKey !== key) return;

      if (data.error) {
        setStatus(`Ошибка: ${data.error}`, true);
        done();
        return;
      }
      if (!data.candles || !data.candles.length) {
        setStatus(`Для тикера ${ticker} свечи не найдены`, true);
        done();
        return;
      }

      // Шапка символа: поле тикера + имя инструмента (name из candles-ответа)
      setHeaderSymbol(ticker);
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
        // Стек undo/redo относится к разметке прежнего тикера — история
        // не должна «переезжать» на чужой график
        undoStack.length = 0;
        redoStack.length = 0;
        syncUndoButtons();
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
      // Шапка (цена/дельта) и легенда — по свежим данным
      refreshChartReadouts();

      // Доборка старых экранов при скролле влево (переввод callback — идемпотентно)
      instance.loadMore((oldestTs) => loadMoreHistory(oldestTs));

      const restored = symbolChanged ? restoreOverlays(ticker) : 0;
      startPolling(ticker, interval);
      // Сохранённые линии сравнения этого тикера — поверх свежих данных
      // (не ждём: tcAddCompare сам проверит, что график не сменился)
      restoreCompares(ticker);

      const liveNote = isBinanceTicker(ticker)
        ? `автообновление каждые ${POLL_MS.binance / 1000} с`
        : `автообновление каждые ${moexPollPeriod() / 1000} с`;
      // note бэкенда — деградация: источник недоступен, отдаём накопленную
      // историю (может быть устаревшей). Показываем предупреждением.
      const base = `График ${ticker} · свечей: ${klineData.length} · ${sourceNote(ticker)} · ${liveNote}`;
      if (data.note) setStatus(`⚠ ${data.note} — ${base}`, false, true);
      else setStatus(restored ? `${base} · разметка восстановлена: ${restored}` : base);
      done();
    } catch (e) {
      done();
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
    // Как в TradingView: клик по ТФ сразу перезагружает график выбранного тикера
    if (lastTicker) window.wlChartLoad(lastTicker);
    else setStatus(`Таймфрейм: ${document.getElementById(`tc-tf-${value}`)?.textContent || value}`);
  };

  // ---- Кисть и измеритель: press-drag захват на холсте (как в TV) ----
  // KLineChart строит фигуры по кликам и промежуточных точек пути не
  // даёт, поэтому для кисти и измерителя захват ведём сами: pointerdown
  // перехватывается на .tc-chart-stage в фазе CAPTURE (stopPropagation
  // не даёт библиотеке начать прокрутку графика), pointermove/pointerup —
  // на window, чтобы рисование не срывалось при выходе курсора за край
  // (и на тач-устройствах — см. Pointer Events в bindStageTools).
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
      : document.getElementById('watchlist-kline');
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

  // Снятие объекта без записи в историю разметки (undo/redo-движок,
  // отмена рисования, пустая кисть — свои мутации в стек не попадают)
  const removeStageOverlaySilently = (id) => {
    if (id == null) return;
    const wasMuted = opsMuted;
    opsMuted = true;
    try { removeStageOverlay(id); } finally { opsMuted = wasMuted; }
  };

  // Escape как в TradingView: снимает режим рисования. Недостроенная
  // (progress-режим библиотеки) фигура удаляется — removeOverlay по id
  // прогресс-объекта в 9.6 сам сбрасывает _progressInstanceInfo; идущий
  // press-drag захват кисти/измерителя обрывается; взведённый, но ещё
  // не начавший рисовать инструмент разоружается. Возвращает true, если
  // что-то было отменено (для статус-сообщения)
  const cancelActiveDrawing = () => {
    if (!chartInstance) return false;
    if (stageToolDrawing) {
      stageToolDrawing = false;
      const id = stageToolOverlayId;
      stageToolOverlayId = null;
      lastCaptureXY = null;
      if (id === measureLiveId) measureLiveId = null;
      disarmStageTool();
      removeStageOverlaySilently(id);
      return true;
    }
    const info = progressDrawingInfo();
    if (info && info.instance) {
      disarmStageTool();
      removeStageOverlaySilently(info.instance.id);
      return true;
    }
    if (armedStageTool) {
      disarmStageTool();
      return true;
    }
    return false;
  };

  const onStageMouseDown = (e) => {
    // Клик по панели настроек разметки — не рисование (кисть/измеритель
    // не стартуют, «висящее» измерение не убирается)
    if (inDrawSettings(e)) return;
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
      // Готовый путь кисти — постоянная разметка: сохраняем по тикеру и
      // пишем операцию «создать» (Ctrl+Z уберёт её, Ctrl+Y вернёт)
      persistOverlays();
      const specs = overlaySpec(ov);
      if (specs) pushOp(opAdd(id, specs));
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
    // Клик по панели настроек — не «догоняющий клик» фигуры
    if (inDrawSettings(e)) return;
    stageClickDownXY = e && (e.button === undefined || e.button === 0)
      ? { x: e.clientX, y: e.clientY }
      : null;
  };

  const onStageClickUp = (e) => {
    if (inDrawSettings(e)) return;
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
    // Pointer Events вместо мышиных событий: кисть/измеритель и клики
    // рисования одинаково работают на мыши, тач-экране и стилусе
    // (touch-action: none на холсте гасит браузерные жесты). pointercancel
    // обрывает захват как отпускание — рисование не «залипает»
    stage.addEventListener('pointerdown', onStageMouseDown, true);
    window.addEventListener('pointermove', onStageMouseMove);
    window.addEventListener('pointerup', onStageMouseUp);
    window.addEventListener('pointercancel', onStageMouseUp);
    // Клик по холсту (capture): координаты нажатия/отжатия для догоняющего
    // клика — фигура фиксируется последним кликом без лишнего «мимо»
    stage.addEventListener('pointerdown', onStageClickDown, true);
    stage.addEventListener('pointerup', onStageClickUp, true);
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
    hideDrawSettings();
    // Сериализуем до удаления: очистка станет операцией — Ctrl+Z вернёт
    // всю разметку (включая «будущие» точки, см. convertSpecPoints)
    const specs = serializeOverlays();
    opsMuted = true;
    try { chartInstance.removeOverlay(); } finally { opsMuted = false; }
    overlayIds = [];
    clearToolActive();
    if (specs.length) pushOp(opClear(specs));
    syncUndoButtons();
    persistOverlays();
    setStatus('Разметка удалена');
  };

  // ---- Плавающая панель настроек выбранной разметки (как в TradingView)
  // ---- Клик по фигуре (или её достройка) показывает строку кастомизации
  // у фигуры: три дропдауна (цвет с палитрой и «Своим цветом…», толщина,
  // стиль линии) и корзина — удалить выделенную фигуру. Триггер каждого
  // дропдауна показывает текущее значение иконкой (кружок цвета / линия
  // толщиной выбора / линия со штрихом выбранного стиля), как в TV; меню
  // в стиле дропдауна типа графика: открытие по клику, закрытие — выбор
  // пункта, клик мимо, Escape или переключение на другой дропдаун.
  // Клик мимо фигуры (onDeselected) или её удаление (onRemoved) закрывают
  // всю панель; сдвиг/зум графика двигают панель вместе с фигурой
  // (подписки onScroll/onZoom в init). Правки применяются через
  // overlay.setStyles (9.6 мерджит partial-стили по ключам типов фигур:
  // line/arc/rect/polygon/circle/point/text) и переживают перезагрузку:
  // styles попадают в сериализацию разметки (overlaySpec → createOverlay
  // при восстановлении/undo). У измерителя панель не показывается: его
  // цвета семантические (рост/падение).

  let drawSettingsOverlayId = null; // id выделенной фигуры (панель открыта)

  // Палитра в духе TradingView (два ряда по шесть; первый — синий TV)
  const DS_COLORS = [
    '#2962ff', '#089981', '#f23645', '#ff9800', '#fdd835', '#26c6da',
    '#9c27b0', '#e91e63', '#787b86', '#d1d4dc', '#ffffff', '#5d606b',
  ];
  const DS_WIDTHS = [1, 2, 3, 4];
  // style — значения LineType из klinecharts 9.6: Dashed='dashed'
  // (не 'dash'! — с 'dash' сравнение в drawLine не срабатывает и линия
  // рисуется сплошной), пунктир и точки отличаются только dashedValue
  const DS_STYLES = [
    { key: 'solid', title: 'Сплошная', style: 'solid', dashedValue: [2, 2] },
    { key: 'dash', title: 'Пунктир', style: 'dashed', dashedValue: [6, 4] },
    { key: 'dotted', title: 'Точки', style: 'dashed', dashedValue: [1, 3] },
  ];

  // '#rrggbb' → 'rgba(r, g, b, a)' (заливка фигур при смене цвета;
  // непарсимое — возвращается как есть)
  const hexToRgba = (hex, alpha) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

  // Дефолтный цвет шаблона: у кастомных фигур — синий TV, у встроенных —
  // библиотечный (край — на случай недоступности стилей инстанса)
  const dsTemplateColor = (name) => ({
    'tc-rect': '#2962ff',
    'tc-arrow': ARROW_COLOR,
    'tc-brush': BRUSH_COLOR,
  }[name] || '#1677FF');

  // Текущий цвет/толщина/стиль фигуры: styles инстанса (их пишет панель),
  // затем дефолт шаблона. Толщина возвращается «как есть» — триггер рисует
  // линию любой фактической толщины (у стрелки 1.6), пункт меню
  // подсвечивается только при попадании в пресет DS_WIDTHS
  const dsCurrentColor = (ov) => {
    const st = (ov && ov.styles) || {};
    return st.line?.color ?? st.rect?.borderColor ?? st.polygon?.color
      ?? st.circle?.borderColor ?? st.text?.backgroundColor
      ?? dsTemplateColor(ov && ov.name);
  };
  const dsCurrentWidth = (ov) => {
    const st = (ov && ov.styles) || {};
    return st.line?.size ?? st.rect?.borderSize ?? 1;
  };
  const dsCurrentStyleKey = (ov) => {
    const line = ((ov && ov.styles) || {}).line || {};
    // 'dash' — стили из сборок с неверным значением LineType (до миграции)
    if (line.style === 'dashed' || line.style === 'dash') {
      return JSON.stringify(line.dashedValue) === JSON.stringify([1, 3]) ? 'dotted' : 'dash';
    }
    return 'solid';
  };

  // Стили из старых сборок: фигуры с line.style 'dash' библиотека рисует
  // сплошной (в 9.6 LineType.Dashed = 'dashed') — нормализуем при записи
  // разметки (overlaySpec) и при восстановлении/undo (createOverlay)
  const normalizeSpecStyles = (styles) => {
    if (!styles || typeof styles !== 'object') return styles;
    const fixStyle = (s) => (s && s.style === 'dash' ? { ...s, style: 'dashed' } : s);
    const fixBorder = (s) => (s && s.borderStyle === 'dash' ? { ...s, borderStyle: 'dashed' } : s);
    const out = { ...styles };
    for (const key of ['line', 'arc']) {
      if (out[key]) out[key] = fixStyle(out[key]);
    }
    for (const key of ['rect', 'polygon', 'circle']) {
      if (out[key]) out[key] = fixBorder(out[key]);
    }
    return out;
  };

  // Применение правки: overlay.setStyles мерджит partial по ключам типов
  // фигур — пишем во все, что фигура использует (лишние безвредны), затем
  // перерисовка панели и сохранение разметки
  const applyDrawSettingsPatch = (patch) => {
    const ov = drawSettingsOverlayId != null && chartInstance
      ? chartInstance.getOverlayById(drawSettingsOverlayId) : null;
    if (!ov || typeof ov.setStyles !== 'function') return;
    ov.setStyles(patch);
    syncDrawSettings(ov);
    redrawOverlayPane();
    persistOverlays();
  };

  const dsApplyColor = (color) => applyDrawSettingsPatch({
    line: { color },
    arc: { color },
    rect: { borderColor: color, color: hexToRgba(color, 0.12) },
    polygon: { color, borderColor: color },
    circle: { borderColor: color, color: hexToRgba(color, 0.12) },
    point: {
      color,
      activeColor: color,
      borderColor: hexToRgba(color, 0.35),
      activeBorderColor: hexToRgba(color, 0.35),
    },
    text: { backgroundColor: color, borderColor: color },
  });

  const dsApplyWidth = (size) => applyDrawSettingsPatch({
    line: { size },
    arc: { size },
    rect: { borderSize: size },
    polygon: { borderSize: size },
    circle: { borderSize: size },
  });

  const dsApplyStyle = (key) => {
    const s = DS_STYLES.find(x => x.key === key) || DS_STYLES[0];
    const dash = s.dashedValue.slice();
    applyDrawSettingsPatch({
      line: { style: s.style, dashedValue: dash },
      arc: { style: s.style, dashedValue: dash.slice() },
      rect: { borderStyle: s.style, borderDashedValue: dash.slice() },
      polygon: { borderStyle: s.style, borderDashedValue: dash.slice() },
      circle: { borderStyle: s.style, borderDashedValue: dash.slice() },
    });
  };

  // ---- Дропдауны панели (цвет / толщина / стиль) — каркас как у
  // ---- дропдауна типа графика: триггер открывает своё меню и гасит
  // остальные (и контекстное меню), закрытие — выбор пункта, клик мимо
  // (общий document-обработчик из bindResetViewUi) или Escape.

  const DS_MENUS = [
    { toggle: 'tc-ds-color-toggle', menu: 'tc-ds-color-menu' },
    { toggle: 'tc-ds-width-toggle', menu: 'tc-ds-widths' },
    { toggle: 'tc-ds-style-toggle', menu: 'tc-ds-styles' },
  ];

  // Спрятать все меню панели. Возвращает true, если было открыто хоть
  // одно (для Escape: он должен закрыть меню и не «провалиться» дальше)
  const hideDrawSettingsMenus = () => {
    let any = false;
    for (const m of DS_MENUS) {
      const menu = document.getElementById(m.menu);
      if (menu && menu.classList.contains('open')) {
        menu.classList.remove('open');
        any = true;
      }
      const toggle = document.getElementById(m.toggle);
      if (toggle && typeof toggle.setAttribute === 'function') {
        toggle.setAttribute('aria-expanded', 'false');
      }
    }
    return any;
  };

  const anyDrawSettingsMenuOpen = () => DS_MENUS.some((m) => {
    const menu = document.getElementById(m.menu);
    return !!(menu && menu.classList.contains('open'));
  });

  // Иконки-триггеры толщины/стиля: горизонтальная линия-образец текущего
  // значения (как в TV: ширина — толщиной линии, стиль — её штрихом).
  // У толщины рядом с линией стоит ЧИСЛО — иначе на дефолтных 1px
  // «сплошная» триггеры толщины и стиля неразличимы
  const dsWidthIconSvg = (w) => `<svg viewBox="0 0 30 12" fill="none" stroke="currentColor" aria-hidden="true"><line x1="2" y1="6" x2="16" y2="6" stroke-width="${w}" stroke-linecap="round"/><text x="19" y="9.5" font-size="9" fill="currentColor" stroke="none">${w}</text></svg>`;
  const DS_DASH_ATTRS = { solid: { dasharray: null, cap: false }, dash: { dasharray: '6 3', cap: false }, dotted: { dasharray: '0.1 3.5', cap: true } };
  const dsStyleIconSvg = (key) => {
    const a = DS_DASH_ATTRS[key] || DS_DASH_ATTRS.solid;
    const cap = a.cap ? ' stroke-linecap="round"' : '';
    const extra = a.dasharray ? ` stroke-dasharray="${a.dasharray}"` : '';
    return `<svg viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.6"${cap} aria-hidden="true"><line x1="3" y1="6" x2="17" y2="6"${extra}/></svg>`;
  };
  // Образец линии для строк меню толщины (рядом подпись «Npx», как в TV)
  const dsWidthSampleSvg = (w) => `<svg viewBox="0 0 26 12" fill="none" stroke="currentColor" aria-hidden="true"><line x1="2" y1="6" x2="24" y2="6" stroke-width="${w}" stroke-linecap="round"/></svg>`;

  // Подсветка выбранных значений в меню и текущих значений на триггерах
  // (кружок цвета, линия толщины, линия со штрихом стиля)
  const syncDrawSettings = (ov) => {
    const hex = toHexColor(dsCurrentColor(ov));
    const dot = document.getElementById('tc-ds-color-dot');
    if (dot) dot.style.background = hex;
    const colorsHost = document.getElementById('tc-ds-colors');
    if (colorsHost) {
      for (const sw of colorsHost.children) {
        sw.classList.toggle('active', toHexColor(sw.dataset.color) === hex);
      }
    }
    const colorInput = document.getElementById('tc-ds-color-input');
    if (colorInput) colorInput.value = hex;
    const w = dsCurrentWidth(ov);
    const widthToggle = document.getElementById('tc-ds-width-toggle');
    if (widthToggle) {
      widthToggle.innerHTML = dsWidthIconSvg(w);
      if (typeof widthToggle.dataset === 'object') widthToggle.dataset.width = String(w);
      widthToggle.title = `Толщина линии: ${w}`;
    }
    const widthsHost = document.getElementById('tc-ds-widths');
    if (widthsHost) {
      for (const b of widthsHost.children) {
        b.classList.toggle('active', Number(b.dataset.width) === w);
      }
    }
    const key = dsCurrentStyleKey(ov);
    const styleToggle = document.getElementById('tc-ds-style-toggle');
    if (styleToggle) {
      styleToggle.innerHTML = dsStyleIconSvg(key);
      if (typeof styleToggle.dataset === 'object') styleToggle.dataset.style = key;
      const s = DS_STYLES.find(x => x.key === key);
      styleToggle.title = `Стиль линии: ${s ? s.title.toLowerCase() : key}`;
    }
    const stylesHost = document.getElementById('tc-ds-styles');
    if (stylesHost) {
      for (const b of stylesHost.children) {
        b.classList.toggle('active', b.dataset.style === key);
      }
    }
  };

  // Позиция — над фигурой: по центру bbox её точек (convertToPixel),
  // с прижимом внутрь холста; не помещается сверху — под фигуру.
  // Геометрия недоступна (мини-DOM тестов, холст ещё не разложился) —
  // панель остаётся там, где была
  const positionDrawSettings = (overlay) => {
    const bar = document.getElementById('tc-draw-settings');
    const stage = document.getElementById('tc-chart-stage');
    if (!bar || !stage) return;
    const rect = typeof stage.getBoundingClientRect === 'function'
      ? stage.getBoundingClientRect() : null;
    const pts = (overlay.points || []).filter(p => p && p.value != null
      && (p.timestamp != null || Number.isFinite(p.dataIndex)));
    if (!rect || !pts.length || typeof chartInstance.convertToPixel !== 'function') return;
    const coords = chartInstance.convertToPixel(pts.map(p => p.timestamp != null
      ? { timestamp: p.timestamp, value: p.value }
      : { dataIndex: p.dataIndex, value: p.value }), { paneId: overlay.paneId || 'candle_pane' });
    const list = Array.isArray(coords) ? coords : [coords];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    for (const c of list) {
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y);
    }
    if (!Number.isFinite(minX)) return;
    const barW = bar.offsetWidth || 280;
    const barH = bar.offsetHeight || 34;
    const margin = 8;
    const left = Math.min(Math.max((minX + maxX) / 2 - barW / 2, margin), rect.width - barW - margin);
    let top = minY - barH - margin;
    if (top < margin) top = Math.min(minY + margin, rect.height - barH - margin);
    bar.style.left = `${Math.round(Math.max(left, margin))}px`;
    bar.style.top = `${Math.round(Math.max(top, margin))}px`;
  };

  // Панель открыта, но фигура могла исчезнуть мимо onRemoved (undo/redo) —
  // сдвиг/зум проверяют и это
  const repositionDrawSettings = () => {
    if (drawSettingsOverlayId == null) return;
    const ov = chartInstance ? chartInstance.getOverlayById(drawSettingsOverlayId) : null;
    if (ov) positionDrawSettings(ov);
    else hideDrawSettings();
  };

  const hideDrawSettings = () => {
    const bar = document.getElementById('tc-draw-settings');
    if (bar) bar.classList.remove('show');
    hideDrawSettingsMenus();
    drawSettingsOverlayId = null;
  };

  const showDrawSettings = (overlay) => {
    if (!overlay) return false;
    // У измерителя цвета семантические (рост/падение) — настроек нет
    if (overlay.name === 'tc-measure') return false;
    const bar = document.getElementById('tc-draw-settings');
    if (!bar) return false;
    drawSettingsOverlayId = overlay.id;
    // Меню всегда стартуют закрытыми: выделение другой фигуры не должно
    // «протащить» открытое меню прежней
    hideDrawSettingsMenus();
    syncDrawSettings(overlay);
    positionDrawSettings(overlay);
    bar.classList.add('show');
    return true;
  };

  // Корзина: удалить выделенную фигуру (onRemoved запишет операцию —
  // Ctrl+Z вернёт её вместе со стилями)
  const removeDrawSettingsTarget = () => {
    const id = drawSettingsOverlayId;
    hideDrawSettings();
    if (id != null) removeStageOverlay(id);
  };

  const buildDrawSettings = () => {
    const bar = document.getElementById('tc-draw-settings');
    if (!bar || bar.dataset.dsBound) return;
    bar.dataset.dsBound = '1';
    // Триггеры дропдаунов: открыть своё меню, погасив остальные меню
    // панели, дропдауны шапки и контекстное меню графика. stopPropagation
    // не даёт общему «клик мимо — закрыть» тут же погасить открытое меню
    for (const m of DS_MENUS) {
      const toggle = document.getElementById(m.toggle);
      const menu = document.getElementById(m.menu);
      if (!toggle || !menu) continue;
      toggle.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        if (ctxMenuOpen) hideCtxMenu();
        hideTypeMenu();
        hideScaleMenu();
        hideIndicatorMenu();
        const wasOpen = menu.classList.contains('open');
        hideDrawSettingsMenus();
        if (wasOpen) return;
        menu.classList.add('open');
        if (typeof toggle.setAttribute === 'function') {
          toggle.setAttribute('aria-expanded', 'true');
        }
      });
    }
    // Цвет: свотчи применяют цвет и закрывают меню (как выбор палитры в TV)
    const colorsHost = document.getElementById('tc-ds-colors');
    if (colorsHost) {
      for (const c of DS_COLORS) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'tc-ds-swatch';
        sw.dataset.color = c;
        sw.style.background = c;
        sw.title = 'Цвет фигуры';
        sw.addEventListener('click', () => {
          dsApplyColor(c);
          hideDrawSettingsMenus();
        });
        colorsHost.appendChild(sw);
      }
    }
    // «Свой цвет…» — нативный виджет цвета (input.click()), правки
    // красят фигуру на лету (input), закрытие меню — после выбора (change)
    const colorCustom = document.getElementById('tc-ds-color-custom');
    const colorInput = document.getElementById('tc-ds-color-input');
    if (colorCustom && colorInput) {
      colorCustom.addEventListener('click', () => {
        if (typeof colorInput.click === 'function') colorInput.click();
      });
      colorInput.addEventListener('input', () => dsApplyColor(colorInput.value));
      colorInput.addEventListener('change', () => {
        dsApplyColor(colorInput.value);
        hideDrawSettingsMenus();
      });
    }
    // Толщина: строки «образец линии + Npx» (подписи как в TV)
    const widthsHost = document.getElementById('tc-ds-widths');
    if (widthsHost) {
      for (const w of DS_WIDTHS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tc-ds-opt';
        b.dataset.width = String(w);
        b.title = `Толщина ${w}`;
        b.innerHTML = `${dsWidthSampleSvg(w)}<span class="tc-ds-opt-label">${w}px</span>`;
        b.addEventListener('click', () => {
          dsApplyWidth(w);
          hideDrawSettingsMenus();
        });
        widthsHost.appendChild(b);
      }
    }
    // Стиль: строки с образцом штриха — сплошная / пунктир / точки
    const stylesHost = document.getElementById('tc-ds-styles');
    if (stylesHost) {
      for (const s of DS_STYLES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tc-ds-opt';
        b.dataset.style = s.key;
        b.title = s.title;
        b.innerHTML = dsStyleIconSvg(s.key);
        b.addEventListener('click', () => {
          dsApplyStyle(s.key);
          hideDrawSettingsMenus();
        });
        stylesHost.appendChild(b);
      }
    }
    const trash = document.getElementById('tc-ds-trash');
    if (trash) trash.addEventListener('click', () => removeDrawSettingsTarget());
  };

  // Клик по HTML-панели настроек не должен начинать рисование кистью/
  // измерителем и не считается кликом фигуры (перехваты холста)
  const inDrawSettings = (e) => !!(e && e.target && typeof e.target.closest === 'function'
    && e.target.closest('#tc-draw-settings'));


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

  // ---- Легенды индикаторов на графике (как в TradingView) ----
  // Каждая включённая линия/под-окно получает на холсте строку
  // «ИМЯ(параметры) значения ×»: имя открывает периоды (tcConfigureIndicator),
  // × убирает индикатор (tcRemoveIndicator) — закрытие живёт рядом с
  // названием на графике, а не в шапке рядом со списком. Значения берутся
  // из живого инстанса (figures/result по бару под курсором, как считал
  // встроенный тултип — он отключён, чтобы не наслаиваться на легенды).
  // Позиция строки — верх панели индикатора (геометрия _drawPanes), у
  // линий в главном окне — стопкой под легендой OHLCV. Гистограмма объёма
  // (VOL_MAIN) отдельной строки не имеет: её название и × живут в строке
  // «Объем» легенды OHLCV.

  // Строки линий главного окна: ниже легенды OHLCV (топ 8 + две строки),
  // шаг — высота строки с зазором
  const IND_LEGEND_BASE_TOP = 42;
  const IND_LEGEND_PITCH = 20;
  // span значений каждой легенды — обновление за кроссхейром без DOM-поиска
  const legendValueEls = new Map();

  // Человеческие подписи легенд для custom-индикаторов (shortName у них
  // пуст — встроенный тултип выключен, а строка легенды рисуется нами)
  const INDICATOR_LEGEND_LABELS = { [VOL_SIDE]: 'Объем сбоку' };

  const indicatorLegendLabel = (name, paneId) => {
    if (INDICATOR_LEGEND_LABELS[name]) return INDICATOR_LEGEND_LABELS[name];
    let label = name;
    let params = [];
    try {
      const inst = chartInstance && chartInstance.getIndicatorByPaneId(paneId, name);
      if (inst) {
        if (inst.shortName) label = inst.shortName;
        if (Array.isArray(inst.calcParams) && inst.calcParams.length) params = inst.calcParams;
      }
    } catch (e) { /* инстанс недоступен — остаётся имя */ }
    // Параметры строкой, как в тултипе TradingView: «MA(5,10)», «RSI(14)»
    return params.length ? `${label}(${params.join(',')})` : label;
  };

  // Верх панели индикатора: линии главного окна — стопкой под легендой
  // OHLCV, под-окна — у верхнего края своей панели (сдвигается вместе с
  // раскладкой панелей — пересчитывается после данных/ресайза). Панель не
  // найдена (ещё не разложилась) — строка прячется до следующего пересчёта
  const updateIndicatorLegendPositions = () => {
    const host = document.getElementById('tc-ind-legends');
    if (!host) return;
    let mainIdx = 0;
    for (const row of host.children) {
      const paneId = row.dataset ? row.dataset.paneId : null;
      let top = IND_LEGEND_BASE_TOP + mainIdx * IND_LEGEND_PITCH;
      if (paneId && paneId !== 'candle_pane') {
        top = -9999;
        try {
          const pane = chartInstance ? (chartInstance._drawPanes || [])
            .find(p => (typeof p.getId === 'function' ? p.getId() : p._id) === paneId) : null;
          if (pane && pane._bounding && Number.isFinite(pane._bounding.top)) {
            top = pane._bounding.top + 4;
          }
        } catch (e) { /* геометрия панелей недоступна */ }
      } else {
        mainIdx++;
      }
      row.style.top = `${Math.round(top)}px`;
    }
  };

  // Раскладка панелей после createIndicator/removeIndicator догоняет
  // асинхронно (adjustPaneViewport 9.6) — повторяем пересчёт с задержкой
  const refreshLegendPositionsSoon = () => {
    setTimeout(updateIndicatorLegendPositions, 150);
  };

  // Иконка настроек в легендах (как «⚙» при наведении на легенду в TV)
  const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>';

  // Кнопка «⚙» (настройки индикатора, как в TradingView при наведении на
  // легенду): клик открывает тот же диалог, что клик по названию
  const makeGearEl = (title, onClick) => {
    const gear = document.createElement('span');
    gear.className = 'tc-ind-gear';
    gear.innerHTML = GEAR_SVG;
    gear.title = title;
    gear.addEventListener('click', onClick);
    return gear;
  };

  const renderIndicatorLegends = () => {
    const host = document.getElementById('tc-ind-legends');
    if (!host) return;
    host.innerHTML = '';
    legendValueEls.clear();
    for (const [name, paneId] of indicators) {
      if (name === VOL_MAIN) continue; // строка «Объем» легенды OHLCV
      const row = document.createElement('span');
      row.className = 'tc-ind-legend';
      row.dataset.ind = name;
      row.dataset.paneId = paneId;
      const nm = document.createElement('span');
      nm.className = 'tc-ind-name';
      nm.textContent = indicatorLegendLabel(name, paneId);
      nm.title = `${name} — настройки (периоды и стиль)`;
      nm.addEventListener('click', () => window.tcConfigureIndicator(name));
      const vals = document.createElement('span');
      vals.className = 'tc-ind-vals';
      const x = document.createElement('span');
      x.className = 'tc-ind-close';
      x.textContent = '×';
      x.title = `Убрать ${name}`;
      x.addEventListener('click', () => window.tcRemoveIndicator(name));
      row.appendChild(nm);
      row.appendChild(vals);
      row.appendChild(makeGearEl(`Настройки ${name}`, () => window.tcConfigureIndicator(name)));
      row.appendChild(x);
      host.appendChild(row);
      legendValueEls.set(name, vals);
    }
    // Линии сравнения (клик по названию/⚙ — без диалога: сравнение
    // настраивается в окне «Сравнить», здесь только значения и ×)
    for (const [name, series] of compareSeries) {
      const row = document.createElement('span');
      row.className = 'tc-ind-legend tc-compare-legend';
      row.dataset.ind = name;
      row.dataset.paneId = 'candle_pane';
      row.dataset.compare = '1';
      const nm = document.createElement('span');
      nm.className = 'tc-ind-name';
      nm.textContent = series.display;
      nm.style.color = series.color;
      nm.title = `Сравнение с ${series.ticker}`;
      const vals = document.createElement('span');
      vals.className = 'tc-ind-vals';
      const x = document.createElement('span');
      x.className = 'tc-ind-close';
      x.textContent = '×';
      x.title = `Убрать сравнение с ${series.display}`;
      x.addEventListener('click', () => window.tcRemoveCompare(name));
      row.appendChild(nm);
      row.appendChild(vals);
      row.appendChild(x);
      host.appendChild(row);
      legendValueEls.set(name, vals);
    }
    updateIndicatorLegendPositions();
    renderIndicatorLegendValues();
    // Чипы убраны — строка «Объем» в легенде должна повторять состояние
    // гистограммы (выключена — строки и её × нет)
    syncVolumeLegend();
    // Подсветка включённых в дропдауне «Индикаторы» (там пункты кликом
    // переключаются — добавить/убрать)
    syncIndicatorMenu();
  };

  // Значения легенд по бару (под курсором или последний): figures/result
  // живого инстанса — те же ключи, что рисовал встроенный тултип
  const fmtIndicatorLegendValue = (v, precision) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(precision) : '—';
  };

  const renderIndicatorLegendValues = (k) => {
    if (!chartInstance || !legendValueEls.size) return;
    const list = chartInstance.getDataList();
    const idx = k ? list.indexOf(k) : (list.length ? list.length - 1 : -1);
    for (const [name, valsEl] of legendValueEls) {
      let text = '';
      if (idx >= 0) {
        // Линия сравнения: цена, пересчитанная к масштабу основного графика,
        // и % от точки привязки — как в легенде «Сравнить» в TradingView
        const series = compareSeries.get(name);
        if (series) {
          const c = compareCloseAt(series, list[idx].timestamp);
          if (c != null) {
            const pct = series.firstClose ? (c / series.firstClose - 1) * 100 : 0;
            const sign = pct >= 0 ? '+' : '';
            text = `${fmtNum(c * series.factor)} (${sign}${pct.toFixed(2)}%)`;
          } else {
            text = '—';
          }
          if (valsEl.textContent !== text) valsEl.textContent = text;
          continue;
        }
        try {
          const paneId = indicators.get(name);
          const inst = chartInstance.getIndicatorByPaneId(paneId, name);
          const figures = inst && Array.isArray(inst.figures) ? inst.figures : [];
          const row = Array.isArray(inst && inst.result) ? inst.result[idx] : null;
          // Точность: своя у индикатора; линии главного окна без неё —
          // точность инструмента, под-окна — библиотечные 4 знака
          const precision = inst && Number.isFinite(inst.precision) ? inst.precision
            : (paneId === 'candle_pane' ? pricePrecision : 4);
          text = figures
            .map(f => fmtIndicatorLegendValue(row ? row[f.key] : undefined, precision))
            .join(' ');
        } catch (e) { text = ''; }
      }
      if (valsEl.textContent !== text) valsEl.textContent = text;
    }
  };

  // Добавление индикатора: MA/EMA/BOLL/SAR — на свечи, остальные —
  // в собственные под-окна (isStack=false, уникальный paneId на имя).
  // Сохранённые настройки индикатора (периоды/стили из диалога настроек,
  // см. IND_EDIT ниже) применяются при создании — как «шаблоны» TradingView
  window.tcAddIndicator = function (name) {
    const instance = getChartInstance();
    if (!instance || !name) return;
    if (indicators.has(name)) { setStatus(`Индикатор ${name} уже включён`); return; }
    const pane = paneForIndicator(name);
    // Стек для главного окна (см. комментарий к volume при init): в 9.6
    // IndicatorStore.addInstance при isStack=false затирает индикаторов
    // панели, поэтому MA/EMA/BOLL… добавляются поверх гистограммы, а не
    // вместо неё. Под-окна каждый раз создаются новые — там не важно.
    const id = instance.createIndicator(indicatorCreateOptions(name), pane.id === 'candle_pane', pane);
    if (!id) { setStatus(`Индикатор ${name} не поддерживается библиотекой`, true); return; }
    indicators.set(name, pane.id);
    persistEnabledIndicators();
    renderIndicatorLegends();
    // Точность оси под-окна и значения легенд — после первого расчёта
    // (createIndicator в 9.6 считает асинхронно: до него в легенде прочерки),
    // верх новой панели появляется с первым кадром раскладки
    setTimeout(() => {
      tuneSubPaneAxisPrecision(name);
      renderIndicatorLegendValues();
    }, 400);
    refreshLegendPositionsSoon();
    setStatus(name === VOL_MAIN
      ? 'Гистограмма объёма включена'
      : `Индикатор ${name} включён — закрытие и периоды на легенде графика`);
  };

  window.tcRemoveIndicator = function (name) {
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    if (!instance || !paneId) return;
    instance.removeIndicator(paneId, name);
    indicators.delete(name);
    persistEnabledIndicators();
    renderIndicatorLegends();
    // Оставшиеся панели переложились — позиции легенд догоняем
    refreshLegendPositionsSoon();
    setStatus(name === VOL_MAIN
      ? 'Гистограмма объёма выключена'
      : `Индикатор ${name} выключен`);
  };

  // ---- Настройки индикаторов (как в TradingView) ----
  // Клик по названию индикатора в легенде (или ⚙ рядом) открывает диалог
  // с двумя вкладками — «Входные данные» (периоды) и «Стиль» (цвета линий/
  // гистограмм, толщина). Изменения применяются через overrideIndicator
  // (9.6 мерджит styles по индексам массивов — правим только выбранные
  // слоты) и ПЕРЕЖИВАЮТ перезагрузку: хранилище wl_chart_indicators =
  //   { enabled: ['VOL_MAIN', ...], settings: { NAME: { calcParams, styles, extendData } } }
  // Включённые индикаторы тоже восстанавливаются при загрузке (набор
  // графика, как в TradingView, живёт между сессиями).

  const IND_LS_KEY = 'wl_chart_indicators';

  const loadIndicatorStore = () => {
    try {
      const v = JSON.parse(localStorage.getItem(IND_LS_KEY) || '{}');
      return {
        enabled: Array.isArray(v.enabled) ? v.enabled : null,
        settings: v.settings && typeof v.settings === 'object' ? v.settings : {},
      };
    } catch (e) { return { enabled: null, settings: {} }; }
  };

  const saveIndicatorStore = (enabled, settings) => {
    try {
      localStorage.setItem(IND_LS_KEY, JSON.stringify({ enabled, settings }));
    } catch (e) { /* localStorage недоступен — настройки не сохранятся */ }
  };

  const persistEnabledIndicators = () => {
    const store = loadIndicatorStore();
    saveIndicatorStore([...indicators.keys()], store.settings);
  };

  const indicatorSetting = (name) => {
    const store = loadIndicatorStore();
    const s = store.settings[name];
    return s && typeof s === 'object' ? s : null;
  };

  // Опции создания индикатора с сохранёнными настройками: createIndicator
  // 9.6 принимает и объект ({name, calcParams, styles, extendData})
  const indicatorCreateOptions = (name) => {
    const saved = indicatorSetting(name);
    const opts = { name };
    if (saved) {
      if (Array.isArray(saved.calcParams) && saved.calcParams.length) opts.calcParams = saved.calcParams.slice();
      if (saved.styles && typeof saved.styles === 'object') opts.styles = saved.styles;
      if (saved.extendData !== undefined) opts.extendData = saved.extendData;
    }
    // Гистограммы объёма — custom-draw, их настройки живут в extendData
    if (name === VOL_MAIN) {
      opts.extendData = { ...VOL_MAIN_DEFAULT_EXTEND, ...(opts.extendData || {}) };
    } else if (name === VOL_SIDE) {
      opts.extendData = { ...VOL_SIDE_DEFAULT_EXTEND, ...(opts.extendData || {}) };
    }
    return opts;
  };

  // ---- Схемы редактирования: подписи полей и состав слотов стиля ----
  // params: массив подписей периодов (или строка-«регенерация»: у MA/EMA/
  // WR/BIAS число периодов меняется пользователем — подписи «Период N»).
  // lines: число линий (массив подписей или 'regen'), bars/circles — слоты
  // цветов гистограмм/точек. Дефолты цветов/толщины — библиотечные
  // (Styles/default.ts 9.6: палитра линий #FF9600/#935EBD/#1677FF/…,
  // гистограммы rgba(45,192,142,.7)/rgba(249,40,85,.7)).
  const LIB_LINE_COLORS = ['#FF9600', '#935EBD', '#1677FF', '#E11D74', '#01C5C4'];
  const LIB_LINE_SIZE = 1;
  const LIB_BAR_COLORS = {
    upColor: 'rgba(45, 192, 142, 0.7)',
    downColor: 'rgba(249, 40, 85, 0.7)',
    noChangeColor: '#888888',
  };

  const IND_EDIT_SCHEMAS = {
    MA: { params: 'MA', lines: 'regen' },
    EMA: { params: 'EMA', lines: 'regen' },
    WR: { params: 'WR', lines: 'regen' },
    BIAS: { params: 'BIAS', lines: 'regen' },
    BOLL: { params: ['Период', 'Множитель отклонения'], lines: ['UP', 'MID', 'DN'] },
    SAR: { params: ['Шаг, %', 'Максимум, %', 'Период'], circles: true },
    BBI: { params: ['Период 1', 'Период 2', 'Период 3', 'Период 4'], lines: 1 },
    AVP: { lines: 1 },
    MACD: { params: ['Быстрый период', 'Медленный период', 'Сигнальный период'], lines: ['DIF', 'DEA'], bars: true, barsNoChange: true },
    RSI: { params: ['Период 1', 'Период 2', 'Период 3'], lines: ['RSI1', 'RSI2', 'RSI3'] },
    KDJ: { params: ['Период RSV', 'Период K', 'Период D'], lines: ['K', 'D', 'J'] },
    CCI: { params: ['Период'], lines: 1 },
    DMI: { params: ['Период', 'Период ADX'], lines: ['PDI', 'MDI', 'ADX', 'ADXR'] },
    OBV: { params: ['Период MA'], lines: ['OBV', 'MAOBV'] },
    ROC: { params: ['Период', 'Период MA'], lines: ['ROC', 'MAROC'] },
    DMA: { params: ['Быстрый период', 'Медленный период', 'Период AMA'], lines: ['DMA', 'AMA'] },
    TRIX: { params: ['Период', 'Период MA'], lines: ['TRIX', 'MATRIX'] },
    VOL: { params: ['MA 1', 'MA 2', 'MA 3'], lines: ['MA1', 'MA2', 'MA3'], bars: true, barsNoChange: true },
    VOL_MAIN: { custom: 'volMain' },
    VOL_SIDE: { custom: 'volSide' },
  };

  // rgba()/rgb() → '#rrggbb' (input[type=color] понимает только hex);
  // непарсимое — нейтральный синий
  const toHexColor = (css) => {
    const s = String(css || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
    const m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) {
      const hex = (n) => Number(n).toString(16).padStart(2, '0').toUpperCase();
      return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
    }
    return '#2962ff';
  };

  // Диалог: состояние текущей правки. fields — реестр полей, собранный при
  // построении (обход DOM на apply не нужен — мини-DOM тестов совместим)
  let indEditCtx = null; // { name, fields: [{ key, kind, el, scale }] }

  const hideIndicatorEditDialog = () => {
    const modal = document.getElementById('tc-ind-modal');
    if (modal) modal.classList.remove('active');
    indEditCtx = null;
  };

  const bindModalDismiss = (modalId, cancelFn) => {
    const modal = document.getElementById(modalId);
    if (!modal || modal.dataset.modalBound) return;
    modal.dataset.modalBound = '1';
    window.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape' || !modal.classList.contains('active')) return;
      // Escape не должен «провалиться» в другие окно-обработчики (диалог
      // заметки и пр.) — погасим всплытие, где у события оно вообще есть
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      cancelFn();
    });
    modal.addEventListener('click', (e) => { if (e && e.target === modal) cancelFn(); });
  };

  const makeNumInput = (value, step) => {
    const inp = document.createElement('input');
    inp.className = 'modal-input tc-ind-num-input';
    inp.type = 'number';
    inp.value = String(value);
    if (step != null) inp.step = String(step);
    return inp;
  };

  const makeColorInput = (value) => {
    const inp = document.createElement('input');
    inp.className = 'tc-ind-color-input';
    inp.type = 'color';
    inp.value = toHexColor(value);
    return inp;
  };

  const addEditField = (pane, label, input, field) => {
    const wrap = document.createElement('div');
    wrap.className = 'tc-ind-field';
    const lbl = document.createElement('div');
    lbl.className = 'tc-ind-field-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    pane.appendChild(wrap);
    indEditCtx.fields.push({ ...field, el: input });
    return input;
  };

  // Построение полей диалога по схеме индикатора
  const buildIndicatorEditFields = (name, paneId) => {
    const instance = getChartInstance();
    const inputsPane = document.getElementById('tc-ind-tab-inputs');
    const stylePane = document.getElementById('tc-ind-tab-style');
    if (!inputsPane || !stylePane) return;
    inputsPane.innerHTML = '';
    stylePane.innerHTML = '';
    const schema = IND_EDIT_SCHEMAS[name] || {};

    // Текущие значения: периоды — из живого инстанса, стили — сохранённые
    // настройки (у библиотеки эффективные дефолты — см. LIB_*), extendData
    // — дефолты custom-гистограмм поверх сохранённых
    let calcParams = [];
    try {
      const inst = instance && instance.getIndicatorByPaneId(paneId, name);
      if (inst && Array.isArray(inst.calcParams)) calcParams = inst.calcParams.slice();
    } catch (e) { /* инстанс недоступен — поля по дефолтам */ }
    const saved = indicatorSetting(name) || {};
    const savedStyles = saved.styles && typeof saved.styles === 'object' ? saved.styles : {};
    const lineStyles = Array.isArray(savedStyles.lines) ? savedStyles.lines : [];
    const barStyles = Array.isArray(savedStyles.bars) && savedStyles.bars.length ? savedStyles.bars[0] : {};
    const circleStyles = Array.isArray(savedStyles.circles) && savedStyles.circles.length ? savedStyles.circles[0] : {};

    if (schema.custom === 'volMain' || schema.custom === 'volSide') {
      const defaults = schema.custom === 'volMain' ? VOL_MAIN_DEFAULT_EXTEND : VOL_SIDE_DEFAULT_EXTEND;
      const ext = { ...defaults, ...(saved.extendData && typeof saved.extendData === 'object' ? saved.extendData : {}) };
      if (schema.custom === 'volMain') {
        addEditField(inputsPane, 'Высота гистограммы, % панели',
          makeNumInput(Math.round(ext.maxHeight * 100), 1),
          { key: 'maxHeight', kind: 'extPercent' });
        addEditField(stylePane, 'Рост', makeColorInput(ext.upColor), { key: 'upColor', kind: 'extColor' });
        addEditField(stylePane, 'Падение', makeColorInput(ext.downColor), { key: 'downColor', kind: 'extColor' });
      } else {
        addEditField(inputsPane, 'Число ценовых уровней', makeNumInput(ext.bins, 1), { key: 'bins', kind: 'extInt' });
        addEditField(inputsPane, 'Ширина профиля, % панели',
          makeNumInput(Math.round(ext.maxWidth * 100), 1),
          { key: 'maxWidth', kind: 'extPercent' });
        addEditField(stylePane, 'Рост', makeColorInput(ext.upColor), { key: 'upColor', kind: 'extColor' });
        addEditField(stylePane, 'Падение', makeColorInput(ext.downColor), { key: 'downColor', kind: 'extColor' });
      }
      return;
    }

    // Входные данные: периоды
    if (schema.params) {
      const labels = Array.isArray(schema.params)
        ? schema.params
        : calcParams.map((_, i) => `${schema.params}: период ${i + 1}`);
      labels.forEach((label, i) => {
        const value = calcParams[i] != null ? calcParams[i] : 14;
        addEditField(inputsPane, label, makeNumInput(value, 1), { key: String(i), kind: 'param' });
      });
    } else {
      const note = document.createElement('div');
      note.className = 'tc-ind-field-note';
      note.textContent = 'У этого индикатора нет входных параметров';
      inputsPane.appendChild(note);
    }

    // Стиль: линии, гистограммы, точки
    if (schema.lines) {
      const count = schema.lines === 'regen' ? calcParams.length : schema.lines.length;
      for (let i = 0; i < count; i++) {
        const label = schema.lines === 'regen' ? `Линия ${i + 1}` : schema.lines[i];
        const cur = lineStyles[i] || {};
        addEditField(stylePane, `${label} — цвет`, makeColorInput(cur.color ?? LIB_LINE_COLORS[i % LIB_LINE_COLORS.length]),
          { key: `lines.${i}.color`, kind: 'styleColor' });
        addEditField(stylePane, `${label} — толщина`, makeNumInput(cur.size ?? LIB_LINE_SIZE, 0.5),
          { key: `lines.${i}.size`, kind: 'styleNum' });
      }
    }
    if (schema.bars) {
      addEditField(stylePane, 'Гистограмма — рост', makeColorInput(barStyles.upColor ?? LIB_BAR_COLORS.upColor),
        { key: 'bars.0.upColor', kind: 'styleColor' });
      addEditField(stylePane, 'Гистограмма — падение', makeColorInput(barStyles.downColor ?? LIB_BAR_COLORS.downColor),
        { key: 'bars.0.downColor', kind: 'styleColor' });
      if (schema.barsNoChange) {
        addEditField(stylePane, 'Гистограмма — без изменений', makeColorInput(barStyles.noChangeColor ?? LIB_BAR_COLORS.noChangeColor),
          { key: 'bars.0.noChangeColor', kind: 'styleColor' });
      }
    }
    if (schema.circles) {
      addEditField(stylePane, 'Точки — рост', makeColorInput(circleStyles.upColor ?? LIB_BAR_COLORS.upColor),
        { key: 'circles.0.upColor', kind: 'styleColor' });
      addEditField(stylePane, 'Точки — падение', makeColorInput(circleStyles.downColor ?? LIB_BAR_COLORS.downColor),
        { key: 'circles.0.downColor', kind: 'styleColor' });
    }
  };

  const switchIndicatorEditTab = (tab) => {
    const inputsPane = document.getElementById('tc-ind-tab-inputs');
    const stylePane = document.getElementById('tc-ind-tab-style');
    const inputsBtn = document.getElementById('tc-ind-tab-inputs-btn');
    const styleBtn = document.getElementById('tc-ind-tab-style-btn');
    if (!inputsPane || !stylePane) return;
    const showInputs = tab !== 'style';
    inputsPane.style.display = showInputs ? '' : 'none';
    stylePane.style.display = showInputs ? 'none' : '';
    if (inputsBtn) inputsBtn.classList.toggle('active', showInputs);
    if (styleBtn) styleBtn.classList.toggle('active', !showInputs);
  };

  // Диалог настроек индикатора (как в TradingView: вкладки «Входные
  // данные» / «Стиль»). Открывается кликом по названию в легенде графика
  window.tcConfigureIndicator = function (name) {
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    const modal = document.getElementById('tc-ind-modal');
    if (!instance || !paneId || !modal) return;
    indEditCtx = { name, fields: [] };
    const title = document.getElementById('tc-ind-modal-title');
    if (title) title.textContent = `Настройки: ${name}`;
    const errEl = document.getElementById('tc-ind-modal-error');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    buildIndicatorEditFields(name, paneId);
    switchIndicatorEditTab('inputs');
    modal.classList.add('active');
  };

  const applyIndicatorEditDialog = () => {
    if (!indEditCtx) { hideIndicatorEditDialog(); return; }
    const { name, fields } = indEditCtx;
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    if (!instance || !paneId) { hideIndicatorEditDialog(); return; }
    const schema = IND_EDIT_SCHEMAS[name] || {};
    const errEl = document.getElementById('tc-ind-modal-error');
    const showError = (text) => {
      if (errEl) { errEl.textContent = text; errEl.style.display = ''; }
    };

    const update = {};
    const saved = {};
    if (schema.custom) {
      // custom-гистограммы: настройки в extendData
      const defaults = schema.custom === 'volMain' ? VOL_MAIN_DEFAULT_EXTEND : VOL_SIDE_DEFAULT_EXTEND;
      const ext = { ...defaults, ...(indicatorSetting(name)?.extendData || {}) };
      for (const f of fields) {
        const raw = String(f.el.value ?? '').trim();
        if (f.kind === 'extColor') { ext[f.key] = raw; continue; }
        const num = Number(raw.replace(',', '.'));
        if (!Number.isFinite(num) || num <= 0) {
          showError('Значения должны быть положительными числами');
          return;
        }
        if (f.kind === 'extPercent') ext[f.key] = Math.min(50, Math.max(2, num)) / 100;
        else if (f.kind === 'extInt') ext[f.key] = Math.round(num);
      }
      update.extendData = ext;
      saved.extendData = ext;
    } else {
      // Периоды
      const paramFields = fields.filter(f => f.kind === 'param');
      if (paramFields.length) {
        const params = [];
        for (const f of paramFields) {
          const num = Number(String(f.el.value ?? '').trim().replace(',', '.'));
          if (!Number.isFinite(num) || num <= 0) {
            showError('Периоды — положительные числа, например 14 или 7, 25');
            return;
          }
          params.push(num);
        }
        update.calcParams = params;
        saved.calcParams = params;
      }
      // Стили
      const styleFields = fields.filter(f => f.kind === 'styleColor' || f.kind === 'styleNum');
      if (styleFields.length) {
        const styles = {};
        for (const f of styleFields) {
          const [group, indexStr, prop] = f.key.split('.');
          const index = Number(indexStr);
          const arr = styles[group] = styles[group] || [];
          const slot = arr[index] = arr[index] || {};
          if (f.kind === 'styleColor') slot[prop] = String(f.el.value ?? '');
          else {
            const size = Number(String(f.el.value ?? '').trim().replace(',', '.'));
            if (!Number.isFinite(size) || size <= 0 || size > 8) {
              showError('Толщина линии — число от 0.5 до 8');
              return;
            }
            slot[prop] = size;
          }
        }
        update.styles = styles;
        saved.styles = styles;
      }
    }

    // Применение + сохранение. overrideIndicator 9.6 ищет инстанс по name
    // (IndicatorStore.override деструктурирует { name }). Легенда печатает
    // параметры рядом с названием — обновляем по завершении override
    // (9.6 асинхронный — колбэком)
    update.name = name;
    instance.overrideIndicator(update, null, () => renderIndicatorLegends());
    const store = loadIndicatorStore();
    store.settings[name] = saved;
    saveIndicatorStore([...indicators.keys()], store.settings);
    hideIndicatorEditDialog();
    setStatus(`${name}: настройки применены и сохранены`);
  };

  const bindIndicatorEditDialog = () => {
    const modal = document.getElementById('tc-ind-modal');
    if (!modal || modal.dataset.indEditBound) return;
    modal.dataset.indEditBound = '1';
    const applyBtn = document.getElementById('tc-ind-modal-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => applyIndicatorEditDialog());
    const cancelBtn = document.getElementById('tc-ind-modal-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => hideIndicatorEditDialog());
    const inputsBtn = document.getElementById('tc-ind-tab-inputs-btn');
    if (inputsBtn) inputsBtn.addEventListener('click', () => switchIndicatorEditTab('inputs'));
    const styleBtn = document.getElementById('tc-ind-tab-style-btn');
    if (styleBtn) styleBtn.addEventListener('click', () => switchIndicatorEditTab('style'));
    bindModalDismiss('tc-ind-modal', () => hideIndicatorEditDialog());
  };

  // ---- Сравнение инструментов на графике (как «Сравнить» в TradingView) ----
  // Линия другого инструмента нормируется к масштабу основного графика:
  // в точке привязки (первый общий бар) цены совпадают, дальше —
  // close_сравнения × (close_основного(t0) / close_сравнения(t0)). Так оба
  // графика читаются на одной шкале цены (в TV «Сравнить» работает так же,
  // а в режиме «Проценты» шкала сама покажет относительный рост обоих).
  // Каждая линия — отдельный кастомный индикатор TC_CMP_N (в 9.6 на панель
  // один инстанс на имя — имена уникальны), данные живут в замыкании:
  // список {ts, close} с переносом вперёд последней известной цены
  // (торговые календари инструментов не совпадают).

  const COMPARE_PREFIX = 'TC_CMP_';
  const COMPARE_MAX = 5;
  const COMPARE_COLORS = ['#e8a33d', '#c86fd1', '#4ecb78', '#38b6ff', '#f5c451'];
  const COMPARE_LS_KEY = 'wl_chart_compares';
  const compareSeries = new Map(); // имя индикатора → { ticker, display, color, data, factor, firstClose }
  let compareSeq = 0;

  const loadCompareSpecs = (ticker) => {
    try {
      const all = JSON.parse(localStorage.getItem(COMPARE_LS_KEY) || '{}');
      return Array.isArray(all[ticker]) ? all[ticker] : [];
    } catch (e) { return []; }
  };

  const saveCompareSpecs = (ticker, specs) => {
    if (!ticker) return;
    try {
      const all = JSON.parse(localStorage.getItem(COMPARE_LS_KEY) || '{}');
      if (specs && specs.length) all[ticker] = specs; else delete all[ticker];
      localStorage.setItem(COMPARE_LS_KEY, JSON.stringify(all));
    } catch (e) { /* localStorage недоступен — сравнения не сохранятся */ }
  };

  const serializeCompareSpecs = () => [...compareSeries.values()]
    .map(s => ({ ticker: s.ticker, color: s.color }));

  // Цена сравнения на бар ts: последняя известная close с ts' <= ts
  // (календари не совпадают — переносим вперёд, как делает TV)
  const compareCloseAt = (series, ts) => {
    let last = null;
    for (const p of series.data) {
      if (p.ts <= ts) last = p.close;
      else break;
    }
    return last;
  };

  // Регистрация линии сравнения: figure типа «line» со значением в масштабе
  // основного графика (диапазон оси свечной панели учитывает figures главных
  // индикаторов — линия «дышит» вместе с ценой, как в TV). Без type линия
  // библиотекой не рисуется (eachFigures красит только line/bar/circle)
  const registerCompareIndicator = (name, series) => {
    klinecharts.registerIndicator({
      name,
      shortName: series.display,
      figures: [{ key: 'value', title: '', type: 'line' }],
      calc: (dataList) => {
        let j = -1;
        let last = null;
        return (dataList || []).map((k) => {
          while (j + 1 < series.data.length && series.data[j + 1].ts <= k.timestamp) {
            j++;
            last = series.data[j].close;
          }
          return last == null ? {} : { value: last * series.factor };
        });
      },
      styles: { lines: [{ color: series.color, size: 2 }] },
    });
  };

  const removeCompareInternal = (name) => {
    const instance = getChartInstance();
    if (instance) {
      try { instance.removeIndicator('candle_pane', name); } catch (e) { /* уже удалён */ }
    }
    compareSeries.delete(name);
  };

  // Добавление линии сравнения. Возвращает null (успех) или текст ошибки —
  // диалог показывает её inline, как в остальных окнах настроек.
  window.tcAddCompare = async function (raw, opts = {}) {
    const instance = getChartInstance();
    const ticker = normalizeTicker(raw);
    if (!instance) return 'График ещё не готов';
    if (!ticker) return 'Введите тикер — например SVCB или BINANCE:ETHUSDT';
    if (!lastTicker || !instance.getDataList().length) return 'Сначала загрузите основной график';
    if (ticker === lastTicker) return 'Основной график уже показывает этот тикер';
    if (compareSeries.size >= COMPARE_MAX) return `Больше ${COMPARE_MAX} линий сравнения не добавить`;
    if ([...compareSeries.values()].some(s => s.ticker === ticker)) return `${ticker} уже на графике`;

    // За время запроса график мог смениться (тикер/ТФ) — данные сравнения
    // привязаны к интервалу, такой ответ отбрасывается
    const expectTicker = lastTicker;
    const expectInterval = currentInterval;

    let points = null;
    try {
      const lookback = TF_LOOKBACK_DAYS[expectInterval] || 600;
      const from = fmtDay(new Date(Date.now() - lookback * 86400000));
      const url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}`
        + `?interval=${expectInterval}&from=${from}&slice=1`;
      const response = await window.fetchWithTimeout(url, {}, 60000);
      const data = await response.json();
      if (data.error || !data.candles || !data.candles.length) {
        return `Свечи ${ticker} не найдены${data.error ? `: ${data.error}` : ''}`;
      }
      points = data.candles.map(toKline)
        .filter(k => !Number.isNaN(k.timestamp) && Number.isFinite(k.close))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(k => ({ ts: k.timestamp, close: k.close }));
    } catch (e) {
      return `Не удалось загрузить свечи ${ticker}: ${e.message || e}`;
    }
    if (lastTicker !== expectTicker || currentInterval !== expectInterval) return null; // график сменился — тихо пропускаем
    if (!points.length) return `Свечи ${ticker} не найдены`;

    // Точка привязки: первый бар основного графика, для которого у сравнения
    // есть цена (с переносом вперёд)
    const mainList = instance.getDataList();
    let factor = null;
    let firstClose = null;
    for (const k of mainList) {
      const c = compareCloseAt({ data: points }, k.timestamp);
      if (c != null && Number.isFinite(k.close) && k.close > 0) {
        firstClose = c;
        factor = k.close / c;
        break;
      }
    }
    if (factor == null) return `У ${ticker} и ${expectTicker} нет общих дат на интервале`;

    const series = {
      ticker,
      display: displayTicker(ticker),
      color: opts.color || COMPARE_COLORS[compareSeq % COMPARE_COLORS.length],
      data: points,
      factor,
      firstClose,
    };
    const name = `${COMPARE_PREFIX}${++compareSeq}`;
    registerCompareIndicator(name, series);
    const id = instance.createIndicator({ name }, true, { id: 'candle_pane' });
    if (!id) return `Линию сравнения ${ticker} создать не удалось`;
    compareSeries.set(name, series);
    saveCompareSpecs(lastTicker, serializeCompareSpecs());
    renderIndicatorLegends();
    refreshLegendPositionsSoon();
    if (!opts.silent) setStatus(`Сравнение: ${series.display} добавлен на график`);
    return null;
  };

  window.tcRemoveCompare = function (name) {
    const series = compareSeries.get(name);
    if (!series) return;
    removeCompareInternal(name);
    saveCompareSpecs(lastTicker, serializeCompareSpecs());
    renderIndicatorLegends();
    setStatus(`Сравнение ${series.display} убрано`);
  };

  // Восстановление сохранённых линий сравнения после загрузки графика
  // (спецификации хранятся по тикеру ОСНОВНОГО графика)
  const restoreCompares = async (ticker) => {
    for (const spec of loadCompareSpecs(ticker)) {
      if (!spec || !spec.ticker) continue;
      await window.tcAddCompare(spec.ticker, { color: spec.color, silent: true });
    }
  };

  // Список активных сравнений в диалоге («SVCB ×»)
  const renderCompareList = () => {
    const host = document.getElementById('tc-compare-list');
    if (!host) return;
    host.innerHTML = '';
    for (const [name, series] of compareSeries) {
      const row = document.createElement('span');
      row.className = 'tc-compare-row';
      const dot = document.createElement('span');
      dot.className = 'tc-compare-dot';
      dot.style.background = series.color;
      const nm = document.createElement('span');
      nm.className = 'tc-compare-name';
      nm.textContent = series.display;
      const x = document.createElement('span');
      x.className = 'tc-compare-close';
      x.textContent = '×';
      x.title = `Убрать ${series.display}`;
      x.addEventListener('click', () => {
        window.tcRemoveCompare(name);
        renderCompareList();
      });
      row.appendChild(dot);
      row.appendChild(nm);
      row.appendChild(x);
      host.appendChild(row);
    }
    host.style.display = compareSeries.size ? '' : 'none';
  };

  const hideCompareDialog = () => {
    const modal = document.getElementById('tc-compare-modal');
    if (modal) modal.classList.remove('active');
  };

  const showCompareError = (text) => {
    const errEl = document.getElementById('tc-compare-error');
    if (errEl) { errEl.textContent = text || ''; errEl.style.display = text ? '' : 'none'; }
  };

  window.tcOpenCompareDialog = function () {
    const instance = getChartInstance();
    const modal = document.getElementById('tc-compare-modal');
    if (!modal) return;
    if (!lastTicker || !instance || !instance.getDataList().length) {
      setStatus('Сначала загрузите график — с чем сравнивать?', true);
      return;
    }
    showCompareError('');
    renderCompareList();
    modal.classList.add('active');
    const input = document.getElementById('tc-compare-input');
    if (input && typeof input.focus === 'function') input.focus();
  };

  const applyCompareDialog = async () => {
    const input = document.getElementById('tc-compare-input');
    if (!input) return;
    const err = await window.tcAddCompare(input.value);
    if (err) { showCompareError(err); return; }
    showCompareError('');
    input.value = '';
    renderCompareList();
  };

  const bindCompareDialog = () => {
    const modal = document.getElementById('tc-compare-modal');
    if (!modal || modal.dataset.compareBound) return;
    modal.dataset.compareBound = '1';
    const btn = document.getElementById('tc-compare-btn');
    if (btn) btn.addEventListener('click', () => window.tcOpenCompareDialog());
    const addBtn = document.getElementById('tc-compare-add');
    if (addBtn) addBtn.addEventListener('click', () => applyCompareDialog());
    const cancelBtn = document.getElementById('tc-compare-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => hideCompareDialog());
    const input = document.getElementById('tc-compare-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key === 'Enter') { e.preventDefault(); applyCompareDialog(); }
        else if (e.key === 'Escape') hideCompareDialog();
      });
      // Автодополнение тикеров — тот же источник подсказок, что у полей
      // списка и шапки графика (js/symbol_search.js)
      if (window.symbolSearch && typeof window.symbolSearch.attach === 'function') {
        window.symbolSearch.attach(input, (item) => {
          input.value = item.symbol;
          applyCompareDialog();
        });
      }
    }
    bindModalDismiss('tc-compare-modal', () => hideCompareDialog());
  };

  // ---- Стартовые слушатели ----

  // klinecharts.init измеряет контейнер в момент вызова. Первый выбор
  // тикера происходит на DOMContentLoaded, когда активной может быть
  // другая страница («Главная»): контейнер 0×0, панель свечей
  // раскладывается в нулевую высоту, и после показа раздела свечи остаются
  // сжатыми в полосу у верхнего края (ResizeObserver растягивает канвас,
  // но раскладку панелей не пересчитывает). Поэтому загрузка в скрытом
  // разделе откладывается до первого показа (pendingSymbol), а уже
  // созданный график при показе пересобирается через resize().

  const chartSectionVisible = () => {
    const el = document.getElementById('watchlist-kline');
    return !!(el && el.offsetParent !== null);
  };

  // Показ раздела Watchlist: доигрывает отложенную загрузку и пересобирает
  // панели под реальные размеры. Вызывается из navigateTo (декоратор ниже);
  // render() к этому моменту уже вызвал createChart → wlChartLoad.
  window.wlChartSectionShown = function () {
    if (!chartSectionVisible()) return;
    // Меню могло остаться открытым при уходе с раздела — прячем (позиция устарела)
    hideCtxMenu();
    if (pendingSymbol) {
      const ticker = pendingSymbol;
      pendingSymbol = null;
      window.wlChartLoad(ticker);
    } else if (chartInstance && typeof chartInstance.resize === 'function') {
      // Раздел снова виден — пересобрать панели под реальные размеры
      chartInstance.resize();
    }
  };

  // Пересборка холста без перезагрузки данных: тянется ресайзером панели
  // списка (вызовы из main.js — окна слева меняют ширину, window-resize
  // при этом не срабатывает) и показом/скрытием панели.
  window.wlChartResize = function () { resizeChartSoon(); };

  // Показывает ли график сейчас этот символ (успешно загруженный).
  // ui.js createChart пропускает повторный вызов только для текущего
  // символа — клик по той же строке после сбоя сети повторяет загрузку.
  window.wlChartIsCurrent = function (symbol) {
    return lastTicker !== null && lastTicker === normalizeTicker(symbol);
  };

  // Символ не выбран (раздел списка/пустой список): гасим поллинг и
  // показываем заглушку поверх холста — как «пустой» виджет TradingView.
  window.wlChartReset = function () {
    pendingSymbol = null;
    stopPolling();
    const wrap = document.getElementById('watchlist-kline');
    if (wrap && !wrap.querySelector('.widget-fallback')) {
      const msg = document.createElement('div');
      msg.className = 'widget-fallback';
      msg.textContent = 'Добавьте тикер в список';
      wrap.appendChild(msg);
    }
  };

  // Показ раздела — как в portfolio.js: оборачиваем navigateTo, чтобы
  // отложить/догрузить график именно в момент, когда контейнер имеет размер
  const originalNavigateTo = window.navigateTo;
  window.navigateTo = function (pageName) {
    const result = typeof originalNavigateTo === 'function'
      ? originalNavigateTo(pageName) : undefined;
    if (pageName === 'watchlist') window.wlChartSectionShown();
    return result;
  };

  // ---- Поле тикера в шапке ----
  // Значение подставляется из выбранной в списке строки (syncTickerInput
  // внутри wlChartLoad), свой код загружается по Enter — тем же путём, что
  // клик по строке списка (createChart: график + новости). Escape возвращает
  // тикер, загруженный на графике (отмена ввода)
  const bindTickerInput = () => {
    const inp = document.getElementById('tc-sym-input');
    if (!inp || inp.dataset.tickerInputBound) return;
    inp.dataset.tickerInputBound = '1';
    inp.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = String(inp.value || '').trim();
        if (!raw) {
          setStatus('Введите тикер — например SBER или BINANCE:BTCUSDT', true);
          return;
        }
        const ticker = normalizeTicker(raw);
        inp.value = ticker; // нормализуем ввод сразу (регистр, без MOEX:)
        if (typeof window.createChart === 'function') window.createChart(ticker);
        else if (typeof window.wlChartLoad === 'function') window.wlChartLoad(ticker);
      } else if (e.key === 'Escape') {
        inp.value = lastTicker || '';
        if (typeof inp.blur === 'function') inp.blur();
      }
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    registerCustomOverlays();
    registerVolumeIndicator();
    registerSideVolumeIndicator();
    // Сохранённый вид (тип графика, режим шкалы, ТФ) читаем до первой
    // загрузки: init графика применит его стилями (apply…Type/ScaleMode)
    loadSavedView();
    syncTfButtons();
    // Дропдауны типа графика, шкалы цены и «Индикаторы»: триггер + меню,
    // подсветку активных пунктов ведут syncTypeButtons/syncScaleButtons/
    // syncIndicatorMenu
    buildTypeDropdown();
    syncTypeButtons();
    buildScaleDropdown();
    syncScaleButtons();
    buildIndicatorDropdown();
    // Плавающая панель настроек разметки: палитра/толщина/стиль/корзина
    // (показ — по выделению фигуры, см. overlayCallbacks)
    buildDrawSettings();
    syncUndoButtons(); // стеки пусты — стрелки в шапке приглушены
    // Отсчёт до закрытия бара: тикает раз в секунду, но пишет в DOM
    // только когда есть живая свеча и раздел виден (renderCountdown)
    startCountdownTimer();
    renderCountdown();
    // Сброс вида (двойной клик / правый клик → «Reset chart»), захват
    // кисти/измерителя и диалог настроек — слушатели защищены от
    // повторного навешивания
    bindResetViewUi();
    bindStageTools();
    // Курсор на холсте: плашка последней цены уступает место метке
    // кроссхейра (см. блок onChartPointerMove / syncAxisPriceTag)
    bindChartPointerTracking();
    bindSettingsDialog();
    bindTickerInput();
    // Диалог настроек индикатора («Входные данные»/«Стиль») и окно
    // «Сравнить» в шапке графика
    bindIndicatorEditDialog();
    bindCompareDialog();
    // Закрытие гистограммы объёма — × в строке «Объем» легенды OHLCV
    const volClose = document.getElementById('tc-leg-volume-close');
    if (volClose) volClose.addEventListener('click', () => window.tcRemoveIndicator(VOL_MAIN));
    // Настройки гистограммы (высота/цвета) — ⚙ рядом с × в той же строке
    const volGear = document.getElementById('tc-leg-volume-gear');
    if (volGear) {
      volGear.innerHTML = GEAR_SVG;
      volGear.addEventListener('click', () => window.tcConfigureIndicator(VOL_MAIN));
    }
    // Страховочные сохранения разметки: перед выгрузкой вкладки и при
    // сворачивании/переключении вкладки (перетаскивание точек без
    // onPressedMoveEnd всё равно попадёт в один из этих моментов).
    window.addEventListener('beforeunload', () => persistOverlays());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) persistOverlays();
    });
  });
})();
