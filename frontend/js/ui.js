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
        if (currentList.collapsedSections.includes(sym)) currentList.collapsedSections = currentList.collapsedSections.filter(s => s !== sym);
        else currentList.collapsedSections.push(sym);
        saveState(); render();
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
    const domain = getCompanyDomain(parts.length > 1 ? parts[1] : sym);
    const fallbackLetter = (parts.length > 1 ? parts[1] : sym).charAt(0);
    const baseTicker = parts.length > 1 ? parts[1] : sym;
    const smartLabUrl = `https://smart-lab.ru/forum/${baseTicker}/`;

    const flagColor = appState.favorites[sym] || null;
    const flagHex = flagColor ? FLAG_COLORS[flagColor].hex : '#363a45';
    const flagClass = flagColor ? '' : 'empty';
    const pickerActiveClass = activePickerSymbol === sym ? 'active' : '';

    const alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
    const hasActiveAlert = alerts.some(a => a.symbol === sym && a.status === 'active');
    const hasTriggeredAlert = alerts.some(a => a.symbol === sym && a.status === 'triggered');

    let bellClass = 'alert-bell';
    if (hasActiveAlert) bellClass += ' active';
    else if (hasTriggeredAlert) bellClass += ' triggered';

    let logoInnerHtml = domain
      ? `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=128" class="ticker-logo" onerror="this.style.display='none'; this.parentElement.querySelector('.ticker-logo-fallback').style.display='flex';" /><div class="ticker-logo-fallback" style="display: none;">${fallbackLetter}</div>`
      : `<div class="ticker-logo-fallback" style="display: flex;">${fallbackLetter}</div>`;

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
      checkAlerts(sym, data.price);

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

window.createChart = function(symbol) {
  const chartDiv = document.getElementById('tradingview_chart');
  if (!chartDiv) return;
  if (typeof TradingView === 'undefined') {
    chartDiv.innerHTML = '<div class="error-msg">⚠️ Ошибка загрузки скрипта TradingView.</div>';
    return;
  }
  if (widget && widgetReady) {
    widget.setSymbol(symbol, 'D', () => {});
    return;
  }
  chartDiv.innerHTML = '';
  widget = new TradingView.widget({
    "autosize": true, "symbol": symbol, "interval": "D", "timezone": "Etc/UTC",
    "theme": "dark", "style": "1", "locale": "ru", "toolbar_bg": "#1e222d",
    "enable_publishing": false, "hide_top_toolbar": false, "hide_legend": false,
    "save_image": false, "container_id": "tradingview_chart",
    "onready": () => { widgetReady = true; }
  });
};

// === АЛЕРТЫ UI ===
window.updateBellIconStatus = function(symbol, status) {
  const items = document.querySelectorAll('.ticker-item');
  items.forEach(item => {
    const bell = item.querySelector('.alert-bell');
    if (bell && bell.getAttribute('data-symbol') === symbol) {
      bell.classList.remove('active', 'triggered');
      if (status === 'active') bell.classList.add('active');
      else if (status === 'triggered') bell.classList.add('triggered');
    }
  });
};

window.openAlertModal = function(symbol) {
  currentAlertSymbol = symbol;
  document.getElementById('alert-symbol-name').textContent = symbol;
  document.getElementById('alert-modal').classList.add('active');

  const alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  const existingAlert = alerts.find(a => a.symbol === symbol && a.status === 'active');

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

window.trimAlertsHistory = function() {
  let alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  const symbolCounts = {};
  const newAlerts = [];
  for (let i = alerts.length - 1; i >= 0; i--) {
    const alert = alerts[i];
    if (!symbolCounts[alert.symbol]) symbolCounts[alert.symbol] = 0;
    if (symbolCounts[alert.symbol] < 10) {
      newAlerts.unshift(alert);
      symbolCounts[alert.symbol]++;
    }
  }
  localStorage.setItem(ALERTS_KEY, JSON.stringify(newAlerts));
};

window.saveAlert = function() {
  if (!currentAlertSymbol) return;
  const condition = document.getElementById('alert-condition').value;
  const target = parseFloat(document.getElementById('alert-target-price').value);

  if (isNaN(target) || target <= 0) {
    window.alert('Пожалуйста, введите корректную целевую цену.');
    return;
  }

  let alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  alerts.push({ id: Date.now().toString(), symbol: currentAlertSymbol, condition: condition, target: target, active: true, status: 'active' });

  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
  trimAlertsHistory();
  log(`Алерт установлен для ${currentAlertSymbol}: ${condition} ${target}`, 'success');
  closeAlertModal();
  updateBellIconStatus(currentAlertSymbol, 'active');
};

window.deleteAlert = function() {
  if (!currentAlertSymbol) return;
  let alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  const indexToRemove = alerts.findIndex(a => a.symbol === currentAlertSymbol && a.status === 'active');
  if (indexToRemove !== -1) alerts.splice(indexToRemove, 1);

  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
  trimAlertsHistory();
  log(`Алерт для ${currentAlertSymbol} удален`, 'info');
  closeAlertModal();

  const hasRemainingActive = alerts.some(a => a.symbol === currentAlertSymbol && a.status === 'active');
  updateBellIconStatus(currentAlertSymbol, hasRemainingActive ? 'active' : 'none');
};

window.openAlertsListModal = function() {
  const symbol = getCurrentList().activeSymbol;
  if (!symbol || symbol.startsWith('SECTION:')) {
    window.alert('Сначала выберите тикер в списке!');
    return;
  }
  document.getElementById('alerts-list-symbol').textContent = symbol;
  renderAlertsList(symbol);
  document.getElementById('alerts-list-modal').classList.add('active');
};

window.closeAlertsListModal = function() {
  document.getElementById('alerts-list-modal').classList.remove('active');
};

window.renderAlertsList = function(symbol) {
  const alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  const symbolAlerts = alerts.filter(a => a.symbol === symbol);
  const container = document.getElementById('alerts-list-content');
  container.innerHTML = '';

  if (symbolAlerts.length === 0) {
    container.innerHTML = '<div style="text-align:center; color:#787b86; padding:20px;">Нет алертов для этого тикера</div>';
    return;
  }

  const statusOrder = { 'active': 1, 'triggered': 2, 'cancelled': 3 };
  symbolAlerts.sort((a, b) => {
    const statusA = a.status || (a.active ? 'active' : 'triggered');
    const statusB = b.status || (b.active ? 'active' : 'triggered');
    return statusOrder[statusA] - statusOrder[statusB];
  });

  symbolAlerts.forEach((alertData, index) => {
    const originalIndex = alerts.indexOf(alertData);
    let status = alertData.status || (alertData.active ? 'active' : 'triggered');
    let statusText = '', statusClass = '', actionBtn = '';

    if (status === 'active') {
      statusText = '🟢 В работе'; statusClass = 'status-active';
      actionBtn = `<button class="mini-btn" onclick="cancelAlert('${symbol}', ${originalIndex})">Отменить</button>`;
    } else if (status === 'triggered') {
      statusText = '✅ Исполнено'; statusClass = 'status-triggered';
    } else {
      statusText = '⛔ Отменено'; statusClass = 'status-cancelled';
    }

    const conditionText = alertData.condition === 'above' ? '≥' : '≤';
    const div = document.createElement('div');
    div.className = `alert-list-item ${statusClass === 'status-active' ? 'status-active' : (statusClass === 'status-triggered' ? 'status-triggered' : 'status-cancelled')}`;
    div.innerHTML = `
      <div class="alert-item-info">
        <span class="alert-item-condition">${conditionText} ${alertData.target}</span>
        <span class="alert-status ${statusClass}">${statusText}</span>
      </div>
      ${actionBtn}`;
    container.appendChild(div);
  });
};

window.cancelAlert = function(symbol, originalIndex) {
  let alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  if (alerts[originalIndex]) {
    alerts[originalIndex].active = false;
    alerts[originalIndex].status = 'cancelled';
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
    trimAlertsHistory();
    renderAlertsList(symbol);
    const hasRemainingActive = alerts.some(a => a.symbol === symbol && a.status === 'active');
    updateBellIconStatus(symbol, hasRemainingActive ? 'active' : 'none');
    log(`Алерт для ${symbol} отменен вручную`, 'info');
  }
};

window.checkAlerts = function(symbol, currentPrice) {
  let alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
  const alertIndex = alerts.findIndex(a => a.symbol === symbol && a.active === true && a.status !== 'cancelled');
  if (alertIndex === -1) return;

  const alertData = alerts[alertIndex];
  const current = parseFloat(currentPrice);
  const target = parseFloat(alertData.target);

  if (isNaN(current) || isNaN(target)) return;

  let triggered = false;
  if (alertData.condition === 'above' && current >= target) triggered = true;
  if (alertData.condition === 'below' && current <= target) triggered = true;

  if (triggered) {
    const msg = `🚨 ${alertData.symbol}: Цена ${current} достигла цели (${alertData.condition === 'above' ? 'выше' : 'ниже'} ${target})`;
    playAlertSound();
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Финансовый терминал: Алерт!", { body: msg });
    } else {
      window.alert(msg);
    }
    log(`Алерт сработал: ${msg}`, 'success');
    alerts[alertIndex].active = false;
    alerts[alertIndex].status = 'triggered';
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
    trimAlertsHistory();
    updateBellIconStatus(symbol, 'triggered');
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