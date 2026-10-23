"""Живые котировки и статусы алертов через SSE (Server-Sent Events).

Раньше фронтенд раздела WATCHLIST каждые 120 с запускал волну GET /api/prices
по каждому тикеру списка (плюс POST /api/alerts/check после каждой
перерисовки). Итог: N+1 запросов каждые две минуты на вкладку, MOEX/CoinGecko
долбились даже когда данные почти не менялись (ночью, на выходных).

Теперь браузер открывает ОДНО долгое соединение GET /api/live/stream и
получает события:
- \"hello\"     — снимок цен/алертов сразу после подписки;
- \"prices\"    — пачка обновлённых котировок (сервер сам опрашивает
                MOEX/CoinGecko по общему для всех клиентов графику);
- \"alerts\"    — актуальный список алертов из БД (после создания/отмены/
                удаления или срабатывания фонового checker-а).

Экономия нагрузки:
- цены считаются ОДИН раз на весь пул подписанных символов за цикл, а не
  на каждый браузер (клиенты делят один цикл обновления);
- частота адаптивная: в торговые часы MOEX — каждые PRICE_INTERVAL_SECONDS,
  внеTrading — REFRESH_OUT_OF_HOURS_SECONDS (реже), при полностью пустом
  пуле символов — PAUSE_IDLE_SECONDS (источники не дёргаются вовсе);
- крипто-цены берутся из crypto_service._markets_cache (TTL 60 с + общий
  batch /coins/markets) — даже с несколькими клиентами CoinGecko получает
  свой лимитный запрос не чаще одного раза в минуту.

Бэкенд остаётся единственной точкой обращения к MOEX/CoinGecko: браузер
не отправляет никаких периодических REST-запросов, пока соединение живо.
Если SSE недоступен (древний браузер, прокси оборвал поток), фронтенд
автоматически возвращается к прежнему циклу автообновления каждые 120 с.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

# main.py импортирует этот модуль и как пакет (backend.services.live_service),
# и как относительный (.services) — регистрируем модуль под именем пакета,
# чтобы состояние hub было ОДНИМ объектом для приложения целиком.
try:
    import backend.services.live_service  # noqa: F401
except ImportError:
    import sys
    sys.modules.setdefault("backend.services.live_service", sys.modules[__name__])

from backend.services import moex_service, crypto_service
from backend.services import alert_service

logger = logging.getLogger(__name__)

# --- периоды (секунды) -------------------------------------------------------
PRICE_INTERVAL_SECONDS = 30         # в торговые часы буднего дня
REFRESH_OUT_OF_HOURS_SECONDS = 120  # ночь/выходные: тот же темп, что был у polling
PAUSE_IDLE_SECONDS = 300            # нет ни одного символа — источники не трогаем
HEARTBEAT_SECONDS = 25              # комментарий :hb — прокси не закроет «молчащее» соединение
ALERT_POLL_SECONDS = 20             # как часто сверять статусы алертов в БД и
                                    # досылать событие 'alerts' при изменениях
MOEX_TZ = timezone(timedelta(hours=3))  # МСК — расписание торгов Мосбиржи


def moex_market_open(now: datetime | None = None) -> bool:
    """Торговая сессия MOEX: будни 07:00–20:00 МСК (упрощённо, без праздников)."""
    now = now or datetime.now(MOEX_TZ)
    return now.weekday() < 5 and 7 <= now.hour < 20


@dataclass(eq=False)
class Client:
    """Один подписчик SSE-потока.

    eq=False — сравнение по идентичности: dataclass с eq=True не может быть
    ключом dict (unhashable), а clients у hub именно dict[Client, str].
    """
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=64))
    symbols: set[str] = field(default_factory=set)
    client_id: str | None = None


class LiveHub:
    """Пул подписчиков + фоновый цикл обновления цен и рассылки событий.

    Поток запускается лениво: первый клиент поднимает asyncio-цикл,
    последний — останавливает его (источники не опрашиваются в простое).
    """

    # MOEX: last-known цены, отданные клиентами через live-цикл (+ время снимка),
    # чтобы hello после переподключения мгновенно рисовал строки без сети.
    _MOEX_SNAPSHOT_TTL = 120.0

    def __init__(self) -> None:
        self.clients: dict[Client, str] = {}
        self._task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # последний отданный снимок алертов (кортежи id/status/triggered_at) —
        # чтобы не слать клиентам одно и то же состояние дважды
        self._last_alerts_sig: tuple | None = None
        self._alerts_checked_at: float = 0.0   # когда последний раз читали алерты из БД
        self._moex_last: dict[str, dict] = {}
        self._moex_last_ts: float = 0.0
        # «будилка» фонового цикла: set() прерывает ожидание между тиками
        # (например, когда клиент подписал новые символы после простоя)
        self._idle = asyncio.Event()

    # ---------- подписка ----------
    def subscribe(self, client_id: str | None = None) -> Client:
        c = Client(client_id=client_id)
        self.clients[c] = client_id or ""
        return c

    def unsubscribe(self, client: Client) -> None:
        self.clients.pop(client, None)

    def find(self, client_id: str) -> Client | None:
        """Клиент по client_id (фронтенд генерирует id на вкладку и передаёт
        его в query потока и в POST /api/live/symbols)."""
        for c in self.clients:
            if c.client_id == client_id:
                return c
        return None

    @property
    def client_count(self) -> int:
        return len(self.clients)

    def watched_symbols(self) -> list[str]:
        """Объединение символов всех подписчиков (без дублей, сортировка)."""
        merged: set[str] = set()
        for c in self.clients:
            merged |= c.symbols
        return sorted(merged)

    def set_client_symbols(self, client: Client, symbols: list[str]) -> None:
        """Клиент сообщил, какие тикеры открыты у него в watchlist.

        Вызывается при подключении и при каждом изменении состава списков —
        сервер опрашивает внешние API только для реально видимых символов.
        Если появились новые символы (после простоя или добавлен тикер) —
        будим цикл, чтобы первая цена пришла сразу, без ожидания интервала.
        """
        norm = {str(s).strip().upper() for s in symbols if s and not str(s).startswith("SECTION:")}
        had_new = not norm.issubset(client.symbols)
        client.symbols = norm
        if had_new and norm:
            self.wake()

    # ---------- отправка ----------
    def broadcast_raw(self, event: str, data) -> None:
        """Синхронно кладёт событие в очереди всех клиентов (можно из потоков/синк-кода).

        Переполненную очередь клиента (медленный клиент) чистим — лучше
        пропустить несколько событий для одной вкладки, чем блокировать
        остальных и фоновый цикл.
        """
        payload = self._encode(event, data)
        for c in list(self.clients):
            try:
                c.queue.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    while True:
                        c.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    c.queue.put_nowait(payload)
                except asyncio.QueueFull:
                    pass

    def broadcast_threadsafe(self, event: str, data) -> None:
        """Версия для вызова из чужого потока/цикла (alert checker в lifespan)."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self.broadcast_raw, event, data)
        except RuntimeError:
            pass  # цикл уже закрыт при остановке сервера

    @staticmethod
    def _encode(event: str, data) -> str:
        body = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, default=str)
        return f"event: {event}\ndata: {body}\n\n"

    # ---------- жизненный цикл потока ----------
    async def ensure_started(self) -> None:
        """Поднимает фоновый цикл на текущем event loop (если ещё не запущен)."""
        self._loop = asyncio.get_running_loop()
        task = self._task
        if task is not None and not task.done():
            return
        self._task = asyncio.create_task(self._run(), name="live-price-broadcaster")

    async def shutdown(self) -> None:
        task = self._task
        self._task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except BaseException:  # noqa: BLE001 — graceful shutdown
                pass

    # ---------- основной цикл ----------
    def _next_interval(self) -> float:
        if not self.clients:
            return PAUSE_IDLE_SECONDS
        if not self.watched_symbols():
            # клиенты есть, но списки пусты — внешние API не нужны
            return PAUSE_IDLE_SECONDS
        return PRICE_INTERVAL_SECONDS if moex_market_open() else REFRESH_OUT_OF_HOURS_SECONDS

    async def _run(self) -> None:
        logger.info("SSE live-поток запущен (interval %d/%d c)",
                    PRICE_INTERVAL_SECONDS, REFRESH_OUT_OF_HOURS_SECONDS)
        last_prices_ts = 0.0
        try:
            while self.clients:
                interval = self._next_interval()
                symbols = self.watched_symbols()
                now = time.time()
                did_work = False
                # цены — не чаще interval; статусы алертов — не чаще
                # ALERT_POLL_SECONDS (см. publish_alerts_if_changed)
                if symbols and (now - last_prices_ts) >= interval:
                    last_prices_ts = now
                    did_work = True
                    try:
                        prices = await self._fetch_prices(symbols)
                        if prices:
                            self.remember_moex(prices)
                            self.broadcast_raw("prices", {"ts": now, "quotes": prices})
                        # проверка алертов по уже полученным ценам — без
                        # повторных запросов к MOEX/CoinGecko (см. check_all_active)
                        await self.check_alerts_with(prices)
                    except Exception:  # noqa: BLE001 — цикл не должен умирать от сбоя
                        logger.exception("Live-поток: ошибка обновления цен")
                if now - self._alerts_checked_at >= ALERT_POLL_SECONDS:
                    did_work = True
                    try:
                        # нет свежих цен этого цикла — сверяем только статусы из БД;
                        # саму проверку условий делает фоновый checker lifespan-а
                        self.publish_alerts_if_changed()
                    except Exception:  # noqa: BLE001
                        logger.exception("Live-поток: ошибка рассылки алертов")
                try:
                    # ждём до ближайшего дедлайна; set_client_symbols будит
                    # поток раньше (wake), чтобы новые тикеры получили цену сразу
                    timeout = interval if did_work else min(interval, ALERT_POLL_SECONDS)
                    await asyncio.wait_for(self._idle.wait(), timeout=max(1.0, timeout))
                    self._idle.clear()
                except asyncio.TimeoutError:
                    pass
        finally:
            logger.info("SSE live-поток остановлен (нет клиентов)")

    def wake(self) -> None:
        """Будит фоновый цикл (новые символы клиента / конец простоя)."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._idle.set)
        except RuntimeError:
            pass

    async def _fetch_prices(self, symbols: list[str]) -> dict[str, dict]:
        """Котировки для набора символов: MOEX параллельно, крипто одним batch."""
        moex_syms, crypto_syms = [], []
        for s in symbols:
            if s.startswith("BINANCE:"):
                crypto_syms.append(s.split(":", 1)[1])
            elif s.startswith("MOEX:"):
                moex_syms.append(s.split(":", 1)[1])
            else:
                moex_syms.append(s)

        quotes: dict[str, dict] = {}
        tasks = []
        if moex_syms:
            tasks.append(asyncio.gather(*[moex_service.fetch_moex_price(t) for t in moex_syms],
                                        return_exceptions=True))
        if crypto_syms:
            tasks.append(crypto_service.fetch_crypto_prices_batch(crypto_syms))
        results = await asyncio.gather(*tasks) if tasks else []

        idx = 0
        if moex_syms:
            # fetch_moex_price возвращает {'symbol': 'MOEX:TICKER', ...} —
            # ключом снимка делаем полный символ, как это делает и REST
            # /api/prices/{ticker}, чтобы фронтенд мог положить цену в кэш
            # под тем же символом, что стоит в строке watchlist.
            for ticker, res in zip(moex_syms, results[idx]):
                idx += 1
                if isinstance(res, Exception) or not isinstance(res, dict):
                    continue
                full = str(res.get("symbol") or f"MOEX:{ticker.upper()}").upper()
                if res.get("price") is not None:
                    quotes[full] = {**res, "symbol": full}
        if crypto_syms:
            batch = results[idx] if idx < len(results) else {}
            for sym_full, res in (batch or {}).items():
                if isinstance(res, dict) and res.get("price") is not None:
                    quotes[res.get("symbol", f"BINANCE:{sym_full}")] = res
        return quotes

    # ---------- снимки для hello ----------
    @staticmethod
    def _moex_lookup_keys(su: str) -> tuple[str, str]:
        """Пары ключей MOEX-снимка: (как храним в _moex_last, как рисует фронт).

        Watchlist хранит тикеры с префиксом ('MOEX:SBER'), но пользователь мог
        добавить и голый тикер ('SBER'). Храним под полным видом, отдаём под
        тем ключом, который клиент прислал — строка списка обновится в любом
        случае.
        """
        if su.startswith("MOEX:"):
            return su, su
        return f"MOEX:{su}", su

    def snapshot_prices_sync(self, symbols: list[str]) -> dict[str, dict]:
        """Цены из внутренних кэшей сервисов БЕЗ сетевых запросов.

        Нужны, чтобы мгновенно отрисовать строки сразу после подключения:
        - крипто: crypto_service._markets_cache (обновляется live-циклом и
          обычными REST-запросами, TTL 60 с);
        - MOEX: last-known цены из последнего broadcased-снапшота (см. _moex_last).
        """
        out: dict[str, dict] = {}
        fresh_moex = (time.time() - self._moex_last_ts) < self._MOEX_SNAPSHOT_TTL
        mc = crypto_service._markets_cache
        for s in symbols:
            su = str(s).strip().upper()
            if su.startswith("SECTION:"):
                continue
            if su.startswith("BINANCE:"):
                base = su.split(":", 1)[1]
                cid = crypto_service.STATIC_MAP.get(base)
                entry = mc.get(cid) if cid else None
                if entry and entry.get("data"):
                    out[su] = crypto_service._build_response(base, entry["data"])
            elif fresh_moex:
                stored, resp_key = self._moex_lookup_keys(su)
                cached = self._moex_last.get(stored)
                if cached and cached.get("price") is not None:
                    out[resp_key] = {**cached, "symbol": resp_key}
        return out

    def _normalize_key(self, sym: str) -> str | None:
        """Ключ котировки для хранения в _moex_last.

        MOEX-ответы приходят с полным символом 'MOEX:TICKER' — нормализуем к
        нему же; голый тикер ('SBER') тоже приводим к 'MOEX:SBER', чтобы hello-
        снимок находил цену независимо от того, в каком виде клиент прислал
        символ. Крипто-ключи не храним (для них есть crypto_service._markets_cache).
        """
        su = str(sym).strip().upper()
        if not su or su.startswith("BINANCE:") or su.startswith("SECTION:"):
            return None
        if su.startswith("MOEX:"):
            return su
        bare = su.split(":", 1)[0]  # на случай экзотического префикса 'XX:SBER'
        return f"MOEX:{bare}"

    def remember_moex(self, quotes: dict[str, dict]) -> None:
        """Сохраняем MOEX-цены последнего успешного цикла для hello-снимка."""
        keep: dict[str, dict] = {}
        for k, v in quotes.items():
            key = self._normalize_key(k)
            if key is None and isinstance(v, dict):
                # ключ ответа мог прийти без префикса — пробуем по полю symbol
                key = self._normalize_key(v.get("symbol", ""))
            if key is not None:
                keep[key] = v
        if keep:
            self._moex_last.update(keep)
            self._moex_last_ts = time.time()

    async def check_alerts_with(self, quotes: dict[str, dict]) -> None:
        """Проверка активных алертов по ценам только что полученного снимка.

        price_map для alert_service строится из quotes (symbol -> price);
        если после проверки хоть один алерт перешёл в 'triggered', статусы
        рассылаются клиентам событием 'alerts' — без повторных запросов к
        MOEX/CoinGecko.
        """
        price_map = {sym: q.get("price") for sym, q in quotes.items()
                     if isinstance(q, dict) and q.get("price") is not None}
        if not price_map:
            return
        triggered = await alert_service.check_all_active(price_map)
        if triggered:
            logger.info("Live-поток: сработало алертов: %d", len(triggered))
            self.publish_alerts_if_changed()

    def alerts_snapshot(self) -> list[dict]:
        try:
            return alert_service.list_alerts()
        except Exception:  # noqa: BLE001 — БД могла быть занята, отдадим пустой снимок
            logger.exception("Live-поток: не удалось прочитать алерты")
            return []

    def alerts_changed(self, alerts: list[dict]) -> bool:
        """True, если набор (id, status, triggered_at) отличается от прошлого снимка."""
        sig = tuple((a.get("id"), a.get("status"), a.get("triggered_at")) for a in alerts)
        changed = sig != self._last_alerts_sig
        if changed:
            self._last_alerts_sig = sig
        return changed

    def publish_alerts_if_changed(self) -> bool:
        """Читает алерты из БД и рассылает событие 'alerts', если статусы изменились.

        Вызывается из live-цикла и после операций CRUD над алертами (см. main.py),
        поэтому браузеру не нужен ни POST /api/alerts/check, ни GET /api/alerts
        по таймеру — колокольчики обновляются push-ем.
        """
        alerts = self.alerts_snapshot()
        self._alerts_checked_at = time.time()
        if not self.alerts_changed(alerts):
            return False
        self.broadcast_raw("alerts", {"alerts": alerts})
        return True

    def build_hello(self, client: Client) -> list[str]:
        """Первые события нового подписчика: hello-статус + снимок цен (из кэшей) + все алерты."""
        events = [self._encode("hello", {
            "ts": time.time(),
            "clients": self.client_count,
            "interval": self._next_interval(),
            "marketOpen": moex_market_open(),
        })]
        snap = self.snapshot_prices_sync(list(client.symbols)) if client.symbols else {}
        events.append(self._encode("prices", {"ts": time.time(), "quotes": snap}))
        alerts = self.alerts_snapshot()
        self._last_alerts_sig = None  # hello всегда несёт полный снимок
        self.alerts_changed(alerts)
        events.append(self._encode("alerts", {"alerts": alerts}))
        return events


hub = LiveHub()
