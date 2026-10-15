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

window.ensureOverlayCanvas = function() {
  const chartBox = document.getElementById('tradingview_chart');
  if (!chartBox) return null;
  if (window.__overlayCanvas && window.__overlayCanvas.parentElement === chartBox) {
    return window.__overlayCanvas;
  }
  // TradingView сам создаёт внутри контейнера div с position:relative —
  // делаем его позиционированными родителем для canvas, если вдруг нет.
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

window.resizeOverlayCanvas = function() {
  const canvas = window.__overlayCanvas;
  const chartBox = document.getElementById('tradingview_chart');
  if (!canvas || !chartBox) return;
  const dpr = window.devicePixelRatio || 1;
  const w = chartBox.clientWidth, h = chartBox.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

// --- Перевод координат: цена/время <-> пиксели ------------------------------

// getChartScaleInfo берёт данные из iframe-а виджета; может вернуть null,
// если scale ещё не готов. height задаётся явно (canvas = размер контейнера).
window.priceToY = function(price) {
  try {
    const info = window.widget && window.widgetReady
      ? window.widget.getChartScaleInfo(window.__overlayCanvas?.clientHeight || 400)
      : null;
    if (!info || !isFinite(info.from) || !isFinite(info.to) || info.height <= 0) return null;
    return info.height - ((price - info.from) / (info.to - info.from)) * info.height;
  } catch (e) { return null; }
};

window.yToPrice = function(y) {
  try {
    const info = window.widget && window.widgetReady
      ? window.widget.getChartScaleInfo(window.__overlayCanvas?.clientHeight || 400)
      : null;
    if (!info || info.height <= 0) return null;
    return info.from + (info.height - y) / info.height * (info.to - info.from);
  } catch (e) { return null; }
};

window.timeToX = function(t) {
  try {
    if (!(window.widget && window.widgetReady)) return null;
    const x = window.widget.convertTime(t, 'UTC');
    return (x === -1 || x == null || !isFinite(x)) ? null : x;
  } catch (e) { return null; }
};

window.xToTime = function(x) {
  try {
    if (!(window.widget && window.widgetReady)) return null;
    const t = window.widget.convertTime(x, 'screen');
    return (t == null || !isFinite(t)) ? null : Math.round(t);
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
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);
      const label = `${fmtDate(it.time)}${it.text ? ' · ' + it.text : ''}`;
      drawChip(ctx, label, Math.min(Math.max(x + 6, 6), w - 120), 8, it.color || '#2962ff');
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
    if (p == null) { showHint('⚠ Шкала графика ещё не готова — подождите загрузки данных'); return; }
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
  if (show && !window.__markupSubscribed) subscribeMarkupSync();
};

window.setMarkupTool = function(tool) {
  window.__markupTool = (window.__markupTool === tool) ? null : tool;
  document.querySelectorAll('#markup-toolbar [data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === window.__markupTool);
  });
  const canvas = window.__overlayCanvas;
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
};

// Вызывается из createChart (ui.js) после смены символа: подгружаем разметку.
window.refreshMarkupForSymbol = function(symbol) {
  window.__markupItems = symbol ? loadMarkupFromStorage(symbol) : [];
  drawMarkup();
  loadActiveMarkupFromDb(); // асинхронно перезапишет, если в БД есть данные
};

// Инициализация: создаём canvas, вешаем перерисовку на изменение размеров.
window.initMarkupOverlay = function() {
  ensureOverlayCanvas();
  window.addEventListener('resize', () => drawMarkup());
  // Разделитель высоты графика (#resizer) и любые изменения размера контейнера —
  // ResizeObserver надёжнее перехвата style/mousemove.
  const chartBox = document.getElementById('tradingview_chart');
  if (chartBox && 'ResizeObserver' in window) {
    const ro = new ResizeObserver(() => drawMarkup());
    ro.observe(chartBox);
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
