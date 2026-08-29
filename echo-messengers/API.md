# WhatsApp API (обгортка над [wwebjs](https://wwebjs.dev/))

`WHATS_APP_HOST` — адреса віддаленого сервера WhatsApp, вказана в налаштуваннях ГОІ (наприклад `http://localhost:4002`).

## GET `{WHATS_APP_HOST}/api/whatsapp/qrcode`

**Response:**

```ts
{
  user: string | null;
}
```

Має повертати номер телефону в полі `user`.

## GET `{WHATS_APP_HOST}/api/whatsapp/health`

**Response:**

```ts
{
  error?: string
  client?: any
}
```

Якщо повертає `error` або порожній `client`, вважається, що сервер недоступний.

## GET `{WHATS_APP_HOST}/api/whatsapp/groups?refresh=true&includeChats=true`

**Response:**

```ts
{
  id: string
  name: string
  isGroup?: boolean
}[]
```

Повертає масив груп поточного користувача.

Параметри (обидва опціональні):

- `?refresh=true` — передається, коли користувач вручну ініціює оновлення списку груп.
- `?includeChats=true` — окрім груп, включає у відповідь також приватні чати. У цьому режимі поле `isGroup` дозволяє відрізнити групу (`true`) від звичайного чату 1-на-1 (`false` або відсутнє).

## POST `{WHATS_APP_HOST}/api/whatsapp/send`

**Request body:**

```ts
{
  groupId: string
  message: string
  screenshot?: string // PNG data URL (наприклад "data:image/png;base64,...")
}
```

**Response:** статус `2xx` у випадку успіху; інакше вважається помилкою відправки.

Надсилає текстове повідомлення `message` у групу WhatsApp із вказаним `groupId`. Опціонально приймає поле `screenshot` — зображення у вигляді PNG data URL, яке буде прикріплене до повідомлення.

# Signal API (обгортка над [signal-rest-api](https://github.com/bbernhard/signal-cli-rest-api))

`SIGNAL_APP_HOST` — адреса віддаленого сервера Signal, вказана в налаштуваннях ГОІ (наприклад `http://localhost:4002`).

## GET `{SIGNAL_APP_HOST}/api/signal/health`

**Response:** статус `200` якщо сервер доступний; будь-який інший код вважається ознакою того, що сервер недоступний. Тіло відповіді не використовується.

## GET `{SIGNAL_APP_HOST}/api/signal/accounts`

**Response:**

```ts
string[] | { error: string }
```

Має повертати помилку або список номерів користувачів. ГОІ буде використовувати лише перший номер з тих що повернулися

## GET `{SIGNAL_APP_HOST}/api/signal/groups/${phone}?refresh=true`

**Response:**

```ts
{
  ids: {
    internalId: string
    groupId: string
  }
  name: string
  isGroup?: boolean
}[] | { error: string }
```

Повертає масив груп поточного користувача, або об'єкт `{ error }` у випадку помилки (ГОІ викине помилку із цим повідомленням).

Параметр `?refresh=true` опціональний і передається, коли користувач вручну ініціює оновлення списку груп.

`ids` містить звичайний та внутрішній айді групи відповідно до того, що повертає `signal-rest-api`. Поле `isGroup` дозволяє відрізнити групу (`true`) від звичайного чату 1-на-1 (`false` або відсутнє).

## POST `{SIGNAL_APP_HOST}/api/signal/send`

**Request body:**

```ts
{
  recipients: string[] // номер телефону або groupId одержувача(ів)
  number: string // номер відправника (один з акаунтів /api/signal/accounts)
  message: string
  base64_attachments?: string[] // масив data URL зображень/файлів
}
```

**Response:** статус `200`, `201` або `400` вважається успіхом; будь-який інший код — помилкою відправки.

Надсилає повідомлення `message` від імені `number` кожному з `recipients`. ГОІ викликає цей ендпоінт окремо для кожного одержувача (по одному `recipient` у масиві за раз). Поле `base64_attachments` опціональне — приймає масив data URL для прикріплення зображень або файлів до повідомлення.

Має бути присутнє хоча б одне з полів `message` або `base64_attachments`.
