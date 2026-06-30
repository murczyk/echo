# Локальне підключення до бази echo-pivnich-dev

Крок 1: Зміна порту PostgreSQL

В `deploy/config.toml` змінити `pg_port = 5432` на `pg_port = 6432`.

Крок 2: Створення локального SSH-тунелю

`$ just ssh-pivnich`

Аналогічно доступні:

`$ just ssh-skhid`

`$ just ssh-zp2`

`$ just ssh-staging`

Крок 3: Створення користувача

`$ cargo run --bin wdintel-rs -- --mode=debug oneoff-register-user --login="<login>" --password="<password>" --role="Admin" --sigint-zone=1 --organism-id=6`

***Примітка:** користувач видаляється щоночі з очищенням бази.*

Крок 4 (опціонально): Зменшення кількості повідомлень від `just dev-back` в терміналі

`$ cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im`

***Примітка:** команда має бути запущена перед `just dev-back` в тому ж терміналі.*

Крок 5: Запуск backend-серверу

`$ just dev-back`

***Примітка:** якщо звіти не стартують локально, запустіть окремо worker у другому терміналі: `$ just dev-bgworker`.*

Крок 6: Запуск Python

`$ just dev-py`

Крок 7: Запуск frontend-серверу

`$ just dev-front`

***Примітка:** усі команди (кроки 2-3 та 5-7) мають бути запущені в окремих терміналах, що лишаються працювати в фоновому режимі.*

## Автоматичне налаштування запуску команд в терміналах для VS Code

Крок 1: Створити файл `.vscode/tasks.json` наступного змісту:

```
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "stop-back-and-front-servers",
      "type": "shell",
      "command": "bash -lc 'set -euo pipefail; pkill -TERM -f \"cargo watch -- cargo run -- --mode=debug server\" >/dev/null 2>&1 || true; pkill -TERM -f \"elm-land server\" >/dev/null 2>&1 || true; pkill -TERM -f \"dev-py\" >/dev/null 2>&1 || true; sleep 0.4; for p in 8081 1234 5000; do fuser -k -TERM $p/tcp >/dev/null 2>&1 || true; done; sleep 0.2; for p in 8081 1234 5000; do fuser -k -KILL $p/tcp >/dev/null 2>&1 || true; done'",
      "problemMatcher": [],
      "presentation": { "panel": "new", "reveal": "always" }
    },
    {
      "label": "cleanup",
      "dependsOrder": "sequence",
      "dependsOn": ["stop-back-and-front-servers"],
      "problemMatcher": []
    },
    {
      "label": "start-db-session",
      "type": "shell",
      "command": "just ssh-pivnich",
      "problemMatcher": [],
      "presentation": { "panel": "new", "focus": true }
    },
    {
      "label": "start-back-server", // port 8081
      "type": "shell",
      "command": "just dev-back --quiet",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "wait-for-back-server", // on port 8081
      "type": "shell",
      "command": "until nc -z 127.0.0.1 8081; do sleep 0.2; done",
      "problemMatcher": []
    },
    {
      "label": "start-nlp-ml-service", // port 5000
      "type": "shell",
      "command": "just dev-py",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "wait-for-nlp-ml-service", // on port 5000
      "type": "shell",
      "command": "until nc -z 127.0.0.1 5000; do sleep 0.2; done",
      "problemMatcher": []
    },
    {
      "label": "start-front-server",
      "type": "shell",
      "command": "just dev-front",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "wait-for-front-server",
      "type": "shell",
      "command": "until nc -z 127.0.0.1 1234; do sleep 0.2; done",
      "problemMatcher": []
    },
    {
      "label": "start-dev",
      "dependsOrder": "parallel",
      "dependsOn": ["start-back-server", "start-nlp-ml-service", "start-front-server", "wait-for-back-server", "wait-for-nlp-ml-service", "wait-for-front-server"],
      "problemMatcher": []
    },
    {
      "label": "start",
      "dependsOrder": "sequence",
      "dependsOn": ["start-dev"],
      "problemMatcher": [],
      "runOptions": {
        "runOn": "folderOpen"
      }
    }
  ]
}
```

Крок 2: Упевнитись, що в системі глобально встановлені наступні утиліти: lsof, fuser, nc

Якщо ні, встановити їх: `$ npm i -g <util>`

Крок 3: Перезапустити VS Code (Shift + Command + P > Developer: Reload Window)

Крок 4: Погодитись на автоматичний запуск задач при запуску VS Code (застосунок спитає дозвіл при запуску)

Якщо запит пропущено: Shift + Command + P > Tasks: Manage Automatic Tasks in Folder > Allow Automatic Tasks
