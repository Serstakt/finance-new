// Раздел «Тест график»: свечи MOEX ISS (user status NOT AUTHORIZED —
// данные с задержкой ~15 мин) рисуются библиотекой KLineChart.
// Ввод тикера — по образцу формы добавления в watchlist: поле + кнопка,
// отправка по Enter. Данные идут через бэкенд: GET /api/candles/{symbol}.

(() => {
  let chartInstance = null;
  let lastTicker = null; // последний успешно введённый тикер (для смены ТФ)

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
      // Доступ к instance извне замыкания — для отладки и будущей
      // сериализации разметки (getOverlayStore → сохранение в БД по тикеру)
      window.testChartInstance = chartInstance;
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

  // ---- Панель разметки: рисование нативных overlay-объектов KLineChart ----
  // Клик по кнопке включает инструмент: следующий клик(и) по графику
  // ставят точки фигуры. Правый клик по готовой фигуре удаляет её
  // (стандартное поведение KLineChart).
  window.tcDrawOverlay = function (name) {
    const instance = getChartInstance();
    if (!instance) return;
    if (name === 'text') {
      const text = window.prompt('Текст заметки на графике:');
      if (!text) return;
      // В 9.6 нет шаблона «text» — используем встроенную аннотацию
      // simpleAnnotation: содержимое берётся из extendData (строка)
      instance.createOverlay({ name: 'simpleAnnotation', extendData: text });
      setStatus('Кликните по свече — текст привяжется к её цене');
      return;
    }
    const hints = {
      segment: 'Кликните по графику 2 раза — начало и конец отрезка',
      horizontalRayLine: 'Кликните по графику — уровень поставится на эту цену',
      'tc-rect': 'Кликните по графику 2 раза — противоположные углы прямоугольника',
      fibonacciLine: 'Кликните по графику 2 раза — уровни 0.236…∞ между ценами',
    };
    instance.createOverlay({ name });
    setStatus(hints[name] || 'Кликните по графику, чтобы поставить фигуру');
  };

  window.tcClearOverlays = function () {
    if (!chartInstance) return;
    chartInstance.removeOverlay();
    setStatus('Разметка удалена');
  };

  // ---- Индикаторы: переключатели VOL / MA / MACD ----
  // Состояние храним локально: у instance нет метода getIndicators(),
  // а removeIndicator принимает имя индикатора строкой.
  const activeIndicators = new Set();
  window.tcToggleIndicator = function (name) {
    const instance = getChartInstance();
    if (!instance) return;
    const btn = document.getElementById(`tc-ind-${name.toLowerCase()}`);
    if (activeIndicators.has(name)) {
      instance.removeIndicator(name);
      activeIndicators.delete(name);
      if (btn) btn.classList.remove('active');
      setStatus(`Индикатор ${name} выключен`);
      return;
    }
    // MA — в главном окне со свечами (id 'candle_pane'), VOL и MACD —
    // в отдельных под-окнах. isStack в v9 означает «сложить на индикатор
    // в том же окне», поэтому везде false.
    if (name === 'VOL') instance.createIndicator('VOL', false, { id: 'volume', height: 90 });
    else if (name === 'MACD') instance.createIndicator('MACD', false, { id: 'macd', height: 90 });
    else instance.createIndicator(name, false, { id: 'candle_pane' });
    activeIndicators.add(name);
    if (btn) btn.classList.add('active');
    setStatus(`Индикатор ${name} включён`);
  };

  document.addEventListener('DOMContentLoaded', () => {
    registerRectOverlay();
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
