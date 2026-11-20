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
//     onCrosshairChange, в 9.6 payload несёт kLineData).

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
  const MAIN_PANE_INDICATORS = new Set(['MA', 'EMA', 'BOLL', 'SAR', 'BBI', 'AVP']);

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
      // Легенда OHLCV следует за кроссхейром (как в TradingView). При уходе
      // курсора KLineChart отдаёт последнюю свечу — легенда «возвращается».
      if (typeof chartInstance.subscribeAction === 'function') {
        chartInstance.subscribeAction('onCrosshairChange', (ev) => {
          if (ev && ev.kLineData) renderLegend(ev.kLineData);
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
      const nm = document.createElement('span');
      nm.className = 'tc-ind-name';
      nm.textContent = name;
      nm.title = `${name} — настройки периодов`;
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
    setStatus(`Индикатор ${name} включён — клик по названию открывает периоды`);
  };

  window.tcRemoveIndicator = function (name) {
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    if (!instance || !paneId) return;
    instance.removeIndicator(paneId, name);
    indicators.delete(name);
    renderIndicatorChips();
    setStatus(`Индикатор ${name} выключен`);
  };

  // Настройка периодов (как клик по названию индикатора в TradingView):
  // текущие значения берём из живого инстанса, правим через overrideIndicator
  window.tcConfigureIndicator = function (name) {
    const instance = getChartInstance();
    const paneId = indicators.get(name);
    if (!instance || !paneId) return;
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
    syncTfButtons();
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
