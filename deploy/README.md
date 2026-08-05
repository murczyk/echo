## server-side setup

For server setup see [[server.md]]

## Test Database Management

For CI/testing, use `just setup-test-db [branch_name]` to create branch-specific test databases from the base dump. Use `just cleanup-test-dbs` to remove all test databases. CI automatically handles this for each branch via the `TEST_DB_NAME` environment variable.

### File registry database

The file registry uses an independent, optional PostgreSQL database: `wd_files`
in live/debug mode. Enable it with a
`[file_registry]` section in the selected `deploy/config*.toml`:

```toml
[file_registry]
pg_host = "postgres-host"
pg_port = 5432
pg_user = "wd"
pg_password = "..."
pg_dbname = "wd_files"
```

Without this section, the backend skips the file-registry connection and
migrations, and device file
operations return HTTP 503. If Devices is enabled through
To enable the file registry on a deployment host, add the section and create
the configured database once before restarting the server or background worker.
Run the one-off command from the installed backend package:

```bash
sudo /usr/bin/wdintel-rs --mode=live oneoff-create-file-registry-database
```

Live mode reads `/etc/echo/config.toml`, just like the systemd services. To use
a different TOML file, pass it explicitly:

```bash
sudo env ECHO_CONFIG_PATH=/path/to/config.toml \
  /usr/bin/wdintel-rs --mode=live oneoff-create-file-registry-database
```

The command creates only the database. When `[file_registry]` is configured,
the `wdfiles-migration` schema migrator runs automatically during backend
startup. The configured PostgreSQL user needs `CREATEDB` to provision the
database and normal DDL permissions to run its migrations.

Generate the isolated SeaORM entity tree from the same configuration:

```bash
just gen-seaorm-files --mode=debug
```


### runtime deps

See "Denendencies" in [[../README.md]]

### main

```
just setup
```

### Ssl certs certificates

For **live**

TODO

For **live** deployments on-site (zptzr, echo-kherson):

```
sudo tailscale cert zptzr.alpines-banded.ts.net
sudo mv ./zptzr.alpines-banded.ts.net.* ~/.ssh/
# (same operation for updating them)
# now grafana
sudo cp ~/.ssh/zptzr.alpines-banded.ts.net.key /etc/grafana/grafana.key
sudo cp ~/.ssh/zptzr.alpines-banded.ts.net.crt /etc/grafana/grafana.crt
sudo cp /etc/grafana/grafana.crt /etc/echo/echo.crt
sudo cp /etc/grafana/grafana.key /etc/echo/echo.key
sudo systemctl restart nginx
sudo systemctl restart grafana-server
```

**Cert update** upon expire:

```
sudo tailscale cert zptzr.alpines-banded.ts.net
sudo cp zptzr.alpines-banded.ts.net.crt /etc/grafana/grafana.crt
sudo cp zptzr.alpines-banded.ts.net.key /etc/grafana/grafana.key
sudo mv zptzr.alpines-banded.ts.net.crt ~/.ssh/
sudo mv zptzr.alpines-banded.ts.net.key ~/.ssh/
sudo cp /etc/grafana/grafana.crt /etc/echo/echo.crt
sudo cp /etc/grafana/grafana.key /etc/echo/echo.key
sudo systemctl restart nginx
sudo systemctl restart grafana-server
```

### open files limit

```
sudo sysctl -w fs.file-max=1000000
# sudo nano /etc/sysctl.conf
# append:
# fs.file-max = 1000000
```

## postgresql

This is older instruction for jvln/wd database. For ECHO, see [[server.md]] PostgreSQL instructions.
Enable the PGDG apt repository as described in [POSTGRESQL.md](../docs/POSTGRESQL.md) first.

```
sudo apt install postgresql-18
sudo -u postgres psql
postgres=# create database wd;
postgres=# CREATE USER wd WITH SUPERUSER PASSWORD 'fee_-_-_-FnoeKFBeebu87bf';
```

Edit `/etc/postgresql/18/main/pg_hba.conf` (`sudo nano`), change:

```
local   all             all                                     peer
```

to

```
local   all             all                                     md5
```

See [[MIGRATIONS.md]]

**Restore** if needed:

```
PGPASSWORD=fee_-_-_-FnoeKFBeebu87bf pg_restore -U wd -d wd --clean ~/Downloads/wd-2023-04-19-08-34-48.pgrestore
```

## cron (mode=live)

`sudo crontab -e`

```
0 1 * * * systemctl restart wdintel-rs.service
1 1 * * * systemctl restart wdintel-rs-restreamer.service
```

## signal (mode=live on-site: zptzr, echo-kherson)

- signal is now deployed as part of the deb package, as two binaries: signal-cli and signal-cli-rest-api

To **link new device**:

<details>
1. Run ssh tunnel like this:

```
ssh -nNT -L 8083:localhost:8083 {{server}}
```

2. Open (for your domain) http://localhost:8083/v1/qrcodelink?device_name=echo

</details>

## (deprecated) signal via docker (mode=live on-site: zptzr, echo-kherson)

We're now using https://github.com/bbernhard/signal-cli-rest-api

[Install docker](https://docs.docker.com/engine/install/ubuntu/):

```
# Add Docker's official GPG key:
sudo apt-get update
sudo apt-get install ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository to Apt sources:
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update

sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```
mkdir -p /etc/echo/storage/signal-cli
```

**Run** via this command but with `0.0.0.0` if you want to link:

```
sudo docker run -d --name signal-api --restart=always -p 127.0.0.1:8083:8080 \
      -v $HOME/storage/signal-cli:/home/.local/share/signal-cli \
      -e 'MODE=native' bbernhard/signal-cli-rest-api
```

**Link new device** Open (for your domain) http://<domain>:8083/v1/qrcodelink?device_name=echo

(Example domain: zptzr.alpines-banded.ts.net, echo-kherson.alpines-banded.ts.net etc.)

Then **update group names**:

```
-- list messages with group master keys
select sm.id, sm.body, sg.name, sm.group_master_key from signal_message sm
left join signal_group sg on sg.master_key = sm.group_master_key
order by id desc limit 100;
```

Then update config.rs and Config.elm appropriately.

## signal presage (deprecated)

migrate existing presage db if needed

## python

```
sudo apt-get install python3-pip
```

See [[wdintel-py/README.md]]

## nginx

```
sudo apt install nginx
```

TODO letsencrypt

## macos nginx

### /etc/hosts

Put `127.0.0.1	wildducks.localhost` in your /etc/hosts.

### nginx

Make sure your nginx (`brew install nginx`) has the following configuration (`/opt/homebrew/etc/nginx/nginx.conf`):

```
    # ...

    server {
        listen 443 ssl;
        listen [::]:443 ssl;
        http2 on;
        server_name  echo.localhost;
        client_max_body_size 200M;
        root /Users/kon/workspace/echo/wdintel-web/public;
        index index.html;
        proxy_read_timeout 600;
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        ssl_certificate /Users/kon/workspace/echo/deploy/echo.localhost.crt;
        ssl_certificate_key /Users/kon/workspace/echo/deploy/echo.localhost.key;
        location / {
            try_files $uri $uri/ /;
            add_header Cache-Control "no-cache";
        }
        location /src/ { include /etc/nginx/echo-dev-front-proxy.inc; }
        location /.elm-land/ { include /etc/nginx/echo-dev-front-proxy.inc; }
        location /@vite/ { include /etc/nginx/echo-dev-front-proxy.inc; }
        location /@id/ { include /etc/nginx/echo-dev-front-proxy.inc; }
        location /node_modules/.vite/ { include /etc/nginx/echo-dev-front-proxy.inc; }
        location /api {
            proxy_pass http://localhost:8081;
            proxy_set_header Host $host;
        }
        # ...
    }

    # ...
```

Restart with `brew services restart nginx`

**nginx ssl certificate** [setup](https://www.digitalocean.com/community/tutorials/how-to-create-a-self-signed-ssl-certificate-for-nginx-in-ubuntu-16-04)

Generate like [this](https://stackoverflow.com/questions/60751795/unable-to-use-self-signed-certificates-with-tokio-rustls):

```
openssl req -x509 -noenc -subj '/CN=echo.localhost' -newkey rsa -keyout root.key -out root.crt
openssl req -noenc -newkey rsa -keyout client.key -out client.csr -subj '/CN=echo.localhost' -addext subjectAltName=DNS:echo.localhost
openssl x509 -req -in client.csr -CA root.crt -CAkey root.key -days 365 -out client.crt -copy_extensions copy
mv client.crt echo.localhost.crt
mv client.key echo.localhost.key
mv root.key ca.key
mv root.crt ca.pem
```

Set `common name` to `echo.localhost`.

```
sudo security add-trusted-cert \
  -d -r trustRoot \
  -k /Library/Keychains/System.keychain ./echo.localhost.crt
```

# Set up log rotation

1. put this file at `/etc/logrotate.d/nginx`:

```
/var/log/nginx/*.log {
	daily
	missingok
	rotate 14
	maxsize 20G
	compress
	delaycompress
	notifempty
	create 0640 www-data adm
	sharedscripts
	prerotate
		if [ -d /etc/logrotate.d/httpd-prerotate ]; then \
			run-parts /etc/logrotate.d/httpd-prerotate; \
		fi \
	endscript
	postrotate
		invoke-rc.d nginx rotate >/dev/null 2>&1
	endscript
}
```

2. test log rotation: run `sudo logrotate /etc/logrotate.d/nginx` and  check `/var/log/nginx` to make sure it worked.
