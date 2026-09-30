# backend/services/telegram_news_service.py
import aiohttp
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
import re
import json
import asyncio

from ..database.database import get_session
from ..database.models import NewsCache

CACHE_DURATION_SECONDS = 300  # 5 минут

RU_NAMES = {
    'ROSN': ['Роснефть', 'Роснефти'],
    'SBER': ['Сбербанк', 'Сбер', 'Сбербанка'],
    'GAZP': ['Газпром', 'Газпрома', 'Газпрому'],
    'LKOH': ['Лукойл', 'Лукойла'],
    'YNDX': ['Яндекс', 'Яндекса'],
    'MGNT': ['Магнит', 'Магнита'],
    'NVTK': ['Новатэк', 'Новатэка'],
    'GMKN': ['Норникель', 'Норильский никель'],
    'CHMF': ['Северсталь', 'Северстали'],
    'NLMK': ['НЛМК'],
    'VTBR': ['ВТБ'],
    'TATN': ['Татнефть', 'Татнефти'],
    'SNGS': ['Сургутнефтегаз'],
    'ALRS': ['Алроса', 'Алросы'],
    'PHOR': ['ФосАгро'],
    'POLY': ['Полюс', 'Полюса'],
    'MTSS': ['МТС'],
    'RTKM': ['Ростелеком', 'Ростелекома'],
    'MOEX': ['Московская биржа', 'Мосбиржа', 'Мосбирже'],
    'AFLT': ['Аэрофлот', 'Аэрофлота'],
    'FIVE': ['Пятерочка', 'X5'],
    'LENT': ['Лента', 'Ленты'],
    'OZON': ['Озон', 'Озона'],
    'VKCO': ['ВК', 'ВКонтакте', 'Mail.ru'],
    'YDEX': ['Яндекс', 'Яндекса'],
    'SIBN': ['Газпром нефть', 'Газпромнефть'],
    'TRNFP': ['Транснефть', 'Транснефти'],
    'IRAO': ['Интер РАО', 'Интеррао'],
    'ENPG': ['Энел', 'Энел Россия'],
    'FEES': ['Россети', 'Россетей'],
    'HYDR': ['РусГидро', 'Русгидро'],
    'T': ['T-технологии'],
}

async def get_cached_news(ticker: str) -> list | None:
    """Получает новости из БД, если кэш еще действителен."""
    try:
        with get_session() as db:
            cache = db.query(NewsCache).filter(NewsCache.ticker == ticker).first()
            if cache:
                age = (datetime.utcnow() - cache.timestamp).total_seconds()
                if age < CACHE_DURATION_SECONDS:
                    print(f"✅ Возвращаем новости из SQLite кэша для {ticker} (осталось {int(CACHE_DURATION_SECONDS - age)} сек)")
                    return json.loads(cache.news_data)
                else:
                    print(f"⏳ Кэш устарел для {ticker}, удаляем из БД...")
                    db.delete(cache)
                    db.commit()
            return None
    except Exception as e:
        print(f"❌ Ошибка чтения кэша: {e}")
        return None

async def save_news_to_cache(ticker: str, news_data: list):
    """Сохраняет или обновляет кэш новостей в БД."""
    try:
        with get_session() as db:
            # Удаляем старую запись (UPSERT через delete + insert проще для SQLite)
            db.query(NewsCache).filter(NewsCache.ticker == ticker).delete()

            new_cache = NewsCache(
                ticker=ticker,
                news_data=json.dumps(news_data, ensure_ascii=False),
                timestamp=datetime.utcnow()
            )
            db.add(new_cache)
            db.commit()
            print(f"💾 Новости для {ticker} сохранены в SQLite кэш")
    except Exception as e:
        print(f"❌ Ошибка сохранения в кэш: {e}")

async def fetch_smartlab_telegram_news(ticker: str, max_posts: int = 1000, max_news: int = 50, force_refresh: bool = False) -> list:
    channel_username = "newssmartlab"

    # 1. Проверяем кэш (если не запрошено принудительное обновление)
    if not force_refresh:
        cached_news = await get_cached_news(ticker)
        if cached_news is not None:
            return cached_news

    search_terms = [
        f"${ticker.upper()}",
        f"#{ticker.upper()}",
        ticker.upper(),
    ]
    if ticker.upper() in RU_NAMES:
        search_terms.extend(RU_NAMES[ticker.upper()])

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }

    news_list = []
    total_checked = 0
    before_id = None
    page = 0
    last_min_id = None

    print(f"🔍 Начинаем парсинг для {ticker} (force_refresh={force_refresh})")
    print(f"📋 Ищем: {search_terms}")

    try:
        while total_checked < max_posts and len(news_list) < max_news:
            page += 1
            url = f"https://t.me/s/{channel_username}?before={before_id}" if before_id else f"https://t.me/s/{channel_username}"

            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
                async with session.get(url, headers=headers) as response:
                    if response.status != 200:
                        print(f"❌ Telegram вернул статус {response.status}")
                        break
                    html = await response.text()

            soup = BeautifulSoup(html, 'html.parser')
            messages = soup.find_all('div', class_='tgme_widget_message_wrap')

            if not messages:
                break

            page_ids = []
            for msg in messages:
                link_tag = msg.find('a', class_='tgme_widget_message_date')
                if link_tag and link_tag.get('href'):
                    match = re.search(r'/(\d+)$', link_tag['href'])
                    if match:
                        page_ids.append(int(match.group(1)))

            if not page_ids:
                break

            min_id = min(page_ids)
            if last_min_id is not None and min_id >= last_min_id:
                break
            last_min_id = min_id

            for msg in messages:
                total_checked += 1
                text_block = msg.find('div', class_='tgme_widget_message_text')
                if not text_block:
                    continue

                text = text_block.get_text(strip=True)
                text_lower = text.lower()

                found = False
                matched_term = None
                for term in search_terms:
                    if term.lower() in text_lower:
                        found = True
                        matched_term = term
                        break

                if not found:
                    continue

                pub_date = "Дата не указана"
                date_link = msg.find('a', class_='tgme_widget_message_date')
                if date_link:
                    time_tag = date_link.find('time')
                    if time_tag and time_tag.has_attr('datetime'):
                        try:
                            dt_str_clean = time_tag['datetime'].replace('Z', '+00:00')
                            dt = datetime.fromisoformat(dt_str_clean)
                            pub_date = dt.strftime('%d.%m.%Y %H:%M')
                        except Exception:
                            pub_date = time_tag.get_text(strip=True)
                    else:
                        pub_date = date_link.get_text(strip=True)

                if re.match(r'^\d{2}:\d{2}$', pub_date):
                    pub_date = f"{datetime.now().strftime('%d.%m.%Y')} {pub_date}"

                link = date_link.get('href', '') if date_link else f"https://t.me/{channel_username}"

                news_list.append({
                    "title": text[:200] + ("..." if len(text) > 200 else ""),
                    "full_text": text,
                    "publisher": "Smart-Lab News",
                    "link": link,
                    "time": pub_date
                })

                if len(news_list) >= max_news:
                    break

            before_id = min_id - 1

            if total_checked % 100 == 0 and total_checked > 0:
                await asyncio.sleep(0.1)

        print(f"\n✅ Завершено. Проверено: {total_checked}, найдено: {len(news_list)}")

        # 2. Сохраняем результат в кэш перед возвратом
        await save_news_to_cache(ticker, news_list)
        return news_list

    except Exception as e:
        print(f"❌ Ошибка парсинга: {e}")
        return news_list