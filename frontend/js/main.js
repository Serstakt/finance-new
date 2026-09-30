// === ИНИЦИАЛИЗАЦИЯ И СОБЫТИЯ ===
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  setupColumnHeaders();
  startAutoRefresh();
  requestNotificationPermission();

  // Загружаем состав активного списка из БД (тикеры watchlist хранятся на сервере)
  syncListWithDb(appState.activeListId);

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
  const id = 'list_' + Date.now();
  appState.lists[id] = { name: name, tickers: [], activeSymbol: '', collapsedSections: [] };
  saveState();
  populateListSelector();
  switchList(id);
  log(`Создан список: ${name}`, 'success');
};

window.renameList = function() {
  if (appState.activeListId.startsWith('fav_')) {
    window.alert('Этот список управляется автоматически через флажки.');
    return;
  }
  const currentList = getCurrentList();
  const newName = prompt('Введите новое название списка:', currentList.name);
  if (!newName || newName.trim() === '' || newName.trim() === currentList.name) return;
  currentList.name = newName.trim();
  saveState();
  populateListSelector();
  log(`Список переименован: "${currentList.name}"`, 'success');
};

window.deleteCurrentList = function() {
  if (appState.activeListId.startsWith('fav_')) {
    window.alert('Этот список управляется автоматически через флажки.');
    return;
  }
  const listIds = Object.keys(appState.lists);
  if (listIds.length <= 1) { window.alert('Нельзя удалить последний список!'); return; }
  const currentName = getCurrentList().name;
  if (!confirm(`Удалить список "${currentName}"?`)) return;
  delete appState.lists[appState.activeListId];
  appState.activeListId = listIds.find(id => id !== appState.activeListId);
  saveState();
  populateListSelector();
  render();
  log(`Удален список: ${currentName}`, 'info');
};

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
  saveState();
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
    saveState(); createChart(sym); render();
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
  saveState(); createChart(sym); render();
  log(`Добавлен: ${sym}`, 'success');
};

window.addSection = async function() {
  const name = prompt('Введите название раздела:', 'Новый раздел');
  if (!name || !name.trim()) return;
  const currentList = getCurrentList();
  currentList.tickers.push(`SECTION:${name.trim()}`);
  saveState(); render();
  await saveOrderToDb(appState.activeListId, currentList.tickers); // порядок и разделы — в БД
  log(`Добавлен раздел: "${name.trim()}"`, 'success');
};

window.refreshAllPrices = function() {
  localStorage.removeItem(CACHE_KEY);
  log('🔄 Ручное обновление...', 'info');
  render();
  countdownValue = 120;
  updateCountdownDisplay();
};

window.exportAllData = function() {
  try {
    const exportData = { appState: appState, alerts: JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]') };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `terminal_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    log('Экспорт успешен (включая алерты)', 'success');
  } catch (e) { log('Ошибка экспорта', 'error'); }
};

window.importAllData = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (imported.appState) {
          appState = imported.appState;
          if (imported.alerts) localStorage.setItem(ALERTS_KEY, JSON.stringify(imported.alerts));
        } else {
          appState = imported;
        }
        if (!appState.favorites) appState.favorites = {};
        for (const key in appState.lists) {
          if (!appState.lists[key].collapsedSections) appState.lists[key].collapsedSections = [];
        }
        saveState();
        currentSort = { field: null, direction: 'asc' };
        document.querySelectorAll('.column-header').forEach(h => { h.classList.remove('active'); h.querySelector('.sort-icon').textContent = '↕'; });
        populateListSelector(); render();
        log('Импорт успешен (включая алерты)', 'success');
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
    onEnd: function () {
      const newList = [];
      document.querySelectorAll('#ticker-list .ticker-item, #ticker-list .section-header').forEach(item => {
        const btn = item.querySelector('.ticker-remove');
        if (btn) newList.push(btn.getAttribute('data-symbol'));
      });
      getCurrentList().tickers = newList;
      saveState();
      // сохраняем новый порядок в БД (fav-списки внутри функции пропускаются)
      if (typeof saveOrderToDb === 'function') saveOrderToDb(appState.activeListId, newList);
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