from sqlalchemy import Column, String, Integer, DateTime, Text
from datetime import datetime
from .database import Base


class NewsCache(Base):
    __tablename__ = "news_cache"

    ticker = Column(String, primary_key=True, index=True)
    news_data = Column(Text)
    timestamp = Column(DateTime, default=datetime.utcnow)


class WatchlistItem(Base):
    """Тикер watchlist, привязанный к конкретному списку."""
    __tablename__ = "watchlist_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    list_id = Column(String, nullable=False, index=True, default="default")
    symbol = Column(String, nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    added_at = Column(DateTime, default=datetime.utcnow)


class Watchlist(Base):
    """Список watchlist: id -> название (хранится в БД, а не в localStorage)."""
    __tablename__ = "watchlists"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="Основной")
    created_at = Column(DateTime, default=datetime.utcnow)
