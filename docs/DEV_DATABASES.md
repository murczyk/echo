# Локальне підключення до бази echo-pivnich-dev

Крок 1: Зміна порту PostgreSQL

В `deploy/config.toml` змінити `pg_port = 5432` на `pg_port = 6432`.

Крок 2: Створення локального SSH-тунелю

`$ ssh -nNT -L 6432:localhost:5432 echo-pivnich-dev`

Крок 3: Запуск клієнту PostgreSQL і підключення до бази даних

`$ PGPASSWORD=fee_-_-_-FnoeKFBeebu87bf psql -U wd -h 127.0.0.1 -p 6432 wd`

Крок 4: Створення користувача

`$ cargo run --bin wdintel-rs -- --mode=debug oneoff-register-user --login="<login>" --password="<password>" --role="Admin" --sigint-zone=1 --organism-id=6`

***Примітка:** користувач видаляється щоночі з очищенням бази.*

Крок 5 (опціонально): Зменшення кількості повідомлень від `just dev-back` в терміналі

`$ cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im ()`

***Примітка:** команда має бути запущена перед `just dev-back` в тому ж терміналі.*

Крок 6: Запуск backend-серверу

`$ just dev-back`

Крок 7: Запуск Python

`$ just dev-py`

Крок 8: Запуск frontend-серверу

`$ just dev-front`

***Примітка:** усі команди (кроки 2-4 та 6-8) мають бути запущені в окремомих терміналах, що лишаються працювати в фоновому режимі.*

## Автоматичне налаштування запуску команд в терміналах для VS Code

Крок 1: Створити файл `.vscode/tasks.json` наступного змісту:

```
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "SSH tunnel 6432->5432",
      "type": "shell",
      "command": "ssh -f -nNT -L 6432:localhost:5432 -o ExitOnForwardFailure=yes echo-pivnich-dev",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new", "reveal": "always" }
    },
    {
      "label": "Wait for tunnel :6432",
      "type": "shell",
      "command": "until nc -z 127.0.0.1 6432; do sleep 0.2; done",
      "problemMatcher": []
    },
    {
      "label": "psql (interactive via :6432)",
      "type": "shell",
      "command": "PGPASSWORD=fee_-_-_-FnoeKFBeebu87bf psql -U wd -h 127.0.0.1 -p 6432 wd",
      "problemMatcher": [],
      "presentation": { "panel": "new", "focus": true }
    },
    {
      "label": "Dev server",
      "type": "shell",
      "command": "just dev-back",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "Python",
      "type": "shell",
      "command": "just dev-py",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "Front server",
      "type": "shell",
      "command": "just dev-front",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "Start apps (parallel)",
      "dependsOrder": "parallel",
      "dependsOn": ["psql (interactive via :6432)", "Dev server", "Python", "Front server"],
      "problemMatcher": []
    },
    {
      "label": "Start everything",
      "dependsOrder": "sequence",
      "dependsOn": ["SSH tunnel 6432->5432", "Wait for tunnel :6432", "Start apps (parallel)"],
      "problemMatcher": [],
      "runOptions": {
        "runOn": "folderOpen"
      }
    }
  ]
}
```

Крок 2: Перезапустити VS Code (Shift + Command + P > Developer: Reload Window)

Крок 3: Погодитись на автоматичний запуск задач при запуску VS Code (застосунок спитає дозвіл при запуску)
