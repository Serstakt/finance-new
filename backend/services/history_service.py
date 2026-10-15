# === ИСТОРИЧЕСКИЕ СВЕЧИ (для тестовых графиков: Lightweight Charts / ECharts / Chart.js / D3) ===
"""Возвращает дневные OHLC-свечи по символу терминала.

Формат ответа: {"symbol": ..., "source": "moex"|"coingecko",
               "candles": [{"time":"YYYY-MM-DD","open":..,"high":..,"low":..,"close":..}, ...]}

Источник данных выбирается по префиксу символа (как в /api/prices):
  * BINANCE:XXX -> CoinGecko market_chart (daily цены; high/low приближены к close,
    т.к. публичный free-эндпоинт отдаёт только цену — для тестовой отрисовки достаточно);
  * MOEX:XXX и прочие -> ISS history candles Мосбиржи (реальные OHLC).
"""
import datetime as _dt

import aiohttp

from . import crypto_service

MOEX_HISTORY_URL = ("https://iss.moex.com/iss/history/engines/stock/markets/shares/"
                    "boards/TQBR/securities/{ticker}/candles.json")
GECKO_HISTORY_URL = "https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"


async def _fetch_moex_candles(session: aiohttp.ClientSession, ticker: str, days: int) -> list[dict]:
    till = _dt.date.today()
    frm = till - _dt.timedelta(days=days)
    url = MOEX_HISTORY_URL.format(ticker=ticker)
    params = {"from": frm.isoformat(), "till": till.isoformat()}
    async with session.get(url, params=params) as resp:
        if resp.status != 200:
            return []
        data = await resp.json()
    history_block = data.get("history") or {}
    rows = history_block.get("data") or []
    cols = history_block.get("columns") or []
    # точные индексы колонок берём из columns (TRADEDATE/OPEN/HIGH/LOW/CLOSE)
    def idx(name, default):
        try:
            return cols.index(name)
        except ValueError:
            return default
    i_d, i_o, i_h, i_l, i_c = idx("TRADEDATE", 1), idx("OPEN", 6), idx("HIGH", 8), idx("LOW", 7), idx("CLOSE", 11)
    out = []
    for r in rows:
        try:
            out.append({
                "time": r[i_d],
                "open": float(r[i_o]), "high": float(r[i_h]),
                "low": float(r[i_l]), "close": float(r[i_c]),
            })
        except (TypeError, ValueError, IndexError):
            continue
    return out


async def _fetch_gecko_candles(session: aiohttp.ClientSession, symbol: str, days: int) -> list[dict]:
    coin_id = await crypto_service.resolve_coin_id(session, symbol)
    if not coin_id:
        return []
    params = {"vs_currency": "usd", "days": str(min(days, 365)), "interval": "daily"}
    async with session.get(GECKO_HISTORY_URL.format(coin_id=coin_id), params=params) as resp:
        if resp.status != 200:
            return []
        data = await resp.json()
    prices = data.get("prices") or []
    out = []
    prev_close = None
    for ts_ms, price in prices:
        day = _dt.datetime.fromtimestamp(ts_ms / 1000, tz=_dt.timezone.utc).date().isoformat()
        c = float(price)
        o = float(prev_close) if prev_close is not None else c
        # high/low приближаем ±0.5% от диапазона open->close (free API не даёт экстремумы)
        spread = max(abs(c - o), abs(c) * 0.005)
        out.append({"time": day, "open": o, "high": max(o, c) + spread * 0.5,
                    "low": min(o, c) - spread * 0.5, "close": c})
        prev_close = c
    return out


async def fetch_history(symbol: str, days: int = 180) -> dict:
    upper = (symbol or "").upper()
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        if upper.startswith("BINANCE:"):
            pair = upper.replace("BINANCE:", "")
            candles = await _fetch_gecko_candles(session, pair, days)
            return {"symbol": f"BINANCE:{pair}", "source": "coingecko", "candles": candles}
        ticker = upper.replace("MOEX:", "")
        candles = await _fetch_moex_candles(session, ticker, days)
        return {"symbol": f"MOEX:{ticker}", "source": "moex", "candles": candles}
