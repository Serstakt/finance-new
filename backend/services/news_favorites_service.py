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


def _normalize_ticker(ticker: str | None) -> str | None:
    """Приводит тикер к каноничному виду «SBER» (без префикса биржи и регистра)."""
    t = (ticker or "").replace("MOEX:", "").strip().upper()
    return t or None


# === Поиск избранных новостей по тикеру напрямую в БД ===
# Вкладка «🚩 Избранные новости» тянет заголовки/время постов из таблицы
# news_cache — туда парсер пишет результаты, только когда пользователь
# открывал вкладку «Новости» этого тикера. Чтобы избранное не зависело от
# того, прогружалась ли лента, у нас есть два прямых источника в БД:
#   1) ticker-кэш (строки news_cache.ticker == <тикер>) — переживает
#      5-минутный TTL потока: get_cached_news удаляет только СВОЮ строку,
#      а save_news_to_cache при последующем парсинге перезаписывает её;
#   2) новостной поток (@newssmartlab): строки кэша, в которых лежат полные
#      тексты спарсенных постов — по ним находим id постов из favorites и
#      определяем принадлежность тикеру через поисковые слова парсера.
from backend.services.telegram_news_service import RU_NAMES

STREAM_LIMIT = 5000  # запас строк кэша, которого хватает на любой объём избранного


def _ticker_terms(ticker: str) -> list[str]:
    """Поисковые слова тикера — те же, что использует парсер Telegram."""
    terms = [f"${ticker}", f"#{ticker}", ticker]
    if ticker in RU_NAMES:
        terms.extend(RU_NAMES[ticker])
    return terms


def _match_ticker(text: str, wanted: set[str]) -> bool:
    """Содержит ли текст поста поисковые слова хотя бы одного тикера из wanted."""
    tl = (text or "").lower()
    return any(term.lower() in tl for t in wanted for term in _ticker_terms(t))


def get_all(ticker: str | None = None) -> dict[str, dict]:
    """Избранные новости: {link: {"ticker": ..., "title": ...}}.

    ticker=None — все избранные новости (нужно для видимости вкладки
    «Избранные»: она существует, пока избранное есть хотя бы по одному тикеру).
    С указанным тикером — только флажки, поставленные в ленте этого тикера:
    вкладка «Избранные Новости» показывает строго избранное выбранного тикера.
    """
    norm = _normalize_ticker(ticker)
    with get_session() as db:
        query = db.query(NewsFavorite)
        if norm:
            query = query.filter(NewsFavorite.ticker == norm)
        rows = query.all()
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


def _collect_db_posts(wanted: set[str], need_ids: set[int]) -> dict[int, tuple[dict, str | None]]:
    """Ищет нужные Telegram-посты напрямую в таблице news_cache (БД).

    Возвращает {post_id: (post, ticker_строки_кэша)}. Источник истины — сама
    база: вкладка «Избранные новости» не ждёт, пока пользователь откроет
    вкладку «Новости» и парсер что-либо загрузит, и сама ничего не парсит.
    Сканируем строки кэша в разумном порядке: сначала строки интересующих
    тикеров (они точнее всего), затем остальные (в т.ч. новостной поток
    @newssmartlab) — и останавливаемся, как только найдены все нужные id.
    """
    found: dict[int, tuple[dict, str | None]] = {}
    if not need_ids:
        return found
    try:
        with get_session() as db:
            rows_wanted = []
            rows_rest = []
            if wanted:
                rows_wanted = db.query(NewsCache) \
                    .filter(NewsCache.ticker.in_(list(wanted))).all()
                rows_rest = db.query(NewsCache) \
                    .filter(~NewsCache.ticker.in_(list(wanted))) \
                    .order_by(NewsCache.timestamp.desc()).limit(STREAM_LIMIT).all()
            else:
                rows_rest = db.query(NewsCache) \
                    .order_by(NewsCache.timestamp.desc()).limit(STREAM_LIMIT).all()
            for row in list(rows_wanted) + list(rows_rest):
                try:
                    posts = json.loads(row.news_data or "[]")
                except (ValueError, TypeError):
                    continue
                if not isinstance(posts, list):
                    continue
                row_ticker = _normalize_ticker(row.ticker)
                # Пост из строки кэша чужого тикера берём только если текст
                # сам упоминает нужный тикер (в лентах бывают перекрёстные
                # упоминания) — иначе это избрание другого тикера.
                strict_row = bool(row_ticker and row_ticker not in wanted)
                for p in posts:
                    if not isinstance(p, dict):
                        continue
                    pid = _post_id(p.get("link", ""))
                    if pid is None or pid not in need_ids or pid in found:
                        continue
                    if strict_row:
                        text = f"{p.get('full_text') or ''} {p.get('title') or ''}"
                        if not _match_ticker(text, wanted):
                            continue
                    found[pid] = (p, row.ticker)
                if len(found) >= len(need_ids):
                    break
    except Exception as e:  # кэш мог быть битым/недоступным — не критично
        print(f"⚠ Не удалось обогатить избранное из news_cache: {e}")
    return found


def _owns_post(entry: tuple[dict, str | None] | None, wanted: set[str]) -> bool:
    """Принадлежит ли найденный в БД пост интересующим нас тикерам.

    Если пост лежит в строке кэша нужного тикера — принадлежит по определению
    (парсер подобрал его по словам этого тикера). Если в строке потока или
    чужого тикера — проверяем текст поста поисковыми словами (те же terms,
    что использует telegram_news_service). Без записи в БД считаем, что
    принадлежит: флажок уже отфильтрован по ticker в news_favorites.
    """
    if entry is None:
        return True
    post, cache_ticker = entry
    ct = _normalize_ticker(cache_ticker)
    if ct and ct in wanted:
        return True
    text = f"{post.get('full_text') or ''} {post.get('title') or ''}"
    return _match_ticker(text, wanted)


def list_favorites(ticker: str | None = None) -> list[dict]:
    """Избранные новости списком для вкладки «Избранные Новости».

    ticker — выбранный в watchlist тикер: вкладка показывает избранные
    новости индивидуально по каждому тикеру (флажки, поставленные в ленте
    SBER, не видны при выбранном GAZP). Пустой/None — все избранные новости
    (используется как фолбэк для новостей без привязанного тикера).

    Данные тянутся НАПРЯМУЮ из БД, без ожидания загрузки вкладки «Новости»:
    сами флажки читаются из таблицы news_favorites, а заголовок, время и
    принадлежность тикеру — из таблицы news_cache (_collect_db_posts
    сканирует базу сразу, включая кэш других тикеров и общий новостной
    поток, и завершает обход, как только найдены все нужные посты).
    Парсинг Telegram при этом не запускается.

    Каждая запись: {link, ticker, title, time}. Если новость ещё не лежит
    ни в одном кэше — возвращаем title из таблицы favorites (он пишется при
    постановке флажка), time остаётся пустым. Отсортировано по времени
    (свежие выше), безвременные — в конце.
    """
    norm = _normalize_ticker(ticker)
    favs = get_all(norm)
    if not favs:
        return []

    wanted = {norm} if norm else {_normalize_ticker(m.get("ticker"))
                                  for m in favs.values()}
    wanted.discard(None)

    # Ищем каждый избранный пост прямо в news_cache — по числовому id поста
    # из ссылки (t.me/newssmartlab/<id>), независимо от того, открывалась
    # ли когда-либо вкладка «Новости» этого тикера.
    need_ids = {pid for pid in (_post_id(l) for l in favs) if pid is not None}
    post_index = _collect_db_posts(wanted, need_ids)

    items = []
    for link, meta in favs.items():
        pid = _post_id(link)
        entry = post_index.get(pid) if pid is not None else None
        post = (entry or (None, None))[0]
        item_ticker = meta.get("ticker")
        if norm:
            # Привязка к выбранному тикеру: доверяем метке флажка; если она
            # пустая или расходится с выборкой — определяем принадлежность по
            # месту хранения поста и его тексту (как делает парсер).
            mt = _normalize_ticker(item_ticker)
            if mt != norm and not _owns_post(entry, {norm}):
                continue
            if not mt:
                item_ticker = norm
        title = (post or {}).get("full_text") or (post or {}).get("title") \
            or meta.get("title") or link
        items.append({
            "link": link,
            "ticker": item_ticker,
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
