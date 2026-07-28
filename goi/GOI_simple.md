# Як створити новий GOI-сервер (проста інструкція)

Ця інструкція показує, як покроково створити новий GOI-сервер (контейнер) для клієнта. Написано простою мовою — не потрібно бути технічним спеціалістом, головне виконувати кроки по порядку.

> 📋 Черга розгортання ведеться в [Google-таблиці](https://docs.google.com/spreadsheets/d/1o24HbY8i7PG0Y0ZAXU47iGuU67Q4LIwpj99FxCLCJ5I). З неї беремо наступний сервер на чергу, і в неї ж наприкінці вносимо результат (URL, доступи тощо).

---

## Що відбувається "під капотом" (для розуміння)

На сервері `echo-gpu-hammer` є один "еталонний" контейнер (шаблон) — `goi-stg`. Коли потрібен новий GOI для клієнта, ми робимо **копію** цього шаблону та трохи його налаштовуємо.

---

## Крок 0. Що підготувати заздалегідь

- Доступ до Tailscale-акаунту **echo-goi@outlook.com** (адмінка: https://console.tailscale.com, домен мережі: `chimp-tiaki.ts.net` проєкту).
- Доступ по SSH до сервера `echo-gpu-hammer`.
- Доступ до репозиторію [echo-sergeant](https://github.com/echoua/echo-sergeant) (там зберігається файл `ssh/config`).

---

## Крок 1. Увійти в Tailscale і отримати ключ

1. Відкрийте https://console.tailscale.com і увійдіть під акаунтом **echo-goi@outlook.com**.
2. Переконайтеся, що в налаштуваннях увімкнено **HTTPS (SSL-сертифікати)**.
3. Натисніть **Add device → Linux server** і скопіюйте виданий **auth key** (виглядає як `tskey-auth-...`). Він знадобиться в наступному кроці.

---

## Крок 2. Підготувати назви для нового сервера

Придумайте назву нового сервера (наприклад, `goi-159ombr` або `goi-prod-01`) і запишіть чотири значення — вони знадобляться для команди клонування:

```bash
TS_KEY=tskey-auth-kB...7y          # ключ з Кроку 1
MACHINE=goi-159ombr                # назва нового сервера (придумайте самі)
DOMAIN=goi-159ombr.eagle-atria.ts.net   # адреса нового сервера в Tailscale
TEMPLATE=goi-stg                   # шаблон, з якого копіюємо (завжди однаковий)
```

---

## Крок 3. Зайти на сервер і запустити клонування

1. Підключіться по SSH до сервера з Incus:

```bash
ssh echo-gpu-hammer
```

2. Вставте туди ті самі 4 значення з Кроку 2 (`TS_KEY`, `MACHINE`, `DOMAIN`, `TEMPLATE`).
    
3. Скопіюйте та виконайте команду клонування повністю:
    

```bash
incus delete -f "$MACHINE" >/dev/null 2>&1 || true
echo-install-utils incus-clone --tailscale "$TS_KEY" --clear-all -- "$TEMPLATE" "$MACHINE"

incus exec "$MACHINE" -- mkdir -p /var/tmp/goi-dev-container
for f in goi-dev-post-clone.sh goi.service goi-npm-start.sh goi-renew-tailscale-cert.sh goi-renew-tailscale-cert.service goi-renew-tailscale-cert.timer; do
  incus file push "$HOME/workspace/goi-container/deploy/goi-dev-container/$f" "$MACHINE/var/tmp/goi-dev-container/$f"
done

incus exec "$MACHINE" -- /var/tmp/goi-dev-container/goi-dev-post-clone.sh \
  --ts-key "$TS_KEY" \
  --machine "$MACHINE" \
  --domain "$DOMAIN"
```

Ця команда сама:

- створює копію шаблону;
- виставляє правильний часовий пояс (Київ);
- налаштовує адресу сайту під новий домен;
- випускає сертифікат для HTTPS.

---

## Крок 4. Додати новий сервер у список SSH

Наприкінці попередньої команди на екрані з'явиться готовий блок для SSH. Скопіюйте його і додайте у файл `ssh/config` репозиторію [echo-sergeant](https://github.com/echoua/echo-sergeant), поруч з іншими GOI-серверами:

```sshconfig
Host goi-159ombr
    HostName goi-159ombr.eagle-atria.ts.net
    User ubuntu   # або інший User, який показала команда вище
```

---

## Крок 5. Додати сервер у justfile

У файлі `echo/goi/justfile` знайдіть змінну `goi_servers` і допишіть назву нового сервера в кінець списку (через пробіл, разом з іншими вже доданими серверами):

```shellscript
goi_servers := "goi-stg goi-prod-01 goi-159ombr"
```

Просто додайте нову назву (`goi-159ombr`) в кінець рядка, нічого не видаляючи.

---

## Крок 6. Перевірити, що сервер відповідає

```bash
ssh goi-159ombr
hostname
sudo systemctl status goi --no-pager
```

Якщо сервіс `goi` активний (`active (running)`) — усе добре.

---

## Крок 7. Налаштування в Tailscale після створення

На сторінці https://console.tailscale.com знайдіть новий пристрій і зробіть:

1. **Disable key expiry** — щоб доступ не "згорів" з часом.
2. Створіть **одноразове посилання-запрошення (invite)** і прийміть його під технічним Tailscale-юзером (наприклад, "ЕХО ПІВНІЧ") — це потрібно, щоб самим отримати доступ до нового сервера.
3. Створіть окреме **постійне запрошення (permanent invite)** на цей GOI-контейнер — його згодом віддамо кінцевим користувачам клієнта.

---

## Крок 8. Налаштувати GOI у веб-адмінці

1. Зайдіть в адмін-панель → розділ **GOI** → **нова інтеграція**.
2. Логін і пароль візьміть на самому сервері у файлі:

```bash
ssh yourcreated-goi-server
sudo su
cat /etc/goi-echo-worker/config.toml
```

3. Натисніть **Зберегти** → **Перевірити з'єднання**.
    - Якщо система попросить інвайт — використайте постійний інвайт із Кроку 7.
4. Після успішного збереження — донастройте воркер.
5. Покладіть SSH-ключ потрібного ЕХО-напрямку у файл `authorized_keys` всередині нового контейнера.

---

## Крок 9. Оновити сервер до останньої версії (редеплой)

```bash
just -f ./goi/justfile deploy --server="goi-159ombr"
```

Якщо це перший деплой на цьому сервері — використайте:

```bash
just deploy-first --server goi-159ombr
```

---

## Крок 10. Завершення

1. Внесіть URL нового сервера та інші деталі доступу в Google-таблицю (посилання на початку документа).
2. Надішліть клієнту (кому вказано в таблиці):
    - посилання на постійний Tailscale-інвайт (з Кроку 7);
    - коротку інструкцію по входу.

✅ Готово — новий GOI-сервер створено і переданий клієнту.

---

## Якщо щось пішло не так (перевірка проблем)

Підключіться на новий сервер і перевірте:

```bash
ssh goi-159ombr

sudo nginx -t
sudo systemctl status nginx --no-pager
sudo systemctl status goi --no-pager
sudo journalctl -u goi -n 100 --no-pager
```

Щоб перезапустити GOI:

```bash
sudo systemctl restart goi
sudo journalctl -u goi -n 100 --no-pager
```

Якщо не запускається — перечитайте Крок 3 (можливо, команда клонування виконалась не повністю) і зверніться до колеги з технічним доступом.
