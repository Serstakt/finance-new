"""
Сервис истории свечей для вкладки «Тест график» (KLineChart).

Источники (без Yahoo Finance):
  * MOEX ISS /history/ — дневные, недельные и месячные свечи по акциям,
    облигациям, индексам, валютам. Глубина истории ограничивается только
    биржей: можно запрашивать данные хоть за 10+ лет назад.
  * CoinGecko market_chart — часовые (interval=1h) свечи по криптопарам.
    Бесплатный API отдаёт историю до начала листинга монеты.

Интервалы: hour | day | week | month.
Формат ответа единый для фронтенда:
  {"symbol": ..., "interval": ..., "source": ...,
   "candles": [{"time": <мс>, "open": .., "high": .., "low": .., "close": .., "volume": ..}]}
Время — Unix milliseconds, начало свечного периода (UTC).
"""

import asyncio
import time as _time_mod
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiohttp

# Извлечение базового тикера и источника — те же правила, что и в остальных
# сервисах терминала (префиксы MOEX:/BINANCE:, автоопределение крипты).
_CRYPTO_BASES = {"BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "LTC", "TRX",
                 "DOT", "AVAX", "MATIC", "LINK", "UNI", "ATOM", "FIL", "APT"}


def split_symbol(symbol: str) -> tuple[str, str]:
    """'MOEX:SBER' -> ('moex','SBER'); 'BINANCE:BTCUSDT' -> ('crypto','BTCUSDT');
    без префикса — автоопределение (криптопара -> crypto, иначе moex)."""
    s = (symbol or "").strip().upper()
    if s.startswith("BINANCE:"):
        return "crypto", s.split(":", 1)[1]
    if s.startswith("MOEX:"):
        return "moex", s.split(":", 1)[1]
    # Автоопределение: пары вида BTCUSDT / ETHBTC или известный базовый актив
    for q in ("USDT", "USDC", "USD", "BTC", "ETH"):
        if s.endswith(q) and len(s) > len(q):
            base = s[: -len(q)]
            if base in _CRYPTO_BASES or base in {"WBTC", "DOGE", "SHIB"}:
                return "crypto", s
    if s in _CRYPTO_BASES:
        return "crypto", s + "USD"
    return "moex", s


def _to_ms(dt_str: str) -> int:
    """'2024-01-15T00:00:00+03:00' или '2024-01-15' -> unix ms (UTC)."""
    try:
        dt = datetime.fromisoformat(dt_str)
    except ValueError:
        d = datetime.strptime(dt_str[:10], "%Y-%m-%d")
        return int(d.replace(tzinfo=timezone.utc).timestamp() * 1000)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _month_start(d: datetime, shift: int = 0) -> datetime:
    y, m = d.year, d.month - shift
    while m <= 0:
        m += 12
        y -= 1
    return datetime(y, m, 1, tzinfo=timezone.utc)


# =============================================================================
# MOEX ISS /history/
# =============================================================================


async def _moex_history_request(session: aiohttp.ClientSession, engine: str,
                                market: str, board: Optional[str], ticker: str,
                                from_d: str, to_d: str) -> Optional[dict]:
    """Запрос истории к MOEX ISS с постраничной загрузкой (start/limit).

    ВАЖНО (история бага): путь .../securities/{ticker}/history.json у карточки
    инструмента всегда отдаёт пустой блок history — настоящая история живёт по
    адресу https://iss.moex.com/iss/history/engines/{engine}/markets/{market}
    [/boards/{board}]/securities/{ticker}.json . Ответ жёстко пагинируется по
    100 строк (параметр limit больше 100 игнорируется, p=N не работает),
    поэтому идём ?start=N шагом 100 пока не соберём history.cursor.TOTAL.
    Так достаётся вся глубина: SBER — 9659 строк с 2011 года (10+ лет)."""
    if board:
        base = (f"https://iss.moex.com/iss/history/engines/{engine}/markets/{market}"
                f"/boards/{board}/securities/{ticker}.json")
    else:
        # Без доски: история по всем историческим доскам инструмента
        base = (f"https://iss.moex.com/iss/history/engines/{engine}/markets/{market}"
                f"/securities/{ticker}.json")
    collected_cols = None
    collected_rows: list = []
    start = 0
    total = None
    while True:
        params = {"from": from_d, "to": to_d, "iss.meta": "off",
                  "iss.only": "history,history.cursor",
                  "limit": 100, "start": start}
        try:
            async with session.get(base, params=params) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
        except Exception:
            return None
        hist = data.get("history") or {}
        rows = hist.get("data") or []
        if not rows:
            break
        if collected_cols is None:
            collected_cols = hist.get("columns")
        collected_rows.extend(rows)
        cursor = (data.get("history.cursor") or {}).get("data") or []
        try:
            total = int(cursor[0][1])  # [INDEX, TOTAL, PAGESIZE]
        except (IndexError, ValueError, TypeError):
            total = None
        if total is None or len(collected_rows) >= total or start > 30000:
            break
        start += len(rows)

    if not collected_rows or collected_cols is None:
        return None
    return {"columns": collected_cols, "data": collected_rows}


def _parse_boards(data: dict) -> list[str]:
    """Список boardid из ответа /securities/{ticker}.json (исторические доски тоже)."""
    boards: list[str] = []
    sec = data.get("securities") or {}
    scols = sec.get("columns") or []
    for row in sec.get("data") or []:
        try:
            b = row[scols.index("BOARDID")] if "BOARDID" in scols else None
        except (IndexError, ValueError):
            b = None
        if b and b not in boards:
            boards.append(str(b))
    md = data.get("marketdata") or {}
    mcols = md.get("columns") or []
    for row in md.get("data") or []:
        try:
            b = row[mcols.index("BOARDID")] if "BOARDID" in mcols else None
        except (IndexError, ValueError):
            b = None
        if b and b not in boards:
            boards.append(str(b))
    return boards


async def _moex_session_history(session: aiohttp.ClientSession, ticker: str,
                                from_d: str, to_d: str) -> Optional[dict]:
    """Ищем историю инструмента на MOEX ISS.

    Основной путь — запрос БЕЗ доски:
      /iss/history/engines/{engine}/markets/{market}/securities/{ticker}.json
    Он отдаёт историю по всем историческим доскам сразу (TQBR, SMAL, индексы
    на SNDX, валюты на CETS), что даёт максимальную глубину (SBER — с 2011 г.,
    ~9659 строк) и убирает лишние сетевые попытки перебора досок.
    Если без доски пусто — резервные варианты: явный обход типовых досок
    (TQBR/SNDX/CETS), затем доски из карточки инструмента."""
    markets = [("stock", "shares"), ("stock", "index"), ("currency", "currencies")]
    for engine, market in markets:
        hist = await _moex_history_request(session, engine, market, None, ticker, from_d, to_d)
        if hist:
            return hist

    attempts = [
        ("stock", "shares", "TQBR"),
        ("stock", "index", "SNDX"),
        ("currency", "currencies", "CETS"),
    ]
    for engine, market, board in attempts:
        hist = await _moex_history_request(session, engine, market, board, ticker, from_d, to_d)
        if hist:
            return hist

    # Резерв: спрашиваем сами доски, на которых торгуется инструмент
    try:
        url = f"https://iss.moex.com/iss/symbols/{ticker}.json?iss.meta=off"
        async with session.get(url) as resp:
            if resp.status == 200:
                info = await resp.json()
            else:
                info = {}
    except Exception:
        info = {}
    seen = {(e, m, b) for e, m, b in attempts}
    for eng_key, market_key in (("stock_engines_markets_shares", "stock"),
                                ("currency_engines_markets_currencies", "currency"),
                                ("stock_engines_markets_index", "stock")):
        block = info.get(eng_key) or {}
        cols = block.get("columns") or []
        rows = block.get("data") or []
        if "boardid" not in cols:
            continue
        bi = cols.index("boardid")
        for row in rows:
            try:
                board = row[bi]
            except IndexError:
                continue
            if not board:
                continue
            key = (market_key, None, str(board))
            if key in seen:
                continue
            seen.add(key)
            hist = await _moex_history_request(session, market_key,
                                               "shares" if market_key == "stock" else "currencies",
                                               str(board), ticker, from_d, to_d)
            if hist:
                return hist
    return None


async def fetch_moex_candles(ticker: str, interval: str) -> list[dict]:
    """Дневные/недельные/месячные свечи MOEX. Максимальная глубина истории:
    запрос идёт с 1995 года — сколько биржа отдаёт, столько и покажем (10+ лет).
    Недельные/месячные агрегируются из дневных."""
    interval = (interval or "day").lower()
    today = datetime.now(timezone.utc).date()
    from_d = "1995-01-01"
    to_d = today.isoformat()

    timeout = aiohttp.ClientTimeout(total=120)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        hist = await _moex_session_history(session, ticker, from_d, to_d)

    if not hist:
        return []

    cols = hist["columns"]
    # ВАЖНО: эндпоинт /history/ без доски возвращает имена колонок в ВЕРХНЕМ
    # регистре (TRADEDATE, OPEN, CLOSE, HIGH, LOW, VOLUME), а карточка
    # инструмента — в нижнем. Приводим индекс к верхнему регистру, иначе
    # все обращения к колонкам проваливаются и список свечей пустой.
    idx = {str(c).upper(): i for i, c in enumerate(cols)}
    board_idx = idx.get("BOARDID")

    def num(row, name):
        try:
            v = row[idx[name]] if name in idx else None
        except IndexError:
            v = None
        try:
            return float(v) if v is not None else None
        except (ValueError, TypeError):
            return None

    daily: list[dict] = []
    by_day: dict = {}
    for row in hist["data"]:
        try:
            ts_raw = row[idx["TRADEDATE"]] if "TRADEDATE" in idx else None
        except IndexError:
            ts_raw = None
        if not ts_raw:
            continue
        day = datetime.strptime(str(ts_raw)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        o = num(row, "OPEN") or num(row, "WAPRICE")
        c = num(row, "CLOSE") or num(row, "WAVAL")
        if o is None or c is None:
            continue
        h = num(row, "HIGH")
        l = num(row, "LOW")
        vol = num(row, "VOLUME") or 0.0
        candle = {"t": day, "time": int(day.timestamp() * 1000),
                  "open": o, "high": h if h is not None else max(o, c),
                  "low": l if l is not None else min(o, c), "close": c,
                  "volume": vol}
        # История без доски содержит несколько досок на одну дату (TQBR + SMAL
        # и т.п.) — берём строку с максимальным объёмом (основная доска).
        if board_idx is not None:
            try:
                board = str(row[board_idx])
            except (IndexError, TypeError):
                board = ""
        else:
            board = ""
        if board.upper() in ("TQBR", "SNDX", "CETS"):
            daily.append(candle)
            continue
        key = candle["time"]
        prev = by_day.get(key)
        if prev is None:
            by_day[key] = candle
        elif candle["volume"] > prev["volume"]:
            by_day[key] = candle

    daily.extend(by_day.values())
    daily.sort(key=lambda d: d["time"])

    if interval == "day":
        return [{"time": d["time"], "open": d["open"], "high": d["high"],
                 "low": d["low"], "close": d["close"], "volume": d["volume"]} for d in daily]

    # Агрегация в недельные/месячные свечи
    buckets: dict = {}
    order: list = []
    for d in daily:
        if interval == "week":
            key = (d["t"].isocalendar()[0], d["t"].isocalendar()[1])
            start = d["t"] - timedelta(days=d["t"].weekday())
        else:  # month
            key = (d["t"].year, d["t"].month)
            start = d["t"].replace(day=1)
        k_ms = int(start.timestamp() * 1000)
        b = buckets.get(key)
        if b is None:
            buckets[key] = {"time": k_ms, "open": d["open"], "high": d["high"],
                            "low": d["low"], "close": d["close"], "volume": d["volume"]}
            order.append(key)
        else:
            b["high"] = max(b["high"], d["high"])
            b["low"] = min(b["low"], d["low"])
            b["close"] = d["close"]
            b["volume"] += d["volume"]
    return [buckets[k] for k in sorted(order, key=lambda k: buckets[k]["time"])]


# =============================================================================
# CoinGecko market_chart (часовые и более крупные интервалы для крипты)
# =============================================================================

async def _cg_resolve_coin_id(session: aiohttp.ClientSession, pair: str) -> Optional[str]:
    """Быстрый резолвинг coin_id по базовому активу пары (BTCUSDT -> bitcoin).
    Используем тот же кэш-слой, что и сервис цен."""
    from . import crypto_service
    return await crypto_service.resolve_coin_id(session, pair)


async def fetch_crypto_candles(pair: str, interval: str) -> list[dict]:
    """Свечи через CoinGecko /coins/{id}/market_chart.
    hour -> prices (1h granularity), day/week/month -> агрегация из 1h-цен закрытия
    (для free API это единственный способ получить OHLC на длинной дистанции;
    high/low внутри периода считаются по часовым точкам)."""
    interval = (interval or "hour").lower()
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        coin_id = await _cg_resolve_coin_id(session, pair)
        if not coin_id:
            return []
        url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
        params = {"vs_currency": "usd", "days": "max", "interval": "hourly"}
        try:
            async with session.get(url, params=params) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
        except Exception:
            return []

    prices = data.get("prices") or []      # [[ms, price], ...]
    vols = data.get("total_volumes") or []
    vol_map = {int(v[0]): v[1] for v in vols if isinstance(v, list) and len(v) >= 2}

    hourly = [{"time": int(p[0]), "close": p[1]} for p in prices if isinstance(p, list) and len(p) >= 2]
    if not hourly:
        return []

    if interval == "hour":
        out = []
        for i, h in enumerate(hourly):
            prev_close = hourly[i - 1]["close"] if i > 0 else h["close"]
            out.append({"time": h["time"], "open": prev_close, "high": max(prev_close, h["close"]),
                        "low": min(prev_close, h["close"]), "close": h["close"],
                        "volume": vol_map.get(h["time"], 0)})
        return out

    # Агрегация часовых точек в дневные/недельные/месячные
    buckets: dict = {}
    for i, h in enumerate(hourly):
        dt = datetime.fromtimestamp(h["time"] / 1000, tz=timezone.utc)
        if interval == "day":
            start = dt.replace(hour=0, minute=0, second=0, microsecond=0)
            key = start.toordinal()
        elif interval == "week":
            start = dt - timedelta(days=dt.weekday())
            start = start.replace(hour=0, minute=0, second=0, microsecond=0)
            key = (start.isocalendar()[0], start.isocalendar()[1])
        else:  # month
            start = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            key = (start.year, start.month)
        k_ms = int(start.timestamp() * 1000)
        prev_close = hourly[i - 1]["close"] if i > 0 else h["close"]
        b = buckets.get(key)
        if b is None:
            buckets[key] = {"time": k_ms, "open": prev_close, "high": max(prev_close, h["close"]),
                            "low": min(prev_close, h["close"]), "close": h["close"],
                            "volume": vol_map.get(h["time"], 0)}
        else:
            b["high"] = max(b["high"], h["close"])
            b["low"] = min(b["low"], h["close"])
            b["close"] = h["close"]
            b["volume"] += vol_map.get(h["time"], 0)
    return [buckets[k] for k in sorted(buckets, key=lambda k: buckets[k]["time"])]


# =============================================================================
# Единая точка входа
# =============================================================================

# Серверный кэш ответов (symbol, interval) -> (получено_в_мс, результат).
# Полная MOEX-история — это ~30-100 страниц по 100 строк (десятки секунд на
# первый запрос), поэтому держим дневные/недельные/месячные данные до суток,
# часовые — 10 минут. Параллельные одинаковые запросы ждут один fetch (locks).
_CACHE_TTL = {"hour": 10 * 60 * 1000, "day": 24 * 3600 * 1000,
              "week": 24 * 3600 * 1000, "month": 24 * 3600 * 1000}
_candle_cache: dict[tuple[str, str], tuple[int, dict]] = {}
_fetch_locks: dict[tuple[str, str], asyncio.Lock] = {}


def _cache_get(key: tuple[str, str]) -> Optional[dict]:
    entry = _candle_cache.get(key)
    if not entry:
        return None
    ts, result = entry
    ttl = _CACHE_TTL.get(key[1], 3600 * 1000)
    if _time_mod.time() * 1000 - ts > ttl:
        del _candle_cache[key]
        return None
    return result


def invalidate_cache(symbol: str, interval: Optional[str] = None) -> int:
    """Сброс серверного кэша для символа (кнопка «Обновить» на вкладке).
    interval=None — сбрасываются все интервалы символа. Возвращает число удалённых записей."""
    source, code = split_symbol(symbol)
    norm = f"{source}:{code}"
    removed = 0
    for key in list(_candle_cache.keys()):
        if key[0] == norm and (interval is None or key[1] == interval):
            del _candle_cache[key]
            removed += 1
    return removed


async def fetch_candles(symbol: str, interval: str) -> dict:
    interval = (interval or "day").lower()
    source, code = split_symbol(symbol)
    key = (f"{source}:{code}", interval)

    cached = _cache_get(key)
    if cached is not None:
        return {**cached, "cached": True}

    lock = _fetch_locks.get(key)
    if lock is None:
        lock = _fetch_locks[key] = asyncio.Lock()
    async with lock:
        # Пока ждали lock, кто-то мог заполнить кэш — проверяем повторно.
        cached = _cache_get(key)
        if cached is not None:
            return {**cached, "cached": True}

        if source == "crypto":
            candles = await fetch_crypto_candles(code, interval)
            result = {"symbol": f"BINANCE:{code}", "interval": interval,
                      "source": "coingecko", "candles": candles}
        else:
            candles = await fetch_moex_candles(code, interval)
            result = {"symbol": f"MOEX:{code}", "interval": interval,
                      "source": "moex_iss", "candles": candles}

        # Пустые ответы не кешируем: пусть следующий запрос повторит
        # попытку (например, MOEX временно недоступен).
        if candles:
            _candle_cache[key] = (int(_time_mod.time() * 1000), result)
        return result
