"""Проверка сигнализации о фоновом переобновлении кэша новостей.

Сценарии (stale-while-revalidate + long-poll):
1. Устаревший кэш: fetch возвращает (stale, revalidating=True) и запускает
   ровно ОДНУ фоновую задачу, сколько бы запросов ни прилетело.
2. wait_for_background_refresh возвращает True после завершения парсера —
   в том числе если фронт подключился, когда парсинг уже закончился.
3. Wait без запущенного обновления → сразу False, без ожидания.
4. Свежий кэш → revalidating=False.
"""
import asyncio
import json
from datetime import datetime, timedelta

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


def make_post(pid: int) -> dict:
    return {"title": f"пост {pid}", "full_text": f"$TEST пост {pid}",
            "publisher": "Smart-Lab News", "link": f"https://t.me/newssmartlab/{pid}",
            "time": "01.10.2026 10:00"}


async def main() -> None:
    global failures

    # --- Чистим состояние и готовим УСТАРЕВШИЙ кэш CNRU -----------------------
    tns._refresh_inflight.clear()
    tns._refresh_done.clear()
    with get_session() as db:
        db.query(NewsCache).filter(NewsCache.ticker == "CNRU").delete()
        db.add(NewsCache(ticker="CNRU", news_data=json.dumps([make_post(1)]),
                         timestamp=datetime.utcnow() - timedelta(hours=2)))
        db.commit()

    # Заглушка парсера: «парсинг» занимает 0.3 с и обновляет кэш
    parsed = []

    async def fake_parse(ticker, *a, **k):
        parsed.append(ticker)
        await asyncio.sleep(0.3)
        await tns.save_news_to_cache(ticker, [make_post(2)])
        return [make_post(2)]

    real_parse = tns.parse_and_save_news
    tns.parse_and_save_news = fake_parse
    try:
        # === 1. Stale-ответ помечен revalidating, задача одна на ключ ==========
        news, revalidating = await tns.fetch_smartlab_telegram_news("CNRU")
        check(revalidating is True, "stale-ответ помечен revalidating=True")
        check(news and tns._post_id(news[0]["link"]) == 1, "отдана устаревшая лента из БД")
        check("CNRU" in tns._refresh_inflight, "ключ перезапуска в inflight")

        # Параллельные запросы, пока парсинг идёт: дублей задач быть не должно
        await tns.fetch_smartlab_telegram_news("CNRU")
        await tns.fetch_smartlab_telegram_news("CNRU")
        check(len(tns._refresh_inflight) == 1, f"задача парсинга одна (inflight: {tns._refresh_inflight})")

        # === 2. Wait завершается True после окончания парсинга =================
        refreshed = await tns.wait_for_background_refresh("CNRU", timeout=5.0)
        check(refreshed is True, "wait вернул True после завершения парсинга")
        check(parsed == ["CNRU"], f"парсер отработал ровно один раз (вызовы: {parsed})")
        check("CNRU" not in tns._refresh_inflight, "ключ покинул inflight после завершения")
        # И второй wait после завершения — тоже мгновенный True (событие ещё в памяти)
        refreshed2 = await tns.wait_for_background_refresh("CNRU", timeout=1.0)
        check(refreshed2 is True, "wait после завершения возвращает True мгновенно")

        # Повторный fetch: кэш уже свежий → revalidating=False
        news2, revalidating2 = await tns.fetch_smartlab_telegram_news("CNRU")
        check(revalidating2 is False, "после переобновления кэш свежий — revalidating=False")
        check(news2 and tns._post_id(news2[0]["link"]) == 2, "перезапрос отдаёт обновлённую ленту")

        # === 3. Wait без запущенного обновления → сразу False ==================
        t0 = asyncio.get_event_loop().time()
        refreshed3 = await tns.wait_for_background_refresh("NOSUCH", timeout=5.0)
        elapsed = asyncio.get_event_loop().time() - t0
        check(refreshed3 is False, "wait без обновления вернул False")
        check(elapsed < 0.5, f"wait без обновления не ждал ({elapsed:.2f} с)")

        # === 4. Свежий кэш → revalidating=False ================================
        _, revalidating4 = await tns.fetch_smartlab_telegram_news("CNRU")
        check(revalidating4 is False, "свежий кэш не помечается revalidating")
    finally:
        tns.parse_and_save_news = real_parse
        tns._refresh_inflight.clear()
        tns._refresh_done.clear()
        with get_session() as db:
            db.query(NewsCache).filter(NewsCache.ticker == "CNRU").delete()
            db.commit()

    if failures:
        print(f"\n❌ Провалено проверок: {failures}")
        raise SystemExit(1)
    print("\n✅ Все проверки сигнала переобновления пройдены")


asyncio.run(main())
