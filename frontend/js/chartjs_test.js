// === ТЕСТ: Chart.js + chartjs-chart-financial (вариант E) ===
// Chart.js рисует график на canvas внутри страницы; financial-плагин даёт
// тип 'candlestick'. Разметка — нативный плагин afterDatasetsDraw: линии и
// текст рисуем прямо в координатах масштабов chart.scales (без оверлеев).
// Данные: GET /api/history/{symbol}.

(function () {
  const V = 'chartjs';
  let chart = null;
  let symbol = null, candles = [];
  let items = [];
  let tool = null;

  // Плагин разметки: рисуем hline/vline/text поверх датасета
  const markupPlugin = {
    id: 'libMarkup',
    afterDatasetsDraw(c) {
      const ctx = c.ctx;
      const x = c.scales.x, y = c.scales.y;
      for (const it of items) {
        if (it.type === 'hline') {
          const py = y.getPixelForValue(it.price);
          ctx.save();
          ctx.strokeStyle = it.color || '#f7a600'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x.left, py); ctx.lineTo(x.right, py); ctx.stroke();
          ctx.fillStyle = it.color || '#f7a600'; ctx.font = '12px sans-serif';
          ctx.fillText(fmt(it.price), x.right + 4, py + 4);
          ctx.restore();
        } else if (it.type === 'vline') {
          const px = pixelForDate(c, it.time);
          if (px == null) continue;
          ctx.save();
          ctx.strokeStyle = it.color || '#2962ff'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(px, y.top); ctx.lineTo(px, y.bottom); ctx.stroke();
          ctx.fillStyle = it.color || '#2962ff'; ctx.font = '12px sans-serif';
          ctx.fillText(it.time, px + 3, y.top + 12);
          ctx.restore();
        } else if (it.type === 'text') {
          const px = pixelForDate(c, it.time);
          const py = y.getPixelForValue(it.price);
          if (px == null) continue;
          ctx.save();
          ctx.fillStyle = it.color || '#e91e63'; ctx.font = 'bold 13px sans-serif';
          ctx.fillText(it.text || 'A', px + 4, py - 4);
          ctx.restore();
        }
      }
    },
  };

  function pixelForDate(c, iso) {
    const idx = dates().indexOf(iso);
    if (idx >= 0) return c.scales.x.getPixelForValue(idx);
    // ближайшая дата <= iso (свечи могут не торговаться в эти дни)
    let bestIdx = -1;
    const ds = dates();
    for (let i = 0; i < ds.length; i++) { if (ds[i] <= iso) bestIdx = i; else break; }
    return bestIdx >= 0 ? c.scales.x.getPixelForValue(bestIdx) : null;
  }

  function dates() { return candles.map(cd => cd.time); }
  function fmt(p) { return Math.abs(p) >= 1000 ? p.toFixed(0) : p.toFixed(2); }

  function dataOf() {
    return candles.map(cd => ({ x: cd.time, o: cd.open, h: cd.high, l: cd.low, c: cd.close }));
  }

  function build() {
    const el = document.getElementById('chartjs_chart');
    if (chart) { chart.destroy(); chart = null; }
    chart = new Chart(el, {
      type: 'candlestick',
      data: { datasets: [{ label: symbol || '', data: dataOf(),
               color: { up: '#26a69a', down: '#ef5350', unchanged: '#9aa0ab' } }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        parsing: false, normalized: true,
        scales: {
          x: { type: 'category', labels: dates(),
               grid: { color: '#1e222d' }, ticks: { color: '#9aa0ab', maxTicksLimit: 10 } },
          y: { position: 'right', grid: { color: '#1e222d' }, ticks: { color: '#9aa0ab' } },
        },
        plugins: { legend: { labels: { color: '#d1d4dc' } }, tooltip: { enabled: true } },
        onClick(evt, els, c) {
          if (!tool) return;
          const area = c.chartArea;
          if (evt.x < area.left || evt.x > area.right || evt.y < area.top || evt.y > area.bottom) return;
          const price = c.scales.y.getValueForPixel(evt.y);
          const idx = Math.round(c.scales.x.getValueForPixel(evt.x));
          const iso = dates()[Math.max(0, Math.min(dates().length - 1, idx))];
          placeTool(iso, price);
        },
      },
      plugins: [markupPlugin],
    });
  }

  function placeTool(iso, price) {
    if (price == null || isNaN(price)) return;
    if (tool === 'hline') addItem({ id: LibChart.uid(), type: 'hline', price: Number(price), color: '#f7a600' });
    else if (tool === 'vline') addItem({ id: LibChart.uid(), type: 'vline', time: iso, color: '#2962ff' });
    else if (tool === 'text') {
      const text = window.prompt('Текст заметки:', 'Заметка');
      if (text) addItem({ id: LibChart.uid(), type: 'text', time: iso, price: Number(price), text, color: '#e91e63' });
    }
    LibChart.status('chartjs-status', `Инструмент «${tool}» снова активен — кликните по графику ещё раз`);
  }

  function redraw() {
    if (!chart) return;
    chart.update('none');
    LibChart.saveMarkup(V, symbol, items);
  }

  function addItem(it) { items.push(it); redraw(); }

  window.loadChartjsChart = function () {
    return LibChart.loadWithStatus('chartjs', 'chartjs-status', (sym, cs) => {
      symbol = sym; candles = cs;
      items = LibChart.loadMarkup(V, sym);
      build();
    });
  };

  window.setChartjsTool = function (t) {
    tool = (tool === t) ? null : t;
    LibChart.markActiveTool('chartjs-toolbar', tool);
    LibChart.status('chartjs-status', tool ? 'Кликните по графику, чтобы поставить объект' : 'Инструмент выключен');
  };

  window.undoChartjsMarkup = function () { items.pop(); redraw(); };
  window.clearChartjsMarkup = function () { items = []; redraw(); };

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('chartjs-symbol');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') window.loadChartjsChart(); });
  });
})();
