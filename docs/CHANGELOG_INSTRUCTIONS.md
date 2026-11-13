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

Медіа зберігаються в B2 та ігноруються Git. Щоб відредагувати наявні файли,
завантажте їх у локальний каталог:

```bash
just download-doc-media --bucket echouastorage --only docs/releases/YYYY-MM-DD/media
```

Параметр `--bucket` обов’язковий; без нього команда покаже доступні сховища та
завершиться з помилкою. Наявні локальні файли пропускаються; `--force` замінює
їх копіями з B2.

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

Медіа публікуються в одне B2-сховище командою
`just release-doc-media --bucket echouastorage`; `--only` обирає каталог,
`--force` замінює існуючі файли. Повторіть публікацію для всіх трьох сховищ,
щоразу задаючи `AWS_ACCESS_KEY_ID` та `AWS_SECRET_ACCESS_KEY` з відповідної
нотатки Bitwarden `<bucket>-lfs backblaze`. Наприкінці команда нагадує про всі
три сховища. Публікація потребує погодження цільових B2-сховищ.
Покрокова інструкція: [завантаження вкладень документації](doc-media.md#uploading-a-documentation-attachment).
