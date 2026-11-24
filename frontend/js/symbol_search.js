// === ПОИСК СИМВОЛОВ С АВТОДОПОЛНЕНИЕМ (аналог поиска TradingView) ===
// Голый input с валидацией «фактическим запросом цены» заменён выпадающим
// поиском: совпадения по тикеру и названию, тип актива (Акция/Крипто/Валюта/
// Индекс), логотипы. Данные — ручка бэкенда /api/search/symbols (MOEX ISS +
// справочник пар Binance + имена/логотипы CoinGecko из кэшей).
//
// Подключено к двум полям:
//   • #add-input (добавление тикера в watchlist): выбор подсказки подставляет
//     символ и вызывает addTicker() — валидация ценой остаётся финальной
//     страховкой, но опечатка теперь ловится ещё на вводе;
//   • #tc-sym-input (тикер в шапке графика): выбор подставляет код и грузит
//     график тем же путём, что Enter (createChart).
//
// Навигация как в TradingView: ↑/↓ — по подсказкам, Enter — выбрать
// подсвеченную, Escape — закрыть подсказки (повторный Escape в поле графика
// откатывает ввод — его родной обработчик в watchlist_chart.js), клик —
// выбрать. Файл подключён ДО main.js/watchlist_chart.js: наши keydown-
// обработчики регистрируются раньше их, и stopImmediatePropagation при
// открытом меню не пускает «сырой» Enter до валидации/графика.
(function () {
  'use strict';

  const MIN_QUERY_LEN = 2;   // 1 символ по MOEX даёт сотни подсказок — не шумим
  // Задержка перед отправкой запроса: набор «NVKE» по буквам не должен
  // порождать по одному запросу на каждый символ. Закэшированные ответы
  // показываются сразу, без ожидания — они сети не дёргают.
  const DEBOUNCE_MS = 1000;
  const FETCH_TIMEOUT_MS = 10000;

  // Бейдж типа актива (цвета — палитра терминала: синий цена/объём,
  // оранжевый Bitcoin, зелёный рост, фиолетовый акцент индикаторов)
  const TYPE_META = {
    stock:    { label: 'Акция',  color: '#4d8dff' },
    crypto:   { label: 'Крипто', color: '#f7931a' },
    currency: { label: 'Валюта', color: '#26a69a' },
    index:    { label: 'Индекс', color: '#ab47bc' },
  };

  // Кэш ответов на время жизни страницы: стирание/правка ввода не дёргает
  // бэкенд повторно (запись — массив из ~8 подсказок, ограничение не нужно)
  const cache = new Map();

  // Состояние ЕДИНОГО активного дропдауна (полей два, открыто максимум одно)
  let menuEl = null;
  let activeInput = null;
  let onPickCb = null;
  let items = [];
  let activeIndex = -1;
  let hasResults = false;      // меню показывает подсказки (а не «Поиск…/Ничего»)
  let debounceTimer = null;
  let searchSeq = 0;           // защита от «отставшего» ответа после правки ввода
  let searchAbort = null;      // AbortController летящего запроса: новый ввод
                               // отменяет предыдущий — запросы не копятся в сети

  const esc = (s) => String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  // Подсветка совпадения (как в TradingView): первое вхождение запроса
  // в тикере/названии — синим жирным
  const highlight = (text, q) => {
    const s = String(text == null ? '' : text);
    if (!q) return esc(s);
    const i = s.toUpperCase().indexOf(q);
    if (i === -1) return esc(s);
    return esc(s.slice(0, i)) + '<b class="ss-hl">' + esc(s.slice(i, i + q.length)) + '</b>' + esc(s.slice(i + q.length));
  };

  const isMenuOpen = () => !!(menuEl && menuEl.classList.contains('open'));

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'symbol-search-menu';
    menuEl.setAttribute('role', 'listbox');
    // mousedown (не click): preventDefault не даёт input потерять фокус,
    // поэтому blur-логика закрытия не срабатывает между mousedown и click
    menuEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const item = e.target.closest('.symbol-search-item');
      if (item && item.dataset.index != null) pickItem(Number(item.dataset.index));
    });
    menuEl.addEventListener('mousemove', (e) => {
      const item = e.target.closest('.symbol-search-item');
      if (!item || item.dataset.index == null) return;
      const i = Number(item.dataset.index);
      if (i !== activeIndex) setActive(i, false);
    });
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function setActive(i, scrollIntoView = true) {
    if (!menuEl) return;
    const nodes = menuEl.querySelectorAll('.symbol-search-item');
    if (!nodes.length) return;
    activeIndex = Math.max(0, Math.min(i, nodes.length - 1));
    nodes.forEach((n, idx) => n.classList.toggle('active', idx === activeIndex));
    if (scrollIntoView && nodes[activeIndex]) {
      const n = nodes[activeIndex];
      const m = menuEl;
      // scrollIntoView nearest двигал бы и страницу — прокручиваем только меню
      if (n.offsetTop < m.scrollTop) m.scrollTop = n.offsetTop;
      else if (n.offsetTop + n.offsetHeight > m.scrollTop + m.clientHeight) {
        m.scrollTop = n.offsetTop + n.offsetHeight - m.clientHeight;
      }
    }
  }

  // Строки-подсказки: логотип (buildLogoHtml из api.js — официальный логотип
  // крипты / favicon эмитента / двухбуквенная заглушка), тикер с подсветкой,
  // название, бейдж типа актива
  function renderMenu(q) {
    const menu = ensureMenu();
    if (!items.length) {
      hasResults = false;
      activeIndex = -1;
      menu.innerHTML = '<div class="symbol-search-note">Ничего не найдено</div>';
      return;
    }
    hasResults = true;
    activeIndex = 0;
    menu.innerHTML = items.map((it, i) => {
      const meta = TYPE_META[it.type] || { label: it.exchange || '', color: '#787b86' };
      const logo = (typeof window.buildLogoHtml === 'function')
        ? window.buildLogoHtml(it.symbol, it.ticker, it.logo ? { logo: it.logo } : null)
        : '';
      const ariaId = `ss-option-${i}`;
      return `<div class="symbol-search-item${i === 0 ? ' active' : ''}" role="option" id="${ariaId}" data-index="${i}" aria-selected="${i === 0}">`
        + `<span class="ss-logo">${logo}</span>`
        + `<span class="ss-ticker">${highlight(it.ticker, q)}</span>`
        + `<span class="ss-name">${it.name ? highlight(it.name, q) : '&nbsp;'}</span>`
        + `<span class="ss-type" style="color: ${meta.color}">${esc(meta.label)}</span>`
        + `</div>`;
    }).join('');
    if (activeInput) activeInput.setAttribute('aria-activedescendant', 'ss-option-0');
  }

  function showNote(text) {
    const menu = ensureMenu();
    hasResults = false;
    activeIndex = -1;
    menu.innerHTML = `<div class="symbol-search-note">${esc(text)}</div>`;
  }

  function openMenu() {
    if (!menuEl || !activeInput) return;
    menuEl.classList.add('open');
    activeInput.setAttribute('aria-expanded', 'true');
  }

  // Позиция — под полем (position: fixed поверх всего, панель watchlist
  // иначе обрезала бы меню своим overflow). Если снизу мало места, а сверху
  // достаточно — раскрываем вверх. Ширина — не уже поля и не уже 300px
  // (у поля графика ширина всего 130px: тикер + название + бейдж не влезут)
  function positionMenu() {
    if (!menuEl || !activeInput || !isMenuOpen()) return;
    const rect = activeInput.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    const menuH = Math.min(menuEl.scrollHeight || 200, 320);
    let top = rect.bottom + 4;
    const below = window.innerHeight - rect.bottom;
    if (below < Math.min(menuH + 8, 180) && rect.top > menuH + 8) top = rect.top - menuH - 4;
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    menuEl.style.left = `${Math.max(4, Math.round(left))}px`;
    menuEl.style.top = `${Math.max(4, Math.round(top))}px`;
    menuEl.style.minWidth = `${Math.round(width)}px`;
  }

  function applyResults(query, results) {
    items = results;
    renderMenu(query);
    if (!isMenuOpen()) openMenu();
    positionMenu();
  }

  async function doSearch(query) {
    const seq = ++searchSeq;
    // Предыдущий запрос (ещё летит из-за набора по буквам) больше не нужен —
    // отменяем его на уровне сети, а не просто игнорируем ответ
    if (searchAbort) { try { searchAbort.abort(); } catch (e) {} }
    searchAbort = new AbortController();
    const cached = cache.get(query);
    if (cached) {
      if (activeInput) applyResults(query, cached);
      return;
    }
    // «Поиск…» показываем только когда подсказок ещё нет: при правке ввода
    // старые подсказки остаются на экране до прихода свежих — без мигания
    if (!items.length) {
      showNote('Поиск…');
      if (activeInput) { openMenu(); positionMenu(); }
    }
    try {
      const res = await window.fetchWithTimeout(
        `${window.API_BASE || ''}/api/search/symbols?q=${encodeURIComponent(query)}`,
        { signal: searchAbort.signal }, FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];
      cache.set(query, results);
      // Пока ждали ответ, ввод изменился или меню закрыли — ответ устарел
      if (seq !== searchSeq || !activeInput || !isMenuOpen()) return;
      applyResults(query, results);
    } catch (err) {
      // Отменённый (заменённый новым вводом) запрос — штатная ситуация
      if (err && err.name === 'AbortError') return;
      if (seq !== searchSeq || !activeInput || !isMenuOpen()) return;
      console.warn('Поиск символов не удался:', err);
      showNote('Поиск недоступен — проверьте, что сервер запущен');
      positionMenu();
    }
  }

  function pickItem(i) {
    const item = items[i];
    const cb = onPickCb;
    close();
    if (!item || typeof cb !== 'function') return;
    try { cb(item); } catch (err) { console.error('Ошибка выбора подсказки:', err); }
  }

  function close() {
    clearTimeout(debounceTimer);
    // Летящий запрос при закрытом меню уже не нужен — отменяем на уровне
    // сети (тот же принцип «без накопления», что и при продолжении ввода)
    if (searchAbort) { try { searchAbort.abort(); } catch (e) {} searchAbort = null; }
    if (menuEl) menuEl.classList.remove('open');
    items = [];
    activeIndex = -1;
    hasResults = false;
    if (activeInput) {
      activeInput.setAttribute('aria-expanded', 'false');
      activeInput.removeAttribute('aria-activedescendant');
    }
    // activeInput/onPickCb НЕ сбрасываем: focus-обработчики полей их восстанавливают
  }

  // Keydown-обработчик поля: навигация ↑/↓, Enter — выбор, Escape/Tab — закрыть.
  // Регистрируется РАНЬШЕ родных Enter/Escape-обработчиков полей (порядок
  // подключения скриптов), stopImmediatePropagation держит их до своего раза.
  function onKeydown(e) {
    if (activeInput !== e.target) return;
    const open = isMenuOpen();

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open || !hasResults || !items.length) return;
      e.preventDefault(); // не двигаем курсор в поле — он «на» подсказках
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + dir + items.length) % items.length);
      const id = `ss-option-${activeIndex}`;
      if (activeInput) activeInput.setAttribute('aria-activedescendant', id);
      return;
    }

    if (e.key === 'Enter') {
      if (open && hasResults && activeIndex >= 0 && activeIndex < items.length) {
        e.preventDefault();
        e.stopImmediatePropagation(); // сырой Enter (addTicker/график) не нужен — символ уже выбран
        pickItem(activeIndex);
      } else if (open) {
        // «Ничего не найдено»/поиск ещё идёт: ввод обрабатывается как обычно
        // (валидация ценой — прежний путь для экзотических кодов)
        close();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopImmediatePropagation(); // первое Esc — закрыть подсказки; второе — родное действие поля
        close();
      }
      return;
    }

    if (e.key === 'Tab' && open) close();
  }

  function attach(input, onPick) {
    if (!input || input.dataset.symbolSearch === '1') return;
    input.dataset.symbolSearch = '1';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('keydown', onKeydown);

    input.addEventListener('input', () => {
      activeInput = input;
      onPickCb = onPick;
      const q = input.value.trim().toUpperCase();
      clearTimeout(debounceTimer);
      if (q.length < MIN_QUERY_LEN) { close(); return; }
      // Закэшированный ответ — сразу, без ожидания debounce и без запроса.
      // Летящий запрос по прежнему тексту гасим: его ответ устаревает
      // (searchSeq), и он не копится в сети
      const cached = cache.get(q);
      if (cached) {
        if (activeInput === input) {
          searchSeq++;
          if (searchAbort) { try { searchAbort.abort(); } catch (e) {} }
          applyResults(q, cached);
        }
        return;
      }
      debounceTimer = setTimeout(() => {
        if (activeInput === input) doSearch(q);
      }, DEBOUNCE_MS);
    });

    input.addEventListener('focus', () => {
      activeInput = input;
      onPickCb = onPick;
      const q = input.value.trim().toUpperCase();
      if (q.length < MIN_QUERY_LEN) return;
      const cached = cache.get(q);
      if (cached) { applyResults(q, cached); }
      else doSearch(q);
    });

    // Закрытие, когда фокус ушёл из поля в сторону (клик по пункту фокус не
    // уводит — mousedown в меню preventDefault'ится)
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (activeInput === input && document.activeElement !== input) close();
      }, 150);
    });
  }

  // Клик вне меню и поля закрывает подсказки
  document.addEventListener('mousedown', (e) => {
    if (!isMenuOpen()) return;
    const t = e.target;
    if (t === menuEl || (menuEl && menuEl.contains(t))) return;
    if (t === activeInput || (activeInput && activeInput.contains(t))) return;
    close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Скролл/ресайз: меню fixed — держим его у поля, а если поле исчезло
  // (свернули панель) — закрываем. capture: скроллы внутренних контейнеров тоже ловим
  window.addEventListener('scroll', () => {
    if (!isMenuOpen()) return;
    if (activeInput && activeInput.getBoundingClientRect().height > 0) positionMenu();
    else close();
  }, true);
  window.addEventListener('resize', () => { if (isMenuOpen()) positionMenu(); });

  // === ПОДКЛЮЧЕНИЕ К ПОЛЯМ ===
  // defer-скрипты выполняются после разбора DOM, но ДО defer-скриптов ниже
  // по списку (main.js/watchlist_chart.js ещё не навесили свои keydown) —
  // порядок регистрации наших обработчиков гарантирует приоритет Enter/Escape
  const addInput = document.getElementById('add-input');
  if (addInput) {
    attach(addInput, (item) => {
      addInput.value = item.symbol;
      if (typeof window.addTicker === 'function') window.addTicker();
    });
  }

  const tcInput = document.getElementById('tc-sym-input');
  if (tcInput) {
    attach(tcInput, (item) => {
      tcInput.value = item.symbol;
      if (typeof window.createChart === 'function') window.createChart(item.symbol);
    });
  }

  window.symbolSearch = { attach, close };
})();
