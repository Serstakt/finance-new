window.formatNumber = function(num, decimals = 2) {
  if (num === null || num === undefined) return '—';
  return num.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

window.formatChange = function(change, isPercent = true) {
  if (change === null || change === undefined) return '<span class="loading">—</span>';
  const sign = change >= 0 ? '+' : '';
  const decimals = isPercent ? 2 : (Math.abs(change) < 1 ? 4 : 2);
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

window.setupColumnHeaders = function() {
  document.querySelectorAll('.column-header').forEach(header => {
    header.addEventListener('click', () => {
      const field = header.dataset.sort;
      if (currentSort.field === field) currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      else { currentSort.field = field; currentSort.direction = 'asc'; }

      document.querySelectorAll('.column-header').forEach(h => {
        h.classList.remove('active');
        h.querySelector('.sort-icon').textContent = '↕';
      });
      header.classList.add('active');
      header.querySelector('.sort-icon').textContent = currentSort.direction === 'asc' ? '↑' : '↓';
      render();
      log(`Сортировка: ${field} (${currentSort.direction === 'asc' ? 'по возрастанию' : 'по убыванию'})`, 'info');
    });
  });
};

// === ВКЛАДКИ «НОВОСТИ / ЗАМЕТКИ» (панель под графиком) ===
// Заметки перенесены из watchlist-строк в блок с новостями: теперь это
// вторая вкладка той же панели. По умолчанию активна вкладка «Новости».
// Выбранная вкладка запоминается в sessionStorage ('bottomTab'), чтобы
// переключение не сбрасывалось при перерисовке списка.
// NOTE_MAX_LEN считается по ВИДИМОМУ тексту без разметки — совпадает с
// лимитом колонки watchlist_items.note (backend/services/watchlist_service.py).
window.NOTE_MAX_LEN = 500;

// Отрисовка содержимого вкладки «Заметки» для выбранного тикера.
// Вкладка — WYSIWYG-редактор (подобие Word): панель форматирования +
// contenteditable-полотно <div id="notes-editor">. Заметка хранится как
// безопасный HTML (бэкенд дополнительно вырезает теги для поиска/лимитов).
// Загрузка чужого HTML недопустима — содержимое прогоняется через санитайзер.
window.renderNotesTab = function(symbol) {
  const editor = document.getElementById('notes-editor');
  const statusEl = document.getElementById('notes-editor-status');
  if (!editor) return;

  const valid = !!symbol && !symbol.startsWith('SECTION:');
  const key = valid ? noteKey(appState.activeListId, symbol) : '';
  const editable = valid && !String(appState.activeListId || '').startsWith('fav_');

  const raw = valid ? (appState.notes[key] || '') : '';
  // Старые заметки хранились как обычный текст (без тегов) — переводим
  // переводы строк в <br>, чтобы они корректно отображались в полотне.
  editor.innerHTML = String(raw).includes('<') ? notesSanitize(raw)
    : escapeHtml(raw).replace(/\n/g, '<br>');
  editor.contentEditable = editable ? 'true' : 'false';
  editor.classList.toggle('disabled', !editable);
  editor.dataset.placeholder = !valid
    ? 'Выберите тикер в списке, чтобы вести заметки'
    : (editable ? 'Здесь можно вести заметки по выбранному тикеру…'
                : 'В цветовых списках заметки не редактируются — откройте обычный список');
  if (statusEl) statusEl.textContent = '';
  // data-empty нужен для плейсхолдера в contenteditable (там нет :placeholder)
  editor.dataset.empty = getNotesSerialize(editor) ? 'false' : 'true';
  updateNotesToolbar();
  // Запоминаем состояние, чтобы автосохранение не сработало на самой загрузке
  window.__notesEditorState = { key, symbol: valid ? symbol : '', value: getNotesSerialize(editor) };
};

// Сериализация полотна заметок: пустое полотно -> '', убираем «мусорные»
// <br> в конце; если видимый текст длиннее NOTE_MAX_LEN — сохраняем только
// первые NOTE_MAX_LEN видимых символов (разметку при этом теряем, но данные
// пользователя важнее форматирования сверх лимита).
function getNotesSerialize(editor) {
  let html = editor.innerHTML;
  if (/^\s*(<br\s*\/?>|&nbsp;|\u00a0)+\s*$/i.test(html)) return '';
  html = html.replace(/(<br\s*\/?>\s*)+$/i, '').trim();
  const plain = (editor.textContent || '').replace(/\u00a0/g, ' ').trim();
  if (!plain) return '';
  if (plain.length > NOTE_MAX_LEN) {
    return escapeHtml(plain.slice(0, NOTE_MAX_LEN)).replace(/\n/g, '<br>');
  }
  return html;
}

// Санитайзер HTML из contenteditable: разрешаем только теги форматирования,
// которые создаёт сам редактор. Неразрешённые теги раскладываем в текст,
// атрибуты снимаем (кроме безобидных у FONT и whitelisted-свойств у SPAN).
const NOTES_ALLOWED_TAGS = new Set(['B','STRONG','I','EM','U','S','STRIKE','FONT','BR','DIV','P','UL','OL','LI','SPAN','BLOCKQUOTE']);
const NOTES_ALLOWED_ATTRS = { FONT: ['color','size','face'], SPAN: ['style'] };
window.notesSanitize = function(html) {
  const doc = (typeof DOMParser !== 'undefined') ? new DOMParser().parseFromString(String(html || ''), 'text/html') : null;
  if (!doc || !doc.body) return escapeHtml(String(html || ''));
  const cleanNode = (node) => {
    const kids = Array.from(node.childNodes);
    for (const child of kids) {
      if (child.nodeType === 3) continue; // текст оставляем как есть
      if (child.nodeType !== 1) { node.removeChild(child); continue; }
      const tag = String(child.tagName || '').toUpperCase();
      if (!NOTES_ALLOWED_TAGS.has(tag)) {
        // неразрешённый тег — заменяем его текстовым содержимым
        const text = doc.createTextNode(child.textContent || '');
        node.replaceChild(text, child);
        continue;
      }
      const allowed = NOTES_ALLOWED_ATTRS[tag] || [];
      for (const attr of Array.from(child.attributes || [])) {
        if (!allowed.includes(String(attr.name).toLowerCase())) child.removeAttribute(attr.name);
      }
      if (tag === 'SPAN' && child.getAttribute && child.getAttribute('style')) {
        const style = String(child.getAttribute('style'));
        // пропускаем только цвет/шрифт/выравнивание — остальное удаляем
        const safe = style.split(';').filter(s => /^(color|font-family|font-size|text-align|background-color)\s*:/i.test(s.trim())).join('; ');
        if (safe.trim()) child.setAttribute('style', safe); else child.removeAttribute('style');
      }
      cleanNode(child);
    }
  };
  cleanNode(doc.body);
  return doc.body.innerHTML;
};

// Подсветка активных кнопок форматирования (как «нажатые» в Word).
// queryCommandState может кидаться в нестандартных окружениях — молча игнорируем.
window.updateNotesToolbar = function() {
  if (typeof document.queryCommandState !== 'function') return;
  document.querySelectorAll('#notes-toolbar button[data-cmd]').forEach(btn => {
    let on = false;
    try { on = document.queryCommandState(btn.dataset.cmd); } catch (e) { on = false; }
    btn.classList.toggle('active', !!on);
  });
};

// Выполнить команду форматирования над выделением в полотне заметок.
window.notesExec = function(cmd) {
  const editor = document.getElementById('notes-editor');
  if (!editor || editor.classList.contains('disabled')) return;
  editor.focus();
  try { document.execCommand(cmd, false, null); } catch (e) { /* команда недоступна */ }
  updateNotesToolbar();
  notesOnInput();
};

// Команда с параметром (шрифт, размер, цвет).
window.notesFormat = function(cmd, value) {
  const editor = document.getElementById('notes-editor');
  if (!editor || editor.classList.contains('disabled') || !value) return;
  editor.focus();
  notesRestoreSel();
  try { document.execCommand(cmd, false, value); } catch (e) { /* команда недоступна */ }
  const sel = cmd === 'fontName' ? 'notes-font-select' : (cmd === 'fontSize' ? 'notes-size-select' : null);
  const selEl = sel && document.getElementById(sel);
  if (selEl) selEl.value = '';
  updateNotesToolbar();
  notesOnInput();
};

// Выбор цвета: нативный color-input уводит фокус/выделение из полотна —
// сохраняем диапазон перед открытием и восстанавливаем перед применением.
window.notesSaveSel = function() {
  const sel = (typeof window.getSelection === 'function') ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return;
  const editor = document.getElementById('notes-editor');
  if (editor && editor.contains && editor.contains(sel.anchorNode)) {
    window.__notesSavedRange = sel.getRangeAt(0).cloneRange();
  }
};
window.notesRestoreSel = function() {
  const r = window.__notesSavedRange;
  if (!r || typeof window.getSelection !== 'function') return;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (e) { /* ignore */ }
};

// Автосохранение из WYSIWYG-полотна заметок: пользователь печатает/форматирует —
// изменения пишутся в кэш appState.notes и в БД (setNoteInDb) с дебаунсом.
// Пустой текст очищает заметку. Ctrl+S сохраняет немедленно.
let __notesSaveTimer = null;
window.notesDoSave = async function() {
  const editor = document.getElementById('notes-editor');
  const st = window.__notesEditorState;
  if (!editor || !st || !st.key || editor.classList.contains('disabled')) return;
  const html = getNotesSerialize(editor);
  if (html === st.value) return; // ничего не изменилось
  st.value = html;
  if (html) appState.notes[st.key] = html;
  else delete appState.notes[st.key];
  const setStatus = (text, cls) => {
    const el = document.getElementById('notes-editor-status');
    if (!el) return;
    el.textContent = text;
    el.className = cls || '';
  };
  setStatus('Сохраняю…', 'saving');
  const [listId] = st.key.split('|');
  const saved = await setNoteInDb(listId, st.symbol, html || null);
  if (saved) setStatus(html ? '💾 Сохранено' : '🗑 Заметка очищена', 'saved');
  else setStatus('⚠ Не удалось сохранить в БД — изменения только локально', 'error');
  setTimeout(() => setStatus('', ''), 2500);
};

// Общий обработчик «изменение в полотне»: обновляем видимость плейсхолдера
// (в contenteditable нет нативного placeholder) и ставим автосохранение в очередь.
window.notesOnInput = function() {
  const editor = document.getElementById('notes-editor');
  if (editor) editor.dataset.empty = getNotesSerialize(editor) ? 'false' : 'true';
  clearTimeout(__notesSaveTimer);
  __notesSaveTimer = setTimeout(() => notesDoSave(), 600);
};

window.initNotesEditor = function() {
  const editor = document.getElementById('notes-editor');
  if (!editor || editor.dataset.initialized === '1') return;
  editor.dataset.initialized = '1';

  editor.addEventListener('input', notesOnInput);
  editor.addEventListener('paste', (e) => {
    // Вставляем только текст — иначе чужой HTML (стили/скрипты) попадёт в полотно
    e.preventDefault();
    const text = ((e.clipboardData || {}).getData) ? e.clipboardData.getData('text/plain') : '';
    try { document.execCommand('insertText', false, text); } catch (err) { /* ignore */ }
    notesOnInput();
  });
  editor.addEventListener('keyup', updateNotesToolbar);
  editor.addEventListener('mouseup', updateNotesToolbar);
  editor.addEventListener('blur', () => {
    clearTimeout(__notesSaveTimer);
    notesDoSave();
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      clearTimeout(__notesSaveTimer);
      notesDoSave();
    }
  });
};

// Переключение вкладок «Новости» / «Избранные Новости» / «Заметки» / «Алерты».
window.switchBottomTab = function(tab) {
  tab = (tab === 'notes' || tab === 'news-fav' || tab === 'alerts') ? tab : 'news';
  // Вкладка «Избранные» существует только пока есть избранное — если с неё
  // сняли последний флажок, возвращаемся на «Новости».
  const favBtn = document.getElementById('news-fav-tab-btn');
  if (tab === 'news-fav' && favBtn && favBtn.style.display === 'none') tab = 'news';
  sessionStorage.setItem('bottomTab', tab);
  const newsPanel = document.getElementById('news-panel');
  const newsList = document.getElementById('news-list');
  const notesList = document.getElementById('notes-list');
  const newsFavList = document.getElementById('news-fav-list');
  const alertsList = document.getElementById('alerts-list');
  if (!newsPanel || !newsList || !notesList) return;

  newsPanel.style.display = 'flex';
  newsList.style.display = tab === 'news' ? 'block' : 'none';
  if (newsFavList) newsFavList.style.display = tab === 'news-fav' ? 'block' : 'none';
  if (alertsList) alertsList.style.display = tab === 'alerts' ? 'block' : 'none';
  // для #notes-list базовый display задаёт CSS (flex — полотно растягивается)
  notesList.style.display = tab === 'notes' ? '' : 'none';

  document.querySelectorAll('#bottom-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const nwBtn = document.getElementById('news-refresh-btn');
  if (nwBtn) nwBtn.style.display = tab === 'news' ? '' : 'none';
  // Кнопка добавления алерта (перенесена с колокольчика в строках списка
  // тикеров) видна только на вкладке «Алерты».
  const addAlertBtn = document.getElementById('add-alert-btn');
  if (addAlertBtn) addAlertBtn.style.display = tab === 'alerts' ? '' : 'none';

  if (tab === 'notes') {
    initNotesEditor(); // вешаем автосохранение при первом открытии вкладки
    const cur = getCurrentList();
    renderNotesTab(cur ? cur.activeSymbol : '');
  }
  if (tab === 'alerts') {
    const cur = getCurrentList();
    renderAlertsTab(cur ? cur.activeSymbol : '');
  }
  if (tab === 'news-fav' && typeof renderNewsFavoritesTab === 'function') {
    // Избранное индивидуально по тикерам: при открытии вкладки перерисовываем
    // её под текущий выбранный тикет (в т.ч. после смены символа, когда
    // вкладка была скрыта). Кэш внутри функции сам определит устаревание.
    renderNewsFavoritesTab(true);
  }
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

// Создание каркаса строки тикера (структура строится один раз; дальше —
// только точечное обновление текстов/классов в updateRow).
window.buildRowElement = function(sym) {
  const div = document.createElement('div');
  div.className = 'ticker-item';
  div.dataset.symbol = sym;
  const safeId = sym.replace(/[^a-zA-Z0-9]/g, '_');
  const parts = sym.split(':');
  const baseTicker = parts.length > 1 ? parts[1] : sym;
  const smartLabUrl = `https://smart-lab.ru/forum/${baseTicker}/`;

  div.innerHTML = `
    <span class="drag-handle" title="Перетащить">⋮</span>
    <div class="favorite-wrapper" onclick="toggleFavoritePicker('${escapeHtml(sym)}', event)" title="Флажок избранного">
      <span class="favorite-flag empty" style="color: #363a45">⚑</span>
      <div class="favorite-picker">
        <span onclick="event.stopPropagation(); setFavorite('${escapeHtml(sym)}', 'red')" style="color:#ef5350" title="Красный">🔴</span>
        <span onclick="event.stopPropagation(); setFavorite('${escapeHtml(sym)}', 'blue')" style="color:#2962ff" title="Синий">🔵</span>
        <span onclick="event.stopPropagation(); setFavorite('${escapeHtml(sym)}', 'yellow')" style="color:#ffca28" title="Желтый">🟡</span>
        <span onclick="event.stopPropagation(); setFavorite('${escapeHtml(sym)}', 'orange')" style="color:#ff9800" title="Оранжевый">🟠</span>
        <span onclick="event.stopPropagation(); setFavorite('${escapeHtml(sym)}', 'green')" style="color:#26a69a" title="Зеленый">🟢</span>
      </div>
    </div>
    <div class="ticker-logo-container"></div>
    <div class="ticker-info">
      <a href="${smartLabUrl}" target="_blank" rel="noopener noreferrer" class="ticker-symbol-link" title="Открыть ${escapeHtml(baseTicker)} на Smart-Lab" onclick="event.stopPropagation();">${escapeHtml(baseTicker)}</a>
    </div>
    <div class="ticker-price" id="price-${safeId}"><div class="skeleton skeleton-price"></div></div>
    <div class="ticker-change" id="change-val-${safeId}"><div class="skeleton skeleton-change"></div></div>
    <div class="ticker-change-percent" id="change-pct-${safeId}"><div class="skeleton skeleton-change-pct"></div></div>
    <span class="ticker-remove" data-symbol="${escapeHtml(sym)}" title="Удалить">×</span>`;

  // Клик по строке — выбор активного тикера. Вешается ОДИН раз на весь срок
  // жизни узла (раньше слушатель создавался при каждой перерисовке).
  div.addEventListener('click', (e) => {
    if (e.target.classList.contains('ticker-remove') || e.target.classList.contains('drag-handle') ||
        e.target.classList.contains('ticker-symbol-link') || e.target.closest('.favorite-wrapper')) return;
    const cur = getCurrentList();
    cur.activeSymbol = sym;
    setActiveSymbolInDb(appState.activeListId, sym); // выбор тикера — в БД (watchlists.active_symbol)
    createChart(sym);
    document.querySelectorAll('.ticker-item').forEach(el => el.classList.remove('active'));
    div.classList.add('active');
  });

  div.querySelector('.ticker-remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    const cur = getCurrentList();
    if (appState.activeListId.startsWith('fav_')) {
      setFavorite(sym, null);
    } else {
      cur.tickers = cur.tickers.filter(s => s !== sym);
      if (cur.activeSymbol === sym) {
        cur.activeSymbol = cur.tickers.find(s => !s.startsWith('SECTION:')) || '';
        setActiveSymbolInDb(appState.activeListId, cur.activeSymbol); // выбор живёт в БД — обновляем сразу
      }
      render();
      await removeTickerFromDb(appState.activeListId, sym); // удаляем из БД
    }
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

  const newSig = dataSig(data);
  const changed = newSig !== prev.sig;
  const wasError = prev.sig === 'ERR';
  const isError = newSig === 'ERR';

  if (changed) {
    if (data && data.price) {
      priceEl.textContent = formatNumber(data.price);
      // flash-подсветка только при переходе цена->цена (не при первом появлении)
      if (prev.sig !== 'INIT' && !wasError) {
        priceEl.classList.remove('price-flash');
        void priceEl.offsetWidth; // рестарт CSS-анимации
        priceEl.classList.add('price-flash');
      }
      if (data.changeValue !== undefined && data.changeValue !== null) {
        changeValEl.innerHTML = formatChange(data.changeValue, false);
        changeValEl.className = `ticker-change ${data.changeValue >= 0 ? 'positive-bg' : 'negative-bg'}`;
      } else {
        changeValEl.innerHTML = '<span class="error-text">—</span>';
        changeValEl.className = 'ticker-change';
      }
      if (data.changeDay !== undefined && data.changeDay !== null) {
        changePctEl.innerHTML = formatChange(data.changeDay, true);
        changePctEl.className = `ticker-change-percent ${data.changeDay >= 0 ? 'positive-bg' : 'negative-bg'}`;
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
  const parts = sym.split(':');
  const baseTicker = parts.length > 1 ? parts[1] : sym;
  const logoContainer = div.querySelector('.ticker-logo-container');
  const wantLogo = buildLogoHtml(sym, baseTicker, data);
  if (wantLogo !== prev.logoHtml) {
    logoContainer.innerHTML = wantLogo;
    prev.logoHtml = wantLogo;
  }

  // Флажок избранного
  const wrapper = div.querySelector('.favorite-wrapper');
  const flagEl = wrapper.querySelector('.favorite-flag');
  const flagColor = appState.favorites[sym] || null;
  const flagHex = flagColor ? FLAG_COLORS[flagColor].hex : '#363a45';
  const flagCls = 'favorite-flag' + (flagColor ? '' : ' empty');
  if (flagColor !== prev.flag) {
    flagEl.style.color = flagHex;
    flagEl.className = flagCls;
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
    prev.active = isActive;
  }
};

// Каркас секции создаётся один раз; обработчики живут на самом узле.
window.buildSectionElement = function(sym) {
  const div = document.createElement('div');
  div.className = 'section-header';
  div.dataset.symbol = sym;
  const sectionName = sym.replace('SECTION:', '');
  div.innerHTML = `
    <span class="drag-handle" title="Перетащить">⋮</span>
    <span class="section-collapse-btn" title="Свернуть/Развернуть">▼</span>
    <span class="section-title" title="Дважды кликните, чтобы переименовать">${escapeHtml(sectionName)}</span>
    <span class="ticker-remove" data-symbol="${escapeHtml(sym)}" title="Удалить раздел">×</span>`;

  div.querySelector('.section-collapse-btn').addEventListener('click', (e) => {
    e.stopPropagation();
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
  });

  div.querySelector('.ticker-remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Удалить раздел "${sectionName}"?`)) {
      const cur = getCurrentList();
      cur.tickers = cur.tickers.filter(s => s !== sym);
      if (cur.collapsedSections) cur.collapsedSections = cur.collapsedSections.filter(s => s !== sym);
      render();
      await saveOrderToDb(appState.activeListId, cur.tickers); // удаляем из БД
    }
  });

  div.querySelector('.section-title').addEventListener('dblclick', async () => {
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
  });

  return div;
};

window.updateSectionElement = function(div, sym, list) {
  const collapsed = !!(list.collapsedSections && list.collapsedSections.includes(sym));
  div.classList.toggle('collapsed', collapsed);
  const btn = div.querySelector('.section-collapse-btn');
  const arrow = collapsed ? '▶' : '▼';
  if (btn.textContent !== arrow) btn.textContent = arrow;
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
  const cacheMap = window.__rowsCache.map;

  // Запрашиваем цены ПАРАЛЛЕЛЬНО (с таймаутом в fetchTickerData).
  // Последовательный await для каждого тикера складывал задержки: при медленном
  // внешнем API список «загружался» бесконечно долго.
  const dataMap = {};
  const symbols = currentList.tickers.filter(s => !s.startsWith('SECTION:'));
  const results = await Promise.all(symbols.map(sym => fetchTickerData(sym)));
  symbols.forEach((sym, i) => { dataMap[sym] = results[i]; });

  // Пока ждали ответа API, пользователь мог переключить список — не рисуем
  // устаревшие данные в чужой DOM (иначе цены «переехали» бы между списками).
  if (window.__rowsCache.listId !== appState.activeListId) return;

  const sortedList = sortList(currentList.tickers, dataMap);

  if (sortedList.length > 0 && !currentList.activeSymbol) {
    const firstTicker = sortedList.find(s => !s.startsWith('SECTION:'));
    if (firstTicker) {
      currentList.activeSymbol = firstTicker;
      setActiveSymbolInDb(appState.activeListId, firstTicker); // выбор — в БД, иначе потеряется после перезагрузки
    }
  }

  // === KEYED DIFF: узлы создаются один раз, дальше только точечные правки ===
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
  if (symbols.some(s => dataMap[s] && dataMap[s].price)) {
    clearTimeout(window.__alertSyncTimer);
    window.__alertSyncTimer = setTimeout(() => { syncAlertsWithDb(); }, 1500);
  }

  // График: пересоздаём TradingView-виджет только при СМЕНЕ активного тикера.
  // При автообновлении цен/сортировке вызов createChart с тем же символом
  // приводил к лишним setSymbol/реконструкциям iframe — теперь это исключено.
  const chartDiv = document.getElementById('tradingview_chart');
  if (chartDiv) {
    if (currentList.activeSymbol && !currentList.activeSymbol.startsWith('SECTION:')) {
      if (chartDiv.dataset.activeSymbol !== currentList.activeSymbol) {
        chartDiv.dataset.activeSymbol = currentList.activeSymbol;
        createChart(currentList.activeSymbol);
      }
    } else {
      delete chartDiv.dataset.activeSymbol;
      chartDiv.innerHTML = '<div class="error-msg" style="display:flex;align-items:center;justify-content:center;height:100%;">Добавьте тикер в список</div>';
    }
  }

  // Панель «Новости / Заметки / Алерты»: синхронизируем полотно заметок и
  // список алертов с выбранным тикером (они могли измениться/переехать
  // вместе со списком).
  const bottomTab = sessionStorage.getItem('bottomTab');
  if (bottomTab === 'notes' && currentList.activeSymbol) {
    const np = document.getElementById('news-panel');
    if (np) np.style.display = 'flex';
    renderNotesTab(currentList.activeSymbol);
  }
  if (bottomTab === 'alerts') {
    const np = document.getElementById('news-panel');
    if (np) np.style.display = 'flex';
    renderAlertsTab(currentList.activeSymbol || '');
  }
};

// === АЛЕРТЫ UI ===
// Алерты хранятся на бэкенде в таблице price_alerts (SQLite) и проверяются
// фоновым циклом сервера — теперь они срабатывают даже при закрытой вкладке.
// Фронтенд только: загружает список через GET /api/alerts в кеш
// window.dbAlerts, отправляет изменения (POST/DELETE) и по кешу рисует
// колокольчики. localStorage 'price_alerts' больше не является источником
// истины — из него выполняется одноразовая миграция в БД.

window.dbAlerts = []; // актуальный снимок алертов из БД (для колокольчиков и модалок)

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

window.openAlertModal = async function(symbol) {
  currentAlertSymbol = symbol;
  document.getElementById('alert-symbol-name').textContent = symbol;
  document.getElementById('alert-modal').classList.add('active');

  // Подтягиваем свежие данные из БД, затем показываем активный алерт (если есть)
  await loadAlertsFromDb();
  if (currentAlertSymbol !== symbol) return; // модалку успели закрыть/переключить
  const existingAlert = (window.dbAlerts || []).find(a => a.symbol === symbol && a.status === 'active');

  const deleteBtn = document.getElementById('alert-delete-btn');
  if (existingAlert) {
    document.getElementById('alert-condition').value = existingAlert.condition;
    document.getElementById('alert-target-price').value = existingAlert.target;
    deleteBtn.style.display = 'block';
  } else {
    document.getElementById('alert-condition').value = 'above';
    document.getElementById('alert-target-price').value = '';
    deleteBtn.style.display = 'none';
  }
};

window.closeAlertModal = function() {
  document.getElementById('alert-modal').classList.remove('active');
  currentAlertSymbol = null;
};

// Сохраняет алерт в БД через POST /api/alerts (бэкенд сам проверяет условия).
window.saveAlert = async function() {
  if (!currentAlertSymbol) return;
  const condition = document.getElementById('alert-condition').value;
  const target = parseFloat(document.getElementById('alert-target-price').value);

  if (isNaN(target) || target <= 0) {
    window.alert('Пожалуйста, введите корректную целевую цену.');
    return;
  }

  try {
    // Текущая цена из отрисованной строки тикера — сохраняем на сервере как
    // «от какой цены ждали срабатывания» (поле price_at_creation)
    const safeId = currentAlertSymbol.replace(/[^a-zA-Z0-9]/g, '_');
    const priceEl = document.getElementById(`price-${safeId}`);
    const currentPrice = priceEl ? parseFloat(String(priceEl.textContent).replace(/\s|'/g, '').replace(',', '.')) : NaN;
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: currentAlertSymbol,
        condition: condition,
        target: target,
        price_at_creation: isNaN(currentPrice) ? null : currentPrice
      })
    }, 15000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    log(`Алерт сохранён в БД для ${currentAlertSymbol}: ${condition} ${target}`, 'success');
    closeAlertModal();
    await loadAlertsFromDb(); // мгновенно обновляем колокольчик по данным из БД
    // Если открыта вкладка «Алерты» — перерисовываем её под этот тикер
    if (sessionStorage.getItem('bottomTab') === 'alerts') renderAlertsList(currentAlertSymbol);
  } catch (e) {
    log(`Ошибка сохранения алерта: ${e.message}`, 'error');
    window.alert('Не удалось сохранить алерт: ' + e.message);
  }
};

// Удаляет активный алерт символа из БД (DELETE /api/alerts/{id}).
window.deleteAlert = async function() {
  if (!currentAlertSymbol) return;
  const active = (window.dbAlerts || []).find(a => a.symbol === currentAlertSymbol && a.status === 'active');
  if (active) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/alerts/${active.id}`, { method: 'DELETE' }, 15000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log(`Алерт для ${currentAlertSymbol} удален из БД`, 'info');
    } catch (e) {
      log(`Ошибка удаления алерта: ${e.message}`, 'error');
      window.alert('Не удалось удалить алерт: ' + e.message);
      return;
    }
  }
  const deletedSymbol = currentAlertSymbol;
  closeAlertModal();
  await loadAlertsFromDb();
  if (sessionStorage.getItem('bottomTab') === 'alerts') renderAlertsList(deletedSymbol);
};

window.openAlertsListModal = async function() {
  // Кнопка «🔔 Алерты» перенесена во вкладку «Алерты» нижней панели —
  // совместимость на случай старого вызова: просто переключаемся на вкладку.
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    window.alert('Сначала выберите тикер в списке!');
    return;
  }
  switchBottomTab('alerts');
};

// Кнопка «+ Добавить» на вкладке «Алерты» (перенесена с колокольчика из
// строк списка тикеров): открывает модалку ценового уведомления для
// выбранного тикера.
window.openAddAlertForActiveSymbol = async function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    window.alert('Сначала выберите тикер в списке!');
    return;
  }
  await openAlertModal(symbol);
};

// Рендер содержимого вкладки «Алерты»: список алертов ВЫБРАННОГО тикера
// (бывшая модалка «📋 Алерты для …»). При пустом кеше алертов тянем свежие
// данные из БД, затем рисуем список и заголовок с символом.
window.renderAlertsTab = async function(symbol) {
  const container = document.getElementById('alerts-list');
  if (!container) return;
  if (!symbol || symbol.startsWith('SECTION:')) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #787b86;">Выберите тикер для просмотра алертов</div>';
    return;
  }
  // Свежие статусы из БД (активные/сработавшие/отменённые)
  if (!(window.dbAlerts || []).length) await loadAlertsFromDb();
  // Пока грузили данные, выбранный тикер мог смениться — не рисуем устаревшее
  const cur = getCurrentList();
  if ((cur && cur.activeSymbol) !== symbol) return;
  renderAlertsList(symbol);
};

window.renderAlertsList = function(symbol) {
  const alerts = window.dbAlerts || [];
  const symbolAlerts = alerts.filter(a => a.symbol === symbol);
  const container = document.getElementById('alerts-list');
  if (!container) return;
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'alerts-tab-header';
  header.innerHTML = `📋 Алерты для <span style="color: #2962ff;">${escapeHtml(symbol)}</span>`;
  container.appendChild(header);

  const listWrap = document.createElement('div');
  listWrap.className = 'alerts-tab-content';
  container.appendChild(listWrap);

  if (symbolAlerts.length === 0) {
    listWrap.innerHTML = '<div style="text-align:center; color:#787b86; padding:20px;">Нет алертов для этого тикера</div>';
    return;
  }

  const statusOrder = { 'active': 1, 'triggered': 2, 'cancelled': 3 };
  symbolAlerts.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const fmtTime = (iso) => {
    if (!iso) return '';
    try { return new Date(iso + 'Z').toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  };

  symbolAlerts.forEach((alertData) => {
    const status = alertData.status;
    let statusText = '', statusClass = '', actionBtn = '';

    if (status === 'active') {
      statusText = '🟢 В работе'; statusClass = 'status-active';
      actionBtn = `<button class="mini-btn" onclick="cancelAlert(${alertData.id}, '${symbol}')">Отменить</button>`;
    } else if (status === 'triggered') {
      statusText = '✅ Исполнено'; statusClass = 'status-triggered';
    } else {
      statusText = '⛔ Отменено'; statusClass = 'status-cancelled';
    }

    const conditionText = alertData.condition === 'above' ? '≥' : '≤';
    const created = fmtTime(alertData.created_at);
    const triggeredInfo = status === 'triggered' && alertData.triggered_price != null
      ? ` · по цене ${alertData.triggered_price}` : '';
    const div = document.createElement('div');
    div.className = `alert-list-item ${statusClass}`;
    div.innerHTML = `
      <div class="alert-item-info">
        <span class="alert-item-condition">${conditionText} ${alertData.target}</span>
        <span class="alert-status ${statusClass}">${statusText}${triggeredInfo}</span>
        ${created ? `<span style="color:#787b86; font-size:11px;">${created}</span>` : ''}
      </div>
      ${actionBtn}`;
    listWrap.appendChild(div);
  });
};

// Отменяет алерт на бэкенде: POST /api/alerts/{id}/cancel (статус 'cancelled',
// запись остаётся в истории). id — первичный ключ строки таблицы price_alerts.
window.cancelAlert = async function(alertId, symbol) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/alerts/${alertId}/cancel`, { method: 'POST' }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`Алерт #${alertId} для ${symbol} отменен (БД)`, 'info');
  } catch (e) {
    log(`Ошибка отмены алерта: ${e.message}`, 'error');
    return;
  }
  await loadAlertsFromDb();
  renderAlertsList(symbol);
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
        window.alert(msg);
      }
      log(`Алерт сработал (проверка бэкенда): ${msg}`, 'success');
    }
    if (triggered.length > 0) {
      await loadAlertsFromDb(); // обновляем колокольчики по новым статусам из БД
      // Если пользователь смотрит вкладку «Алерты» — мгновенно покажем новые статусы
      if (sessionStorage.getItem('bottomTab') === 'alerts' && typeof renderAlertsList === 'function') {
        const cur = getCurrentList();
        if (cur && cur.activeSymbol) renderAlertsList(cur.activeSymbol);
      }
    }
  } catch (e) {
    console.error('Ошибка синхронизации алертов с БД:', e);
  }
};

window.createChart = function(symbol) {
    console.log("📊 [DEBUG] createChart вызвана для:", symbol);
    const chartDiv = document.getElementById('tradingview_chart');
    if (!chartDiv) return;

    // Идемпотентность: повторный вызов с тем же символом (например, из
    // navigateTo или addTicker для уже открытого тикера) не должен заново
    // дёргать widget.setSymbol и перезагружать новости — это дорого и
    // вызывает мерцание графика.
    if (chartDiv.dataset.activeSymbol === symbol && (window.widget || typeof TradingView === 'undefined')) return;
    chartDiv.dataset.activeSymbol = symbol;

    if (typeof TradingView === 'undefined') {
        chartDiv.innerHTML = '<div class="error-msg">⚠️ Ошибка загрузки скрипта TradingView.</div>';
        return;
    }

    if (window.widget && window.widgetReady) {
        window.widget.setSymbol(symbol, 'D', () => {});
    } else {
        chartDiv.innerHTML = '';
        window.widget = new TradingView.widget({
            "autosize": true,
            "symbol": symbol,
            "interval": "D",
            "timezone": "Etc/UTC",
            "theme": "dark",
            "style": "1",
            "locale": "ru",
            "toolbar_bg": "#1e222d",
            "enable_publishing": false,
            "hide_top_toolbar": false,
            "hide_legend": false,
            "save_image": false,
            "container_id": "tradingview_chart",
            "onready": () => {
                window.widgetReady = true;
                // Разметка поверх графика (chart_overlay.js): перерисовать по
                // новой шкале и подписать события перерисовки виджета.
                if (typeof window.subscribeMarkupSync === 'function') {
                    window.subscribeMarkupSync();
                    window.drawMarkup();
                }
            }
        });
    }

    // Разметка: подгружаем объекты нового символа (localStorage + БД)
    if (typeof window.refreshMarkupForSymbol === 'function') {
        window.refreshMarkupForSymbol(symbol);
    }

    // ЯВНЫЙ ВЫЗОВ НОВОСТЕЙ
    if (typeof window.loadTickerNews === 'function') {
        console.log("✅ [DEBUG] Вызываем loadTickerNews для:", symbol);
        window.loadTickerNews(symbol);
    } else {
        console.error("❌ [DEBUG] Функция loadTickerNews НЕ НАЙДЕНА!");
    }
};