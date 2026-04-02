# GOI CONTAINER (Incus + Tailscale)

## Загальна ідея

- Є еталонний Incus контейнер `goi-stg`, з якого робиться копія під новий GOI інстанс
- Виконується клонування окремого контейнера
- Після клонування запускається GOI post-clone скрипт, який:
  - виставляє timezone контейнера в `Europe/Kyiv`
  - оновлює `server_name` в nginx під Tailscale домен
  - застосовує GOI post-clone налаштування всередині контейнера
  - перевипускає Tailscale сертифікат для GOI

## Попередня підготовка

1) З цього ноутбука покладіть post-clone скрипт на сервер з Incus через `just`:

```bash
cd ~/workspace/echo
just --justfile goi/justfile setup-dev-container-scripts --server <INCUS_HOST>
```

2) За замовчуванням скрипт буде на Incus host у:

```text
~/workspace/goi-container/deploy/goi-dev-post-clone.sh
~/workspace/goi-container/deploy/goi-dev-container/
```

## Інструкція клонування

1) Увійдіть у Tailscale admin panel і увімкніть HTTPS (SSL сертифікати)

2) Згенеруйте Tailscale auth key:
   - `Add device -> Linux server`
   - скопіюйте інсталяційний ключ

3) Задайте параметри нового контейнера:

```bash
TS_KEY=tskey-auth-kB...7y
MACHINE=goi-prod-01                    # новий контейнер
DOMAIN=goi-prod-01.eagle-atria.ts.net # його tailscale домен
TEMPLATE=goi-stg                       # існуючий incus instance, з якого клонуємо
```

4) Зайдіть на сервер з Incus:

```bash
ssh <INCUS_HOST>
```

5) Вже на сервері з Incus виконайте клонування + post-clone:

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

6) Після налаштування додайте `~/.ssh/config` (блок надасть скрипт):

```sshconfig
Host goi-prod-01
    HostName goi-prod-01.eagle-atria.ts.net
    User ubuntu   # або інший User з виводу post-clone скрипта
```

7) Перевірте доступ:

```bash
ssh "$MACHINE"
hostname
```

8) Перевірка GOI:

```bash
ssh "$MACHINE"
sudo systemctl status goi --no-pager
sudo journalctl -u goi -n 100 --no-pager
```

9) Доступ:

```text
https://goi-prod-01.eagle-atria.ts.net
```

10) На панелі Tailscale натисніть `Disable key expiry` для нової машини

## Troubleshoot

Перевірка nginx/goi:

```bash
ssh "$MACHINE"
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo systemctl status goi --no-pager
```

Перезапуск GOI:

```bash
ssh "$MACHINE"
sudo systemctl restart goi
sudo journalctl -u goi -n 100 --no-pager
```

11) Перший деплой: виконайте команду `just deploy-first --server $MACHINE`
