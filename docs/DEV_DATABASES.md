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

`$ cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im`

***Примітка:** команда має бути запущена перед `just dev-back` в тому ж терміналі.*

Крок 6: Запуск backend-серверу

`$ just dev-back`

Крок 7: Запуск Python

`$ just dev-py`

Крок 8: Запуск frontend-серверу

`$ just dev-front`

***Примітка:** усі команди (кроки 2-4 та 6-8) мають бути запущені в окремих терміналах, що лишаються працювати в фоновому режимі.*

## Автоматичне налаштування запуску команд в терміналах для VS Code

Крок 1: Створити файл `.vscode/tasks.json` наступного змісту:

```
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "stop-ssh-tunnel",
      "type": "shell",
      "command": "ssh -S .vscode/pg-tunnel.sock -O exit echo-pivnich-dev || true",
      "problemMatcher": [],
      "presentation": { "panel": "new", "reveal": "always" }
    },
    {
      "label": "stop-nlp-ml-service",
      "type": "shell",
      "command": "bash -lc 'set -e; PIDS=$(lsof -tiTCP:5000 -sTCP:LISTEN 2>/dev/null || true); if [ -z \"$PIDS\" ]; then echo \"Flask:5000 already stopped\"; exit 0; fi; echo \"Stopping :5000 pids: $PIDS\"; kill -TERM $PIDS || true; for i in {1..25}; do sleep 0.2; PIDS=$(lsof -tiTCP:5000 -sTCP:LISTEN 2>/dev/null || true); [ -z \"$PIDS\" ] && { echo \"Stopped\"; exit 0; }; done; echo \"Escalating to SIGKILL\"; PIDS=$(lsof -tiTCP:5000 -sTCP:LISTEN 2>/dev/null || true); [ -n \"$PIDS\" ] && kill -KILL $PIDS || true; sleep 0.2; PIDS=$(lsof -tiTCP:5000 -sTCP:LISTEN 2>/dev/null || true); [ -n \"$PIDS\" ] && { echo \"ERROR: still listening: $PIDS\"; exit 1; } || echo \"Stopped\"'",
      "problemMatcher": [],
      "presentation": { "panel": "new", "reveal": "always" }
    },
    {
      "label": "stop-back-and-front-servers",
      "type": "shell",
      "command": "bash -lc 'for p in 8081 1234; do fuser -k $p/tcp 2>/dev/null || true; done'",
      "problemMatcher": [],
      "presentation": { "panel": "new", "reveal": "always" }
    },
    {
      "label": "cleanup",
      "dependsOrder": "sequence",
      "dependsOn": ["stop-ssh-tunnel", "stop-nlp-ml-service", "stop-back-and-front-servers"],
      "problemMatcher": []
    },
    {
      "label": "open-ssh-tunnel", // port 6432 to 5432
      "type": "shell",
      "command": "bash -lc 'mkdir -p .vscode; if nc -z 127.0.0.1 6432; then echo \"Tunnel already up on :6432\"; else ssh -f -nNT -M -S .vscode/pg-tunnel.sock -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 6432:localhost:5432 echo-pivnich-dev; fi'",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new", "reveal": "always" }
    },
    {
      "label": "wait-for-ssh-tunnel", // on port 6432
      "type": "shell",
      "command": "until nc -z 127.0.0.1 6432; do sleep 0.2; done",
      "problemMatcher": []
    },
    {
      "label": "start-db-session", // via port 6432
      "type": "shell",
      "command": "PGPASSWORD=fee_-_-_-FnoeKFBeebu87bf psql -U wd -h 127.0.0.1 -p 6432 wd",
      "problemMatcher": [],
      "presentation": { "panel": "new", "focus": true }
    },
    {
      "label": "start-back-server", // port 8081
      "type": "shell",
      "command": "just dev-back",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
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
      "label": "start-front-server", // port 1234
      "type": "shell",
      "command": "just dev-front",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "panel": "new" }
    },
    {
      "label": "start-dev",
      "dependsOrder": "parallel",
      "dependsOn": ["start-db-session", "start-back-server", "start-nlp-ml-service", "start-front-server"],
      "problemMatcher": []
    },
    {
      "label": "start",
      "dependsOrder": "sequence",
      "dependsOn": ["open-ssh-tunnel", "wait-for-ssh-tunnel", "start-dev"],
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
