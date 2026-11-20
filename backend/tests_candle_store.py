"""Проверка накопления свечей «Тест график» в БД (services/candle_store_service.py).

Покрывает:
  * get-or-create тикера в справочнике candle_tickers (без дублей);
  * bulk-upsert candle_bars: повторное сохранение не плодит строки,
    последняя «формирующаяся» свеча обновляется;
  * реестр candle_timeframes: last_begin / candle_count корректны после
    каждой записи, истории разных ТФ одного тикера не смешиваются;
  * инкрементальный флоу фоновой докачки main._backfill_other_intervals:
    в API уходит from = дата последней сохранённой свечи (или полная
    история, если ТФ ещё не копился).
"""
import asyncio

from backend import main as app_main
from backend.database.database import get_session, safe_create_all
from backend.database.models import CandleBar, CandleTicker, CandleTimeframe
from backend.services import candle_store_service as svc

safe_create_all()

# Тестовый тикер с заведомо несуществующим на бирже именем, чтобы не
# пересечься с реальными накопленными данными.
TEST_SYMBOL = "MOEX:__TESTACC__"

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def cleanup():
    """Удаляет тестовые строки из всех трёх таблиц хранилища свечей."""
    with get_session() as db:
        ids = [r[0] for r in db.query(CandleTicker.id)
               .filter(CandleTicker.symbol == TEST_SYMBOL)]
        if ids:
            db.query(CandleBar).filter(CandleBar.ticker_id.in_(ids)) \
                .delete(synchronize_session=False)
            db.query(CandleTimeframe).filter(CandleTimeframe.ticker_id.in_(ids)) \
                .delete(synchronize_session=False)
            db.query(CandleTicker).filter(CandleTicker.symbol == TEST_SYMBOL) \
                .delete(synchronize_session=False)
        db.commit()


cleanup()

# --- Свечи-фикстуры (формат ответа moex_service / crypto_service) ----------
def candle(day, close, open_=None):
    o = open_ if open_ is not None else close
    return {
        "open": o, "high": max(o, close) + 1, "low": min(o, close) - 1,
        "close": close, "volume": 10, "value": 1000,
        "begin": f"2026-01-{day:02d} 00:00:00",
        "end": f"2026-01-{day:02d} 23:59:59",
    }


# --- 1. Первое сохранение: тикер создаётся, свечи ложатся в bars + реестр ---
res = svc.save_candles(TEST_SYMBOL, 24, [candle(1, 100), candle(2, 105), candle(3, 106)])
check(res["status"] == "ok", "save_candles вернул ok")
check(res["candle_count"] == 3, f"После первого сохранения 3 свечи (получено {res['candle_count']})")
check(res["last_begin"] == "2026-01-03 00:00:00", "last_begin — последняя сохранённая свеча")

with get_session() as db:
    n_tickers = db.query(CandleTicker).filter(CandleTicker.symbol == TEST_SYMBOL).count()
check(n_tickers == 1, "Справочник candle_tickers: одна строка на тикер")

# --- 2. Повторное сохранение тех же свечей — без дублей ----------------------
res2 = svc.save_candles(TEST_SYMBOL, 24, [candle(1, 100), candle(2, 105), candle(3, 106)])
check(res2["candle_count"] == 3, f"Повторное сохранение не плодит строки (получено {res2['candle_count']})")

# --- 3. Обновление последней («формирующейся») свечи + новая -----------------
res3 = svc.save_candles(TEST_SYMBOL, 24, [candle(3, 108), candle(4, 112)])
check(res3["candle_count"] == 4, f"Обновление + новая свеча: всего 4 (получено {res3['candle_count']})")
bars = svc.load_candles(TEST_SYMBOL, 24)
check([b["close"] for b in bars] == [100, 105, 108, 112],
      "Перезаписанная свеча 01-03 обновилась (close 108), история отсортирована по begin")

# --- 4. ТФ одного тикера не смешиваются -------------------------------------
svc.save_candles(TEST_SYMBOL, 60, [candle(1, 100)])
counts = svc.stored_candle_counts(TEST_SYMBOL)
check(counts.get(24) == 4 and counts.get(60) == 1,
      f"Счётчики по ТФ независимы: {counts}")
check(len(svc.load_candles(TEST_SYMBOL, 24)) == 4 and len(svc.load_candles(TEST_SYMBOL, 60)) == 1,
      "load_candles отдаёт историю только своего ТФ")

# --- 5. get_last_begin из реестра --------------------------------------------
check(svc.get_last_begin(TEST_SYMBOL, 24) == "2026-01-04 00:00:00",
      "get_last_begin(24) — дата последней свечи дневного ТФ")
check(svc.get_last_begin(TEST_SYMBOL, 60) == "2026-01-01 00:00:00",
      "get_last_begin(60) — дата последней свечи часового ТФ")
check(svc.get_last_begin(TEST_SYMBOL, 31) is None,
      "get_last_begin(31) — None: месячный ТФ ещё не копился")
check(svc.get_last_begin("MOEX:__UNKNOWN__", 24) is None,
      "get_last_begin неизвестного тикера — None")

# --- 6. Инкрементальный флоу фоновой докачки ---------------------------------
# Заглушка источника: фиксирует from, отдает свежие свечи для запрошенного ТФ.
calls = []

async def fake_fetch(ticker, is_binance, interval, from_date, till_date):
    calls.append({"interval": interval, "from": from_date})
    return {"symbol": f"MOEX:{ticker}", "interval": interval,
            "candles": [candle(4, 112)]}

orig_fetch = app_main._fetch_candles_from_source
app_main._fetch_candles_from_source = fake_fetch
try:
    asyncio.run(app_main._backfill_other_intervals(TEST_SYMBOL, 24))
finally:
    app_main._fetch_candles_from_source = orig_fetch

by_interval = {c["interval"]: c["from"] for c in calls}
check(sorted(by_interval) == [7, 31, 60], f"Докачка запущена для остальных ТФ (60/7/31): {sorted(by_interval)}")
check(by_interval.get(60) == "2026-01-01", "Часовой ТФ докачивается инкрементом от последней свечи")
check(by_interval.get(7) is None and by_interval.get(31) is None,
      "Некопившиеся ТФ (7/31) запрашивают полную историю (from=None)")

counts = svc.stored_candle_counts(TEST_SYMBOL)
check(counts.get(7) == 1 and counts.get(31) == 1,
      f"После докачки ТФ 7 и 31 накоплены в реестре: {counts}")

# --- 7. save_candles без свечей — no-op --------------------------------------
res_noop = svc.save_candles(TEST_SYMBOL, 7, [])
check(res_noop["status"] == "nothing_to_save", "Пустой список свечей — nothing_to_save")

cleanup()
check(svc.get_last_begin(TEST_SYMBOL, 24) is None, "cleanup удалил тестовые строки")

print("\nALL TESTS PASSED" if not failures else f"\n{failures} TEST(S) FAILED")
raise SystemExit(1 if failures else 0)
