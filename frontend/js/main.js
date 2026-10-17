// === ИНИЦИАЛИЗАЦИЯ И СОБЫТИЯ ===

// Одноразовый перенос устаревшего дубликата состояния из localStorage
// ('multi_watchlists_state' / 'my_watchlist') в БД. Ключи удаляются ТОЛЬКО
// после успешной записи на сервер — при недоступном бэкенде данные не теряются
// и миграция повторится при следующем старте. После удаления второй источник
// истины физически исчезает: рассинхроны «дубль в браузере vs данные в БД»
// становятся невозможны по построению.
window.runLegacyMigration = async function() {
  const hasLegacy = (() => {
    try {
      return !!(localStorage.getItem(window.STORAGE_KEY) || localStorage.getItem('my_watchlist'));
    } catch (e) { return false; }
  })();
  if (!hasLegacy) return;
  const legacy = readLegacyState();
  if (!legacy) { window.removeLegacyStorageKeys(); return; } // битый JSON — мигрировать нечего
  const ok = await migrateLegacyStateToDb(legacy);
  if (ok) {
    window.removeLegacyStorageKeys();
    log('Состояние из localStorage перенесено в БД — ключ multi_watchlists_state удалён', 'info');
  } else {
    log('Не удалось полностью перенести состояние из localStorage в БД — данные сохранены локально, миграция повторится при следующем запуске', 'error');
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  loadState();
  setupColumnHeaders();
  startAutoRefresh();
  requestNotificationPermission();

  // Алерты: сначала переносим старые клиентские алерты из localStorage
  // в таблицу price_alerts (однократно), затем загружаем актуальный снимок
  // из БД — по нему рисуется вкладка «Алерты» (индикаторов в строках нет).
  await runLegacyMigration(); // watchlist-дубликат localStorage -> БД (однократно)
  await migrateAlertsToDb();
  await loadAlertsFromDb();

  // Загружаем списки (названия и тикеры) из БД — источник истины не localStorage
  await loadListNamesFromDb();
  // Флажки (избранное) тянем из колонки watchlist_items.flag_color — так
  // избранное восстанавливается даже в чистом браузере без localStorage.
  await loadFlagsFromDb();
  // Заметки к тикерам — из колонки watchlist_items.note (GET /api/watchlist-notes),
  // чтобы иконки 📝 отрисовались сразу при первой перерисовке списка.
  await loadNotesFromDb();
  syncListWithDb(appState.activeListId);

  // Избранные новости: подтягиваем флажки из БД (news_favorites) — и общий
  // снимок (видимость вкладки «🚩 Избранные»), и по выбранному тикеру
  // (избранное индивидуально: у каждого тикета свой список).
  if (typeof window.loadNewsAllFavorites === 'function') {
    window.loadNewsAllFavorites().catch(() => {});
  }
  const _initSym = getCurrentList() && getCurrentList().activeSymbol;
  if (typeof window.loadNewsFavorites === 'function' && _initSym) {
    window.loadNewsFavorites(_initSym).catch(() => {});
  }

  const savedPage = sessionStorage.getItem('activePage') || 'home';
  navigateTo(savedPage);
});

window.navigateTo = function(pageName) {
  sessionStorage.setItem('activePage', pageName);
  document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
  const targetPage = document.getElementById(`${pageName}-page`);
  if (targetPage) targetPage.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.page === pageName) btn.classList.add('active');
  });

  if (pageName === 'watchlist') {
    render();
    // При открытии раздела названия и тикеры списков подтягиваются из БД,
    // а не из localStorage. Флажки (избранное) и заметки — тоже из БД
    // (watchlist_items.flag_color / watchlist_items.note).
    loadListNamesFromDb().then(loadFlagsFromDb).then(loadNotesFromDb).then(() => syncListWithDb(appState.activeListId));
    const currentList = getCurrentList();
    if (currentList.activeSymbol && !currentList.activeSymbol.startsWith('SECTION:')) {
      setTimeout(() => { if (!widget) createChart(currentList.activeSymbol); }, 100);
    }
  }
  log(`Переход на страницу: ${pageName}`, 'info');
};

window.openSmartLabNews = function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    window.alert('Сначала выберите тикер в списке!');
    return;
  }
  const baseTicker = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  window.open(`https://smart-lab.ru/forum/news/${baseTicker}/`, '_blank');
  log(`Открыты новости Smart-Lab для: ${baseTicker}`, 'info');
};

window.addNewList = async function() {
  const name = prompt('Введите название нового списка:', 'Новый список');
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const id = 'list_' + Date.now();

  // Сначала гарантированно регистрируем список в БД (таблица watchlists),
  // и только потом показываем его в UI. Так невозможно состояние, когда
  // список «есть на экране», но в БД его нет или он сохранился с заглушкой.
  log(`Сохраняю список "${trimmed}" в БД...`, 'info');
  const saved = await createListInDb(id, trimmed);
  if (!saved) {
    log(`Не удалось создать список "${trimmed}" в БД — список не создан. Проверьте, что сервер запущен, и повторите.`, 'error');
    return;
  }

  appState.lists[id] = { name: trimmed, tickers: [], activeSymbol: '', collapsedSections: [] };
  populateListSelector();
  switchList(id);
  log(`Создан список: ${trimmed} (сохранен в БД)`, 'success');
};

window.renameList = async function() {
  if (appState.activeListId.startsWith('fav_')) {
    window.alert('Этот список управляется автоматически через флажки.');
    return;
  }
  const currentList = getCurrentList();
  const newName = prompt('Введите новое название списка:', currentList.name);
  if (!newName || newName.trim() === '' || newName.trim() === currentList.name) return;
  currentList.name = newName.trim();
  populateListSelector();
  // Сохраняем новое название в БД (watchlist.name) — при следующей загрузке
  // раздела данные будут тянуться из БД
  const saved = await renameListInDb(appState.activeListId, currentList.name);
  if (saved) log(`Список переименован: "${currentList.name}" (название сохранено в БД)`, 'success');
  else log(`Список переименован локально: "${currentList.name}", но сохранить название в БД не удалось`, 'error');
};

window.deleteCurrentList = async function() {
  if (appState.activeListId.startsWith('fav_')) {
    window.alert('Этот список управляется автоматически через флажки.');
    return;
  }
  const listIds = Object.keys(appState.lists);
  if (listIds.length <= 1) { window.alert('Нельзя удалить последний список!'); return; }
  const deletedId = appState.activeListId;
  const currentName = getCurrentList().name;
  if (!confirm(`Удалить список "${currentName}"?`)) return;
  delete appState.lists[deletedId];
  appState.activeListId = listIds.find(id => id !== deletedId);
  try { sessionStorage.setItem(window.UI_STATE_KEY, appState.activeListId); } catch (e) {}
  populateListSelector();
  render();
  // Удаляем список и его тикеры из БД
  await deleteListInDb(deletedId);
  syncListWithDb(appState.activeListId);
  log(`Удален список: ${currentName}`, 'info');
};

// === ЗАМЕТКИ К ТИКЕРАМ ===
// Заметка («почему слежу за тикером») хранится в колонке watchlist_items.note,
// источник истины — БД. Редактирование доступно только во вкладке «Заметки»
// под графиком: там нет кнопок и prompt-диалогов — вместо них единое текстовое
// полотно (<textarea id="notes-editor">) с автосохранением (см. renderNotesTab
// и initNotesEditor в ui.js). NOTE_MAX_LEN объявлен в ui.js
// (window.NOTE_MAX_LEN) и используется полотном заметок.
const NOTE_MAX_LEN = window.NOTE_MAX_LEN || 500; // совпадает с backend/services/watchlist_service.py

window.toggleFavoritePicker = function(symbol, event) {
  event.stopPropagation();
  const currentColor = appState.favorites[symbol];
  if (currentColor) {
    setFavorite(symbol, null);
  } else {
    if (activePickerSymbol === symbol) { activePickerSymbol = null; }
    else { activePickerSymbol = symbol; }
    render();
  }
};

window.setFavorite = function(symbol, color) {
  const oldColor = appState.favorites[symbol];
  if (oldColor) {
    const oldListId = `fav_${oldColor}`;
    if (appState.lists[oldListId]) {
      appState.lists[oldListId].tickers = appState.lists[oldListId].tickers.filter(s => s !== symbol);
    }
  }
  if (color) {
    appState.favorites[symbol] = color;
    const newListId = `fav_${color}`;
    if (!appState.lists[newListId]) {
      appState.lists[newListId] = { name: `${FLAG_COLORS[color].icon} ${FLAG_COLORS[color].name}`, tickers: [], activeSymbol: '', collapsedSections: [], isFavoriteList: true };
    }
    if (!appState.lists[newListId].tickers.includes(symbol)) {
      appState.lists[newListId].tickers.push(symbol);
    }
  } else {
    delete appState.favorites[symbol];
  }
  activePickerSymbol = null;
  // Сохраняем флажок в БД (watchlist_items.flag_color): избранное живёт на
  // сервере и восстанавливается в другом браузере через loadFlagsFromDb().
  // fav_-списки — производные от флага, их флажок не храним.
  const listId = appState.activeListId;
  if (!listId.startsWith('fav_')) {
    setFlagInDb(listId, symbol, color || null);
  }
  render();
};

window.addTicker = async function() {
  const input = document.getElementById('add-input');
  let sym = input.value.replace(/\s+/g, '').toUpperCase();
  if (!sym) return;
  sym = detectExchange(sym);
  const currentList = getCurrentList();
  const currentListId = appState.activeListId;

  if (currentList.tickers.includes(sym)) {
    log(`Тикер ${sym} уже в списке.`, 'info');
    currentList.activeSymbol = sym;
    setActiveSymbolInDb(currentListId, sym); // выбор тикера — в БД
    createChart(sym); render();
    input.value = ''; return;
  }

  input.disabled = true;
  input.value = 'Проверка...';
  log(`Проверка тикера ${sym}...`, 'info');

  // Проверяем через API
  const testData = await fetchTickerData(sym);

  input.disabled = false;
  input.value = '';
  input.focus();

  if (!testData || !testData.price) {
    window.alert(`Тикер "${sym}" не найден или данные недоступны.\n\nПримеры:\n• SBER, GAZP, LKOH (Россия)\n• AAPL, TSLA, NVDA (США)\n• BTCUSDT, ETHUSDT (Крипто)`);
    log(`Валидация не пройдена для ${sym}`, 'error');
    return;
  }

  log(`Тикер ${sym} прошел валидацию (цена: ${testData.price})`, 'success');

  if (currentListId.startsWith('fav_')) {
    const color = currentListId.replace('fav_', '');
    setFavorite(sym, color);
  } else {
    currentList.tickers.push(sym);
    await addTickerToDb(currentListId, sym); // сохраняем в БД
  }
  currentList.activeSymbol = sym;
  setActiveSymbolInDb(currentListId, sym); // выбор тикера — в БД
  createChart(sym); render();
  log(`Добавлен: ${sym}`, 'success');
};

window.addSection = async function() {
  const name = prompt('Введите название раздела:', 'Новый раздел');
  if (!name || !name.trim()) return;
  const listId = appState.activeListId;
  const currentList = getCurrentList();
  currentList.tickers.push(`SECTION:${name.trim()}`);
  render();
  // Гарантируем, что очередь записи имени списка в БД завершена ДО /order,
  // иначе гонка create-vs-order могла создать строку-заглушку «Новый список».
  await waitForListNameSaved(listId);
  await saveOrderToDb(listId, currentList.tickers); // порядок и разделы — в БД
  // Страховка: после любых изменений состава перечитываем название из БД.
  // Если там всё же оказалась заглушка — syncListWithDb/repair её починят.
  await syncListWithDb(listId);
  log(`Добавлен раздел: "${name.trim()}"`, 'success');
};

window.refreshAllPrices = function() {
  localStorage.removeItem(CACHE_KEY);
  log('🔄 Ручное обновление...', 'info');
  render();
  countdownValue = 120;
  updateCountdownDisplay();
};

window.exportAllData = async function() {
  try {
    // Алерты живут в БД (таблица price_alerts) — берём их оттуда, а не из localStorage
    let alerts = [];
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/alerts`, {}, 15000);
      if (res.ok) {
        const data = await res.json();
        alerts = Array.isArray(data.alerts) ? data.alerts : [];
      }
    } catch (e) { console.error('Не удалось получить алерты из БД для экспорта:', e); }
    const exportData = { appState: appState, alerts: alerts };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `terminal_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    log('Экспорт успешен (включая алерты из БД)', 'success');
  } catch (e) { log('Ошибка экспорта', 'error'); }
};

window.importAllData = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        // Источник истины — БД, поэтому импорт НЕ подменяет appState целиком
        // (так раньше создавался второй дубликат состояния). Вместо этого
        // каждый список из бэкапа загружается в БД через /order (состав +
        // флажки + свёрнутость + заметки), названия — через create/rename,
        // выбранный тикер — через /api/watchlist/active. После успешной
        // записи UI перечитывает всё из БД.
        const src = imported.appState || imported;
        const lists = src.lists || {};
        let okCount = 0, failCount = 0;
        for (const [id, list] of Object.entries(lists)) {
          if (!list || id.startsWith('fav_')) continue; // fav_-списки — производные от флажков
          const name = (list.name || '').trim() || id;
          const symbols = list.tickers || [];
          try {
            await window.renameListInDb(id, name);
            const items = symbols.map(sym => ({
              symbol: sym,
              flag_color: (!sym.startsWith('SECTION:') && src.favorites && src.favorites[sym]) || null,
              collapsed: !!(list.collapsedSections && list.collapsedSections.includes(sym)),
              note: (!sym.startsWith('SECTION:') && src.notes && src.notes[noteKey(id, sym)]) || null
            }));
            const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ list_id: id, symbols: symbols, list_name: name, items })
            }, 15000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (list.activeSymbol) await setActiveSymbolInDb(id, list.activeSymbol, true);
            okCount++;
          } catch (err) {
            failCount++;
            log(`Не удалось импортировать список "${name}": ${err.message}`, 'error');
          }
        }
        if (!okCount && failCount) {
          window.alert('Импорт не выполнен: ни один список не удалось сохранить в БД.');
          return;
        }
        currentSort = { field: null, direction: 'asc' };
        document.querySelectorAll('.column-header').forEach(h => { h.classList.remove('active'); h.querySelector('.sort-icon').textContent = '↕'; });

        // Перечитываем состояние из БД — единственный источник истины.
        await loadListNamesFromDb();
        await loadFlagsFromDb();
        await loadNotesFromDb();
        if (!appState.lists[appState.activeListId]) appState.activeListId = 'default';
        await syncListWithDb(appState.activeListId);
        populateListSelector(); render();

        // Алерты из бэкапа переносим в БД через тот же механизм миграции
        // (бэкенд отсекает дубликаты активных и невалидные записи).
        if (Array.isArray(imported.alerts) && imported.alerts.length > 0) {
          try {
            const res = await fetchWithTimeout(`${API_BASE}/api/alerts/migrate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ alerts: imported.alerts })
            }, 15000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            log(`Импорт завершён: списков в БД — ${okCount}${failCount ? ` (ошибок ${failCount})` : ''}, алертов перенесено: ${data.imported} (пропущено ${data.skipped})`, 'success');
            await loadAlertsFromDb();
          } catch (err) {
            log(`Алерты не удалось перенести в БД: ${err.message}`, 'error');
          }
        } else {
          log(`Импорт завершён: списков обновлено — ${okCount}${failCount ? `, ошибок ${failCount}` : ''}`, 'success');
        }
      } catch (err) {
        log('Ошибка импорта: ' + err.message, 'error');
        window.alert('Ошибка чтения файла.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
};

window.openOnTradingView = function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) { window.alert('Сначала выберите тикер в списке!'); return; }
  window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`, '_blank');
  log(`Открыт график ${symbol} на TradingView`, 'success');
};

window.updateCountdownDisplay = function() {
  const el = document.getElementById('countdown');
  if (el) el.textContent = `${countdownValue}с`;
};

window.startAutoRefresh = function() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  autoRefreshTimer = setInterval(() => {
    if (sessionStorage.getItem('activePage') === 'watchlist') {
      localStorage.removeItem(CACHE_KEY);
      log('🔄 Автообновление цен...', 'info');
      render();
      countdownValue = 120;
    }
    updateCountdownDisplay();
  }, AUTO_REFRESH_INTERVAL);

  countdownTimer = setInterval(() => {
    if (sessionStorage.getItem('activePage') === 'watchlist') {
      if (countdownValue > 0) countdownValue--;
      else countdownValue = 120;
    }
    updateCountdownDisplay();
  }, 1000);
};

window.log = function(message, type = 'info') {
  const panel = document.getElementById('debug-panel');
  if (panel) {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
  }
};

window.toggleDebug = function() {
  debugVisible = !debugVisible;
  document.getElementById('debug-panel').classList.toggle('visible', debugVisible);
};

window.closeDebug = function() {
  debugVisible = false;
  document.getElementById('debug-panel').classList.remove('visible');
};

window.requestNotificationPermission = function() {
  if ("Notification" in window) {
    if (Notification.permission === "default") {
      Notification.requestPermission().then(permission => {
        log(`Разрешение на уведомления: ${permission}`, 'info');
      });
    }
  }
};

window.playAlertSound = function() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  } catch (e) {
    console.warn('Не удалось воспроизвести звук:', e);
  }
};

// Drag and Drop инициализация (Sortable грузится с CDN асинхронно — ждём его,
// иначе при недоступности cdnjs здесь падал ReferenceError и весь код ниже не выполнялся)
if (typeof Sortable !== 'undefined') {
  new Sortable(document.getElementById('ticker-list'), {
    animation: 150, handle: '.drag-handle', ghostClass: 'sortable-ghost', dragClass: 'sortable-drag',
    onEnd: function (evt) {
      // Собираем новый порядок по DOM и находим перемещённый элемент.
      const newList = [];
      document.querySelectorAll('#ticker-list .ticker-item, #ticker-list .section-header').forEach(item => {
        const btn = item.querySelector('.ticker-remove');
        if (btn) newList.push(btn.getAttribute('data-symbol'));
      });
      getCurrentList().tickers = newList;
      // Сохраняем в БД только перемещённый элемент (move + target position),
      // а не весь список: payload не растёт с размером списка, и параллельные
      // правки с другого устройства не затираются снимком с этого.
      const movedBtn = evt.item ? evt.item.querySelector('.ticker-remove') : null;
      const symbol = movedBtn ? movedBtn.getAttribute('data-symbol') : null;
      let targetIndex = -1;
      if (symbol && evt.oldIndex != null && evt.newIndex != null && evt.oldIndex !== evt.newIndex) {
        // target_index для бэкенда — позиция в списке БЕЗ перемещаемого
        // элемента. Считаем по актуальному DOM: сколько других элементов
        // стоит перед перемещённым после drop.
        const kids = Array.from(document.getElementById('ticker-list').children);
        const posInKids = kids.indexOf(evt.item);
        let othersBefore = 0;
        for (let i = 0; i < posInKids; i++) {
          const btn = kids[i] ? kids[i].querySelector('.ticker-remove') : null;
          const s = btn ? btn.getAttribute('data-symbol') : null;
          if (s && s !== symbol) othersBefore++;
        }
        targetIndex = Math.max(0, Math.min(othersBefore, newList.length - 1));
      }
      if (symbol && targetIndex >= 0) {
        // fav-списки пропускаются внутри moveOrderToDb
        window.moveOrderToDb(appState.activeListId, symbol, targetIndex);
      } else if (typeof saveOrderToDb === 'function') {
        // fallback: не удалось определить перемещённый элемент — сохраняем
        // порядок по-старому всем списком
        saveOrderToDb(appState.activeListId, newList);
      }
      currentSort = { field: null, direction: 'asc' };
      document.querySelectorAll('.column-header').forEach(h => { h.classList.remove('active'); h.querySelector('.sort-icon').textContent = '↕'; });
      log('Порядок обновлен', 'info');
    }
  });
} else {
  console.warn('Sortable (cdnjs) не загружен — перетаскивание списка недоступно.');
}

// Ресайзер
const resizer = document.getElementById('resizer');
const watchlist = document.getElementById('watchlist');
let isResizing = false;
resizer.addEventListener('mousedown', (e) => { isResizing = true; resizer.classList.add('active'); document.body.style.userSelect = 'none'; });
document.addEventListener('mousemove', (e) => { if (isResizing && e.clientX >= 260 && e.clientX <= 500) watchlist.style.width = `${e.clientX}px`; });
document.addEventListener('mouseup', () => { if (isResizing) { isResizing = false; resizer.classList.remove('active'); document.body.style.userSelect = ''; } });

document.getElementById('hide-watchlist-btn').addEventListener('click', () => {
  watchlist.classList.add('hidden'); resizer.classList.add('hidden'); document.getElementById('show-watchlist-btn').classList.add('visible');
  if (widget && widgetReady) setTimeout(() => widget.resize(), 150);
});
document.getElementById('show-watchlist-btn').addEventListener('click', () => {
  watchlist.classList.remove('hidden'); resizer.classList.remove('hidden'); document.getElementById('show-watchlist-btn').classList.remove('visible');
  if (widget && widgetReady) setTimeout(() => widget.resize(), 150);
});

document.getElementById('list-selector').addEventListener('change', (e) => switchList(e.target.value));
document.getElementById('add-list-btn').addEventListener('click', addNewList);
document.getElementById('rename-list-btn').addEventListener('click', renameList);
document.getElementById('delete-list-btn').addEventListener('click', deleteCurrentList);
document.getElementById('add-btn').addEventListener('click', addTicker);
document.getElementById('add-section-btn').addEventListener('click', addSection);
document.getElementById('add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTicker(); } });

// Debug ресайз
(function initDebugResize() {
  const panel = document.getElementById('debug-panel');
  const handle = document.getElementById('debug-resize-handle');
  const DEBUG_HEIGHT_KEY = 'debug_panel_height';
  let isResizing = false, startY = 0, startHeight = 0;
  const savedHeight = localStorage.getItem(DEBUG_HEIGHT_KEY);
  if (savedHeight) {
    const h = parseInt(savedHeight, 10);
    if (h >= 100 && h <= window.innerHeight * 0.8) panel.style.height = h + 'px';
  }
  handle.addEventListener('mousedown', (e) => {
    isResizing = true; startY = e.clientY; startHeight = panel.offsetHeight;
    handle.classList.add('active'); document.body.style.userSelect = 'none'; e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = startY - e.clientY;
    panel.style.height = Math.min(Math.max(startHeight + delta, 100), window.innerHeight * 0.8) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false; handle.classList.remove('active'); document.body.style.userSelect = '';
    localStorage.setItem(DEBUG_HEIGHT_KEY, panel.offsetHeight);
  });
})();