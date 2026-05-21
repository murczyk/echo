# Changelog: коротка інструкція додавання релізу

Оновлення релізу складається з 3 файлів:

- `CHANGELOG.md`
- `docs/releases/YYYY-MM-DD/release.md`
- `docs/releases/index.json`

## 1) Додайте запис у `CHANGELOG.md`

Додавайте нові рядки тільки в секцію `## NEXT`.

Формат:

```md
- [#1234](https://github.com/echoua/echo/issues/1234) ✅ Короткий опис зміни для користувача.
```

## 2) Створіть реліз у `docs/releases/YYYY-MM-DD/`

Створіть файл `docs/releases/YYYY-MM-DD/release.md`.

Мінімальний шаблон:

```md
# Реліз YYYY-MM-DD

## Назва зміни

Короткий опис для користувача.
```

Якщо є медіа — кладіть у `docs/releases/YYYY-MM-DD/media/` і вставляйте в `release.md`:

- `![alt](media/file.png)`
- `{{ video(id="media/file.webm") }}`

## 3) Оновіть `docs/releases/index.json`

Додайте новий реліз у верх списку:

```json
{
  "release_id": "YYYY-MM-DD",
  "title": "YYYY-MM-DD"
}
```

## 4) Перевірка

```bash
just build-front
```

На `/updates` має бути видно новий реліз, текст і медіа.
