# DEV CONTAINER (Incus + Tailscale)

## Загальна ідея

- Є шаблонний Incus контейнер `echo-dev-template`, в якому вже налаштоване dev-середовище
- Розробнику клонується окремий контейнер і після клонування запускається пост-скрипт
- Пост-скрипт підставляє Tailscale домен у `deploy/config.toml` (`public_host`)
- Пост-скрипт оновлює `server_name` в nginx
- Пост-скрипт перевипускає сертифікат для `/etc/echo/https.{crt,key}`

## Інструкція для девів

0) Підготуйте публічний SSH ключ, яким ви зайдете по SSH в контейнер, і приватний ключ для операцій з github/gitlab

1) Увійдіть у власну Tailscale панель і включіть HTTPS (SSL сертифікати)

2) Увійдіть у власну Tailscale панель і створіть ключ:
   - `add device -> linux server`
   - згенеруйте інсталяційний ключ

3) Оберіть ім'я машини і повний домен (кореневий домен можна подивитись у вкладці DNS в Tailscale кабінеті):

```bash
TS_KEY=tskey-auth-kB...7y
MACHINE=ziggy-dev-echo
DOMAIN=ziggy-dev-echo.eagle-atria.ts.net
```

4) Підготуйте SSH публічний ключ, який буде додано в контейнер:

```bash
SSH_PUBLIC_KEY="ssh-ed25519 AAAA... user@host"
```

5) Надішліть адміну вводні:

```bash
TS_KEY=tskey-auth-kB...7y
MACHINE=ziggy-dev-echo
DOMAIN=ziggy-dev-echo.eagle-atria.ts.net
SSH_PUBLIC_KEY="ssh-ed25519 AAAA... user@host"
```

6) Після виконання адміном клонування додайте в `~/.ssh/config` (надасть адмін):

```sshconfig
Host ziggy-dev-echo
    HostName ziggy-dev-echo.eagle-atria.ts.net
    User ubuntu   # приклад; використайте User зі скрипта
```

7) Зайдіть по ssh та покладіть приватний ключ для github/gitlab:

```bash
ssh "$MACHINE"
nano ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
ssh-add ~/.ssh/id_ed25519
ssh-add -l
```

8) Запустіть проект:

```bash
ssh "$MACHINE"
cd ~/workspace/echo
git pull

# 2 термінали
just dev-back
just dev-front
```

9) Доступ:

```text
https://ziggy-dev-echo.eagle-atria.ts.net
```

10) На панелі Tailscale натисніть "Disable key expiry" біля нової машини, щоб вас не вилогінило

## Інструкція адміну

Отримавши вводні від дева, виконайте:

```bash
TEMPLATE=echo-dev-template
cd ~/workspace/echo-dev-env/

echo-install-utils incus-clone --tailscale "$TS_KEY" --clear-all --ssh "$SSH_PUBLIC_KEY" -- "$TEMPLATE" "$MACHINE"
incus file push ./deploy/dev-post-clone.sh "$MACHINE/var/tmp/dev-post-clone.sh"
incus exec "$MACHINE" -- /var/tmp/dev-post-clone.sh \
  --ts-key "$TS_KEY" \
  --machine "$MACHINE" \
  --domain "$DOMAIN" \
  --ssh-public-key "$SSH_PUBLIC_KEY"
```

Після виконання скрипт виведе банер:
- готовий URL
- готовий блок для `~/.ssh/config`

## Troubleshoot

**Вбити підвислі сервіси:**

```
pkill -f wdintel-rs
```
