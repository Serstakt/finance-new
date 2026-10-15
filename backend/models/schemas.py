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
    # Логотип монеты (CoinGecko image, поле приходит из /coins/markets).
    # Для MOEX-тикеров может приходить favicon с сайта эмитента или None.
    logo: str | None = None


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


class WatchlistRepair(BaseModel):
    """Массовая починка названий: {list_id: настоящее_название}.

    Фронтенд вызывает POST /api/watchlist/repair при загрузке раздела
    WATCHLIST, чтобы залечить строки-заглушки («Новый список»,
    list_<timestamp>), созданные гонкой add-before-create.
    Настоящие пользовательские названия не перезаписываются.
    """
    names: Dict[str, str]


# === ЦЕНОВЫЕ АЛЕРТЫ (хранятся в БД, таблица price_alerts) ===

class AlertCreate(BaseModel):
    symbol: str
    condition: str = "above"          # above | below
    target: float
    # Текущая цена на момент создания (сохраняется в price_at_creation
    # для отображения «от какой цены ждали»).
    price_at_creation: Optional[float] = None


class AlertMigrate(BaseModel):
    """Перенос старых алертов из localStorage ('price_alerts') в БД.

    legacy-формат записи: {id, symbol, condition, target, active, status?, cancelled?}
    """
    alerts: List[Dict[str, Any]]

