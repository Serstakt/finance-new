import aiohttp

async def fetch_crypto_price(symbol: str) -> dict:
    coin_id = symbol.lower().replace('usdt', '').replace('btc', 'bitcoin').replace('eth', 'ethereum')
    url = f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}&vs_currencies=usd&include_24hr_change=true"

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        async with session.get(url) as response:
            if response.status != 200:
                return {"symbol": f"BINANCE:{symbol}", "error": "API limit or error"}
            data = await response.json()

            if coin_id not in data:
                return {"symbol": f"BINANCE:{symbol}", "error": "Not found"}

            coin_data = data[coin_id]
            return {
                "symbol": f"BINANCE:{symbol}",
                "price": coin_data.get('usd'),
                "changeDay": coin_data.get('usd_24h_change')
            }