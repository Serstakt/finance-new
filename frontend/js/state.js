// === КОНСТАНТЫ ===
window.STORAGE_KEY = 'multi_watchlists_state';
window.DB_LISTS_KEY = 'watchlist_db_lists';   // соответствие id -> название пользовательских списков (локально)
window.CACHE_KEY = 'price_cache';
window.CACHE_DURATION = 120 * 1000;
window.AUTO_REFRESH_INTERVAL = 120 * 1000;
window.ALERTS_KEY = 'price_alerts';

window.FLAG_COLORS = {
  'red': { name: 'Красный', icon: '🔴', hex: '#ef5350' },
  'blue': { name: 'Синий', icon: '🔵', hex: '#2962ff' },
  'yellow': { name: 'Желтый', icon: '🟡', hex: '#ffca28' },
  'orange': { name: 'Оранжевый', icon: '🟠', hex: '#ff9800' },
  'green': { name: 'Зеленый', icon: '🟢', hex: '#26a69a' }
};

// === ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ===
window.widget = null;
window.widgetReady = false;
window.debugVisible = false;
window.countdownValue = 120;
window.countdownTimer = null;
window.autoRefreshTimer = null;
window.currentSort = { field: null, direction: 'asc' };
window.activePickerSymbol = null;
window.currentAlertSymbol = null;

window.appState = {
  activeListId: 'default',
  favorites: {},
  lists: {
    'default': { name: 'Основной', tickers: ['MOEX:SBER', 'MOEX:IMOEX'], activeSymbol: 'MOEX:SBER', collapsedSections: [] }
  }
};

// === ФУНКЦИИ СОСТОЯНИЯ ===
window.loadState = function() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      appState = JSON.parse(saved);
      if (!appState.favorites) appState.favorites = {};
      for (const key in appState.lists) {
        if (!appState.lists[key].collapsedSections) appState.lists[key].collapsedSections = [];
      }
    } else {
      const oldList = localStorage.getItem('my_watchlist');
      if (oldList) {
        try {
          const parsed = JSON.parse(oldList);
          if (Array.isArray(parsed) && parsed.length > 0) {
            appState.lists['default'].tickers = parsed;
            appState.lists['default'].activeSymbol = parsed[0];
            window.pendingLegacySync = true; // первый запуск: загрузим локальный список в БД
          }
        } catch(e) {}
        localStorage.removeItem('my_watchlist');
      }
    }
    if (typeof trimAlertsHistory === 'function') trimAlertsHistory();
  } catch (e) { console.error('Ошибка загрузки состояния:', e); }

  // Пользовательские списки: названия хранятся локально, тикеры — в БД
  try {
    const dbLists = JSON.parse(localStorage.getItem(DB_LISTS_KEY) || '{}');
    for (const [id, name] of Object.entries(dbLists)) {
      if (!appState.lists[id]) {
        appState.lists[id] = { name: name, tickers: [], activeSymbol: '', collapsedSections: [] };
      }
    }
  } catch(e) {}
};

window.saveState = function() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appState)); }
  catch (e) { if (typeof log === 'function') log('Ошибка записи состояния: ' + e.message, 'error'); }
};

// Синхронизация состава списка с бэкендом (БД).
window.syncListWithDb = async function(listId) {
  if (!listId || listId.startsWith('fav_')) return;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/${encodeURIComponent(listId)}`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = appState.lists[listId];
    if (!list) return;
    const dbSymbols = data.symbols || [];

    // Миграция: в БД пусто, а локально есть тикеры (старый watchlist) — загружаем их в БД
    if (dbSymbols.length === 0 && list.tickers.length > 0) {
      await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: listId, symbols: list.tickers })
      }, 15000);
      if (typeof log === 'function') log(`Локальный список "${list.name}" мигрирован в БД (${list.tickers.length} эл.)`, 'info');
      return;
    }

    list.tickers = dbSymbols;
    saveState();
    if (listId === appState.activeListId && typeof render === 'function') render();
    if (typeof populateListSelector === 'function') populateListSelector();
    if (typeof log === 'function') log(`Список "${list.name}" загружен из БД (${list.tickers.length} эл.)`, 'info');
  } catch (e) {
    if (typeof log === 'function') log('Не удалось загрузить watchlist из БД: ' + e.message, 'error');
  }
};

window.addTickerToDb = async function(listId, symbol) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol })
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (typeof log === 'function') log(`${symbol} сохранен в БД`, 'success');
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Ошибка сохранения в БД: ' + e.message, 'error');
    return false;
  }
};

window.removeTickerFromDb = async function(listId, symbol) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol })
    }, 15000);
    if (res.status === 404) return true; // уже удалён
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (typeof log === 'function') log(`${symbol} удален из БД`, 'success');
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Ошибка удаления из БД: ' + e.message, 'error');
    return false;
  }
};

window.saveOrderToDb = async function(listId, symbols) {
  if (!listId || listId.startsWith('fav_')) return;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbols: symbols })
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (typeof log === 'function') log('Ошибка сохранения порядка в БД: ' + e.message, 'error');
  }
};

window.getCurrentList = function() { return appState.lists[appState.activeListId] || appState.lists['default']; };

window.switchList = function(listId) {
  if (!appState.lists[listId]) return;
  appState.activeListId = listId;
  saveState();
  populateListSelector();
  currentSort = { field: null, direction: 'asc' };
  document.querySelectorAll('.column-header').forEach(h => {
    h.classList.remove('active');
    h.querySelector('.sort-icon').textContent = '↕';
  });
  if (typeof render === 'function') render();
  // тикеры обычных списков живут в БД — подтягиваем актуальный состав
  if (typeof syncListWithDb === 'function') syncListWithDb(listId);
};

window.populateListSelector = function() {
  const selector = document.getElementById('list-selector');
  selector.innerHTML = '';
  for (const [id, list] of Object.entries(appState.lists)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = list.name + (list.tickers.length > 0 ? ` (${list.tickers.length})` : '');
    if (id === appState.activeListId) option.selected = true;
    selector.appendChild(option);
  }
};