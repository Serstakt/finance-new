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
// Единый ключ кэша: берём константу CACHE_KEY из state.js (загружается раньше этого
// файла). Фолбэк 'ticker_cache' — на случай загрузки api.js без state.js.
window.CACHE_KEY = window.CACHE_KEY || 'ticker_cache';

// Одноразовая миграция: раньше очистка кэша обращалась к устаревшему ключу
// 'price_cache', из-за чего в localStorage могли остаться «осиротевшие» записи.
try { localStorage.removeItem('price_cache'); } catch(e) {}

window.fetchTickerData = async function(symbol) {
  if (symbol.startsWith('SECTION:')) return null;

  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch(e) {}
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
    // Сохраняем логотип крипты в отдельный долгий кэш (переживает очистку цен)
    if (data && data.logo) rememberCryptoLogo(symbol, data.logo);

    cache[symbol] = { data, timestamp: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch(e) {}

    return data;
  } catch (e) {
    console.error(`Ошибка API для ${symbol}:`, e);
    return null;
  }
};

// === ЛОГОТИПЫ ТИКЕРОВ ===
// Кэш официальных логотипов криптовалют (CoinGecko image) из ответа /api/prices:
// symbol -> url. Пишется при каждой загрузке цены, читается при отрисовке тикера,
// поэтому логотип появляется сразу даже на скелетоне и переживает перезагрузку
// страницы (localStorage).
window.LOGO_CACHE_KEY = 'crypto_logo_cache';
try { window.cryptoLogoCache = JSON.parse(localStorage.getItem(LOGO_CACHE_KEY) || '{}'); }
catch(e) { window.cryptoLogoCache = {}; }

window.rememberCryptoLogo = function(symbol, logoUrl) {
  if (!logoUrl || !symbol) return;
  if (window.cryptoLogoCache[symbol] === logoUrl) return; // не пересохраняем без изменения
  window.cryptoLogoCache[symbol] = logoUrl;
  try { localStorage.setItem(window.LOGO_CACHE_KEY, JSON.stringify(window.cryptoLogoCache)); } catch(e) {}
};

// Вызывается после каждого fetchTickerData: складываем logo из ответа в кэш.
window.cacheLogosFromData = function(symbol, data) {
  if (data && data.logo) rememberCryptoLogo(symbol, data.logo);
};

// HTML логотипа для строки тикера/портфеля.
// Приоритет: официальный логотип крипты (CoinGecko CDN) -> favicon сайта эмитента
// (Google s2) -> буква-заглушка.
window.buildLogoHtml = function(fullSymbol, baseTicker, data) {
  const fallbackLetter = (baseTicker || fullSymbol || '?').charAt(0).toUpperCase();
  const parts = String(fullSymbol || '').toUpperCase().split(':');
  const isCrypto = parts[0] === 'BINANCE' ||
    /USDT$|BTC$|ETH$/.test(String(baseTicker || '').toUpperCase());

  let url = null;
  if (isCrypto) {
    if (data && data.logo) { window.rememberCryptoLogo(fullSymbol, data.logo); url = data.logo; }
    else url = window.cryptoLogoCache[fullSymbol] || window.cryptoLogoCache[`BINANCE:${baseTicker}`] || null;
  }
  if (!url) {
    const domain = window.getCompanyDomain(baseTicker);
    if (domain) url = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  }
  if (!url) {
    return `<div class="ticker-logo-fallback" style="display: flex;">${fallbackLetter}</div>`;
  }
  return `<img src="${url}" class="ticker-logo" alt="${fallbackLetter}" loading="lazy" ` +
    `onerror="this.style.display='none'; this.parentElement.querySelector('.ticker-logo-fallback').style.display='flex';" />` +
    `<div class="ticker-logo-fallback" style="display: none;">${fallbackLetter}</div>`;
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
// Панель под графиком — двухтабовая («Новости» / «Заметки»). Вкладка
// «Новости» активна по умолчанию; loadTickerNews показывает панель, но
// НЕ переключает табы — если пользователь открыл «Заметки», новости
// догружаются в скрытую вкладку.
window.loadTickerNews = async function(symbol, forceRefresh = false) {
  console.log("🚀 [DEBUG] loadTickerNews вызвана для:", symbol, "Force:", forceRefresh);

  if (!symbol || symbol.startsWith('SECTION:')) {
    const panel = document.getElementById('news-panel');
    if (panel) panel.style.display = 'none';
    return;
  }

  const newsPanel = document.getElementById('news-panel');
  const newsList = document.getElementById('news-list');

  if (!newsPanel || !newsList) {
    console.error("❌ [DEBUG] Не найдены элементы!");
    return;
  }

  console.log("✅ [DEBUG] Показываем панель и скелетон...");
  newsPanel.style.display = 'flex';
  // Синхронизируем видимость вкладок с сохранённым выбором (по умолчанию — Новости).
  // Раздел «🚩 Избранные новости» отображается только когда в нём есть добавленные
  // новости: если сохранён выбор «news-fav», а избранного у этого тикета нет
  // (например, лента открылась по другому символу, пока снимок флажков ещё не
  // догружен), switchBottomTab сам вернёт пользователя на «Новости».
  const savedTab = sessionStorage.getItem('bottomTab') || 'news';
  if (typeof switchBottomTab === 'function') switchBottomTab(savedTab);

  // Раздел «🚩 Избранные новости» показываем только когда в нём реально есть
  // добавленные новости: сразу прячем вкладку для тикета, чей снимок флажков
  // ещё не загружен (актуальное состояние выставит loadNewsFavorites ниже —
  // после него лента рисуется только при наличии избранного у этого тикета).
  if (typeof updateNewsFavTabVisibility === 'function') updateNewsFavTabVisibility();

  // Показываем скелетон только если это принудительное обновление или первый запуск
  if (forceRefresh || newsList.children.length === 0) {
      newsList.innerHTML = `
        <div style="text-align: center; color: #787b86; padding: 40px;">
          <div style="font-size: 24px; margin-bottom: 12px;">⏳</div>
          <div>${forceRefresh ? 'Принуд更新ление новостей...' : 'Загрузка новостей...'}</div>
        </div>
      `;
  }

  const tickerNorm = String(symbol || '').replace('MOEX:', '').trim().toUpperCase();

  // === ИЗБРАННОЕ НОВОСТЕЙ — НЕЗАВИСИМО ОТ ЛЕНТЫ «НОВОСТИ» ===
  // Флажки и вкладка «🚩 Избранные новости» тянутся НАПРЯМУЮ из БД
  // (GET /api/news/favorites?ticker=... читает таблицу news_favorites),
  // поэтому запрашиваем их СРАЗУ, не дожидаясь медленного парсинга
  // Telegram во вкладке «Новости». Раздел «Избранные» появляется и
  // открывается сразу после выбора тикета, даже если лента ещё грузится
  // (или вовсе не загрузилась из-за ошибки/таймаута).
  if (!window.newsFavorites) window.newsFavorites = {};
  // Сохраняем промис загрузки избранного — лента будет ждать его только
  // перед отрисовкой карточек (чтобы флажки не «догонялись» позже), но
  // сам запрос стартует немедленно, параллельно с лентой «Новости».
  window.newsFavoritesLoad = Promise.all([
    window.loadNewsFavorites(tickerNorm).catch(() => {}),
    window.loadNewsAllFavorites().catch(() => {}),
  ]).then(() => {
    // Снимок флажков готов — обновляем видимость раздела и, если
    // пользователь уже сидит на вкладке «Избранные», рисуем её по
    // данным из БД, НЕ дожидаясь ответа ленты «Новости».
    updateNewsFavTabVisibility();
    if (sessionStorage.getItem('bottomTab') === 'news-fav'
        && typeof renderNewsFavoritesTab === 'function') {
      renderNewsFavoritesTab(true);
    }
  }).catch(() => {});

  try {
    let news = [];
    if (symbol.startsWith("MOEX:")) {
      const ticker = tickerNorm;

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

    // Ждём снимок флажков только перед отрисовкой ЛЕНТЫ: иначе уже
    // избранные новости мелькнули бы серыми флажками (догоняющая
    // перерисовка выглядит дёрганьем). Важно: сам запрос избранного
    // стартовал выше, параллельно с лентой — лента не ждёт избранное,
    // а избранное и вкладка «🚩 Избранные» не ждут ответ Telegram-парсера.
    if (window.newsFavoritesLoad) {
      try { await window.newsFavoritesLoad; } catch (e) { /* не критично */ }
    }

    // Ссылка на пост — каноничный идентификатор новости (как на бэкенде:
    // https-схема, без хвостового слэша), по нему сверяем флажки.
    const normLink = (l) => {
      let s = (l || '').trim();
      if (s.startsWith('http://')) s = 'https://' + s.slice(7);
      return s.replace(/\/+$/, '');
    };

// Обрезка текста новости для UI: Telegram-посты часто заканчиваются словами
// «Читать далее» / «показать полностью» и т.п. — на вкладке «Новости», а также
// на вкладке «🚩 Избранные» (новости, отмеченные флажком), всё начиная с этих
// слов и до конца отсекаем (полный текст всегда доступен по клику на карточку —
// она ведёт на исходный пост).
const trimNewsTeaser = (text) => {
  const s = String(text == null ? '' : text);
  const re = /(?:читать\s+далее|подробнее\s+в\s+источнике|перейти\s+к\s+публикации|показать\s+полностью|смотреть\s+полностью|читать\s+полностью|\bread\s+more\b|\bview\s+post\b|\bopen\s+post\b)/i;
  const m = re.exec(s);
  if (!m) return s.trim();
  return s.slice(0, m.index).replace(/[\s….,:;«»"'\-\u2013\u2014]+$/g, '').trim();
};
window.trimNewsTeaser = trimNewsTeaser;

// Отображаем новости. Padding вынесен во внутренний div, чтобы скролл не обрезал низ
newsList.innerHTML = `
<div style="padding: 0 20px; margin-top: 12px; flex-shrink: 0;">
    <div style="padding: 8px 12px; background: #2a2e39; border-radius: 6px; font-size: 12px; color: #787b86; display: inline-block;">
        📊 Найдено <strong style="color: #2962ff;">${news.length}</strong> новостей
    </div>
</div>
<div style="padding: 12px 20px 20px 20px; display: flex; flex-direction: column; gap: 12px;">
    ${news.map(n => {
    const link = normLink(n.link);
    const isFav = !!window.newsFavorites[link];
    // На UI показываем только «тизер»: текст до слов «Читать далее» и т.п.
    const teaser = trimNewsTeaser(n.title);
    return `
    <div class="news-item" data-link="${link}" style="display: flex; align-items: stretch;">
        <button type="button" title="${isFav ? 'Убрать из избранного' : 'В избранное'}" aria-pressed="${isFav}"
                onclick="toggleNewsFavorite('${encodeURIComponent(link)}', this)"
                style="flex-shrink: 0; width: 34px; border: none; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px 0 0; color: ${isFav ? '#ef5350' : '#5a5f6b'}; transition: transform .15s;"
                onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">${isFav ? '🚩' : '⚑'}</button>
        <a href="${n.link}" target="_blank" style="flex: 1; min-width: 0; display: flex; gap: 16px; padding: 16px; background: ${isFav ? '#33272a' : '#2a2e39'}; border-radius: 8px; border: 1px solid ${isFav ? '#ef5350' : '#363a45'}; text-decoration: none; color: #d1d4dc; transition: all 0.2s; align-items: flex-start;" onmouseover="this.style.background='#363a45'; this.style.transform='translateY(-2px)'" onmouseout="this.style.background='${isFav ? '#33272a' : '#2a2e39'}'; this.style.transform='translateY(0)'">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 14px; font-weight: 600; margin-bottom: 8px; line-height: 1.4;">${teaser}</div>
                <div style="font-size: 12px; color: #787b86;">${n.publisher}</div>
            </div>
            <div style="font-size: 12px; color: #2962ff; white-space: nowrap; flex-shrink: 0; padding-top: 2px; font-weight: 500;">
                ${n.time || ''}
            </div>
        </a>
    </div>
    `;
    }).join('')}
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

// === ИЗБРАННЫЕ НОВОСТИ (вкладка «Новости» раздела WATCHLIST) ===
// newsFavorites — актуальное избранное {link: {ticker, title}} из БД.
// ВАЖНО (логика «избранное по тикерам»): когда выбран тикет, по нему
// выгружается лента новостей; флажок 🚩 ставится в контексте этого тикера
// (в POST сохраняется ticker), и вкладка «🚩 Избранные» показывает только
// избранные новости выбранного тикера. Для другого тикета — своё избранное.
// Флажок-кнопка слева от новости: ⚑ (серый контурный) = не избранная,
// 🚩 (красный) = избранная. Отметка ставится/снимается на сервере
// (POST /api/news/favorite), поэтому переживает смену браузера/устройства.
// Вкладка «🚩 Избранные» (между «Новостями» и «Заметками») отображается
// только когда в ней есть добавленные новости — т.е. у выбранного тикета
// есть хотя бы одна избранная новость (см. currentTickerHasFavorites и
// renderNewsFavoritesTab ниже).
window.newsFavorites = window.newsFavorites || {};

// Все избранные новости по всем тикерам {link: {ticker, title}} — нужно
// только для видимости вкладки «Избранные». Вкладка показывается ТОЛЬКО
// когда в ней есть добавленные новости: т.е. выбран тикет и у этого тикета
// есть хотя бы одна избранная новость. При выборе другого тикета без его
// собственного избранного вкладка скрывается. Заполняется
// loadNewsAllFavorites() (используется как словарь меты тикер→название).
window.newsFavoritesAll = window.newsFavoritesAll || {};

// Тикер, чьё избранное сейчас лежит в window.newsFavorites (синхронизация
// при переключении тикеров без перезагрузки страницы).
window.newsFavoritesTicker = window.newsFavoritesTicker || null;

// Кэш списка избранного для вкладки «Избранные Новости» выбранного тикера
// (GET /api/news/favorites/list?ticker=...): [{link, ticker, title, time}, ...].
window.newsFavoritesList = window.newsFavoritesList || [];
window.newsFavoritesListTicker = window.newsFavoritesListTicker || null;

// Есть ли у ВЫБРАННОГО тикета избранные новости. Источник истины —
// window.newsFavorites: снимок избранного именно текущего тикера
// (GET /api/news/favorites?ticker=...), который перезапрашивается при каждом
// выборе тикета вместе с лентой новостей. newsFavoritesTicker — защита от
// «опоздавших» ответов: если снимок относится к другому тикеру, считаем
// избранного нет до его обновления.
function currentTickerHasFavorites() {
  const ticker = currentNewsTicker();
  if (!ticker) return false;
  if (window.newsFavoritesTicker !== ticker) return false;
  return Object.keys(window.newsFavorites || {}).length > 0;
}

// Показывает/скрывает раздел «🚩 Избранные новости» (вкладка между «Новостями»
// и «Заметками»). Раздел отображается ТОЛЬКО когда в нём есть добавленные
// новости: т.е. у выбранного тикета есть хотя бы одна избранная новость
// (флажок 🚩). Кнопка вкладки изначально скрыта (style="display:none" в
// index.html); при выборе другого тикета без его собственного избранного
// вкладка скрывается, а если активная вкладка была «Избранные» — возвращаемся
// на «Новости».
window.updateNewsFavTabVisibility = function() {
  const btn = document.getElementById('news-fav-tab-btn');
  if (!btn) return;
  const hasAny = currentTickerHasFavorites();
  btn.style.display = hasAny ? '' : 'none';
  // Панель-контейнер раздела — тоже видима только при наличии избранного
  // (иначе под вкладками оставалась бы пустая полоса прокрутки).
  const pane = document.getElementById('news-fav-list');
  if (pane && !hasAny && sessionStorage.getItem('bottomTab') !== 'news-fav') {
    pane.style.display = 'none';
  }
  if (!hasAny && sessionStorage.getItem('bottomTab') === 'news-fav'
      && typeof switchBottomTab === 'function') {
    switchBottomTab('news');
  }
};

// Актуальное избранное по всем тикерам — словарь метаинформации
// {link: {ticker, title}} (используется как fallback при отрисовке вкладки;
// видимость вкладки определяется избранным выбранного тикета).
window.loadNewsAllFavorites = async function() {
  try {
    const res = await window.fetchWithTimeout(`${API_BASE}/api/news/favorites`, {}, 15000);
    if (!res.ok) return;
    const data = await res.json();
    window.newsFavoritesAll = data.favorites || {};
    updateNewsFavTabVisibility();
  } catch (e) {
    console.error('Ошибка загрузки всего избранного новостей:', e);
  }
};

// Флажки выбранного тикера: GET /api/news/favorites?ticker=SBER.
// При смене тикета лента новостей перезапрашивается вместе с этим списком,
// поэтому красные флажки (и содержимое вкладки «Избранные») всегда
// соответствуют именно текущему тикету.
window.loadNewsFavorites = async function(ticker) {
  const norm = String(ticker || '').replace('MOEX:', '').trim().toUpperCase();
  // Раздел «🚩 Избранные новости» отображается только когда в нём реально есть
  // добавленные новости. При смене тикета сразу помечаем снимок флажков
  // устаревшим (пустым) и прячем вкладку: иначе до ответа сервера на экране
  // висело бы избранное предыдущего тикета. Актуальное состояние выставит
  // updateNewsFavTabVisibility() после загрузки ответа ниже.
  window.newsFavoritesTicker = norm || null;
  window.newsFavorites = {};
  updateNewsFavTabVisibility();
  try {
    const url = `${API_BASE}/api/news/favorites` +
      (norm ? `?ticker=${encodeURIComponent(norm)}` : '');
    const res = await window.fetchWithTimeout(url, {}, 15000);
    if (!res.ok) return;
    const data = await res.json();
    window.newsFavorites = data.favorites || {};
    window.newsFavoritesTicker = norm || null;
    // Если лента уже отрисована — обновляем флажки без полной перерисовки
    document.querySelectorAll('#news-list .news-item').forEach(updateNewsItemFlag);
    updateNewsFavTabVisibility();
  } catch (e) {
    console.error('Ошибка загрузки избранного новостей:', e);
  }
};

// Перекрашивает одну карточку новости под текущее состояние избранного.
// Ищет карточку по data-link во всех списках: и в ленте «Новости»,
// и во вкладке «Избранные Новости». Вкладка теперь индивидуальна по
// тикерам, поэтому там флажок всегда красный — не зависит от снимка
// window.newsFavorites выбранного тикета (иначе карточка из «Избранного»
// при синхронизации состояния стала бы серой).
window.updateNewsItemFlag = function(itemOrLink) {
  const items = (typeof itemOrLink === 'string')
    ? document.querySelectorAll(`.news-item[data-link="${CSS.escape(itemOrLink)}"]`)
    : [itemOrLink];
  for (const item of items) {
  if (!item) continue;
  const link = item.dataset.link || '';
  const inFavPane = !!(item.closest && item.closest('#news-fav-list'));
  const isFav = inFavPane || !!window.newsFavorites[link];
  const btn = item.querySelector('button');
  const card = item.querySelector('a');
  if (btn) {
    btn.textContent = isFav ? '🚩' : '⚑';
    btn.style.color = isFav ? '#ef5350' : '#5a5f6b';
    btn.title = isFav ? 'Убрать из избранного' : 'В избранное';
    btn.setAttribute('aria-pressed', String(isFav));
  }
  if (card) {
    card.style.background = isFav ? '#33272a' : '#2a2e39';
    card.style.borderColor = isFav ? '#ef5350' : '#363a45';
    // hover-обработчики инлайновые — пересоздаём их с новым «базовым» цветом
    card.onmouseover = () => { card.style.background = '#363a45'; card.style.transform = 'translateY(-2px)'; };
    card.onmouseout = () => { card.style.background = isFav ? '#33272a' : '#2a2e39'; card.style.transform = 'translateY(0)'; };
  }
  }
};

// Клик по флажку: ставим/снимаем избранное. Ссылка передаётся закодированной,
// чтобы не ломать inline-обработчик спецсимволами. Работает и из ленты
// «Новости», и из вкладки «Избранные Новости» (там флажок всегда красный —
// клик по нему снимает отметку, и карточка исчезает из избранной вкладки).
window.toggleNewsFavorite = async function(encodedLink, btnEl) {
  let link = encodedLink;
  try { link = decodeURIComponent(encodedLink); } catch (e) { /* оставляем как есть */ }
  if (!link) return;

  const item = btnEl ? btnEl.closest('.news-item') : null;
  const wasFav = !!window.newsFavorites[link];

  // Тикер, по которому открыта лента — сохраняем в контекст избранной новости
  const cur = typeof getCurrentList === 'function' ? getCurrentList() : null;
  const ticker = cur && cur.activeSymbol ? cur.activeSymbol.replace('MOEX:', '').toUpperCase() : null;
  const titleEl = item ? item.querySelector('a div div') : null;

  // Мгновенный отклик: меняем вид флажка до ответа сервера
  if (wasFav) delete window.newsFavorites[link];
  else window.newsFavorites[link] = { ticker: ticker || null, title: titleEl ? titleEl.textContent.trim().slice(0, 300) : null };
  updateNewsItemFlag(link);
  // Синхронизируем «глобальный» снимок избранного (словарь метаинформации).
  // Видимость вкладки «🚩 Избранные» зависит от избранного выбранного тикета:
  // первый флажок — вкладка появляется, снятие последнего у этого тикета —
  // скрывается (избранное других тикетов на это не влияет).
  if (wasFav) delete window.newsFavoritesAll[link];
  else window.newsFavoritesAll[link] = window.newsFavorites[link];
  updateNewsFavTabVisibility();
  syncNewsFavoritesList(link, !wasFav, item);

  try {
    const res = await window.fetchWithTimeout(`${API_BASE}/api/news/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        link: link,
        favorite: !wasFav,
        ticker: ticker,
        title: titleEl ? titleEl.textContent.trim().slice(0, 300) : null,
      }),
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error('Ошибка сохранения избранной новости:', e);
    // откат оптимистичного изменения при ошибке сети/сервера
    if (wasFav) window.newsFavorites[link] = { ticker: ticker || null, title: titleEl ? titleEl.textContent.trim().slice(0, 300) : null };
    else delete window.newsFavorites[link];
    if (wasFav) window.newsFavoritesAll[link] = window.newsFavorites[link];
    else delete window.newsFavoritesAll[link];
    updateNewsItemFlag(link);
    updateNewsFavTabVisibility();
    syncNewsFavoritesList(link, wasFav, item);
  }
};

// Обновляет кэш newsFavoritesList после локального переключения флажка,
// чтобы вкладка «Избранные Новости» оставалась синхронной без лишнего
// запроса к серверу. Список относится только к выбранному тикеру: при
// снятии флажка карточка убирается из вкладки, при добавлении — полный
// перезапрос списка (нужны заголовок/время поста, которых у нас локально
// может не быть).
window.syncNewsFavoritesList = function(link, added, item) {
  if (!Array.isArray(window.newsFavoritesList)) window.newsFavoritesList = [];
  const idx = window.newsFavoritesList.findIndex(n => n.link === link);
  if (!added) {
    // снимаем везде: удаляем карточку из вкладки «Избранные», если она там есть
    if (idx !== -1) window.newsFavoritesList.splice(idx, 1);
    const favPane = document.getElementById('news-fav-list');
    const favItem = favPane ? favPane.querySelector(`.news-item[data-link="${CSS.escape(link)}"]`) : null;
    if (favItem) favItem.remove();
    if (favPane && sessionStorage.getItem('bottomTab') === 'news-fav'
        && window.newsFavoritesList.length === 0) renderNewsFavoritesTab();
    return;
  }
  if (idx !== -1) return; // уже в списке
  if (item && item.closest('#news-fav-list')) return; // пришла из этой же вкладки
  if (typeof renderNewsFavoritesTab === 'function') renderNewsFavoritesTab(true);
};

// Тикер, чьё избранное показывается во вкладке «Избранные Новости»:
// активный символ текущего списка watchlist (у каждого тикета своё
// избранное). Пустая строка, если тикет ещё не выбран.
function currentNewsTicker() {
  const cur = typeof getCurrentList === 'function' ? getCurrentList() : null;
  return cur && cur.activeSymbol
    ? cur.activeSymbol.replace('MOEX:', '').trim().toUpperCase()
    : '';
}

// === ВКЛАДКА «ИЗБРАННЫЕ НОВОСТИ» (между «Новостями» и «Заметками») ===
// Раздел отображается только когда в нём есть добавленные новости: т.е.
// у ВЫБРАННОГО тикета есть хотя бы одна избранная новость (флажок 🚩).
// Внутри — избранные посты именно выбранного тикера (свежие сверху),
// каждый с красным флажком 🚩 слева; клик по флажку снимает избранное и
// убирает карточку. При выборе другого тикета перерисовывается его
// собственное избранное (а своего нет — вкладка скрывается).
window.renderNewsFavoritesTab = async function(force = false) {
  const pane = document.getElementById('news-fav-list');
  if (!pane) return;
  const ticker = currentNewsTicker();
  // Избранное привязано к тикету: без выбранного тикета или без избранного
  // у него раздел пуст — прячем вкладку (updateNewsFavTabVisibility сама
  // вернёт пользователя на «Новости», если он сидел на «Избранных»).
  if (!ticker || !currentTickerHasFavorites()) {
    window.newsFavoritesList = [];
    window.newsFavoritesListTicker = null;
    pane.innerHTML = `<div style="padding: 20px; text-align: center; color: #787b86;">
        Избранных новостей пока нет — отметьте новость флажком 🚩 во вкладке «Новости»
    </div>`;
    updateNewsFavTabVisibility();
    return;
  }
  updateNewsFavTabVisibility();
  // Черновая отрисовка из имеющегося кэша — но только если кэш относится
  // к тому же тикеру (иначе под ним избранное другого тикета — мигаем
  // пустой вкладкой до ответа сервера, это честнее чужого списка).
  if (window.newsFavoritesListTicker === (ticker || null)) {
    drawNewsFavorites(pane, window.newsFavoritesList.filter(n => window.newsFavorites[n.link]), ticker);
  } else {
    pane.innerHTML = `<div style="padding: 20px; text-align: center; color: #787b86;">Загрузка избранного...</div>`;
  }
  // Данные тянутся НАПРЯМУЮ из БД (GET /api/news/favorites/list?ticker=...):
  // бэкенд читает news_favorites + news_cache и отвечает сразу, не дожидаясь
  // загрузки ленты во вкладке «Новости» и не запуская парсинг Telegram.
  // Поэтому здесь нет ни принудительного loadTickerNews, ни ожидания её
  // ответа — вкладка «Избранные» полностью независима от «Новостей».
  try {
    const url = `${API_BASE}/api/news/favorites/list` +
      (ticker ? `?ticker=${encodeURIComponent(ticker)}` : '');
    const res = await window.fetchWithTimeout(url, {}, 15000);
    if (!res.ok) return;
    const data = await res.json();
    window.newsFavoritesList = data.news || [];
    window.newsFavoritesListTicker = ticker || null;
    // Сервер мог ответить уже для другого тикета (пользователь переключился) —
    // рисуем только актуальный ответ.
    if (currentNewsTicker() === ticker) {
      drawNewsFavorites(pane, window.newsFavoritesList, ticker);
    }
  } catch (e) {
    console.error('Ошибка загрузки списка избранных новостей:', e);
  }
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function drawNewsFavorites(pane, items, ticker) {
  if (!items || items.length === 0) {
    const who = ticker ? ` по тикеру ${escapeHtml(ticker)}` : '';
    pane.innerHTML = `<div style="padding: 20px; text-align: center; color: #787b86;">
        Избранных новостей${who} пока нет — отметьте новость флажком 🚩 во вкладке «Новости»
    </div>`;
    return;
  }
  const shownTicker = (items[0] && items[0].ticker) || ticker || '';
  pane.innerHTML = `
<div style="padding: 0 20px; margin-top: 12px; flex-shrink: 0;">
    <div style="padding: 8px 12px; background: #2a2e39; border-radius: 6px; font-size: 12px; color: #787b86; display: inline-block;">
        🚩 Избранные новости${shownTicker ? ` (${escapeHtml(shownTicker)})` : ''}: <strong style="color: #ef5350;">${items.length}</strong>
    </div>
</div>
<div style="padding: 12px 20px 20px 20px; display: flex; flex-direction: column; gap: 12px;">
    ${items.map(n => {
    const link = n.link || '';
    // Бейдж тикера показываем только если он отличается от выбранного
    // (вкладка теперь индивидуальна по тикерам — свой бейдж не нужен).
    const itemTicker = String(n.ticker || '').replace('MOEX:', '').trim().toUpperCase();
    const tickerBadge = (itemTicker && itemTicker !== String(ticker || '').toUpperCase())
      ? `<span style="display:inline-block; margin-right:8px; padding:2px 8px; background:#363a45; border-radius:4px; font-size:11px; color:#2962ff; font-weight:600;">${escapeHtml(itemTicker)}</span>`
      : '';
    // Как и на вкладке «Новости»: на UI показываем только «тизер» — текст до
    // слов «Читать далее» и т.п.; всё, начиная с этих слов и до конца, отсекаем.
    const teaser = trimNewsTeaser(n.title || link);
    return `
    <div class="news-item" data-link="${escapeHtml(link)}" style="display: flex; align-items: stretch;">
        <button type="button" title="Убрать из избранного" aria-pressed="true"
                onclick="toggleNewsFavorite('${encodeURIComponent(link)}', this)"
                style="flex-shrink: 0; width: 34px; border: none; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px 0 0; color: #ef5350; transition: transform .15s;"
                onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">🚩</button>
        <a href="${escapeHtml(link)}" target="_blank" style="flex: 1; min-width: 0; display: flex; gap: 16px; padding: 16px; background: #33272a; border-radius: 8px; border: 1px solid #ef5350; text-decoration: none; color: #d1d4dc; transition: all 0.2s; align-items: flex-start;" onmouseover="this.style.background='#363a45'; this.style.transform='translateY(-2px)'" onmouseout="this.style.background='#33272a'; this.style.transform='translateY(0)'">
            <div style="flex: 1; min-width: 0;">
                <div style="font-size: 14px; font-weight: 600; margin-bottom: 8px; line-height: 1.4;">${tickerBadge}${escapeHtml(teaser)}</div>
                <div style="font-size: 12px; color: #787b86;">Smart-Lab News</div>
            </div>
            <div style="font-size: 12px; color: #2962ff; white-space: nowrap; flex-shrink: 0; padding-top: 2px; font-weight: 500;">
                ${escapeHtml(n.time || '')}
            </div>
        </a>
    </div>
    `;
    }).join('')}
</div>
`;
}

// === АНИМАЦИЯ СКЕЛЕТОНА ===
if (!document.getElementById('news-skeleton-style')) {
  const style = document.createElement('style');
  style.id = 'news-skeleton-style';
  style.textContent = `@keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }`;
  document.head.appendChild(style);
}