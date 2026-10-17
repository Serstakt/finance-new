// === КОНСТАНТЫ ===
// localStorage больше НЕ хранит данные watchlist (тикеры, названия списков,
// флажки, заметки, выбранный тикер) — единственный источник истины для них:
// SQLite (watchlists / watchlist_items) и REST API. Устаревший ключ
// 'multi_watchlists_state' читается ОДИН раз (readLegacyState), конвертируется
// в БД (migrateLegacyStateToDb) и удаляется: две копии одних данных раньше
// расходились (баги «Новый список вместо имени», потерянные заметки).
window.STORAGE_KEY = 'multi_watchlists_state';
// Устаревший ключ: раньше названия пользовательских списков хранились в localStorage.
// Теперь они живут в БД (таблица watchlists) и загружаются через /api/watchlists.
window.DB_LISTS_KEY = 'watchlist_db_lists';
// Устаревшие дубликаты данных: снимок appState ('multi_watchlists_state'),
// плоский список ('my_watchlist') и кэш названий списков читаются ОДИН раз
// при миграции (см. runLegacyMigration в main.js) и затем удаляются.
// Пока миграция не подтверждена сервером, ключи НЕ трогаем — иначе можно
// потерять данные при недоступном бэкенде.
try { localStorage.removeItem(window.DB_LISTS_KEY); } catch(e) {}
window.removeLegacyStorageKeys = function() {
  try {
    localStorage.removeItem(window.STORAGE_KEY);
    localStorage.removeItem('my_watchlist');
    localStorage.removeItem(window.DB_LISTS_KEY);
  } catch (e) {}
};
// В localStorage остаются только переходящие UI-настройки: размер панели
// отладки ('debug_panel_height'), кэш цен ('ticker_cache') и логотипов.
// Сессионные UI-настройки: активная страница/вкладка под графиком.
// Активный таб (выбранный список) тоже живёт в sessionStorage — это
// настройка вида конкретной вкладки браузера, а не данные списка.
window.UI_STATE_KEY = 'ui_active_list_id';
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
  // Заметки к тикерам: {"list_id|SYMBOL": "текст"}. Кэш колонки БД
  // watchlist_items.note (источник истины — БД, см. loadNotesFromDb/syncListWithDb).
  notes: {},
  lists: {
    'default': { name: 'Основной', tickers: ['MOEX:SBER', 'MOEX:IMOEX'], activeSymbol: 'MOEX:SBER', collapsedSections: [] }
  }
};

// Ключ для appState.notes: заметка привязана к паре (список, тикер),
// поэтому в разных списках у одного тикера могут быть разные тезисы.
window.noteKey = function(listId, symbol) { return `${listId}|${symbol}`; };

// === ФУНКЦИИ СОСТОЯНИЯ ===
// appState — только кэш в памяти. В него попадают данные из БД (syncListWithDb,
// loadListNamesFromDb, loadFlagsFromDb, loadNotesFromDb) и временные UI-состояния.
// localStorage для этих данных больше не используется: запись в него создавала
// второй источник истины и рассинхроны с БД.
window.loadState = function() {
  // Активный таб — UI-настройка конкретной вкладки браузера (sessionStorage).
  // Название выбранного списка подтянется из БД в loadListNamesFromDb();
  // если списка нет (например, fav_-таб ещё не собран), откатимся к 'default'.
  try {
    const savedTab = sessionStorage.getItem(window.UI_STATE_KEY);
    if (savedTab && appState.lists[savedTab]) appState.activeListId = savedTab;
  } catch (e) {}

  // Данные watchlist сюда НЕ загружаются: единственный источник истины — БД.
  // Одноразовый перенос старого снимка из localStorage делает
  // runLegacyMigration() в main.js (readLegacyState -> migrateLegacyStateToDb).
};

// Читает устаревший снимок appState из localStorage без применения к памяти.
// Используется только migrateLegacyStateToDb() при первом запуске после
// перевода состояния на БД.
window.readLegacyState = function() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
    // Ещё более старый формат: плоский массив тикеров 'my_watchlist'.
    const oldList = localStorage.getItem('my_watchlist');
    if (oldList) {
      const parsed = JSON.parse(oldList);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { lists: { default: { name: 'Основной', tickers: parsed, activeSymbol: parsed[0] } } };
      }
    }
  } catch (e) { console.error('Ошибка чтения устаревшего состояния:', e); }
  return null;
};

// saveState() упразднён полностью: все прежние вызовы заменены на точечные
// записи в БД (saveOrderToDb / setActiveSymbolInDb / renameListInDb и т.п.),
// а UI-настройки пишутся напрямую в sessionStorage. localStorage для данных
// watchlist больше не пишется никогда — второго источника истины нет.

// Одноразовая миграция «localStorage -> БД»: поднимает устаревший снимок
// multi_watchlists_state (тикеры, названия, флажки, заметки, активный тикер)
// и загружает его в таблицы watchlists/watchlist_items через существующие
// эндпоинты. Вызывается из main.js (runLegacyMigration) ДО загрузки списков
// из БД; ключи localStorage удаляются только после успешного переноса.
window.migrateLegacyStateToDb = async function(legacy) {
  if (!legacy || !legacy.lists) return false;
  let migrated = false;
  for (const [id, list] of Object.entries(legacy.lists)) {
    if (!list || id.startsWith('fav_')) continue; // fav_-списки — производные от флажков
    const symbols = list.tickers || [];
    const realName = (list.name || '').trim();
    const hasName = realName && realName !== 'Новый список' && realName !== id;
    // Пустой список без настоящего имени мигрировать нечего.
    if (symbols.length === 0 && !hasName) continue;
    // Название + состав (с флажками/свёрнутостью/заметками из legacy-кэша) —
    // одним /order; syncListWithDb затем сверит результат с БД.
    try {
      if (hasName) await window.renameListInDb(id, realName);
      const items = symbols.map(sym => ({
        symbol: sym,
        flag_color: (!sym.startsWith('SECTION:') && legacy.favorites && legacy.favorites[sym]) || null,
        collapsed: !!(list.collapsedSections && list.collapsedSections.includes(sym)),
        note: (!sym.startsWith('SECTION:') && legacy.notes && legacy.notes[noteKey(id, sym)]) || null
      }));
      if (symbols.length > 0) {
        const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ list_id: id, symbols: symbols, list_name: hasName ? realName : null, items })
        }, 15000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      if (list.activeSymbol) await setActiveSymbolInDb(id, list.activeSymbol, true);
      migrated = true;
    } catch (e) {
      if (typeof log === 'function') log(`Не удалось мигрировать список "${realName || id}" из localStorage: ${e.message}`, 'error');
      return false; // миграция не завершена — ключи localStorage НЕ удаляем
    }
  }
  return migrated;
};

// === Сериализация чтения списков из БД (защита от гонок) ===
// syncListWithDb вызывается при каждом переключении таба, поэтому медленный
// ответ списка A мог дойти уже после клика на B и записать данные A в
// appState.lists[A], а затем вызвать render() поверх активного B. Защита:
// 1) monotonically increasing request serial — «запрос-серийный номер»:
//    каждый новый вызов получает свой номер, а применение результата
//    разрешено только самому свежему запросу для данного списка (устаревшие
//    ответы отбрасываются целиком, включая их side-effects — repair,
//    rebuildFavoriteLists, render);
// 2) render() — только для активного списка: данные неактивного списка
//    пишутся в appState, но не перерисовывают DOM чужого таба;
// 3) сверка list_id в теле ответа с запрошенным — страховка на случай, если
//    сервер/прокси вернёт данные чужого списка.
window.__syncListSeq = 0;
const activeSyncSerials = new Map(); // listId -> serial последнего запущенного запроса

window.syncListWithDb = async function(listId) {
  if (!listId || listId.startsWith('fav_')) return;
  const mySerial = ++window.__syncListSeq;
  activeSyncSerials.set(listId, mySerial);
  // результат применения: true — данные списка обновлены, false — устаревший
  // ответ отброшен или ошибка сети (чтобы awaiting-вызовы могли это учесть)
  let applied = false;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/${encodeURIComponent(listId)}`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Пока ждали ответа, по этому списку уже ушёл более свежий запрос —
    // наш результат устарел, применять его нельзя (данные перезапишет
    // более новый ответ).
    if (activeSyncSerials.get(listId) !== mySerial) {
      if (typeof log === 'function') log(`Ответ по списку "${listId}" устарел (запрос #${mySerial}) — пропущен`, 'info');
      return false;
    }
    // Страховка: тело ответа должно относиться именно к запрошенному списку.
    if (data.list_id && data.list_id !== listId) {
      if (typeof log === 'function') log(`Ответ GET /watchlist содержит чужой list_id "${data.list_id}" вместо "${listId}" — пропущен`, 'error');
      return false;
    }
    const list = appState.lists[listId];
    if (!list) return false;
    const dbSymbols = data.symbols || [];
    // Новые колонки БД: flag_color, collapsed и note у каждого элемента.
    // Это источник истины для избранного, свёрнутых разделов и заметок (не localStorage).
    const dbItems = Array.isArray(data.items) ? data.items : null;

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
      // Фиксация заглушки имени — фоновая операция, не ждём ответ в этом
      // async-участке: единственный await здесь давал бы другому запросу
      // «просочиться» между проверкой серийного номера и применением данных.
      fetchWithTimeout(`${API_BASE}/api/watchlist/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: { [listId]: localName } })
      }).then(() => {
        if (typeof log === 'function') log(`Название "${localName}" восстановлено в БД вместо заглушки`, 'info');
      }).catch(() => { /* попробуем починить при следующей загрузке */ });
    }

    // Миграция «в БД пусто, локально есть тикеры» упразднена: localStorage
    // больше не источник данных, а одноразовый перенос старого снимка делает
    // migrateLegacyStateToDb() на старте страницы. Пустой список в БД — это
    // просто пустой список.
    list.tickers = dbSymbols;

    // Флажки, свёрнутые разделы и заметки: источник истины — колонки БД
    // (watchlist_items.flag_color / collapsed / note). Для fav_-списков (они
    // вычисляются из флага родительского списка) ничего не делаем.
    if (dbItems && !listId.startsWith('fav_')) {
      let flagsChanged = false;
      for (const it of dbItems) {
        const sym = it.symbol;
        if (!sym || sym.startsWith('SECTION:')) continue;
        const prev = appState.favorites[sym];
        if (it.flag_color) {
          if (prev !== it.flag_color) { appState.favorites[sym] = it.flag_color; flagsChanged = true; }
        } else if (prev) {
          delete appState.favorites[sym]; flagsChanged = true;
        }
        // заметка элемента этого списка (ключ list_id|SYMBOL)
        const nk = noteKey(listId, sym);
        const dbNote = it.note || null;
        if (dbNote) appState.notes[nk] = dbNote;
        else delete appState.notes[nk];
      }
      if (flagsChanged) rebuildFavoriteLists();
      // collapsed разделов из БД перезаписывают локальный список
      const collapsedFromDb = dbItems
        .filter(it => it.symbol && it.symbol.startsWith('SECTION:') && it.collapsed)
        .map(it => it.symbol);
      list.collapsedSections = collapsedFromDb;
    }

    // Выбранный тикер — колонка БД watchlists.active_symbol. Если выбор
    // устарел (тикер удалён/пусто), берём первый тикер списка.
    if (!listId.startsWith('fav_')) {
      const dbActive = data.active_symbol || '';
      list.activeSymbol = (dbActive && dbSymbols.includes(dbActive))
        ? dbActive
        : (dbSymbols.find(s => !s.startsWith('SECTION:')) || '');
    }

    applied = true;
    // Весь участок от проверки серийного номера до применения данных и вывода
    // в UI синхронный (await здесь только выше, до dbSymbols) — другой вызов
    // syncListWithDb не может «вклиниться» в середину. Поэтому render()
    // вызываем ТОЛЬКО когда ответ относится к активному табу: медленный ответ
    // A при активном B не должен перерисовывать список B (сам render читает
    // активный список — данные A попали бы в DOM B). Данные A остаются в
    // appState.lists[A]; их отрисует syncListWithDb(A)/render() при возврате
    // на таб A. Выпадающий список (счётчики/названия) обновляем всегда —
    // он показывает все списки сразу.
    if (listId === appState.activeListId && typeof render === 'function') render();
    if (typeof populateListSelector === 'function') populateListSelector();
    if (typeof log === 'function') log(`Список "${list.name}" загружен из БД (${list.tickers.length} эл.)`, 'info');
  } catch (e) {
    if (typeof log === 'function') log('Не удалось загрузить watchlist из БД: ' + e.message, 'error');
  }
  return applied;
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
  // Флажки и свёрнутость/заметки едут вместе с порядком: если элемент будет
  // пересоздан в БД, его flag_color/collapsed/note не потеряются.
  const items = (symbols || []).map(sym => ({
    symbol: sym,
    flag_color: (!sym.startsWith('SECTION:') && appState.favorites[sym]) || null,
    collapsed: !!(appState.lists[listId] && appState.lists[listId].collapsedSections
                  && appState.lists[listId].collapsedSections.includes(sym)),
    note: (!sym.startsWith('SECTION:') && appState.notes[noteKey(listId, sym)]) || null
  }));
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbols: symbols, list_name: listName, items })
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (typeof log === 'function') log('Ошибка сохранения порядка в БД: ' + e.message, 'error');
  }
};

// Точечное сохранение результата drag&drop: в БД уходит только перемещённый
// элемент и его новая позиция, а не весь список (как делал saveOrderToDb).
// Сервер переставляет символ поверх актуального порядка, поэтому параллельные
// изменения с другого устройства не затираются, а payload не растёт с размером
// списка. В ответ приходит новый порядок — им и сверяем локальное состояние;
// при ошибке откатываемся на снимок с сервера (syncListWithDb).
window.moveOrderToDb = async function(listId, symbol, targetIndex) {
  if (!listId || listId.startsWith('fav_')) return false;
  await window.waitForListNameSaved(listId);
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol, target_index: targetIndex })
    }, 15000);
    if (res.status === 404) {
      // элемента нет в списке на сервере (например, удалён с другого
      // устройства) — перечитаем состав из БД, чтобы UI не показывал лишнее
      if (typeof syncListWithDb === 'function') await syncListWithDb(listId);
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = appState.lists[listId];
    if (list && Array.isArray(data.symbols)) {
      list.tickers = data.symbols; // сервер — источник истины по порядку
    }
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Ошибка сохранения порядка в БД: ' + e.message, 'error');
    if (typeof syncListWithDb === 'function') await syncListWithDb(listId);
    if (typeof render === 'function') render();
    return false;
  }
};

// Ставит/снимает цветной флажок элемента в БД (watchlist_items.flag_color).
// Теперь избранное живёт на сервере и не теряется при смене браузера.
window.setFlagInDb = async function(listId, symbol, color) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol, color: color || null })
    }, 15000);
    if (res.status === 404) return true; // элемента нет в этом списке — не ошибка
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось сохранить флажок в БД: ' + e.message, 'error');
    return false;
  }
};

// Сохраняет состояние свёрнутого раздела в БД (watchlist_items.collapsed).
window.setCollapsedInDb = async function(listId, sectionSymbol, collapsed) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/collapse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: sectionSymbol, collapsed: !!collapsed })
    }, 15000);
    if (res.status === 404) return true;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось сохранить состояние раздела в БД: ' + e.message, 'error');
    return false;
  }
};

// Ставит/обновляет/снимает текстовую заметку элемента в БД
// (watchlist_items.note). Заметка привязана к паре (список, тикер): у одного
// тикера в разных списках могут быть разные тезисы «почему слежу».
// Локальный кэш appState.notes обновляет вызывающий код (полотно заметок —
// initNotesEditor в ui.js), чтобы UI перерисовался мгновенно без перезагрузки из БД.
window.setNoteInDb = async function(listId, symbol, note) {
  if (!listId || listId.startsWith('fav_')) return false;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: listId, symbol: symbol, note: note || null })
    }, 15000);
    if (res.status === 404) return true; // элемента нет в этом списке — не ошибка
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось сохранить заметку в БД: ' + e.message, 'error');
    return false;
  }
};

// Запоминает выбранный тикер списка в БД (watchlists.active_symbol).
// Раньше activeSymbol был частью appState -> localStorage — второй источник
// истины; теперь выбор живёт на сервере и возвращается GET /api/watchlist/{id}.
// Огонь записью гасится дебаунсом: быстрые клики по строкам не плодят запросы.
window.__activeSymbolTimers = window.__activeSymbolTimers || {};
// immediate=true — записать без дебаунса (используется миграцией legacy-
// состояния: запись должна точно завершиться до удаления ключей localStorage).
window.setActiveSymbolInDb = async function(listId, symbol, immediate) {
  if (!listId || listId.startsWith('fav_')) return false;
  const t = window.__activeSymbolTimers;
  if (t[listId]) { clearTimeout(t[listId]); delete t[listId]; }
  const send = async () => {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/watchlist/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: listId, symbol: symbol || null })
      }, 15000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (e) {
      if (typeof log === 'function') log('Не удалось сохранить выбранный тикер в БД: ' + e.message, 'error');
      return false;
    }
  };
  if (immediate) return send();
  return new Promise(resolve => {
    t[listId] = setTimeout(async () => {
      delete t[listId];
      resolve(await send());
    }, 400);
  });
};

// Пересобирает служебные fav_-списки из appState.favorites (после загрузки
// флажков из БД или их изменения).
window.rebuildFavoriteLists = function() {
  for (const id of Object.keys(appState.lists)) {
    if (id.startsWith('fav_')) delete appState.lists[id];
  }
  for (const [sym, color] of Object.entries(appState.favorites || {})) {
    if (!color || !window.FLAG_COLORS[color]) continue;
    const favId = `fav_${color}`;
    if (!appState.lists[favId]) {
      appState.lists[favId] = {
        name: `${FLAG_COLORS[color].icon} ${FLAG_COLORS[color].name}`,
        tickers: [], activeSymbol: '', collapsedSections: [], isFavoriteList: true
      };
    }
    if (!appState.lists[favId].tickers.includes(sym)) {
      appState.lists[favId].tickers.push(sym);
    }
  }
};

// Загружает ВСЕ флажки из БД (GET /api/watchlist-flags) и применяет их к
// appState.favorites. Вызывается при старте, чтобы избранное восстановилось
// в новом браузере без localStorage.
window.loadFlagsFromDb = async function() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist-flags`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const flags = data.flags || {};
    let changed = false;
    for (const [key, color] of Object.entries(flags)) {
      const sep = key.indexOf('|');
      if (sep === -1) continue;
      const listId = key.slice(0, sep);
      const sym = key.slice(sep + 1);
      if (listId.startsWith('fav_')) continue; // служебные списки — производные
      if (!window.FLAG_COLORS[color]) continue;
      if (appState.favorites[sym] !== color) {
        appState.favorites[sym] = color;
        changed = true;
      }
    }
    if (changed) {
      rebuildFavoriteLists();
      if (typeof populateListSelector === 'function') populateListSelector();
      if (typeof render === 'function' && sessionStorage.getItem('activePage') === 'watchlist') render();
    }
    return flags;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось загрузить флажки из БД: ' + e.message, 'error');
    return {};
  }
};

// Загружает ВСЕ заметки из БД (GET /api/watchlist-notes) и применяет их к
// appState.notes. Вызывается при старте/открытии раздела, чтобы иконки 📝
// восстановились в новом браузере без localStorage (аналог loadFlagsFromDb).
window.loadNotesFromDb = async function() {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/watchlist-notes`, {}, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const notes = data.notes || {};
    let changed = false;
    // Сначала убираем локальные записи для обычных списков, которых больше
    // нет в БД (источник истины — БД; заметки могли быть удалены на другом
    // устройстве). Ключ имеет вид list_id|SYMBOL, '|' не встречается в id.
    for (const key of Object.keys(appState.notes)) {
      const sep = key.indexOf('|');
      if (sep === -1) continue;
      const listId = key.slice(0, sep);
      if (listId.startsWith('fav_')) continue;
      if (!(key in notes)) { delete appState.notes[key]; changed = true; }
    }
    for (const [key, note] of Object.entries(notes)) {
      const sep = key.indexOf('|');
      if (sep === -1) continue;
      const listId = key.slice(0, sep);
      if (listId.startsWith('fav_')) continue; // служебные списки — производные
      if (appState.notes[key] !== note) {
        appState.notes[key] = note;
        changed = true;
      }
    }
    if (changed) {
      if (typeof render === 'function' && sessionStorage.getItem('activePage') === 'watchlist') render();
    }
    return notes;
  } catch (e) {
    if (typeof log === 'function') log('Не удалось загрузить заметки из БД: ' + e.message, 'error');
    return {};
  }
};

window.getCurrentList = function() { return appState.lists[appState.activeListId] || appState.lists['default']; };

window.switchList = function(listId) {
  if (!appState.lists[listId]) return;
  appState.activeListId = listId;
  // Активный таб — UI-настройка вкладки браузера: sessionStorage, не localStorage.
  try { sessionStorage.setItem(window.UI_STATE_KEY, listId); } catch (e) {}
  populateListSelector();
  currentSort = { field: null, direction: 'asc' };
  document.querySelectorAll('.column-header').forEach(h => {
    h.classList.remove('active');
    h.querySelector('.sort-icon').textContent = '↕';
  });
  // Порядок важен: render() до syncListWithDb(). Рендер мгновенно показывает
  // то, что уже есть в кэше appState.lists (или скелетоны при пустом кэше),
  // а syncListWithDb сам вызовет render() когда придут свежие данные из БД.
  // Если делать наоборот (render после запуска запроса), ранний ответ БД
  // успевает отрисоваться ПОВЕРХ ещё не перерисованного DOM предыдущего
  // списка — пользователь видит мигание: сначала строки старого списка
  // (например, RUS), потом нового (CRYPTO).
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