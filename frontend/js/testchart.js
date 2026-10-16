// === ТЕСТ ГРАФИК (KLineChart) ===
// Вкладка «Тест график»: свечевой график через KLineChart v9 (локальный UMD-бандл).
// Данные: GET /api/candles/{symbol}?interval=hour|day|week|month (MOEX ISS / CoinGecko),
// максимальная глубина истории (MOEX — с 1995 г., по факту сколько отдаёт биржа).
(function () {
  'use strict';

  let chart = null;            // экземпляр KLineChart
  // Интервал по умолчанию — «День»: MOEX не отдаёт внутридневные свечи,
  // а на часовом интервале вкладка выглядела пустой. Часы доступны для крипты.
  let currentInterval = 'day'; // активный интервал
  let currentSymbol = '';      // последний загруженный символ
  let loadedOnce = false;      // первая загрузка при открытии вкладки
  let loading = false;         // запрос в полёте (защита от двойных кликов)

  const INTERVAL_NAMES = { hour: 'Час', day: 'День', week: 'Неделя', month: 'Месяц' };

  function status(msg, isError) {
    const el = document.getElementById('tc-status');
    if (el) {
      el.textContent = msg || '';
      el.style.color = isError ? '#ef5350' : '#787b86';
    }
  }

  async function loadData(force) {
    const input = document.getElementById('tc-symbol');
    const symbol = (input && input.value.trim()) || 'MOEX:SBER';
    if (loading) return;
    // Принудительное обновление: сбиваем серверный кэш, чтобы MOEX/CoinGecko
    // опросились заново (кнопка «⟳ Обновить»).
    if (force) {
      try {
        await fetch(`${API_BASE}/api/candles/${encodeURIComponent(symbol)}` +
                    `/invalidate?interval=${currentInterval}`, { method: 'POST' });
      } catch (e) { /* если эндпоинт недоступен — просто идём в кэш */ }
    }
    loading = true;
    status(`Загрузка ${symbol} · ${INTERVAL_NAMES[currentInterval]}…`);
    const url = `${API_BASE}/api/candles/${encodeURIComponent(symbol)}?interval=${currentInterval}`;
    try {
      // MOEX-история за 10+ лет грузится долго (десятки страниц по 100 строк) —
      // таймаут запроса увеличен до 3 минут.
      const resp = await fetchWithTimeout(url, {}, 180000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const candles = data.candles || [];
      if (!candles.length) {
        status(`${symbol}: данных нет (проверьте тикер)`, true);
        return;
      }
      // KLineChart ожидает [{timestamp, open, high, low, close, volume}]
      const kdata = candles.map(c => ({
        timestamp: c.time, open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume
      }));
      // Экземпляр графика создаём ТОЛЬКО когда страница видна и контейнер
      // имеет реальные размеры: KLineChart измеряет контейнер при init(),
      // а на скрытой странице (display:none) height=0 → график получался
      // нулевой высоты и вкладка выглядела пустой.
      if (!chart) {
        if (typeof klinecharts === 'undefined') {
          status('KLineChart не загрузился (проверьте js/vendor/klinecharts.min.js)', true);
          return;
        }
        const container = document.getElementById('tc-chart');
        if (!container) { status('Контейнер #tc-chart не найден', true); return; }
        if (container.offsetHeight === 0) {
          status('Подождите: страница ещё не отрисована, повторю попытку…');
          setTimeout(() => loadData(false), 400);
          return;
        }
        chart = klinecharts.init(container);
        // Тёмная тема в стиле терминала + всплывающая информация по свече
        try {
          chart.setStyles({
            grid: { horizontal: { color: '#1e222d' }, vertical: { color: '#1e222d' } },
            candle: {
              type: 'candle_stroke',
              bar: { upColor: '#26a69a', downColor: '#ef5350', noChangeColor: '#959EB6' },
              priceMark: { last: { upColor: '#26a69a', downColor: '#ef5350' } },
              tooltip: { showRule: 'always', showType: 'standard' }
            },
            xAxis: { axisLine: { color: '#363c4e' }, tickText: { color: '#787b86' } },
            yAxis: { axisLine: { color: '#363c4e' }, tickText: { color: '#787b86' } },
            crosshair: {
              horizontal: { line: { color: '#929AA5' }, text: { backgroundColor: '#363c4e' } },
              vertical: { line: { color: '#929AA5' }, text: { backgroundColor: '#363c4e' } }
            }
          });
          // Индикатор объёма во второй панели
          chart.createIndicator('VOL', true, { id: 'candle_pane' });
          // Скользящие средние MA5/MA10/MA20 на основной панели
          chart.createIndicator({ name: 'MA', calcParams: [5, 10, 20] });
        } catch (e) { /* настройки стиля не должны ломать инициализацию */ }
      }
      chart.applyNewData(kdata);
      currentSymbol = symbol;
      const first = new Date(kdata[0].timestamp).getFullYear();
      const last = new Date(kdata[kdata.length - 1].timestamp).toLocaleDateString('ru-RU');
      status(`${data.symbol} · ${INTERVAL_NAMES[currentInterval]} · ${kdata.length} свечей (${first} — ${last})` +
             (data.cached ? ' · из кэша' : ''));
    } catch (e) {
      status(`Ошибка загрузки: ${e.message}`, true);
    } finally {
      loading = false;
    }
  }

  // --- публичные обработчики для onclick в index.html ---
  window.testChartSetInterval = function (interval, btn) {
    currentInterval = interval;
    document.querySelectorAll('.tc-interval-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadData(false);
  };

  window.testChartReload = function (force) {
    loadData(!!force);
  };

  // Enter в поле тикера = загрузить
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('tc-symbol');
    if (input) {
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') loadData(false);
      });
    }
  });

  // Интеграция с navigateTo: при переходе на вкладку — первая загрузка
  // и пересчёт размеров (контейнер был display:none — KLineChart не может
  // измерить его, пока страница скрыта).
  // ВАЖНО: навешиваемся через addEventListener на кнопки, а НЕ перезаписываем
  // window.navigateTo. Перезапись была источником бага: порядок подключения
  // скриптов мог привести к тому, что обёртка сохранялась в переменной до её
  // определения (undefined.apply → TypeError), и переход по вкладкам ломался.
  function onEnterTab() {
    requestAnimationFrame(() => {
      if (chart) { try { chart.resize(); } catch (e) {} }
      if (!loadedOnce) {
        loadedOnce = true;
        loadData(false);
      }
    });
  }

  function bindNavHooks() {
    document.querySelectorAll('.nav-btn[data-page="testchart"]').forEach(btn => {
      btn.addEventListener('click', onEnterTab);
    });
    // Если пользователь уже на вкладке при загрузке страницы (main.js
    // восстанавливает активную страницу из sessionStorage) — грузим сразу.
    const page = document.getElementById('testchart-page');
    if (page && page.classList.contains('active')) onEnterTab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindNavHooks);
  } else {
    bindNavHooks();
  }
})();
