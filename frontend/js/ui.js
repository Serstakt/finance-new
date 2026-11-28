window.formatNumber = function(num, decimals = 2) {
  if (num === null || num === undefined) return '—';
  return num.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

// === АДАПТИВНАЯ ТОЧНОСТЬ ЦЕНЫ (как в TradingView) ===
// Раньше цены писались жёстко с 2 знаками: дешёвая крипта (SHIB ~0.0000154,
// XRP в сатоши) показывалась «0,00». Число знаков подстраивается под
// величину инструмента:
//   >= 1000 — 2 знака (BTC, индексы, дорогие акции);
//   1..1000 — 2..4 знака (акции MOEX дают 2, валютные котировки CETS — 4);
//   < 1 — 4 значащих цифры, не меньше 4 и не больше 10 знаков
//   (SHIB 0.00001541 → 8, PEPE 0.0000055 → 9 — как в TradingView).
const countDecimalsOf = (n) => {
  const s = String(Math.abs(n));
  // Малые числа JS печатает экспонентой («1.54e-7» → 5 порядков + 2 разряда мантиссы)
  if (s.includes('e-')) {
    const [mantissa, exp] = s.split('e-');
    const mantissaDecimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    return Number(exp) + mantissaDecimals;
  }
  return s.includes('.') ? s.split('.')[1].length : 0;
};

window.autoPriceDecimals = function(num) {
  const n = Math.abs(Number(num));
  if (!Number.isFinite(n) || n === 0) return 2;
  if (n >= 1000) return 2;
  if (n >= 1) return Math.min(Math.max(countDecimalsOf(n), 2), 4);
  // < 1: первая ненулевая цифра + ещё 3 значащих
  const d = Math.ceil(-Math.log10(n)) + 3;
  return Math.min(Math.max(d, 4), 10);
};

// Цена с адаптивной точностью и ru-форматом (запятая, разделители разрядов).
window.formatPriceAuto = function(num) {
  if (num === null || num === undefined) return '—';
  const n = Number(num);
  if (!Number.isFinite(n)) return '—';
  const d = window.autoPriceDecimals(n);
  return n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
};

window.formatChange = function(change, isPercent = true) {
  if (change === null || change === undefined) return '<span class="loading">—</span>';
  const sign = change >= 0 ? '+' : '';
  // Абсолютная дельта — с той же адаптивной точностью, что и цена: у SHIB
  // изменение ~0.0000001 при фиксированных 4 знаках печаталось «0,0000».
  const decimals = isPercent ? 2 : window.autoPriceDecimals(change);
  const formatted = isPercent ? formatNumber(change, decimals) + '%' : formatNumber(change, decimals);
  return `<span>${sign}${formatted}</span>`;
};

// Экранирование для безопасной вставки пользовательских строк (заметки,
// названия разделов) в HTML-шаблоны innerHTML.
window.escapeHtml = function(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
};

window.sortList = function(list, dataMap) {
  if (!currentSort.field) return list;
  const blocks = [];
  let currentBlock = { section: null, tickers: [] };
  for (const sym of list) {
    if (sym.startsWith('SECTION:')) {
      if (currentBlock.tickers.length > 0 || currentBlock.section !== null) blocks.push(currentBlock);
      currentBlock = { section: sym, tickers: [] };
    } else {
      currentBlock.tickers.push(sym);
    }
  }
  if (currentBlock.tickers.length > 0 || currentBlock.section !== null) blocks.push(currentBlock);

  const sortedBlocks = blocks.map(block => {
    const sortedTickers = [...block.tickers].sort((a, b) => {
      const dataA = dataMap[a], dataB = dataMap[b];
      let valA, valB;
      switch (currentSort.field) {
        case 'ticker': valA = a; valB = b; break;
        case 'price': valA = dataA?.price ?? -Infinity; valB = dataB?.price ?? -Infinity; break;
        case 'change': valA = dataA?.changeValue ?? -Infinity; valB = dataB?.changeValue ?? -Infinity; break;
        case 'changePct': valA = dataA?.changeDay ?? -Infinity; valB = dataB?.changeDay ?? -Infinity; break;
      }
      if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
      if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return { section: block.section, tickers: sortedTickers };
  });

  const result = [];
  for (const block of sortedBlocks) {
    if (block.section) result.push(block.section);
    result.push(...block.tickers);
  }
  return result;
};

// Сброс/установка подсветки заголовков сортировки. Единая точка для всех
// мест (switchList, импорт бэкапа, drag&drop, клик по заголовку): после
// перехода на SVG-стрелки нельзя писать sortIcon.textContent = '↕' —
// у .col-empty заглушек span.sort-icon вовсе нет, и такой код падал с
// TypeError: Cannot set properties of null.
window.resetSortHeaders = function(field, direction) {
  document.querySelectorAll('.column-header').forEach(h => {
    h.classList.remove('active');
    delete h.dataset.dir;
  });
  if (!field) return;
  const header = document.querySelector(`.column-header[data-sort="${field}"]`);
  if (header) {
    header.classList.add('active');
    header.dataset.dir = direction || 'asc';
  }
};

window.setupColumnHeaders = function() {
  document.querySelectorAll('.column-header').forEach(header => {
    header.addEventListener('click', () => {
      const field = header.dataset.sort;
      if (!field) return; // пустые grid-заглушки над служебными колонками не кликабельны
      if (currentSort.field === field) currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      else { currentSort.field = field; currentSort.direction = 'asc'; }

      // Стрелки ↑/↓ — SVG-иконки из разметки; направление задаёт общий
      // resetSortHeaders (data-dir), видимость — CSS (.sort-icon-dir-up/down).
      resetSortHeaders(currentSort.field, currentSort.direction);
      // Запоминаем выбор в localStorage: после F5 список остаётся
      // отсортированным по той же колонке (loadSortState в state.js).
      if (typeof saveSortState === 'function') saveSortState();
      render();
      log(`Сортировка: ${field} (${currentSort.direction === 'asc' ? 'по возрастанию' : 'по убыванию'})`, 'info');
    });
  });
};

// === КОНТЕКСТНОЕ МЕНЮ СТРОКИ/РАЗДЕЛА WATCHLIST ===
// Заменяет однокликовое удаление «×»: деструктивные действия вынесены в меню
// «⋯» (открывается по клику или правому клику на строке), с подписями пунктов.
window.closeWlContextMenu = function() {
  document.querySelectorAll('.wl-context-menu').forEach(m => m.remove());
};

window.openWlContextMenu = function(anchorEl, x, y, items) {
  closeWlContextMenu();
  const menu = document.createElement('div');
  menu.className = 'wl-context-menu';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = it.label;
    if (it.danger) btn.classList.add('danger');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeWlContextMenu();
      it.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  // прижимаем меню к viewport, чтобы оно нелезло за край экрана
  const rect = menu.getBoundingClientRect();
  const px = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const py = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
};

// закрытие меню по клику вне / Escape — один раз на документ
document.addEventListener('click', () => closeWlContextMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWlContextMenu(); });

// === НИЖНЯЯ ПАНЕЛЬ (под графиком): левая колонка «Новости / Заметки», ===
// === правая колонка «Алерты» (всегда видима)                            ===
// Заметки — вторая вкладка ЛЕВОЙ колонки (переключение switchBottomTab);
// «Алерты» живут в правой колонке (switchRightTab) и не перекрываются
// вкладками. Активная вкладка левой колонки запоминается в sessionStorage
// ('bottomTab'), чтобы переключение не сбрасывалось при перерисовке списка.

// --- Санитайзер HTML заметок ---
// Единый whitelist: ровно то, что умеет генерировать Quill 2 с нашим
// тулбаром (заголовки, инлайн-форматы, списки, цитаты, код, ссылки, цвет).
// Quill пишет выравнивание/отступы классами ql-*, цвет — inline-style,
// списки — <ol><li data-list="bullet|ordered">. Всё остальное (скрипты,
// iframe, обработчики, произвольные классы/стили) вырезается.
// Основной санитайзер — DOMPurify (CDN); если он недоступен, работает
// эквивалентный DOM-фильтр ниже.
const NOTES_ALLOWED_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'FONT', 'BR', 'DIV', 'P',
  'UL', 'OL', 'LI', 'SPAN', 'BLOCKQUOTE', 'PRE', 'CODE', 'H1', 'H2', 'H3', 'A',
]);
const NOTES_ALLOWED_ATTRS = {
  A: ['href', 'target', 'rel'],
  LI: ['class', 'data-list'],
  OL: ['class'],
  UL: ['class'],
  DIV: ['class'],
  P: ['class'],
  H1: ['class'],
  H2: ['class'],
  H3: ['class'],
  BLOCKQUOTE: ['class'],
  PRE: ['class'],
  CODE: ['class'],
  SPAN: ['class', 'style'],
  FONT: ['color', 'size', 'face'],
};
// Классы форматирования Quill (UI-классы ql-ui/ql-cursor сюда не входят)
const NOTES_ALLOWED_CLASS_RE = /^(?:ql-align-(?:center|right|justify)|ql-indent-[1-8]|ql-direction-rtl|ql-size-(?:small|large|huge)|ql-syntax)$/;
const NOTES_ALLOWED_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'font-family', 'font-size']);

function notesFilterClasses(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(cls => NOTES_ALLOWED_CLASS_RE.test(cls))
    .join(' ');
}

function notesFilterStyle(value) {
  return String(value || '')
    .split(';')
    .map(decl => decl.trim())
    .filter(Boolean)
    .filter(decl => {
      const sep = decl.indexOf(':');
      if (sep <= 0) return false;
      const prop = decl.slice(0, sep).trim().toLowerCase();
      const val = decl.slice(sep + 1).trim();
      if (!NOTES_ALLOWED_STYLE_PROPS.has(prop)) return false;
      // никаких url()/expression()/javascript: в значениях стилей
      return !/url\s*\(|expression\s*\(|javascript:/i.test(val);
    })
    .join('; ');
}

function notesIsSafeHref(value) {
  return /^(?:https?:|mailto:|tel:)/i.test(String(value || '').trim());
}

const NOTES_LIST_VALUES_RE = /^(?:bullet|ordered|checked|unchecked)$/;

// Резервный DOM-санитайзер (если DOMPurify не загрузился с CDN).
function notesSanitizeFallback(html) {
  const doc = (typeof DOMParser !== 'undefined')
    ? new DOMParser().parseFromString(String(html || ''), 'text/html')
    : null;
  if (!doc || !doc.body) return escapeHtml(String(html || ''));
  const cleanNode = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) continue; // текст
      if (child.nodeType !== 1) { node.removeChild(child); continue; }
      const tag = String(child.tagName || '').toUpperCase();
      if (!NOTES_ALLOWED_TAGS.has(tag)) {
        // неразрешённый тег — оставляем только его текст
        node.replaceChild(doc.createTextNode(child.textContent || ''), child);
        continue;
      }
      const allowed = NOTES_ALLOWED_ATTRS[tag] || [];
      for (const attr of Array.from(child.attributes || [])) {
        const name = String(attr.name).toLowerCase();
        if (!allowed.includes(name)) { child.removeAttribute(attr.name); continue; }
        if (name === 'class') {
          const cls = notesFilterClasses(attr.value);
          if (cls) child.setAttribute('class', cls); else child.removeAttribute('class');
        } else if (name === 'style') {
          const style = notesFilterStyle(attr.value);
          if (style) child.setAttribute('style', style); else child.removeAttribute('style');
        } else if (name === 'data-list' && !NOTES_LIST_VALUES_RE.test(attr.value)) {
          child.removeAttribute(name);
        } else if (name === 'href' && !notesIsSafeHref(attr.value)) {
          child.removeAttribute(name);
        }
      }
      if (tag === 'A') {
        if (!child.getAttribute('href')) {
          node.replaceChild(doc.createTextNode(child.textContent || ''), child);
          continue;
        }
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'SPAN' && !child.attributes.length) {
        // пустые span (например, служебный span.ql-ui) в разметке не нужны
        node.replaceChild(doc.createTextNode(child.textContent || ''), child);
        continue;
      }
      cleanNode(child);
    }
  };
  cleanNode(doc.body);
  return doc.body.innerHTML;
}

window.notesSanitize = function(html) {
  const src = String(html ?? '');
  if (!src) return '';
  const dp = window.DOMPurify;
  if (dp && typeof dp.sanitize === 'function') {
    try {
      if (!window.__notesPurifyHooked) {
        window.__notesPurifyHooked = true;
        dp.addHook('uponSanitizeAttribute', (node, data) => {
          const name = String(data.attrName || '').toLowerCase();
          if (name === 'class') {
            const cls = notesFilterClasses(data.attrValue);
            if (cls) data.attrValue = cls; else data.keepAttr = false;
          } else if (name === 'style') {
            const style = notesFilterStyle(data.attrValue);
            if (style) data.attrValue = style; else data.keepAttr = false;
          } else if (name === 'href') {
            if (!notesIsSafeHref(data.attrValue)) data.keepAttr = false;
          } else if (name === 'data-list') {
            if (!NOTES_LIST_VALUES_RE.test(String(data.attrValue || ''))) data.keepAttr = false;
          } else if (name === 'target') {
            if (data.attrValue !== '_blank') data.keepAttr = false;
          } else if (name === 'rel') {
            data.attrValue = 'noopener noreferrer';
          }
        });
        dp.addHook('afterSanitizeAttributes', (node) => {
          if (node.tagName === 'A' && node.getAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        });
      }
      return dp.sanitize(src, {
        ALLOWED_TAGS: Array.from(NOTES_ALLOWED_TAGS, t => t.toLowerCase()),
        ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style', 'data-list', 'color', 'size', 'face'],
        ALLOW_DATA_ATTR: true, // произвольные data-* снимает хук выше
        ALLOW_ARIA_ATTR: false,
        KEEP_CONTENT: true,
      });
    } catch (e) {
      // повреждённый/слишком сложный HTML — уходим в резервный фильтр
    }
  }
  return notesSanitizeFallback(src);
};

// --- Доступ к экземпляру Quill ---
// Контейнер обязан оставаться #notes-editor: тесты и старые вызовы передают
// этот элемент в getNotesSerialize(editor).
function getNotesQuill() {
  const q = window.__notesQuill;
  const editor = document.getElementById('notes-editor');
  if (!q || !editor || q.container !== editor) return null;
  return q;
}

function notesQuillPlain(quill) {
  return String(quill.getText() || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function notesDomPlain(editor) {
  return String(editor.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Отрисовка содержимого вкладки «Заметки» для выбранного тикера.
// В Quill содержимое загружается Delta из безопасного HTML; старые заметки
// (plain text в БД) приходят без тегов и переводятся в <br>.
window.renderNotesTab = function(symbol) {
  const editor = document.getElementById('notes-editor');
  if (!editor) return;
  if (editor.dataset.initialized !== '1' && typeof window.initNotesEditor === 'function') {
    window.initNotesEditor();
  }
  const statusEl = document.getElementById('notes-editor-status');
  const listEl = document.getElementById('notes-list');

  const valid = !!symbol && !symbol.startsWith('SECTION:');
  // Заметка привязана к паре (список, тикер) и хранится в колонке
  // watchlist_items.note родительского списка. В цветовых списках
  // («Красный», «Синий»…) строки производные — резолвим родительский список,
  // где реально лежит тикер с флажком (тот же приём, что у setFavorite —
  // findListWithTicker в main.js).
  const activeId = String(appState.activeListId || '');
  const noteListId = activeId.startsWith('fav_')
    ? (findListWithTicker(symbol) || 'default')
    : activeId;
  const key = valid ? noteKey(noteListId, symbol) : '';
  const editable = valid;

  const raw = valid ? String(appState.notes[key] || '') : '';
  // Повторная отрисовка списка (обновление цен, флажки, сворачивание) не должна
  // перезаписывать полотно, если открыта та же заметка и источник не менялся:
  // иначе сбрасывались бы курсор/выделение, история undo и несохранённый ввод.
  const st = window.__notesEditorState;
  const sameNote = !!(st && st.key === key && st.raw === raw);

  if (!sameNote) {
    // Старые заметки хранились как обычный текст (без тегов) — переводим
    // переводы строк в <br>, чтобы они корректно отображались в полотне.
    const safeHtml = !raw ? ''
      : (raw.includes('<') ? notesSanitize(raw) : escapeHtml(raw).replace(/\n/g, '<br>'));
    const placeholder = valid
      ? 'Здесь можно вести заметки по выбранному тикеру…'
      : 'Выберите тикер в списке, чтобы вести заметки';
    const quill = getNotesQuill();
    window.__notesLoading = true;
    try {
      if (quill) {
        quill.enable(editable);
        if (safeHtml) {
          quill.setContents(quill.clipboard.convert({ html: safeHtml }), 'silent');
        } else {
          quill.setText('', 'silent');
        }
        quill.root.dataset.placeholder = placeholder;
        try { quill.history.clear(); } catch (e) { /* история недоступна */ }
      } else {
        editor.innerHTML = safeHtml;
        editor.contentEditable = editable ? 'true' : 'false';
        editor.classList.toggle('disabled', !editable);
        editor.dataset.placeholder = placeholder;
        // data-empty нужен для плейсхолдера в contenteditable (там нет :placeholder)
        editor.dataset.empty = safeHtml ? 'false' : 'true';
      }
    } finally {
      window.__notesLoading = false;
    }
  }

  if (listEl) listEl.classList.toggle('notes-disabled', !editable);
  if (!sameNote) {
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'notes-status';
    }
    // Запоминаем состояние, чтобы автосохранение не сработало на самой загрузке
    window.__notesEditorState = {
      key,
      symbol: valid ? symbol : '',
      value: getNotesSerialize(editor),
      raw,
    };
  }
};

// Сериализация полотна заметок: пустое -> '', «мусорные» <br> в конце
// убираем. Длины заметки не ограничиваем — храним весь введённый текст.
function getNotesSerialize(editor) {
  const quill = getNotesQuill();
  if (quill && (!editor || editor === quill.container)) {
    const plain = notesQuillPlain(quill);
    if (!plain) return '';
    const html = notesSanitize(quill.root.innerHTML);
    return html || `<p>${escapeHtml(plain)}</p>`;
  }
  if (!editor) return '';
  let html = editor.innerHTML;
  if (/^\s*(<br\s*\/?>|&nbsp;|\u00a0)+\s*$/i.test(html)) return '';
  html = html.replace(/(<br\s*\/?>\s*)+$/i, '').trim();
  const plain = notesDomPlain(editor);
  if (!plain) return '';
  return html;
}

// Автосохранение из WYSIWYG-полотна заметок: пользователь печатает/форматирует —
// изменения пишутся в кэш appState.notes и в БД (setNoteInDb) с дебаунсом.
// Пустой текст очищает заметку. Ctrl+S сохраняет немедленно.
let __notesSaveTimer = null;

function notesSetStatus(text, cls) {
  const el = document.getElementById('notes-editor-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'notes-status' + (cls ? ' ' + cls : '');
}

window.notesDoSave = async function() {
  const editor = document.getElementById('notes-editor');
  const st = window.__notesEditorState;
  if (!editor || !st || !st.key) return;
  const quill = getNotesQuill();
  if (!quill && editor.classList.contains('disabled')) return;
  const html = getNotesSerialize(editor);
  if (html === st.value) return; // ничего не изменилось
  st.value = html;
  // raw синхронизируем с локальным кэшем: следующая отрисовка списка увидит
  // тот же источник и не будет перезагружать полотно (курсор/история целы).
  st.raw = html;
  if (html) appState.notes[st.key] = html;
  else delete appState.notes[st.key];
  notesSetStatus('Сохраняю…', 'saving');
  const [listId] = st.key.split('|');
  const saved = await setNoteInDb(listId, st.symbol, html || null);
  if (saved) {
    notesSetStatus('Сохранено', 'saved');
    setTimeout(() => {
      const el = document.getElementById('notes-editor-status');
      if (el && el.textContent === 'Сохранено') {
        el.textContent = '';
        el.className = 'notes-status';
      }
    }, 2500);
  } else {
    notesSetStatus('Не удалось сохранить в БД — изменения только локально', 'error');
  }
};

// Общий обработчик «изменение в полотне»: ставим автосохранение в очередь
// с дебаунсом. Вызывается и Quill (text-change), и fallback-полотном.
window.notesOnInput = function() {
  clearTimeout(__notesSaveTimer);
  __notesSaveTimer = setTimeout(() => notesDoSave(), 650);
};

// Создание Quill-редактора. Тулбар — кастомная разметка из index.html;
// snow-тема сама подставит SVG-иконки стандартным кнопкам, а для истории
// (ql-undo/ql-redo) иконки заданы вручную.
function notesCreateQuill(editor) {
  const toolbarHandlers = {
    undo() {
      const q = getNotesQuill();
      if (!q) return;
      q.focus();
      q.history.undo();
    },
    redo() {
      const q = getNotesQuill();
      if (!q) return;
      q.focus();
      q.history.redo();
    },
  };
  const quill = new window.Quill(editor, {
    theme: 'snow',
    placeholder: 'Здесь можно вести заметки по выбранному тикеру…',
    formats: [
      'header', 'bold', 'italic', 'underline', 'strike',
      'color', 'background', 'list', 'indent', 'align',
      'blockquote', 'code-block', 'link',
    ],
    modules: {
      toolbar: { container: '#notes-toolbar', handlers: toolbarHandlers },
      history: { delay: 450, maxStack: 200, userOnly: true },
    },
  });
  window.__notesQuill = quill;

  // Любое пользовательское изменение (ввод, форматирование, undo/redo) —
  // в очередь автосохранения.
  quill.on('text-change', (delta, oldDelta, source) => {
    if (window.__notesLoading || source === 'silent') return;
    notesOnInput();
  });

  // Ctrl/Cmd+S — сохранить немедленно (как в остальном терминале).
  quill.root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
      e.preventDefault();
      clearTimeout(__notesSaveTimer);
      notesDoSave();
    }
  });
  return quill;
}

// Резервный редактор, если CDN Quill недоступен: обычный contenteditable
// с тем же автосохранением/санитайзером (без панели форматирования).
function notesInitFallbackEditor(editor) {
  const listEl = document.getElementById('notes-list');
  if (listEl) listEl.classList.add('notes-fallback');
  editor.contentEditable = 'true';
  editor.addEventListener('input', () => {
    editor.dataset.empty = getNotesSerialize(editor) ? 'false' : 'true';
    notesOnInput();
  });
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = ((e.clipboardData || {}).getData) ? e.clipboardData.getData('text/plain') : '';
    try { document.execCommand('insertText', false, text); } catch (err) { /* ignore */ }
    notesOnInput();
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
      e.preventDefault();
      clearTimeout(__notesSaveTimer);
      notesDoSave();
    }
  });
  editor.addEventListener('blur', () => {
    clearTimeout(__notesSaveTimer);
    notesDoSave();
  });
}

window.initNotesEditor = function() {
  const editor = document.getElementById('notes-editor');
  if (!editor || editor.dataset.initialized === '1') return;
  editor.dataset.initialized = '1';
  if (typeof window.Quill === 'function') {
    try {
      notesCreateQuill(editor);
      return;
    } catch (e) {
      // If Quill упал на инициализации — остаёмся с простым полотном
      if (window.console && console.error) console.error('Quill init failed:', e);
      window.__notesQuill = null;
    }
  }
  notesInitFallbackEditor(editor);
};

// Переключение вкладок ЛЕВОЙ колонки нижней панели:
// «Новости» / «Избранные Новости» / «Заметки». Правая колонка («Алерты»)
// всегда видима и управляется отдельно (switchRightTab).
window.switchBottomTab = function(tab) {
  // Значение 'alerts' могло остаться в sessionStorage со старых версий —
  // правая колонка теперь живёт отдельно, возвращаемся на «Новости».
  tab = (tab === 'notes' || tab === 'news-fav') ? tab : 'news';
  // Вкладка «Избранные» существует только пока есть избранное — если с неё
  // сняли последний флажок, возвращаемся на «Новости».
  const favBtn = document.getElementById('news-fav-tab-btn');
  if (tab === 'news-fav' && favBtn && favBtn.style.display === 'none') tab = 'news';
  sessionStorage.setItem('bottomTab', tab);
  const newsPanel = document.getElementById('news-panel');
  const newsList = document.getElementById('news-list');
  const notesList = document.getElementById('notes-list');
  const newsFavList = document.getElementById('news-fav-list');
  if (!newsPanel || !newsList || !notesList) return;

  newsPanel.style.display = 'flex';
  newsList.style.display = tab === 'news' ? 'block' : 'none';
  if (newsFavList) newsFavList.style.display = tab === 'news-fav' ? 'block' : 'none';
  // для #notes-list базовый display задаёт CSS (flex — полотно растягивается)
  notesList.style.display = tab === 'notes' ? '' : 'none';

  document.querySelectorAll('.bottom-tabs-left .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const nwBtn = document.getElementById('news-refresh-btn');
  if (nwBtn) nwBtn.style.display = tab === 'news' ? '' : 'none';

  if (tab === 'notes') {
    initNotesEditor(); // вешаем автосохранение при первом открытии вкладки
    const cur = getCurrentList();
    renderNotesTab(cur ? cur.activeSymbol : '');
  }
  if (tab === 'news-fav' && typeof renderNewsFavoritesTab === 'function') {
    // Избранное индивидуально по тикерам: при открытии вкладки перерисовываем
    // её под текущий выбранный тикет (в т.ч. после смены символа, когда
    // вкладка была скрыта). Кэш внутри функции сам определит устаревание.
    renderNewsFavoritesTab(true);
  }
};

// Переключение вкладок ПРАВОЙ колонки нижней панели («Алерты»; позже здесь
// появится «Отчётность»). Колонка всегда видима — функция только подводит
// активность кнопок/панелей (например, из openAlertsListModal).
window.switchRightTab = function(tab) {
  if (tab !== 'alerts') tab = 'alerts'; // пока колонка содержит одну вкладку
  document.querySelectorAll('.bottom-tabs-right .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const alertsList = document.getElementById('alerts-list');
  if (alertsList) alertsList.style.display = tab === 'alerts' ? 'block' : 'none';
  const cur = getCurrentList();
  renderAlertsTab(cur ? cur.activeSymbol : '');
};

// ==========================================================================
// ИНКРЕМЕНТАЛЬНАЯ ОТРИСОВКА СПИСКА (KEYED DOM DIFFING)
// --------------------------------------------------------------------------
// Раньше каждая перерисовка (автообновление цен каждые 120 с, сортировка,
// клики по флажкам, сворачивание разделов) выполняла container.innerHTML = ''
// и пересоздавала все строки заново. Из-за этого:
//   • сбрасывался скролл списка и hover-состояния;
//   • мигали логотипы (перезагрузка <img>), скелетоны рисовались заново;
//   • терялся фокус/выделение, если пользователь взаимодействовал со списком;
//   • лишние перекладывания DOM-узлов грузили поток рендера при больших списках.
// Теперь строки создаются один раз и «переживают» перерисовку: обновляются
// только изменившиеся значения (цена, изменение, флажок, колокольчик), а
// порядок узлов меняется через insertBefore только при реальной необходимости.
// ==========================================================================

// Кэш DOM-узлов строк: symbol -> { el, state }. Сбрасывается при смене списка.
window.__rowsCache = { map: new Map(), listId: null };

// Ключ снимка данных для сравнения «изменилось ли значение» (null, если данных нет).
window.dataSig = function(d) {
  if (!d) return 'ERR';
  return `${d.price}|${d.changeValue}|${d.changeDay}`;
};

// Иконка-флажок избранного: lucide «bookmark» (https://lucide.dev/icons/bookmark).
// Закрашивается красным, когда тикер в избранном (класс .favorite в styles.css).
window.BOOKMARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>';

// Создание каркаса строки тикера (структура строится один раз; дальше —
// только точечное обновление текстов/классов в updateRow).
// SVG-иконка корзины — единственная кнопка удаления в строке.
window.TRASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';

// SVG-иконка «⋯» (горизонтальные точки) — кнопка контекстного меню РАЗДЕЛА
// (в разделе нет одной понятной деструктивной кнопки, поэтому там меню:
// переименовать / свернуть / удалить).
window.MORE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

// Пункты контекстного меню строки тикера (правый клик на строке).
// Кнопка удаления — одна корзина: удаление выполняется сразу одним кликом
// по ней (без подтверждений и без меню «⋯»). Контекстное меню по правому
// клику осталось только как дополнительные действия (пункт удаления там —
// запасной путь).
window.rowMenuItems = function(sym) {
  const baseTicker = sym.split(':').length > 1 ? sym.split(':')[1] : sym;
  const items = [
    { label: `Открыть ${baseTicker} на Smart-Lab`, action: () => window.open(`https://smart-lab.ru/forum/${baseTicker}/`, '_blank', 'noopener') },
  ];
  // Отчетность ведётся только по бумагам Мосбиржи (крипта в раздел
  // не попадает — см. canonical_symbol в report_metrics_service).
  if (!sym.startsWith('BINANCE:')) {
    items.push({ label: `Перейти в отчетность ${baseTicker}`, action: () => openReportsForTicker(sym) });
  }
  items.push(
    { label: 'Перейти в заметки', action: () => {
        sessionStorage.setItem('bottomTab', 'notes');
        const np = document.getElementById('news-panel');
        if (np) np.style.display = 'flex';
        renderNotesTab(sym);
      } },
    { label: 'Убрать из избранного', action: () => setFavorite(sym, null) },
    { label: 'Удалить из списка', danger: true, action: () => removeTickerFromList(sym) },
  );
  return items;
};

// Удаление тикера из активного списка (общий путь для корзины и контекстного меню).
window.removeTickerFromList = async function(sym) {
  const cur = getCurrentList();
  if (appState.activeListId.startsWith('fav_')) {
    setFavorite(sym, null);
    return;
  }
  cur.tickers = cur.tickers.filter(s => s !== sym);
  if (cur.activeSymbol === sym) {
    cur.activeSymbol = cur.tickers.find(s => !s.startsWith('SECTION:')) || '';
    setActiveSymbolInDb(appState.activeListId, cur.activeSymbol); // выбор живёт в БД — обновляем сразу
  }
  render();
  await removeTickerFromDb(appState.activeListId, sym); // удаляем из БД
};

window.buildRowElement = function(sym) {
  const div = document.createElement('div');
  div.className = 'ticker-item wl-row-grid'; // общая сетка колонок с заголовками (A1)
  div.dataset.symbol = sym;
  const safeId = sym.replace(/[^a-zA-Z0-9]/g, '_');
  const parts = sym.split(':');
  const baseTicker = parts.length > 1 ? parts[1] : sym;
  const smartLabUrl = `https://smart-lab.ru/forum/${baseTicker}/`;

  div.innerHTML = `
    <div class="favorite-wrapper" onclick="toggleFavoritePicker('${escapeHtml(sym)}', event)" title="Флажок избранного">
      <span class="favorite-flag empty" style="color: #363a45">${BOOKMARK_SVG}</span>
      <div class="favorite-picker">
        ${Object.entries(FLAG_COLORS).map(([key, c]) => `<span class="favorite-picker-item" onclick="event.stopPropagation(); setFavorite('${escapeHtml(sym)}', '${key}')" style="color:${c.hex}" title="${c.name}">${BOOKMARK_SVG}</span>`).join('')}
      </div>
    </div>
    <div class="ticker-logo-container"></div>
    <div class="ticker-info">
      <a href="${smartLabUrl}" target="_blank" rel="noopener noreferrer" class="ticker-symbol-link" title="Открыть ${escapeHtml(baseTicker)} на Smart-Lab" onclick="event.stopPropagation();">${escapeHtml(baseTicker)}</a>
    </div>
    <div class="ticker-price" id="price-${safeId}"><div class="skeleton skeleton-price"></div></div>
    <div class="ticker-change" id="change-val-${safeId}"><div class="skeleton skeleton-change"></div></div>
    <div class="ticker-change-percent" id="change-pct-${safeId}"><div class="skeleton skeleton-change-pct"></div></div>
    <span class="ticker-remove" data-symbol="${escapeHtml(sym)}" title="Удалить из списка" aria-label="Удалить ${escapeHtml(baseTicker)} из списка">${TRASH_SVG}</span>`;

  // Клик по строке — выбор активного тикера. Вешается ОДИН раз на весь срок
  // жизни узла (раньше слушатель создавался при каждой перерисовке).
  div.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.ticker-remove');
    if (removeBtn) { // корзина: удаление сразу, одним кликом (без меню/подтверждений)
      e.stopPropagation();
      removeTickerFromList(sym);
      return;
    }
    if (e.target.classList.contains('ticker-symbol-link') || e.target.closest('.favorite-wrapper')) return;
    const cur = getCurrentList();
    cur.activeSymbol = sym;
    setActiveSymbolInDb(appState.activeListId, sym); // выбор тикера — в БД (watchlists.active_symbol)
    createChart(sym);
    document.querySelectorAll('.ticker-item').forEach(el => el.classList.remove('active'));
    div.classList.add('active');
    // Колонка «Алерты» показывает алерты выбранного тикера — при смене
    // выбора она тоже должна обновиться (иначе останется список старого).
    renderAlertsList(sym);
  });

  // Правый клик по строке — то же контекстное меню (без выделения тикера)
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openWlContextMenu(div, e.clientX ?? 0, e.clientY ?? 0, rowMenuItems(sym));
  });

  return div;
};

// Точечное обновление строки: пишем в DOM только то, что реально изменилось
// (сравнение по data-подписям — без лишних innerHTML/textContent записей).
window.updateRow = function(div, sym, data, list, prev) {
  const safeId = sym.replace(/[^a-zA-Z0-9]/g, '_');
  const priceEl = div.querySelector(`#price-${safeId}`);
  const changeValEl = div.querySelector(`#change-val-${safeId}`);
  const changePctEl = div.querySelector(`#change-pct-${safeId}`);
  if (!priceEl || !changeValEl || !changePctEl) return;

  // data === undefined — «обновить только флажок» (см. updateFavoriteFlagsOnly):
  // цены/логотип не трогаем и подписи (prev.sig / prev.logoHtml) не сбиваем,
  // чтобы следующий обычный рендер корректно определил изменение цены.
  const flagsOnly = data === undefined;

  const newSig = dataSig(data);
  const changed = !flagsOnly && newSig !== prev.sig;
  const wasError = prev.sig === 'ERR';
  const isError = newSig === 'ERR';

  if (changed) {
    if (data && data.price) {
      const newPrice = Number(data.price);
      // Адаптивная точность (как в TradingView): 2 знака у акций/индексов,
      // больше — у дешёвой крипты (SHIB, PEPE), у которой 2 знака давали «0,00»
      priceEl.textContent = formatPriceAuto(data.price);
      // Направленная flash-подсветка цены: рост — зелёная, падение — красная.
      // Только при переходе цена->цена с реальным изменением: при real-time
      // тиках подпись (sig) меняется и от объёмов/процентов, где направления
      // нет. prev.price хранится в state строки (см. __rowsCache.map).
      // Прошлый класс снимаем всегда — иначе подсветка прежнего направления
      // остаётся на узле, пока не придёт изменение в другую сторону.
      priceEl.classList.remove('price-flash-up', 'price-flash-down');
      if (typeof prev.price === 'number' && newPrice !== prev.price) {
        void priceEl.offsetWidth; // рестарт CSS-анимации
        priceEl.classList.add(newPrice > prev.price ? 'price-flash-up' : 'price-flash-down');
      }
      prev.price = newPrice;
      if (data.changeValue !== undefined && data.changeValue !== null) {
        changeValEl.innerHTML = formatChange(data.changeValue, false);
        changeValEl.className = `ticker-change ${data.changeValue >= 0 ? 'positive-bg' : 'negative-bg'}`;
      } else {
        changeValEl.innerHTML = '<span class="error-text">—</span>';
        changeValEl.className = 'ticker-change';
      }
      if (data.changeDay !== undefined && data.changeDay !== null) {
        changePctEl.innerHTML = formatChange(data.changeDay, true);
        // Иерархия (A3): «Изм.%» — главный акцент, насыщенный бейдж;
        // абсолютное изменение остаётся приглушённым текстом.
        changePctEl.className = `ticker-change-percent ${data.changeDay >= 0 ? 'positive-bg-strong' : 'negative-bg-strong'}`;
      } else {
        changePctEl.innerHTML = '<span class="error-text">—</span>';
        changePctEl.className = 'ticker-change-percent';
      }
    } else if (isError && prev.sig !== 'INIT') {
      // Данные пришли, но пустые/ошибка сети. Если раньше была нормальная цена —
      // оставляем её показывать (не «мигаем» ошибкой при временном сбое MOEX).
      if (wasError || prev.sig === 'INIT') {
        priceEl.innerHTML = '<span class="error-text" title="Возможно, временная блокировка MOEX">Сбой сети</span>';
        changeValEl.innerHTML = '<span class="error-text">—</span>';
        changeValEl.className = 'ticker-change';
        changePctEl.innerHTML = '<span class="error-text">—</span>';
        changePctEl.className = 'ticker-change-percent';
      }
    }
    prev.sig = newSig;
  }

  // Логотип: перестраиваем HTML только если URL реально сменился
  // (иначе <img> перезагружался бы при каждой перерисовке и мигал).
  if (!flagsOnly) {
    const parts = sym.split(':');
    const baseTicker = parts.length > 1 ? parts[1] : sym;
    const logoContainer = div.querySelector('.ticker-logo-container');
    const wantLogo = buildLogoHtml(sym, baseTicker, data);
    if (wantLogo !== prev.logoHtml) {
      logoContainer.innerHTML = wantLogo;
      prev.logoHtml = wantLogo;
    }
  }

  // Флажок избранного. Смена флажка НЕ должна порождать запрос цен: строки
  // с flags-only-обновлением получают data === undefined и обновляют только
  // закладку/пикер (цены, логотипы и подписи остаются нетронутыми).
  const wrapper = div.querySelector('.favorite-wrapper');
  const flagEl = wrapper.querySelector('.favorite-flag');
  const flagColor = appState.favorites[sym] || null;
  const flagCls = 'favorite-flag' + (flagColor ? '' : ' empty');
  if (flagColor !== prev.flag) {
    // Закрашенный bookmark (lucide): при избранном цвете — заливка этим
    // цветом (красный по умолчанию), иначе — контурный серый.
    const hex = (window.FLAG_COLORS[flagColor] || FLAG_COLORS['red']).hex;
    flagEl.style.color = flagColor ? hex : '#363a45';
    flagEl.innerHTML = BOOKMARK_SVG;
    flagEl.className = flagCls + (flagColor ? ' favorite-filled' : '');
    if (flagColor) {
      flagEl.firstChild.setAttribute('fill', hex);
      flagEl.firstChild.setAttribute('stroke', hex);
    }
    wrapper.title = flagColor ? 'Нажмите, чтобы убрать из избранного' : 'Нажмите, чтобы выбрать цвет';
    prev.flag = flagColor;
  }
  // Открытый пикер цветов — переходящее UI-состояние, синхронизируем всегда
  const picker = wrapper.querySelector('.favorite-picker');
  picker.classList.toggle('active', activePickerSymbol === sym);

  // Колокольчик алерта убран из строк тикеров — статус синхронизируется
  // через refreshAllBells, который молча пропускает отсутствующие узлы.

  // Подсветка активной строки
  const isActive = sym === list.activeSymbol;
  if (isActive !== prev.active) {
    div.classList.toggle('active', isActive);
    div.dataset.active = String(isActive);
    prev.active = isActive;
  }
};

// Точечно обновляет ТОЛЬКО флажки/пикер избранных у уже отрисованных строк —
// без пересборки DOM и без единого сетевого запроса. Используется действиями
// «в избранное / убрать из избранного» (setFavorite / toggleFavoritePicker).
window.updateFavoriteFlagsOnly = function() {
  const container = document.getElementById('ticker-list');
  if (!container) return;
  const list = getCurrentList();
  container.querySelectorAll('.ticker-item').forEach(item => {
    const sym = item.dataset.symbol;
    if (!sym || sym.startsWith('SECTION:')) return;
    const entry = window.__rowsCache.map.get(sym);
    // Строка «не из этого списка» (например, открыт fav_-список, а узлы ещё
    // старые) — пересобирать её на лету не нужно, обычный render() сделает
    // это при смене списка. Здесь важна только синхронизация флажка/пикера.
    const state = entry ? entry.state : { sig: 'INIT', logoHtml: null, flag: undefined, active: null };
    updateRow(item, sym, undefined, list, state);
  });
};

// SVG-шеврон кнопки «свернуть/развернуть» раздела (▼→▲ поворачивается CSS-ом,
// см. .section-header.collapsed .section-collapse-btn svg в styles.css).
window.CHEVRON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

// Пункты контекстного меню раздела («⋯» или правый клик по заголовку).
window.sectionMenuItems = function(sym, sectionName) {
  return [
    { label: 'Переименовать раздел', action: () => renameSection(sym, sectionName) },
    { label: collapsedNow(sym) ? 'Развернуть раздел' : 'Свернуть раздел', action: () => toggleSectionCollapse(sym) },
    { label: 'Удалить раздел', danger: true, action: () => removeSection(sym, sectionName) },
  ];
};

window.collapsedNow = function(sym) {
  const cur = getCurrentList();
  return !!(cur.collapsedSections && cur.collapsedSections.includes(sym));
};

// Переключение свёрнутости раздела — общий путь для шеврона и контекстного меню.
window.toggleSectionCollapse = function(sym) {
  const cur = getCurrentList();
  if (!cur.collapsedSections) cur.collapsedSections = [];
  const nowCollapsed = !cur.collapsedSections.includes(sym);
  if (nowCollapsed) cur.collapsedSections.push(sym);
  else cur.collapsedSections = cur.collapsedSections.filter(s => s !== sym);
  // состояние свёрнутости раздела живёт в БД (watchlist_items.collapsed),
  // а не только в localStorage — переживает смену браузера
  setCollapsedInDb(appState.activeListId, sym, nowCollapsed);
  // Инкрементально: меняем только стрелку и видимость строк этой секции —
  // без полного render() и без повторного запроса цен.
  applySectionCollapse(cur);
};

window.renameSection = async function(sym, sectionName) {
  const newName = prompt('Введите новое название раздела:', sectionName);
  if (!newName || !newName.trim() || newName.trim() === sectionName) return;
  const newSectionSymbol = `SECTION:${newName.trim()}`;
  const cur = getCurrentList();
  const index = cur.tickers.indexOf(sym);
  if (index !== -1) {
    cur.tickers[index] = newSectionSymbol;
    if (cur.collapsedSections && cur.collapsedSections.includes(sym)) {
      cur.collapsedSections[cur.collapsedSections.indexOf(sym)] = newSectionSymbol;
    }
    render();
    await saveOrderToDb(appState.activeListId, cur.tickers); // переименование раздела — в БД (saveState не нужен: состояние живёт в БД)
    log(`Раздел переименован: "${sectionName}" → "${newName.trim()}"`, 'success');
  }
};

window.removeSection = async function(sym, sectionName) {
  if (!confirm(`Удалить раздел "${sectionName}"?`)) return;
  const cur = getCurrentList();
  cur.tickers = cur.tickers.filter(s => s !== sym);
  if (cur.collapsedSections) cur.collapsedSections = cur.collapsedSections.filter(s => s !== sym);
  render();
  await saveOrderToDb(appState.activeListId, cur.tickers); // удаляем из БД
};

// Каркас секции создаётся один раз; обработчики живут на самом узле.
window.buildSectionElement = function(sym) {
  const div = document.createElement('div');
  div.className = 'section-header wl-row-grid'; // общая сетка колонок (A1/A8)
  div.dataset.symbol = sym;
  const sectionName = sym.replace('SECTION:', '');
  // Колонки сетки: collapse | счётчик-заглушка | название (col-span до цены) | меню
  div.innerHTML = `
    <span class="section-collapse-btn" title="Свернуть/Развернуть">${CHEVRON_SVG}</span>
    <span class="section-count" title="Инструментов в разделе"></span>
    <span class="section-title col-section-name" title="Дважды кликните, чтобы переименовать">${escapeHtml(sectionName)}</span>
    <span class="section-menu-btn" data-symbol="${escapeHtml(sym)}" title="Ещё действия" aria-label="Меню раздела">${MORE_SVG}</span>`;

  div.querySelector('.section-collapse-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSectionCollapse(sym);
  });

  // «⋯» раздела — контекстное меню (переименовать / свернуть / удалить)
  div.querySelector('.section-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openWlContextMenu(e.target.closest('.section-menu-btn'), e.clientX ?? 0, e.clientY ?? 0, sectionMenuItems(sym, sectionName));
  });

  // Правый клик по заголовку раздела — то же меню
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openWlContextMenu(div, e.clientX ?? 0, e.clientY ?? 0, sectionMenuItems(sym, sectionName));
  });

  div.querySelector('.section-title').addEventListener('dblclick', () => renameSection(sym, sectionName));

  return div;
};

window.updateSectionElement = function(div, sym, list) {
  const collapsed = !!(list.collapsedSections && list.collapsedSections.includes(sym));
  div.classList.toggle('collapsed', collapsed);
  // Счётчик инструментов раздела (A8): считаем тикеры от этого заголовка
  // до следующего заголовка в текущем (отсортированном) порядке списка.
  const countEl = div.querySelector('.section-count');
  if (countEl) {
    const idx = list.tickers.indexOf(sym);
    let n = 0;
    for (let i = idx + 1; i < list.tickers.length && !list.tickers[i].startsWith('SECTION:'); i++) n++;
    const txt = String(n);
    if (countEl.textContent !== txt) countEl.textContent = txt;
  }
};

// Применяет свёрнутость секций к уже существующим строкам (без пересборки DOM).
window.applySectionCollapse = function(list) {
  const container = document.getElementById('ticker-list');
  if (!container) return;
  let isCollapsed = false;
  container.querySelectorAll(':scope > .section-header, :scope > .ticker-item').forEach(node => {
    if (node.classList.contains('section-header')) {
      const sym = node.dataset.symbol || '';
      isCollapsed = !!(list.collapsedSections && list.collapsedSections.includes(sym));
      updateSectionElement(node, sym, list);
    } else {
      node.style.display = isCollapsed ? 'none' : '';
    }
  });
};

// === БЛОК РАЗДЕЛА ПРИ DRAG&DROP ===
// Список плоский: раздел — это заголовок и все строки до следующего заголовка.
// Sortable перетаскивает только сам узел заголовка, поэтому спутников раздела
// приходится переносить вручную (onStart/onEnd в main.js) — иначе тикеры
// остались бы на старом месте и привязались к предыдущему разделу.
window.sectionFollowerNodes = function(headerNode) {
  const nodes = [];
  if (!headerNode || !headerNode.classList || !headerNode.classList.contains('section-header')) return nodes;
  for (let n = headerNode.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList && n.classList.contains('section-header')) break;
    nodes.push(n);
  }
  return nodes;
};

// Ставит спутников раздела сразу после заголовка, сохраняя их порядок.
// remove() + insertBefore, а не голый insertBefore: при переносе узла внутри
// одного родителя так не остаётся дублей в разметке.
window.moveSectionBlockAfterHeader = function(headerNode, followers) {
  if (!headerNode || !followers || followers.length === 0) return;
  const parent = headerNode.parentNode;
  if (!parent) return;
  let anchor = headerNode;
  for (const node of followers) {
    if (node === anchor) continue;
    if (node.parentNode) node.remove();
    parent.insertBefore(node, anchor.nextSibling);
    anchor = node;
  }
};

// Ближайшая граница раздела для позиции drop. nodes — список БЕЗ
// перетаскиваемого блока, pos — позиция в нём. Заголовок раздела не должен
// попадать внутрь чужого блока: тикеры, оставшиеся после заголовка, привязались
// бы к перетаскиваемому разделу. Границы — заголовок раздела и место сразу
// после последнего тикера блока (следующий заголовок либо конец списка).
// Тикеры до первого заголовка разделу не принадлежат, поэтому drop среди них
// не снапим: забирать у раздела нечего, а «новый раздел начинается здесь» —
// осмысленное поведение.
window.snapSectionDropIndex = function(nodes, pos) {
  const isHeader = (n) => !!(n && n.classList && n.classList.contains('section-header'));
  const list = nodes || [];
  const at = Math.max(0, Math.min(pos, list.length));
  let header = -1; // заголовок раздела, внутрь блока которого попал drop
  for (let i = 0; i < at; i++) if (isHeader(list[i])) header = i;
  if (header < 0) return at;
  let blockEnd = list.length;
  for (let i = at; i < list.length; i++) if (isHeader(list[i])) { blockEnd = i; break; }
  const distStart = at - header;
  const distEnd = blockEnd - at;
  if (distStart === 0 || distEnd === 0) return at; // drop уже на границе
  return distStart <= distEnd ? header : blockEnd;
};

// Ставит блок раздела (заголовок + его тикеры) в точку drop, подтягивая его к
// границе раздела. Возвращает итоговую позицию блока в списке БЕЗ его
// собственных элементов — она же target_index для бэкенда.
window.resolveSectionDrop = function(headerNode, followers) {
  const container = document.getElementById('ticker-list');
  const parent = headerNode ? headerNode.parentNode : null;
  if (!headerNode || !container || !parent) return -1;
  const followersList = followers || [];
  const blockNodes = new Set([headerNode, ...followersList]);
  const kids = Array.from(container.children);
  const rest = kids.filter(n => !blockNodes.has(n));
  // Сколько НЕ принадлежащих блоку элементов стоит перед заголовком — это и
  // есть позиция drop в списке без блока (Sortable перенёс только заголовок).
  let pos = 0;
  for (const n of kids) {
    if (n === headerNode) break;
    if (!blockNodes.has(n)) pos++;
  }
  pos = typeof snapSectionDropIndex === 'function' ? snapSectionDropIndex(rest, pos) : pos;
  // Переносим блок целиком в вычисленную точку. remove() перед insertBefore,
  // чтобы при переносе внутри родителя не осталось дублей.
  const before = rest[pos] || null;
  headerNode.remove();
  parent.insertBefore(headerNode, before);
  moveSectionBlockAfterHeader(headerNode, followersList);
  return pos;
};

// === ЛЁГКАЯ ПЕРЕРИСОВКА (БЕЗ ЗАПРОСА ЦЕН) ===
// symbol -> данные последнего рендера с ценами. Нужна для того, чтобы
// действия, которые меняют только оформление (флажок избранного, открытие/
// закрытие пикера цветов), не дёргали /api/prices для каждого тикера списка.
window.__lastRenderData = null;
window.__lastRenderAt = 0;

// True, если можно перерисовать список из кэша цен, не обращаясь к API:
// тот же список, данные свежие (не старше TTL кэша) и все тикеры уже известны.
window.canRenderWithoutPrices = function(list) {
  const d = window.__lastRenderData;
  if (!d || window.__rowsCache.listId !== appState.activeListId) return false;
  if (Date.now() - window.__lastRenderAt >= (window.CACHE_DURATION || 120000)) return false;
  return list.tickers.every(s => s.startsWith('SECTION:') || (s in d));
};

window.render = async function() {
  const currentList = getCurrentList();
  const container = document.getElementById('ticker-list');
  if (!container) return;
  populateListSelector();

  // Список полностью сменился — сбрасываем кэш DOM-узлов (старые узлы относятся
  // другому списку: другие тикеры, флажки, заметки). Контейнер при этом очищается,
  // иначе diff не сможет корректно удалить чужие строки.
  if (window.__rowsCache.listId !== appState.activeListId) {
    window.__rowsCache = { map: new Map(), listId: appState.activeListId };
    container.innerHTML = '';
  }

  const symbols = currentList.tickers.filter(s => !s.startsWith('SECTION:'));
  let dataMap = {};
  let lightweightRender = false;

if (window.canRenderWithoutPrices(currentList)) {
    // Цены уже есть в свежем in-memory-кэше последнего рендера (например, пользователь
    // просто поставил/снял флажок избранного или открыл пикер цветов) —
    // запросы /api/prices НЕ выполняются вовсе, строки обновляются точечно.
    // Полная загрузка цен остаётся при первой отрисовке списка, переключении
    // списка, сортировке, добавлении/удалении тикера и автообновлении.
    lightweightRender = true;
    symbols.forEach(sym => { dataMap[sym] = window.__lastRenderData[sym]; });
  } else {
    // Запрашиваем цены ПАРАЛЛЕЛЬНО (с таймаутом в fetchTickerData).
    // Последовательный await для каждого тикера складывал задержки: при медленном
    // внешнем API список «загружался» бесконечно долго.
   const results = await Promise.all(symbols.map(sym => fetchTickerData(sym)));
    symbols.forEach((sym, i) => { dataMap[sym] = results[i]; });

    // Пока ждали ответа API, пользователь мог переключить список — не рисуем
    // устаревшие данные в чужой DOM (иначе цены «переехали» бы между списками).
    if (window.__rowsCache.listId !== appState.activeListId) return;

    // Обновляем кэш данных для лёгкой перерисовки (см. canRenderWithoutPrices)
    window.__lastRenderData = Object.assign({}, dataMap);
    window.__lastRenderAt = Date.now();
  }

  const sortedList = sortList(currentList.tickers, dataMap);

  if (!lightweightRender && sortedList.length > 0 && !currentList.activeSymbol) {
    const firstTicker = sortedList.find(s => !s.startsWith('SECTION:'));
    if (firstTicker) {
      currentList.activeSymbol = firstTicker;
      setActiveSymbolInDb(appState.activeListId, firstTicker); // выбор — в БД, иначе потеряется после перезагрузки
    }
  }

  // === KEYED DIFF: узлы создаются один раз, дальше только точечные правки ===
  const cacheMap = window.__rowsCache.map;
  const seen = new Set();
  let cursor = container.firstElementChild;
  let isCollapsed = false;

  for (const sym of sortedList) {
    if (sym.startsWith('SECTION:')) {
      let node = cacheMap.get(sym);
      if (!node) { node = buildSectionElement(sym); cacheMap.set(sym, node); }
      seen.add(sym);
      updateSectionElement(node, sym, currentList);
      isCollapsed = !!(currentList.collapsedSections && currentList.collapsedSections.includes(sym));
      if (cursor !== node) container.insertBefore(node, cursor);
      else cursor = cursor.nextElementSibling;
      continue;
    }

    let entry = cacheMap.get(sym);
    if (!entry) {
      entry = { el: buildRowElement(sym), state: { sig: 'INIT', logoHtml: null, flag: undefined, active: null } };
      cacheMap.set(sym, entry);
    }
    seen.add(sym);
    // На лёгком рендере строкам передаём закэшированные данные: подписи (prev.sig)
    // совпадают, поэтому в DOM пишется только реально изменившийся флажок.
    updateRow(entry.el, sym, dataMap[sym], currentList, entry.state);
    entry.el.style.display = isCollapsed ? 'none' : '';
    if (cursor !== entry.el) container.insertBefore(entry.el, cursor);
    else cursor = cursor.nextElementSibling;
  }
  cursor = container.lastElementChild;
  while (cursor) {
    const prev = cursor.previousElementSibling;
    if (!seen.has(cursor.dataset.symbol || '')) {
      cursor.remove();          // удалённые тикеры/секции
      cacheMap.delete(cursor.dataset.symbol); // чистим кэш узлов, чтобы он не рос бесконечно
    }
    cursor = prev;
  }

  // Проверка алертов на бэкенде «по горячим следам» — ОДИН раз за перерисовку
  // (раньше таймер перезапускался из каждой строки). Фоновый цикл сервера
  // делает то же самое каждые 60 с, но при открытом терминале реакция мгновенна.
  // Только на обычном рендере: лёгкая перерисовка (флажок избранного) не должна
  // порождать лишний запрос проверки алертов.
  if (!lightweightRender && symbols.some(s => dataMap[s] && dataMap[s].price)) {
    clearTimeout(window.__alertSyncTimer);
    window.__alertSyncTimer = setTimeout(() => { syncAlertsWithDb(); }, 1500);
  }

  // Цены отрисованных строк — графику: плашка «цена» на шкале, пунктир
  // last-price и «Закр» легенды повторяют число строки списка. Свечи и
  // котировки списка питаются разными лентами бэкенда (у MOEX свечи без
  // задержки, marketdata в /api/prices отстаёт), поэтому без общей точки
  // «текущая цена» на графике расходилась с ценой в списке (watchlist_chart.js:
  // wlChartApplyListPrices). Тикер не из списка (введён в шапке графика) —
  // график живёт по свечам.
  if (typeof window.wlChartApplyListPrices === 'function') {
    window.wlChartApplyListPrices(dataMap);
  }

  // График: перезагружаем KLineChart только при СМЕНЕ активного тикера.
  // При автообновлении цен/сортировке вызов createChart с тем же символом
  // приводил к лишним перезагрузкам свечей — теперь это исключено.
  const chartDiv = document.getElementById('wl-chart-area');
  if (chartDiv) {
    if (currentList.activeSymbol && !currentList.activeSymbol.startsWith('SECTION:')) {
      if (chartDiv.dataset.activeSymbol !== currentList.activeSymbol) {
        chartDiv.dataset.activeSymbol = currentList.activeSymbol;
        createChart(currentList.activeSymbol);
      }
    } else {
      delete chartDiv.dataset.activeSymbol;
      if (typeof window.wlChartReset === 'function') window.wlChartReset();
    }
  }

  // Нижняя панель: синхронизируем полотно заметок (активная вкладка левой
  // колонки) и список алертов (правая колонка видима всегда) с выбранным
  // тикером — они могли измениться/переехать вместе со списком.
  const bottomTab = sessionStorage.getItem('bottomTab');
  if (bottomTab === 'notes' && currentList.activeSymbol) {
    const np = document.getElementById('news-panel');
    if (np) np.style.display = 'flex';
    renderNotesTab(currentList.activeSymbol);
  }
  renderAlertsTab(currentList.activeSymbol || '');
};

// === АЛЕРТЫ UI ===
// Алерты хранятся на бэкенде в таблице price_alerts (SQLite) и проверяются
// фоновым циклом сервера — теперь они срабатывают даже при закрытой вкладке.
// Фронтенд только: загружает список через GET /api/alerts в кеш
// window.dbAlerts, отправляет изменения (POST/DELETE) и по кешу рисует
// колокольчики. localStorage 'price_alerts' больше не является источником
// истины — из него выполняется одноразовая миграция в БД.

window.dbAlerts = []; // актуальный снимок алертов из БД (для колокольчиков и модалок)

// id алерта, который редактируется в модалке (null — режим создания).
// Заполняется в openAlertModal(symbol, alertId) по id с карточки; по нему
// saveAlert выбирает PUT вместо POST, а deleteAlert удаляет именно эту запись.
window.editingAlertId = null;

// Емкость на тикер — дублирует backend/services/alert_service.py
// (MAX_ALERTS_PER_SYMBOL); используется только в подписи группы «Активные».
const ALERTS_MAX_PER_SYMBOL = 10;

// === ИКОНКИ АЛЕРТОВ (inline SVG, пути lucide — https://lucide.dev) ===
// Строки SVG вставляются через innerHTML отдельного <span>: иконки
// статичны и не содержат пользовательских данных. Весь текст карточек
// по-прежнему через textContent (безопасность + совместимость с
// мини-DOM интеграционного теста alerts_tab_test.js).
const ALERT_ICON_SVG = {
  up: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>', // arrow-up-right
  down: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10"/><path d="M17 7v10H7"/></svg>', // arrow-down-right
  bell: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H4s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  bellOff: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>', // bell-off
  pencil: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>', // trash-2
  x: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  plus: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
};

// <span> с inline-иконкой lucide (aria-hidden: для скринридеров есть текст).
window.makeAlertIcon = function(name, cls) {
  const span = document.createElement('span');
  span.className = cls || 'alert-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ALERT_ICON_SVG[name] || '';
  return span;
};

// Кнопка-иконка карточки алерта (изменить / отменить / удалить).
const makeAlertIconBtn = function(icon, title, onClick, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'alert-icon-btn' + (extraClass ? ' ' + extraClass : '');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(makeAlertIcon(icon));
  btn.addEventListener('click', onClick);
  return btn;
};

// === ТОСТЫ (неблокирующая замена window.alert) ===
// Стек в правом верхнем углу; типы: success / error / warn / info.
// В мини-DOM теста document.body без appendChild — фолбэк в debug-лог.
window.showToast = function(message, type = 'info', timeoutMs = 4000) {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    if (!document.body || typeof document.body.appendChild !== 'function') {
      log(`[toast:${type}] ${message}`, type === 'error' ? 'error' : (type === 'success' ? 'success' : 'info'));
      return;
    }
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.setAttribute('role', 'status');
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  const msg = document.createElement('span');
  msg.className = 'toast__msg';
  msg.textContent = message;
  toast.appendChild(msg);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast__close';
  closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);
  stack.appendChild(toast);
  setTimeout(() => { try { toast.remove(); } catch (e) { /* уже снят */ } }, timeoutMs);
};

// Текущая цена тикера из отрисованной строки watchlist (число или NaN).
// Единая точка парсинга: используется модалкой (price_at_creation, чипы,
// подсказка расстояния) и прогресс-баром карточек.
window.getCurrentPriceForSymbol = function(symbol) {
  if (!symbol) return NaN;
  const safeId = String(symbol).replace(/[^a-zA-Z0-9]/g, '_');
  const priceEl = document.getElementById(`price-${safeId}`);
  if (!priceEl) return NaN;
  // formatPriceAuto пишет «1 234,56» (неразрывные пробелы + запятая)
  return parseFloat(String(priceEl.textContent).replace(/\s|'/g, '').replace(',', '.'));
};

// Загружает все алерты из БД в window.dbAlerts и перерисовывает колокольчики.
window.loadAlertsFromDb = async function() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.dbAlerts = Array.isArray(data.alerts) ? data.alerts : [];
  } catch (e) {
    console.error('Ошибка загрузки алертов из БД:', e);
  }
  refreshAllBells();
  return window.dbAlerts;
};

// Однократная миграция старых клиентских алертов (localStorage 'price_alerts')
// в таблицу на бэкенде. Вызывается при старте приложения; после успешного
// переноса ключ localStorage очищается.
window.migrateAlertsToDb = async function() {
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]'); } catch (e) {}
  if (!Array.isArray(legacy) || legacy.length === 0) return;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts: legacy })
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    localStorage.removeItem(ALERTS_KEY);
    log(`Алерты перенесены из браузера в БД: ${data.imported} шт. (пропущено ${data.skipped})`, 'info');
    await loadAlertsFromDb();
  } catch (e) {
    // Бэкенд недоступен — попробуем перенести при следующем старте
    console.error('Ошибка миграции алертов в БД:', e);
  }
};

// Единая функция определения состояния колокольчика для символа.
// Читает кеш dbAlerts (заполняется из БД), поэтому результат отражает
// серверные статусы: active / triggered / cancelled.
window.getBellStatusForSymbol = function(symbol) {
  const alerts = window.dbAlerts || [];
  let hasTriggered = false;
  for (const a of alerts) {
    if (a.symbol !== symbol) continue;
    if (a.status === 'active') return 'active';
    if (a.status === 'triggered') hasTriggered = true;
  }
  if (hasTriggered) return 'triggered';
  return 'none';
};

// Мгновенно перерисовывает колокольчики всех тикеров в DOM по фактическому
// состоянию кеша алертов — вызывается после любого изменения статуса алертов.
window.refreshAllBells = function() {
  const items = document.querySelectorAll('.ticker-item');
  items.forEach(item => {
    const bell = item.querySelector('.alert-bell');
    if (!bell) return;
    const sym = bell.getAttribute('data-symbol');
    if (!sym) return;
    const st = getBellStatusForSymbol(sym);
    bell.classList.remove('active', 'triggered');
    if (st === 'active') bell.classList.add('active');
    else if (st === 'triggered') bell.classList.add('triggered');
  });
};

// Обновляет колокольчик одного символа (делегировано в refreshAllBells,
// чтобы вся логика статуса была в одном месте).
window.updateBellIconStatus = function(symbol, status) {
  refreshAllBells();
};

// === МОДАЛКА-КОНСТРУКТОР АЛЕРТА ===
// Управление сегментированным переключателем (Выше/Ниже), чипами быстрых
// значений цели и живой подсказкой расстояния. Один раз навешиваем
// обработчики при первом открытии (wireAlertModalControls), горячие
// клавиши Enter/Esc — один документный слушатель (initAlertModalShortcuts).

window.wireAlertModalControls = function() {
  if (window._alertModalControlsWired) return;
  window._alertModalControlsWired = true;
  const seg = document.getElementById('alert-condition-seg');
  if (seg) {
    seg.querySelectorAll('.alert-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => setAlertCondition(btn.getAttribute('data-condition')));
    });
  }
  const chips = document.getElementById('alert-target-chips');
  if (chips) {
    chips.querySelectorAll('.alert-chip').forEach(chip => {
      chip.addEventListener('click', () => setAlertTargetFromChip(parseFloat(chip.getAttribute('data-pct'))));
    });
  }
  const input = document.getElementById('alert-target-price');
  if (input) input.addEventListener('input', updateAlertDistanceHint);
};

// Горячие клавиши модалки: Enter в поле цены — сохранить, Esc — закрыть.
window.initAlertModalShortcuts = function() {
  if (window._alertModalShortcutsWired) return;
  window._alertModalShortcutsWired = true;
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('alert-modal');
    if (!modal || !modal.classList.contains('active')) return;
    if (e.key === 'Escape') {
      closeAlertModal();
    } else if (e.key === 'Enter') {
      const input = document.getElementById('alert-target-price');
      if (document.activeElement && input && document.activeElement === input) {
        saveAlert();
      }
    }
  });
};

window.setAlertCondition = function(cond) {
  const input = document.getElementById('alert-condition');
  if (input) input.value = cond === 'below' ? 'below' : 'above';
  const seg = document.getElementById('alert-condition-seg');
  if (seg) {
    seg.querySelectorAll('.alert-seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-condition') === input.value);
    });
  }
  updateAlertDistanceHint();
};

// Чип быстрого значения цели: ±N% от текущей цены, «Текущая» — без сдвига.
window.setAlertTargetFromChip = function(pct) {
  const cur = getCurrentPriceForSymbol(currentAlertSymbol);
  if (!Number.isFinite(cur) || cur <= 0) {
    showAlertError('Текущая цена ещё не загрузилась — введите целевую цену вручную.');
    return;
  }
  const input = document.getElementById('alert-target-price');
  if (!input) return;
  const value = pct === 0 ? cur : cur * (1 + pct / 100);
  input.value = Number(value.toPrecision(8)); // 8 значащих: хватает и для SHIB, и для индексов
  clearAlertError();
  updateAlertDistanceHint();
};

// Проверка направления цели относительно текущей цены. Алерт «Выше» с целью
// ниже текущей (и «Ниже» с целью выше) сработал бы сразу после создания —
// такой смысл у него отсутствует, поэтому сохранение блокируется. Условия
// строгие: равенство тоже недопустимо, т.к. сервер сравнивает current >= target.
// Если текущая цена неизвестна (null/0), проверять нечего — пропускаем.
window.validateAlertDirection = function(condition, target, refPrice) {
  if (!Number.isFinite(refPrice) || refPrice <= 0) return { ok: true, message: '' };
  if (condition === 'above' && target <= refPrice) {
    return {
      ok: false,
      message: `Цель ${formatPriceAuto(target)} не выше текущей цены ${formatPriceAuto(refPrice)} — для «Выше или равно» укажите цену больше ${formatPriceAuto(refPrice)}.`
    };
  }
  if (condition === 'below' && target >= refPrice) {
    return {
      ok: false,
      message: `Цель ${formatPriceAuto(target)} не ниже текущей цены ${formatPriceAuto(refPrice)} — для «Ниже или равно» укажите цену меньше ${formatPriceAuto(refPrice)}.`
    };
  }
  return { ok: true, message: '' };
};

// Живая подсказка «до цели +8,3% · сработает при ≥ 325,50». Если цель уже
// достигнута при текущей цене — вместо неё предупреждение тем же текстом,
// который покажет saveAlert при попытке сохранить.
window.updateAlertDistanceHint = function() {
  const hint = document.getElementById('alert-distance-hint');
  if (!hint) return;
  const condInput = document.getElementById('alert-condition');
  const cond = condInput && condInput.value === 'below' ? 'below' : 'above';
  const target = parseFloat((document.getElementById('alert-target-price') || {}).value);
  if (!Number.isFinite(target) || target <= 0) {
    hint.textContent = '';
    if (hint.classList) hint.classList.remove('alert-hint--warn');
    return;
  }
  const cur = getCurrentPriceForSymbol(currentAlertSymbol);
  const direction = validateAlertDirection(cond, target, cur);
  if (!direction.ok) {
    hint.textContent = direction.message;
    if (hint.classList) hint.classList.add('alert-hint--warn');
    return;
  }
  if (hint.classList) hint.classList.remove('alert-hint--warn');
  const targetText = `сработает при ${cond === 'above' ? '≥' : '≤'} ${formatPriceAuto(target)}`;
  if (!Number.isFinite(cur) || cur <= 0) { hint.textContent = targetText; return; }
  const distPct = cond === 'above' ? (target - cur) / cur * 100 : (cur - target) / cur * 100;
  const sign = distPct >= 0 ? '+' : '';
  hint.textContent = `До цели ${sign}${formatNumber(distPct, 2)}% · ${targetText}`;
};

window.updateAlertCurrentPrice = function() {
  const el = document.getElementById('alert-current-price');
  if (!el) return;
  const cur = getCurrentPriceForSymbol(currentAlertSymbol);
  el.textContent = Number.isFinite(cur) && cur > 0 ? formatPriceAuto(cur) : '—';
};

// Inline-ошибка модалки (вместо блокирующего window.alert).
window.showAlertError = function(message) {
  const el = document.getElementById('alert-error');
  if (!el) { showToast(message, 'error'); return; }
  el.textContent = message;
  el.style.display = 'block';
};
window.clearAlertError = function() {
  const el = document.getElementById('alert-error');
  if (el) { el.textContent = ''; el.style.display = 'none'; }
};

// Открывает модалку ценового уведомления.
//   openAlertModal(symbol, alertId)  — редактирование существующего алерта:
//       поля заполняются его значениями, «Сохранить» шлёт PUT /api/alerts/{id}
//       и ОБНОВЛЯЕТ запись (раньше здесь всегда создавался новый алерт).
//   openAlertModal(symbol)           — создание нового алерта (кнопка
//       «+ Добавить», CTA пустого состояния).
window.openAlertModal = async function(symbol, alertId) {
  wireAlertModalControls();
  initAlertModalShortcuts();
  currentAlertSymbol = symbol;
  const nameEl = document.getElementById('alert-symbol-name');
  if (nameEl) nameEl.textContent = symbol;
  clearAlertError();
  const modal = document.getElementById('alert-modal');
  if (modal) modal.classList.add('active');
  updateAlertCurrentPrice();

  // Подтягиваем свежие данные из БД, затем ищем редактируемый алерт: по
  // точному id с карточки (у тикера может быть до 10 активных) либо
  // показываем пустую форму для нового.
  await loadAlertsFromDb();
  if (currentAlertSymbol !== symbol) return; // модалку успели закрыть/переключить
  const allForSymbol = (window.dbAlerts || []).filter(a => a.symbol === symbol);
  const existingAlert = alertId != null
    ? allForSymbol.find(a => a.id === alertId && a.status === 'active')
    : null;

  window.editingAlertId = existingAlert ? existingAlert.id : null;
  setAlertModalMode(!!existingAlert);

  const deleteBtn = document.getElementById('alert-delete-btn');
  const input = document.getElementById('alert-target-price');
  if (existingAlert) {
    setAlertCondition(existingAlert.condition);
    if (input) input.value = existingAlert.target;
    if (deleteBtn) deleteBtn.style.display = '';
  } else {
    setAlertCondition('above');
    if (input) input.value = '';
    if (deleteBtn) deleteBtn.style.display = 'none';
  }
  updateAlertDistanceHint();
  if (input && typeof input.focus === 'function') input.focus();

  // Синхронизируем колонку «Алерты» с модалкой: список должен отражать
  // алерты именно того тикера, для которого она открыта (раньше при
  // создании алерта через колокольчик другого тикера колонка продолжала
  // рисовать пустой список выбранного тикера).
  const cur = getCurrentList();
  if (cur && !symbol.startsWith('SECTION:')) {
    cur.activeSymbol = symbol;
    setActiveSymbolInDb(appState.activeListId, symbol);
    renderAlertsList(symbol);
  }
};

// Переключает подпись заголовка модалки: «Ценовое уведомление» (создание)
// или «Изменить уведомление» (редактирование существующего алерта).
window.setAlertModalMode = function(isEditing) {
  const title = document.getElementById('alert-modal-title-text');
  if (title) title.textContent = isEditing ? 'Изменить уведомление' : 'Ценовое уведомление';
  const saveBtn = document.getElementById('alert-save-btn');
  if (saveBtn) saveBtn.textContent = isEditing ? 'Сохранить' : 'Создать';
};

window.closeAlertModal = function() {
  const modal = document.getElementById('alert-modal');
  if (modal) modal.classList.remove('active');
  clearAlertError();
  currentAlertSymbol = null;
  window.editingAlertId = null;
};

// Сохраняет алерт в БД. Режим зависит от того, как открыта модалка:
//   редактирование (editingAlertId задан) → PUT /api/alerts/{id} обновляет
//       существующую запись: id, created_at и price_at_creation сохраняются,
//       меняются только условие и цель;
//   создание → POST /api/alerts.
window.saveAlert = async function() {
  if (!currentAlertSymbol) return;
  const condInput = document.getElementById('alert-condition');
  const condition = condInput && condInput.value === 'below' ? 'below' : 'above';
  const target = parseFloat(document.getElementById('alert-target-price').value);

  if (isNaN(target) || target <= 0) {
    showAlertError('Введите корректную целевую цену — положительное число.');
    return;
  }
  // Цель должна лежать в сторону условия относительно текущей цены: иначе
  // алерт сработал бы мгновенно и показывал «в работе · цель достигнута».
  const refPrice = getCurrentPriceForSymbol(currentAlertSymbol);
  const direction = validateAlertDirection(condition, target, refPrice);
  if (!direction.ok) {
    showAlertError(direction.message);
    return;
  }
  clearAlertError();

  const editId = window.editingAlertId;
  const savedSymbol = currentAlertSymbol;
  try {
    const res = await sendAlertRequest(editId, savedSymbol, condition, target);
    // 404/409 при редактировании: алерт успел сработать или был отменён
    // (например, фоновой проверкой), пока модалка была открыта. Сохранённый
    // замысел пользователя не теряем — создаём новый алерт с теми же полями.
    if (!res.ok && editId && (res.status === 404 || res.status === 409)) {
      const retry = await sendAlertRequest(null, savedSymbol, condition, target);
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${retry.status}`);
      }
      log(`Алерт #${editId} уже завершён — создан новый для ${savedSymbol}`, 'info');
      showToast(`Прежний алерт уже завершён — создан новый: ${condition === 'above' ? '≥' : '≤'} ${formatPriceAuto(target)}`, 'warn');
    } else if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    } else {
      const verb = editId ? 'обновлён' : 'создан';
      log(`Алерт ${verb} в БД для ${savedSymbol}: ${condition} ${target}`, 'success');
      showToast(`Алерт ${verb}: ${condition === 'above' ? '≥' : '≤'} ${formatPriceAuto(target)}`, 'success');
    }
    closeAlertModal();
    await loadAlertsFromDb(); // мгновенно обновляем колокольчик по данным из БД
    // Перерисовываем колонку «Алерты» под ЭТОТ тикер. Важно:
    // closeAlertModal() сбрасывает currentAlertSymbol, а при смене выбранного
    // тикера во время сетевой записи список иначе показывал «Нет алертов для
    // этого тикера», хотя алерт уже был создан и лежал в кеше.
    if (savedSymbol) {
      renderAlertsTab(savedSymbol);
    }
  } catch (e) {
    log(`Ошибка сохранения алерта: ${e.message}`, 'error');
    showToast('Не удалось сохранить алерт: ' + e.message, 'error');
  }
};

// Один сетевой вызов сохранения: PUT при редактировании (editId — id записи)
// или POST при создании. Вынесено из saveAlert, чтобы повторное создание
// после 404/409 не дублировало сборку тела запроса.
const sendAlertRequest = async function(editId, symbol, condition, target) {
  const headers = { 'Content-Type': 'application/json' };
  // Текущая цена строки тикера: при создании сохраняется как «от какой цены
  // ждали» (price_at_creation); при изменении сервер по ней же проверяет,
  // что новая цель не оказалась уже достигнутой.
  const currentPrice = getCurrentPriceForSymbol(symbol);
  const refPrice = Number.isFinite(currentPrice) ? currentPrice : null;
  if (editId) {
    return fetchWithTimeout(`${API_BASE}/api/alerts/${editId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ condition, target, price_at_creation: refPrice })
    }, 15000);
  }
  return fetchWithTimeout(`${API_BASE}/api/alerts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      symbol,
      condition,
      target,
      price_at_creation: refPrice
    })
  }, 15000);
};

// Удаляет активный алерт символа из БД (кнопка «Удалить» модалки).
// При редактировании удаляем именно открытую запись (editingAlertId), а не
// «первый активный» — у тикера их может быть несколько.
window.deleteAlert = async function() {
  if (!currentAlertSymbol) return;
  const active = window.editingAlertId
    ? { id: window.editingAlertId }
    : (window.dbAlerts || []).find(a => a.symbol === currentAlertSymbol && a.status === 'active');
  const deletedSymbol = currentAlertSymbol;
  closeAlertModal();
  if (active) {
    await deleteAlertById(active.id, deletedSymbol);
  }
};

window.openAlertsListModal = async function() {
  // Кнопка «🔔 Алерты» перенесена в правую колонку нижней панели —
  // совместимость на случай старого вызова: колонка видима всегда,
  // просто перерисовываем список под текущий тикер.
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    showToast('Сначала выберите тикер в списке', 'info');
    return;
  }
  renderAlertsTab(symbol);
};

// Кнопка «+ Добавить» на вкладке «Алерты» (перенесена с колокольчика из
// строк списка тикеров): открывает модалку ценового уведомления для
// выбранного тикера.
window.openAddAlertForActiveSymbol = async function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    showToast('Сначала выберите тикер в списке', 'info');
    return;
  }
  await openAlertModal(symbol);
};

// Рендер правой колонки «Алерты» (видима всегда): КАРТОЧКИ алертов
// выбранного тикера с прогрессом до цели и группами «Активные»/«История».
// Без выбранного тикера показываем пустое состояние. При пустом
// кеше алертов тянем свежие данные из БД (для пустого тикера запрос не нужен).
window.renderAlertsTab = async function(symbol) {
  const container = document.getElementById('alerts-list');
  if (!container) return;
  // В колонке видны только алерты выбранного тикера.
  const sym = (!symbol || symbol.startsWith('SECTION:')) ? '' : symbol;
  // Свежие статусы из БД. Кеш пуст — тянем всё; есть алерты этого тикера —
  // рисуем сразу (иначе пересозданный/новый алерт мог «исчезать» до ответа
  // сервера и колонка показывала «Нет алертов»).
  const alerts = window.dbAlerts || [];
  const hasCacheForSymbol = alerts.some(a => a.symbol === sym);
  if (sym && (!alerts.length || !hasCacheForSymbol)) await loadAlertsFromDb();
  // Пока грузили данные, выбранный тикер мог смениться — не рисуем устаревшее
  const cur = getCurrentList();
  const activeSymRaw = (cur && cur.activeSymbol) || '';
  const activeSym = activeSymRaw.startsWith('SECTION:') ? '' : activeSymRaw;
  if (activeSym !== sym) return;
  renderAlertsList(symbol);
};

// Отслеживание анимаций карточек: слайд-ин только для впервые показанных
// алертов, pulse — только при переходе в «Исполнено» (иначе каждая
// перерисовка цен проигрывала бы анимации заново).
const _seenAlertIds = new Set();
const _prevAlertStatus = new Map();

window.renderAlertsList = function(symbol) {
  const alerts = window.dbAlerts || [];
  // Только алерты выбранного тикера — карточки: иконка направления,
  // цель, статус-пилюля, мета-строка и прогресс до цели.
  const sym = (!symbol || String(symbol).startsWith('SECTION:')) ? '' : symbol;
  const allAlerts = alerts.filter(a => a.symbol === sym);
  const container = document.getElementById('alerts-list');
  if (!container) return;
  container.innerHTML = '';

  if (allAlerts.length === 0) {
    const listWrap = document.createElement('div');
    listWrap.className = 'alerts-tab-content';
    container.appendChild(listWrap);
    // Пустые состояния: без выбранного тикера — подсказка; с тикером —
    // иконка + CTA «Создать алерт».
    const empty = document.createElement('div');
    empty.className = 'alert-empty';
    empty.appendChild(makeAlertIcon('bellOff', 'alert-icon alert-empty-icon'));
    const title = document.createElement('div');
    title.className = 'alert-empty-title';
    title.textContent = sym ? 'Нет алертов' : 'Выберите тикер для просмотра алертов';
    empty.appendChild(title);
    if (sym) {
      const hint = document.createElement('div');
      hint.className = 'alert-empty-hint';
      hint.textContent = 'Установите ценовую цель — сервер проверяет её каждые 60 секунд, даже при закрытой вкладке';
      empty.appendChild(hint);
      const cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'alert-empty-cta';
      cta.appendChild(makeAlertIcon('plus'));
      const ctaText = document.createElement('span');
      ctaText.textContent = 'Создать алерт';
      cta.appendChild(ctaText);
      cta.addEventListener('click', () => openAlertModal(sym));
      empty.appendChild(cta);
    }
    listWrap.appendChild(empty);
    return;
  }

  // Шапка колонки (над карточками): колокол, тикер, счётчик алертов
  const header = document.createElement('div');
  header.className = 'alerts-col-header';
  header.appendChild(makeAlertIcon('bell'));
  const symSpan = document.createElement('span');
  symSpan.textContent = symbol;
  header.appendChild(symSpan);
  const badge = document.createElement('span');
  badge.className = 'alerts-col-badge';
  badge.textContent = String(allAlerts.length);
  header.appendChild(badge);
  container.appendChild(header);

  const listWrap = document.createElement('div');
  listWrap.className = 'alerts-tab-content';
  container.appendChild(listWrap);

  const statusOrder = { 'active': 1, 'triggered': 2, 'cancelled': 3 };
  allAlerts.sort((a, b) => {
    const byStatus = (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
    if (byStatus !== 0) return byStatus;
    // внутри статуса — новые сверху
    return (b.id || 0) - (a.id || 0);
  });

  // Компактный формат времени (дд.мм чч:мм, без года)
  const fmtTime = (iso) => {
    if (!iso) return '';
    try { return new Date(iso + 'Z').toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  };

  // Группировка: активные отдельно, история (исполнено/отменено) ниже.
  const activeAlerts = allAlerts.filter(a => a.status === 'active');
  const historyAlerts = allAlerts.filter(a => a.status !== 'active');
  const makeGroupLabel = (text) => {
    const label = document.createElement('div');
    label.className = 'alert-group-label';
    const span = document.createElement('span');
    span.textContent = text;
    label.appendChild(span);
    return label;
  };
  if (activeAlerts.length > 0) {
    listWrap.appendChild(makeGroupLabel(`Активные · ${activeAlerts.length} из ${ALERTS_MAX_PER_SYMBOL}`));
  }
  if (historyAlerts.length > 0) {
    listWrap.appendChild(makeGroupLabel('История'));
  }

  // Разметка строится через createElement/appendChild, текст — через
  // textContent (иконки — статичные SVG без пользовательских данных):
  // одинаково работает в реальном DOM и в тестовом мини-DOM, безопасно
  // по XSS. Обработчики — addEventListener вместо inline onclick.
  allAlerts.forEach((alertData) => {
    const status = alertData.status;
    let statusText = '', pillClass = '';
    if (status === 'active') {
      statusText = 'В работе'; pillClass = 'active';
    } else if (status === 'triggered') {
      statusText = 'Исполнено'; pillClass = 'triggered';
    } else {
      statusText = 'Отменено'; pillClass = 'cancelled';
    }
    const cond = alertData.condition === 'below' ? 'below' : 'above';

    const card = document.createElement('div');
    card.className = `alert-card status-${pillClass}`;

    // Верхняя строка: направление, цель, статус-пилюля
    const top = document.createElement('div');
    top.className = 'alert-card-top';
    top.appendChild(makeAlertIcon(cond === 'above' ? 'up' : 'down', `alert-dir ${cond}`));
    const target = document.createElement('span');
    target.className = 'alert-target';
    const condSpan = document.createElement('span');
    condSpan.className = 'alert-cond';
    condSpan.textContent = cond === 'above' ? '≥' : '≤';
    target.appendChild(condSpan);
    target.appendChild(document.createTextNode(' ' + formatPriceAuto(alertData.target)));
    top.appendChild(target);
    const pill = document.createElement('span');
    pill.className = `alert-pill alert-pill--${pillClass}`;
    pill.textContent = statusText;
    top.appendChild(pill);
    card.appendChild(top);

    // Мета-строка: от какой цены / по какой сработал + время
    const meta = document.createElement('div');
    meta.className = 'alert-meta';
    const metaParts = [];
    if (status === 'triggered' && alertData.triggered_price != null) {
      metaParts.push(`сработал по ${formatPriceAuto(alertData.triggered_price)}`);
      const t = fmtTime(alertData.triggered_at || alertData.created_at);
      if (t) metaParts.push(`в ${t}`);
    } else {
      if (alertData.price_at_creation != null) metaParts.push(`от ${formatPriceAuto(alertData.price_at_creation)}`);
      const t = fmtTime(alertData.created_at);
      if (t) metaParts.push(`создан ${t}`);
    }
    if (metaParts.length > 0) meta.textContent = metaParts.join(' · ');
    card.appendChild(meta);

    // Прогресс до цели (активные): сколько осталось до срабатывания.
    // Полоса — оставшееся расстояние в % от текущей цены: тает по мере
    // приближения к цели. Без доступной цены строка скрывается.
    if (status === 'active') {
      const cur = getCurrentPriceForSymbol(alertData.symbol);
      if (Number.isFinite(cur) && cur > 0) {
        const distPct = cond === 'above'
          ? (alertData.target - cur) / cur * 100
          : (cur - alertData.target) / cur * 100;
        const reached = distPct <= 0;
        const row = document.createElement('div');
        // Условие уже выполнено (цена дошла до цели после создания, а сервер
        // ещё не успел пометить алерт исполненным) — показываем предупреждение
        // вместо синего прогресса, чтобы «в работе · цель достигнута» не путало.
        row.className = reached ? 'alert-progress alert-progress--reached' : 'alert-progress';
        const track = document.createElement('div');
        track.className = 'alert-progress-track';
        const fill = document.createElement('div');
        fill.className = 'alert-progress-fill';
        fill.style.width = (reached ? 100 : Math.min(Math.max(distPct, 2), 100)) + '%';
        track.appendChild(fill);
        const label = document.createElement('span');
        label.className = 'alert-progress-label';
        label.textContent = reached
          ? 'цель достигнута · сработает при проверке'
          : `до цели ${distPct >= 0 ? '+' : ''}${formatNumber(distPct, 2)}%`;
        row.appendChild(track);
        row.appendChild(label);
        card.appendChild(row);
      }
    }

    // Действия: активным — изменить/отменить; истории — удалить из списка
    const actions = document.createElement('div');
    actions.className = 'alert-actions';
    if (status === 'active') {
      actions.appendChild(makeAlertIconBtn('pencil', 'Изменить', () => openAlertModal(alertData.symbol, alertData.id)));
      actions.appendChild(makeAlertIconBtn('x', 'Отменить алерт', () => cancelAlert(alertData.id, alertData.symbol), 'alert-icon-btn--danger'));
    } else {
      actions.appendChild(makeAlertIconBtn('trash', 'Удалить из истории', () => deleteAlertById(alertData.id, alertData.symbol), 'alert-icon-btn--danger'));
    }
    card.appendChild(actions);

    // Анимации: slide-in — только впервые показанная карточка,
    // pulse — только при фактическом срабатывании (смена статуса).
    if (!_seenAlertIds.has(alertData.id)) card.classList.add('alert-card--enter');
    const prevStatus = _prevAlertStatus.get(alertData.id);
    if (status === 'triggered' && prevStatus && prevStatus !== 'triggered') {
      card.classList.add('alert-card--just-triggered');
    }
    _seenAlertIds.add(alertData.id);
    _prevAlertStatus.set(alertData.id, status);

    listWrap.appendChild(card);
  });
};

// Отменяет алерт на бэкенде: POST /api/alerts/{id}/cancel (статус 'cancelled',
// запись остаётся в истории). id — первичный ключ строки таблицы price_alerts.
window.cancelAlert = async function(alertId, symbol) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts/${alertId}/cancel`, { method: 'POST' }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`Алерт для ${symbol} отменён`, 'info');
  } catch (e) {
    showToast(`Не удалось отменить алерт: ${e.message}`, 'error');
    return;
  }
  await loadAlertsFromDb();
  renderAlertsList(symbol);
};

// Удаляет алерт по id (DELETE /api/alerts/{id}): используется и кнопкой
// «Удалить» в модалке (активный алерт), и корзиной на карточках истории —
// запись убирается из БД окончательно (в отличие от «Отменить», которое
// оставляет её в истории).
window.deleteAlertById = async function(alertId, symbol) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts/${alertId}`, { method: 'DELETE' }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`Алерт для ${symbol} удалён`, 'info');
  } catch (e) {
    showToast(`Не удалось удалить алерт: ${e.message}`, 'error');
    return;
  }
  _seenAlertIds.delete(alertId); // повторное создание — анимация как у нового
  _prevAlertStatus.delete(alertId);
  await loadAlertsFromDb();
  // renderAlertsTab, а не renderAlertsList: защита от гонки — если во время
  // запроса пользователь выбрал другой тикер, устаревший список не рисуем
  renderAlertsTab(symbol || (getCurrentList() || {}).activeSymbol || '');
};

// Синхронизация статуса алертов с БД после загрузки цен. Проверка условий
// выполняется на сервере (фоновый цикл + этот же endpoint), поэтому здесь мы
// только запрашиваем принудительную проверку и «озвучиваем» новые срабатывания.
window.syncAlertsWithDb = async function() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts/check`, { method: 'POST' }, 20000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const triggered = Array.isArray(data.triggered) ? data.triggered : [];
    for (const t of triggered) {
      const msg = `🚨 ${t.symbol}: Цена ${t.triggered_price} достигла цели (${t.condition === 'above' ? 'выше' : 'ниже'} ${t.target})`;
      playAlertSound();
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Финансовый терминал: Алерт!", { body: msg });
      } else {
        // Нет разрешения на Web Notifications — неблокирующий тост вместо window.alert
        showToast(msg, 'warn', 8000);
      }
      log(`Алерт сработал (проверка бэкенда): ${msg}`, 'success');
    }
    if (triggered.length > 0) {
      await loadAlertsFromDb(); // обновляем колокольчики по новым статусам из БД
      // Колонка «Алерты» видима всегда — мгновенно покажем новые статусы
      if (typeof renderAlertsList === 'function') {
        const cur = getCurrentList();
        if (cur && cur.activeSymbol) renderAlertsList(cur.activeSymbol);
      }
    }
  } catch (e) {
    console.error('Ошибка синхронизации алертов с БД:', e);
  }
};

window.createChart = function(symbol) {
    const chartDiv = document.getElementById('wl-chart-area');
    if (!chartDiv) return;

    // Идемпотентность: повторный вызов с тем же символом (например, из
    // navigateTo, addTicker или перерисовки списка при автообновлении цен)
    // не должен заново перезагружать свечи и новости — это дорого и
    // вызывает мерцание графика. Исключение: прежняя загрузка этого же
    // символа сорвалась (сбой сети) — клик по той же строке повторяет её.
    const sameLoaded = chartDiv.dataset.activeSymbol === symbol
      && typeof window.wlChartIsCurrent === 'function'
      && window.wlChartIsCurrent(symbol);
    if (sameLoaded) return;
    chartDiv.dataset.activeSymbol = symbol;

    // График KLineChart с разметкой и фильтрами (ТФ/тип/индикаторы) —
    // js/watchlist_chart.js: тикер берётся из выбранной строки списка.
    // Пока раздел скрыт, загрузка откладывается внутри wlChartLoad до
    // показа раздела (контейнер без размеров — свечи не раскладываются).
    if (typeof window.wlChartLoad === 'function') {
        window.wlChartLoad(symbol);
    }

    // ЯВНЫЙ ВЫЗОВ НОВОСТЕЙ
    if (typeof window.loadTickerNews === 'function') {
        window.loadTickerNews(symbol);
    } else {
        console.error("❌ [DEBUG] Функция loadTickerNews НЕ НАЙДЕНА!");
    }
};