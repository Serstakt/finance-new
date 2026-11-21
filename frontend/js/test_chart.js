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
//     «улетевший» зум/сдвиг всегда можно вернуть.

(() => {
  let chartInstance = null;
  let lastTicker = null; // последний успешно введённый тикер (сохранение разметки, guard поллинга)
  let lastTs = null; // timestamp последней свечи — точка инкремента поллинга
  let pollTimer = null;
  let pollKey = null; // 'TICKER|interval' — поллинг останавливается, если данные сменились
  let overlayIds = []; // id созданных overlay — для сериализации разметки
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

  const setStatus = (text, isError = false, isWarn = false) => {
    const el = document.getElementById('test-chart-status');
    if (el) {
      el.textContent = text;
      el.classList.toggle('error', isError);
      el.classList.toggle('warn', !isError && isWarn);
    }
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
    registerRectOverlay();
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
      // Дефолтный вид для сброса: снимаем до первого applyNewData и до
      // restoreViewport пользовательских зума/сдвига — это чистые дефолты
      defaultViewport = {
        barSpace: chartInstance.getBarSpace(),
        offsetRight: chartInstance.getOffsetRightDistance(),
      };
      // Volume-гистограмма включена по умолчанию (как в TradingView);
      // выключается чипом, включается обратно через dropdown индикаторов
      if (!indicators.has(VOL_MAIN)) {
        const id = chartInstance.createIndicator(VOL_MAIN, false, { id: 'candle_pane' });
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

  const bindResetViewUi = () => {
    const stage = document.getElementById('tc-chart-stage');
    const menu = document.getElementById('tc-ctx-menu');
    if (!stage || stage.dataset.resetViewBound) return;
    stage.dataset.resetViewBound = '1';
    // Двойной клик — сброс вида (как в TradingView)
    stage.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetChartView();
    });
    // Правый клик — своё меню вместо браузерного
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY);
    });
    const item = menu && document.getElementById('tc-ctx-reset');
    if (item) {
      // Клик по пункту: сброс произойдёт до закрытия (клик всплывает в
      // document-обработчик ниже — он только прячет меню)
      item.addEventListener('click', () => resetChartView());
    }
    // Закрытие меню: клик где угодно, Escape, изменение размера окна
    document.addEventListener('click', () => { if (ctxMenuOpen) hideCtxMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape' && ctxMenuOpen) hideCtxMenu();
    });
    window.addEventListener('resize', () => { if (ctxMenuOpen) hideCtxMenu(); });
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
      const points = (o.points || [])
        .filter(p => p && p.timestamp != null && p.value != null)
        .map(p => ({ timestamp: p.timestamp, value: p.value }));
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
  // (контекстное меню по правому клику, «Очистить»).
  const overlayCallbacks = () => ({
    onDrawEnd: () => {
      clearToolActive();
      persistOverlays();
    },
    onPressedMoveEnd: () => persistOverlays(),
    onDeselected: () => persistOverlays(),
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
      // points с timestamp/value рисуются сразу, без режима рисования:
      // Overlay.setPoints сам переводит timestamp в dataIndex
      const id = chartInstance.createOverlay({
        name: s.name,
        extendData: s.extendData ?? undefined,
        points: s.points.map(p => ({ timestamp: p.timestamp, value: p.value })),
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

  const fmtNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n)
      ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
    changeEl.textContent = `${sign}${delta.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
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

  // Легенда + цена из текущих данных графика (последняя свеча)
  const refreshChartReadouts = () => {
    if (!chartInstance) return;
    const list = chartInstance.getDataList();
    renderLegend(list.length ? list[list.length - 1] : null);
    updateSymbolQuote(list);
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
      }

      // Вид графика (масштаб + сдвиг) не должен прыгать при смене данных
      const vp = saveViewport();
      instance.applyNewData(klineData, true);
      lastTs = klineData.length ? klineData[klineData.length - 1].timestamp : null;
      lastTicker = ticker;
      restoreViewport(vp);
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

  // ---- Панель разметки: рисование нативных overlay-объектов KLineChart ----
  // Клик по иконке на вертикальной панели включает инструмент: следующий
  // клик(и) по графику ставят точки фигуры. Правый клик по готовой фигуре
  // удаляет её (стандартное поведение KLineChart).
  window.tcDrawOverlay = function (name, btn) {
    const instance = getChartInstance();
    if (!instance) return;
    // Подсветка активного инструмента — как выбранная иконка в TradingView
    setToolActive(btn);
    if (name === 'text') {
      const text = window.prompt('Текст заметки на графике:');
      if (!text) return;
      // В 9.6 нет шаблона «text» — используем встроенную аннотацию
      // simpleAnnotation: содержимое берётся из extendData (строка)
      const id = instance.createOverlay({
        name: 'simpleAnnotation', extendData: text, ...overlayCallbacks(),
      });
      if (id) overlayIds.push(id);
      setStatus('Кликните по свече — текст привяжется к её цене');
      return;
    }
    const hints = {
      segment: 'Кликните по графику 2 раза — начало и конец отрезка',
      horizontalRayLine: 'Кликните по графику — уровень поставится на эту цену',
      'tc-rect': 'Кликните по графику 2 раза — противоположные углы прямоугольника',
      fibonacciLine: 'Кликните по графику 2 раза — уровни 0.236…∞ между ценами',
    };
    const id = instance.createOverlay({ name, ...overlayCallbacks() });
    if (id) overlayIds.push(id);
    setStatus(hints[name] || 'Кликните по графику, чтобы поставить фигуру');
  };

  window.tcClearOverlays = function () {
    if (!chartInstance) return;
    chartInstance.removeOverlay();
    overlayIds = [];
    clearToolActive();
    persistOverlays();
    setStatus('Разметка удалена');
  };

  // ---- Индикаторы: dropdown всех встроенных + чипы с настройкой периодов ----
  // В 9.6.0 removeIndicator требует (paneId, name?) — раньше передавали имя
  // как paneId, и выключение индикатора было no-op.

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
    const id = instance.createIndicator(name, false, pane);
    if (!id) { setStatus(`Индикатор ${name} не поддерживается библиотекой`, true); return; }
    indicators.set(name, pane.id);
    renderIndicatorChips();
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
  // текущие значения берём из живого инстанса, правим через overrideIndicator
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
    } catch (e) { /* инстанс не найден — промпт без подсказки */ }
    const raw = window.prompt(
      `Периоды ${name} через запятую${current ? ` (сейчас: ${current})` : ''}:`, current || '14'
    );
    if (raw == null) return; // отмена
    const params = raw.split(',').map(s => parseFloat(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!params.length) { setStatus('Не понял периоды — нужны положительные числа через запятую', true); return; }
    instance.overrideIndicator({ name, calcParams: params });
    setStatus(`${name}: периоды ${params.join(', ')} применены`);
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
    registerRectOverlay();
    registerVolumeIndicator();
    syncTfButtons();
    // Сброс вида (двойной клик / правый клик → «Reset chart») — слушатели
    // на .tc-chart-stage, защищены от повторного навешивания
    bindResetViewUi();
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
