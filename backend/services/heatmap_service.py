"""Сервис тепловой карты «Главная»: % изменения тикеров за период.

Период «день» фронт берёт из /api/prices/batch (changeDay). Здесь —
недельный и месячный: считаются из ДНЕВНЫХ свечей (interval=24), которые
проект уже копит в candle_store (services/candle_store_service.py).
История добирается теми же fetch_moex_candles / fetch_binance_candles,
что и для «Тест график», поэтому карта попутно греет накопленное хранилище
свечей и работает офлайн, если источник временно недоступен.

Семантика как у Finviz map: сравнение последнего close с закрытием свечи,
жившей ~N календарных дней назад (последняя свеча СТРОГО раньше границы
окна). Окна: неделя = 7 дней, месяц = 30 дней. Если накопленной истории не
хватает на всё окно (новая бумага, тикер только начал копиться) — считаем
от самой ранней доступной свечи и помечаем ответ partial=True.

Процессный TTL-кэш сглаживает частые обновления карты: пока запись жива,
источники не дёргаются вовсе; после истечения — инкрементальная докачка
только если последняя сохранённая свеча старше суток.
"""
import asyncio
import time
from datetime import datetime, timedelta, timezone

from backend.services import candle_store_service
from backend.services import crypto_service
from backend.services import moex_service

# Календарные окна периодов (дней); «день» сюда не входит — он из price-batch.
PERIOD_WINDOWS = {"week": 7, "month": 30}

# Жизнь записи кэша % изменения. Неделя/месяц меняются медленно, поэтому
# 5 минут достаточно: повторные обновления карты отдаются из памяти.
CACHE_TTL_SECONDS = 300.0

# Дневная свеча «устарела», если последняя сохранённая старше суток
# (в выходные/праздники новая не появляется — тогда докачка просто не
# приносит ничего нового, но и не чаще раза в TTL).
FRESH_MAX_AGE_SECONDS = 24 * 3600.0

# Сколько тикеров одновременно ходят в ISS/Binance за свечами.
MAX_PARALLEL_FETCHES = 8

# (symbol_full, period) -> (monotonic_ts, ответ)
_period_cache: dict[tuple[str, str], tuple[float, dict]] = {}


def clear_cache() -> None:
    """Сброс кэша (тесты; в проде карта чистится сама по TTL)."""
    _period_cache.clear()


def _parse_begin(begin) -> datetime | None:
    """ISO-строка begin свечи -> naive datetime.

    MOEX отдаёт «YYYY-MM-DDTHH:MM:SS» (московское время), Binance —
    ISO с 'Z' (UTC). Для окон 7/30 дней разница поясов несущественна —
    приводим всё к naive и сравниваем в одном масштабе.
    """
    if not begin:
        return None
    try:
        return datetime.fromisoformat(str(begin).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def compute_period_change(candles: list[dict], window_days: int,
                          now: datetime | None = None) -> dict:
    """% изменения из дневных свечей за календарное окно window_days.

    candles — формат moex_service/crypto_service ({begin, close, ...}),
    произвольный порядок. Возвращает {changePct: float, partial: bool};
    partial=True — истории на всё окно не хватает, считали от самой ранней
    доступной свечи.
    """
    parsed = []
    for c in candles or []:
        begin = _parse_begin(c.get("begin"))
        close = c.get("close")
        if begin is None or close is None:
            continue
        parsed.append((begin, float(close)))
    if not parsed:
        return {"changePct": None, "error": "Нет свечей"}
    parsed.sort(key=lambda p: p[0])

    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    boundary = now - timedelta(days=window_days)

    base = None
    for begin, close in parsed:
        if begin <= boundary:
            base = (begin, close)
        else:
            break

    partial = base is None
    if partial:
        base = parsed[0]

    last_begin, last_close = parsed[-1]
    if base[1] == 0:
        return {"changePct": None, "error": "Нулевая базовая цена"}

    change = (last_close / base[1] - 1.0) * 100.0
    return {
        "changePct": round(change, 2),
        "partial": partial,
        "base_begin": base[0].isoformat(),
        "last_begin": last_begin.isoformat(),
    }


def _is_history_fresh(candles: list[dict], now: datetime) -> bool:
    """Достаточно ли свежи сохранённые свечи (последняя — младше суток)."""
    if not candles:
        return False
    last_begin = _parse_begin(candles[-1].get("begin"))
    if last_begin is None:
        return False
    return (now - last_begin) <= timedelta(seconds=FRESH_MAX_AGE_SECONDS)


def _history_needs_fetch(candles: list[dict], window_days: int, now: datetime) -> bool:
    """Нужна ли докачка: хвост устарел ИЛИ история не покрывает окно периода.

    Второе важно для смешанного сценария: тикер мог копиться сначала в
    «неделю» (хранилище свежее, но глубиной всего ~17 дней) — для «месяца»
    его недостаточно, иначе расчёт стал бы partial без реальной причины.
    """
    if not candles:
        return True
    if not _is_history_fresh(candles, now):
        return True
    # Самая ранняя свеча должна быть старше границы окна (с буфером 5 дней
    # на выходные/праздники), иначе базовой свечи для расчёта может не быть.
    oldest = _parse_begin(candles[0].get("begin"))
    needed = now - timedelta(days=window_days + 5)
    return oldest is None or oldest > needed


async def _ensure_candles(symbol_full: str, ticker: str, is_binance: bool,
                          window_days: int, now: datetime) -> list[dict]:
    """Накопленная история дневных свечей с докачкой недостающего.

    Хранилище пустое — запрашиваем окно периода с буфером 10 дней (чтобы
    гарантированно была базовая свеча до границы окна, даже с учётом
    выходных/праздников). Хранилище не покрывает окно (копился только в
    «неделе», а теперь нужен «месяц») — повторный запрос от начала окна:
    upsert дозаполнит историю, не затирая новее сохранённые свечи. Хвост
    устарел (последняя свеча старше суток) — инкремент от даты последней
    свечи (inclusive — «формирующаяся» свеча дня обновится). Достаточно
    свежее и полное — сеть не трогаем вовсе.
    """
    stored = candle_store_service.load_candles(symbol_full, 24)

    if not _history_needs_fetch(stored, window_days, now):
        return stored

    if stored:
        # Покрывает ли накопленное окно периода? Если нет — качаем от начала
        # окна (upsert дозаполнит), если да — только устаревший хвост.
        oldest = _parse_begin(stored[0].get("begin"))
        needed = now - timedelta(days=window_days + 5)
        if oldest is not None and oldest <= needed:
            last_begin = candle_store_service.get_last_begin(symbol_full, 24) or ""
            from_date = last_begin[:10] or None
        else:
            from_date = (now - timedelta(days=window_days + 10)).strftime("%Y-%m-%d")
    else:
        from_date = (now - timedelta(days=window_days + 10)).strftime("%Y-%m-%d")

    if is_binance:
        result = await crypto_service.fetch_binance_candles(
            ticker, interval=24, from_date=from_date)
    else:
        result = await moex_service.fetch_moex_candles(
            ticker, interval=24, from_date=from_date)

    fresh = result.get("candles") or []
    if fresh and not result.get("error"):
        candle_store_service.save_candles(symbol_full, 24, fresh)
        return candle_store_service.load_candles(symbol_full, 24)

    # Источник недоступен — отдаём что накоплено (иногда этого достаточно).
    return stored


async def _symbol_period_change(symbol_full: str, period: str,
                                window_days: int) -> dict:
    """% изменения одного тикера за период (с докачкой истории при нужде)."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    is_binance = symbol_full.startswith("BINANCE:")
    ticker = symbol_full.replace("BINANCE:", "").replace("MOEX:", "")
    candles = await _ensure_candles(symbol_full, ticker, is_binance,
                                    window_days, now)
    change = compute_period_change(candles, window_days, now)
    if "error" in change:
        return {"error": change["error"]}
    # В ответ карты служебные метки времени не нужны — только значение.
    return {"changePct": change["changePct"], "partial": change["partial"]}


async def get_period_changes(symbols: list[str], period: str) -> dict[str, dict]:
    """Батч % изменения тикеров за период: {symbol: {changePct, partial}|{error}}.

    symbols — полные символы ('MOEX:SBER', 'BINANCE:BTCUSDT', без префикса —
    считаем тикером Мосбиржи, как в /api/prices). Кэш — по (symbol, period);
    промахи считаются параллельно с ограничением одновременности, ошибка
    одного тикера не ломает остальные.
    """
    if period not in PERIOD_WINDOWS:
        raise ValueError(f"period must be one of {sorted(PERIOD_WINDOWS)}")
    window_days = PERIOD_WINDOWS[period]

    requested = list(dict.fromkeys(
        s.strip().upper() for s in symbols if s and s.strip()))
    if not requested:
        return {}

    full_symbols = [s if s.startswith(("MOEX:", "BINANCE:")) else f"MOEX:{s}"
                    for s in requested]

    now_monotonic = time.monotonic()
    out: dict[str, dict] = {}
    misses: list[tuple[str, str]] = []   # (полный символ, исходная запись)
    for full, orig in zip(full_symbols, requested):
        cached = _period_cache.get((full, period))
        if cached and (now_monotonic - cached[0]) < CACHE_TTL_SECONDS:
            out[orig] = cached[1]
        else:
            misses.append((full, orig))

    if misses:
        semaphore = asyncio.Semaphore(MAX_PARALLEL_FETCHES)

        async def fetch_one(full: str, orig: str) -> tuple[str, dict]:
            async with semaphore:
                try:
                    data = await _symbol_period_change(full, period, window_days)
                except Exception as e:  # noqa: BLE001 — ошибка одного тикера не роняет батч
                    data = {"error": str(e)}
                _period_cache[(full, period)] = (time.monotonic(), data)
                return orig, data

        results = await asyncio.gather(
            *(fetch_one(full, orig) for full, orig in misses))
        out.update(dict(results))

    return out
