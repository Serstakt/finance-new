"""Сервис хранения избранных новостей в БД (SQLite через SQLAlchemy).

Вкладка «Новости» раздела Watchlist показывает посты, спарсенные из Telegram
(@newssmartlab). Пользователь может отметить конкретную новость избранным —
слева от неё появляется красный флажок 🚩 (как у тикеров в watchlist_items).

Идентификатором новости служит постоянная ссылка на пост (news.link вида
https://t.me/newssmartlab/<id>) — она не меняется между обновлениями кэша,
в отличие от заголовка/текста.

Флажки хранятся в таблице news_favorites, поэтому избранное переживает
очистку localStorage и доступно с любого браузера/устройства.
"""
from backend.database.database import get_session, safe_create_all
from backend.database.models import NewsFavorite

safe_create_all()

# Максимальная длина сохраняемого заголовка (колонка title — только для
# отображения вне контекста, полный текст всегда в news_cache / Telegram).
TITLE_MAX_LEN = 300


def _normalize_link(link: str) -> str:
    """Приводит ссылку на пост к каноничному виду для использования как PK.

    Ссылки из Telegram-парсера могут отличаться хвостовым слэшем или схемой
    (http/https), из-за чего одна новость могла бы сохраниться дважды.
    """
    s = (link or "").strip()
    if not s:
        return ""
    if s.startswith("http://"):
        s = "https://" + s[len("http://"):]
    return s.rstrip("/")


def get_all() -> dict[str, dict]:
    """Все избранные новости: {link: {"ticker": ..., "title": ...}}."""
    with get_session() as db:
        rows = db.query(NewsFavorite).all()
        return {
            r.link: {"ticker": r.ticker, "title": r.title}
            for r in rows
            if r.link
        }


def set_favorite(link: str, ticker: str | None = None, title: str | None = None) -> dict:
    """Ставит флажок «избранное» на новость (идемпотентно)."""
    link = _normalize_link(link)
    if not link:
        return {"status": "bad_request", "error": "Пустая ссылка на новость"}
    ticker = (ticker or "").replace("MOEX:", "").strip().upper() or None
    title = (title or "").strip()[:TITLE_MAX_LEN] or None
    with get_session() as db:
        row = db.get(NewsFavorite, link)
        if not row:
            row = NewsFavorite(link=link, ticker=ticker, title=title)
            db.add(row)
        else:
            # при повторной отметке обновляем контекст последней отметки
            if ticker:
                row.ticker = ticker
            if title:
                row.title = title
        db.commit()
        return {"status": "ok", "link": link, "favorite": True}


def remove_favorite(link: str) -> dict:
    """Снимает флажок «избранное» с новости."""
    link = _normalize_link(link)
    if not link:
        return {"status": "bad_request", "error": "Пустая ссылка на новость"}
    with get_session() as db:
        row = db.get(NewsFavorite, link)
        if not row:
            return {"status": "not_found", "link": link}
        db.delete(row)
        db.commit()
        return {"status": "ok", "link": link, "favorite": False}
