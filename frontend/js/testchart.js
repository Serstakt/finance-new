// === ТЕСТОВЫЙ ГРАФИК (страница «Тестовый график») ===
// Цель страницы — сравнить два варианта работы с TradingView:
//   Вариант A: публичный tv.js-виджет + наша canvas-разметка поверх
//              (копия функционала Watchlist, но с независимым контейнером,
//              отдельным объектом виджета и отдельным хранилищем разметки,
//              чтобы не трогать window.widget / localStorage «chart_markup»).
//   Вариант B: tradingview.com/chart — «условная авторизация»:
//              если в браузере есть сессия TradingView, откроется ваш
//              аккаунт с сохранёнными layout; если нет — TradingView сам
//              покажет форму входа. Реализовано двумя кнопками: переход
//              в новой вкладке (_blank) и попытка встроить график во
//              фрейм прямо на странице (loadTestChartEmbed). Учтите:
//              полный chart запрещён к встраиванию на стороне TV
//              (CSP frame-ancestors 'none'), поэтому для фрейма
//              предусмотрена понятная заглушка с fallback-кнопкой.
// Подключение: скрипт идёт ПОСЛЕ chart_overlay.js — нужны общие утилиты
// roundRect/fmtPrice/fmtDate (инкапсулированы ниже, чтобы не зависеть от
// порядка загрузки и не конфликтовать с основной страницей).

(function () {
  // --- Состояние тестовой страницы (полностью независимое) ---------------
  let testWidget = null;        // экземпляр TradingView.widget для этой страницы
  let testWidgetReady = false;
  let testSymbol = null;        // активный символ тестового графика
  let testItems = [];           // объекты разметки текущего символа
  let testTool = null;          // 'hline' | 'vline' | 'text' | null
  let testCanvas = null;
  let testHint = null;
  let testSubscribed = false;
  let drawTimer = null;
  let dragItem = null;

  const LS_KEY = 'testchart_markup'; // отдельное хранилище — не смешиваем с Watchlist
  const TV_TOOLBAR_H = 38;           // примерная высота верхней панели виджета

  function status(text) {
    const el = document.getElementById('testmarkup-status');
    if (!el) return;
    el.textContent = text || '';
    clearTimeout(status._t);
    if (text) status._t = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // --- Хранилище -----------------------------------------------------------
  function loadItems(symbol) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      const arr = all[symbol];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function persistItems() {
    if (!testSymbol) return;
    try {
      const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      all[testSymbol] = testItems;
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) { console.warn('Не удалось сохранить разметку:', e); }
  }

  // --- Утилиты отрисовки (свои копии, без зависимости от chart_overlay.js) --
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

  function roundToTick(p) {
    const abs = Math.abs(p);
    const q = abs >= 1000 ? 1 : abs >= 100 ? 0.1 : abs >= 1 ? 0.01 : abs >= 0.01 ? 0.0001 : 0.000001;
    return Math.round(p / q) * q;
  }

  // --- Canvas-оверлей ------------------------------------------------------
  // ВАЖНО (наследие Watchlist): вешаем canvas на ВНЕШНИЙ контейнер
  // #testchart-chart-box, а НЕ внутрь #testchart_tv_chart — tv.js при
  // инициализации перезаписывает innerHTML своего контейнера.
  function ensureTestCanvas() {
    const box = document.getElementById('testchart-chart-box');
    if (!box) return null;
    if (testCanvas && testCanvas.parentElement === box) return testCanvas;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';

    // Классы повторяют оформление боевого оверлея (#markup-overlay /
    // #markup-hint в styles.css), но id и классы свои (.test-markup-*) —
    // стили для них добавлены отдельным блоком, конфликтов с Watchlist нет.
    const canvas = document.createElement('canvas');
    canvas.id = 'test-markup-overlay';
    canvas.className = 'test-markup-overlay';
    canvas.title = 'Разметка поверх тестового графика';
    box.appendChild(canvas);

    const hint = document.createElement('div');
    hint.id = 'test-markup-hint';
    hint.className = 'test-markup-hint';
    box.appendChild(hint);
    testHint = hint;

    canvas.addEventListener('mousedown', onMouseDown);
    testCanvas = canvas;
    return canvas;
  }

  function syncCanvasSize() {
    const canvas = testCanvas;
    const box = document.getElementById('testchart-chart-box');
    const tvBox = document.getElementById('testchart_tv_chart');
    if (!canvas || !box || !tvBox) return;
    const rb = box.getBoundingClientRect();
    const rt = tvBox.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.left = Math.round(rt.left - rb.left) + 'px';
    canvas.style.top = Math.round(rt.top - rb.top) + 'px';
    canvas.style.width = Math.round(rt.width) + 'px';
    canvas.style.height = Math.round(rt.height) + 'px';
    if (canvas.width !== Math.round(rt.width * dpr) || canvas.height !== Math.round(rt.height * dpr)) {
      canvas.width = Math.round(rt.width * dpr);
      canvas.height = Math.round(rt.height * dpr);
    }
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function chartAreaHeight() {
    if (!testCanvas) return 400;
    const h = testCanvas.getBoundingClientRect().height - TV_TOOLBAR_H;
    return Math.max(h, 100);
  }

  // --- Перевод координат через API виджета ----------------------------------
  function priceToY(price) {
    try {
      const info = (testWidget && testWidgetReady)
        ? testWidget.getChartScaleInfo(chartAreaHeight()) : null;
      if (!info || !isFinite(info.from) || !isFinite(info.to) || info.height <= 0) return null;
      return TV_TOOLBAR_H + info.height - ((price - info.from) / (info.to - info.from)) * info.height;
    } catch (e) { return null; }
  }

  function yToPrice(y) {
    try {
      const info = (testWidget && testWidgetReady)
        ? testWidget.getChartScaleInfo(chartAreaHeight()) : null;
      if (!info || info.height <= 0) return null;
      const localY = y - TV_TOOLBAR_H;
      return info.from + (info.height - localY) / info.height * (info.to - info.from);
    } catch (e) { return null; }
  }

  function timeToX(t) {
    try {
      if (!(testWidget && testWidgetReady)) return null;
      const x = testWidget.convertTime(t, 'UTC');
      return (x === -1 || x == null || !isFinite(x)) ? null : x;
    } catch (e) { return null; }
  }

  function xToTime(x) {
    try {
      if (!(testWidget && testWidgetReady)) return null;
      const t = testWidget.convertTime(x, 'screen');
      return (t == null || !isFinite(t)) ? null : Math.round(t);
    } catch (e) { return null; }
  }

  // --- Отрисовка ------------------------------------------------------------
  function drawTestMarkup() {
    if (!testCanvas) return;
    syncCanvasSize();
    const ctx = testCanvas.getContext('2d');
    const w = testCanvas.clientWidth, h = testCanvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const top = TV_TOOLBAR_H;

    for (const it of testItems) {
      if (it.type === 'hline') {
        const y = priceToY(it.price);
        if (y == null) continue;
        ctx.strokeStyle = it.color || '#ffca28';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.setLineDash([]);
        drawChip(ctx, `${fmtPrice(it.price)}${it.text ? ' · ' + it.text : ''}`, 6, y - 9, it.color || '#ffca28');
      } else if (it.type === 'vline') {
        const x = timeToX(it.time);
        if (x == null) continue;
        ctx.strokeStyle = it.color || '#2962ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h); ctx.stroke();
        ctx.setLineDash([]);
        drawChip(ctx, `${fmtDate(it.time)}${it.text ? ' · ' + it.text : ''}`, Math.min(Math.max(x + 6, 6), w - 120), top + 4, it.color || '#2962ff');
      } else if (it.type === 'text') {
        drawChip(ctx, it.text || '…', 10, h - 30, it.color || '#26a69a');
      }
    }
  }

  // --- Мышь: добавление / перетаскивание / удаление --------------------------
  function hitTest(mx, my) {
    let best = null, bestDist = 7;
    for (const it of testItems) {
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

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    const hit = hitTest(mx, my);
    if (hit) {
      dragItem = { item: hit, startX: mx, startY: my, moved: false };
      e.preventDefault();
      const onMove = (ev) => {
        const r = testCanvas.getBoundingClientRect();
        const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
        if (!dragItem) return;
        if (Math.abs(cy - dragItem.startY) > 2 || Math.abs(cx - dragItem.startX) > 2) dragItem.moved = true;
        if (dragItem.item.type === 'hline') {
          const p = yToPrice(cy);
          if (p != null) { dragItem.item.price = roundToTick(p); drawTestMarkup(); }
        } else if (dragItem.item.type === 'vline') {
          const t = xToTime(cx);
          if (t != null) { dragItem.item.time = t; drawTestMarkup(); }
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (dragItem && dragItem.moved) persistItems();
        dragItem = null;
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return;
    }

    if (!testTool) return;
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
    if (testTool === 'hline') {
      const p = yToPrice(my);
      if (p == null) { showTestHint('⚠ Шкала графика ещё не готова — подождите загрузки данных'); return; }
      item.type = 'hline'; item.price = roundToTick(p); item.color = '#ffca28';
    } else if (testTool === 'vline') {
      const t = xToTime(mx);
      if (t == null) { showTestHint('⚠ Не удалось определить время по позиции курсора'); return; }
      item.type = 'vline'; item.time = t; item.color = '#2962ff';
    } else if (testTool === 'text') {
      const txt = prompt('Текст заметки на графике:');
      if (!txt) return;
      item.type = 'text'; item.text = txt.slice(0, 120); item.color = '#26a69a';
    } else return;
    testItems.push(item);
    drawTestMarkup();
    persistItems();
    setTestMarkupTool(null);
  }

  function showTestHint(text) {
    if (!testHint) return;
    testHint.textContent = text || '';
    testHint.style.display = text ? 'block' : 'none';
    if (text) {
      clearTimeout(showTestHint._t);
      showTestHint._t = setTimeout(() => { if (testHint.textContent === text) testHint.style.display = 'none'; }, 4000);
    }
  }

  // Двойной клик по линии — удалить объект
  document.addEventListener('dblclick', (e) => {
    if (!testCanvas || e.target !== testCanvas) return;
    const r = testCanvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (hit) {
      testItems = testItems.filter(i => i.id !== hit.id);
      drawTestMarkup();
      persistItems();
      showTestHint('✕ Объект удалён');
    }
  });

  // --- Синхронизация перерисовки с виджетом ----------------------------------
  function subscribeTestSync() {
    const doSubscribe = () => {
      if (!(testWidget && testWidgetReady) || testSubscribed) return;
      try {
        for (const ev of ['data_loading', 'data_completed', 'onVisibleRangeChange']) {
          if (typeof testWidget.subscribe === 'function') {
            testWidget.subscribe(ev, () => drawTestMarkup());
          }
        }
        testSubscribed = true;
      } catch (e) { console.warn('subscribe для тестовой разметки недоступен:', e); }
    };
    doSubscribe();
    if (!testSubscribed) setTimeout(doSubscribe, 1500);
    if (!drawTimer) {
      drawTimer = setInterval(() => {
        if (testItems.length || testTool) drawTestMarkup();
      }, 700);
    }
  }

  // --- Публичные функции (вызываются из HTML) --------------------------------
  window.loadTestChart = function () {
    const input = document.getElementById('testchart-symbol');
    let symbol = (input && input.value.trim()) || (typeof getCurrentList === 'function' ? getCurrentList().activeSymbol : '');
    if (!symbol || symbol.startsWith('SECTION:')) {
      alert('Введите тикер (например, MOEX:SBER или NASDAQ:AAPL) либо выберите тикер в Watchlist.');
      return;
    }
    symbol = symbol.toUpperCase();
    if (input) input.value = symbol;

    if (typeof TradingView === 'undefined') {
      const box = document.getElementById('testchart_tv_chart');
      if (box) box.innerHTML = '<div class="error-msg" style="padding:20px;">⚠️ Скрипт TradingView (s3.tradingview.com) не загрузился — проверьте доступ к CDN.</div>';
      return;
    }

    const firstLoad = !testWidget;
    testSymbol = symbol;
    testItems = loadItems(symbol);

    if (testWidget && testWidgetReady) {
      testWidget.setSymbol(symbol, 'D', () => {});
    } else if (firstLoad) {
      testWidget = new TradingView.widget({
        autosize: true,
        symbol: symbol,
        interval: 'D',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'ru',
        toolbar_bg: '#1e222d',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        container_id: 'testchart_tv_chart',
        onready: () => {
          testWidgetReady = true;
          subscribeTestSync();
          drawTestMarkup();
        }
      });
    }
    drawTestMarkup();
    status(`График ${symbol} загружен (вариант A)`);
  };

  window.toggleTestMarkupToolbar = function () {
    const tb = document.getElementById('testchart-markup-toolbar');
    if (!tb) return;
    const show = tb.style.display === 'none' || !tb.style.display;
    tb.style.display = show ? 'flex' : 'none';
    if (show) {
      ensureTestCanvas();
      drawTestMarkup();
      subscribeTestSync();
    } else {
      setTestMarkupTool(null);
    }
  };

  window.setTestMarkupTool = function (tool) {
    testTool = (testTool === tool && tool) ? null : tool;
    document.querySelectorAll('#testchart-markup-toolbar [data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === testTool);
    });
    const canvas = ensureTestCanvas();
    if (canvas) canvas.classList.toggle('drawing', !!testTool);
    showTestHint(testTool
      ? '🖊 Кликните по графику, чтобы поставить объект (повторное нажатие кнопки — выключить)'
      : '');
  };

  window.undoTestMarkup = function () {
    if (!testItems.length) return;
    testItems.pop();
    drawTestMarkup();
    persistItems();
  };

  window.clearTestMarkup = function () {
    if (!testSymbol) return;
    if (!testItems.length) { showTestHint('Разметки на этом графике нет'); return; }
    if (!confirm(`Удалить всю разметку по ${testSymbol}?`)) return;
    testItems = [];
    drawTestMarkup();
    persistItems();
    showTestHint('🧹 Разметка очищена');
  };

  function resolveTestSymbol() {
    const input = document.getElementById('testchart-symbol');
    let symbol = (input && input.value.trim()) || (typeof getCurrentList === 'function' ? getCurrentList().activeSymbol : '');
    if (!symbol || symbol.startsWith('SECTION:')) {
      alert('Введите тикер в поле варианта A либо выберите тикер в Watchlist.');
      return null;
    }
    return symbol.toUpperCase();
  }

  // Вариант B: полный TradingView с условной авторизацией — новая вкладка
  window.openTestChartTVTab = function () {
    const symbol = resolveTestSymbol();
    if (!symbol) return;
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`, '_blank');
    status(`B: открыт tradingview.com (${symbol}) в новой вкладке`);
  };

  // Вариант B-embed: график tradingview.com во фрейме прямо на странице.
  // ВАЖНО: полный chart на tradingview.com защищён заголовком
  // Content-Security-Policy: frame-ancestors 'none' (проверено), поэтому
  // браузер, скорее всего, заблокирует загрузку iframe'а. Мы не можем это
  // обойти со своей страницы, но корректно обрабатываем случай: если через
  // несколько секунд документ iframe недоступен (blocked) или пуст —
  // показываем понятную заглушку с кнопкой «открыть в новой вкладке».
  let testEmbedTimer = null;

  window.loadTestChartEmbed = function () {
    const symbol = resolveTestSymbol();
    if (!symbol) return;
    const block = document.getElementById('testchart-b-block');
    const frame = document.getElementById('testchart-b-frame');
    const fallback = document.getElementById('testchart-b-fallback');
    const label = document.getElementById('testchart-b-symbol');
    if (!block || !frame || !fallback) return;

    fallback.style.display = 'none';
    if (label) label.textContent = `— ${symbol}`;
    block.style.display = 'block';
    frame.src = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });

    clearTimeout(testEmbedTimer);
    testEmbedTimer = setTimeout(() => {
      let blocked = false;
      try {
        // При блокировке CSP/NOFROMACCESS документ iframe нам не доступен.
        const doc = frame.contentDocument;
        blocked = !doc || doc.location.href === 'about:blank';
      } catch (e) {
        blocked = true; // SecurityError — кросс-документный доступ запрещён
      }
      if (blocked) {
        fallback.style.display = 'block';
        status('B: TradingView запретил встраивание полного графика (frame-ancestors \'none\')');
      } else {
        status(`B: график встроен во фрейм (${symbol})`);
      }
    }, 5000);
  };

  window.closeTestChartEmbed = function () {
    const block = document.getElementById('testchart-b-block');
    const frame = document.getElementById('testchart-b-frame');
    const fallback = document.getElementById('testchart-b-fallback');
    clearTimeout(testEmbedTimer);
    if (frame) frame.src = 'about:blank';
    if (fallback) fallback.style.display = 'none';
    if (block) block.style.display = 'none';
  };

  // --- Перерисовка при изменении размеров / возврате на страницу -------------
  window.addEventListener('resize', () => { if (testCanvas) drawTestMarkup(); });
  if ('ResizeObserver' in window) {
    document.addEventListener('DOMContentLoaded', () => {
      const ro = new ResizeObserver(() => { if (testCanvas) drawTestMarkup(); });
      for (const id of ['testchart-chart-box', 'testchart_tv_chart']) {
        const el = document.getElementById(id);
        if (el) ro.observe(el);
      }
    });
  }

  // Enter в поле символа = «Показать график»
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('testchart-symbol');
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.loadTestChart(); });
    }
  });
})();
