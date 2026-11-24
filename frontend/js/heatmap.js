// === ТЕПЛОВАЯ КАРТА «ГЛАВНАЙ» (treemap тикеров всех watchlist-списков) ===
//
// Finviz-style treemap: плитка = тикер (площадь равная), цвет = % изменения
// за выбранный период (День/Неделя/Месяц), зоны = типы активов
// (Акции/Крипта/Валюты/Индексы). Клик по плитке — открыть тикер в Watchlist.
//
// Данные:
//   * состав тикеров — GET /api/watchlists/symbols (все списки одним запросом);
//   * период «день» — changeDay из /api/prices/batch (fetchPricesBatch, заодно
//     греет общий ticker_cache для Watchlist);
//   * «неделя»/«месяц» — GET /api/heatmap/changes: бэкенд считает из дневных
//     свечей (interval=24) с накоплением в candle_store и TTL-кэшем.
//
// Раскладка — squarified treemap (Bruls et al.): без внешних зависимостей,
// в духе vanilla-JS проекта. DOM обновляется двумя путями: полная пересборка
// при изменении СОСТАВА тикеров (renderHeatmap) и точечная перекраска при
// обновлении цен (updateHeatmapColors) — чтобы не сбрасывать hover/tooltip.

(function () {
  'use strict';

  // Интервал опроса берём из state.js (глобальная lexical-константа classic-
  // скриптов); фолбэк — на случай запуска heatmap.js в изоляции (тесты).
  const REFRESH_MS = (typeof AUTO_REFRESH_INTERVAL !== 'undefined')
    ? AUTO_REFRESH_INTERVAL : 15000;
  // Неделя/месяц меняются медленно — опрашиваем раз в ~60 с (каждый 4-й тик).
  const SLOW_PERIOD_TICKS = 4;

  const PERIODS = ['day', 'week', 'month'];
  const PERIOD_LABELS = { day: 'За день', week: 'За неделю', month: 'За месяц' };
  // Размах легенды/окраски по периодам (Finviz тоже масштабирует шкалу).
  const PERIOD_COLOR_LIMIT = { day: 2, week: 7, month: 15 };
  const HM_PERIOD_KEY = 'heatmap_period';
  // Сортировка плиток внутри зон: 'list' — как в списках, 'gainers' —
  // от самых растущих к падающим, 'losers' — от самых падающих к растущим.
  const HM_SORT_KEY = 'heatmap_sort';
  const SORTS = ['list', 'gainers', 'losers'];

  const GROUP_ORDER = ['stock', 'crypto', 'currency', 'index'];
  const GROUP_LABELS = { stock: 'Акции', crypto: 'Крипта', currency: 'Валюты', index: 'Индексы' };

  // Высота полоски-заголовка зоны группы (зеркалит .hm-group-label в CSS).
  const GROUP_HEADER_H = 24;

  // Пороги читаемости плитки (px): на маленьких прячем цену (нижний угол),
  // ещё меньших — %, на совсем мелких — и тикер тоже (как в Finviz:
  // у мелких плиток остаётся только цвет). Пороги подстроены под размер
  // шрифта плитки (тикер 15px / % 13px / цена 12px).
  const HIDE_PRICE_W = 70, HIDE_PRICE_H = 48;
  const HIDE_CHANGE_W = 62, HIDE_CHANGE_H = 42;
  const HIDE_LABEL_W = 42, HIDE_LABEL_H = 26;

  // --- состояние карты ---
  let hmPeriod = (() => {
    try { return localStorage.getItem(HM_PERIOD_KEY) || 'day'; } catch (e) { return 'day'; }
  })();
  let hmSort = (() => {
    try { return localStorage.getItem(HM_SORT_KEY) || 'list'; } catch (e) { return 'list'; }
  })();
  if (!SORTS.includes(hmSort)) hmSort = 'list';
  let hmSymbols = [];        // [{symbol, lists: [listId]}] — все тикеры всех списков
  let hmPrices = {};         // {symbol: ответ /api/prices/batch} — цены + changeDay
  let hmPeriodChanges = {};  // {symbol: {changePct, partial}} — данные week/month
  let hmTimer = null;
  let hmTicks = 0;
  let hmLoadSeq = 0;         // защита от гонок: устаревший ответ не перекрашивает карту
  let hmResizeTimer = null;
  const hmTileEls = new Map();   // symbol -> плитка (для точечной перекраски)
  // Порядок тикеров, в котором зоны были разложены при последнем рендере:
  // {тип актива: [symbol, ...]}. По нему решаем, пора ли пересортировать
  // плитки после прихода свежих данных (см. fetchHeatmapData).
  const hmBuiltOrder = new Map();

  // === ТИП АКТИВА (группировка зон) ===
  // Зеркало классификации бэкенда (moex_service.fetch_moex_prices_batch):
  // BINANCE: -> крипта; известные индексы -> индексы; *RUB и валютные пары
  // -> валюты; остальное с Мосбиржи — акции.
  window.classifyAssetType = function (symbol) {
    const s = String(symbol || '').toUpperCase();
    if (s.startsWith('BINANCE:')) return 'crypto';
    const t = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
    if (['IMOEX', 'RTSI', 'RGBI', 'IRUS'].includes(t)) return 'index';
    if (t.includes('RUB') || ['USD000UTSTOM', 'EUR_RUB__TOM'].includes(t)) return 'currency';
    return 'stock';
  };

  // === SQUARIFIED TREEMAP (Bruls, Huizing, van Wijk) ===
  // entries: [{key, weight}]; rect: {x, y, w, h}. Возвращает [{key, x, y, w, h}]
  // без пересечений и пустот, aspect ratios близки к 1. У эвристики простое
  // правило: очередной элемент добавляется к «ряду», пока это улучшает
  // (уменьшает) худшее соотношение сторон в ряду.
  window.hmSquarify = function (entries, rect) {
    const items = (entries || [])
      .filter(e => e && e.weight > 0)
      .map(e => ({ key: e.key, weight: e.weight, area: 0 }))
      .sort((a, b) => b.weight - a.weight);
    const totalWeight = items.reduce((s, e) => s + e.weight, 0);
    if (!items.length || !(rect && rect.w > 0 && rect.h > 0)) return [];

    const fullArea = rect.w * rect.h;
    for (const e of items) e.area = fullArea * (e.weight / totalWeight);

    const out = [];
    // Текущий незакрытый прямоугольник раскладки (сжимается после каждого ряда).
    let rx = rect.x, ry = rect.y, rw = rect.w, rh = rect.h;
    let row = [];

    // Худшее соотношение сторон ряда: длина ряда L (короткая сторона незакрытого
    // прямоугольника), толщина ряда T = площадь ряда / L; элемент в ряду —
    // T × (a_i / T), сравниваем его стороны между собой.
    const rowWorst = (areas, L) => {
      const sum = areas.reduce((s, a) => s + a, 0);
      if (sum <= 0 || L <= 0) return Infinity;
      const thickness = sum / L;
      let worst = 0;
      for (const a of areas) {
        const len = a / thickness;
        if (len <= 0) return Infinity;
        worst = Math.max(worst, len / thickness, thickness / len);
      }
      return worst;
    };

    // Фиксирует ряд вдоль короткой стороны незакрытого прямоугольника.
    const flushRow = () => {
      if (!row.length) return;
      const sum = row.reduce((s, e) => s + e.area, 0);
      if (rw >= rh) { // широкий остаток: ряд — вертикальная полоса слева
        const stripW = sum / rh;
        let cy = ry;
        for (const e of row) {
          const ih = e.area / stripW;
          out.push({ key: e.key, x: rx, y: cy, w: stripW, h: ih });
          cy += ih;
        }
        rx += stripW; rw -= stripW;
      } else {        // высокий остаток: ряд — горизонтальная полоса сверху
        const stripH = sum / rw;
        let cx = rx;
        for (const e of row) {
          const iw = e.area / stripH;
          out.push({ key: e.key, x: cx, y: ry, w: iw, h: stripH });
          cx += iw;
        }
        ry += stripH; rh -= stripH;
      }
      row = [];
    };

    for (const item of items) {
      const L = Math.min(rw, rh);
      if (!row.length) { row.push(item); continue; }
      const withItem = row.map(e => e.area).concat(item.area);
      if (rowWorst(withItem, L) <= rowWorst(row.map(e => e.area), L)) {
        row.push(item);
      } else {
        flushRow();
        row.push(item);
      }
    }
    flushRow(); // последний ряд
    return out;
  };

  // === ЦВЕТ ПЛИТКИ ===
  // Интерполяция #ef5350 (падение) -> нейтральный -> #26a69a (рост) — палитра
  // проекта (positive/negative). |v| нормируется на размах периода; корень
  // делает мелкие движения заметными (Finviz-подобная насыщенность).
  window.hmColor = function (changePct, period) {
    const v = Number(changePct);
    if (changePct === null || changePct === undefined || !Number.isFinite(v)) {
      return '#454b59'; // нет данных — серая плитка
    }
    const lim = PERIOD_COLOR_LIMIT[period] || 2;
    const clamped = Math.max(-lim, Math.min(lim, v));
    const t = Math.sqrt(Math.abs(clamped) / lim);
    const target = clamped >= 0 ? [0x26, 0xa6, 0x9a] : [0xef, 0x53, 0x50];
    const base = [0x3e, 0x43, 0x4f];
    const mixed = target.map((c, i) => Math.round(base[i] + (c - base[i]) * t));
    return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
  };

  // Значение окраски тикера для ТЕКУЩЕГО периода (null — данных нет).
  window.hmPeriodChangeOf = function (symbol) {
    if (hmPeriod === 'day') {
      const d = hmPrices[symbol];
      return (d && d.changeDay !== null && d.changeDay !== undefined) ? Number(d.changeDay) : null;
    }
    const c = hmPeriodChanges[symbol];
    return (c && c.changePct !== null && c.changePct !== undefined) ? Number(c.changePct) : null;
  };

  // Сортировка тикеров одной зоны под текущий режим hmSort. Тикеры без данных
  // всегда в конце — их значение окраски неизвестно.
  function hmSortedSymbols(symbols) {
    if (hmSort === 'list') return symbols;
    const known = [];
    const unknown = [];
    for (const sym of symbols) {
      const val = window.hmPeriodChangeOf(sym);
      (val === null || val === undefined ? unknown : known).push({ sym, val });
    }
    known.sort((a, b) => (hmSort === 'gainers') ? (b.val - a.val) : (a.val - b.val));
    return [...known, ...unknown].map(e => e.sym);
  }

  // === ДАННЫЕ ===

  // Состав тикеров всех списков: GET /api/watchlists/symbols (без SECTION,
  // дедуп: один тикер в нескольких списках -> карта symbol -> [listId] для клика).
  window.collectHeatmapSymbols = async function () {
    const res = await window.fetchWithTimeout(`${window.API_BASE}/api/watchlists/symbols`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const byList = data.symbols_by_list || {};
    const map = new Map();
    for (const [listId, symbols] of Object.entries(byList)) {
      for (const sym of symbols || []) {
        if (!map.has(sym)) map.set(sym, []);
        if (!map.get(sym).includes(listId)) map.get(sym).push(listId);
      }
    }
    hmSymbols = Array.from(map.entries()).map(([symbol, lists]) => ({ symbol, lists }));
    return hmSymbols;
  };

  // Цена тикера для плитки/тултипа: из свежего батча цен, иначе из общего
  // кэша Watchlist (localStorage ticker_cache, туда пишет fetchPricesBatch).
  function hmPriceOf(symbol) {
    const d = hmPrices[symbol];
    if (d && d.price !== null && d.price !== undefined) return d.price;
    try {
      const cache = JSON.parse(localStorage.getItem(window.CACHE_KEY || 'ticker_cache') || '{}');
      const rec = cache[symbol];
      if (rec && rec.data && rec.data.price !== null && rec.data.price !== undefined) return rec.data.price;
    } catch (e) { /* битый кэш — цены просто не будет */ }
    return null;
  }

  // Загрузка данных окраски под текущий период + точечная перекраска.
  window.fetchHeatmapData = async function () {
    if (!hmSymbols.length) return;
    const seq = ++hmLoadSeq;
    try {
      // Цены нужны во ВСЕХ периодах: текущая цена показывается на плитке
      // (правый нижний угол) и в тултипе. Это тот же один батч-запрос на все
      // тикеры — он заодно греет общий ticker_cache для Watchlist.
      const prices = await window.fetchPricesBatch(hmSymbols.map(e => e.symbol));
      if (seq !== hmLoadSeq) return; // пока шли — период/состав сменился
      hmPrices = Object.assign({}, hmPrices, prices);

      if (hmPeriod !== 'day') {
        const url = `${window.API_BASE}/api/heatmap/changes`
          + `?symbols=${encodeURIComponent(hmSymbols.map(e => e.symbol).join(','))}`
          + `&period=${hmPeriod}`;
        // Первый запрос недели/месяца может докачивать историю свечей —
        // таймаут щедрее, чем у price-batch (дальше отдаёт TTL-кэш бэкенда).
        const res = await window.fetchWithTimeout(url, {}, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (seq !== hmLoadSeq) return;
        hmPeriodChanges = data.changes || {};
      }
    } catch (e) {
      if (typeof log === 'function') log(`Тепловая карта: не удалось загрузить данные (${e.message})`, 'error');
    }
    // Активная сортировка: если свежие данные изменили порядок тикеров —
    // пересобираем раскладку (один «прыжок» вместо дёргания каждый опрос).
    if (hmSort !== 'list' && heatmapOrderStale()) {
      window.renderHeatmap();
    } else {
      window.updateHeatmapColors();
    }
  };

  // Изменился ли отсортированный порядок хоть одной зоны с последнего рендера.
  function heatmapOrderStale() {
    if (!hmBuiltOrder.size) return false;
    for (const [type, built] of hmBuiltOrder) {
      if (hmSortedSymbols(built).join('|') !== built.join('|')) return true;
    }
    return false;
  }

  // === РЕНДЕР ===

  window.renderHeatmap = function () {
    const area = document.getElementById('watchlist-heatmap');
    if (!area) return;
    hmTileEls.clear();

    if (!hmSymbols.length) {
      area.innerHTML = '<div class="widget-fallback">В списках нет тикеров — добавьте их в Watchlist, и здесь появится тепловая карта.</div>';
      return;
    }

    const w = area.clientWidth, h = area.clientHeight;
    if (w < 50 || h < 50) {
      // Контейнер ещё не отрисовался (смена страницы) — повтор после layout.
      setTimeout(() => window.renderHeatmap(), 200);
      return;
    }

    // Зоны по типам активов: сортировка стабильная (Акции, Крипта, Валюты, Индексы).
    const groups = new Map();
    for (const { symbol } of hmSymbols) {
      const type = window.classifyAssetType(symbol);
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(symbol);
    }
    const types = Array.from(groups.keys())
      .sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));

    const groupRects = window.hmSquarify(
      types.map(t => ({ key: t, weight: groups.get(t).length })),
      { x: 0, y: 0, w: w, h: h });

    area.innerHTML = '';
    hmBuiltOrder.clear();
    for (const gr of groupRects) {
      const g = document.createElement('div');
      g.className = 'hm-group';
      g.style.left = gr.x + 'px';
      g.style.top = gr.y + 'px';
      g.style.width = gr.w + 'px';
      g.style.height = gr.h + 'px';
      const label = document.createElement('div');
      label.className = 'hm-group-label';
      label.textContent = `${GROUP_LABELS[gr.key] || gr.key} · ${groups.get(gr.key).length}`;
      const inner = document.createElement('div');
      inner.className = 'hm-group-area';
      g.appendChild(label);
      g.appendChild(inner);
      area.appendChild(g);

      const iw = inner.clientWidth, ih = inner.clientHeight;
      if (iw < 10 || ih < 10) continue; // зона вырожденно мала — заголовка достаточно
      // Плитки зоны: под активную сортировку («рост»/«падение») или как в списках
      const groupSymbols = hmSortedSymbols(groups.get(gr.key));
      hmBuiltOrder.set(gr.key, groupSymbols);
      const tiles = window.hmSquarify(
        groupSymbols.map(sym => ({ key: sym, weight: 1 })),
        { x: 0, y: 0, w: iw, h: ih });
      for (const tr of tiles) {
        const sym = tr.key;
        const tile = document.createElement('div');
        tile.className = 'hm-tile';
        tile.dataset.symbol = sym;
        tile.style.left = tr.x + 'px';
        tile.style.top = tr.y + 'px';
        tile.style.width = tr.w + 'px';
        tile.style.height = tr.h + 'px';
        const tick = document.createElement('span');
        tick.className = 'hm-ticker';
        tick.textContent = sym.includes(':') ? sym.split(':')[1] : sym;
        const chg = document.createElement('span');
        chg.className = 'hm-change';
        // Текущая цена — правый нижний угол плитки (hmPriceOf + updateHeatmapColors)
        const price = document.createElement('span');
        price.className = 'hm-price';
        tile.appendChild(tick);
        tile.appendChild(chg);
        tile.appendChild(price);
        inner.appendChild(tile);
        hmTileEls.set(sym, tile);
        // Длинный тикер на узкой плитке: второй, уменьшенный ярус шрифта
        // вместо обрезки («BNBUSDT» ужмётся до 12px, «SBER» останется 15px).
        if (tick.scrollWidth > tick.clientWidth) tile.classList.add('tight-ticker');
      }
    }
    window.updateHeatmapColors();
  };

  // Точечная перекраска без пересборки DOM: цвет/тексты/пометки по текущим данным.
  window.updateHeatmapColors = function () {
    for (const [sym, tile] of hmTileEls) {
      const val = window.hmPeriodChangeOf(sym);
      tile.style.background = window.hmColor(val, hmPeriod);
      const chg = tile.querySelector('.hm-change');
      if (chg) {
        chg.innerHTML = (typeof formatChange === 'function')
          ? formatChange(val)
          : `<span>${val === null || val === undefined ? '—' : (val >= 0 ? '+' : '') + Number(val).toFixed(2) + '%'}</span>`;
      }
      const price = hmPriceOf(sym);
      const priceEl = tile.querySelector('.hm-price');
      if (priceEl) {
        // Нет цены — не рисуем ничего (пустой угол читается лучше, чем «—»)
        priceEl.innerHTML = (price !== null && price !== undefined)
          ? (typeof formatPriceAuto === 'function'
              ? formatPriceAuto(price)
              : Number(price).toLocaleString('ru-RU', { maximumFractionDigits: 4 }))
          : '';
      }
      const tw = parseFloat(tile.style.width) || 0;
      const th = parseFloat(tile.style.height) || 0;
      tile.classList.toggle('no-price', tw < HIDE_PRICE_W || th < HIDE_PRICE_H);
      tile.classList.toggle('no-change', tw < HIDE_CHANGE_W || th < HIDE_CHANGE_H);
      tile.classList.toggle('no-label', tw < HIDE_LABEL_W || th < HIDE_LABEL_H);
      const rec = hmPeriodChanges[sym];
      tile.classList.toggle('hm-partial', hmPeriod !== 'day' && !!(rec && rec.partial));
    }
    updateHeatmapLegend();
  };

  // Легенда-градиент: полоса из реальных цветов hmColor + подписи размаха периода.
  function updateHeatmapLegend() {
    const bar = document.getElementById('heatmap-legend-bar');
    const minEl = document.getElementById('heatmap-legend-min');
    const maxEl = document.getElementById('heatmap-legend-max');
    if (!bar) return;
    const lim = PERIOD_COLOR_LIMIT[hmPeriod] || 2;
    const stops = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const v = -lim + (2 * lim * i) / N;
      stops.push(window.hmColor(v, hmPeriod));
    }
    bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    if (minEl) minEl.textContent = `−${lim}%`;
    if (maxEl) maxEl.textContent = `+${lim}%`;
  }

  // === TOOLTIP (hover) ===
  // Делегирование на area: переживёт любую пересборку плиток.
  // Цена берётся из той же hmPriceOf, что и на плитке.

  window.showHeatmapTooltip = function (symbol, x, y) {
    const tip = document.getElementById('heatmap-tooltip');
    if (!tip) return;
    const base = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    const val = window.hmPeriodChangeOf(symbol);
    const rec = hmPeriodChanges[symbol];
    const partial = hmPeriod !== 'day' && rec && rec.partial;
    const valHtml = (typeof formatChange === 'function')
      ? formatChange(val)
      : `<span>${val === null || val === undefined ? '—' : (val >= 0 ? '+' : '') + Number(val).toFixed(2) + '%'}</span>`;
    const valCls = (val !== null && val !== undefined) ? (val >= 0 ? 'text-green' : 'text-red') : '';
    const price = hmPriceOf(symbol);
    const priceHtml = (price !== null && typeof formatPriceAuto === 'function')
      ? formatPriceAuto(price) : '—';

    tip.innerHTML = `
      <div class="hm-tip-symbol">${typeof escapeHtml === 'function' ? escapeHtml(base) : base}</div>
      <div class="hm-tip-row">Цена: <strong>${priceHtml}</strong></div>
      <div class="hm-tip-row">${PERIOD_LABELS[hmPeriod] || ''}: <strong class="${valCls}">${valHtml}</strong></div>
      ${partial ? '<div class="hm-tip-note">Истории не хватает на весь период — расчёт частичный</div>' : ''}`;

    tip.style.display = 'block';
    tip.style.visibility = 'hidden';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + tw + 8 > window.innerWidth) left = x - tw - 14;
    if (top + th + 8 > window.innerHeight) top = y - th - 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
    tip.style.visibility = 'visible';
  };

  window.hideHeatmapTooltip = function () {
    const tip = document.getElementById('heatmap-tooltip');
    if (tip) tip.style.display = 'none';
  };

  function bindHeatmapEvents() {
    const area = document.getElementById('watchlist-heatmap');
    if (!area || area.dataset.hmBound) return;
    area.dataset.hmBound = '1';

    area.addEventListener('mousemove', (e) => {
      const tile = e.target.closest ? e.target.closest('.hm-tile') : null;
      if (!tile || !tile.dataset.symbol) { window.hideHeatmapTooltip(); return; }
      window.showHeatmapTooltip(tile.dataset.symbol, e.clientX, e.clientY);
    });
    area.addEventListener('mouseleave', () => window.hideHeatmapTooltip());
    area.addEventListener('click', (e) => {
      const tile = e.target.closest ? e.target.closest('.hm-tile') : null;
      if (tile && tile.dataset.symbol) window.openHeatmapSymbol(tile.dataset.symbol);
    });

    // Перелayout при изменении размера окна (только когда карта видна).
    window.addEventListener('resize', () => {
      if (sessionStorage.getItem('activePage') !== 'home') return;
      clearTimeout(hmResizeTimer);
      hmResizeTimer = setTimeout(() => window.renderHeatmap(), 150);
    });
  }

  // === КЛИК ПО ПЛИТКЕ -> WATCHLIST ===
  window.openHeatmapSymbol = function (symbol) {
    window.navigateTo('watchlist');
    const cur = window.getCurrentList();
    if (cur && Array.isArray(cur.tickers) && cur.tickers.includes(symbol)) {
      // Тикер уже в активном списке — тот же путь, что клик по строке watchlist.
      cur.activeSymbol = symbol;
      window.setActiveSymbolInDb(window.appState.activeListId, symbol);
      if (typeof createChart === 'function') createChart(symbol);
      if (typeof render === 'function') render();
      return;
    }
    // Иначе — первый список, где тикер лежит (из собранного состава карты).
    const entry = hmSymbols.find(s => s.symbol === symbol);
    const listId = (entry && entry.lists.length)
      ? entry.lists[0]
      : (typeof window.findListWithTicker === 'function' ? window.findListWithTicker(symbol) : null);
    if (!listId || !window.appState.lists[listId]) {
      if (typeof log === 'function') log(`Тикер ${symbol} не найден в списках`, 'error');
      return;
    }
    if (listId !== window.appState.activeListId) {
      window.switchList(listId);
      // switchList запускает syncListWithDb (async): её ответ с БД может
      // перезаписать активный тикер старым значением — переустанавливаем
      // после синхронизации.
      Promise.resolve(window.syncListWithDb(listId)).then(() => {
        const l = window.appState.lists[listId];
        if (l && window.appState.activeListId === listId) l.activeSymbol = symbol;
      });
    } else {
      const l = window.appState.lists[listId];
      if (l) l.activeSymbol = symbol;
    }
    // immediate=true — без дебаунса 400 мс: выбор должен успеть до sync-ответа.
    window.setActiveSymbolInDb(listId, symbol, true);
    if (typeof createChart === 'function') createChart(symbol);
  };

  // === ПЕРИОД ===
  window.setHeatmapPeriod = function (period) {
    if (!PERIODS.includes(period) || period === hmPeriod) return;
    hmPeriod = period;
    try { localStorage.setItem(HM_PERIOD_KEY, hmPeriod); } catch (e) { /* приватный режим */ }
    updateHeatmapPeriodButtons();
    // Сначала перекраска тем, что в памяти (данные прошлого периода), свежие
    // значения недели/месяца придёт следом — тогда heatmapOrderStale()
    // решит, нужно ли пересортировать плитки (один «прыжок», без дёргания).
    window.updateHeatmapColors();
    window.fetchHeatmapData();
  };

  function updateHeatmapPeriodButtons() {
    document.querySelectorAll('.hm-period-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.period === hmPeriod);
    });
  }

  // === СОРТИРОВКА ПЛИТОК ===
  window.setHeatmapSort = function (sort) {
    if (!SORTS.includes(sort) || sort === hmSort) return;
    hmSort = sort;
    try { localStorage.setItem(HM_SORT_KEY, hmSort); } catch (e) { /* приватный режим */ }
    updateHeatmapSortButtons();
    window.renderHeatmap(); // раскладка по уже загруженным данным окраски
  };

  function updateHeatmapSortButtons() {
    document.querySelectorAll('.hm-sort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === hmSort);
    });
  }

  // === ЗАГРУЗКА И ОПРОС ===
  window.loadHeatmap = async function () {
    const area = document.getElementById('watchlist-heatmap');
    if (!area) return;
    bindHeatmapEvents();
    updateHeatmapPeriodButtons();
    updateHeatmapSortButtons();
    try {
      await window.collectHeatmapSymbols();
    } catch (e) {
      area.innerHTML = `<div class="widget-fallback">⚠️ Не удалось загрузить состав списков (${e.message}). Проверьте, что сервер запущен.</div>`;
      return;
    }
    window.renderHeatmap();
    await window.fetchHeatmapData();
  };

  window.startHeatmapPolling = function () {
    if (hmTimer) clearInterval(hmTimer);
    hmTicks = 0;
    hmTimer = setInterval(() => {
      if (sessionStorage.getItem('activePage') !== 'home') return;
      if (document.hidden) return;
      if (hmPeriod !== 'day') {
        hmTicks++;
        if (hmTicks % SLOW_PERIOD_TICKS !== 0) return; // неделя/месяц — раз в ~60 с
      }
      if (!hmSymbols.length) { window.loadHeatmap(); return; } // первая попытка могла не удаться
      window.fetchHeatmapData();
    }, REFRESH_MS);
  };
})();
