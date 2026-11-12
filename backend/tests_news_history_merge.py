"""Проверка накопления новостей по тикеру в news_cache (merge вместо затирания).

Сценарии:
1. Свежий парсинг сливается с накопленной историей тикера: новые посты в
   начале, дубли (по нормализованной ссылке — схема/хвостовой слэш) убираются,
   при дубликате побеждает свежий текст.
2. Лимит NEWS_HISTORY_LIMIT: старейшие посты вытесняются за пределом 100.
3. Общий новостной поток (ticker='') накапливается по тем же правилам.

Сеть не используется: save_news_to_cache вызывается напрямую с подготовленными
«результатами парсинга».
"""
import asyncio
import json

from backend.database.database import get_session, safe_create_all
from backend.database.models import NewsCache
from backend.services import telegram_news_service as tns

safe_create_all()

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def make_post(pid: int, text: str = "") -> dict:
    link = f"https://t.me/newssmartlab/{pid}"
    full = text or f"пост {pid}"
    return {"title": full[:200], "full_text": full,
            "publisher": "Smart-Lab News", "link": link, "time": "01.10.2026 10:00"}


def read_cache(ticker: str) -> list:
    with get_session() as db:
        row = db.query(NewsCache).filter(NewsCache.ticker == ticker).first()
        return json.loads(row.news_data) if row else []


def cache_age(ticker: str) -> float | None:
    from datetime import datetime
    with get_session() as db:
        row = db.query(NewsCache).filter(NewsCache.ticker == ticker).first()
        return (datetime.utcnow() - row.timestamp).total_seconds() if row else None


# --- Чистим строки кэша, которые трогаем -----------------------------------
with get_session() as db:
    db.query(NewsCache).filter(NewsCache.ticker.in_(["SBER", ""])).delete()
    db.commit()

# === 1. Слияние + дедупликация по нормализованной ссылке ====================
# История SBER: пост 100 записан со «грязной» ссылкой (http:// + слэш),
# пост 105 — обычный.
old_posts = [
    {"title": "старый 100", "full_text": "старый текст 100",
     "publisher": "Smart-Lab News", "link": "http://t.me/newssmartlab/100/", "time": "30.09.2026 09:00"},
    make_post(105),
]
with get_session() as db:
    db.add(NewsCache(ticker="SBER", news_data=json.dumps(old_posts, ensure_ascii=False)))
    db.commit()

# Свежий парс: 200 и 150 новые, 100 — дубликат (уже в истории, но с новым текстом)
fresh = [make_post(200, "свежий 200"), make_post(150), make_post(100, "СВЕЖИЙ текст 100")]
merged = asyncio.run(tns.save_news_to_cache("SBER", fresh))

ids = [tns._post_id(p["link"]) for p in merged]
check(ids == [200, 150, 105, 100], f"порядок: по убыванию id поста (получено {ids})")
check(len(merged) == 4, f"дубликат поста 100 не задваивается (получено {len(merged)})")
dup = next(p for p in merged if tns._post_id(p["link"]) == 100)
check(dup["full_text"] == "СВЕЖИЙ текст 100", "при дубликате побеждает свежий текст парса")
check(cache_age("SBER") is not None and cache_age("SBER") < 60,
      "timestamp строки кэша обновлён (TTL перезапущен)")

# === 2. Лимит накопления ====================================================
# История потока: 120 постов (id 1..120). Свежий парс приносит 5 новых
# (id 121..125) — в кэше должно остаться 100 самых свежих (id 26..125).
stream_old = [make_post(i) for i in range(1, 121)]
with get_session() as db:
    db.query(NewsCache).filter(NewsCache.ticker == "").delete()
    db.add(NewsCache(ticker="", news_data=json.dumps(stream_old, ensure_ascii=False)))
    db.commit()

stream_fresh = [make_post(i) for i in range(121, 126)]
merged_stream = asyncio.run(tns.save_news_to_cache("", stream_fresh))

check(len(merged_stream) == tns.NEWS_HISTORY_LIMIT,
      f"лимит накопления: {len(merged_stream)} == {tns.NEWS_HISTORY_LIMIT}")
stream_ids = {tns._post_id(p["link"]) for p in merged_stream}
check(min(stream_ids) == 26 and max(stream_ids) == 125,
      f"вытеснились самые старые (остались id {min(stream_ids)}..{max(stream_ids)})")
check(stream_ids == set(range(26, 126)), "внутри лимита порядок id непрерывный, без дыр")

# === 3. Битая строка кэша не роняет слияние =================================
with get_session() as db:
    db.query(NewsCache).filter(NewsCache.ticker == "GAZP").delete()
    db.add(NewsCache(ticker="GAZP", news_data="не json"))
    db.commit()
merged_bad = asyncio.run(tns.save_news_to_cache("GAZP", [make_post(300)]))
check([tns._post_id(p["link"]) for p in merged_bad] == [300],
      "битый news_data трактуется как пустая история")
with get_session() as db:
    db.query(NewsCache).filter(NewsCache.ticker.in_(["SBER", "GAZP", ""])).delete()
    db.commit()

print()
if failures:
    print(f"❌ Провалено проверок: {failures}")
    raise SystemExit(1)
print("✅ Все проверки накопления новостей пройдены")
