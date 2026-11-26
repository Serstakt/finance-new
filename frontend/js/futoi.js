// === FUTOI — ОТКРЫТЫЕ ПОЗИЦИИ ПО ФЬЮЧЕРСАМ (физ. и юр. лица) ===
//
// Раздел справа от Watchlist в верхнем меню. Источник — MOEX ISS+ FUTOI
// (/api/futoi/... на бэкенде, services/futoi_service.py): по корню фьючерса
// (MX — все серии на индекс МосБиржи) отдаются лонги/шорты физлиц (FIZ)
// и юрлиц (YUR) с шагом ~5 минут. Бэкенд сворачивает снимки в дневной ряд,
// здесь он рисуется линейным графиком на canvas — без внешних библиотек,
// в духе остального vanilla-JS проекта (ср. js/heatmap.js).
//
// Режимы (как на smart-lab.ru/oi):
//   longshort  — лонги/шорты физлиц и юрлиц, 4 линии;
//   net        — чистая позиция (long − short) групп;
//   shortshare — доля шортов группы, %;
//   longshare  — доля лонгов группы, %;
//   change     — изменение чистой позиции за день;
//   oi         — открытый интерес (всего лонгов/шортов).
//
// Периоды: 1М/3М/6М/1Г/Всё; инструмент — селектор (72 корня FUTOI).
// Выбор запоминается в localStorage. Клик по легенде скрывает линию.
// На бесплатном тарифе MOEX API последние 14 дней недоступны — бэкенд
// укорачивает диапазон, в подписи показывается задержка.

(function () {
  'use strict';

  const API = (typeof window !== 'undefined' && window.API_BASE) || '';
  const STORAGE_TICKER = 'futoi_ticker';
  const STORAGE_DAYS = 'futoi_days';
  const STORAGE_MODE = 'futoi_mode';

  const ALLOWED_DAYS = [30, 90, 180, 365, 3000];
  const DEFAULT_TICKER = 'MX';
  const DEFAULT_DAYS = 365;
  const DEFAULT_MODE = 'longshort';

  // Популярные инструменты — в начале селектора, остальные по алфавиту.
  const POPULAR = ['MX', 'RI', 'Si', 'CR', 'BR', 'NG', 'GD', 'SV', 'ME', 'GZ', 'LK', 'SR'];

  const COLORS = {
    fiz: '#26a69a',
    fizShort: '#ef5350',
    yur: '#4c8dff',
    yurShort: '#ffca28',
    neutral: '#787b86',
  };

  // Режимы графика: серии + единица измерения + показывать ли ноль
  // (для «чистой позиции» и «изменения» ноль — важная опорная линия).
  const MODES = {
    longshort: {
      label: 'Лонги и шорты',
      unit: 'count',
      includeZero: false,
      series: [
        { key: 'fizLong', label: 'Физ. лонги', color: COLORS.fiz },
        { key: 'fizShort', label: 'Физ. шорты', color: COLORS.fizShort },
        { key: 'yurLong', label: 'Юр. лонги', color: COLORS.yur },
        { key: 'yurShort', label: 'Юр. шорты', color: COLORS.yurShort },
      ],
    },
    net: {
      label: 'Чистая позиция',
      unit: 'signed',
      includeZero: true,
      series: [
        { key: 'fizNet', label: 'Нетто физлиц', color: COLORS.fiz },
        { key: 'yurNet', label: 'Нетто юрлиц', color: COLORS.yur },
      ],
    },
    shortshare: {
      label: 'Доля шортов',
      unit: 'percent',
      includeZero: false,
      series: [
        { key: 'fizShortShare', label: 'Физ. шорты, %', color: COLORS.fizShort },
        { key: 'yurShortShare', label: 'Юр. шорты, %', color: COLORS.yur },
      ],
    },
    longshare: {
      label: 'Доля лонгов',
      unit: 'percent',
      includeZero: false,
      series: [
        { key: 'fizLongShare', label: 'Физ. лонги, %', color: COLORS.fiz },
        { key: 'yurLongShare', label: 'Юр. лонги, %', color: COLORS.yur },
      ],
    },
    change: {
      label: 'Изменение за день',
      unit: 'signed',
      includeZero: true,
      series: [
        { key: 'fizNetChange', label: 'Нетто физлиц, Δ', color: COLORS.fiz },
        { key: 'yurNetChange', label: 'Нетто юрлиц, Δ', color: COLORS.yur },
      ],
    },
    oi: {
      label: 'OI контракта',
      unit: 'count',
      includeZero: false,
      series: [
        { key: 'oiLong', label: 'Лонги (OI)', color: COLORS.fiz },
        { key: 'oiShort', label: 'Шорты (OI)', color: COLORS.fizShort },
      ],
    },
  };

  // --- состояние раздела ---
  const state = {
    ticker: readStorage(STORAGE_TICKER, DEFAULT_TICKER),
    days: Number(readStorage(STORAGE_DAYS, DEFAULT_DAYS)) || DEFAULT_DAYS,
    mode: readStorage(STORAGE_MODE, DEFAULT_MODE),
    instruments: [],
    data: null,
    metrics: [],
    lines: [],
    hidden: new Set(),
    hoverIndex: -1,
    loading: false,
    seq: 0,
    loadedAt: 0,
    initPromise: null,
    bound: false,
    resizeObserver: null,
    resizeTimer: null,
  };
  if (!ALLOWED_DAYS.includes(state.days)) state.days = DEFAULT_DAYS;
  if (!MODES[state.mode]) state.mode = DEFAULT_MODE;

  function readStorage(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* приватный режим */ }
  }

  // === ФОРМАТИРОВАНИЕ ЧИСЕЛ ===
  const nfInt = (typeof Intl !== 'undefined' && Intl.NumberFormat)
    ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
    : null;

  window.futoiFormatCount = function (value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return nfInt ? nfInt.format(Math.round(value)) : String(Math.round(value));
  };

  // Компактная подпись для оси Y: 1,2 млн / 350 тыс / 12 345.
  window.futoiFormatCompact = function (value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    const abs = Math.abs(value);
    const sign = value < 0 ? '−' : '';
    if (abs >= 1e9) return sign + trimNum(abs / 1e9, abs >= 1e10 ? 0 : 1) + ' млрд';
    if (abs >= 1e6) return sign + trimNum(abs / 1e6, abs >= 1e7 ? 0 : 1) + ' млн';
    if (abs >= 1e4) return sign + trimNum(abs / 1e3, 0) + ' тыс';
    if (abs >= 1e3) return sign + trimNum(abs / 1e3, 1) + ' тыс';
    return sign + String(Math.round(abs));
  };

  window.futoiFormatPercent = function (value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    const d = digits === undefined ? 1 : digits;
    return value.toFixed(d).replace('.', ',') + '%';
  };

  function trimNum(v, digits) {
    let s = v.toFixed(digits);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s.replace('.', ',');
  }

  function formatSigned(value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    const sign = value > 0 ? '+' : (value < 0 ? '−' : '');
    return sign + window.futoiFormatCount(Math.abs(value));
  }

  function parseDate(iso) {
    if (!iso) return null;
    const parts = String(iso).slice(0, 10).split('-');
    if (parts.length !== 3) return null;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(iso, withYear) {
    const d = parseDate(iso);
    if (!d) return String(iso || '');
    const opts = withYear
      ? { day: '2-digit', month: '2-digit', year: '2-digit' }
      : { day: '2-digit', month: 'short' };
    return d.toLocaleDateString('ru-RU', opts);
  }

  function formatDateTime(raw) {
    // ISS: «2026-11-12 23:50:12» -> «12.11.2026 23:50»
    const s = String(raw || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return s;
    return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
  }

  // === МЕТРИКИ ДНЯ ===
  function groupMetrics(group) {
    if (!group) return null;
    const long = numberOrNull(group.pos_long);
    const shortRaw = numberOrNull(group.pos_short);
    const longValue = long === null ? 0 : long;
    const shortAbs = shortRaw === null ? 0 : Math.abs(shortRaw);
    const total = longValue + shortAbs;
    return {
      long: longValue,
      short: shortAbs,
      net: numberOrNull(group.pos) || 0,
      longShare: total > 0 ? (longValue / total) * 100 : null,
      shortShare: total > 0 ? (shortAbs / total) * 100 : null,
    };
  }

  function numberOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  // Метрики одного дня. Значения-«дельты» считаются относительно
  // предыдущего торгового дня (prev — предыдущая точка ряда).
  window.futoiPointMetrics = function (point, prev) {
    const fiz = groupMetrics(point && point.fiz);
    const yur = groupMetrics(point && point.yur);
    const prevFiz = groupMetrics(prev && prev.fiz);
    const prevYur = groupMetrics(prev && prev.yur);
    const total = (point && point.total) || {};
    return {
      date: point && point.date,
      fizLong: fiz ? fiz.long : null,
      fizShort: fiz ? fiz.short : null,
      fizNet: fiz ? fiz.net : null,
      fizLongShare: fiz ? fiz.longShare : null,
      fizShortShare: fiz ? fiz.shortShare : null,
      yurLong: yur ? yur.long : null,
      yurShort: yur ? yur.short : null,
      yurNet: yur ? yur.net : null,
      yurLongShare: yur ? yur.longShare : null,
      yurShortShare: yur ? yur.shortShare : null,
      oiLong: numberOrNull(total.pos_long),
      oiShort: total.pos_short === null || total.pos_short === undefined
        ? null : Math.abs(Number(total.pos_short)),
      fizNetChange: (fiz && prevFiz) ? fiz.net - prevFiz.net : null,
      yurNetChange: (yur && prevYur) ? yur.net - prevYur.net : null,
    };
  };

  // Ряд значений для выбранного режима: [{key, label, color, values: [...]}].
  window.futoiBuildSeries = function (data, mode) {
    const def = MODES[mode] || MODES[DEFAULT_MODE];
    const points = (data && data.series) || [];
    const metrics = points.map((p, i) => window.futoiPointMetrics(p, i > 0 ? points[i - 1] : null));
    const lines = def.series.map(s => ({
      key: s.key,
      label: s.label,
      color: s.color,
      values: metrics.map(m => (m[s.key] === null || m[s.key] === undefined ? null : m[s.key])),
    }));
    return { mode: MODES[mode] ? mode : DEFAULT_MODE, unit: def.unit, includeZero: !!def.includeZero, lines, metrics };
  };

  // === «КРАСИВЫЕ» ДЕЛЕНИЯ ОСИ ===
  window.futoiNiceTicks = function (min, max, targetCount) {
    const count = targetCount || 5;
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;
      min -= pad;
      max += pad;
    }
    const span = max - min;
    const rawStep = span / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / magnitude;
    let mult = 1;
    if (norm > 1 && norm <= 2) mult = 2;
    else if (norm > 2 && norm <= 2.5) mult = 2.5;
    else if (norm > 2.5 && norm <= 5) mult = 5;
    else if (norm > 5) mult = 10;
    const step = mult * magnitude;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
      if (ticks.length > 40) break;
    }
    return ticks;
  };

  // === ДАННЫЕ ===
  async function loadInstruments() {
    const select = document.getElementById('futoi-instrument');
    try {
      const res = await window.fetchWithTimeout(`${API}/api/futoi/instruments`, {}, 30000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data.instruments) ? data.instruments.slice() : [];
      if (!list.length) return;
      list.sort((a, b) => {
        const ia = POPULAR.indexOf(a.ticker);
        const ib = POPULAR.indexOf(b.ticker);
        if (ia !== -1 || ib !== -1) {
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        }
        return String(a.name || a.ticker).localeCompare(String(b.name || b.ticker), 'ru');
      });
      state.instruments = list;
      select.innerHTML = list.map(inst =>
        `<option value="${escapeHtml(inst.ticker)}">${escapeHtml(inst.name || inst.ticker)}</option>`
      ).join('');
      const available = list.some(i => i.ticker === state.ticker);
      if (!available) {
        state.ticker = list[0].ticker;
        writeStorage(STORAGE_TICKER, state.ticker);
      }
      select.value = state.ticker;
    } catch (e) {
      console.warn('FUTOI: не удалось загрузить список инструментов', e);
    }
  }

  async function loadSeries(force) {
    const seq = ++state.seq;
    setLoading(true);
    try {
      const url = `${API}/api/futoi/${encodeURIComponent(state.ticker)}?days=${state.days}`
        + (force ? '&force=1' : '');
      const res = await window.fetchWithTimeout(url, {}, 60000);
      if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try { const j = await res.json(); detail = j.detail || detail; } catch (e) { /* not json */ }
        throw new Error(detail);
      }
      const data = await res.json();
      if (seq !== state.seq) return; // устаревший ответ (быстро переключили тикер)
      if (data && data.error) throw new Error(data.error);
      if (!data || !Array.isArray(data.series)) throw new Error('Пустой ответ');

      state.data = data;
      state.loadedAt = Date.now();
      renderAll();
    } catch (e) {
      if (seq !== state.seq) return;
      console.error('FUTOI: ошибка загрузки', e);
      state.data = null;
      state.metrics = [];
      state.lines = [];
      showEmpty('Не удалось загрузить данные FUTOI: ' + (e && e.message ? e.message : e));
      setFootnote('Проверьте подключение к MOEX ISS+ и токен MOEX_API_TOKEN в .env.');
      document.getElementById('futoi-summary').innerHTML = '';
      renderLegend();
      updateUpdatedLabel();
    } finally {
      if (seq === state.seq) setLoading(false);
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    const btn = document.getElementById('futoi-refresh');
    if (btn) btn.classList.toggle('loading', loading);
    if (loading) showEmpty('Загрузка данных…');
    else if (state.data) showEmpty('');
  }

  function showEmpty(text) {
    const el = document.getElementById('futoi-empty');
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  }

  function setFootnote(text) {
    const el = document.getElementById('futoi-footnote');
    if (el) el.textContent = text || '';
  }

  // === РЕНДЕР ===
  function renderAll() {
    const built = window.futoiBuildSeries(state.data, state.mode);
    state.lines = built.lines;
    state.metrics = built.metrics;
    state.hoverIndex = -1;
    renderSummary();
    renderLegend();
    updateUpdatedLabel();
    updateFootnote();
    hideTooltip();
    // Рисуем сразу, не через requestAnimationFrame: в фоновой/свёрнутой
    // вкладке (и в среде предпросмотра) rAF может не срабатывать вовсе,
    // а холст уже в layout — размеры доступны синхронно.
    drawChart();
  }

  function updateUpdatedLabel() {
    const el = document.getElementById('futoi-updated');
    if (!el) return;
    const data = state.data;
    if (!data) { el.textContent = ''; el.removeAttribute('title'); return; }
    const stamp = data.updated || data.latest;
    el.textContent = stamp ? `Данные на ${formatDateTime(stamp)}` : '';
    const parts = [`Обновлено: ${stamp || '—'}`];
    if (data.delayed && data.delay_days) parts.push(`Задержка: ${data.delay_days} дн. (бесплатный тариф MOEX API)`);
    if (data.dataset_from) parts.push(`История с ${data.dataset_from}`);
    el.title = parts.join('\n');
    el.classList.toggle('delayed', !!data.delayed);
  }

  function updateFootnote() {
    const data = state.data;
    if (!data) return;
    const parts = ['Источник: MOEX ISS+ · FUTOI. Позиции агрегированы по всем сериям инструмента.'];
    if (data.delayed && data.delay_days) {
      parts.push(`Бесплатный тариф ISS+ отдаёт данные с задержкой ${data.delay_days} дн.`);
    }
    if (data.dataset_from) parts.push(`Доступная история: с ${data.dataset_from}.`);
    setFootnote(parts.join(' '));
  }

  function renderSummary() {
    const el = document.getElementById('futoi-summary');
    if (!el) return;
    const metrics = state.metrics || [];
    const last = metrics[metrics.length - 1];
    if (!last) { el.innerHTML = ''; return; }

    const card = (title, value, sub, cls) =>
      `<div class="futoi-sum-card">
         <div class="futoi-sum-title">${title}</div>
         <div class="futoi-sum-value ${cls || ''}">${value}</div>
         <div class="futoi-sum-sub">${sub || '&nbsp;'}</div>
       </div>`;

    const netCls = v => v > 0 ? 'futoi-pos' : (v < 0 ? 'futoi-neg' : '');
    const lastDate = formatDate(last.date, true);

    const fizNetSub = last.fizNetChange === null
      ? `на ${lastDate}`
      : `за день ${formatSigned(last.fizNetChange)}`;
    const yurNetSub = last.yurNetChange === null
      ? `на ${lastDate}`
      : `за день ${formatSigned(last.yurNetChange)}`;

    el.innerHTML = [
      card('Физлица · лонги',
        window.futoiFormatCount(last.fizLong),
        'контрактов'),
      card('Физлица · шорты',
        window.futoiFormatCount(last.fizShort),
        `доля шортов ${window.futoiFormatPercent(last.fizShortShare)}`),
      card('Физлица · нетто',
        formatSigned(last.fizNet),
        fizNetSub,
        netCls(last.fizNet)),
      card('Юрлица · нетто',
        formatSigned(last.yurNet),
        yurNetSub,
        netCls(last.yurNet)),
      card('Открытый интерес',
        window.futoiFormatCount(last.oiLong),
        'лонги = шорты (контракты)'),
    ].join('');
  }

  function renderLegend() {
    const el = document.getElementById('futoi-legend');
    if (!el) return;
    if (!state.lines.length) { el.innerHTML = ''; return; }
    el.innerHTML = state.lines.map(line => {
      const off = state.hidden.has(line.key) ? ' off' : '';
      return `<button type="button" class="futoi-leg-item${off}" data-key="${escapeHtml(line.key)}"
                title="Показать/скрыть линию">
                <span class="futoi-leg-dot" style="background:${line.color}"></span>
                <span>${escapeHtml(line.label)}</span>
              </button>`;
    }).join('');
  }

  // === ГРАФИК ===
  function chartGeometry() {
    const wrap = document.getElementById('futoi-chart-wrap');
    const canvas = document.getElementById('futoi-chart');
    if (!wrap || !canvas) return null;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (!width || !height) return null;
    return {
      wrap, canvas, width, height,
      left: 64, right: 16, top: 14, bottom: 30,
      plotW: Math.max(10, width - 64 - 16),
      plotH: Math.max(10, height - 14 - 30),
    };
  }

  function drawChart() {
    const geo = chartGeometry();
    if (!geo) return;
    const { canvas, width, height, left, top, plotW, plotH } = geo;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const def = MODES[state.mode] || MODES[DEFAULT_MODE];
    const visible = state.lines.filter(l => !state.hidden.has(l.key));
    const n = state.metrics.length;

    if (!n || !visible.length) {
      showEmpty(!n ? 'Нет данных за выбранный период' : 'Все линии скрыты — включите их в легенде');
      return;
    }

    // --- домен Y ---
    let min = Infinity, max = -Infinity;
    visible.forEach(line => line.values.forEach(v => {
      if (v === null || v === undefined || !isFinite(v)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    }));
    if (!isFinite(min) || !isFinite(max)) {
      showEmpty('Нет числовых данных за выбранный период');
      return;
    }
    if (def.includeZero || (min < 0 && max > 0)) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;
      min -= pad; max += pad;
    } else {
      const pad = (max - min) * 0.08;
      min -= pad; max += pad;
    }

    const ticks = window.futoiNiceTicks(min, max, 5).filter(v => v >= min && v <= max);
    const yOf = v => top + plotH - ((v - min) / (max - min)) * plotH;
    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const xOf = i => n > 1 ? left + i * stepX : left + plotW / 2;

    showEmpty('');

    // --- сетка и подписи Y ---
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    ticks.forEach(tick => {
      const y = Math.round(yOf(tick)) + 0.5;
      ctx.strokeStyle = tick === 0 ? '#3a3f4b' : '#232836';
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#787b86';
      ctx.fillText(axisLabel(tick, def.unit), left - 8, y);
    });

    // --- подписи X ---
    const labelCount = Math.max(2, Math.min(8, Math.floor(plotW / 105)));
    const withYear = state.days > 400;
    const seen = new Set();
    for (let k = 0; k < labelCount; k++) {
      const idx = n === 1 ? 0 : Math.round((k / (labelCount - 1)) * (n - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      const label = formatDate(state.metrics[idx].date, withYear);
      ctx.textAlign = k === 0 ? 'left' : (k === labelCount - 1 ? 'right' : 'center');
      ctx.fillStyle = '#787b86';
      ctx.fillText(label, xOf(idx), top + plotH + 18);
    }

    // --- линии ---
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotW, plotH);
    ctx.clip();
    visible.forEach(line => {
      ctx.beginPath();
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      let started = false;
      line.values.forEach((v, i) => {
        if (v === null || v === undefined || !isFinite(v)) {
          started = false;
          return;
        }
        const x = xOf(i);
        const y = yOf(v);
        if (started) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); started = true; }
      });
      ctx.stroke();

      // Точка на последнем значении — «текущее» состояние серии.
      for (let i = line.values.length - 1; i >= 0; i--) {
        const v = line.values[i];
        if (v === null || v === undefined || !isFinite(v)) continue;
        ctx.beginPath();
        ctx.fillStyle = line.color;
        ctx.arc(xOf(i), yOf(v), 2.6, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    });
    ctx.restore();

    // --- перекрестие и точки под курсором ---
    if (state.hoverIndex >= 0 && state.hoverIndex < n) {
      const hx = xOf(state.hoverIndex);
      ctx.save();
      ctx.strokeStyle = 'rgba(209, 212, 220, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, top);
      ctx.lineTo(Math.round(hx) + 0.5, top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      visible.forEach(line => {
        const v = line.values[state.hoverIndex];
        if (v === null || v === undefined || !isFinite(v)) return;
        ctx.beginPath();
        ctx.fillStyle = line.color;
        ctx.arc(hx, yOf(v), 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#131722';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  function axisLabel(value, unit) {
    if (unit === 'percent') return window.futoiFormatPercent(value, 0);
    return window.futoiFormatCompact(value);
  }

  // --- тултип ---
  function updateTooltip(index) {
    const geo = chartGeometry();
    const tooltip = document.getElementById('futoi-tooltip');
    if (!geo || !tooltip || index < 0 || index >= state.metrics.length) return;
    const def = MODES[state.mode] || MODES[DEFAULT_MODE];
    const visible = state.lines.filter(l => !state.hidden.has(l.key));
    const point = state.metrics[index];
    const rows = visible.map(line => {
      const v = line.values[index];
      return `<div class="futoi-tt-row">
                <span class="futoi-tt-dot" style="background:${line.color}"></span>
                <span class="futoi-tt-label">${escapeHtml(line.label)}</span>
                <span class="futoi-tt-val">${tooltipValue(v, def.unit)}</span>
              </div>`;
    }).join('');

    tooltip.innerHTML = `<div class="futoi-tt-date">${formatDate(point.date, true)}</div>${rows}`;
    tooltip.style.display = 'block';

    const n = state.metrics.length;
    const stepX = n > 1 ? geo.plotW / (n - 1) : 0;
    const hx = n > 1 ? geo.left + index * stepX : geo.left + geo.plotW / 2;
    const tw = tooltip.offsetWidth || 190;
    const th = tooltip.offsetHeight || 80;
    let leftPx = hx + 14;
    if (leftPx + tw > geo.width - 6) leftPx = hx - tw - 14;
    leftPx = Math.max(6, Math.min(leftPx, geo.width - tw - 6));
    const topPx = Math.max(6, Math.min(14, geo.height - th - 6));
    tooltip.style.left = leftPx + 'px';
    tooltip.style.top = topPx + 'px';
  }

  function tooltipValue(value, unit) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    if (unit === 'percent') return window.futoiFormatPercent(value);
    if (unit === 'signed') return formatSigned(value);
    return window.futoiFormatCount(value);
  }

  function hideTooltip() {
    const tooltip = document.getElementById('futoi-tooltip');
    if (tooltip) tooltip.style.display = 'none';
    state.hoverIndex = -1;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // === СОБЫТИЯ ===
  function bindControls() {
    if (state.bound) return;
    state.bound = true;

    const select = document.getElementById('futoi-instrument');
    if (select) {
      select.value = state.ticker;
      select.addEventListener('change', () => {
        state.ticker = select.value;
        writeStorage(STORAGE_TICKER, state.ticker);
        loadSeries();
      });
    }

    const periods = document.getElementById('futoi-periods');
    if (periods) {
      periods.addEventListener('click', e => {
        const btn = e.target.closest('button[data-days]');
        if (!btn) return;
        const days = Number(btn.dataset.days);
        if (!ALLOWED_DAYS.includes(days) || days === state.days) return;
        state.days = days;
        writeStorage(STORAGE_DAYS, days);
        syncPeriodButtons();
        loadSeries();
      });
      syncPeriodButtons();
    }

    const modes = document.getElementById('futoi-modes');
    if (modes) {
      modes.addEventListener('click', e => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        const mode = btn.dataset.mode;
        if (!MODES[mode] || mode === state.mode) return;
        state.mode = mode;
        writeStorage(STORAGE_MODE, mode);
        state.hidden.clear();
        state.hoverIndex = -1;
        syncModeButtons();
        renderAll();
      });
      syncModeButtons();
    }

    const legend = document.getElementById('futoi-legend');
    if (legend) {
      legend.addEventListener('click', e => {
        const btn = e.target.closest('button[data-key]');
        if (!btn) return;
        const key = btn.dataset.key;
        if (state.hidden.has(key)) state.hidden.delete(key);
        else state.hidden.add(key);
        renderLegend();
        hideTooltip();
        drawChart();
      });
    }

    const refresh = document.getElementById('futoi-refresh');
    if (refresh) refresh.addEventListener('click', () => loadSeries(true));

    bindChartHover();

    const wrap = document.getElementById('futoi-chart-wrap');
    if (wrap && typeof ResizeObserver !== 'undefined') {
      state.resizeObserver = new ResizeObserver(() => {
        clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => drawChart(), 80);
      });
      state.resizeObserver.observe(wrap);
    } else if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => {
        clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => drawChart(), 120);
      });
    }
  }

  function syncPeriodButtons() {
    document.querySelectorAll('#futoi-periods button[data-days]').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.days) === state.days);
    });
  }

  function syncModeButtons() {
    document.querySelectorAll('#futoi-modes button[data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });
  }

  function bindChartHover() {
    const wrap = document.getElementById('futoi-chart-wrap');
    if (!wrap) return;

    wrap.addEventListener('mousemove', e => {
      if (!state.metrics.length) return;
      const geo = chartGeometry();
      if (!geo) return;
      const rect = geo.wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < geo.left || mx > geo.left + geo.plotW || my < geo.top || my > geo.top + geo.plotH) {
        if (state.hoverIndex !== -1) { hideTooltip(); drawChart(); }
        return;
      }
      const n = state.metrics.length;
      const index = n > 1
        ? Math.max(0, Math.min(n - 1, Math.round(((mx - geo.left) / geo.plotW) * (n - 1))))
        : 0;
      if (index !== state.hoverIndex) {
        state.hoverIndex = index;
        drawChart();
        updateTooltip(index);
      }
    });

    wrap.addEventListener('mouseleave', () => {
      hideTooltip();
      drawChart();
    });
  }

  // === ПУБЛИЧНАЯ ТОЧКА ВХОДА ===
  // Вызывается navigateTo('futoi') из main.js. Инициализация ленивая:
  // пока раздел не открыт, сеть не дёргаем.
  window.loadFutoiPage = function () {
    if (!state.initPromise) {
      state.initPromise = (async () => {
        bindControls();
        await loadInstruments();
        await loadSeries();
      })();
    } else if (state.data && Date.now() - state.loadedAt > 300000) {
      // Вернулись в раздел спустя 5+ минут — обновляем ряд (FUTOI на ISS
      // обновляется каждые 5 минут, чаще опрашивать смысла нет).
      loadSeries();
    }
    // Повторный переход в раздел: холст мог быть скрыт при первой загрузке
    // (нулевые размеры) — перерисовываем после активации страницы.
    if (state.data) {
      drawChart();
      if (state.hoverIndex >= 0) updateTooltip(state.hoverIndex);
    }
    return state.initPromise;
  };

  // Сброс кэша данных (например, после смены токена) — на будущее и для тестов.
  window.futoiReload = function () {
    state.data = null;
    return loadSeries(true);
  };

  if (typeof document !== 'undefined') {
    // На случай, если раздел открыт первым: main.js вызывает navigateTo
    // на DOMContentLoaded, но не мешает подготовить обработчики заранее.
    const ready = () => {
      if (document.getElementById('futoi-page') &&
          document.getElementById('futoi-page').classList.contains('active')) {
        window.loadFutoiPage();
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ready);
    } else {
      ready();
    }
  }
})();
