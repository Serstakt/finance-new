// === ТЕСТ: ECharts candlestick (вариант D) ===
// Apache ECharts рисует график в canvas внутри страницы. Разметка — нативные
// markLine (горизонтальные/вертикальные линии) и graphic-текст, без оверлеев.
// Данные: GET /api/history/{symbol}.

(function () {
  const V = 'echarts';
  let chart = null;
  let symbol = null, candles = [];
  let items = [];
  let tool = null;

  function ensureChart() {
    if (chart) return;
    chart = echarts.init(document.getElementById('echarts_chart'), 'dark');
    window.addEventListener('resize', () => chart && chart.resize());
    // Клик по графику: convertFromPixel -> дата/цена -> объект разметки
    chart.on('click', params => {
      if (!tool || params.componentType !== 'series') return;
      const x = params.data[0];               // категория-дата
      const y = chart.convertFromPixel({ seriesIndex: 0 }, [params.event.offsetX, params.event.offsetY]);
      addOrPrompt(x, y && y[1]);
    });
    chart.getZr().on('click', e => {
      // клики вне серий (пустая область) тоже поддерживаем через координаты
      if (!tool) return;
      const pt = [e.offsetX, e.offsetY];
      if (!chart.containPixel('grid', pt)) return;
      const xIdx = chart.convertFromPixel({ gridIndex: 0 }, pt);
      const dateIso = dates()[Math.round(xIdx[0])] || null;
      addOrPrompt(dateIso, xIdx[1]);
    });
  }

  function addOrPrompt(isoDate, price) {
    if (price == null || isNaN(price)) return;
    if (tool === 'hline') {
      addItem({ id: LibChart.uid(), type: 'hline', price: Number(price), color: '#f7a600' });
    } else if (tool === 'vline' && isoDate) {
      addItem({ id: LibChart.uid(), type: 'vline', time: isoDate, color: '#2962ff' });
    } else if (tool === 'text') {
      const text = window.prompt('Текст заметки:', 'Заметка');
      if (text && isoDate) addItem({ id: LibChart.uid(), type: 'text', time: isoDate, price: Number(price), text, color: '#e91e63' });
    }
    LibChart.status('echarts-status', `Инструмент «${tool}» снова активен — кликните по графику ещё раз`);
  }

  function dates() { return candles.map(c => c.time); }

  function option() {
    const mlData = [];
    const graphics = [];
    for (const it of items) {
      if (it.type === 'hline') {
        mlData.push({ yAxis: it.price, lineStyle: { color: it.color || '#f7a600', width: 2 },
                      label: { formatter: fmt(it.price), position: 'insideEndTop', color: it.color || '#f7a600' } });
      } else if (it.type === 'vline') {
        mlData.push({ xAxis: nearestCat(it.time), lineStyle: { color: it.color || '#2962ff', width: 2 },
                      label: { formatter: it.time, position: 'start', color: it.color || '#2962ff' } });
      } else if (it.type === 'text') {
        const px = chart ? chart.convertToPixel({ seriesIndex: 0 }, [nearestCat(it.time), it.price]) : null;
        if (px) graphics.push({ type: 'text', x: px[0], y: px[1], style: {
          text: it.text || 'A', fill: it.color || '#e91e63', font: 'bold 13px sans-serif' } });
      }
    }
    return {
      backgroundColor: '#131722',
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      grid: { left: 56, right: 60, top: 24, bottom: 56 },
      xAxis: { type: 'category', data: dates(), boundaryGap: true,
               axisLine: { lineStyle: { color: '#363a45' } } },
      yAxis: { scale: true, axisLine: { lineStyle: { color: '#363a45' } } },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 20, bottom: 8 }],
      series: [{
        name: symbol || '', type: 'candlestick',
        data: candles.map(c => [c.open, c.close, c.low, c.high]),
        itemStyle: { color: '#26a69a', color0: '#ef5350', borderColor: '#26a69a', borderColor0: '#ef5350' },
        markLine: mlData.length ? { symbol: 'none', silent: true, data: mlData } : undefined,
      }],
      graphic: graphics,
    };
  }

  function nearestCat(iso) {
    const ds = dates();
    if (!ds.length) return iso;
    let best = ds[0];
    for (const d of ds) { if (d <= iso) best = d; else break; }
    return best;
  }

  function fmt(p) { return Math.abs(p) >= 1000 ? p.toFixed(0) : p.toFixed(2); }

  function redraw() {
    ensureChart();
    chart.setOption(option(), { notMerge: true });
    LibChart.saveMarkup(V, symbol, items);
  }

  function addItem(it) { items.push(it); redraw(); }

  window.loadEchartsChart = function () {
    ensureChart();
    return LibChart.loadWithStatus('echarts', 'echarts-status', (sym, cs) => {
      symbol = sym; candles = cs;
      items = LibChart.loadMarkup(V, sym);
      chart.timeScaleReady = true;
      redraw();
      chart.dispatchAction({ type: 'takeGlobalCursor', key: 'crosshair', crosshair: { show: true } });
    });
  };

  window.setEchartsTool = function (t) {
    tool = (tool === t) ? null : t;
    LibChart.markActiveTool('echarts-toolbar', tool);
    LibChart.status('echarts-status', tool ? 'Кликните по графику, чтобы поставить объект' : 'Инструмент выключен');
  };

  window.undoEchartsMarkup = function () { items.pop(); redraw(); };
  window.clearEchartsMarkup = function () { items = []; redraw(); };

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('echarts-symbol');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') window.loadEchartsChart(); });
  });
})();
