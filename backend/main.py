from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pathlib import Path

from .services import moex_service, crypto_service, telegram_news_service
from .services import portfolio_service
from .services import watchlist_service
from .models import schemas

# Путь к фронтенду
FRONTEND_PATH = Path(__file__).parent.parent / "frontend"


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Монтируем статику фронтенда при старте, чтобы "/..." не перехватывал /api/*-маршруты."""
    application.mount("/css", StaticFiles(directory=FRONTEND_PATH / "css"), name="css")
    application.mount("/js", StaticFiles(directory=FRONTEND_PATH / "js"), name="js")
    yield


app = FastAPI(title="Financial Terminal API", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Главная страница
@app.get("/")
async def root():
    return FileResponse(FRONTEND_PATH / "index.html", headers={"Cache-Control": "no-cache"})


# Иконка сайта: без неё браузер просит /favicon.ico и запрос «висит»,
# из-за чего вкладка показывает бесконечную загрузку.
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    icon = FRONTEND_PATH / "favicon.ico"
    if icon.exists():
        return FileResponse(icon)
    # Пустой ответ 204 вместо зависающего/бесконечного 404
    return Response(status_code=204)


# =============================================================================
# ЦЕНЫ (БЕЗ YAHOO FINANCE: MOEX + крипто CoinGecko)
# =============================================================================

@app.get("/api/prices/{symbol}", response_model=schemas.PriceResponse)
async def get_price(symbol: str):
    try:
        upper = symbol.upper()
        if upper.startswith("MOEX:"):
            return await moex_service.fetch_moex_price(upper.replace("MOEX:", ""))
        if upper.startswith("BINANCE:"):
            return await crypto_service.fetch_crypto_price(upper.replace("BINANCE:", ""))
        # Неизвестная биржа — считаем тикером Мосбиржи (Yahoo Finance не используется)
        return await moex_service.fetch_moex_price(upper)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# ПОРТФЕЛЬ
# =============================================================================

@app.get("/api/portfolio")
async def get_portfolio():
    return await portfolio_service.get_portfolio_with_pnl()


@app.post("/api/portfolio")
async def add_position_endpoint(position: schemas.PositionCreate):
    sector = getattr(position, 'sector', 'Не указан')
    return await portfolio_service.add_position(
        position.symbol,
        position.quantity,
        position.avg_price,
        sector
    )


@app.delete("/api/portfolio/{symbol}")
async def remove_position_endpoint(symbol: str):
    return await portfolio_service.remove_position(symbol)


# =============================================================================
# WATCHLIST - ХРАНЕНИЕ В БД
# =============================================================================

@app.get("/api/watchlist/{list_id}")
async def get_watchlist(list_id: str):
    """Возвращает список тикеров из БД в порядке позиции."""
    items = watchlist_service.get_list_symbols(list_id)
    return {"list_id": list_id, "symbols": [i["symbol"] for i in items]}


@app.post("/api/watchlist/add")
async def add_watchlist_ticker(payload: schemas.WatchlistAdd):
    """Добавляет тикер в watchlist (сохраняется в БД)."""
    try:
        return watchlist_service.add_symbol(payload.list_id, payload.symbol)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@app.post("/api/watchlist/remove")
async def remove_watchlist_ticker(payload: schemas.WatchlistRemove):
    """Удаляет тикер из watchlist (удаляется из БД)."""
    result = watchlist_service.remove_symbol(payload.list_id, payload.symbol)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Тикер не найден в списке")
    return result


@app.post("/api/watchlist/order")
async def set_watchlist_order(payload: schemas.WatchlistOrder):
    """Сохраняет новый порядок/состав списка (drag&drop, разделы)."""
    return watchlist_service.set_order(payload.list_id, payload.symbols)


# =============================================================================
# НОВОСТИ (Telegram @newssmartlab)
# =============================================================================

@app.get("/api/news/telegram/{ticker}")
async def get_telegram_news(ticker: str, force_refresh: bool = Query(default=False)):
    """Новости из @newssmartlab по тикеру"""
    clean_ticker = ticker.replace("MOEX:", "").upper()

    news = await telegram_news_service.fetch_smartlab_telegram_news(
        clean_ticker,
        force_refresh=force_refresh
    )
    return {"symbol": f"MOEX:{clean_ticker}", "news": news}


if __name__ == "__main__":
    import uvicorn

    # ВАЖНО: приложение передаётся import-строкой, иначе uvicorn не может
    # включить reload/workers ("You must pass the application as an import string")
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000)
