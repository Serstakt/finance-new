// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
window.delay = ms => new Promise(res => setTimeout(res, ms));

// База для API-запросов: если страница открыта через этот же сервер (uvicorn),
// используется тот же origin. Иначе (например, фронтенд открыт отдельно) — localhost:8000.
window.API_BASE = (location.protocol === 'http:' || location.protocol === 'https:') && location.port !== ''
  ? '' : 'http://localhost:8000';

// === БЕЗОПАСНЫЙ FETCH С ТАЙМАУТОМ ===
// Обычный fetch к внешнему/зависшему сервису может «висеть» бесконечно —
// из-за этого вкладки крутят индикатор загрузки. Обрываем такие запросы по таймеру.
window.fetchWithTimeout = function(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

// === ПОЛУЧЕНИЕ ДАННЫХ ПО ТИКЕРУ ===
window.fetchTickerData = async function(symbol) {
  if (symbol.startsWith('SECTION:')) return null;

  let cache = {};
  try { cache = JSON.parse(localStorage.getItem('ticker_cache') || '{}'); } catch(e) {}
  if (cache[symbol] && (Date.now() - cache[symbol].timestamp) < 120000) {
    return cache[symbol].data;
  }

  try {
    // Таймаут 20 с: если MOEX/CoinGecko не отвечают — отказ, а не вечная загрузка
    const response = await window.fetchWithTimeout(
      `${API_BASE}/api/prices/${encodeURIComponent(symbol)}`, {}, 20000
    );
    if (!response.ok) return null;
    const data = await response.json();

    cache[symbol] = { data, timestamp: Date.now() };
    try { localStorage.setItem('ticker_cache', JSON.stringify(cache)); } catch(e) {}

    return data;
  } catch (e) {
    console.error(`Ошибка API для ${symbol}:`, e);
    return null;
  }
};

// === СЛОВАРЬ ДОМЕНОВ ДЛЯ ЛОГОТИПОВ ===
window.getCompanyDomain = function(ticker) {
  const domains = {
    'SBER': 'sber.ru', 'SBERP': 'sber.ru', 'VTBR': 'vtb.ru', 'SVCB': 'sovcombank.ru',
    'T': 't-technologies.ru', 'CBOM': 'cbom.ru', 'MOEX': 'moex.com', 'IMOEX': 'moex.com',
    'INDEX_RTS': 'moex.com', 'ASSB': 'absolutbank.ru', 'AVAN': 'avangard.ru', 'SFIN': 'sfin.ru',
    'GAZP': 'gazprom.ru', 'SIBN': 'gazprom.ru', 'LKOH': 'lukoil.ru', 'ROSN': 'rosneft.ru',
    'RNFT': 'rosneft.ru', 'NVTK': 'novatek.ru', 'TATN': 'tatneft.ru', 'TATNP': 'tatneft.ru',
    'SNGS': 'surgutneftegas.ru', 'SNGSP': 'surgutneftegas.ru', 'TRNFP': 'transneft.ru',
    'NGTK': 'ngtk.ru', 'LSNGP': 'lenenergo.ru', 'GMKN': 'nornickel.ru', 'NLMK': 'nlmk.com',
    'CHMF': 'severstal.com', 'CHMK': 'chmk.ru', 'ALRS': 'alrosa.ru', 'RUAL': 'rusal.ru',
    'PLZL': 'polyus.com', 'DOMRF': 'дом.рф', 'POLY': 'polymetal.com', 'SPBE': 'spbexchange.ru',
    'RASP': 'raspadskaya.ru', 'TGMK': 'tugmk.ru', 'IRGZ': 'irg.ru', 'AKRN': 'akron.ru',
    'PHOR': 'phosagro.ru', 'URKZ': 'urkz.ru', 'RBCM': 'rbcm.ru', 'SMLT': 'samlet.ru',
    'FEES': 'rosseti.ru', 'RENI': 'renins.ru', 'IRAO': 'interrao.ru', 'ENPG': 'enel.ru',
    'UPRO': 'unipro.ru', 'MSNG': 'mosenergo.ru', 'DVEC': 'dvec.ru', 'OGKB': 'ogk2.ru',
    'TGKA': 'tgka.ru', 'TGKB': 'tgkb.ru', 'TGKD': 'tgkd.ru', 'TGSN': 'tgsn.ru',
    'VGSB': 'vgsb.ru', 'VGSO': 'vgso.ru', 'VJGZ': 'vjgz.ru', 'MSRS': 'msrs.ru',
    'KOGK': 'kogk.ru', 'RKKE': 'rkke.ru', 'THRO': 'thro.ru', 'TKIM': 'tkim.ru',
    'YNDX': 'yandex.ru', 'MTSS': 'mts.ru', 'RTKM': 'rostelecom.ru', 'RTKMP': 'rostelecom.ru',
    'VKCO': 'vk.company', 'OZON': 'ozon.ru', 'POSI': 'group.ptsecurity.com', 'HEAD': 'investor.hh.ru',
    'DIAS': 'diasoft.ru', 'CNRU': 'ir.ciangroup.ru', 'ASTS': 'asts.ru', 'MGNT': 'magnit.ru',
    'X5': 'x5.ru', 'FIVE': '5ka.ru', 'LENT': 'lenta.com', 'DETL': 'detmir.ru', 'MVID': 'mvideo.ru',
    'SELG': 'selgros.ru', 'OKEY': 'ok.ru', 'AFLT': 'aeroflot.ru', 'FLOT': 'sovcomflot.ru',
    'FESH': 'fesco.ru', 'NMTP': 'nmtport.ru', 'TRMK': 'tmk-group.com', 'RAGR': 'rusagro.ru',
    'AGRO': 'rusagrogroup.ru', 'AFKS': 'afksistema.ru', 'SGZH': 'sgzh.ru', 'TORS': 'tors.ru',
    'SGBE': 'sgbe.ru', 'MRKY': 'mrk-group.ru', 'MRKS': 'mrk-group.ru', 'MRK': 'mrk-group.ru',
    'MRKP': 'mrk-group.ru', 'MRKU': 'mrk-group.ru', 'BELU': 'beluga.ru', 'BLNG': 'beluga.ru',
    'DZRD': 'dzerzhinsk.ru', 'KMAZ': 'kamaz.ru', 'USBN': 'usbn.ru',
    'UTAR': 'utar.ru', 'UTII': 'utii.ru', 'UVEK': 'uvek.ru', 'MDMG': 'mcclinics.ru',
    'YRSB': 'yrsb.ru', 'APTK': '366.ru', 'PRMD': 'promomed.pro', 'BTCUSDT': 'bitcoin.org',
    'ETHUSDT': 'ethereum.org', 'BNBUSDT': 'binance.com', 'SOLUSDT': 'solana.com',
    'XRPUSDT': 'ripple.com', 'ADAUSDT': 'cardano.org', 'DOGEUSDT': 'dogecoin.com',
    'TONUSDT': 'ton.org', 'AAPL': 'apple.com', 'TSLA': 'tesla.com', 'MSFT': 'microsoft.com',
    'GOOGL': 'abc.xyz', 'GOOG': 'abc.xyz', 'AMZN': 'amazon.com', 'NVDA': 'nvidia.com',
    'META': 'meta.com', 'NFLX': 'netflix.com', 'INTC': 'intel.com', 'AMD': 'amd.com',
    'CSCO': 'cisco.com', 'ADBE': 'adobe.com', 'PEP': 'pepsico.com', 'COST': 'costco.com',
    'TMUS': 't-mobile.com', 'AVGO': 'broadcom.com', 'TXN': 'ti.com', 'QCOM': 'qualcomm.com',
    'BABA': 'alibaba.com', 'TCEHY': 'tencent.com', 'NIO': 'nio.com'
  };
  return domains[ticker] || null;
};

// === ОПРЕДЕЛЕНИЕ БИРЖИ ПО ТИКЕРУ ===
window.detectExchange = function(symbol) {
  const sym = symbol.toUpperCase().trim();

  // 1. Явное исправление валютных пар MOEX
  if (sym === 'MOEX:BYNRUB' || sym === 'BYNRUB') return 'MOEX:BYNRUB_TOM';
  if (sym === 'MOEX:USD' || sym === 'USD') return 'MOEX:USD000UTSTOM';
  if (sym === 'MOEX:EUR' || sym === 'EUR') return 'MOEX:EUR_RUB__TOM';
  if (sym === 'MOEX:CNY' || sym === 'CNY') return 'MOEX:CNYRUB';

  // 2. Если уже есть корректный префикс, оставляем как есть
  if (symbol.includes(':')) return symbol;

  // 3. Криптовалюты
  if (sym.endsWith('USDT') || sym.endsWith('BTC') || sym.endsWith('ETH') || sym === 'BNBUSDT') {
    return `BINANCE:${sym}`;
  }

  // 4. Индексы Мосбиржи
  const moexIndices = ['IMOEX', 'IRUS', 'RTSI', 'RGBI', 'RUBIUSDT', 'MOEX'];

  // 5. Остальные валюты и акции Мосбиржи
  const moexCurrencies = ['BYNRUB_TOM', 'USD000UTSTOM', 'EUR_RUB__TOM', 'CNYRUB', 'RUB'];
  const moexTickers = new Set(['SBER', 'GAZP', 'LKOH', 'VTBR', 'YNDX', 'YDEX', 'TATN', 'MGNT', 'RTKM', 'OZON', 'FIVE', 'LENT', 'AFLT', 'AFKS', 'AKRN', 'ENPG', 'FEES', 'FLOT', 'HYDR', 'IRGZ', 'TRMK', 'UPRO', 'VKCO', 'RAGR', 'AGRO', 'LSNGP', 'NGTK', 'T', 'CBOM', 'ASSB', 'AVAN', 'SFIN', 'TRNFP', 'TGMK', 'URKZ', 'RBCM', 'SMLT', 'TGKA', 'TGKB', 'TGKD', 'TGSN', 'VGSB', 'VGSO', 'VJGZ', 'MSRS', 'KOGK', 'RKKE', 'THRO', 'TKIM', 'HEAD', 'MGTSP', 'CNTL', 'ASTS', 'DETL', 'MVID', 'SELG', 'OKEY', 'FESH', 'NMTP', 'SGBE', 'MRKY', 'MRKS', 'MRK', 'MRKP', 'MRKU', 'BELU', 'BLNG', 'DZRD', 'KMAZ', 'SPBE', 'USBN', 'UTAR', 'UTII', 'UVEK', 'MDMG', 'YRSB', 'APTK', 'PRMD', 'SBERP', 'SIBN', 'TATNP', 'ROSN', 'RNFT', 'GMKN', 'NVTK', 'CHMF', 'CHMK', 'ALRS', 'NLMK', 'PLZL', 'POLY', 'RUAL', 'SNGS', 'SNGSP', 'PHOR', 'IRAO', 'MTSS']);

  if (moexIndices.includes(sym) || moexCurrencies.includes(sym) || moexTickers.has(sym)) {
    return `MOEX:${sym}`;
  }

  // 6. Сырьевые товары и мировые индексы — только для отображения на TradingView,
  //    цены по ним через внешний API не запрашиваются (котировки берут MOEX/крипто).

  // По умолчанию считаем тикером Мосбиржи
  return `MOEX:${sym}`;
};

// === ЛЕНТА НОВОСТЕЙ ИЗ TELEGRAM (@newssmartlab) ===
window.loadTickerNews = async function(symbol, forceRefresh = false) {
  console.log("🚀 [DEBUG] loadTickerNews вызвана для:", symbol, "Force:", forceRefresh);

  if (!symbol || symbol.startsWith('SECTION:')) {
    const panel = document.getElementById('news-panel');
    if (panel) panel.style.display = 'none';
    return;
  }

  const newsPanel = document.getElementById('news-panel');
  const newsList = document.getElementById('news-list');
  const symbolSpan = document.getElementById('news-panel-symbol');

  if (!newsPanel || !newsList || !symbolSpan) {
    console.error("❌ [DEBUG] Не найдены элементы!");
    return;
  }

  console.log("✅ [DEBUG] Показываем панель и скелетон...");
  newsPanel.style.display = 'flex';
  symbolSpan.textContent = symbol;

  // Показываем скелетон только если это принудительное обновление или первый запуск
  if (forceRefresh || newsList.children.length === 0) {
      newsList.innerHTML = `
        <div style="text-align: center; color: #787b86; padding: 40px;">
          <div style="font-size: 24px; margin-bottom: 12px;">⏳</div>
          <div>${forceRefresh ? 'Принуд更新ление новостей...' : 'Загрузка новостей...'}</div>
        </div>
      `;
  }

  try {
    let news = [];
    if (symbol.startsWith("MOEX:")) {
      const ticker = symbol.replace("MOEX:", "").toUpperCase();

      // Добавляем параметр force_refresh в URL запроса
      const url = `/api/news/telegram/${ticker}?force_refresh=${forceRefresh}`;
      console.log("📡 [DEBUG] Отправляем fetch на:", url);

      // Парсинг Telegram-канала может занимать десятки секунд — ставим таймаут 60 с,
      // чтобы запрос не «висел» бесконечно и не удерживал индикатор загрузки вкладки
      const response = await window.fetchWithTimeout(url, {}, 60000);
      console.log("📥 [DEBUG] Ответ получен, статус:", response.status);

      if (response.ok) {
        const data = await response.json();
        news = data.news || [];
      }
    }


// Отображаем новости. Padding вынесен во внутренний div, чтобы скролл не обрезал низ
newsList.innerHTML = `
<div style="padding: 0 20px; margin-top: 12px; flex-shrink: 0;">
    <div style="padding: 8px 12px; background: #2a2e39; border-radius: 6px; font-size: 12px; color: #787b86; display: inline-block;">
        📊 Найдено <strong style="color: #2962ff;">${news.length}</strong> новостей
    </div>
</div>
<div style="padding: 12px 20px 20px 20px; display: flex; flex-direction: column; gap: 12px;">
    ${news.map(n => `
    <a href="${n.link}" target="_blank" style="display: flex; gap: 16px; padding: 16px; background: #2a2e39; border-radius: 8px; border: 1px solid #363a45; text-decoration: none; color: #d1d4dc; transition: all 0.2s; align-items: flex-start;" onmouseover="this.style.background='#363a45'; this.style.transform='translateY(-2px)'" onmouseout="this.style.background='#2a2e39'; this.style.transform='translateY(0)'">
        <div style="flex: 1; min-width: 0;">
            <div style="font-size: 14px; font-weight: 600; margin-bottom: 8px; line-height: 1.4;">${n.title}</div>
            <div style="font-size: 12px; color: #787b86;">${n.publisher}</div>
        </div>
        <div style="font-size: 12px; color: #2962ff; white-space: nowrap; flex-shrink: 0; padding-top: 2px; font-weight: 500;">
            ${n.time || ''}
        </div>
    </a>
    `).join('')}
</div>
`;

  } catch (error) {
    console.error('Ошибка загрузки новостей:', error);
    newsList.innerHTML = `<div style="text-align: center; color: #ef5350; padding: 20px;">Ошибка загрузки</div>`;
  }
};

// === КНОПКА ОБНОВЛЕНИЯ НОВОСТЕЙ ===
window.refreshNews = function() {
  const currentList = getCurrentList();
  if (currentList && currentList.activeSymbol) {
    // Передаем true, чтобы бэкенд проигнорировал кэш и спарсил заново
    window.loadTickerNews(currentList.activeSymbol, true);
  }
};

// === АНИМАЦИЯ СКЕЛЕТОНА ===
if (!document.getElementById('news-skeleton-style')) {
  const style = document.createElement('style');
  style.id = 'news-skeleton-style';
  style.textContent = `@keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }`;
  document.head.appendChild(style);
}