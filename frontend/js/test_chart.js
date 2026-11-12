// Раздел «Тест график»: свечи MOEX ISS (user status NOT AUTHORIZED —
// данные с задержкой ~15 мин) рисуются библиотекой KLineChart.
// Ввод тикера — по образцу формы добавления в watchlist: поле + кнопка,
// отправка по Enter. Данные идут через бэкенд: GET /api/candles/{symbol}.

(() => {
  let chartInstance = null;
  let lastTicker = null; // последний успешно введённый тикер (для смены ТФ)

  const setStatus = (text, isError = false) => {
    const el = document.getElementById('test-chart-status');
    if (el) {
      el.textContent = text;
      el.classList.toggle('error', isError);
    }
  };

  const normalizeTicker = (raw) =>
    String(raw || '').replace('MOEX:', '').trim().toUpperCase();

  const getChartInstance = () => {
    if (typeof klinecharts === 'undefined') {
      setStatus('⚠️ Библиотека KLineChart не загрузилась (CDN cdn.jsdelivr.net недоступен)', true);
      return null;
    }
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
          },
          xAxis: { tickText: { color: '#787b86' }, tickLine: { color: '#2a2e39' } },
          yAxis: { tickText: { color: '#787b86' }, tickLine: { color: '#2a2e39' } },
          crosshair: {
            horizontal: { text: { backgroundColor: '#434651' } },
            vertical: { text: { backgroundColor: '#434651' } },
          },
          tooltip: { text: { color: '#d1d4dc' } },
        },
      });
    }
    return chartInstance;
  };

  window.loadTestChartCandles = async function () {
    const input = document.getElementById('test-chart-ticker-input');
    const ticker = normalizeTicker(input && input.value);
    if (!ticker) {
      setStatus('Введите тикер акции Мосбиржи', true);
      return;
    }
    const interval = parseInt(
      (document.getElementById('test-chart-interval') || {}).value || '24', 10
    );

    const instance = getChartInstance();
    if (!instance) return;

    setStatus(`Загрузка свечей ${ticker}…`);

    try {
      // Без from бэкенд собирает пагинацией всю доступную историю ISS
      // (максимум свечей), а не только последние 500.
      const url = `${API_BASE}/api/candles/${encodeURIComponent(ticker)}`
        + `?interval=${interval}`;
      const response = await window.fetchWithTimeout(url, {}, 60000);
      const data = await response.json();

      if (data.error) {
        setStatus(`Ошибка: ${data.error}`, true);
        return;
      }
      if (!data.candles || !data.candles.length) {
        setStatus(`Для тикера ${ticker} свечи не найдены`, true);
        return;
      }

      // ISS: begin "2026-11-05 06:00:00" (время Мосбиржи). Парсим как есть
      // в локальном времени — для тестового графика этого достаточно.
      const klineData = data.candles.map(c => ({
        timestamp: new Date(String(c.begin).replace(' ', 'T')).getTime(),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0,
        turnover: c.value || 0,
      })).filter(c => !Number.isNaN(c.timestamp))
        // KLineChart требует возрастающих меток времени
        .sort((a, b) => a.timestamp - b.timestamp);

      instance.applyNewData(klineData);
      lastTicker = ticker;
      setStatus(`График ${ticker} · свечей: ${klineData.length} · данные ISS с задержкой ~15 мин`);
    } catch (e) {
      setStatus(`Не удалось загрузить свечи: ${e.message || e}`, true);
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('test-chart-ticker-input');
    const btn = document.getElementById('test-chart-load-btn');
    if (btn) btn.addEventListener('click', () => window.loadTestChartCandles());
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') window.loadTestChartCandles();
      });
    }
  });
})();
