// === ТЕСТ: TradingView Lightweight Charts (вариант C) ===
// Библиотечный график прямо в DOM страницы: разметка — нативные price lines /
// vertical lines / text markers API LWC (без canvas-оверлеев и iframe).
// Данные: GET /api/history/{symbol} (MOEX ISS / CoinGecko).

(function () {
  const V = 'lwc';
  let chart = null, series = null, volSeries = null;
  let symbol = null, candles = [];
  let items = [];          // размеченные объекты (общий формат LibChart)
  let tool = null;         // 'hline' | 'vline' | 'text' | null
  const priceLines = new Map();   // id -> IPriceLine
  const vLines = new Map();       // id -> ISeriesMarker-like (рисуем через markers)
  let markersMerged = false;

  function ensureChart() {
    if (chart) return;
    const el = document.getElementById('lwc_chart');
    chart = LightweightCharts.createChart(el, {
      layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      rightPriceScale: { borderColor: '#363a45' },
      timeScale: { borderColor: '#363a45', timeVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      autoSize: true,
    });
    series = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    volSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // Клик по графику в режиме инструмента = добавление объекта разметки
    chart.subscribeClick(param => {
      if (!tool || !param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      const time = param.time;
      if (price == null || time == null) return;
      if (tool === 'hline') {
        addItem({ id: LibChart.uid(), type: 'hline', price: Number(price), color: '#f7a600' });
      } else if (tool === 'vline' && time) {
        addItem({ id: LibChart.uid(), type: 'vline', time: toISO(time), color: '#2962ff' });
      } else if (tool === 'text') {
        const text = window.prompt('Текст заметки:', 'Заметка');
        if (text) addItem({ id: LibChart.uid(), type: 'text', price: Number(price), time: toISO(time), text, color: '#e91e63' });
      }
      LibChart.status('lwc-status', `Инструмент «${tool}» снова активен — кликните по графику ещё раз`);
    });
  }

  function toISO(t) {
    if (typeof t === 'string') return t;
    if (typeof t === 'number') {
      return new Date(t * 1000).toISOString().slice(0, 10);
    }
    if (t && t.year) return `${t.year}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`;
    return '';
  }

  function renderAll() {
    ensureChart();
    series.setData(candles);
    volSeries.setData(candles.map(c => ({
      time: c.time, value: 1,
      color: c.close >= c.open ? 'rgba(38,166,154,.4)' : 'rgba(239,83,80,.4)',
    })));
    chart.timeScale().fitContent();
    redrawMarkup();
  }

  function redrawMarkup() {
    // price lines: удаляем старые, создаём текущие
    for (const pl of priceLines.values()) series.removePriceLine(pl);
    priceLines.clear();
    for (const it of items) {
      if (it.type === 'hline') {
        priceLines.set(it.id, series.createPriceLine({
          price: it.price, color: it.color || '#f7a600', lineWidth: 2,
          axisLabelVisible: true, title: '',
        }));
      }
    }
    // vline + text: маркеры на последней доступной свече рядом с датой
    const markers = [];
    for (const it of items) {
      if (it.type === 'vline') {
        markers.push({ time: nearestTime(it.time), position: 'aboveBar', color: it.color || '#2962ff',
                       shape: 'arrowDown', text: '|' });
      } else if (it.type === 'text') {
        markers.push({ time: nearestTime(it.time), position: 'inBar', color: it.color || '#e91e63',
                       shape: 'circle', text: it.text || 'A' });
      }
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : 1));
    series.setMarkers(markers);
    LibChart.saveMarkup(V, symbol, items);
  }

  function nearestTime(iso) {
    if (!candles.length) return iso;
    let best = candles[0].time;
    for (const c of candles) if (c.time <= iso) best = c.time; else break;
    return best;
  }

  function addItem(it) {
    items.push(it);
    redrawMarkup();
  }

  window.loadLwcChart = function () {
    ensureChart();
    return LibChart.loadWithStatus('lwc', 'lwc-status', (sym, cs) => {
      symbol = sym; candles = cs;
      items = LibChart.loadMarkup(V, sym);
      renderAll();
    });
  };

  window.setLwcTool = function (t) {
    tool = (tool === t) ? null : t;
    LibChart.markActiveTool('lwc-toolbar', tool);
    LibChart.status('lwc-status', tool ? 'Кликните по графику, чтобы поставить объект' : 'Инструмент выключен');
  };

  window.undoLwcMarkup = function () {
    items.pop();
    redrawMarkup();
  };

  window.clearLwcMarkup = function () {
    items = [];
    redrawMarkup();
  };

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('lwc-symbol');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') window.loadLwcChart(); });
  });
})();
