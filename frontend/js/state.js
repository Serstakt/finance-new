// === КОНСТАНТЫ ===
window.STORAGE_KEY = 'multi_watchlists_state';
// Устаревший ключ: раньше названия пользовательских списков хранились в localStorage.
// Теперь они живут в БД (таблица watchlists) и загружаются через /api/watchlists.
window.DB_LISTS_KEY = 'watchlist_db_lists';
try { localStorage.removeItem(window.DB_LISTS_KEY); } catch(e) {}
// Ключ кэша цен в localStorage. Должен совпадать с ключом, который использует
// fetchTickerData (api.js), иначе очистка кэша (ручное/авто обновление) не будет
// удалять реальные записи и цены будут устаревать.
window.CACHE_KEY = 'ticker_cache';
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
    // trimAlertsHistory() убран: история алертов теперь режется на бэкенде
    // (alert_service.trim_history), localStorage 'price_alerts' больше не
    // источник истины — из него выполняется только одноразовая миграция в БД.
  } catch (e) { console.error('Ошибка загрузки состояния:', e); }

  // Пользовательские списки: названия хранятся в БД (таблица watchlists),
  // поэтому здесь они не подтягиваются из localStorage — это делает
  // loadListNamesFromDb() при загрузке страницы/раздела WATCHLIST.
};

window.saveState = function() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appState)); }
  catch (e) { if (typeof log === 'function') log('Ошибка записи состояния: ' + e.message, 'error'); }
};

// Синхронизация состава списка с бэкендом (БД).
// Название списка тоже берётся из БД (watchlists.name), а не из localStorage.
window.syncListWithDb = async function(listId) {
  if (!listId || listId.startsWith('fav_')) return;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/${encodeURIComponent(listId)}`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = appState.lists[listId];
    if (!list) return;
    const dbSymbols = data.symbols || [];

    // Название списка тянем из БД: оно является источником истины при загрузке раздела.
    // Исключение — заглушки («Новый список», list_<timestamp>, пустое): если локально
    // у нас настоящее имя, а в БД заглушка (например, /add создал строку раньше, чем
    // дошёл /create), НЕ перетаскиваем заглушку в UI и чиним её в БД через repair.
    const dbRaw = typeof data.name === 'string' ? data.name.trim() : '';
    const localName = (list.name || '').trim();
    const isStub = !dbRaw || dbRaw === 'Новый список' || dbRaw === listId;
    if (!isStub && dbRaw !== list.name) {
      list.name = data.name;
    } else if (isStub && localName && localName !== 'Новый список' && localName !== listId) {
      try {
        await fetchWithTimeout(`${API_BASE}/api/watchlist/repair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: { [listId]: localName } })
        }, 15000);
        if (typeof log === 'function') log(`Название "${localName}" восстановлено в БД вместо заглушки`, 'info');
      } catch (e) { /* попробуем починить при следующей загрузке */ }
    }

    // Миграция: в БД пусто, а локально есть тикеры (старый watchlist) — загружаем их в БД
    if (dbSymbols.length === 0 && list.tickers.length > 0) {
      // Заодно сохраняем текущее название в БД, чтобы дальше оно жило на сервере
      await window.renameListInDb(listId, list.name);
      await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: listId, symbols: list.tickers, list_name: list.name })
      }, 15000);
      if (typeof log === 'function') log(`Локальный список "${list.name}" мигрирован в БД (${list.tickers.length} эл.)`, 'info');
      saveState();
      if (typeof populateListSelector === 'function') populateListSelector();
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

// Названия всех пользовательских списков подтягиваются из БД (таблица watchlists)
// и создают отсутствующие списки локально — вместо хранения в localStorage.
window.loadListNamesFromDb = async function() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlists`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const names = data.lists || {};
    let changed = false;
    for (const [id, name] of Object.entries(names)) {
      if (id.startsWith('fav_')) continue;
      if (!appState.lists[id]) {
        appState.lists[id] = { name: name, tickers: [], activeSymbol: '', collapsedSections: [] };
        changed = true;
      } else if (name && appState.lists[id].name !== name) {
        // источник истины — БД, а не localStorage
        appState.lists[id].name = name;
        changed = true;
      }
    }
    // Обратная синхронизация: список есть локально (например, создан на другом
    // устройстве/сессии или мигрирован), но его ещё нет в таблице watchlists —
    // регистрируем его в БД, чтобы названия всех списков жили на сервере.
    const missing = Object.entries(appState.lists)
      .filter(([id, l]) => !id.startsWith('fav_') && !(id in names) && l.name);
    // Плюс чиним «заглушки» в БД ("Новый список" / list_<timestamp>), которые
    // появились из-за того, что тикер добавили раньше, чем сохранилось название.
    const stubs = Object.entries(appState.lists)
      .filter(([id, l]) => !id.startsWith('fav_') && l.name &&
        id in names && (names[id] === 'Новый список' || names[id] === id));
    await Promise.all(
      [...missing, ...stubs].map(([id, l]) => window.createListInDb(id, l.name))
    );
    // Страховка на случай гонки add-before-create: одной пачкой чиним ВСЕ
    // локальные имена поверх заглушек прямо в БД (/api/watchlist/repair).
    // Настоящие названия в БД эндпоинт не перезаписывает.
    try {
      const repairNames = {};
      for (const [id, l] of Object.entries(appState.lists)) {
        if (!id.startsWith('fav_') && l.name) repairNames[id] = l.name;
      }
      const repRes = await fetchWithTimeout(`${API_BASE}/api/watchlist/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: repairNames })
      }, 15000);
      if (repRes.ok) {
        const rdata = await repRes.json();
        for (const [id, name] of Object.entries(rdata.lists || {})) {
          if (id.startsWith('fav_')) continue;
          if (appState.lists[id] && name && appState.lists[id].name !== name) {
            appState.lists[id].name = name;
            changed = true;
          }
        }
      }
    } catch (e) { /* если repair недоступен — дальше работает обычная загрузка имён */ }
    if (missing.length || stubs.length) {
      // перечитаем названия из БД после починки
      const refreshed = await fetchWithTimeout(`${API_BASE}/api/watchlists`, {}, 15000);
      if (refreshed.ok) {
        const rdata = await refreshed.json();
        for (const [id, name] of Object.entries(rdata.lists || {})) {
          if (id.startsWith('fav_')) continue;
          if (appState.lists[id] && name && appState.lists[id].name !== name) {
            appState.lists[id].name = name;
          }
        }
      }
      changed = true;
    }
    if (changed) {
      saveState();
      if (typeof populateListSelector === 'function') populateListSelector();
    }
    return names;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось загрузить названия списков из БД: ' + e.message, 'error');
    return {};
  }
};

// Создаёт/обновляет название списка в БД (строка watchlists.name).
// Использует /api/watchlist/create (upsert), делает до 3 попыток при сетевых
// ошибках и ПРОВЕРЯЕТ результат: после успешного ответа запрашивает список
// из БД и сверяет название. Возвращает true только если название реально
// записалось в таблицу watchlists.
//
// ВАЖНО (заглушка вместо имени): все записи имён идут через ОЧЕРЕДЬ на
// список (nameWriteQueue). Это гарантирует, что /api/watchlist/create
// завершится ДО того, как следующий запрос (/add, /order) сможет создать
// строку с заглушкой «Новый список». Без очереди addTicker мог выиграть
// гонку у create — и в БД оставалась заглушка.
window.nameWriteQueue = window.nameWriteQueue || {};

function _writeListNameNow(listId, trimmed) {
  return (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ list_id: listId, name: trimmed })
        }, 15000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Проверка: убеждаемся, что запись действительно появилась в БД
        const checkRes = await fetchWithTimeout(
          `${API_BASE}/api/watchlist/${encodeURIComponent(listId)}`, {}, 15000
        );
        if (checkRes.ok) {
          const data = await checkRes.json();
          if (data && data.name === trimmed) return true;
          lastError = `в БД сохранилось "${data ? data.name : '?'}" вместо "${trimmed}"`;
        } else {
          lastError = `проверка не удалась (HTTP ${checkRes.status})`;
        }
      } catch (e) {
        lastError = e.message;
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    }
    if (typeof log === 'function') {
      log(`Не удалось сохранить название списка "${trimmed}" в БД: ${lastError}`, 'error');
    }
    return false;
  })();
}

window.createListInDb = async function(listId, name) {
  if (!listId || listId.startsWith('fav_')) return false;
  const trimmed = (name || '').trim();
  if (!trimmed) return false;
  const q = window.nameWriteQueue;
  const prev = q[listId] || Promise.resolve(false);
  const cur = prev.then(() => _writeListNameNow(listId, trimmed));
  q[listId] = cur.catch(() => false);
  return cur;
};

// Ждём завершения всех отложенных записей имени списка в БД.
// Вызывается перед /add и /order, чтобы эти запросы не создали в watchlists
// строку-заглушку раньше, чем дойдёт настоящий create/rename.
window.waitForListNameSaved = async function(listId) {
  if (!listId || !window.nameWriteQueue || !window.nameWriteQueue[listId]) return;
  try { await window.nameWriteQueue[listId]; } catch (e) {}
};

// Совместимость: renameListInDb — то же, что createListInDb (upsert по названию).
window.renameListInDb = window.createListInDb;

window.deleteListInDb = async function(listId) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/api/watchlist/${encodeURIComponent(listId)}`, { method: 'DELETE' }, 15000
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось удалить список из БД: ' + e.message, 'error');
    return false;
  }
};

window.addTickerToDb = async function(listId, symbol) {
  if (!listId || listId.startsWith('fav_')) return false;
  // Ждём завершения записи имени (create/rename), чтобы /add не создал
  // строку-заглушку «Новый список» раньше настоящего названия.
  await window.waitForListNameSaved(listId);
  // Передаём и название списка: если строки в watchlists ещё нет (например,
  // create не дошёл до БД), /api/watchlist/add создаст её сразу с настоящим
  // именем, а не с заглушкой.
  const listName = (appState.lists[listId] && appState.lists[listId].name) || null;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol, list_name: listName })
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
  await window.waitForListNameSaved(listId);
  const listName = (appState.lists[listId] && appState.lists[listId].name) || null;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbols: symbols, list_name: listName })
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