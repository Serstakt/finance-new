"""Проверка поиска инструментов для автодополнения (services/symbol_search_service.py).

Покрывает (БЕЗ сети — сырые ответы ISS/Binance подменяются фиксатурами):
  * разбор /iss/securities.json: фильтр групп (только акции TQBR, валюты CETS,
    известные индексы; облигации и прочие индексы отбрасываются), is_traded,
    дедупликация по SECID;
  * релевантность: точный тикер > начало тикера > вхождение в тикер >
    начало названия > вхождение в название; совпадения только по ISIN/REGNUMBER
    не попадают в выдачу;
  * статические индексы (IMOEX и др.), которых в ISS-поиске нет;
  * ранжирование пар Binance: одна строка на монету (дедупликация по базовому
    активу с приоритетом USDT-квот), статус TRADING;
  * слияние MOEX + крипта по оценке (MOEX первее при равной) и формат ответа.
"""
import asyncio

from backend.services import symbol_search_service as svc

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


# --- Фикстура: сырой ответ ISS /securities.json (структура реального API) ----
def iss_row(secid, shortname, name, group, is_traded=1,
            primary="TQBR", market_board="TQBR", isin=None):
    return [secid, shortname, None, name, isin, is_traded, None, None, None,
            None, "common_share", group, primary, market_board]


ISS_COLUMNS = ["secid", "shortname", "regnumber", "name", "isin", "is_traded",
               "emitent_id", "emitent_title", "emitent_inn", "emitent_okpo",
               "type", "group", "primary_boardid", "marketprice_boardid"]


def iss_response(rows):
    return {"securities": {"columns": ISS_COLUMNS, "data": rows}}


# --- 1. Разбор ISS: фильтры групп и досок ------------------------------------
data = iss_response([
    iss_row("SBER", "Сбербанк", "Сбербанк России ПАО ао", "stock_shares"),
    iss_row("SBERP", "Сбербанк-п", "Сбербанк России ПАО ап", "stock_shares"),
    # облигация — терминал не умеет её показывать (цена только с доски TQBR)
    iss_row("RU000A10DS74", "Сбер Sb51R", "Сбербанк ПАО 001Р-SBER51", "stock_bonds"),
    # акция не с TQBR (например, иностранный сектор) — отбрасывается
    iss_row("BA", "Boeing", "Boeing Co", "stock_shares", market_board="TQIR"),
    # не торгуемая бумага — отбрасывается
    iss_row("SBEROLD", "Сбер старый", "Сбер старый ПАО", "stock_shares", is_traded=0),
    # валюта CETS — остаётся
    iss_row("USD000UTSTOM", "USDRUB_TOM", "Доллар США", "currency_selt",
            primary="CETS", market_board="CETS"),
    # валюта без 'RUB' и не из явного списка fetch_moex_price — ушла бы в
    # акции TQBR и упала на валидации цены: не подсказывается
    iss_row("USD000000TOD", "USDRUB_TOD", "Доллар США TOD", "currency_selt",
            primary="CETS", market_board="CETS"),
])
items = svc._parse_moex_securities(data, "SBER")
secids = [i["ticker"] for i in items]
check("SBER" in secids and "SBERP" in secids, f"Акции TQBR найдены: {secids}")
check("RU000A10DS74" not in secids, "Облигации (stock_bonds) не попадают в подсказки")
check("BA" not in secids, "Акции не с рыночной доской TQBR отбрасываются")
check("SBEROLD" not in secids, "is_traded=0 отбрасывается")
check("USD000UTSTOM" not in secids, "Валюты не появляются в выдаче по запросу 'SBER'")

cur = svc._parse_moex_securities(data, "USD")
cur_tickers = [i["ticker"] for i in cur]
check(cur and cur[0]["ticker"] == "USD000UTSTOM" and cur[0]["type"] == "currency",
      f"Валютная подсказка по 'USD' с типом currency: {cur_tickers}")
check("USD000000TOD" not in cur_tickers,
      "Валютные коды без 'RUB' (TOD/TOM-варианты) не подсказываются — цена по ним не берётся")

# --- 2. Дедупликация по SECID (ISS отдаёт бумагу с нескольких досок) ---------
dup = iss_response([
    iss_row("GAZA", "ГазА", "ГазА ПАО", "stock_shares"),
    iss_row("GAZA", "ГазА", "ГазА ПАО", "stock_shares", primary="TQBF", market_board="TQBF"),
])
dup_items = svc._parse_moex_securities(dup, "GAZA")
check(len(dup_items) == 1, f"Одна бумага с двух досок — одна подсказка (получено {len(dup_items)})")

# --- 3. Релевантность ---------------------------------------------------------
ranked = svc._parse_moex_securities(iss_response([
    iss_row("SBER", "Сбербанк", "Сбербанк России ПАО ао", "stock_shares"),
    iss_row("SBERP", "Сбербанк-п", "Сбербанк России ПАО ап", "stock_shares"),
]), "SBER")
check(ranked[0]["ticker"] == "SBER" and ranked[1]["ticker"] == "SBERP",
      f"Точный тикер выше начала тикера: {[i['ticker'] for i in ranked]}")

# Название: по подстроке находим бумагу с другим тикером («ЛЕТ» — не начало
# названия, поэтому оценка 4 — вхождение, не startswith)
name_hit = svc._parse_moex_securities(iss_response([
    iss_row("SMLT", "Самолет", "Самолет ПАО", "stock_shares"),
]), "ЛЕТ")
check(len(name_hit) == 1 and name_hit[0]["score"] == 4,
      f"Подстрока в названии находит бумагу с оценкой 4: {name_hit}")

# Совпадение только по ISIN/REGNUMBER (не тикер/название) в подсказки не попадает:
# пользователь, набравший «SBER», ожидает бумаги с SBER в коде/имени
isin_only = svc._parse_moex_securities(iss_response([
    iss_row("XYZQ", "Ромашка", "Ромашка ПАО", "stock_shares", isin="RU000SBERXXX"),
]), "SBER")
check(isin_only == [], "Совпадение только по ISIN не показывается")

# --- 4. Статические индексы ----------------------------------------------------
idx = svc._parse_moex_securities(iss_response([]), "IMOEX")
check(len(idx) == 1 and idx[0]["ticker"] == "IMOEX" and idx[0]["type"] == "index"
      and idx[0]["symbol"] == "MOEX:IMOEX",
      f"Индекс IMOEX отдаётся статическим списком: {idx}")
idx_none = svc._parse_moex_securities(iss_response([]), "SP500")
check(idx_none == [], "Неизвестный индекс не подсказывается (цены по нему не взять)")

# --- 5. Ранжирование пар Binance ----------------------------------------------
pairs = {
    "BTCUSDT": ("BTC", "USDT"), "BTCUSDC": ("BTC", "USDC"), "BTCBTC": ("BTC", "BTC"),
    "BTCUPUSDT": ("BTCUP", "USDT"), "BTCUPUSDC": ("BTCUP", "USDC"),
    "BTCUSDT_240628": ("BTC", "USDT"),  # доставочная пара с тем же base
    "ETHBTC": ("ETH", "BTC"), "ETHUSDT": ("ETH", "USDT"),
    "BTCUSDTRY": ("BTCUSD", "TRY"),  # startswith BTC в base-символе пары
}
top = svc._rank_binance_pairs(pairs, "BTC", 8)
bases = [b for _, b in top]
# ETHBTC (BTC — лишь квота) не подсказывается по запросу «btc» — иначе
# выдача заваливается парами вида ADABTC/AVAXBTC
check(bases == ["BTC", "BTCUP", "BTCUSD"], f"Одна строка на монету, точная база первой: {top}")
check(top[0] == ("BTCUSDT", "BTC"), f"USDT-квота приоритетнее USDC/BTC: {top[0]}")
# Точный код экзотической пары пользователь вводит осознанно — показываем
exact_exotic = svc._rank_binance_pairs(pairs, "ETHBTC", 8)
check(exact_exotic and exact_exotic[0] == ("ETHBTC", "ETH"),
      f"Точный код пары с экзотической квотой находится: {exact_exotic}")
check("BTCUSDT_240628" not in [s for s, _ in top], "Доставочные пары отсекаются дедупликацией по base")

# --- 6. Слияние источников: score -> порядок, MOEX первее при равной ----------
moex_item = {"symbol": "MOEX:SBER", "ticker": "SBER", "name": "Сбербанк",
             "type": "stock", "exchange": "MOEX", "logo": None, "score": 0}
crypto_item = {"symbol": "BINANCE:BTCUSDT", "ticker": "BTCUSDT", "name": "Bitcoin",
               "type": "crypto", "exchange": "BINANCE",
               "logo": "https://example.com/btc.png", "score": 0.0}
merged_src = [moex_item, crypto_item]
merged = sorted(merged_src, key=lambda r: (r["score"], 0 if r["exchange"] == "MOEX" else 1, r["ticker"]))
check(merged[0]["ticker"] == "SBER", "При равной оценке MOEX стоит выше крипты")
for r in merged:
    r.pop("score", None)
check(all("score" not in r for r in merged), "score не утекает в ответ фронтенду")
check(set(merged[1].keys()) == {"symbol", "ticker", "name", "type", "exchange", "logo"},
      f"Формат подсказки: {sorted(merged[1].keys())}")

# --- 7. Короткий запрос — пустая выдача без обращений -------------------------
short = asyncio.run(svc.search_symbols("S"))
check(short == {"results": []}, "Запрос из 1 символа не порождает поиск")

print("\nALL TESTS PASSED" if not failures else f"\n{failures} TEST(S) FAILED")
raise SystemExit(1 if failures else 0)
