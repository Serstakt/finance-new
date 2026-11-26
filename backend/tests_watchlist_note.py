"""Проверка хранения заметок watchlist (вкладка «Заметки», редактор Quill 2).

Заметка теперь может содержать безопасный HTML: заголовки, инлайн-форматы,
списки (li[data-list]), выравнивание (class="ql-align-*") и цвет (style).
Сервер обязан:
  • сохранять разрешённую разметку (форматирование переживает перезагрузку);
  • вырезать скрипты/картинки/опасные ссылки и произвольные классы/стили;
  • не ограничивать длину заметки (сохраняется весь текст);
  • совместимо принимать старые заметки простым текстом.

Запуск: python -m backend.tests_watchlist_note
"""
from backend.services.watchlist_service import normalize_note

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


# 1. Старый plain text: пробелы схлопываются, сущности декодируются.
check(normalize_note("  газпрос\n\nхороший  отчёт ") == "газпрос хороший отчёт",
      "plain text: пробелы схлопываются, переводы строк сохраняются как пробел")
check(normalize_note("a &amp; b") == "a & b",
      "plain text: HTML-сущности декодируются")
check(normalize_note("   ") is None, "пустая строка заметки -> None")
check(normalize_note(None) is None, "None заметки -> None")

# 2. Разметка Quill сохраняется.
html = (
    '<h1>Идея</h1>'
    '<p class="ql-align-center"><strong>Жирный</strong> и <em>курсив</em></p>'
    '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Пункт</li></ol>'
    '<p><span style="color: rgb(255, 107, 107);">красный</span></p>'
)
saved = normalize_note(html)
check("<h1>Идея</h1>" in saved, "заголовок сохраняется")
check('<strong>Жирный</strong>' in saved and "<em>курсив</em>" in saved,
      "жирный/курсив сохраняются")
check('class="ql-align-center"' in saved, "выравнивание Quill сохраняется")
check('<li data-list="bullet">' in saved, "маркированный список сохраняется")
check("ql-ui" not in saved, "служебный span.ql-ui не попадает в БД")
check('style="color: rgb(255, 107, 107)' in saved, "цвет текста сохраняется")

# 3. Опасная разметка вырезается.
xss = (
    '<p>safe</p>'
    '<script>alert(1)</script>'
    '<img src=x onerror=alert(1)>'
    '<a href="javascript:alert(1)">bad link</a>'
    '<p style="background:url(javascript:alert(1)); color: red">styled</p>'
    '<p class="ql-align-center evil-class">ok</p>'
)
xss_saved = normalize_note(xss)
check("<script" not in xss_saved.lower() and "<img" not in xss_saved.lower(),
      "script/img вырезаются")
check("javascript:" not in xss_saved.lower(), "javascript:-ссылки и url() в style вырезаются")
check("evil-class" not in xss_saved, "произвольные классы вырезаются")
check('class="ql-align-center"' in xss_saved, "разрешённые ql-классы остаются")
check("safe" in xss_saved and "ok" in xss_saved, "безопасный текст не теряется")

# 4. Ссылки: только http(s)/mailto/tel, с безопасными target/rel.
link_saved = normalize_note('<p><a href="https://example.com">ссылка</a></p>')
check('href="https://example.com"' in link_saved
      and 'rel="noopener noreferrer"' in link_saved
      and 'target="_blank"' in link_saved,
      "безопасная ссылка получает target=_blank и rel=noopener")

# 5. Пустая разметка (одни теги) -> None.
check(normalize_note("<p><br></p>") is None, "разметка без видимого текста -> None")

# 6. Длина не ограничивается: длинная заметка сохраняется целиком.
long_text = "я" * 1500
long_saved = normalize_note(f"<p>{long_text}</p>")
check(long_text in long_saved, "длинная заметка сохраняется целиком (лимита нет)")
check(long_saved.startswith("<p>") and long_saved.endswith("</p>"),
      "длинная заметка остаётся валидным HTML")

print(f"\n{'FAILED: ' + str(failures) if failures else 'ALL TESTS PASSED'}")
raise SystemExit(1 if failures else 0)
