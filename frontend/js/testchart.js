// === ТЕСТ ГРАФИК (KLineChart) ===
// Бесплатная библиотека klinecharts (Apache-2.0) с встроенными инструментами
// разметки: трендовые линии, уровни, каналы, фигуры, заметки. Данные —
// бесплатный MOEX ISS / CoinGecko через бэкенд (/api/history/{symbol}).
(function () {
  let chart = null;          // экземпляр KLineChart
  let currentSymbol = null;  // последний загруженный тикер (для overlay-подсказок)

  function setStatus(text) {
    const el = document.getElementById('tc-status');
    if (el) el.textContent = text || '';
  }

  // Инициализация графика (вызывается при первом переходе на вкладку).
  function ensureChart() {
    if (chart || typeof window.klinecharts === 'undefined') return chart;
    const box = document.getElementById('tc-chart');
    if (!box) return null;
    chart = window.klinecharts.init(box);
    // Тёмная тема в стиле терминала
    chart.setStyles({
      grid: { horizontal: { color: '#1e222d' }, vertical: { color: '#1e222d' } },
      candle: {
        priceMark: { last: { upColor: '#26a69a', downColor: '#ef5350' } },
        tooltip: { showRule: 'always', showType: 'standard' }
      },
      indicator: { bars: [{ upColor: 'rgba(38,166,154,.7)', downColor: 'rgba(239,83,80,.7)', noChangeColor: '#560963' }] }
    });
    // Стандартные индикаторы для примера разметки
    chart.createIndicator('MA', true, { id: 'candle_pane' });
    chart.createIndicator('VOL');
    setupToolbar();
    return chart;
  }

  // Кнопки тулбара активируют режим рисования оверлея соответствующего типа.
  function setupToolbar() {
    const bar = document.getElementById('tc-toolbar');
    if (!bar || bar.dataset.bound === '1') return;
    bar.dataset.bound = '1';
    bar.querySelectorAll('button[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!chart) return;
        const tool = btn.dataset.tool;
        const isActive = btn.classList.contains('active');
        bar.querySelectorAll('button[data-tool]').forEach(b => b.classList.remove('active'));
        if (isActive) {
          // повторный клик — выходим из режима рисования: завершаем текущий
          // незавершённый оверлей (рисование), статус сбрасываем
          try { chart.stopOverlay(); } catch (e) { /* старая версия API */ }
          setStatus('Инструмент отключён');
          return;
        }
        btn.classList.add('active');
        try {
          chart.createOverlay(tool);
          setStatus(`Рисование: ${btn.textContent.trim()} (кликайте по графику, Esc — отмена)`);
        } catch (e) {
          setStatus(`Инструмент «${tool}» недоступен в этой версии KLineChart`);
        }
      });
    });
  }

  window.removeAllOverlayTools = function () {
    if (!chart) return;
    chart.removeOverlay();
    document.querySelectorAll('#tc-toolbar button[data-tool]').forEach(b => b.classList.remove('active'));
    setStatus('Разметка очищена');
  };

  // Загрузка истории свечей с бэкенда и установка данных в график.
  window.loadTestChartData = async function () {
    const input = document.getElementById('tc-symbol');
    const raw = (input.value || '').trim().toUpperCase();
    if (!raw) { setStatus('Введите тикер'); return; }
    if (typeof window.klinecharts === 'undefined') {
      setStatus('⚠️ Библиотека KLineChart не загрузилась (заблокирован jsdelivr?)');
      return;
    }
    ensureChart();
    if (!chart) { setStatus('Не удалось инициализировать график'); return; }

    const interval = document.getElementById('tc-interval').value;
    setStatus(`Загружаю ${raw} (${interval})…`);
    try {
      const resp = await window.fetchWithTimeout(
        `${window.API_BASE}/api/history/${encodeURIComponent(raw)}?interval=${interval}`, {}, 25000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const candles = data.candles || [];
      if (!candles.length) { setStatus(`Нет исторических данных для ${raw}`); return; }
      chart.applyNewData(candles);
      currentSymbol = raw;
      setStatus(`${data.source || ''} ${raw}: ${candles.length} свечей`);
    } catch (e) {
      console.error('testchart load error:', e);
      setStatus(`Ошибка загрузки: ${e.message}`);
    }
  };

  // Подстановка активного тикера из Watchlist (кнопка «Из Watchlist»).
  window.useActiveWatchlistSymbol = function () {
    let sym = '';
    try {
      const list = (typeof getCurrentList === 'function') ? getCurrentList() : null;
      sym = list && list.activeSymbol ? list.activeSymbol : '';
    } catch (e) { /* ignore */ }
    if (!sym || sym.startsWith('SECTION:')) {
      setStatus('В Watchlist нет выбранного тикера');
      return;
    }
    const base = sym.includes(':') ? sym.split(':')[1] : sym;
    document.getElementById('tc-symbol').value = base;
    loadTestChartData();
  };

  // Вход на вкладку: ленивая инициализация + автозагрузка последнего тикера.
  const origNavigateTo = window.navigateTo;
  window.navigateTo = function (pageName) {
    origNavigateTo(pageName);
    if (pageName === 'testchart') {
      ensureChart();
      if (typeof window.klinecharts === 'undefined') {
        setStatus('⚠️ KLineChart не загружен с CDN — проверьте блокировщик/сеть');
      }
      const input = document.getElementById('tc-symbol');
      if (input && !input.value) {
        try {
          const list = (typeof getCurrentList === 'function') ? getCurrentList() : null;
          const s = list && list.activeSymbol && !list.activeSymbol.startsWith('SECTION:')
            ? (list.activeSymbol.includes(':') ? list.activeSymbol.split(':')[1] : list.activeSymbol)
            : 'SBER';
          input.value = s;
        } catch (e) { input.value = 'SBER'; }
      }
      if (currentSymbol === null && input && input.value) loadTestChartData();
      // KLineChart сам следит за размером контейнера, но при скрытых .page
      // инициализация даёт нулевую ширину — принудительно пересчитываем.
      setTimeout(() => { if (chart && chart.resize) chart.resize(); }, 50);
    }
  };

  // Enter в поле тикера = кнопка «Показать».
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('tc-symbol');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') loadTestChartData(); });
  });
})();
