# Fresh ECHO server setup

**УВАГА!** Проект поступово переходить на інсталяцію за допомогою
`echo-install`. Див. головний README. Всі інструкції що тут мають
поступово переноситись в проект echo-install та запускаються через
нього.

## Інструкція

- Будьте уважними! Ця інструкція написана для сервера echo-kherson, іноді треба підставляти ваш сервер замість нього
- install Ubuntu 22.04
- sudo apt-get -y install openssh-server
- Tailscale
  - install tailscale (testing OpenVPN option for Donetsk)
  - enable MagicDNS, choose domain
  - enable HTTPS in Tailscale web ui
  - **disable key expiry** in Tailscale machines list [machine menu item](https://tailscale.com/kb/1028/key-expiry)
- set [swappiness=0](https://askubuntu.com/questions/103915/how-do-i-configure-swappiness)

<details>

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# signin with your administrative tailscale gmail
```

</details>

- configure [sudo without password](https://askubuntu.com/questions/147241/execute-sudo-without-password)
  - наприклад `echo "ubuntu ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/90-ubuntu`
- install dependencies

<details>

```
# sudo apt-get install -y nginx python3-pip gdal-data libopencv-dev libproj22 libprotobuf23 poppler-data proj-bin proj-data redis-server libxkbcommon-x11-0
sudo apt-get install -y nginx python3-pip gdal-data redis-server sqlite3
```

</details>

- Importer extra deps

<details>

```
# sudo apt-get install -y llvm libclang-dev clang poppler-utils ffmpeg libssl-dev pkgconf cmake libopencv-dev libproj-dev sqlite3
sudo apt-get install -y llvm libclang-dev clang ffmpeg libssl-dev pkgconf cmake libopencv-dev libproj-dev sqlite3
wget https://github.com/pdf2htmlEX/pdf2htmlEX/releases/download/v0.18.8.rc1/pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.deb
sudo apt install ./pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.deb
```

</details>

- open file limit

<details>

```
sudo sysctl -w fs.file-max=1000000
# sudo nano /etc/sysctl.conf
# append:
# fs.file-max = 1000000
```

</details>

- set timezone to UTC

```
sudo timedatectl set-timezone UTC
```

</details>

## Configure PostgreSQL

**install**

<details>

```
sudo echo-install-utils setup-postgresql --pg-version 18 --db-name wd --db-user wd --password 'fee_-_-_-FnoeKFBeebu87bf' --install-pg-uuidv7 --install-pg-repack --install-postgis --setup-slowlog
```

This also configures PostgreSQL systemd OOM policy; see
[POSTGRESQL.md](../docs/POSTGRESQL.md) for repair/check commands.

`sudo nano /etc/postgresql/18/main/pg_hba.conf` change (if not already):

```
local   all             all                                     peer
```

to

```
local   all             all                                     md5
```

**performance**

```
echo-install-utils ssh-sync-file deploy/postgresql/20-performance $server:/etc/postgresql/18/main/conf.d/20-performance.conf
```

**rest of the setup**

- load (scp) `deploy/wd-2024-06-21-13-00-59.pgrestore` it into the
  server (command displayed at the end of gen-db-skeleton)
  - For context, it was generated via this:
  - `just server=<SERVER_FROM> copy-db`
  - `just server=<SERVER_TO> gen-db-skeleton`
- run `PGPASSWORD="fee_-_-_-FnoeKFBeebu87bf" pg_restore -U wd -d wd ~/Downloads/wd-2024-06-21-13-00-59.pgrestore`
- update datasource=1 set `display_name`, `signal_phone`
- update sigint_zone=1 set `name`
- зробіть тюнінг за необхідності, див. [POSTGRESQL.md](../docs/POSTGRESQL.md)

</details>

#### fix 'time zone "Europe/Kiev" not recognized' error
```
cd /usr/share/zoneinfo/Europe && sudo cp Kyiv Kiev && sudo systemctl restart postgresql
```

## Install apt

- Встановлення (apt): [../docs/INSTALL_APT.md](./docs/INSTALL_APT.md)

## Install python worker with NLP

```
ssh $SERVER `sudo apt install wdintel-rs`
just setup-py --server $SERVER
```

## Deployment commands

- once do `bw login` with sergeantbtzr
- once do `export BW_SESSION=...`
- deploy:

```
just config-deploy --server $SERVER
just deploy --server $SERVER
```

Both `just deploy` and `just deploy-from-local` automatically publish a
two-minute Redis-backed maintenance state before stopping runtime services.
The state wakes connected browsers to show the update notice and temporarily
suppresses SigNoz log delivery; successful verification clears it immediately,
while failures rely on the TTL.

## Instal AI

```
just deploy-echo-ai --server $SERVER
```

## ECHO-IM

```
ssh $SERVER 'sudo apt install openjdk-25-jre-headless echo-im-signal echo-im-whatsapp'
```

## MILGEO-RS

- proj database (see justfile)

```
just deploy-proj-db --server=$SERVER
```

## Nginx

Run the setup recipe to install the nginx systemd file limit and restart nginx:

```
just setup-nginx-limits --server=$SERVER
```

**Edit /etc/nginx/nginx.conf**

```
worker_rlimit_nofile 524288;

...

  events {
      worker_connections 4096;
  }

...
```

**Setup and deploy new server config**

Create `deploy/nginx/<server>`. Then do:

```
- Add www-data user to the group mygroup of the current user
<server>$ sudo usermod -a -G <mygroup> www-data

<server>$ sudo rm /etc/nginx/sites-enabled/default
$ scp deploy/nginx/<server> $SERVER: && ssh $SERVER "sudo mv $SERVER /etc/nginx/sites-enabled/"
<SERVER>$ sudo systemctl restart nginx
```
</details>

## Enable services

Once also enable services in systemd: `sudo systemctl enable wdintel-rs`

If you want socket activation (reduced downtime during quick restarts), enable the socket
and disable the direct service autostart:

```
sudo systemctl enable --now wdintel-rs.socket
sudo systemctl disable wdintel-rs
```

Background workers are split into a separate unit:

```
sudo systemctl enable --now wdintel-rs-bgworker
```

`wdintel-rs --mode=live server` starts with background workers by default.
In `live` mode, the server process only runs `secret_worker` (vault secret loader) by default;
full background workers are expected from `wdintel-rs-bgworker`.
For local debug (`--mode=debug`), background workers are still enabled by default.

### Optional OCR worker

Configure every participating Echo instance with its own stable ID in
`/etc/echo/config.toml`:

```toml
[ocr]
base_url = "http://100.93.77.92:8000"
instance_id = "echo-staging"
gateway_url = "http://<this-instance-tailscale-ip>:8081"
max_in_flight_jobs = 2
```

Store the extractor credential separately as `ECHO_OCR_TOKEN=...` in
`/etc/echo/ocr.env`, owned by root with mode `0600`, then restart both
`wdintel-rs.service` and `wdintel-rs-bgworker.service`. The worker remains off
until an administrator enables it under **ШІ → OCR**. Configure this first only
on `echo-staging` and `echo-cbr-staging`; never reuse an `instance_id`.

## Geo-screenshot

```
just deploy-geo-screenshot --builder echo-gpu --server "$server"
```

## Після-інсталяційні налаштування

- перевірте юзерів, створіть нових
- перевірте таблички `sigint_zone`, `sigint_zone_datasource`, `datasource`
- адмінка: включені signal-групи

## MONITORING

echo-sergeant

## Backups: pgBackRest

Nightly DB backups are triggered by `/etc/cron.d/echo_cron` via
`/usr/bin/wdintel-rs --mode=live backup` (which runs `pgbackrest backup`
locally on the server as `postgres`).

### Setup

1. Read `docs/POSTGRESQL.md` (pgBackRest section) for the config layout.
2. Run: `just setup-pgbackrest --server <ssh-host> [--backup-name <backup-name>]`
3. One-off manual backup: `just backup --server <server>`

## POST SETUP

- інструкцію для tailscale
- нотатка obsidian з шаблоном

## Setup logs/metrics

- Install vector: https://vector.dev/docs/setup/installation/package-managers/apt/
- For Signoz logs:
  - set in `/etc/echo/config.toml`:
    - `signoz_logs_enabled = true`
    - `signoz_logs_endpoint = "http://signoz-echo.eagle-atria.ts.net:8082"`
  - restart vector: `sudo systemctl restart echo-vector`
- For Signoz device metrics:
  - set in `/etc/echo/config.toml`:
    - `signoz_metrics_enabled = true`
    - `signoz_metrics_endpoint = "http://signoz-echo.eagle-atria.ts.net:4317"`
  - restart the backend: `sudo systemctl restart wdintel-rs`

## При пререїзді на новий сервер

1. відредагувати `moved.html` - вказати коректну назву сервера і актуальну адресу
2. скопіювати moved.html до `/etc/echo/moved/index.html`:
3. оновити nginx файл `echo-$SERVERNAME`:

```
server {
    server_name echo-dn.alpines-banded.ts.net dn.echoua.info;

    root /etc/echo/moved;
    index index.html;
        gzip on;
        gzip_types
                text/css
                text/plain
                text/javascript
                application/javascript
                application/json
                application/x-javascript
                application/xml
                application/xml+rss
                application/xhtml+xml
                application/x-font-ttf
                application/x-font-opentype
                application/vnd.ms-fontobject
                image/svg+xml
                image/x-icon
                application/rss+xml
                application/atom_xml;
    access_log  off;

    client_max_body_size 200M;
    proxy_read_timeout 600;
    proxy_connect_timeout 600;
    proxy_send_timeout 600;

    location / {
        try_files $uri /index.html;
    }
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    listen 80;
    listen [::]:80;

    listen [::]:443 ssl http2; # managed by Certbot
    listen 443 ssl http2; # managed by Certbot
    ssl_certificate /etc/echo/echo.crt;
    ssl_certificate_key /etc/echo/echo.key;
}
```

4. restart nginx


### Other init steps

- deploy docs using "just deploy-docs --server $SERVER"
- (if needed) init database with an initial backup: `just server=${new-server-name} init-new-db`
