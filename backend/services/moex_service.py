import asyncio
import os
from pathlib import Path
from typing import Optional

import aiohttp
from dotenv import load_dotenv

# .env ищем рядом с модулем (backend/.env) и в корне проекта — как в
# notification_service. Токен Algopack нужен для авторизованного ISS
# (котировки без задержки ~15 мин анонимного доступа).
for _candidate in (Path(__file__).resolve().parent.parent / ".env",
                   Path(__file__).resolve().parent.parent.parent / ".env"):
    if _candidate.exists():
        load_dotenv(_candidate)


def get_moex_token() -> str:
    """Bearer-токен ISS из .env/окружения; пустая строка, если не задан."""
    return (os.getenv("MOEX_API_TOKEN") or "").strip()


async def _get_json(url: str, headers: Optional[dict] = None) -> dict:
    """GET url -> dict ISS; при сетевой ошибке/не-200 возвращает {'error': …}."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        try:
            async with session.get(url, headers=headers or {}) as response:
                if response.status != 200:
                    return {"error": f"Not found (Status {response.status})"}
                return await response.json()
        except asyncio.TimeoutError:
            return {"error": "Timeout"}
        except Exception as e:
            return {"error": str(e)}

# Свечи ISS: с токеном Algopack — apim.moex.com (данные без задержки),
# без токена — анонимный iss.moex.com (лаг ~15 минут, для тестового графика
# этого достаточно).
async def fetch_moex_candles(
    ticker: str,
    interval: int = 24,
    from_date: Optional[str] = None,
    till_date: Optional[str] = None,
) -> dict:
    """Свечи OHLCV (акции, режим TQBR) — МАКСИМАЛЬНАЯ история.

    interval: 1 (мин), 10, 60 (час), 24 (день), 7 (неделя), 31 (месяц) —
    стандартные интервалы ISS. from/till: даты 'YYYY-MM-DD' (опционально).

    С токеном MOEX_API_TOKEN запрос идёт на apim.moex.com с заголовком
    Authorization: Bearer (котировки без задержки); если токен не принят —
    откат на анонимный iss.moex.com.

    ISS отдаёт не более 500 свечей за запрос, поэтому история собирается
    пагинацией параметром start (0, 500, 1000, …) до конца доступных данных
    (без from это вся история тикера, для GAZP — с 2014 г.). Защита от
    бесконечного цикла — жёсткий лимит MAX_CANDLES.
    Возвращает сырые свечи ISS: open/close/high/low/volume/value + begin/end.
    """
    ticker = ticker.upper().strip()
    token = get_moex_token()

    def base_url(use_apim: bool) -> str:
        host = "apim.moex.com" if use_apim else "iss.moex.com"
        board = "tqbr" if use_apim else "TQBR"
        url = (
            f"https://{host}/iss/engines/stock/markets/shares/"
            f"boards/{board}/securities/{ticker}/candles.json"
            f"?interval={interval}"
        )
        if from_date:
            url += f"&from={from_date}"
        if till_date:
            url += f"&till={till_date}"
        return url

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    use_apim = bool(token)   # при отказе apim падаем на анонимный ISS

    PAGE_SIZE = 500          # максимум свечей в одном ответе ISS
    MAX_CANDLES = 50000      # страховка от бесконечной пагинации

    columns = None
    rows = []

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        start = 0
        while start < MAX_CANDLES:
            try:
                async with session.get(f"{base_url(use_apim)}&start={start}",
                                       headers=headers if use_apim else {}) as response:
                    if response.status != 200:
                        if not rows and use_apim:
                            # apim не принял токен / недоступен — откат на
                            # анонимный ISS (данные с задержкой ~15 мин)
                            use_apim = False
                            continue
                        if not rows:  # ошибка на первой странице — сообщаем
                            return {"symbol": f"MOEX:{ticker}", "error": f"Not found (Status {response.status})"}
                        break       # ошибка в середине — отдаём что успели собрать
                    data = await response.json()
            except asyncio.TimeoutError:
                if not rows and use_apim:
                    use_apim = False
                    continue
                if not rows:
                    return {"symbol": f"MOEX:{ticker}", "error": "Timeout"}
                break
            except Exception as e:
                if not rows and use_apim:
                    use_apim = False
                    continue
                if not rows:
                    return {"symbol": f"MOEX:{ticker}", "error": str(e)}
                break

            candles = data.get("candles") or {}
            if columns is None:
                columns = candles.get("columns") or []
            page = candles.get("data") or []
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                break  # последняя страница истории
            start += PAGE_SIZE

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
    token = get_moex_token()

    # 1. Индексы (IMOEX, RTSI, RGBI, IRUS)
    if ticker in ['IMOEX', 'RTSI', 'RGBI', 'IRUS']:
        url = f"https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX.json?spm=a2ty_o01.29997173.0.0.144e55fbQlTBXd&file=RTSI.json{ticker}.json"
    # 2. Валюты (BYNRUB, CNYRUB, USD000UTSTOM и любые с RUB)
    elif 'RUB' in ticker or ticker in ['USD000UTSTOM', 'EUR_RUB__TOM']:
        url = f"https://iss.moex.com/iss/engines/currency/markets/currencies/boards/CETS/securities/{ticker}.json"
    # 3. Акции и облигации (по умолчанию)
    else:
        if token:
            # Авторизованный ISS (Algopack): котировки без задержки ~15 мин.
            # Авторизация — Bearer-токен в заголовке самого запроса
            # (отдельного шага логина у ISS нет).
            url = (f"https://apim.moex.com/iss/engines/stock/markets/shares/"
                   f"boards/tqbr/securities/{ticker}.json")
        else:
            url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/{ticker}.json"

    headers = {}
    if token and "apim.moex.com" in url:
        headers["Authorization"] = f"Bearer {token}"

    data = await _get_json(url, headers)

    # apim не ответил или не принял токен (401/403) — откат на анонимный ISS,
    # чтобы ручка watchlist не отваливалась (данные будут с задержкой ~15 мин).
    if "error" in data and "apim.moex.com" in url:
        anon_url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/{ticker}.json"
        data = await _get_json(anon_url)

    if "error" in data:
        return {"symbol": f"MOEX:{ticker}", "error": data["error"]}

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
