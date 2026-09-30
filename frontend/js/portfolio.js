// === ПОРТФЕЛЬ: УПРАВЛЕНИЕ И ВИЗУАЛИЗАЦИЯ ===

let portfolioPieChart = null;
let portfolioBarChart = null;
let currentChartMode = 'ticker'; // 'ticker' или 'sector'

window.setChartMode = function(mode) {
  currentChartMode = mode;

  const btnTicker = document.getElementById('chart-mode-ticker');
  const btnSector = document.getElementById('chart-mode-sector');

  if (mode === 'sector') {
    btnSector.style.background = '#2962ff';
    btnSector.style.color = '#fff';
    btnTicker.style.background = '#2a2e39';
    btnTicker.style.color = '#d1d4dc';
  } else {
    btnTicker.style.background = '#2962ff';
    btnTicker.style.color = '#fff';
    btnSector.style.background = '#2a2e39';
    btnSector.style.color = '#d1d4dc';
  }

  if (window.lastPortfolioData && window.lastPortfolioData.positions) {
    renderPieChart(window.lastPortfolioData.positions);
  }
};

// Загрузка данных портфеля
window.loadPortfolio = async function() {
  try {
    const response = await window.fetchWithTimeout(API_BASE + '/api/portfolio', {}, 30000);
    if (!response.ok) throw new Error('Failed to load portfolio');

    const data = await response.json();
    window.lastPortfolioData = data;
    renderPortfolio(data);
    updatePortfolioSummary(data);
    renderPortfolioCharts(data);
  } catch (error) {
    console.error('Ошибка загрузки портфеля:', error);
    document.getElementById('portfolio-tbody').innerHTML =
      '<tr><td colspan="8" class="empty-state">Ошибка загрузки данных</td></tr>';
  }
};

// Отрисовка таблицы позиций
function renderPortfolio(data) {
  const tbody = document.getElementById('portfolio-tbody');

  if (!data.positions || data.positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Портфель пуст. Добавьте первую позицию!</td></tr>';
    return;
  }

  tbody.innerHTML = data.positions.map(pos => {
    const pnlClass = pos.pnl >= 0 ? 'text-green' : 'text-red';
    const pnlSign = pos.pnl >= 0 ? '+' : '';

    // === ЛОГИКА ДЛЯ ЛОГОТИПА (как в watchlist) ===
    const parts = pos.symbol.split(':');
    const baseTicker = parts.length > 1 ? parts[1] : pos.symbol; // Убираем "MOEX:"
    const domain = getCompanyDomain(baseTicker);
    const fallbackLetter = baseTicker.charAt(0);

    const logoInnerHtml = domain
      ? `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=128" class="ticker-logo" onerror="this.style.display='none'; this.parentElement.querySelector('.ticker-logo-fallback').style.display='flex';" /><div class="ticker-logo-fallback" style="display: none;">${fallbackLetter}</div>`
      : `<div class="ticker-logo-fallback" style="display: flex;">${fallbackLetter}</div>`;
    // ==============================================

    return `
      <tr>
        <td>
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="ticker-logo-container">${logoInnerHtml}</div>
            <strong>${baseTicker}</strong>
          </div>
        </td>
        <td>${pos.quantity.toFixed(2)}</td>
        <td><strong>${pos.avg_price.toFixed(2)} ₽</strong></td>
        <td>${pos.current_price.toFixed(2)} ₽</td>
        <td>${(pos.quantity * pos.current_price).toFixed(2)} ₽</td>
        <td class="${pnlClass}">${pnlSign}${pos.pnl.toFixed(2)} ₽</td>
        <td class="${pnlClass}">${pnlSign}${pos.pnl_pct.toFixed(2)}%</td>
        <td>
          <button class="btn-icon delete" onclick="deletePosition('${pos.symbol}')" title="Удалить">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Обновление сводной статистики
function updatePortfolioSummary(data) {
  document.getElementById('total-value').textContent = `${data.total_value.toFixed(2)} ₽`;
  document.getElementById('total-invested').textContent = `${data.total_invested.toFixed(2)} ₽`;

  const pnlEl = document.getElementById('total-pnl');
  const pnlPctEl = document.getElementById('total-pnl-pct');

  const pnlSign = data.total_pnl >= 0 ? '+' : '';
  pnlEl.textContent = `${pnlSign}${data.total_pnl.toFixed(2)} ₽`;
  pnlEl.className = `value ${data.total_pnl >= 0 ? 'text-green' : 'text-red'}`;

  pnlPctEl.textContent = `${pnlSign}${data.total_pnl_pct.toFixed(2)}%`;
  pnlPctEl.className = `sub-value ${data.total_pnl >= 0 ? 'text-green' : 'text-red'}`;

  document.getElementById('total-positions').textContent = data.positions.length;
}

// Отрисовка графиков
function renderPortfolioCharts(data) {
  renderPieChart(data.positions);
  renderBarChart(data.positions);
}

// Круговая диаграмма распределения
function renderPieChart(positions) {
  const ctx = document.getElementById('portfolio-pie-chart').getContext('2d');

  if (portfolioPieChart) {
    portfolioPieChart.destroy();
  }

  let labels = [];
  let values = [];

  if (currentChartMode === 'sector') {
    const sectorMap = {};
    positions.forEach(pos => {
      // Явно проверяем, что сектор существует и не является пустой строкой
      const sec = (pos.sector && pos.sector.trim() !== "") ? pos.sector.trim() : "Не указан";
      const val = (pos.quantity || 0) * (pos.current_price || 0);

      console.log(`   ➕ Обработка: Тикер ${pos.symbol}, Сектор: "${sec}", Стоимость: ${val}`);

      sectorMap[sec] = (sectorMap[sec] || 0) + val;
    });

    labels = Object.keys(sectorMap);
    values = Object.values(sectorMap);

    console.log("🗂️ Итоговая группировка по секторам:", sectorMap);
    } else {
        labels = positions.map(p => p.symbol.includes(':') ? p.symbol.split(':')[1] : p.symbol);
        values = positions.map(p => (p.quantity || 0) * (p.current_price || 0));
      }

  const colors = [
    '#2962ff', '#26a69a', '#ffca28', '#ef5350', '#ab47bc',
    '#ff7043', '#5c6bc0', '#29b6f6', '#66bb6a', '#ffa726', '#787b86'
  ];

  portfolioPieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#1e222d',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#d1d4dc',
            font: { size: 12 },
            padding: 15
          }
        },
        tooltip: {
          backgroundColor: '#1e222d',
          titleColor: '#d1d4dc',
          bodyColor: '#d1d4dc',
          borderColor: '#363a45',
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              const value = context.parsed;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${context.label}: ${value.toFixed(2)} ₽ (${percentage}%)`;
            }
          }
        }
      }
    }
  });
}

// Столбчатая диаграмма P&L
function renderBarChart(positions) {
  const ctx = document.getElementById('portfolio-bar-chart').getContext('2d');

  if (portfolioBarChart) {
    portfolioBarChart.destroy();
  }

  // Убираем префикс биржи для подписей на оси X
  const labels = positions.map(p => p.symbol.includes(':') ? p.symbol.split(':')[1] : p.symbol);
  const pnlValues = positions.map(p => p.pnl);

  // === ЭТА СТРОКА ОБЯЗАТЕЛЬНА: определяем цвета до их использования ===
  const colors = pnlValues.map(pnl => pnl >= 0 ? '#26a69a' : '#ef5350');

  portfolioBarChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'P&L (₽)',
        data: pnlValues,
        backgroundColor: colors, // Теперь переменная colors существует
        borderColor: colors,
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#d1d4dc' }
        },
        tooltip: {
          backgroundColor: '#1e222d',
          titleColor: '#d1d4dc',
          bodyColor: '#d1d4dc',
          borderColor: '#363a45',
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              const value = context.parsed.y;
              const sign = value >= 0 ? '+' : '';
              return `${sign}${value.toFixed(2)} ₽`;
            }
          }
        }
      },
      scales: {
        y: {
          grid: { color: '#2a2e39' },
          ticks: { color: '#787b86' }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#787b86' }
        }
      }
    }
  });
}

// Модальное окно добавления позиции
window.openAddPositionModal = function() {
  document.getElementById('add-position-modal').classList.add('active');
  document.getElementById('position-symbol').value = '';
  document.getElementById('position-quantity').value = '';
  document.getElementById('position-avg-price').value = '';
};

window.closeAddPositionModal = function() {
  document.getElementById('add-position-modal').classList.remove('active');
};

window.savePosition = async function() {
  const symbol = document.getElementById('position-symbol').value.replace(/\s+/g, '').toUpperCase();
  const quantity = parseFloat(document.getElementById('position-quantity').value);
  const avgPrice = parseFloat(document.getElementById('position-avg-price').value);
  const sector = document.getElementById('position-sector').value;

  if (!symbol || isNaN(quantity) || isNaN(avgPrice) || quantity <= 0 || avgPrice <= 0) {
    alert('Пожалуйста, заполните все поля корректно. Пример: MOEX:SBER, кол-во > 0, цена > 0');
    return;
  }

  try {
    const response = await window.fetchWithTimeout(API_BASE + '/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, quantity, avg_price: avgPrice, sector: sector })
    });

    if (!response.ok) throw new Error('Failed to add position');

    closeAddPositionModal();
    await loadPortfolio();
    log(`Добавлена позиция: ${symbol}`, 'success');
  } catch (error) {
    console.error('Ошибка добавления позиции:', error);
    alert('Ошибка при добавлении позиции');
  }
};

// Удаление позиции
window.deletePosition = async function(symbol) {
  if (!confirm(`Удалить позицию ${symbol}?`)) return;

  // Очищаем символ от пробелов и приводим к верхнему регистру
  const cleanSymbol = symbol.replace(/\s+/g, '').toUpperCase();
  console.log(`🗑️ Удаление позиции: '${cleanSymbol}' (исходный: '${symbol}')`);

  try {
    // Используем encodeURIComponent для безопасного URL
    const response = await window.fetchWithTimeout(`${API_BASE}/api/portfolio/${encodeURIComponent(cleanSymbol)}`, {
      method: 'DELETE'
    }, 30000);

    const data = await response.json();
    console.log('📡 Ответ от сервера:', data);

    if (!response.ok || data.status === 'error') {
      throw new Error(data.message || 'Failed to delete position');
    }

    await loadPortfolio();
    log(`Удалена позиция: ${cleanSymbol}`, 'success');
  } catch (error) {
    console.error('❌ Ошибка удаления позиции:', error);
    alert(`Ошибка при удалении позиции: ${error.message}`);
  }
};

// Обновление портфеля
window.refreshPortfolio = async function() {
  await loadPortfolio();
  log('Портфель обновлен', 'success');
};

// Инициализация при загрузке страницы портфеля
const originalNavigateTo = window.navigateTo;
window.navigateTo = function(pageName) {
  originalNavigateTo(pageName);

  if (pageName === 'portfolio') {
    // Загружаем Chart.js динамически, если еще не загружен
    if (!window.Chart) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      script.onload = () => loadPortfolio();
      document.head.appendChild(script);
    } else {
      loadPortfolio();
    }
  }
};