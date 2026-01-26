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

<details>

```
sudo echo-install-utils setup-postgresql --db-name wd --db-user wd --password 'fee_-_-_-FnoeKFBeebu87bf' --install-pg-uuidv7 --install-pg-repack --install-postgis --setup-slowlog
```

`sudo nano /etc/postgresql/14/main/pg_hba.conf` change (if not already):

```
local   all             all                                     peer
```

to

```
local   all             all                                     md5
```

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
just server=$SERVER setup-py
```

## Edit `justfile`, expand `just deploy` command with your server

- once do `bw login` with sergeantbtzr
- once do `export BW_SESSION=...`
- deploy:

```
just server=<server> deploy-config
just builder=jvln server=<server> deploy-signal-cli-native
just builder=echo-gpu server=<server> deploy
```

## Instal AI

```
just server=$server deploy-echo-ai
```

## ECHO-IM

- TODO: install echo im binaries

## MILGEO-RS

- proj database (see justfile)

## Nginx

Don't upgrade NGINX! It has some bug that prevents it from starting properly after reboot sometimes.

Create `deploy/nginx/<server>`. Then do:

```
- Add www-data user to the group mygroup of the current user
<server>$ sudo usermod -a -G <mygroup> www-data

<server>$ sudo rm /etc/nginx/sites-enabled/default
$ scp deploy/nginx/<server> <server>: && ssh <server> 'sudo mv <server> /etc/nginx/sites-enabled/'
<server>$ sudo systemctl restart nginx
```
</details>

## Enable services

Once also enable services in systemd: `sudo systemctl enable wdintel-rs echo-whatsapp echo-signal-cli`

## SSL/Letsencrypt Tailscale

```
$ sudo su
$ (mkdir -p /tmp/echo && /usr/bin/wdintel-rs --mode=live renew-tailscale-cert >> /tmp/echo/echo_cron.txt 2>&1)
```

## Geo-screenshot

```
just builder=echo-gpu server=$server deploy-geo-screenshot
```

## Після-інсталяційні налаштування

- перевірте юзерів, створіть нових
- перевірте таблички `sigint_zone`, `sigint_zone_datasource`, `datasource`
- адмінка: включені signal-групи

## MONITORING

echo-sergeant

## Backups: Using GPG and encryption

### Setup

- `just server=<server> setup-b2`
- import

```
$ scp gpg-pub.asc {{server}}:
$ ssh {{server}}
[ubuntu@server]$ sudo su
[root@server]$ gpg --import gpg-pub.asc
[root@server]$ sudo mv gpg-pub.asc /etc/echo/
[root@server]$ gpg --edit-key FA2ED97558147E30
> trust
> 5
> y
> quit
[root@server]$ exit
[ubuntu@server]$ exit
$ just server={{server}} backup
```

### Additional info

#### Encrypt

```
gpg --encrypt --recipient 'Echo' test.txt
```

#### Decrypt

```
gpg --output test.txt --decrypt test.txt.gpg
```

#### Info

- see https://www.madboa.com/geek/gpg-quickstart/
- see https://gist.github.com/angela-d/8b27670bac26e4bf7c431715fef5cc51

```
gpg --gen-key
gpg --list-secret-keys --keyid-format LONG
gpg --export -a FA2ED97558147E30 > gpg-pub.asc
gpg --export-secret-keys -a FA2ED97558147E30 > gpg-sc.asc
```

## POST SETUP

- інструкцію для tailscale
- нотатка obsidian з шаблоном

## Setup logs/metrics

- Install vector: https://vector.dev/docs/setup/installation/package-managers/apt/
- Allow echo-greptime machine access to your server

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
1. deploy docs using `just server=${new-server-name} deploy-docs`
2. init database with an initial backup: `just server=${new-server-name} init-new-db`
