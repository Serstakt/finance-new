// === ОТЧЁТНОСТЬ — ФИНАНСОВЫЕ ПОКАЗАТЕЛИ КОМПАНИЙ ИЗ WATCHLIST ===
//
// В шапке раздела — выбор компании (дропдаун) и кнопка загрузки файла.
// Таблица в духе smart-lab: строка «Период» с колонками-периодами
// (кварталы, полугодия, 9 месяцев, годы), строка «Фин. отчетность»
// с кнопкой «Файл» у каждого периода и плоские строки-показатели.
// Набор строк зависит от сектора компании (банки — свой шаблон из
// бэкенда, см. report_metrics_service.py: metrics_catalog(sector)).
//
// Колонка появляется после загрузки PDF/ZIP по выбранной компании:
// бэкенд (services/reports_service.py + report_metrics_service.py)
// распознаёт ОПиУ/ДДС/баланс, приводит статьи к единому набору
// показателей и сохраняет периоды в report_documents.columns_json.
// Ниже таблицы — документы компании и исходные распознанные таблицы.
//
// API:
//   GET    /api/reports/companies            -> бумаги watchlist + счётчики
//   GET    /api/reports/company?ticker=...   -> колонки периодов и документы
//   POST   /api/reports/upload (file,ticker) -> разбор и добавление колонок
//   GET    /api/reports/{id}                 -> исходные таблицы одного файла
//   DELETE /api/reports/{id}                 -> удалить загрузку
//
// Рендер в духе остального vanilla-JS проекта (ср. js/futoi.js): без
// фреймворков, разметка собирается строками, все тексты экранируются.

(function () {
  'use strict';

  const API = (typeof window !== 'undefined' && window.API_BASE) || '';
  const STORAGE_COMPANY = 'reports_selected_company';
  const MAX_FILE_SIZE = 30 * 1024 * 1024;

  const KIND_LABELS = {
    quarter: 'квартал',
    half: 'полугодие',
    nine: '9 месяцев',
    year: 'год',
    date: 'дата',
  };

  const FILTERS = [
    { key: 'all', label: 'Все периоды' },
    { key: 'quarter', label: 'Кварталы' },
    { key: 'half', label: 'Полугодия' },
    { key: 'nine', label: '9 месяцев' },
    { key: 'year', label: 'Годы' },
  ];

  const state = {
    companies: [],
    companiesError: '',
    loadingCompanies: false,
    selected: '',
    detailSeq: 0,
    detail: null,
    loadingDetail: false,
    companyError: '',
    filter: 'all',
    view: 'values',       // values | change
    uploading: false,
    openDoc: null,        // {id, loading, data, activeTable}
    bound: false,
    // Текущая капитализация выбранной бумаги (ISSUECAPITALIZATION из
    // /api/prices): {cap: number|null, updated: 'ЧЧ:ММ:СС'}. Обновляется
    // на каждом real-time-тике (см. таймер в bindHandlers).
    market: { cap: null, updated: '' },
  };

  // --- Вспомогательное ------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    // Бэкенд отдаёт UTC с суффиксом Z — показываем в местном времени.
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (e) {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  async function requestJson(url, options = {}, timeoutMs = 20000) {
    // fetchWithTimeout из js/api.js: зависший запрос обрывается по таймеру,
    // иначе раздел «крутит индикатор» бесконечно.
    const response = await window.fetchWithTimeout(url, options, timeoutMs);
    let payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload && payload.detail ? payload.detail : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return payload;
  }

  function savedCompany() {
    try {
      return sessionStorage.getItem(STORAGE_COMPANY) || '';
    } catch (e) {
      return '';
    }
  }

  function rememberCompany(ticker) {
    try {
      if (ticker) sessionStorage.setItem(STORAGE_COMPANY, ticker);
      else sessionStorage.removeItem(STORAGE_COMPANY);
    } catch (e) { /* приватный режим — не критично */ }
  }

  function bareTicker(ticker) {
    return ticker && ticker.indexOf(':') >= 0 ? ticker.split(':')[1] : (ticker || '');
  }

  function companyName(ticker) {
    const found = state.companies.find((item) => item.ticker === ticker);
    return found ? found.code : bareTicker(ticker);
  }

  function currentCompany() {
    return state.companies.find((item) => item.ticker === state.selected) || null;
  }

  // --- Форматирование чисел -------------------------------------------------

  function formatNumber(value, digits) {
    if (value == null || !Number.isFinite(value)) return '';
    try {
      return new Intl.NumberFormat('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      }).format(value);
    } catch (e) {
      return String(Math.round(value * 100) / 100);
    }
  }

  function formatCell(value, unit, cellUnit) {
    if (value == null || !Number.isFinite(value)) return '—';
    if (unit === 'pct') return formatNumber(value, 1) + '%';
    if (unit === 'x') return formatNumber(value, 2) + '×';
    if (unit === 'share') return formatNumber(value, 2) + ' ₽';
    if (cellUnit === 'raw') {
      return formatNumber(value, Math.abs(value) >= 1000 ? 0 : 2);
    }
    const digits = Math.abs(value) >= 100 ? 1 : 2;
    return formatNumber(value, digits);
  }

  function formatChange(value) {
    if (value == null || !Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return sign + formatNumber(value, 1) + '%';
  }

  function metricUnit(metric, columns) {
    if (metric.unit === 'share') return '₽/акция';
    if (metric.unit === 'pct') return '%';
    if (metric.unit === 'x') return '×';
    for (let i = 0; i < columns.length; i += 1) {
      const cell = cellForMetric(metric.key, columns[i]);
      if (cell) return cell.u === 'bn' ? 'млрд ₽' : 'как в отчёте';
    }
    return '';
  }

  function changeFor(metricKey, columnIndex, columns) {
    const current = columns[columnIndex];
    const currentCell = current && current.values ? current.values[metricKey] : null;
    if (!currentCell || currentCell.v == null || !Number.isFinite(currentCell.v)) return null;
    // Предыдущий период того же типа: для кварталов — прошлый квартал,
    // для годов — прошлый год. Колонки отсортированы от новых к старым.
    let previous = null;
    for (let i = columnIndex + 1; i < columns.length; i += 1) {
      if (columns[i].kind !== current.kind) continue;
      previous = columns[i].values ? columns[i].values[metricKey] : null;
      break;
    }
    if (!previous || previous.v == null || !Number.isFinite(previous.v) || previous.v === 0) {
      return null;
    }
    return (currentCell.v - previous.v) / Math.abs(previous.v) * 100;
  }

  // --- Мультипликаторы по текущей капитализации -----------------------------
  // Капитализация приходит из /api/prices (ISSUECAPITALIZATION, рубли).
  // Потоки за период приводятся к году, как на smart-lab: квартал ×4,
  // полугодие ×2, 9 месяцев ×4/3. Мультипликатор считается только из статей
  // в млрд ₽ (u === 'bn'): «как в отчёте» без распознанных единиц к рублям
  // не приводится — выдумывать масштаб нельзя. Значение строки из самого
  // отчёта приоритетнее (см. cellForMetric).
  const ANNUAL_FACTORS = { quarter: 4, half: 2, nine: 4 / 3 };

  function marketCell(metricKey, column, cap) {
    if (!cap || !Number.isFinite(cap) || cap <= 0 || !column) return null;
    const capBn = cap / 1e9;
    const values = column.values || {};
    const factor = ANNUAL_FACTORS[column.kind] || 1;
    // Статья в млрд ₽, иначе для рыночного расчёта непригодна.
    const pick = (key) => {
      const cell = values[key];
      return cell && cell.u === 'bn' && cell.v != null && Number.isFinite(cell.v) ? cell : null;
    };
    if (metricKey === 'pe') {
      // Прибыль акционерам банка → общая чистая прибыль за период.
      const profit = pick('net_profit_shareholders') || pick('net_profit_total') || pick('net_profit');
      if (profit && profit.v !== 0) return { v: capBn / (profit.v * factor), u: 'x' };
      return null;
    }
    if (metricKey === 'pb') {
      const equity = pick('equity');
      if (equity && equity.v !== 0) return { v: capBn / equity.v, u: 'x' };
      return null;
    }
    if (metricKey === 'ev_ebitda') {
      const ebitda = pick('ebitda');
      if (!ebitda || ebitda.v === 0) return null;
      // Чистый долг может отсутствовать — тогда EV ≈ капитализация.
      // Отрицательный чистый долг (чистая денежная позиция) уменьшает EV.
      const netDebt = pick('net_debt');
      const ev = capBn + (netDebt ? netDebt.v : 0);
      return { v: ev / ebitda.v, u: 'x' };
    }
    if (metricKey === 'ps') {
      const revenue = pick('revenue');
      if (revenue && revenue.v !== 0) return { v: capBn / (revenue.v * factor), u: 'x' };
      return null;
    }
    return null;
  }

  // Значение ячейки: как в отчёте, иначе — по текущей капитализации.
  // «Капитализация» — текущее значение с Мосбиржи, показывается в КАЖДОЙ
  // колонке (историческую из цен не восстановить); значение из самого
  // отчёта, если строка там была, приоритетнее.
  function cellForMetric(metricKey, column) {
    const stored = column && column.values ? column.values[metricKey] : null;
    if (stored && stored.v != null) return stored;
    if (metricKey === 'market_cap') {
      const cap = state.market.cap;
      return cap && Number.isFinite(cap) && cap > 0
        ? { v: cap / 1e9, u: 'bn' }
        : null;
    }
    return marketCell(metricKey, column, state.market.cap);
  }

  // --- Данные ---------------------------------------------------------------

  async function loadCompanies() {
    if (state.loadingCompanies) return;
    state.loadingCompanies = true;
    state.companiesError = '';
    renderCompanySelect();
    try {
      const data = await requestJson(`${API}/api/reports/companies`, {}, 15000);
      state.companies = (data && data.companies) || [];
    } catch (err) {
      state.companies = [];
      state.companiesError = err.message;
    } finally {
      state.loadingCompanies = false;
      renderCompanySelect();
    }
  }

  async function loadCompany(ticker) {
    if (!ticker) {
      state.detail = null;
      state.companyError = '';
      renderMain();
      return;
    }
    // Быстрые клики по списку: ответ устаревшего запроса не должен
    // перетереть показатели уже выбранной бумаги.
    const sequence = (state.detailSeq || 0) + 1;
    state.detailSeq = sequence;
    state.loadingDetail = true;
    state.companyError = '';
    state.filter = 'all';
    state.view = 'values';
    state.openDoc = null;
    state.detail = null;
    // Капитализация прошлой бумаги не должна подсвечивать мультипликаторы
    // новой, пока не пришёл её собственный ответ /api/prices.
    state.market = { cap: null, updated: '' };
    renderMain();
    try {
      const data = await requestJson(
        `${API}/api/reports/company?ticker=${encodeURIComponent(ticker)}`, {}, 20000,
      );
      if (sequence !== state.detailSeq) return;
      state.detail = data;
      setUpdated(data);
      loadMarketCap();
    } catch (err) {
      if (sequence !== state.detailSeq) return;
      state.companyError = err.message;
      state.detail = null;
      setUpdated(null);
    } finally {
      if (sequence === state.detailSeq) {
        state.loadingDetail = false;
        renderMain();
      }
    }
  }

  // Текущая капитализация выбранной бумаги: /api/prices возвращает
  // ISSUECAPITALIZATION (рубли) и ISSUECAPITALIZATION_UPDATETIME.
  // Вызывается при выборе бумаги и на каждом real-time-тике (интервал —
  // как у watchlist, AUTO_REFRESH_INTERVAL): пока открыт раздел «Отчетность»,
  // капитализация в шапке и мультипликаторы в таблице остаются живыми.
  async function loadMarketCap() {
    const ticker = state.selected;
    if (!ticker || ticker === '__orphans__') return;
    try {
      const data = await requestJson(
        `${API}/api/prices/${encodeURIComponent(ticker)}`, {}, 15000,
      );
      // Бумагу успели сменить — ответ устарел, не трогаем состояние.
      if (state.selected !== ticker) return;
      const rawCap = data && data.ISSUECAPITALIZATION;
      const cap = rawCap != null && Number.isFinite(Number(rawCap)) && Number(rawCap) > 0
        ? Number(rawCap) : null;
      const updated = (data && data.ISSUECAPITALIZATION_UPDATETIME) || '';
      const same = cap === state.market.cap && updated === state.market.updated;
      const sameBn = cap != null && state.market.cap != null
        && Math.round(cap / 1e8) === Math.round(state.market.cap / 1e8);
      if (same) return;
      state.market = { cap, updated };
      // Перерисовка нужна только когда значение реально сдвинулось
      // (с точностью 0,1 млрд ₽ — чтобы не мигать таблицей на каждом тике).
      if (sameBn) return;
      renderMain();
    } catch (e) {
      // Сеть/таймаут — оставляем последнее известное значение.
    }
  }

  async function selectCompany(ticker) {
    if (!ticker) return;
    state.selected = ticker;
    rememberCompany(ticker);
    renderCompanySelect();
    updateAddButton();
    await loadCompany(ticker);
  }

  async function refreshAll() {
    await loadCompanies();
    const exists = state.selected
      && state.companies.some((item) => item.ticker === state.selected);
    if (exists) {
      await loadCompany(state.selected);
      return;
    }
    const fallback = state.companies.find((item) => item.in_watchlist)
      || state.companies[0];
    if (fallback) {
      await selectCompany(fallback.ticker);
    } else {
      state.selected = '';
      state.detail = null;
      rememberCompany(null);
      updateAddButton();
      renderCompanySelect();
      renderMain();
    }
  }

  function setUpdated(detail) {
    const box = byId('reports-updated');
    if (!box) return;
    const docs = detail && Array.isArray(detail.documents) ? detail.documents : [];
    const latest = docs.find((doc) => doc.uploaded_at);
    box.textContent = latest ? `Обновлено ${formatDate(latest.uploaded_at)}` : '';
  }

  // --- Рендер списка бумаг (дропдаун) ---------------------------------------

  function companyOptionLabel(company) {
    if (company.ticker === '__orphans__') {
      return 'Без компании';
    }
    const parts = [company.code || company.ticker];
    if (!company.in_watchlist) parts.push('вне watchlist');
    return parts.join(' · ');
  }

  function renderCompanySelect() {
    const select = byId('reports-company-select');
    if (!select) return;
    const previous = select.value;

    if (state.loadingCompanies && !state.companies.length) {
      select.innerHTML = '<option value="">Загрузка бумаг…</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    if (state.companiesError) {
      select.innerHTML = `<option value="">Не удалось загрузить бумаги</option>`;
      return;
    }
    if (!state.companies.length) {
      select.innerHTML = '<option value="">В watchlist нет бумаг</option>';
      return;
    }

    const options = ['<option value="">Выбор компании</option>']
      .concat(state.companies.map((company) => `
        <option value="${escapeHtml(company.ticker)}"${company.ticker === state.selected ? ' selected' : ''}>
          ${escapeHtml(companyOptionLabel(company))}
        </option>`))
      .join('');
    select.innerHTML = options;
    // Восстанавливаем выбор, если перерисовка случилась без смены компании.
    if (previous && state.companies.some((item) => item.ticker === previous)) {
      select.value = state.selected || previous;
    }
  }

  // --- Таблица показателей --------------------------------------------------

  function filteredColumns() {
    const columns = (state.detail && state.detail.columns) || [];
    if (state.filter === 'all') return columns;
    return columns.filter((column) => column.kind === state.filter);
  }

  function hasAnyValue(metric, columns, changeMode) {
    for (let i = 0; i < columns.length; i += 1) {
      if (changeMode) {
        if (changeFor(metric.key, i, columns) != null) return true;
      } else {
        const cell = cellForMetric(metric.key, columns[i]);
        if (cell && cell.v != null) return true;
      }
    }
    return false;
  }

  function canChangeView(columns) {
    // «Изм. %» имеет смысл, только если есть хотя бы два периода
    // одного типа (квартал к кварталу, год к году).
    for (let i = 0; i < columns.length; i += 1) {
      for (let j = i + 1; j < columns.length; j += 1) {
        if (columns[i].kind === columns[j].kind) return true;
      }
    }
    return false;
  }

  function metricRowsHtml(metrics, columns, changeMode) {
    const rows = [];
    metrics.forEach((metric) => {
      const visible = metric.core || hasAnyValue(metric, columns, changeMode);
      if (!visible) return;
      const unit = changeMode ? '%' : metricUnit(metric, columns);
      const hint = metric.hint
        ? `<span class="reports-fin-hint" title="${escapeHtml(metric.hint)}">ⓘ</span>`
        : '';
      const cells = columns.map((column, index) => {
        if (changeMode) {
          const value = changeFor(metric.key, index, columns);
          const cls = value == null ? ' empty' : (value < 0 ? ' neg' : '');
          return `<td><span class="reports-fin-value${cls}">${formatChange(value)}</span></td>`;
        }
        const cell = cellForMetric(metric.key, column);
        if (!cell || cell.v == null) {
          return '<td><span class="reports-fin-value empty">—</span></td>';
        }
        const cls = cell.v < 0 ? ' neg' : '';
        return `<td><span class="reports-fin-value${cls}">${formatCell(cell.v, metric.unit, cell.u)}</span></td>`;
      }).join('');
      rows.push(`
        <tr class="reports-fin-row${metric.core ? ' reports-fin-key' : ''}">
          <td><span class="reports-fin-metric-label">${escapeHtml(metric.label)}</span>${
            unit ? `<span class="reports-fin-unit">${escapeHtml(unit)}</span>` : ''
          }${hint}</td>
          ${cells}
        </tr>`);
    });
    return rows.join('');
  }

  // Документ-источник колонки: последняя загрузка, чьи распознанные
  // периоды включают label колонки.
  function documentForColumn(columns) {
    const docs = (state.detail && state.detail.documents) || [];
    const byPeriod = new Map();
    docs.forEach((doc) => {
      (doc.period_labels || []).forEach((label) => {
        byPeriod.set(label, doc);
      });
    });
    return columns.map((column) => byPeriod.get(column.label) || null);
  }

  function financialTableHtml(columns) {
    const metrics = (state.detail && state.detail.metrics) || [];
    const changeMode = state.view === 'change';
    const docByColumn = changeMode ? [] : documentForColumn(columns);

    const periodCells = columns.map((column) => {
      const kind = KIND_LABELS[column.kind] || '';
      const title = column.full_label || column.label || '';
      return `<th title="${escapeHtml(title)}">
        <div class="reports-period-label">${escapeHtml(column.label || '')}</div>
        <div class="reports-period-kind">${escapeHtml(kind)}</div>
      </th>`;
    }).join('');

    const fileCells = columns.map((column, index) => {
      if (changeMode) return '<td class="reports-file-cell empty">—</td>';
      const doc = docByColumn[index];
      if (doc) {
        return `<td class="reports-file-cell">
          <button class="reports-file-btn" type="button" data-doc-toggle="${doc.id}"
                  title="${escapeHtml(doc.filename)}: показать распознанные таблицы">Файл</button>
        </td>`;
      }
      return `<td class="reports-file-cell">
        <button class="reports-file-btn muted" type="button" data-file-add="1"
                title="Файл за этот период не найден — загрузите PDF или ZIP">+ Файл</button>
      </td>`;
    }).join('');

    const body = metricRowsHtml(metrics, columns, changeMode);

    return `
      <div class="reports-fin-wrap">
        <table class="reports-fin-table">
          <thead>
            <tr>
              <th class="reports-fin-metric">Период</th>
              ${periodCells}
            </tr>
            <tr class="reports-fin-files">
              <th class="reports-fin-metric reports-fin-files-label">Фин. отчетность</th>
              ${fileCells}
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  function filtersHtml(columns) {
    const counts = { all: columns.length };
    columns.forEach((column) => {
      counts[column.kind] = (counts[column.kind] || 0) + 1;
    });
    return FILTERS.map((item) => {
      const count = counts[item.key] || 0;
      const active = state.filter === item.key ? ' active' : '';
      const disabled = item.key !== 'all' && !count ? ' disabled' : '';
      return `<button class="reports-filter${active}" type="button"
              data-filter="${item.key}"${disabled}>${escapeHtml(item.label)}${
        item.key === 'all' ? '' : ` · ${count}`
      }</button>`;
    }).join('');
  }

  function toolbarHtml(columns) {
    const changeDisabled = canChangeView(columns) ? '' : ' disabled';
    return `
      <div class="reports-toolbar">
        <div class="reports-filters" role="group" aria-label="Тип периода">
          ${filtersHtml(columns)}
        </div>
        <div class="reports-view-toggle" role="group" aria-label="Режим таблицы">
          <button type="button" data-view="values" class="${
            state.view === 'values' ? 'active' : ''
          }">Значения</button>
          <button type="button" data-view="change" class="${
            state.view === 'change' ? 'active' : ''
          }"${changeDisabled}>Изм. %</button>
        </div>
      </div>`;
  }

  // --- Документы компании ---------------------------------------------------

  function documentRowHtml(doc) {
    const periods = Array.isArray(doc.period_labels) && doc.period_labels.length
      ? doc.period_labels.join(', ')
      : (doc.period || 'периоды не распознаны');
    const meta = [
      periods,
      doc.column_count ? `${doc.column_count} колонок` : '',
      doc.pages ? `${doc.pages} стр.` : '',
      formatDate(doc.uploaded_at),
    ].filter(Boolean).join(' · ');
    const open = state.openDoc && state.openDoc.id === doc.id;
    const label = open ? 'Скрыть таблицы' : 'Таблицы';
    return `
      <div class="reports-doc" data-doc-id="${doc.id}">
        <div class="reports-doc-main">
          <div class="reports-doc-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</div>
          <div class="reports-doc-meta">${escapeHtml(meta)}</div>
        </div>
        <div class="reports-doc-actions">
          <button class="reports-doc-btn" type="button" data-doc-toggle="${doc.id}">${label}</button>
          <button class="reports-doc-delete" type="button" data-doc-delete="${doc.id}"
                  title="Удалить загрузку" aria-label="Удалить ${escapeHtml(doc.filename)}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </div>`;
  }

  function docViewHtml() {
    const open = state.openDoc;
    if (!open) return '';
    if (open.loading) {
      return `<div class="reports-doc-view">
        <div class="reports-loading">
          <span class="reports-spinner" aria-hidden="true"></span>
          <span>Загрузка таблиц…</span>
        </div>
      </div>`;
    }
    const doc = open.data;
    if (!doc) return '';
    const tables = Array.isArray(doc.tables) ? doc.tables : [];
    const activeIndex = Math.min(open.activeTable || 0, Math.max(tables.length - 1, 0));
    const active = tables[activeIndex];
    const tabs = tables.map((table, index) => (
      `<button class="reports-tab${index === activeIndex ? ' active' : ''}" type="button"
              role="tab" aria-selected="${index === activeIndex}"
              data-doc-table="${index}">${escapeHtml(table.title || `Таблица ${index + 1}`)}</button>`
    )).join('');
    return `
      <div class="reports-doc-view">
        <div class="reports-doc-view-head">
          <div class="reports-doc-view-title">${escapeHtml(doc.filename || '')}</div>
          <button class="reports-doc-btn" type="button" data-doc-close="1">Закрыть</button>
        </div>
        ${tables.length
          ? `<div class="reports-tabs" role="tablist">${tabs}</div>${tableHtml(active)}`
          : '<div class="reports-empty-inline">В этом файле не распознано ни одной таблицы.</div>'}
        ${notesHtml(doc.notes)}
      </div>`;
  }

  function documentsHtml(detail) {
    const docs = Array.isArray(detail.documents) ? detail.documents : [];
    const rows = docs.length
      ? docs.map(documentRowHtml).join('')
      : '<div class="reports-empty-inline">Документов пока нет. Нажмите «Загрузить файл», чтобы загрузить PDF или ZIP с отчётностью.</div>';
    return `
      <div class="reports-docs">
        <div class="reports-docs-head">
          Документы компании <span>${docs.length}</span>
        </div>
        <div class="reports-doc-list">${rows}</div>
        ${docViewHtml()}
      </div>`;
  }

  // --- Рендер главной области ----------------------------------------------

  function emptyMain(title, hint, isError) {
    return `
      <div class="reports-empty${isError ? ' error' : ''}">
        <span class="reports-empty-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V8"/><path d="M17 16v-3"/></svg>
        </span>
        <div class="reports-empty-title">${escapeHtml(title)}</div>
        <div class="reports-empty-hint">${escapeHtml(hint || '')}</div>
      </div>`;
  }

  function loadingMain(text) {
    return `
      <div class="reports-loading">
        <span class="reports-spinner" aria-hidden="true"></span>
        <span>${escapeHtml(text || 'Загрузка показателей…')}</span>
      </div>`;
  }

  function renderMain() {
    const box = byId('reports-main');
    if (!box) return;

    if (!state.selected) {
      box.innerHTML = emptyMain(
        'Выберите компанию',
        'В выпадающем списке — бумаги из watchlist. По выбранной компании появится таблица показателей.',
      );
      return;
    }
    if (state.loadingDetail) {
      box.innerHTML = loadingMain('Загрузка показателей…');
      return;
    }
    if (state.companyError) {
      box.innerHTML = emptyMain(
        'Не удалось загрузить показатели',
        state.companyError,
        true,
      );
      return;
    }
    const detail = state.detail;
    if (!detail) {
      box.innerHTML = emptyMain('Нет данных', 'Выберите компанию в выпадающем списке.');
      return;
    }

    const columns = Array.isArray(detail.columns) ? detail.columns : [];
    const docs = Array.isArray(detail.documents) ? detail.documents : [];
    const subtitleParts = [];
    if (detail.sector === 'bank') subtitleParts.push('банковский сектор');
    if (docs.length) subtitleParts.push(`документов: ${docs.length}`);
    if (columns.length) subtitleParts.push(`периодов: ${columns.length}`);
    if (!detail.ticker || detail.ticker === '__orphans__') {
      subtitleParts.push('загрузки без привязки к бумаге');
    }

    const isOrphans = detail.ticker === '__orphans__';
    // Живая капитализация с Мосбиржи (правая часть шапки компании).
    const capLine = state.market.cap
      ? `<div class="reports-company-subtitle">Капитализация: ${
          formatNumber(state.market.cap / 1e9, 1)} млрд ₽${
          state.market.updated ? ` · на ${escapeHtml(state.market.updated)}` : ''}</div>`
      : '';
    let tablePart = '';
    if (isOrphans) {
      tablePart = `<div class="reports-empty-inline">
        Эти документы были загружены до появления выбора бумаги. Исходные таблицы
        доступны ниже; чтобы собрать показатели по периодам, выберите компанию
        и загрузите отчёт ещё раз.
      </div>`;
    } else if (!columns.length) {
      tablePart = `<div class="reports-empty-inline">
        По <strong>${escapeHtml(detail.code || bareTicker(state.selected))}</strong>
        ещё нет периодов. Нажмите <strong>«Загрузить файл»</strong> и загрузите
        PDF или ZIP с отчётностью (ОПиУ, ДДС или баланс).
      </div>`;
    } else {
      const visible = filteredColumns();
      tablePart = `
        ${toolbarHtml(columns)}
        ${visible.length
          ? financialTableHtml(visible)
          : '<div class="reports-empty-inline">Нет периодов выбранного типа. Выберите другой фильтр.</div>'}`;
    }

    box.innerHTML = `
      <div class="reports-company-head">
        <div>
          <div class="reports-company-title">
            ${escapeHtml(detail.code || bareTicker(state.selected))}
            ${detail.exchange ? `<code>${escapeHtml(detail.exchange)}</code>` : ''}
          </div>
          <div class="reports-company-subtitle">${escapeHtml(subtitleParts.join(' · '))}</div>
          ${capLine}
        </div>
      </div>
      ${tablePart}
      ${documentsHtml(detail)}`;
  }

  // --- Исходные таблицы документа (как в прежней версии раздела) -----------

  function cellHtml(value) {
    const text = value == null ? '' : String(value).trim();
    if (!text || text === '-' || text === '—' || text === '–') {
      return '<td class="reports-num reports-cell-empty">—</td>';
    }
    // Отрицательные значения в отчётности — в скобках, выделяем цветом.
    const negative = /^\(.*\)$/.test(text) || /^[-−–]/.test(text);
    return `<td class="reports-num${negative ? ' reports-neg' : ''}">${escapeHtml(text)}</td>`;
  }

  function tableHtml(table) {
    if (!table) return '';
    const columns = Array.isArray(table.columns) ? table.columns : ['Показатель'];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const head = columns.map((column, index) => (
      index === 0
        ? `<th class="reports-col-label">${escapeHtml(column)}</th>`
        : `<th class="reports-num">${escapeHtml(column)}</th>`
    )).join('');

    const body = rows.map((row) => {
      if (row.section || !Array.isArray(row.cells) || row.cells.length === 0) {
        return `<tr class="reports-row-section"><td colspan="${columns.length}">${escapeHtml(row.label)}</td></tr>`;
      }
      const indent = Math.max(0, Math.min(5, Number(row.indent) || 0));
      const labelStyle = indent ? ` style="padding-left:${10 + indent * 16}px"` : '';
      const labelClass = row.bold ? ' reports-cell-bold' : '';
      const cells = columns.slice(1).map((_column, index) => cellHtml(row.cells[index])).join('');
      return `<tr class="reports-row${row.bold ? ' reports-row-bold' : ''}">`
        + `<td class="reports-cell-label${labelClass}"${labelStyle}>${escapeHtml(row.label)}</td>`
        + cells
        + '</tr>';
    }).join('');

    const pages = Array.isArray(table.pages) && table.pages.length
      ? table.pages
      : (table.page ? [table.page] : []);
    const pageLabel = pages.length > 1
      ? `Стр. ${pages[0]}–${pages[pages.length - 1]}`
      : (pages.length ? `Стр. ${pages[0]}` : '');
    const meta = [pageLabel, table.units].filter(Boolean).join(' · ');
    const ocrBadge = table.ocr
      ? '<span class="reports-ocr-badge" title="Распознано OCR — проверяйте числа по исходному PDF">OCR</span>'
      : '';

    return `
      <div class="reports-panel">
        <div class="reports-panel-head">
          <div class="reports-raw-title">${escapeHtml(table.raw_title || table.title || '')}</div>
          <div class="reports-panel-meta">${ocrBadge}${escapeHtml(meta)}</div>
        </div>
        <div class="reports-table-wrap">
          <table class="reports-table">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
  }

  function notesHtml(notes) {
    if (!Array.isArray(notes) || !notes.length) return '';
    const items = notes.map((note) => {
      const page = note.page ? ` <span class="reports-note-page">стр. ${note.page}</span>` : '';
      return `<li><strong>${escapeHtml(note.title || 'Таблица')}</strong>${page} — ${escapeHtml(note.reason || 'не распознана')}</li>`;
    }).join('');
    return `
      <div class="reports-notes">
        <div class="reports-notes-title">
          <span aria-hidden="true">⚠</span> Не всё удалось распознать
        </div>
        <ul>${items}</ul>
      </div>`;
  }

  // --- Загрузка колонки -----------------------------------------------------

  function updateAddButton() {
    const button = byId('reports-add-column');
    const input = byId('reports-file-input');
    if (!button) return;
    const allowed = Boolean(state.selected)
      && state.selected !== '__orphans__'
      && !state.uploading;
    button.disabled = !allowed;
    const label = button.querySelector('span');
    if (label) label.textContent = state.uploading ? 'Распознаём…' : 'Загрузить файл';
    if (input) input.disabled = state.uploading;
  }

  async function uploadFile(file) {
    if (state.uploading) return;
    if (!state.selected || state.selected === '__orphans__') {
      window.showToast && window.showToast('Сначала выберите бумагу', 'error');
      return;
    }
    if (!file) return;

    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.pdf') && !name.endsWith('.zip')) {
      window.showToast && window.showToast('Поддерживаются только PDF и ZIP', 'error');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      window.showToast && window.showToast('Файл больше 30 МБ', 'error');
      return;
    }

    state.uploading = true;
    updateAddButton();
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('ticker', state.selected);
      const report = await requestJson(
        `${API}/api/reports/upload`,
        { method: 'POST', body: form },
        240000,  // разбор PDF и OCR сканов на бэкенде занимают десятки секунд
      );
      const count = Array.isArray(report && report.columns) ? report.columns.length : 0;
      window.showToast && window.showToast(
        count
          ? `Добавлено периодов: ${count}`
          : 'Документ распознан, но периоды не найдены',
        count ? 'success' : 'info',
        6000,
      );
      await refreshAll();
    } catch (err) {
      window.showToast && window.showToast(
        'Не удалось распознать файл: ' + err.message, 'error', 9000,
      );
    } finally {
      state.uploading = false;
      updateAddButton();
      const input = byId('reports-file-input');
      if (input) input.value = '';
    }
  }

  async function deleteDocument(id, filename) {
    if (!window.confirm(`Удалить «${filename}» из отчётов компании?`)) return;
    try {
      await requestJson(`${API}/api/reports/${id}`, { method: 'DELETE' }, 15000);
      if (state.openDoc && state.openDoc.id === id) state.openDoc = null;
      window.showToast && window.showToast('Загрузка удалена', 'info');
      await refreshAll();
    } catch (err) {
      window.showToast && window.showToast(
        'Не удалось удалить загрузку: ' + err.message, 'error',
      );
    }
  }

  async function toggleDocument(id) {
    if (state.openDoc && state.openDoc.id === id) {
      state.openDoc = null;
      renderMain();
      return;
    }
    state.openDoc = { id: id, loading: true, data: null, activeTable: 0 };
    renderMain();
    try {
      const data = await requestJson(`${API}/api/reports/${id}`, {}, 20000);
      if (!state.openDoc || state.openDoc.id !== id) return;
      state.openDoc = { id: id, loading: false, data: data, activeTable: 0 };
      renderMain();
    } catch (err) {
      state.openDoc = null;
      renderMain();
      window.showToast && window.showToast(
        'Не удалось открыть таблицы: ' + err.message, 'error',
      );
    }
  }

  // --- События --------------------------------------------------------------

  function bindHandlers() {
    if (state.bound) return;
    state.bound = true;

    // Real-time капитализация: пока открыт раздел «Отчетность», тянем
    // /api/prices выбранной бумаги на том же цикле, что и watchlist
    // (AUTO_REFRESH_INTERVAL из js/state.js, fallback 15 c).
    const refreshMs = (typeof window.AUTO_REFRESH_INTERVAL === 'number')
      ? window.AUTO_REFRESH_INTERVAL : 15000;
    setInterval(() => {
      if (sessionStorage.getItem('activePage') !== 'reports') return;
      if (!state.selected || state.selected === '__orphans__') return;
      loadMarketCap();
    }, refreshMs);

    const select = byId('reports-company-select');
    const input = byId('reports-file-input');
    const addButton = byId('reports-add-column');
    const refreshButton = byId('reports-refresh');
    const main = byId('reports-main');

    if (select) {
      select.addEventListener('change', () => {
        const ticker = select.value || '';
        if (ticker && ticker !== state.selected) selectCompany(ticker);
      });
    }

    if (input) {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) uploadFile(file);
      });
    }
    if (addButton) {
      addButton.addEventListener('click', () => {
        if (addButton.disabled) return;
        if (input) input.click();
      });
    }

    if (refreshButton) {
      refreshButton.addEventListener('click', async () => {
        refreshButton.classList.add('loading');
        try {
          await refreshAll();
        } finally {
          refreshButton.classList.remove('loading');
        }
      });
    }

    if (main) {
      main.addEventListener('click', (event) => {
        const filter = event.target.closest('[data-filter]');
        if (filter) {
          const key = filter.getAttribute('data-filter');
          if (key && key !== state.filter) {
            state.filter = key;
            if (state.view === 'change' && !canChangeView(filteredColumns())) {
              state.view = 'values';
            }
            renderMain();
          }
          return;
        }
        const view = event.target.closest('[data-view]');
        if (view) {
          const key = view.getAttribute('data-view');
          if (key && key !== state.view) {
            state.view = key;
            renderMain();
          }
          return;
        }
        if (event.target.closest('[data-file-add]')) {
          if (input && !input.disabled) input.click();
          return;
        }
        const docTab = event.target.closest('[data-doc-table]');
        if (docTab && state.openDoc) {
          const index = Number(docTab.getAttribute('data-doc-table'));
          if (Number.isFinite(index)) {
            state.openDoc.activeTable = index;
            renderMain();
          }
          return;
        }
        const toggle = event.target.closest('[data-doc-toggle]');
        if (toggle) {
          toggleDocument(Number(toggle.getAttribute('data-doc-toggle')));
          return;
        }
        const remove = event.target.closest('[data-doc-delete]');
        if (remove) {
          const id = Number(remove.getAttribute('data-doc-delete'));
          const doc = state.detail && (state.detail.documents || [])
            .find((item) => item.id === id);
          deleteDocument(id, doc ? doc.filename : 'документ');
          return;
        }
        if (event.target.closest('[data-doc-close]')) {
          state.openDoc = null;
          renderMain();
        }
      });
    }
  }

  // --- Точка входа ---------------------------------------------------------

  // Тикер, который нужно открыть при следующем входе в раздел. Ставится
  // «Перейти в отчетность …» из контекстного меню watchlist (js/ui.js),
  // снимается в loadReportsPage: переход одноразовый, обычное открытие
  // раздела из меню навигации остаётся с сохранённым выбором компании.
  let pendingTicker = '';

  window.openReportsForTicker = function (symbol) {
    const ticker = String(symbol || '').trim().toUpperCase();
    if (!ticker) return;
    pendingTicker = ticker;
    if (typeof window.navigateTo === 'function') {
      window.navigateTo('reports');
    } else {
      loadReportsPage();
    }
  };

  window.loadReportsPage = async function () {
    bindHandlers();
    // Повторный вход в раздел: список перечитываем (загрузки могли появиться
    // с другого устройства), выбранную бумагу сохраняем.
    await loadCompanies();
    // Переход из watchlist: открываем отчетность запрошенного тикера.
    // Тикер из списка мог исчезнуть (удалили из watchlist между кликом и
    // открытием) или не поддерживаться (индекс) — тогда раздел открывается
    // как обычно, без выбора.
    const pending = pendingTicker;
    pendingTicker = '';
    if (pending) {
      const candidates = pending.indexOf('MOEX:') === 0
        ? [pending]
        : [pending, `MOEX:${pending}`];
      const entry = state.companies.find((item) => candidates.indexOf(item.ticker) >= 0);
      if (entry) {
        await selectCompany(entry.ticker);
        return;
      }
      window.showToast && window.showToast(
        `Отчетность по ${pending} недоступна — бумага не в списке раздела`, 'info',
      );
    }
    const saved = savedCompany();
    const exists = saved && state.companies.some((item) => item.ticker === saved);
    if (exists) {
      await selectCompany(saved);
      return;
    }
    // Без сохранённого выбора открываем бумагу, по которой уже есть
    // отчёты, — иначе раздел выглядел бы пустым при наличии данных.
    const first = state.companies.find((item) => item.periods > 0 || item.documents > 0)
      || state.companies.find((item) => item.in_watchlist)
      || state.companies[0];
    if (first) {
      await selectCompany(first.ticker);
    } else {
      state.selected = '';
      state.detail = null;
      rememberCompany(null);
      updateAddButton();
      renderMain();
    }
  };

  // Для отладки/автотестов — та же функция, что у кнопки загрузки.
  window.uploadReportFile = uploadFile;
  // Чистые функции форматирования — для фронтенд-тестов.
  window.reportsFormatCell = formatCell;
  window.reportsFormatChange = formatChange;
  window.reportsChangeFor = changeFor;
  window.reportsCanChangeView = canChangeView;
  // Мультипликатор по текущей капитализации (pe/pb/ev_ebitda/ps) — для тестов.
  window.reportsMarketCell = marketCell;
  // Резолвер ячейки (отчёт → живая капитализация) и сеттер капитализации —
  // для тестов строки «Капитализация».
  window.reportsCellForMetric = cellForMetric;
  window.reportsSetMarketCap = (cap, updated) => {
    state.market = { cap: cap || null, updated: updated || '' };
  };
})();
