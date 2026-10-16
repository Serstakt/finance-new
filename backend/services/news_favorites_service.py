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
import json

from backend.database.database import get_session, safe_create_all
from backend.database.models import NewsCache, NewsFavorite

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


def _post_id(link: str) -> int | None:
    """Достаёт числовой id поста Telegram из ссылки вида t.me/<channel>/<id>."""
    tail = (link or "").rstrip("/").rsplit("/", 1)[-1]
    # у закреп/форвардов бывают хвосты вида /123?single — отрезаем не-цифры
    digits = ""
    for ch in reversed(tail):
        if ch.isdigit():
            digits = ch + digits
        else:
            break
    return int(digits) if digits else None


def list_favorites() -> list[dict]:
    """Избранные новости списком для вкладки «Избранные Новости».

    Каждая запись: {link, ticker, title, time}. Заголовок и время по
    возможности подтягиваются из news_cache (парсер сохраняет там full_text
    и точный таймстемп поста); если новость ещё не лежит ни в одном кэше —
    возвращаем title из таблицы favorites (он пишется при постановке
    флажка), time остаётся пустым. Отсортировано по времени (свежие выше),
    безвременные — в конце.
    """
    favs = get_all()
    if not favs:
        return []

    # Индекс постов по id Telegram-поста из всего кэшированного потока новостей.
    post_index: dict[int, dict] = {}
    try:
        with get_session() as db:
            for row in db.query(NewsCache).all():
                try:
                    posts = json.loads(row.news_data or "[]")
                except (ValueError, TypeError):
                    continue
                for p in posts if isinstance(posts, list) else []:
                    if not isinstance(p, dict):
                        continue
                    pid = _post_id(p.get("link", ""))
                    if pid is not None and pid not in post_index:
                        post_index[pid] = p
    except Exception as e:  # кэш мог быть битым/недоступным — не критично
        print(f"⚠ Не удалось обогатить избранное из news_cache: {e}")

    items = []
    for link, meta in favs.items():
        pid = _post_id(link)
        post = post_index.get(pid) if pid is not None else None
        title = (post or {}).get("full_text") or (post or {}).get("title") \
            or meta.get("title") or link
        items.append({
            "link": link,
            "ticker": meta.get("ticker"),
            "title": str(title)[:TITLE_MAX_LEN],
            "time": (post or {}).get("time") or "",
        })

    # Сортировка по времени поста (%d.%m.%Y %H:%M или %d.%m.%Y) — свежие сверху;
    # записи без времени — в конец, между собой по ссылке (стабильный порядок).
    def sort_key(it: dict):
        t = it["time"]
        try:
            from datetime import datetime as dt
            fmt = "%d.%m.%Y %H:%M" if len(t) > 10 else "%d.%m.%Y"
            ts = dt.strptime(t, fmt).timestamp()
        except (ValueError, TypeError):
            ts = -1.0
        return (-ts, it["link"])

    items.sort(key=sort_key)
    return items


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
