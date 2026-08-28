## Перелік месенджерів

- [gdocs: ЕХО](https://docs.google.com/spreadsheets/d/17mDPD0OM6HjXteMElScK0sT6jiOyS6C2Ic3i62NBRds/edit?gid=0#gid=0)

## Адміністрування чатів

Вкладка `Чати` з'являється першою, якщо принаймні один активний
`echo_client` має `show_chats_admin_panel = true`. Налаштування зберігаються по
одному запису на клієнта в `echo_client_settings`. Для приватних чатів і груп
можна окремо вибрати allowlist або denylist; ідентичність приватного контакту
та групи завжди включає акаунт месенджера.

Прапорець `Зберігати дані 30 днів` зберігає переглянуті вхідні, усі
вхідні/вихідні повідомлення та відправлені медіа протягом 30 днів. Збереження
перезапускає воркер конкретного клієнта. Якщо перезапуск не вдався,
налаштування вже збережені, а повторне натискання `Зберегти` безпечно повторює
перезапуск.

Непрочитані ID зберігаються в Redis у версіонованих ключах з timestamp
останнього прив'язування акаунта. При недоступному Redis історія з PostgreSQL
працює, але UI показує деградацію лічильників і не приховує помилку позначення
прочитаним. Воркери автоматично перепідключаються й відтворюють ingestion з
PostgreSQL watermark; видалені retention-воркером ID періодично очищаються з
Redis.

Webhook отримує `version: 1`, стабільний `eventId`, непрозорий `chatId` і той
самий DTO повідомлення, що й API історії. У payload є метадані вкладень та
авторизовані URL, але немає байтів/base64 вкладень. Відповіді не 2xx і мережеві
помилки повторюються з обмеженим exponential backoff; після восьмої невдалої
спроби запис отримує `failed_at`. Webhook має використовувати HTTPS без
облікових даних і резолвитися лише в публічні IP-адреси; перевірений DNS
закріплюється на час запиту, редіректи заборонені. URL webhook не потрапляють у
логи й не повертаються API.

Топологія: `echo-messengers.service` читає PostgreSQL, використовує локальний
`redis-server`, диспетчеризує webhook і пише вихідні вкладення в
`/var/lib/echo-messengers/chat-attachments`. Пакет створює каталог, а systemd
впорядковує запуск після Redis без жорсткої залежності від його доступності.

Діагностика:

```bash
redis-cli ping
sudo systemctl status redis-server echo-messengers --no-pager
sudo journalctl -u echo-messengers -n 200 --no-pager
sudo -u postgres psql -d wd -c "select id, attempts, next_attempt_at, delivered_at, failed_at, last_error from echo_chat_webhook_delivery order by id desc limit 50;"
```

## Черга обробки

Отримання повідомлень і їх обробка працюють окремо. Вхідні знімки надійно
зберігаються в `signal_message_queue`. Перед обробкою воркер перевіряє
`http://127.0.0.1:5000/health/ready`: протягом першої хвилини — кожні 2 секунди,
далі — кожні 30 секунд. Недоступність NLP не зупиняє отримання повідомлень або
інші фонові воркери.

Невдала обробка записує `attempt_count`, `next_attempt_at` і скорочений
`last_error`. Інтервали повторів: 5 с, 15 с, 1 хв, 5 хв, 15 хв, далі 30 хв.
Оновлений знімок повідомлення скидає цей стан. Рядки не видаляються через
вичерпання спроб.

Для швидкої перевірки відставання:

```sql
select
    count(*) as depth,
    count(*) filter (
        where next_attempt_at <= now() at time zone 'utc'
    ) as due_depth,
    max(attempt_count) as max_attempt_count,
    min(created_at) as oldest_created_at
from signal_message_queue;
```
  
## Діагностування 

З таблиць ECHO-IM отримуємо інформацію про параметри підключення джерела

- таблички echo im
    - datasource
    - echo_client_lock
    - echo_client_config
        - порт
        - назва воркера systemd
        - папка з атачментами

```sql
select
    cl.id as client_lock_id,
	cl.client_id,
	cc.process_name,
	cc.signal_api_attachment_path,
    cc.signal_port,
	ea.phone_number,
	ea.is_linked,
    ea.id as echo_account_id, 
    ea.source as echo_account_source
from
    echo_client_lock cl
left join echo_client_config cc on
    cl.client_id = cc.client_id
left join echo_account ea on cl.account_id=ea.id
where
    cl.id = 7 -- client_lock_id з таблиці datasource
```

- signal cli rest api діагностика:
    - `curl http://localhost:8010/v1/accounts ; echo`
        - глянути чи прив'язаний акаунт
    - `journalctl -u echo-signal-bot@pivnich-signal -f`
        - глянути чи показує банер з ендпойнтами -- значить вбивається
- перевірити `echo_account.is_linked=true`

## Прив'язка

- чистимо в середині папок data та attachments
```
root@echo-pivnich:/etc/echo/signal-cli-data/pivnich-signal/signal-cli# rm -rf ./data/*
root@echo-pivnich:/etc/echo/signal-cli-data/pivnich-signal/signal-cli# rm -rf ./attachments/*
```
- генеруємо QR-код для прив'язки та скануємо його потрібним пристроєм
    - зараз:
        - `ssh -nNT -L 8012:localhost:8012 echo-pivnich`
        - відкриваємо http://localhost:8012/v1/qrcodelink?device_name=pivnich-signal-5nov25
        - перевірити `echo_account.is_linked=true`
    - майбутнє: веб інтерфейс

### Troubleshoot відставання СХІД 14NOV25

```sql
select max(sm.timestamp), g.id, g.name from signal_message sm inner join datasource_group g on sm.datasource_group_id = g.id where sm.created_at > '2025-11-12 10:00' and sm.datasource_group_id in (select id from datasource_group where datasource_id = 4) group by g.id, g.name;
```

- `echo_whatsapp_queue -> echo_inbox_message -> signal_message`

- альтернативно ехо схід:

```
wd=# select max(created_at),account_id from echo_inbox_message group by account_id;
            max             | account_id
----------------------------+------------
 2026-02-03 17:25:42.078617 |         26
 2026-02-03 17:29:38.258668 |         25
 2026-02-03 17:29:54.641973 |         23
 2026-02-03 17:29:50.959153 |         22
 2026-02-03 17:29:07.176077 |         24
(5 rows)
```

### Troubleshoot відставання Донецьк 5NOV25

Остання група де в сигнал шось прилітало:
```sql
select name from echo_group where id in (select group_id from echo_inbox_message where account_id = 1 order by created_at desc limit 1);
```

Перевірити групу Ether 7:
```sql
select max(created_at) from signal_message where datasource_group_id in (select id from datasource_group where group_master_key in (select master_key from signal_group where name ilike 'Ether 7')) and created_at > '2025-11-03';
```

### Troubleshoot 5NOV25

- знаходимо echo_client_lock.id=15, client_id=10
- прив'язка

**другий**

- echo_client_lock_id=7, client_id=7, account_id=6
    - echo-signal-bot@pivnich-signal
    - /etc/echo/signal-cli-data/pivnich-signal/signal-cli/attachments/
    - 8010

- [ ] сержант моніторинг задокументувати
- [ ] **p1** todo: чому нема нотифікації коли від'їбнув сигнал
