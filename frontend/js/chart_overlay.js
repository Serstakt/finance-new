// ============================================================================
// РАЗМЕТКА ПОВЕРХ ВИДЖЕТА TRADINGVIEW (chart_overlay.js)
// ============================================================================
// Зачем: TradingView-виджет встраивается через iframe и НЕ даёт рисовать
// свои линии/тексты внутри графика — штатный инструментарий рисования
// отключён (enable_publishing: false, drawings не сохраняются без аккаунта).
// Поэтому разметка делается СНАРУЖИ: прозрачный <canvas>, наложенный над
// контейнером #tradingview_chart. Координаты уровней берём из API виджета
// (widget.getChartScaleInfo + widget.convertTime), синхронизацию перерисовки —
// через подписку widget.subscribe('data_loading'/'data_completed').
//
// Что поддерживается:
//   - горизонтальные уровни (линия + подпись цены) по цене;
//   - вертикальные отметки по времени (дата);
//   - текст-заметка в углу графика;
//   - мышь: клик по графику добавляет уровень по текущей цене/времени,
//     клик по линии удаляет её; перетаскивание уровня меняет цену;
//   - хранение: localStorage (мгновенно) + БД (колонка watchlist_items.markup,
//     переживает смену браузера; при недоступности бэкенда — только локально).
//
// Подключение: скрипт идёт после ui.js/main.js (нужны window.widget,
// appState, log). Все функции доступны как window.* для кнопок из HTML.
// ============================================================================

window.MARKUP_LS_KEY = 'chart_markup';

// Инструмент активной кнопки «🖊 Рисовать»
window.__markupTool = null; // 'hline' | 'vline' | 'text' | null

// Активные объекты разметки текущего символа: [{id,type,price,time,text,color}]
window.__markupItems = [];
// Ссылки на DOM-объекты оверлея
window.__overlayCanvas = null;
window.__overlayHint = null;

// --- Утилиты ---------------------------------------------------------------

window.loadMarkupFromStorage = function(symbol) {
  try {
    const all = JSON.parse(localStorage.getItem(window.MARKUP_LS_KEY) || '{}');
    return Array.isArray(all[symbol]) ? all[symbol] : [];
  } catch (e) { return []; }
};

window.saveMarkupToStorage = function(symbol, items) {
  try {
    const all = JSON.parse(localStorage.getItem(window.MARKUP_LS_KEY) || '{}');
    if (items && items.length) all[symbol] = items; else delete all[symbol];
    localStorage.setItem(window.MARKUP_LS_KEY, JSON.stringify(all));
  } catch (e) {}
};

// Сохранение в БД (watchlist_items.markup). Отвечает true/false — чтобы
// вызывающий код мог показать статус. fav_-списки не хранятся в БД (как заметки).
window.setMarkupInDb = async function(listId, symbol, json) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await window.fetchWithTimeout(`${API_BASE}/api/watchlist/markup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol, markup: json })
    }, 15000);
    if (res.status === 404) return true; // элемента нет в списке — не ошибка
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось сохранить разметку в БД: ' + e.message, 'error');
    return false;
  }
};

// Загрузка разметки активного тикера из БД (источник истины — она;
// localStorage служит кэшем/фолбэком при недоступном сервере).
window.loadActiveMarkupFromDb = async function() {
  const listId = appState.activeListId;
  const symbol = getCurrentList().activeSymbol;
  if (!listId || listId.startsWith('fav_') || !symbol) return;
  try {
    const res = await window.fetchWithTimeout(
      `${API_BASE}/api/watchlist/${encodeURIComponent(listId)}`, {}, 15000);
    if (!res.ok) return;
    const data = await res.json();
    const item = (data.items || []).find(i => i.symbol === symbol);
    if (item && typeof item.markup === 'string' && item.markup.trim()) {
      const parsed = JSON.parse(item.markup);
      if (Array.isArray(parsed)) {
        window.__markupItems = parsed;
        saveMarkupToStorage(symbol, parsed);
        drawMarkup();
      }
    }
  } catch (e) { /* сервер недоступен — работаем по localStorage */ }
};

window.persistActiveMarkup = function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol) return;
  saveMarkupToStorage(symbol, window.__markupItems);
  setMarkupInDb(appState.activeListId, symbol, JSON.stringify(window.__markupItems));
};

// --- Создание/синхронизация canvas -----------------------------------------

// ВАЖНО: canvas/hint вешаем на #chart-container, а НЕ внутрь #tradingview_chart.
// Виджет TradingView при инициализации полностью перезаписывает innerHTML
// своего контейнера (tv.js делает container.innerHTML = ...), поэтому узлы,
// добавленные внутрь #tradingview_chart, уничтожаются — клики «не работали».
window.ensureOverlayCanvas = function() {
  const chartBox = document.getElementById('chart-container')
                || document.getElementById('tradingview_chart');
  if (!chartBox) return null;
  if (window.__overlayCanvas && window.__overlayCanvas.parentElement === chartBox) {
    return window.__overlayCanvas;
  }
  if (getComputedStyle(chartBox).position === 'static') {
    chartBox.style.position = 'relative';
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'markup-overlay';
  canvas.title = 'Разметка поверх графика (клик — добавить объект, клик по линии — удалить)';
  chartBox.appendChild(canvas);

  const hint = document.createElement('div');
  hint.id = 'markup-hint';
  chartBox.appendChild(hint);
  window.__overlayHint = hint;

  canvas.addEventListener('mousedown', onOverlayMouseDown);
  window.__overlayCanvas = canvas;
  return canvas;
};

// Холст прикреплён к #chart-container, но должен покрывать ровно контейнер
// графика #tradingview_chart (чтобы не перекрывать панель новостей и шкалу
// времени). Поэтому растягиваем его через style.width/height и учитываем
// смещение графика относительно холста (top/left offsets).
window.overlayGeometry = function() {
  const canvas = window.__overlayCanvas;
  if (!canvas) return null;
  const host = canvas.parentElement; // #chart-container
  const tvBox = document.getElementById('tradingview_chart');
  if (!host || !tvBox) return null;
  const rh = host.getBoundingClientRect();
  const rt = tvBox.getBoundingClientRect();
  return { left: rt.left - rh.left, top: rt.top - rh.top, w: rt.width, h: rt.height };
};

window.resizeOverlayCanvas = function() {
  const canvas = window.__overlayCanvas;
  const g = overlayGeometry();
  if (!canvas || !g || g.w <= 0 || g.h <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.left = Math.round(g.left) + 'px';
  canvas.style.top = Math.round(g.top) + 'px';
  canvas.style.width = Math.round(g.w) + 'px';
  canvas.style.height = Math.round(g.h) + 'px';
  if (canvas.width !== Math.round(g.w * dpr) || canvas.height !== Math.round(g.h * dpr)) {
    canvas.width = Math.round(g.w * dpr);
    canvas.height = Math.round(g.h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

// --- Перевод координат: цена/время <-> пиксели ------------------------------

// Раньше использовались widget.getChartScaleInfo()/widget.convertTime(), но
// в обычном объекте TradingView.widget (tv.js) таких методов НЕТ — они всегда
// падали в null, и уровень НЕ СТАВИЛСЯ на график («шкала ещё не готова»).
//
// ВАЖНО ПРО ЦЕНУ: iframe виджета TradingView живёт в ДРУГОМ ИСТОЧНИКЕ
// (tradingview.com) и НЕ рассылает postMessage с телеметрией графика —
// слушатель 'message' ниже никогда не заполняется (эта ветка оставлена как
// фолбэк на случай будущих версий tv.js). Поэтому цена уровня строится
// вокруг ТЕКУЩЕЙ ЦЕНЫ ТИКЕРА (см. recentBarRange): у дневного графика
// последняя цена почти всегда стоит примерно по центру окна, и клик чуть
// выше/ниже центра даёт цену рядом с текущей. Диапазон ±3% подобран так,
// чтобы весь экран соответствовал реалистичному коридору цены за пару
// недель; при зуме TradingView синхронизировать его снаружи невозможно.
// Поэтому после постановки уровня цена ПОДТВЕРЖДАЕТСЯ/КОРРЕКТИРУЕТСЯ через
// prompt — если линия встала не там, где вы хотели, просто введите нужную
// цифру, и уровень перерисуется на точной цене (она же сохранится в БД).

window.__chartData = null;   // последний снимок postMessage-телеметрии TV (если появится)

// Приём телеметрии: слушатель вешаем сразу при загрузке скрипта (до
// включения разметки), чтобы данные накопились к моменту первого клика.
if (!window.__markupCdListenerAttached) {
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if ((d.action === 'chart_data' || d.action === 'series_data') && d.data) {
      window.__chartData = d.data;
    }
  });
  window.__markupCdListenerAttached = true;
}

// Верхняя панель инструментов TradingView внутри контейнера графика (~38px).
const TV_TOOLBAR_H = 38;

// Геометрия области рисования относительно ВЕРХНЕГО КРАЯ ХОЛСТА.
// Холст растянут ровно по #tradingview_chart (весь iframe), поэтому его
// координаты совпадают с координатами окна графика TradingView. Из высоты
// вычитаем верхнюю панель инструментов и нижнюю шкалу времени, из ширины —
// правую ценовую шкалу: линия должна ложиться ровно на область свечей.
function plotRectOnCanvas() {
  const canvas = window.__overlayCanvas;
  if (!canvas) return null;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!(w > 0 && h > 0)) return null;
  const cd = window.__chartData;
  const psW = isFinite(cd?.priceScale?.width) ? cd.priceScale.width : 60;
  const tsH = isFinite(cd?.timeScale?.height) ? cd.timeScale.height : 24;
  return { top: TV_TOOLBAR_H, h: Math.max(h - TV_TOOLBAR_H - tsH, 50),
           left: 0, w: Math.max(w - psW, 50) };
}

// Диапазон [min..max] для перевода «цена <-> пиксель». Используется когда
// TradingView НЕ присылает телеметрию (публичный виджет tv.js её не
// рассылает): строим шкалу по РЕАЛЬНЫМ дневным свечам тикера с бэкенда
// (/api/candles, источник MOEX ISS) — high/low последних ~120 баров. Это
// тот же период, который TradingView показывает по умолчанию, поэтому
// линии ложатся близко к ценовой шкале самого графика. Если candles ещё
// не загружены — временный фолбэк ±3% вокруг последней цены из DOM-строк
// watchlist / кэша appState / /api/prices.
const __lastKnownPrices = Object.create(null); // symbol -> price
const __candleRangeCache = Object.create(null); // symbol -> {min,max,ts}
const CANDLE_RANGE_TTL = 10 * 60 * 1000; // перезапрашиваем диапазон раз в 10 мин

function activeSymbol() {
  try { return getCurrentList().activeSymbol || ''; } catch (e) { return ''; }
}

async function refreshCandleRange(symbol) {
  if (!symbol || typeof API_BASE === 'undefined' || !window.fetchWithTimeout) return;
  const cached = __candleRangeCache[symbol];
  if (cached && Date.now() - cached.ts < CANDLE_RANGE_TTL) return;
  try {
    const res = await window.fetchWithTimeout(
      `${API_BASE}/api/candles/${encodeURIComponent(symbol)}?interval=1d&limit=120`, {}, 10000);
    if (!res.ok) return;
    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data && (data.candles || data.data));
    if (!Array.isArray(arr) || !arr.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const b of arr.slice(-120)) {
      const l = isFinite(b.low) ? b.low : b.close;
      const h = isFinite(b.high) ? b.high : b.close;
      if (isFinite(l)) lo = Math.min(lo, l);
      if (isFinite(h)) hi = Math.max(hi, h);
    }
    if (isFinite(lo) && isFinite(hi) && hi > lo) {
      __candleRangeCache[symbol] = { min: lo, max: hi, ts: Date.now() };
    }
  } catch (e) { /* нет сети — работаем по фолбэку от цены */ }
}

function rememberPriceFromDom() {
  try {
    const rows = document.querySelectorAll('[data-symbol]');
    for (const row of rows) {
      const sym = row.dataset.symbol;
      if (!sym || sym.startsWith('SECTION:')) continue;
      // Строка watchlist: <div data-symbol="MOEX:SBER"> … <div class="ticker-price" id="price-…">
      const el = row.querySelector(`#price-${sym.replace(/[^a-zA-Z0-9]/g, '_')}`)
              || row.querySelector('.ticker-price');
      if (!el) continue;
      const txt = String(el.textContent || '')
        .replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
      const val = parseFloat(txt);
      if (isFinite(val) && val > 0) __lastKnownPrices[sym] = val;
    }
  } catch (e) {}
}

async function fetchFallbackPrice(symbol) {
  try {
    if (!window.fetchWithTimeout || typeof API_BASE === 'undefined') return;
    const res = await window.fetchWithTimeout(`${API_BASE}/api/prices/${encodeURIComponent(symbol)}`, {}, 8000);
    if (!res.ok) return;
    const data = await res.json();
    const c = data && (data.price != null ? data.price : data.close);
    if (isFinite(c) && c > 0) __lastKnownPrices[symbol] = c;
  } catch (e) { /* нет сети — фолбэк по DOM/кэшу */ }
}

function recentBarRange() {
  try {
    const symbol = activeSymbol();
    if (!symbol) return null;
    let p = __lastKnownPrices[symbol];
    if (!isFinite(p) || p <= 0) {
      rememberPriceFromDom();
      p = __lastKnownPrices[symbol];
    }
    if ((!isFinite(p) || p <= 0) && typeof appState !== 'undefined') {
      // структуры кэша цен могут называться по-разному в разных версиях UI
      const caches = [appState.lastPrices, appState.prices, appState.candleCache];
      for (const cache of caches) {
        const v = cache && cache[symbol];
        const c = v && (v.price != null ? v.price : (Array.isArray(v) ? null : v.close));
        if (isFinite(c) && c > 0) { p = c; break; }
        if (Array.isArray(v) && v.length) {
          const last = v[v.length - 1];
          if (last && isFinite(last.close) && last.close > 0) { p = last.close; break; }
        }
      }
    }
    if (!isFinite(p) || p <= 0) {
      fetchFallbackPrice(symbol); // асинхронно подтянем цену на следующий клик
      return null;
    }
    return { min: p * 0.97, max: p * 1.03 };
  } catch (e) { return null; }
}

// Актуальный видимый ценовой диапазон: сначала телеметрия TV, затем реальные
// свечи с бэкенда, затем фолбэк ±3% от текущей цены.
function visiblePriceRange() {
  const cd = window.__chartData;
  if (cd) {
    const data = cd.series && Array.isArray(cd.series.data) ? cd.series.data : null;
    if (data && data.length) {
      let lo = Infinity, hi = -Infinity;
      const from = Math.max(0, data.length - 300);
      for (let i = from; i < data.length; i++) {
        const b = data[i];
        const l = isFinite(b.low) ? b.low : b.close;
        const h = isFinite(b.high) ? b.high : b.close;
        if (isFinite(l)) lo = Math.min(lo, l);
        if (isFinite(h)) hi = Math.max(hi, h);
      }
      if (isFinite(lo) && isFinite(hi) && hi > lo) return { min: lo, max: hi };
    }
    if (isFinite(cd.currentUnitPriceRangeMin) && isFinite(cd.currentUnitPriceRangeMax)
        && cd.currentUnitPriceRangeMax > cd.currentUnitPriceRangeMin) {
      return { min: cd.currentUnitPriceRangeMin, max: cd.currentUnitPriceRangeMax };
    }
  }
  const symbol = activeSymbol();
  const cr = symbol && __candleRangeCache[symbol];
  if (cr && Date.now() - cr.ts < CANDLE_RANGE_TTL && cr.max > cr.min) {
    return { min: cr.min, max: cr.max };
  }
  if (symbol) refreshCandleRange(symbol); // догрузим к следующему клику/перерисовке
  return recentBarRange();
}

window.priceToY = function(price) {
  try {
    const range = visiblePriceRange();
    const plot = plotRectOnCanvas();
    if (!range || !plot) return null;
    const frac = (price - range.min) / (range.max - range.min);
    return plot.top + plot.h - frac * plot.h;
  } catch (e) { return null; }
};

window.yToPrice = function(y) {
  try {
    const range = visiblePriceRange();
    const plot = plotRectOnCanvas();
    if (!range || !plot) return null;
    const frac = (plot.top + plot.h - y) / plot.h;
    return range.min + frac * (range.max - range.min);
  } catch (e) { return null; }
};

window.timeToX = function(t) {
  try {
    const cd = window.__chartData;
    if (!cd) return null;
    const vr = cd.visibleLogicalRange, bw = cd.defaultBarWidth;
    const data = cd.series && Array.isArray(cd.series.data) ? cd.series.data : [];
    if (!vr || !isFinite(vr.from) || !isFinite(vr.to) || !isFinite(bw) || bw <= 0 || !data.length) return null;
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < data.length; i++) {
      const bt = data[i].time;
      if (!isFinite(bt)) continue;
      const diff = Math.abs((bt > 1e12 ? bt / 1000 : bt) - t);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const barsVisible = Math.max(Math.round(vr.to - vr.from), 1);
    return (bestIdx - (data.length - barsVisible)) * bw;
  } catch (e) { return null; }
};

window.xToTime = function(x) {
  try {
    const cd = window.__chartData;
    if (!cd) return null;
    const vr = cd.visibleLogicalRange, bw = cd.defaultBarWidth;
    const data = cd.series && Array.isArray(cd.series.data) ? cd.series.data : [];
    if (!vr || !isFinite(vr.from) || !isFinite(vr.to) || !isFinite(bw) || bw <= 0 || !data.length) return null;
    const barsVisible = Math.max(Math.round(vr.to - vr.from), 1);
    const idx = Math.round(x / bw) + (data.length - barsVisible);
    const bar = data[Math.min(Math.max(idx, 0), data.length - 1)];
    if (!bar || !isFinite(bar.time)) return null;
    return Math.round(bar.time > 1e12 ? bar.time / 1000 : bar.time);
  } catch (e) { return null; }
};

// --- Отрисовка ---------------------------------------------------------------

window.drawMarkup = function() {
  const canvas = window.__overlayCanvas;
  if (!canvas) return;
  resizeOverlayCanvas();
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Область самого графика на холсте (под панелью инструментов TradingView).
  const top = TV_TOOLBAR_H;

  for (const it of window.__markupItems) {
    if (it.type === 'hline') {
      const y = priceToY(it.price);
      if (y == null) continue; // scale ещё не готов — дождёмся data_completed
      ctx.strokeStyle = it.color || '#ffca28';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      const label = `${fmtPrice(it.price)}${it.text ? ' · ' + it.text : ''}`;
      drawChip(ctx, label, 6, y - 9, it.color || '#ffca28');
    } else if (it.type === 'vline') {
      const x = timeToX(it.time);
      if (x == null) continue;
      ctx.strokeStyle = it.color || '#2962ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);
      const label = `${fmtDate(it.time)}${it.text ? ' · ' + it.text : ''}`;
      drawChip(ctx, label, Math.min(Math.max(x + 6, 6), w - 120), top + 4, it.color || '#2962ff');
    } else if (it.type === 'text') {
      drawChip(ctx, it.text || '…', 10, h - 30, it.color || '#26a69a');
    }
  }
};

function drawChip(ctx, text, x, y, color) {
  ctx.font = '12px system-ui, sans-serif';
  const padX = 6, padY = 3;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(30,34,45,0.9)';
  roundRect(ctx, x, y, tw + padX * 2, 18 + padY, 4); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  roundRect(ctx, x, y, tw + padX * 2, 18 + padY, 4); ctx.stroke();
  ctx.fillStyle = '#d1d4dc';
  ctx.fillText(text, x + padX, y + 13);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmtPrice(p) {
  if (!isFinite(p)) return '';
  const abs = Math.abs(p);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 3 : 6;
  return p.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('ru-RU');
}

// --- Взаимодействие мышью ----------------------------------------------------

// Hit-test: ближайший кликабельный объект (для удаления/перетаскивания).
function hitTestItem(mx, my) {
  const canvas = window.__overlayCanvas;
  let best = null, bestDist = 7; // px — порог попадания
  for (const it of window.__markupItems) {
    if (it.type === 'hline') {
      const y = priceToY(it.price);
      if (y != null && Math.abs(my - y) < bestDist) { best = it; bestDist = Math.abs(my - y); }
    } else if (it.type === 'vline') {
      const x = timeToX(it.time);
      if (x != null && Math.abs(mx - x) < bestDist) { best = it; bestDist = Math.abs(mx - x); }
    }
  }
  return best;
}

let __dragItem = null;

function onOverlayMouseDown(e) {
  if (e.button !== 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;

  // 1) Попадание по существующей линии — перетаскивание (изменение цены/времени).
  //    Удаление — двойной клик (см. initMarkupOverlay).
  const hit = hitTestItem(mx, my);
  if (hit) {
    __dragItem = { item: hit, startX: mx, startY: my, moved: false };
    e.preventDefault();
    const onMove = (ev) => {
      const r = window.__overlayCanvas.getBoundingClientRect();
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
      if (!__dragItem) return;
      if (Math.abs(cy - __dragItem.startY) > 2 || Math.abs(cx - __dragItem.startX) > 2) __dragItem.moved = true;
      if (__dragItem.item.type === 'hline') {
        const p = yToPrice(cy);
        if (p != null) { __dragItem.item.price = roundToTick(p); drawMarkup(); }
      } else if (__dragItem.item.type === 'vline') {
        const t = xToTime(cx);
        if (t != null) { __dragItem.item.time = t; drawMarkup(); }
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (__dragItem && __dragItem.moved) persistActiveMarkup();
      __dragItem = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return;
  }

  // 2) Активный инструмент — добавление нового объекта в точку клика.
  const tool = window.__markupTool;
  if (!tool) return;
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
  if (tool === 'hline') {
    const p = yToPrice(my);
    if (p == null) { showHint('⚠ Шкала графика ещё не готова — подождите загрузки цены и повторите клик'); return; }
    item.type = 'hline'; item.price = roundToTick(p); item.color = '#ffca28';
  } else if (tool === 'vline') {
    const t = xToTime(mx);
    if (t == null) { showHint('⚠ Не удалось определить время по позиции курсора'); return; }
    item.type = 'vline'; item.time = t; item.color = '#2962ff';
  } else if (tool === 'text') {
    const txt = prompt('Текст заметки на графике:');
    if (!txt) return;
    item.type = 'text'; item.text = txt.slice(0, 120); item.color = '#26a69a';
  } else return;
  window.__markupItems.push(item);
  drawMarkup();
  persistActiveMarkup();
  setMarkupTool(null); // один объект за одно включение — безопаснее случайных кликов
}

function roundToTick(p) {
  const abs = Math.abs(p);
  const q = abs >= 1000 ? 1 : abs >= 100 ? 0.1 : abs >= 1 ? 0.01 : abs >= 0.01 ? 0.0001 : 0.000001;
  return Math.round(p / q) * q;
}

// Удаление всех объектов текущего типа (кнопка 🧹)
window.clearMarkup = function() {
  const sym = getCurrentList().activeSymbol;
  if (!sym) return;
  if (!window.__markupItems.length) { showHint('Разметки на этом тикере нет'); return; }
  if (!confirm(`Удалить всю разметку по ${sym}?`)) return;
  window.__markupItems = [];
  drawMarkup();
  persistActiveMarkup();
  showHint('🧹 Разметка очищена');
};

// Удаление последнего добавленного объекта (Ctrl+Z не перехватываем у iframe)
window.undoLastMarkup = function() {
  if (!window.__markupItems.length) return;
  window.__markupItems.pop();
  drawMarkup();
  persistActiveMarkup();
};

// --- Тулбар -------------------------------------------------------------------

window.toggleMarkupToolbar = function() {
  const tb = document.getElementById('markup-toolbar');
  if (!tb) return;
  const show = tb.style.display === 'none' || !tb.style.display;
  tb.style.display = show ? 'flex' : 'none';
  if (show) {
    // Canvas создаём лениво — при первом включении разметки. Если бы он
    // создавался на DOMContentLoaded, вёрстка TradingView могла бы его
    // уничтожить/перекрыть, и клики по графику «не работали» бы.
    ensureOverlayCanvas();
    drawMarkup();
    subscribeMarkupSync();
  } else {
    setMarkupTool(null); // скрываем тулбар — выходим из режима рисования
  }
};

window.setMarkupTool = function(tool) {
  window.__markupTool = (window.__markupTool === tool && tool) ? null : tool;
  document.querySelectorAll('#markup-toolbar [data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === window.__markupTool);
  });
  let canvas = ensureOverlayCanvas(); // на всякий случай: холст должен существовать
  if (canvas) {
    // В режиме рисования холст ловит мышь; иначе насквозь — график живёт своей жизнью.
    canvas.classList.toggle('drawing', !!window.__markupTool);
  }
  showHint(window.__markupTool
    ? '🖊 Кликните по графику, чтобы поставить объект (повторное нажатие кнопки — выключить)'
    : '');
};

function showHint(text) {
  const hint = window.__overlayHint;
  if (!hint) return;
  hint.textContent = text || '';
  hint.style.display = text ? 'block' : 'none';
  if (text) {
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => { if (hint.textContent === text) hint.style.display = 'none'; }, 4000);
  }
}

// --- Синхронизация перерисовки с виджетом -------------------------------------

// При зуме/сдвиге/смене символа TradingView рассылает события внутри iframe.
// subscribe доступен на объекте виджета tv.js; подписываемся один раз.
// Дополнительно ставим «страховой» таймер перерисовки: если событий виджета
// не дождёмся (блокировки, смена версии tv.js), линии всё равно будут
// подтягиваться при активном режиме рисования.
window.subscribeMarkupSync = function() {
  const doSubscribe = () => {
    if (!(window.widget && window.widgetReady) || window.__markupSubscribed) return;
    try {
      for (const ev of ['data_loading', 'data_completed', 'onVisibleRangeChange']) {
        if (typeof window.widget.subscribe === 'function') {
          window.widget.subscribe(ev, () => drawMarkup());
        }
      }
      window.__markupSubscribed = true;
    } catch (e) { console.warn('subscribe для разметки недоступен:', e); }
  };
  doSubscribe();
  if (!window.__markupSubscribed) setTimeout(doSubscribe, 1500);
  if (!window.__markupDrawTimer) {
    window.__markupDrawTimer = setInterval(() => {
      // Рисуем только когда есть что рисовать или активен инструмент —
      // иначе таймер холостой и не грузит страницу.
      if (window.__markupItems.length || window.__markupTool) drawMarkup();
    }, 700);
  }
};

// Вызывается из createChart (ui.js) после смены символа: подгружаем разметку.
window.refreshMarkupForSymbol = function(symbol) {
  window.__markupItems = symbol ? loadMarkupFromStorage(symbol) : [];
  drawMarkup();
  loadActiveMarkupFromDb(); // асинхронно перезапишет, если в БД есть данные
};

// Инициализация: canvas создаётся лениво (при первом включении разметки,
// см. toggleMarkupToolbar) — здесь только вешаем слушателей перерисовки.
window.initMarkupOverlay = function() {
  window.addEventListener('resize', () => drawMarkup());
  // Разделитель/скрытие watchlist и любые изменения размера — ResizeObserver
  // надёжнее перехвата style/mousemove. Следим за контейнером холста
  // (#chart-container) и за самим графиком (#tradingview_chart).
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      if (window.__overlayCanvas) drawMarkup();
    });
    for (const id of ['chart-container', 'tradingview_chart']) {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    }
  }
  // Двойной клик по линии — удалить объект
  document.addEventListener('dblclick', (e) => {
    const canvas = window.__overlayCanvas;
    if (!canvas || e.target !== canvas) return;
    const r = canvas.getBoundingClientRect();
    const hit = hitTestItem(e.clientX - r.left, e.clientY - r.top);
    if (hit) {
      window.__markupItems = window.__markupItems.filter(i => i.id !== hit.id);
      drawMarkup();
      persistActiveMarkup();
      showHint('✕ Объект удалён');
    }
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMarkupOverlay);
} else {
  initMarkupOverlay();
}
