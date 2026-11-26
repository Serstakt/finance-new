// === ОТЧЁТНОСТЬ — БУХГАЛТЕРСКАЯ (ФИНАНСОВАЯ) ОТЧЁТНОСТЬ ИЗ PDF/ZIP ===
//
// Раздел справа от FUTOI в верхнем меню. Пользователь сам загружает файл
// (PDF или ZIP с PDF) — скачивать с e-disclosure ничего не нужно. Бэкенд
// (services/reports_service.py) находит в документе таблицы отчётности,
// распознаёт колонки по геометрии чисел и сохраняет результат в SQLite;
// здесь — drag&drop, история загрузок и таблицы на вкладках.
//
// API:
//   POST   /api/reports/upload  (multipart file) -> отчёт с таблицами
//   GET    /api/reports                          -> история загрузок
//   GET    /api/reports/{id}                     -> таблицы одного отчёта
//   DELETE /api/reports/{id}                     -> удалить загрузку
//
// Рендер в духе остального vanilla-JS проекта (ср. js/futoi.js): без
// фреймворков, разметка собирается строками, все тексты экранируются.

(function () {
  'use strict';

  const API = (typeof window !== 'undefined' && window.API_BASE) || '';
  const STORAGE_SELECTED = 'reports_selected_id';
  const MAX_FILE_SIZE = 30 * 1024 * 1024;

  const state = {
    reports: [],
    current: null,
    activeTable: 0,
    // Флаги, чтобы повторный вход в раздел не сбивал открытый отчёт и
    // не запускал параллельные загрузки.
    loadingList: false,
    loadingDetail: false,
    uploading: false,
    bound: false,
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

  // --- Данные --------------------------------------------------------------

  function savedSelection() {
    const raw = sessionStorage.getItem(STORAGE_SELECTED);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function rememberSelection(id) {
    if (id) sessionStorage.setItem(STORAGE_SELECTED, String(id));
    else sessionStorage.removeItem(STORAGE_SELECTED);
  }

  async function loadList(preferredId) {
    if (state.loadingList) return;
    state.loadingList = true;
    try {
      const data = await requestJson(`${API}/api/reports`, {}, 15000);
      state.reports = (data && data.reports) || [];
      renderHistory();

      const wanted = preferredId || (state.current && state.current.id) || savedSelection();
      let target = state.reports.find((item) => item.id === wanted);
      if (!target && state.reports.length) target = state.reports[0];

      if (!target) {
        state.current = null;
        rememberSelection(null);
        renderView();
        return;
      }
      await loadDetail(target.id);
    } catch (err) {
      state.reports = [];
      renderHistory();
      renderEmpty('Не удалось загрузить историю', err.message, true);
    } finally {
      state.loadingList = false;
    }
  }

  async function loadDetail(id) {
    if (!id) return;
    state.loadingDetail = true;
    if (!state.current || state.current.id !== id) {
      renderView();
    }
    try {
      const report = await requestJson(`${API}/api/reports/${id}`, {}, 20000);
      if (!report || !Array.isArray(report.tables)) {
        throw new Error('Сервер вернул некорректный отчёт');
      }
      const sameReport = state.current && state.current.id === report.id;
      state.current = report;
      if (!sameReport) state.activeTable = 0;
      if (state.activeTable >= report.tables.length) state.activeTable = 0;
      rememberSelection(report.id);
      renderHistory();
      renderView();
    } catch (err) {
      state.current = null;
      rememberSelection(null);
      renderEmpty('Не удалось открыть отчёт', err.message, true);
    } finally {
      state.loadingDetail = false;
    }
  }

  async function deleteReport(id, filename) {
    if (!window.confirm(`Удалить «${filename}» из истории загрузок?`)) return;
    try {
      await requestJson(`${API}/api/reports/${id}`, { method: 'DELETE' }, 15000);
      if (state.current && state.current.id === id) {
        state.current = null;
        rememberSelection(null);
      }
      window.showToast && window.showToast('Отчёт удалён', 'info');
      await loadList();
    } catch (err) {
      window.showToast && window.showToast('Не удалось удалить отчёт: ' + err.message, 'error');
    }
  }

  // --- Загрузка файла ------------------------------------------------------

  function setUploading(active) {
    state.uploading = active;
    const zone = byId('reports-dropzone');
    const title = byId('reports-drop-title');
    const hint = byId('reports-drop-hint');
    const button = byId('reports-upload-btn');
    const input = byId('reports-file-input');

    if (zone) zone.classList.toggle('uploading', active);
    if (title) title.textContent = active
      ? 'Распознаём таблицы…'
      : 'Перетащите сюда PDF или ZIP с отчётностью';
    if (hint) hint.textContent = active
      ? 'Обычно это занимает несколько секунд'
      : 'или нажмите, чтобы выбрать файл · до 30 МБ';
    if (button) button.disabled = active;
    if (input) input.disabled = active;
  }

  async function uploadFile(file) {
    if (state.uploading) return;
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

    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const report = await requestJson(
        `${API}/api/reports/upload`,
        { method: 'POST', body: form },
        240000,  // разбор PDF и OCR сканов на бэкенде занимают десятки секунд
      );
      const count = (report && report.tables ? report.tables.length : 0);
      window.showToast && window.showToast(
        `Распознано таблиц: ${count}`, 'success',
      );
      await loadList(report && report.id);
    } catch (err) {
      window.showToast && window.showToast(
        'Не удалось распознать файл: ' + err.message, 'error', 9000,
      );
      if (!state.current) {
        renderEmpty('Файл не распознан', err.message, true);
      }
    } finally {
      setUploading(false);
      const input = byId('reports-file-input');
      if (input) input.value = '';
    }
  }

  // --- Рендер истории ------------------------------------------------------

  function renderHistory() {
    const box = byId('reports-history');
    if (!box) return;

    if (!state.reports.length) {
      box.innerHTML = '<div class="reports-history-empty">Пока пусто</div>';
      return;
    }

    const currentId = state.current ? state.current.id : null;
    box.innerHTML = state.reports.map((report) => {
      const active = report.id === currentId ? ' active' : '';
      const period = report.period || 'Периоды не распознаны';
      const meta = [
        period,
        report.pages ? `${report.pages} стр.` : '',
        formatDate(report.uploaded_at),
      ].filter(Boolean).join(' · ');
      return `
        <div class="reports-history-item${active}" data-report-id="${report.id}" role="button" tabindex="0"
             title="${escapeHtml(report.filename)}">
          <div class="reports-history-main">
            <div class="reports-history-name">${escapeHtml(report.filename)}</div>
            <div class="reports-history-meta">${escapeHtml(meta)}</div>
          </div>
          <button class="reports-history-delete" type="button" data-delete-id="${report.id}"
                  title="Удалить из истории" aria-label="Удалить ${escapeHtml(report.filename)}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>`;
    }).join('');
  }

  // --- Рендер отчёта -------------------------------------------------------

  function renderEmpty(title, hint, isError) {
    const view = byId('reports-view');
    if (!view) return;
    const titleText = title || 'Отчётность ещё не загружена';
    const hintText = hint || 'Перетащите PDF или ZIP с отчётностью в зону выше — таблицы появятся здесь.';
    view.innerHTML = `
      <div class="reports-empty${isError ? ' error' : ''}">
        <span class="reports-empty-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V8"/><path d="M17 16v-3"/></svg>
        </span>
        <div class="reports-empty-title">${escapeHtml(titleText)}</div>
        <div class="reports-empty-hint">${escapeHtml(hintText)}</div>
      </div>`;
  }

  function renderLoading(text) {
    const view = byId('reports-view');
    if (!view) return;
    view.innerHTML = `
      <div class="reports-loading">
        <span class="reports-spinner" aria-hidden="true"></span>
        <span>${escapeHtml(text || 'Загрузка отчёта…')}</span>
      </div>`;
  }

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

  function renderView() {
    const view = byId('reports-view');
    if (!view) return;

    if (state.loadingDetail && !state.current) {
      renderLoading('Загрузка отчёта…');
      return;
    }
    if (!state.current) {
      if (state.reports.length) {
        renderLoading('Выберите отчёт в истории загрузок');
      } else {
        renderEmpty('Отчётность ещё не загружена');
      }
      return;
    }

    const report = state.current;
    const tables = Array.isArray(report.tables) ? report.tables : [];
    if (!tables.length) {
      renderEmpty('В отчёте нет распознанных таблиц', 'Попробуйте загрузить другой файл.');
      return;
    }

    const meta = [
      report.period || '',
      report.pages ? `${report.pages} стр.` : '',
      formatDate(report.uploaded_at),
    ].filter(Boolean).join(' · ');

    const tabs = tables.map((table, index) => (
      `<button class="reports-tab${index === state.activeTable ? ' active' : ''}" type="button"
              role="tab" aria-selected="${index === state.activeTable}"
              data-table-index="${index}">${escapeHtml(table.title || `Таблица ${index + 1}`)}</button>`
    )).join('');

    const active = tables[state.activeTable] || tables[0];
    view.innerHTML = `
      <div class="reports-doc-head">
        <div class="reports-doc-name">${escapeHtml(report.filename)}</div>
        <div class="reports-doc-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="reports-tabs" role="tablist" aria-label="Таблицы отчёта">${tabs}</div>
      ${tableHtml(active)}
      ${notesHtml(report.notes)}`;
  }

  // --- События -------------------------------------------------------------

  function bindHandlers() {
    if (state.bound) return;
    state.bound = true;

    const input = byId('reports-file-input');
    const zone = byId('reports-dropzone');
    const uploadBtn = byId('reports-upload-btn');
    const refreshBtn = byId('reports-refresh');
    const history = byId('reports-history');
    const view = byId('reports-view');

    function openPicker() {
      if (state.uploading) return;
      if (input) input.click();
    }

    if (input) {
      // Программный input.click() всплывает до зоны — без остановки
      // получилась бы рекурсия «зона → input → зона → input…».
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) uploadFile(file);
      });
    }
    if (uploadBtn) uploadBtn.addEventListener('click', openPicker);
    if (zone) {
      zone.addEventListener('click', openPicker);
      zone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPicker();
        }
      });
      ['dragenter', 'dragover'].forEach((name) => {
        zone.addEventListener(name, (event) => {
          event.preventDefault();
          zone.classList.add('drag-over');
        });
      });
      ['dragleave', 'dragend'].forEach((name) => {
        zone.addEventListener(name, () => zone.classList.remove('drag-over'));
      });
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('drag-over');
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) uploadFile(file);
      });
    }
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('loading');
        try {
          await loadList();
        } finally {
          refreshBtn.classList.remove('loading');
        }
      });
    }
    if (history) {
      history.addEventListener('click', (event) => {
        const deleteButton = event.target.closest('[data-delete-id]');
        if (deleteButton) {
          event.stopPropagation();
          const id = Number(deleteButton.getAttribute('data-delete-id'));
          const report = state.reports.find((item) => item.id === id);
          deleteReport(id, report ? report.filename : 'отчёт');
          return;
        }
        const item = event.target.closest('[data-report-id]');
        if (item) {
          const id = Number(item.getAttribute('data-report-id'));
          if (id && (!state.current || state.current.id !== id)) loadDetail(id);
        }
      });
      history.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const item = event.target.closest('[data-report-id]');
        if (!item) return;
        event.preventDefault();
        const id = Number(item.getAttribute('data-report-id'));
        if (id) loadDetail(id);
      });
    }
    if (view) {
      view.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-table-index]');
        if (!tab) return;
        const index = Number(tab.getAttribute('data-table-index'));
        if (!Number.isFinite(index) || index === state.activeTable) return;
        state.activeTable = index;
        renderView();
      });
    }
  }

  // --- Точка входа ---------------------------------------------------------

  window.loadReportsPage = function () {
    bindHandlers();
    // Повторный вход в раздел: список всё равно перечитываем (загрузки
    // могли появиться с другого устройства), открытый отчёт сохраняем.
    loadList();
  };

  // Для отладки/автотестов — та же функция, что у кнопки загрузки.
  window.uploadReportFile = uploadFile;
})();
