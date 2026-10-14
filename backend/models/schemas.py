from pydantic import BaseModel
from typing import Dict, Any, Optional, List


class PriceResponse(BaseModel):
    symbol: str
    price: float | None = None
    changeDay: float | None = None
    changeValue: float | None = None
    changeWeek: float | None = None
    changeMonth: float | None = None
    changeYear: float | None = None


class PositionCreate(BaseModel):
    symbol: str
    quantity: float
    avg_price: float
    sector: str = "Не указан"


class WatchlistAdd(BaseModel):
    list_id: str = "default"
    symbol: str
    # Название списка (опционально): передаётся фронтендом, чтобы при добавлении
    # тикера в ещё не созданный список запись в watchlists появлялась сразу с
    # настоящим именем, а не с заглушкой (закрывает гонку create/add).
    list_name: str | None = None


class WatchlistRemove(BaseModel):
    list_id: str = "default"
    symbol: str


class WatchlistOrder(BaseModel):
    list_id: str = "default"
    symbols: List[str]
    # См. WatchlistAdd: настоящее название списка при автосоздании строки в watchlists.
    list_name: str | None = None


class WatchlistRename(BaseModel):
    list_id: str = "default"
    name: str

