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

// Ключ localStorage для «сиротской» разметки: объекты, поставленные в
// списках, которые ещё не зарегистрированы в БД (fav_* и списки, созданные
// офлайн). Без этого шага разметка терялась бы при первом сохранении:
// setMarkupInDb/loadActiveMarkupFromDb пропускают такие списки, а
// persistActiveMarkup перезаписывает обычный кэш пустым массивом.
window.MARKUP_ORPHAN_LS_KEY = 'chart_markup_orphan';

function loadOrphanMarkup(symbol) {
  try {
    const all = JSON.parse(localStorage.getItem(window.MARKUP_ORPHAN_LS_KEY) || '{}');
    return Array.isArray(all[symbol]) ? all[symbol] : null;
  } catch (e) { return null; }
}

function saveOrphanMarkup(symbol, items) {
  try {
    const all = JSON.parse(localStorage.getItem(window.MARKUP_ORPHAN_LS_KEY) || '{}');
    if (items && items.length) all[symbol] = items; else delete all[symbol];
    localStorage.setItem(window.MARKUP_ORPHAN_LS_KEY, JSON.stringify(all));
  } catch (e) {}
}

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
  if (!symbol) return;
  // Списки вне БД (fav_*, созданные офлайн): отдаём «сиротскую» разметку из
  // отдельного localStorage-ключа — обычный кэш persistActiveMarkup затирает.
  if (!listId || listId.startsWith('fav_')) {
    const orphan = loadOrphanMarkup(symbol);
    if (orphan && orphan.length) {
      window.__markupItems = orphan;
      drawMarkup();
    }
    return;
  }
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
  // fav_*-списки (и списки, ещё не зарегистрированные в БД) не хранят
  // разметку на сервере — держим её в отдельном localStorage-ключе,
  // иначе следующий loadMarkupFromStorage/refresh вернул бы пустоту.
  const listId = appState.activeListId;
  if (!listId || listId.startsWith('fav_')) {
    saveOrphanMarkup(symbol, window.__markupItems);
    return;
  }
  setMarkupInDb(listId, symbol, JSON.stringify(window.__markupItems));
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

// getChartScaleInfo берёт данные из iframe-а виджета; может вернуть null,
// если scale ещё не готов. height = высота ОБЛАСТИ ГРАФИКА: полотно лежит на
// #chart-container и покрывает ровно контейнер графика #tradingview_chart
// (панель «Новости / Заметки» — отдельный flex-элемент ниже), а сверху —
// стандартная панель инструментов TradingView (~38px внутри контейнера
// графика). Координаты кликов/рисования — в системе полотна.
const TV_TOOLBAR_H = 38; // примерная высота верхней панели tv.js

// Высота области графика для виджетного API. Берём РЕАЛЬНУЮ высоту холста,
// а не захардкоженную: раньше здесь фигурировала «bottom:120px», которая
// разъезжалась с фактической вёрсткой — линии рисовались не на своей цене,
// а при низком окне «уровень» вообще уходил за край (клип canvas-ом), и
// казалось, что разметка не ставится.
function chartAreaHeight() {
  const canvas = window.__overlayCanvas;
  if (!canvas) return 400;
  const h = canvas.getBoundingClientRect().height - TV_TOOLBAR_H;
  return Math.max(h, 100);
}

window.priceToY = function(price) {
  try {
    const info = window.widget && window.widgetReady
      ? window.widget.getChartScaleInfo(chartAreaHeight())
      : null;
    if (!info || !isFinite(info.from) || !isFinite(info.to) || info.height <= 0) return null;
    // y шкалы -> y полотна (область графика начинается под панелью инструментов)
    return TV_TOOLBAR_H + info.height - ((price - info.from) / (info.to - info.from)) * info.height;
  } catch (e) { return null; }
};

window.yToPrice = function(y) {
  try {
    const info = window.widget && window.widgetReady
      ? window.widget.getChartScaleInfo(chartAreaHeight())
      : null;
    if (!info || info.height <= 0) return null;
    const localY = y - TV_TOOLBAR_H;
    return info.from + (info.height - localY) / info.height * (info.to - info.from);
  } catch (e) { return null; }
};

window.timeToX = function(t) {
  try {
    if (!(window.widget && window.widgetReady)) return null;
    const x = window.widget.convertTime(t, 'UTC');
    if (x === -1 || x == null || !isFinite(x)) return null;
    // Полотно выровнено по левому краю контейнера графика -> x совпадает.
    return x;
  } catch (e) { return null; }
};

window.xToTime = function(x) {
  try {
    if (!(window.widget && window.widgetReady)) return null;
    const t = window.widget.convertTime(x, 'screen');
    return (t == null || !isFinite(t)) ? null : Math.round(t);
  } catch (e) { return null; }
};

// Ждём, пока шкала виджета станет доступной (widgetReady + getChartScaleInfo).
// Без этой страховки клик сразу после включения разметки молча падал:
// yToPrice возвращал null («Шкала ещё не готова»), объект не создавался,
// и уровень на график не ставился. resolve(true) — шкала готова;
// resolve(false) — таймаут (вызывающий покажет подсказку).
window.waitForChartScale = function(timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise((resolve) => {
    const scaleOk = () => {
      try {
        if (!(window.widget && window.widgetReady)) return false;
        const info = window.widget.getChartScaleInfo(chartAreaHeight());
        return !!(info && isFinite(info.from) && isFinite(info.to) && info.height > 0);
      } catch (e) { return false; }
    };
    if (scaleOk()) { resolve(true); return; }
    const started = Date.now();
    const iv = setInterval(() => {
      if (scaleOk()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 150);
  });
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
    window.addEventListener('mousemove', onOverlayMouseMove);
    window.addEventListener('mouseup', onOverlayMouseUp);
    return;
  }

  // 2) Активный инструмент — добавление нового объекта в точку клика.
  const tool = window.__markupTool;
  if (!tool) return;
  // Запоминаем точку клика: если шкала ещё не готова, ждём её и ставим
  // объект в ту же точку (раньше клик просто молча пропадал).
  addMarkupAtPoint(tool, mx, my);
}

// Добавление объекта разметки по координатам клика на холсте. Асинхронная:
// сначала дожидаемся готовности ценовой/временной шкалы виджета — иначе
// yToPrice/xToTime вернут null и «уровень не ставится на график».
window.addMarkupAtPoint = async function(tool, mx, my) {
  if (!tool) return;
  const ready = await waitForChartScale(5000);
  if (!ready) {
    showHint('⚠ Шкала графика недоступна — обновите страницу или выберите тикер');
    return;
  }
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
  if (tool === 'hline') {
    const p = yToPrice(my);
    if (p == null) { showHint('⚠ Не удалось определить цену по позиции курсора'); return; }
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
};

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
  // Кнопка «🖊 Разметка» живёт в нижней панели, которая скрыта, пока не
  // выбран тикер (и показывает заглушку вместо графика). Без активного
  // символа рисовать не на чем — включение молча «не работало».
  const sym = getCurrentList().activeSymbol;
  if (!sym || sym.startsWith('SECTION:')) {
    tb.style.display = 'none';
    showHint('⚠ Сначала выберите тикер в списке');
    return;
  }
  const show = tb.style.display === 'none' || !tb.style.display;
  tb.style.display = show ? 'flex' : 'none';
  if (show) {
    // Canvas создаём лениво — при первом включении разметки. Если бы он
    // создавался на DOMContentLoaded, вёрстка TradingView могла бы его
    // уничтожить/перекрыть, и клики по графику «не работали» бы.
    ensureOverlayCanvas();
    drawMarkup();
    subscribeMarkupSync();
    loadActiveMarkupFromDb(); // объекты могли появиться в другом списке/сессии
    // Страховка: если виджет ещё не готов (только что открыли watchlist),
    // дождитесь шкалы и перерисуйте — иначе включение разметки выглядит
    // как «уровень не ставится на график».
    waitForChartScale(6000).then(() => drawMarkup());
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
    // Перевешиваем слушатель на document: если после mousedown пользователь
    // чуть сдвинул курсор, mouseup на canvas не срабатывал — «залипал» drag,
    // инструмент оставался активным, а каждый следующий клик двигал старую
    // линию вместо создания новой (выглядело как «уровень не ставится»).
    if (window.__markupTool) {
      if (!setMarkupTool._downAttached) {
        document.addEventListener('mousedown', onDocumentMouseDownCatch);
        setMarkupTool._downAttached = true;
      }
    } else {
      detachDragListeners();
    }
  }
  showHint(window.__markupTool
    ? '🖊 Кликните по графику, чтобы поставить объект (повторное нажатие кнопки — выключить)'
    : '');
};

// Страховка от «залипшего» перетаскивания: любой новый mousedown вне холста
// или mouseup в любом месте завершает активный drag.
function onDocumentMouseDownCatch(e) {
  if (__dragItem && e.target !== window.__overlayCanvas) finishDrag();
}
function finishDrag() {
  if (!__dragItem) return;
  if (__dragItem.moved) persistActiveMarkup();
  __dragItem = null;
  detachDragListeners();
}
function detachDragListeners() {
  window.removeEventListener('mousemove', onOverlayMouseMove);
  window.removeEventListener('mouseup', onOverlayMouseUp);
  document.removeEventListener('mousedown', onDocumentMouseDownCatch);
  setMarkupTool._downAttached = false;
}

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
