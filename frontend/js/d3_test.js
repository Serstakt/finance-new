// === ТЕСТ: D3.js candlestick (вариант F) ===
// Полностью самописный график на SVG: масштабирование, оси, свечи, зум колесом.
// Разметка — те же данные, что у остальных тестов; рисуем <line>/<text> поверх
// свечей в координатах d3-шкал. Данные: GET /api/history/{symbol}.

(function () {
  const V = 'd3';
  let svg = null, g = null, xScale = null, yScale = null, xAxisG = null, yAxisG = null, marksG = null;
  let symbol = null, candles = [];
  let items = [];
  let tool = null;
  let view = null;   // [i0, i1] видимый диапазон индексов свечей
  const M = { top: 12, right: 64, bottom: 28, left: 8 };

  function el() { return document.getElementById('d3_chart'); }

  function size() {
    const r = el().getBoundingClientRect();
    return { w: Math.max(300, r.width), h: Math.max(200, r.height) };
  }

  function initSvg() {
    if (svg) return;
    svg = d3.select(el()).append('svg').attr('width', '100%').attr('height', '100%');
    g = svg.append('g');
    g.append('rect').attr('class', 'd3-bg').attr('fill', '#131722');
    xAxisG = g.append('g').attr('class', 'x-axis');
    yAxisG = g.append('g').attr('class', 'y-axis');
    const clip = svg.append('defs').append('clipPath').attr('id', 'd3-plot-clip').append('rect');
    g.append('g').attr('class', 'candles').attr('clip-path', 'url(#d3-plot-clip)');
    marksG = g.append('g').attr('class', 'marks').attr('clip-path', 'url(#d3-plot-clip)');
    // клик по фону для инструментов
    svg.on('click', event => {
      if (!tool || !candles.length) return;
      const [mx, my] = d3.pointer(event, g.node());
      const { w, h } = size();
      if (mx < M.left || mx > w - M.right || my < M.top || my > h - M.bottom) return;
      const idx = Math.round(xScale.invert(mx));
      const price = yScale.invert(my);
      placeTool(idx, price);
    });
    // зум колесом
    svg.on('wheel', event => {
      if (!view || !candles.length) return;
      event.preventDefault();
      const span = view[1] - view[0];
      const delta = event.deltaY > 0 ? Math.ceil(span * 0.15) : -Math.ceil(span * 0.15);
      let i0 = view[0] + delta, i1 = view[1] - delta;
      if (i1 - i0 < 5) return;
      i0 = Math.max(0, i0); i1 = Math.min(candles.length - 1, i1);
      view = [i0, i1];
      draw();
    }, { passive: false });
  }

  function visible() {
    if (!view) view = [0, Math.max(0, candles.length - 1)];
    return candles.slice(view[0], view[1] + 1);
  }

  function draw() {
    initSvg();
    const { w, h } = size();
    svg.attr('viewBox', `0 0 ${w} ${h}`);
    g.select('.d3-bg').attr('x', 0).attr('y', 0).attr('width', w).attr('height', h);
    svg.select('#d3-plot-clip').select('rect')
       .attr('x', M.left).attr('y', M.top).attr('width', Math.max(1, w - M.left - M.right))
       .attr('height', Math.max(1, h - M.top - M.bottom));

    const vis = visible();
    if (!vis.length) return;
    xScale = d3.scaleLinear().domain([view[0], view[1]]).range([M.left, w - M.right]);
    const lo = d3.min(vis, c => c.low), hi = d3.max(vis, c => c.high);
    const pad = (hi - lo) * 0.05 || 1;
    yScale = d3.scaleLinear().domain([lo - pad, hi + pad]).range([h - M.bottom, M.top]);

    xAxisG.attr('transform', `translate(0,${h - M.bottom})`)
      .call(d3.axisBottom(xScale).ticks(Math.max(3, Math.floor(w / 110)))
        .tickFormat(i => (candles[i] ? candles[i].time.slice(5) : '')))
      .call(sel => sel.selectAll('text,line,path').attr('stroke', '#9aa0ab').attr('fill', '#9aa0ab'));
    yAxisG.attr('transform', `translate(${w - M.right},0)`)
      .call(d3.axisLeft(yScale).ticks(6).tickFormat(d3.format('~g')))
      .call(sel => sel.selectAll('text,line,path').attr('stroke', '#9aa0ab').attr('fill', '#9aa0ab'));

    const bw = Math.max(1.5, (w - M.left - M.right) / (view[1] - view[0] + 1) * 0.65);
    const cg = g.select('.candles');
    const sel = cg.selectAll('g.candle').data(vis, (c, i) => c.time);
    sel.exit().remove();
    const enter = sel.enter().append('g').attr('class', 'candle');
    enter.append('line').attr('class', 'wick');
    enter.append('rect').attr('class', 'body');
    const merged = enter.merge(sel);
    merged.select('.wick')
      .attr('x1', c => xScale(view[0] + vis.indexOf(c))).attr('x2', c => xScale(view[0] + vis.indexOf(c)))
      .attr('y1', c => yScale(c.high)).attr('y2', c => yScale(c.low))
      .attr('stroke', c => c.close >= c.open ? '#26a69a' : '#ef5350');
    merged.select('.body')
      .attr('x', (c, i) => xScale(view[0] + i) - bw / 2)
      .attr('y', c => yScale(Math.max(c.open, c.close)))
      .attr('width', bw)
      .attr('height', c => Math.max(1, Math.abs(yScale(c.open) - yScale(c.close))))
      .attr('fill', c => c.close >= c.open ? '#26a69a' : '#ef5350');

    drawMarks();
  }

  function nearestIdx(iso) {
    let best = 0;
    for (let i = 0; i < candles.length; i++) { if (candles[i].time <= iso) best = i; else break; }
    return best;
  }

  function drawMarks() {
    marksG.selectAll('*').remove();
    const { w, h } = size();
    for (const it of items) {
      if (it.type === 'hline') {
        const py = yScale(it.price);
        marksG.append('line').attr('x1', M.left).attr('x2', w - M.right)
          .attr('y1', py).attr('y2', py).attr('stroke', it.color || '#f7a600').attr('stroke-width', 2);
        marksG.append('text').attr('x', w - M.right + 4).attr('y', py + 4)
          .attr('fill', it.color || '#f7a600').attr('font-size', 12).text(fmt(it.price));
      } else if (it.type === 'vline') {
        const px = xScale(nearestIdx(it.time));
        marksG.append('line').attr('x1', px).attr('x2', px)
          .attr('y1', M.top).attr('y2', h - M.bottom)
          .attr('stroke', it.color || '#2962ff').attr('stroke-width', 2);
        marksG.append('text').attr('x', px + 3).attr('y', M.top + 12)
          .attr('fill', it.color || '#2962ff').attr('font-size', 12).text(it.time);
      } else if (it.type === 'text') {
        const px = xScale(nearestIdx(it.time)), py = yScale(it.price);
        marksG.append('text').attr('x', px + 4).attr('y', py - 4)
          .attr('fill', it.color || '#e91e63').attr('font-size', 13).attr('font-weight', 'bold')
          .text(it.text || 'A');
      }
    }
  }

  function fmt(p) { return Math.abs(p) >= 1000 ? p.toFixed(0) : p.toFixed(2); }

  function placeTool(idx, price) {
    const iso = candles[idx] ? candles[idx].time : null;
    if (tool === 'hline') addItem({ id: LibChart.uid(), type: 'hline', price: Number(price), color: '#f7a600' });
    else if (tool === 'vline' && iso) addItem({ id: LibChart.uid(), type: 'vline', time: iso, color: '#2962ff' });
    else if (tool === 'text' && iso) {
      const text = window.prompt('Текст заметки:', 'Заметка');
      if (text) addItem({ id: LibChart.uid(), type: 'text', time: iso, price: Number(price), text, color: '#e91e63' });
    }
    LibChart.status('d3-status', `Инструмент «${tool}» снова активен — кликните по графику ещё раз`);
  }

  function redraw() {
    draw();
    LibChart.saveMarkup(V, symbol, items);
  }

  function addItem(it) { items.push(it); redraw(); }

  window.loadD3Chart = function () {
    initSvg();
    return LibChart.loadWithStatus('d3', 'd3-status', (sym, cs) => {
      symbol = sym; candles = cs; view = [0, cs.length - 1];
      items = LibChart.loadMarkup(V, sym);
      draw();
    });
  };

  window.setD3Tool = function (t) {
    tool = (tool === t) ? null : t;
    LibChart.markActiveTool('d3-toolbar', tool);
    LibChart.status('d3-status', tool ? 'Кликните по графику, чтобы поставить объект' : 'Инструмент выключен');
  };

  window.undoD3Markup = function () { items.pop(); redraw(); };
  window.clearD3Markup = function () { items = []; redraw(); };

  window.addEventListener('resize', () => { if (candles.length) draw(); });

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('d3-symbol');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') window.loadD3Chart(); });
  });
})();
