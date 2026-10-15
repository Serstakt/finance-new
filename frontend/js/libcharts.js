// === ОБЩИЕ УТИЛИТЫ ТЕСТОВЫХ БИБЛИОТЕЧНЫХ ГРАФИКОВ (LWC / ECharts / Chart.js / D3) ===
// Все четыре библиотеки рисуют график ВНУТРИ нашей страницы (никаких iframe),
// поэтому разметка — это нативные объекты API каждой библиотеки, которые мы
// сохраняем в localStorage по тикеру. Общий формат разметки одинаков для всех:
//   { id, type:'hline'|'vline'|'text', price?, time?('YYYY-MM-DD'), text?, color }
// Хранилище: «libchart_markup:<вариант>:<символ>» — боевые данные Watchlist не трогаем.

(function () {
  const LS_PREFIX = 'libchart_markup';

  function normSymbol(input) {
    let s = (input || '').trim().toUpperCase();
    if (!s) {
      // если поле пустое — берём активный тикер Watchlist (для удобства сравнения)
      try {
        if (typeof getCurrentList === 'function') s = (getCurrentList().activeSymbol || '').toUpperCase();
      } catch (e) {}
    }
    if (!s || s.startsWith('SECTION:')) return null;
    if (!s.includes(':')) s = 'MOEX:' + s; // как в терминале: без биржи = Мосбиржа
    return s;
  }

  async function fetchCandles(symbol, days) {
    const base = window.API_BASE || '';
    const resp = await window.fetchWithTimeout(
      `${base}/api/history/${encodeURIComponent(symbol)}?days=${days || 180}`, {}, 25000);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    return (data && Array.isArray(data.candles)) ? data : { symbol, source: '?', candles: [] };
  }

  function loadMarkup(variant, symbol) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_PREFIX) || '{}');
      const arr = all[variant + ':' + symbol];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveMarkup(variant, symbol, items) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_PREFIX) || '{}');
      all[variant + ':' + symbol] = items;
      localStorage.setItem(LS_PREFIX, JSON.stringify(all));
    } catch (e) { console.warn('Не удалось сохранить разметку:', e); }
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Подсказка-статус в тулбаре конкретной страницы
  function status(elId, text) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = text || '';
    clearTimeout(status._t);
    if (text) status._t = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // Активация выбранной кнопки инструмента в тулбаре страницы
  function markActiveTool(boxId, tool) {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.querySelectorAll('[data-tool]').forEach(b =>
      b.classList.toggle('libtool-active', b.dataset.tool === tool));
  }

  // Загрузка данных + статус/ошибки в контейнер страницы
  async function loadWithStatus(pageKey, statusElId, renderFn) {
    const input = document.getElementById(pageKey + '-symbol');
    const symbol = normSymbol(input && input.value);
    if (!symbol) {
      status(statusElId, '⚠ Введите тикер (например MOEX:SBER или BINANCE:BTCUSDT)');
      return null;
    }
    status(statusElId, 'Загрузка данных…');
    try {
      const data = await fetchCandles(symbol);
      if (!data.candles.length) {
        status(statusElId, `Нет истории по ${symbol}`);
        return null;
      }
      status(statusElId, `${symbol}: ${data.candles.length} свечей (${data.source})`);
      renderFn(symbol, data.candles);
      return { symbol, candles: data.candles };
    } catch (e) {
      status(statusElId, 'Ошибка загрузки истории: ' + e.message);
      return null;
    }
  }

  window.LibChart = {
    normSymbol, fetchCandles, loadMarkup, saveMarkup, uid, status, markActiveTool, loadWithStatus
  };
})();
