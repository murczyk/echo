# Quick setup newcomers guide

After following this guide the app should be available at https://echo.localhost:8443/ after startup.

To start it, use screen/tmux and run `just dev-back`, `just dev-front2`, `just dev-py`.

Use `admin` and the password `fee_-_-_-FnoeKFBeebu87bf` (same as the DB default password) to sign-in.

## Setup base system (Ubuntu 22.04)

```bash
# adjust postgresql-14 to postgresql-16 if using a newer version of Ubuntu
sudo apt install pkg-config libssl-dev libsqlite3-dev sqlite3 curl \
    python3-pip ca-certificates cmake build-essential python3-venv python3-virtualenv postgresql-14 postgis postgresql-14-postgis-3 \
    git git-lfs nginx

# Install rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

cargo install just
cargo install cargo-watch

# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts

# Install redis
sudo apt-get install lsb-release curl gpg
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt-get update
sudo apt-get install redis
sudo systemctl enable redis-server
sudo systemctl start redis-server

# ensure the following line is above peer auth method in postgres
# local   all             all                                     scram-sha-256
# local   replication     all                                     scram-sha-256
sudo vim /etc/postgresql/14/main/pg_hba.conf
sudo systemctl reload postgresql@14-main.service
```

## Clone the repository
```bash
# Generate SSH key and add to GitHub (crates use Git SSH transport)
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub

git clone git@github.com:echoua/echo.git
```

## Setup database

```bash
sudo -u postgres psql -c "CREATE USER wd WITH PASSWORD 'fee_-_-_-FnoeKFBeebu87bf';"
sudo -u postgres psql -c "CREATE DATABASE wd OWNER wd;"
sudo -u postgres psql -c "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;" wd
sudo -u postgres psql -c "ALTER TABLE public.spatial_ref_sys OWNER TO wd;" wd
PGPASSWORD=fee_-_-_-FnoeKFBeebu87bf pg_restore -U wd -d wd --clean deploy/wd-init.pgrestore 

```

## Build and start backend (dev-back)

```bash
cd echo
cargo build
cp deploy/config-debug.toml deploy/config.toml
just dev-back
# ctrl+C and then add local dev admin login
cargo run --bin=wdintel-rs -- --mode debug oneoff-register-user --login admin --password fee_-_-_-FnoeKFBeebu87bf --role Admin --sigint-zone 1
# assign default organism to user
PGPASSWORD=fee_-_-_-FnoeKFBeebu87bf psql -U wd -c "UPDATE login SET organism_id = 6 WHERE login = 'admin';" wd

```

## Build and start frontend (dev-front2)
```bash
just dev-front2
```

## Build and start spacy (dev-py)
```bash
just dev-py
```

## Setup nginx

```bash
openssl req -x509 -noenc -subj '/CN=echo.localhost' -newkey rsa -keyout root.key -out root.crt
openssl req -noenc -newkey rsa -keyout client.key -out client.csr -subj '/CN=echo.localhost' -addext subjectAltName=DNS:echo.localhost
openssl x509 -req -in client.csr -CA root.crt -CAkey root.key -days 365 -out client.crt -copy_extensions copy
mv client.crt echo.localhost.crt
mv client.key echo.localhost.key
mv root.key ca.key
mv root.crt ca.pem

sudo cp echo.localhost.crt echo.localhost.key /etc/nginx/
# adjust config as following
sudo vim /etc/nginx/sites-available/default
sudo systemctl reload nginx
```

Example nginx configuration

```
server {
    server_name echo.localhost;

    listen 8080;
    listen [::]:8080;

    listen [::]:8443 ssl http2;
    listen 8443 ssl http2;
    ssl_certificate /etc/nginx/echo.localhost.crt;
    ssl_certificate_key /etc/nginx/echo.localhost.key;

    root /etc/nginx/public;
    index index.html;

    client_max_body_size 200M;
    proxy_read_timeout 600;
    proxy_connect_timeout 600;
    proxy_send_timeout 600;
    
    location /api {
        proxy_pass http://localhost:8081;
        proxy_set_header Host $host;
    }
    location /api-public {
        proxy_pass http://localhost:8081/api-public;
        proxy_set_header Host $host;
    }
    location / {
        proxy_pass http://localhost:1234;
        proxy_set_header Host $host;
    }
}
```

