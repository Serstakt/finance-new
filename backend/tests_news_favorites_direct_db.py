"""Проверка: вкладка «🚩 Избранные новости» тянет данные НАПРЯМУЮ из БД.

Сценарий пользователя: флажок поставлен, но вкладка «Новости» этого тикера
никогда не открывалась (его строки в news_cache нет) — при этом пост лежит
в общем новостном потоке (@newssmartlab). list_favorites обязан вернуть
заголовок/время/тикер без какого-либо парсинга Telegram.
"""
import json
from datetime import datetime

from backend.database.database import get_session, safe_create_all
from backend.database.models import NewsCache, NewsFavorite
from backend.services import news_favorites_service as svc
from backend.services import telegram_news_service

safe_create_all()

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


# --- Чистим таблицы, которые трогаем --------------------------------------
with get_session() as db:
    db.query(NewsFavorite).delete()
    db.query(NewsCache).filter(NewsCache.ticker.in_(["SBER", "GAZP", ""])).delete()
    db.commit()

posts_stream = [
    {"title": "Сбер: МСФО за квартал... Читать далее", "full_text": "$SBER отчитался по МСФО",
     "publisher": "Smart-Lab News", "link": "https://t.me/newssmartlab/111", "time": "02.10.2026 10:00"},
    {"title": "Газпром: дивиденды", "full_text": "#GAZP рекомендовал дивиденды",
     "publisher": "Smart-Lab News", "link": "https://t.me/newssmartlab/222", "time": "01.10.2026 09:00"},
]
posts_gazp = [
    {"title": "Газпром добыя", "full_text": "GAZP: дочерняя компания",
     "publisher": "Smart-Lab News", "link": "https://t.me/newssmartlab/333", "time": "30.09.2026 12:00"},
]

with get_session() as db:
    # общий поток (@newssmartlab) — есть в БД
    db.add(NewsCache(ticker="", news_data=json.dumps(posts_stream, ensure_ascii=False),
                    timestamp=datetime.utcnow()))
    # кэш GAZP — тоже есть (перекрёстное упоминание SBER отсутствует)
    db.add(NewsCache(ticker="GAZP", news_data=json.dumps(posts_gazp, ensure_ascii=False),
                    timestamp=datetime.utcnow()))
    db.commit()

# Флажки: SBER-новости (посты 111 и 222? нет: 111 — SBER, 333 — избрание GAZP)
svc.set_favorite("https://t.me/newssmartlab/111/", "SBER", "Сбер: МСФО")   # хвостовой слэш
svc.set_favorite("http://t.me/newssmartlab/333", "GAZP", "Газпром добыя")

# Парсинг Telegram быть не должен — заглушка падает, если её вызовут
async def _no_parsing(*a, **k):
    raise AssertionError("list_favorites не должен запускать парсинг Telegram!")
telegram_news_service.fetch_smartlab_telegram_news = _no_parsing

# --- Ключевой сценарий: лента SBER никогда не загружалась ------------------
items = svc.list_favorites("MOEX:sber")  # префикс биржи + нижний регистр
check(len(items) == 1, "Избранное SBER вернулось без загрузки вкладки «Новости»")
it = items[0] if items else {}
check(it.get("link") == "https://t.me/newssmartlab/111", "Ссылка канонизирована")
check(it.get("ticker") == "SBER", "Тикер определён напрямую из потока БД")
check(it.get("title") == "$SBER отчитался по МСФО", "Заголовок взят из news_cache (полный текст)")
check(it.get("time") == "02.10.2026 10:00", "Время поста подтянуто из БД")

# Избранное GAZP видно только под своим тикером
check(svc.list_favorites("GAZP")[0]["link"] == "https://t.me/newssmartlab/333",
      "Избранное GAZP индивидуально по своему тикеру")
check(all(n["link"] != "https://t.me/newssmartlab/333" for n in svc.list_favorites("SBER")),
      "Чужое избранное не попадает в ленту SBER")

# Общий список (без тикера) — обе новости, свежие сверху
alls = svc.list_favorites(None)
check([n["link"] for n in alls] == ["https://t.me/newssmartlab/111",
                                    "https://t.me/newssmartlab/333"],
      "Общий список отсортирован по времени (свежие сверху)")

print("\nALL TESTS PASSED" if not failures else f"\n{failures} TEST(S) FAILED")
raise SystemExit(1 if failures else 0)
