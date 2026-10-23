// === ЖИВЫЕ ДАННЫЕ WATCHLIST ЧЕРЕЗ SSE (Server-Sent Events) ===
// Раньше этот раздел каждые 120 с запускал волну GET /api/prices по каждому
// тикеру списка плюс POST /api/alerts/check после перерисовки. Теперь
// браузер держит ОДНО долгое соединение GET /api/live/stream и получает:
//   - 'hello'  — статус потока сразу после подписки;
//   - 'prices' — пачку обновлённых котировок (сервер сам опрашивает
//                MOEX/CoinGecko по адаптивному графику);
//   - 'alerts' — актуальный снимок алертов из БД (push вместо таймера);
//   - 'ok'/комментарий «: hb» — heartbeat, признак здорового соединения.
// Если EventSource недоступен или поток оборвался более чем на FALLBACK_AFTER_MS,
// модуль возвращает прежний цикл автообновления каждые 120 с (startAutoRefresh),
// поэтому раздел не остаётся без данных ни при каком прокси/браузере.

window.LIVE_ENDPOINT = `${API_BASE}/api/live/stream`;
window.LIVE_CLIENT_ID = (() => {
  // Стабильный id вкладки: попадёт в query потока и в POST /api/live/symbols,
  // чтобы сервер понимал, каким символом принадлежит подписка.
  try { return sessionStorage.getItem('liveClientId') || ''; } catch (e) { return ''; }
})();
if (!window.LIVE_CLIENT_ID) {
  window.LIVE_CLIENT_ID = 'c-' + Math.random().toString(36).slice(2, 10);
  try { sessionStorage.setItem('liveClientId', window.LIVE_CLIENT_ID); } catch (e) {}
}

window.liveState = {
  es: null,            // текущий EventSource
  connected: false,    // поток жив (последнее событие свежее STALE_MS)
  lastEventAt: 0,      // время последнего события/heartbeat
  interval: 120,       // фактический период серверного цикла (из 'hello')
  reconnectTimer: null,
  watchdog: null,
  fallbackActive: false, // сейчас работает старый polling
};

const FALLBACK_AFTER_MS = 95000;  // нет событий ~95 с -> поднимаем polling
const STALE_MS = 70000;           // «LIVE» гаснет раньше серверного heartbeat-цикла
const RECONNECT_MIN_MS = 3000;    // экспоненциальный рестарт: 3, 6, 12 ... до 60 с
const RECONNECT_MAX_MS = 60000;

// --- набор тикеров, которые реально видны в watchlist -----------------------
window.watchlistSymbolsForLive = function() {
  const out = [];
  const lists = (appState && appState.lists) || {};
  for (const id of Object.keys(lists)) {
    const t = lists[id] && lists[id].tickers;
    if (Array.isArray(t)) t.forEach(s => { if (s && !s.startsWith('SECTION:')) out.push(s); });
  }
  return [...new Set(out)];
};

// Сообщаем серверу актуальный состав списков (он опрашивает внешние API
// только для этих тикеров). Вызывается при подключении и при каждом
// изменении состава watchlist (см. notifyLiveSymbols ниже).
window.pushLiveSymbols = async function() {
  const symbols = watchlistSymbolsForLive();
  try {
    await fetchWithTimeout(`${API_BASE}/api/live/symbols`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: LIVE_CLIENT_ID, symbols })
    }, 10000);
  } catch (e) { /* сервер перезапускается — следующая пачка 'prices' всё равно придёт */ }
};

// --- применение снимка цен ---------------------------------------------------
// Ключи quotes совпадают с ключами REST /api/prices ('MOEX:SBER',
// 'BINANCE:BTC' либо голый тикер), поэтому строка списка обновляется напрямую.
window.applyLiveQuotes = function(quotes) {
  if (!quotes) return;
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) {}
  const now = Date.now();
  const touched = [];
  for (const sym of Object.keys(quotes)) {
    const data = quotes[sym];
    if (!data || data.price === undefined || data.price === null) continue;
    if (data.logo) rememberCryptoLogo(sym, data.logo);
    cache[sym] = { data, timestamp: now };
    touched.push(sym);
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  if (!touched.length) return;

  // Обновляем in-memory кэш последнего рендера — тогда лёгкая перерисовка
  // (canRenderWithoutPrices) рисует новые цены без единого REST-запроса.
  if (window.__lastRenderData) {
    for (const sym of touched) window.__lastRenderData[sym] = quotes[sym];
    window.__lastRenderAt = now;
  }

  // Рисуем, только если страница watchlist активна (в фоне смысла нет —
  // при возврате render() возьмёт данные из свежего кэша).
  if (sessionStorage.getItem('activePage') === 'watchlist' && typeof render === 'function') {
    render();
  }
};

// --- применение снимка алертов ----------------------------------------------
// Push-событие 'alerts' заменяет и GET /api/alerts по таймеру, и POST
// /api/alerts/check после каждой перерисовки: бэкенд проверяет условия сам
// (live-цикл + фоновый checker) и досылает новые статусы всем вкладкам.
window.applyLiveAlerts = function(alerts) {
  if (!Array.isArray(alerts)) return;
  const prev = window.dbAlerts || [];
  const prevById = new Map(prev.map(a => [a.id, a]));
  const triggeredNow = alerts.filter(a =>
    a.status === 'triggered' && prevById.get(a.id) && prevById.get(a.id).status !== 'triggered');
  window.dbAlerts = alerts;
  refreshAllBells();
  if (sessionStorage.getItem('bottomTab') === 'alerts' && typeof renderAlertsList === 'function') {
    const cur = getCurrentList();
    if (cur && cur.activeSymbol) renderAlertsList(cur.activeSymbol);
  }
  // Уведомление о новых срабатываниях — тот же путь, что у syncAlertsWithDb
  for (const t of triggeredNow) {
    const msg = `🚨 ${t.symbol}: Цена ${t.triggered_price} достигла цели (${t.condition === 'above' ? 'выше' : 'ниже'} ${t.target})`;
    if (typeof playAlertSound === 'function') playAlertSound();
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Финансовый терминал: Алерт!", { body: msg });
    } else {
      window.alert(msg);
    }
    if (typeof log === 'function') log(`Алерт сработал (SSE push): ${msg}`, 'success');
  }
};

// --- индикатор в шапке -------------------------------------------------------
// Пока поток жив — зелёная точка и подпись «LIVE» (период серверного цикла);
// при деградации на polling возвращается прежний обратный отсчёт 120 с.
window.updateLiveIndicator = function() {
  const wrap = document.getElementById('auto-refresh-indicator');
  if (!wrap) return;
  const cd = document.getElementById('countdown');
  const st = window.liveState;
  const live = st.connected && (Date.now() - st.lastEventAt) < STALE_MS;
  wrap.classList.toggle('live', live);
  if (cd) {
    if (live) cd.textContent = `LIVE·${st.interval}с`;
    else if (st.fallbackActive) updateCountdownDisplay();
  }
};

// --- деградация на прежний polling ------------------------------------------
function enterFallback(reason) {
  const st = window.liveState;
  if (st.fallbackActive) return;
  st.fallbackActive = true;
  st.connected = false;
  if (typeof startAutoRefresh === 'function') startAutoRefresh(); // прежний цикл 120 с
  if (typeof log === 'function') log(`SSE live: ${reason} — временный опрос каждые 120 с`, 'info');
  updateLiveIndicator();
}

function leaveFallback() {
  const st = window.liveState;
  if (!st.fallbackActive) return;
  st.fallbackActive = false;
  if (window.autoRefreshTimer) { clearInterval(window.autoRefreshTimer); window.autoRefreshTimer = null; }
  if (window.countdownTimer) { clearInterval(window.countdownTimer); window.countdownTimer = null; }
  if (typeof log === 'function') log('SSE live: поток восстановлен — периодический опрос отключён', 'success');
}

// --- подключение к потоку ----------------------------------------------------
let reconnectDelay = RECONNECT_MIN_MS;

window.connectLiveStream = function() {
  if (typeof EventSource === 'undefined') {
    enterFallback('EventSource не поддерживается браузером');
    return;
  }
  const st = window.liveState;
  if (st.es) { try { st.es.close(); } catch (e) {} st.es = null; }

  const symbols = encodeURIComponent(watchlistSymbolsForLive().join(','));
  const url = `${LIVE_ENDPOINT}?client_id=${encodeURIComponent(LIVE_CLIENT_ID)}&symbols=${symbols}`;
  const es = new EventSource(url);
  st.es = es;

  es.addEventListener('hello', (ev) => {
    st.connected = true;
    st.lastEventAt = Date.now();
    try {
      const d = JSON.parse(ev.data);
      if (d.interval) st.interval = d.interval;
    } catch (e) {}
    reconnectDelay = RECONNECT_MIN_MS; // соединение подтверждено — сбрасываем backoff
    leaveFallback();
    updateLiveIndicator();
    if (typeof log === 'function') log(`SSE live: подключено (цикл сервера ${st.interval} с)`, 'success');
  });

  es.addEventListener('prices', (ev) => {
    st.lastEventAt = Date.now();
    st.connected = true;
    leaveFallback();
    updateLiveIndicator();
    try { applyLiveQuotes(JSON.parse(ev.data).quotes); } catch (e) {}
  });

  es.addEventListener('alerts', (ev) => {
    st.lastEventAt = Date.now();
    try { applyLiveAlerts(JSON.parse(ev.data).alerts); } catch (e) {}
  });

  // heartbeat ('ok' и комментарии «: hb» до onmessage не доходят — слушаем и open)
  es.addEventListener('ok', () => {
    st.lastEventAt = Date.now();
    st.connected = true;
    updateLiveIndicator();
  });
  es.onopen = () => { st.lastEventAt = Date.now(); };
  es.onerror = () => {
    // EventSource сам реконнектится; наш watchdog подстрахует, если браузер
    // надолго останется в состоянии CONNECTING (упавший сервер, молчащий прокси)
    st.connected = false;
    updateLiveIndicator();
  };

  // watchdog: нет событий дольше FALLBACK_AFTER_MS -> закрываем поток и
  // поднимаем polling; параллельно пробуем переподключение с backoff
  if (st.watchdog) clearInterval(st.watchdog);
  st.watchdog = setInterval(() => {
    const s = window.liveState;
    if (!s.es) return;
    if (Date.now() - s.lastEventAt > FALLBACK_AFTER_MS) {
      enterFallback('поток молчит более 95 с');
      scheduleReconnect();
    }
  }, 10000);
};

function scheduleReconnect() {
  const st = window.liveState;
  if (st.reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    try { if (st.es) st.es.close(); } catch (e) {}
    st.lastEventAt = Date.now(); // отложить новый триггер fallback на цикл reconnect
    connectLiveStream();
  }, delay);
}

// --- точки входа -------------------------------------------------------------
// Изменение состава watchlist: пушимв список на сервер + будим цикл (если
// появились новые тикеры — первая цена придёт без ожидания интервала).
window.notifyLiveSymbols = function() {
  const st = window.liveState;
  if (!st.es || st.fallbackActive) return;
  pushLiveSymbols();
};

window.startLive = function() {
  const st = window.liveState;
  if (st.es) return; // уже подключены
  connectLiveStream();
  // Страховка на случай, если 'hello' не придёт (сервер не поддерживает SSE):
  // через 8 с без событий уходим в polling — он штатный и проверенный.
  setTimeout(() => {
    if (!window.liveState.lastEventAt) enterFallback('нет ответа от /api/live/stream');
  }, 8000);
};

// Поток переживает сворачивание вкладки; при долгом сне (телефон в кармане)
// соединение мог оборвать прокси — чиним его при возврате на страницу.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const st = window.liveState;
  if (!st.es) return;
  if (Date.now() - st.lastEventAt > FALLBACK_AFTER_MS) {
    try { st.es.close(); } catch (e) {}
    st.es = null;
    st.lastEventAt = Date.now();
    connectLiveStream();
  }
});

window.stopLive = function() {
  const st = window.liveState;
  if (st.reconnectTimer) { clearTimeout(st.reconnectTimer); st.reconnectTimer = null; }
  if (st.watchdog) { clearInterval(st.watchdog); st.watchdog = null; }
  if (st.es) { try { st.es.close(); } catch (e) {} st.es = null; }
  st.connected = false;
};
