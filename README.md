# Финансовый терминал

Веб-терминал для отслеживания котировок, управления watchlist и портфелем.
Аналог https://github.com/Serstakt/finance-terminal без раздела «Финансовые показатели»
и без использования Yahoo Finance (котировки: MOEX ISS API + CoinGecko).

## Стек
- **Backend:** Python 3.11+ / FastAPI
- **Frontend:** HTML5 + CSS3 + Vanilla JavaScript
- **Database:** SQLite (SQLAlchemy)

## Функционал
- **Главная** — обзор рынка (виджет TradingView, виджет Investing.com), быстрые действия
- **Watchlist** — несколько списков наблюдения (хранение в БД), разделы, drag&drop,
  сортировка по колонкам, флажки избранного, ценовые алерты (звук + уведомления),
  график TradingView по выбранному тикеру, новости Telegram (@newssmartlab),
  автообновление цен каждые 120 с, экспорт/импорт настроек
- **Портфель** — позиции (тикер/кол-во/средняя цена/сектор), расчёт P&L,
  сводная статистика, круговая диаграмма (по тикерам/секторам), столбчатая диаграмма P&L

## Источники данных
| Префикс | Источник |
|---------|----------|
| `MOEX:` | Мосбиржа ISS API (акции, облигации, индексы, валюты) |
| `BINANCE:` | CoinGecko (криптопара, например BTCUSDT) |
| без префикса | автоопределение: крипто → BINANCE, иначе → MOEX |

Yahoo Finance **не используется**.

## Установка и запуск
```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r backend/requirements.txt
python -m backend.main          # или: uvicorn backend.main:app --reload
```

Откройте http://localhost:8000
