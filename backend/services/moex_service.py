import asyncio
from typing import Optional

import aiohttp

# Задержка данных ISS для неавторизованного пользователя (user status =
# NOT AUTHORIZED): свечи приходят с лагом ~15 минут. Для тестового графика
# этого достаточно, авторизация не требуется.
async def fetch_moex_candles(
    ticker: str,
    interval: int = 24,
    from_date: Optional[str] = None,
    till_date: Optional[str] = None,
) -> dict:
    """Свечи OHLCV с iss.moex.com (акции, режим TQBR).

    interval: 1 (мин), 10, 60 (час), 24 (день), 7 (неделя), 31 (месяц) —
    стандартные интервалы ISS. from/till: даты 'YYYY-MM-DD'.
    Возвращает сырые свечи ISS: open/close/high/low/volume/value + begin/end.
    """
    ticker = ticker.upper().strip()
    url = (
        f"https://iss.moex.com/iss/engines/stock/markets/shares/"
        f"boards/TQBR/securities/{ticker}/candles.json"
        f"?interval={interval}"
    )
    if from_date:
        url += f"&from={from_date}"
    if till_date:
        url += f"&till={till_date}"

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
        try:
            async with session.get(url) as response:
                if response.status != 200:
                    return {"symbol": f"MOEX:{ticker}", "error": f"Not found (Status {response.status})"}
                data = await response.json()
        except asyncio.TimeoutError:
            return {"symbol": f"MOEX:{ticker}", "error": "Timeout"}
        except Exception as e:
            return {"symbol": f"MOEX:{ticker}", "error": str(e)}

    candles = data.get("candles") or {}
    columns = candles.get("columns") or []
    rows = candles.get("data") or []
    if not columns or not rows:
        return {"symbol": f"MOEX:{ticker}", "error": "No candles data", "candles": []}

    def get_col(row, name):
        try:
            return row[columns.index(name)]
        except ValueError:
            return None

    result = []
    for row in rows:
        result.append({
            "open": get_col(row, "open"),
            "close": get_col(row, "close"),
            "high": get_col(row, "high"),
            "low": get_col(row, "low"),
            "volume": get_col(row, "volume"),
            "value": get_col(row, "value"),
            "begin": get_col(row, "begin"),
            "end": get_col(row, "end"),
        })

    return {
        "symbol": f"MOEX:{ticker}",
        "interval": interval,
        "candles": result,
    }


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
