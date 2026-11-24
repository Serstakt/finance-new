"""Проверка тепловой карты «Главная» (services/heatmap_service.py + состав списков).

Покрывает:
  * compute_period_change: % изменения на фикстурных свечах (рост/падение,
    частичное окно, пустые свечи, нулевая базовая цена, внеокновые свечи);
  * get_all_symbols_by_list: состав всех списков без SECTION-заголовков;
  * TTL-кэш get_period_changes: повторный батч не дёргает докачку свечей,
    clear_cache сбрасывает;
  * устойчивость к ошибке одного тикера: он получает {"error": ...},
    остальные считаются.

Тестовый тикер с заведомо несуществующим именем — чтобы не пересечься с
реальными списками (по образцу tests_candle_store.py). В конце — cleanup.
"""
import asyncio

from backend.services import heatmap_service as svc
from backend.services import watchlist_service as ws

TEST_LIST_A = "hm_test_list_a"
TEST_LIST_B = "hm_test_list_b"
TEST_SYM = "MOEX:__TESTH__"
TEST_SYM_CRYPTO = "BINANCE:__TESTH__USDT"

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def cleanup():
    """Удаляет тестовые списки и сбрасывает кэш карты."""
    for lid in (TEST_LIST_A, TEST_LIST_B):
        try:
            ws.delete_list(lid)
        except Exception:
            pass
    svc.clear_cache()


cleanup()  # на случай незавершённого прошлого прогона

# =============================================================================
# 1. compute_period_change — чистая функция на фикстурных свечах
# =============================================================================
from datetime import datetime

NOW = datetime(2026, 11, 24, 18, 0, 0)


def d(day, hour=0):
    return f"2026-{11:02d}-{day:02d}T{hour:02d}:00:00"


candles_up = [
    {"begin": d(24, 18), "close": 110.0},   # последняя
    {"begin": d(16), "close": 100.0},       # ровно на границе недели (24-7)
    {"begin": d(10), "close": 90.0},        # за окном недели
    {"begin": "2026-10-20T00:00:00", "close": 88.0},
]
r = svc.compute_period_change(candles_up, 7, NOW)
check(r.get("changePct") == 10.0 and not r.get("partial"),
      f"week: рост +10% от свечи на границе окна (получено {r})")

r = svc.compute_period_change(candles_up, 30, NOW)
check(r.get("changePct") == 25.0, f"month: +25% от свечи 20.10 (получено {r})")

candles_down = [{"begin": d(24, 18), "close": 90.0}, {"begin": d(17), "close": 100.0}]
r = svc.compute_period_change(candles_down, 7, NOW)
check(r.get("changePct") == -10.0, f"week: падение -10% (получено {r})")

r = svc.compute_period_change([candles_up[0]], 30, NOW)
check(r.get("changePct") == 0.0 and r.get("partial") is True,
      "partial: одна свеча — расчёт от неё, partial=True")

r = svc.compute_period_change([], 7, NOW)
check("error" in r, "пустой список свечей -> error")

r = svc.compute_period_change([{"begin": d(24), "close": 0}], 7, NOW)
check("error" in r, "нулевая базовая цена -> error")

# Свечи в произвольном порядке + мусорные записи без begin/close — результат тот же
r_mixed = svc.compute_period_change(list(reversed(candles_up)) + [{"begin": None}, {"close": 5}], 7, NOW)
check(r_mixed.get("changePct") == 10.0,
      f"свечи не по порядку и без close не ломают расчёт (получено {r_mixed})")

# _history_needs_fetch: свежесть хвоста И покрытие окна (сценарий «неделя -> месяц»).
# Свечи — по возрастанию begin, как отдаёт load_candles.
oldest_candle = {"begin": "2026-10-01T00:00:00", "close": 1.0}
mid_candle = {"begin": d(12), "close": 1.0}                   # глубина 12 дней
fresh_candle = {"begin": d(24, 17), "close": 1.0}             # последняя свеча — час назад
shallow = [mid_candle, fresh_candle]
deep = [oldest_candle, mid_candle, fresh_candle]
check(not svc._history_needs_fetch(deep, 7, NOW), "покрытие: глубокая свежая история — докачка не нужна")
check(svc._history_needs_fetch(shallow, 30, NOW),
      "покрытие: хранилище из «недели» не хватает для «месяца» -> докачка")
check(not svc._history_needs_fetch(shallow, 7, NOW),
      "покрытие: та же история достаточна для «недели»")
deep_stale = [oldest_candle, mid_candle, {"begin": d(22, 18), "close": 1.0}]   # последняя — 48 ч назад
check(svc._history_needs_fetch(deep_stale, 7, NOW),
      "покрытие: устаревший хвост (свеча двухдневной давности) -> докачка")
check(svc._history_needs_fetch([], 7, NOW), "покрытие: пустое хранилище -> докачка")

# =============================================================================
# 2. get_all_symbols_by_list — все списки, без SECTION
# =============================================================================
ws.add_symbol(TEST_LIST_A, TEST_SYM, "Тест карта A")
ws.add_symbol(TEST_LIST_A, "SECTION:Раздел")          # заголовок — не тикер
ws.add_symbol(TEST_LIST_B, TEST_SYM_CRYPTO, "Тест карта B")
ws.add_symbol(TEST_LIST_B, TEST_SYM)                   # тот же тикер во втором списке

all_syms = ws.get_all_symbols_by_list()
check(all_syms.get(TEST_LIST_A) == [TEST_SYM],
      f"состав A: только тикер, SECTION исключён (получено {all_syms.get(TEST_LIST_A)})")
check(all_syms.get(TEST_LIST_B) == [TEST_SYM_CRYPTO, TEST_SYM],
      "состав B: два тикера в порядке позиций")
check("SECTION:Раздел" not in all_syms.get(TEST_LIST_A, []),
      "SECTION-заголовок не попал в состав")

# =============================================================================
# 3. get_period_changes: TTL-кэш и устойчивость к ошибкам
# =============================================================================
# Подменяем докачку свечей счётчиком: сетевые вызовы в тест не ходят.
fetch_log = []


async def fake_ensure(symbol_full, ticker, is_binance, window_days, now):
    fetch_log.append(symbol_full)
    candles = [
        {"begin": "2026-11-24T00:00:00", "close": 110.0},
        {"begin": "2026-11-16T00:00:00", "close": 100.0},
        {"begin": "2026-11-10T00:00:00", "close": 90.0},
    ]
    return candles


orig_ensure = svc._ensure_candles
svc._ensure_candles = fake_ensure
try:
    svc.clear_cache()
    res = asyncio.run(svc.get_period_changes([TEST_SYM, TEST_SYM_CRYPTO], "week"))
    check(res.get(TEST_SYM, {}).get("changePct") == 10.0,
          f"батч week: расчёт по подменённым свечам (получено {res.get(TEST_SYM)})")
    check(res.get(TEST_SYM_CRYPTO, {}).get("changePct") == 10.0,
          "батч week: крипта считается так же")
    check(len(fetch_log) == 2, f"первый батч: докачка по разу на тикер ({len(fetch_log)})")

    # Повторный запрос — из TTL-кэша, без новой докачки
    res2 = asyncio.run(svc.get_period_changes([TEST_SYM, TEST_SYM_CRYPTO], "week"))
    check(len(fetch_log) == 2, f"повторный батч: из кэша, докачки нет ({len(fetch_log)})")
    check(res2 == res, "повторный батч: значения идентичны")

    # Другой период — отдельный ключ кэша
    asyncio.run(svc.get_period_changes([TEST_SYM], "month"))
    check(len(fetch_log) == 3, "период month: свой ключ кэша -> докачка")
    # ... но повтор month снова из кэша
    asyncio.run(svc.get_period_changes([TEST_SYM], "month"))
    check(len(fetch_log) == 3, "повтор month: из кэша")

    # Ошибка одного тикера не ломает батч
    async def broken_ensure(symbol_full, ticker, is_binance, window_days, now):
        fetch_log.append(symbol_full)
        if symbol_full == TEST_SYM_CRYPTO:
            raise RuntimeError("источник недоступен")
        return await fake_ensure(symbol_full, ticker, is_binance, window_days, now)

    svc.clear_cache()
    svc._ensure_candles = broken_ensure
    res3 = asyncio.run(svc.get_period_changes([TEST_SYM, TEST_SYM_CRYPTO], "week"))
    check("error" in res3.get(TEST_SYM_CRYPTO, {}),
          f"ошибка тикера -> его запись с error (получено {res3.get(TEST_SYM_CRYPTO)})")
    check(res3.get(TEST_SYM, {}).get("changePct") == 10.0,
          "ошибка одного тикера не ломает расчёт другого")
finally:
    svc._ensure_candles = orig_ensure
    cleanup()

# Неверный период — ValueError (endpoинт отдаёт 400)
try:
    asyncio.run(svc.get_period_changes([TEST_SYM], "year"))
    check(False, "неверный период должен давать ValueError")
except ValueError:
    check(True, "неверный период -> ValueError")

print("\nALL TESTS PASSED" if not failures else f"\n{failures} TEST(S) FAILED")
raise SystemExit(1 if failures else 0)
