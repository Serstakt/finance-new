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

window.render = async function() {
  const currentList = getCurrentList();
  const container = document.getElementById('ticker-list');
  if (!container) return;
  populateListSelector();

  // Запрашиваем цены ПАРАЛЛЕЛЬНО (с таймаутом в fetchTickerData).
  // Последовательный await для каждого тикера складывал задержки: при медленном
  // внешнем API список «загружался» бесконечно долго.
  const dataMap = {};
  const symbols = currentList.tickers.filter(s => !s.startsWith('SECTION:'));
  const results = await Promise.all(symbols.map(sym => fetchTickerData(sym)));
  symbols.forEach((sym, i) => { dataMap[sym] = results[i]; });

  const sortedList = sortList(currentList.tickers, dataMap);
  container.innerHTML = '';

  if (sortedList.length > 0 && !currentList.activeSymbol) {
    const firstTicker = sortedList.find(s => !s.startsWith('SECTION:'));
    if (firstTicker) { currentList.activeSymbol = firstTicker; saveState(); }
  }

  let isCollapsed = false;
  for (const sym of sortedList) {
    if (sym.startsWith('SECTION:')) {
      isCollapsed = currentList.collapsedSections && currentList.collapsedSections.includes(sym);
      const sectionName = sym.replace('SECTION:', '');
      const div = document.createElement('div');
      div.className = 'section-header' + (isCollapsed ? ' collapsed' : '');
      div.innerHTML = `
        <span class="drag-handle" title="Перетащить">⋮</span>
        <span class="section-collapse-btn" title="Свернуть/Развернуть">${isCollapsed ? '▶' : '▼'}</span>
        <span class="section-title" title="Дважды кликните, чтобы переименовать">${sectionName}</span>
        <span class="ticker-remove" data-symbol="${sym}" title="Удалить раздел">×</span>`;

      div.querySelector('.section-collapse-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!currentList.collapsedSections) currentList.collapsedSections = [];
        const nowCollapsed = !currentList.collapsedSections.includes(sym);
        if (nowCollapsed) currentList.collapsedSections.push(sym);
        else currentList.collapsedSections = currentList.collapsedSections.filter(s => s !== sym);
        saveState(); render();
        // состояние свёрнутости раздела живёт в БД (watchlist_items.collapsed),
        // а не только в localStorage — переживает смену браузера
        setCollapsedInDb(appState.activeListId, sym, nowCollapsed);
      });

      div.querySelector('.ticker-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Удалить раздел "${sectionName}"?`)) {
          currentList.tickers = currentList.tickers.filter(s => s !== sym);
          if (currentList.collapsedSections) currentList.collapsedSections = currentList.collapsedSections.filter(s => s !== sym);
          saveState(); render();
          await saveOrderToDb(appState.activeListId, currentList.tickers); // удаляем из БД
        }
      });

      div.querySelector('.section-title').addEventListener('dblclick', async () => {
        const newName = prompt('Введите новое название раздела:', sectionName);
        if (!newName || !newName.trim() || newName.trim() === sectionName) return;
        const newSectionSymbol = `SECTION:${newName.trim()}`;
        const index = currentList.tickers.indexOf(sym);
        if (index !== -1) {
          currentList.tickers[index] = newSectionSymbol;
          if (currentList.collapsedSections && currentList.collapsedSections.includes(sym)) {
            currentList.collapsedSections[currentList.collapsedSections.indexOf(sym)] = newSectionSymbol;
          }
          saveState(); render();
          await saveOrderToDb(appState.activeListId, currentList.tickers); // переименование раздела — в БД
          log(`Раздел переименован: "${sectionName}" → "${newName.trim()}"`, 'success');
        }
      });
      container.appendChild(div);
      continue;
    }

    const div = document.createElement('div');
    div.className = 'ticker-item' + (sym === currentList.activeSymbol ? ' active' : '');
    if (isCollapsed) div.style.display = 'none';

    const safeId = sym.replace(/[^a-zA-Z0-9]/g, '_');
    const parts = sym.split(':');
    const data = dataMap[sym];
    const fallbackLetter = (parts.length > 1 ? parts[1] : sym).charAt(0);
    const baseTicker = parts.length > 1 ? parts[1] : sym;
    const smartLabUrl = `https://smart-lab.ru/forum/${baseTicker}/`;

    const flagColor = appState.favorites[sym] || null;
    const flagHex = flagColor ? FLAG_COLORS[flagColor].hex : '#363a45';
    const flagClass = flagColor ? '' : 'empty';
    const pickerActiveClass = activePickerSymbol === sym ? 'active' : '';

    const bellStatus = getBellStatusForSymbol(sym);
    let bellClass = 'alert-bell';
    if (bellStatus === 'active') bellClass += ' active';
    else if (bellStatus === 'triggered') bellClass += ' triggered';

    let logoInnerHtml = buildLogoHtml(sym, baseTicker, data);

    div.innerHTML = `
      <span class="drag-handle" title="Перетащить">⋮</span>
      <div class="favorite-wrapper" onclick="toggleFavoritePicker('${sym}', event)" title="${flagColor ? 'Нажмите, чтобы убрать из избранного' : 'Нажмите, чтобы выбрать цвет'}">
        <span class="favorite-flag ${flagClass}" style="color: ${flagHex}">⚑</span>
        <div class="favorite-picker ${pickerActiveClass}">
          <span onclick="event.stopPropagation(); setFavorite('${sym}', 'red')" style="color:#ef5350" title="Красный">🔴</span>
          <span onclick="event.stopPropagation(); setFavorite('${sym}', 'blue')" style="color:#2962ff" title="Синий">🔵</span>
          <span onclick="event.stopPropagation(); setFavorite('${sym}', 'yellow')" style="color:#ffca28" title="Желтый">🟡</span>
          <span onclick="event.stopPropagation(); setFavorite('${sym}', 'orange')" style="color:#ff9800" title="Оранжевый">🟠</span>
          <span onclick="event.stopPropagation(); setFavorite('${sym}', 'green')" style="color:#26a69a" title="Зеленый">🟢</span>
        </div>
      </div>
      <div class="ticker-logo-container">${logoInnerHtml}</div>
      <div class="ticker-info">
        <a href="${smartLabUrl}" target="_blank" rel="noopener noreferrer" class="ticker-symbol-link" title="Открыть ${baseTicker} на Smart-Lab" onclick="event.stopPropagation();">${baseTicker}</a>
      </div>
      <div class="ticker-price" id="price-${safeId}">${data?.price ? formatNumber(data.price) : '<div class="skeleton skeleton-price"></div>'}</div>
      <div class="ticker-change" id="change-val-${safeId}">${data?.changeValue !== undefined && data?.changeValue !== null ? '' : '<div class="skeleton skeleton-change"></div>'}</div>
      <div class="ticker-change-percent" id="change-pct-${safeId}">${data?.changeDay !== undefined && data?.changeDay !== null ? '' : '<div class="skeleton skeleton-change-pct"></div>'}</div>
      <span class="alert-bell ${bellClass}" data-symbol="${sym}" onclick="event.stopPropagation(); openAlertModal('${sym}')" title="Настроить ценовое уведомление">🔔</span>
      <span class="ticker-remove" data-symbol="${sym}" title="Удалить">×</span>`;

    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('ticker-remove') || e.target.classList.contains('drag-handle') || e.target.classList.contains('ticker-symbol-link') || e.target.closest('.favorite-wrapper') || e.target.classList.contains('alert-bell')) return;
      currentList.activeSymbol = sym;
      saveState();
      createChart(sym);
      document.querySelectorAll('.ticker-item').forEach(el => el.classList.remove('active'));
      div.classList.add('active');
    });

    div.querySelector('.ticker-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (appState.activeListId.startsWith('fav_')) {
        setFavorite(sym, null);
      } else {
        currentList.tickers = currentList.tickers.filter(s => s !== sym);
        if (currentList.activeSymbol === sym) {
          currentList.activeSymbol = currentList.tickers.find(s => !s.startsWith('SECTION:')) || '';
        }
        saveState(); render();
        await removeTickerFromDb(appState.activeListId, sym); // удаляем из БД
      }
    });

    const priceEl = div.querySelector(`#price-${safeId}`);
    const changeValEl = div.querySelector(`#change-val-${safeId}`);
    const changePctEl = div.querySelector(`#change-pct-${safeId}`);

    if (data && data.price) {
      priceEl.textContent = formatNumber(data.price);
      // Бэкенд-проверка алертов «по горячим следам»: сразу после обновления
      // цен просим сервер проверить активные условия (POST /api/alerts/check).
      // Фоновый цикл сервера делает то же самое каждые 60 с, но при открытом
      // терминале реакция должна быть мгновенной. Повторный запуск отменяет
      // предыдущий таймер — синхронизация не наслаивается при автообновлении.
      clearTimeout(window.__alertSyncTimer);
      window.__alertSyncTimer = setTimeout(() => { syncAlertsWithDb(); }, 1500);

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
    } else {
      priceEl.innerHTML = '<span class="error-text" title="Возможно, временная блокировка MOEX">Сбой сети</span>';
      changeValEl.innerHTML = '<span class="error-text">—</span>';
      changeValEl.className = 'ticker-change';
      changePctEl.innerHTML = '<span class="error-text">—</span>';
      changePctEl.className = 'ticker-change-percent';
    }

    container.appendChild(div);
  }

  if (currentList.activeSymbol && !currentList.activeSymbol.startsWith('SECTION:')) {
    createChart(currentList.activeSymbol);
  } else {
    document.getElementById('tradingview_chart').innerHTML = '<div class="error-msg" style="display:flex;align-items:center;justify-content:center;height:100%;">Добавьте тикер в список</div>';
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
  closeAlertModal();
  await loadAlertsFromDb();
};

window.openAlertsListModal = async function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    window.alert('Сначала выберите тикер в списке!');
    return;
  }
  document.getElementById('alerts-list-symbol').textContent = symbol;
  document.getElementById('alerts-list-modal').classList.add('active');
  // Список алертов берём из БД (свежие статусы, включая сработавшие сервером)
  await loadAlertsFromDb();
  renderAlertsList(symbol);
};

window.closeAlertsListModal = function() {
  document.getElementById('alerts-list-modal').classList.remove('active');
};

window.renderAlertsList = function(symbol) {
  const alerts = window.dbAlerts || [];
  const symbolAlerts = alerts.filter(a => a.symbol === symbol);
  const container = document.getElementById('alerts-list-content');
  container.innerHTML = '';

  if (symbolAlerts.length === 0) {
    container.innerHTML = '<div style="text-align:center; color:#787b86; padding:20px;">Нет алертов для этого тикера</div>';
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
    container.appendChild(div);
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
    }
  } catch (e) {
    console.error('Ошибка синхронизации алертов с БД:', e);
  }
};

window.createChart = function(symbol) {
    console.log("📊 [DEBUG] createChart вызвана для:", symbol);
    const chartDiv = document.getElementById('tradingview_chart');
    if (!chartDiv) return;

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
            }
        });
    }

    // ЯВНЫЙ ВЫЗОВ НОВОСТЕЙ
    if (typeof window.loadTickerNews === 'function') {
        console.log("✅ [DEBUG] Вызываем loadTickerNews для:", symbol);
        window.loadTickerNews(symbol);
    } else {
        console.error("❌ [DEBUG] Функция loadTickerNews НЕ НАЙДЕНА!");
    }
};