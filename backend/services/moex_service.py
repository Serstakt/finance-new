import asyncio
import time

import aiohttp


# ---------------------------------------------------------------------------
# ИСТОРИЯ СВЕЧЕЙ (для вкладки «Тест график» / KLineChart) — бесплатный MOEX ISS
# ---------------------------------------------------------------------------
_history_cache: dict[str, tuple[float, list[dict]]] = {}  # key -> (ts, candles)
HISTORY_TTL = 300  # 5 минут — история не меняется чаще


async def fetch_moex_history(ticker: str, interval: str = 'D', days: int = 365) -> list[dict]:
    """OHLC-свечи с MOEX ISS. Возвращает список {timestamp, open, high, low, close}
    в формате KLineChart (timestamp в миллисекундах)."""
    ticker = ticker.upper().strip()
    interval = (interval or 'D').upper()
    cache_key = f"{ticker}:{interval}:{days}"
    cached = _history_cache.get(cache_key)
    if cached and (time.time() - cached[0]) < HISTORY_TTL:
        return cached[1]

    from datetime import date, timedelta
    start = (date.today() - timedelta(days=days)).isoformat()
    end = date.today().isoformat()

    if ticker in ['IMOEX', 'RTSI', 'RGBI', 'IRUS']:
        base = "https://iss.moex.com/iss/history/engines/stock/markets/index/securities"
    elif 'RUB' in ticker or ticker in ('USD000UTSTOM', 'EUR_RUB__TOM'):
        base = "https://iss.moex.com/iss/history/engines/currency/markets/currencies/boards/CETS/securities"
    else:
        base = "https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities"

    # Корректный эндпоинт истории ISS: /iss/history/.../{SECID}.json
    url = f"{base}/{ticker}.json?from={start}&till={end}&limit=1500"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
        async with session.get(url) as response:
            if response.status != 200:
                raise RuntimeError(f"MOEX ISS history status {response.status}")
            data = await response.json()

    rows = (data.get('history') or {}).get('data') or []
    columns = (data.get('history') or {}).get('columns') or []

    def col(row, name):
        try:
            return row[columns.index(name)]
        except (ValueError, IndexError):
            return None

    candles = []
    for row in rows:
        # В /iss/history дата в колонке TRADEDATE (интрадневные интервалы MOEX
        # на этом эндпоинте не отдаёт — для H фронтенд использует крипто-фолбэк)
        dt = col(row, 'TRADEDATE') or col(row, 'TRADE_DATE') or col(row, 'BEGIN_AT')
        o, h, l, c = (col(row, 'OPEN'), col(row, 'HIGH'), col(row, 'LOW'), col(row, 'CLOSE'))
        if not dt or None in (o, h, l, c):
            continue
        try:
            if interval == 'D':
                ts = int(time.mktime(time.strptime(dt, '%Y-%m-%d'))) * 1000
            else:
                ts = int(time.mktime(time.strptime(dt[:16], '%Y-%m-%dT%H:%M'))) * 1000
            candles.append({
                "timestamp": ts,
                "open": float(o), "high": float(h), "low": float(l), "close": float(c),
                "volume": float(col(row, 'VOLUME') or 0),
            })
        except (ValueError, TypeError):
            continue
    candles.sort(key=lambda x: x['timestamp'])
    _history_cache[cache_key] = (time.time(), candles)
    return candles


async def fetch_moex_price(ticker: str) -> dict:
    ticker = ticker.upper().strip()

    # 1. Индексы (IMOEX, RTSI, RGBI, IRUS)
    if ticker in ['IMOEX', 'RTSI', 'RGBI', 'IRUS']:
        url = f"https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX.json?spm=a2ty_o01.29997173.0.0.144e55fbQlTBXd&file=RTSI.json{ticker}.json"
    # 2. Валюты (BYNRUB, CNYRUB, USD000UTSTOM и любые с RUB)
    elif 'RUB' in ticker or ticker in ['USD000UTSTOM', 'EUR_RUB__TOM']:
        url = f"https://iss.moex.com/iss/engines/currency/markets/currencies/boards/CETS/securities/{ticker}.json"
    # 3. Акции и облигации (по умолчанию)
    else:
        url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/{ticker}.json"

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        try:
            async with session.get(url) as response:
                if response.status != 200:
                    return {"symbol": f"MOEX:{ticker}", "error": f"Not found (Status {response.status})"}
                data = await response.json()
        except asyncio.TimeoutError:
            return {"symbol": f"MOEX:{ticker}", "error": "Timeout"}
        except Exception as e:
            return {"symbol": f"MOEX:{ticker}", "error": str(e)}

    # MOEX возвращает данные в сложной структуре. Ищем marketdata
    if not data.get('marketdata') or not data['marketdata'].get('data'):
        return {"symbol": f"MOEX:{ticker}", "error": "No data in marketdata"}

    columns = data['marketdata']['columns']
    row = data['marketdata']['data'][0]

    # Безопасная функция для получения значения по имени колонки
    def get_col(name):
        try:
            return row[columns.index(name)]
        except ValueError:
            return None

    # Для индексов иногда используется LASTVALUE, для акций LAST
    price = get_col('LAST') or get_col('LASTVALUE') or get_col('VALTODAY')
    change_percent = get_col('LASTTOPREVPRICE') or get_col('LASTCHANGEPRC')
    change_value = get_col('CHANGE') or get_col('LASTCHANGE')

    return {
        "symbol": f"MOEX:{ticker}",
        "price": float(price) if price else None,
        "changeDay": float(change_percent) if change_percent else None,
        "changeValue": float(change_value) if change_value else None
    }
