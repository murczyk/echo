## Running

SIGINT analytical platform webapp.

**USE THIS REPO WITH [GIT Large File Storage](https://git-lfs.com/)**

## DEPLOY

- Встановлення (apt): [docs/INSTALL_APT.md](./docs/INSTALL_APT.md)
- **рекомендовано** Встановлення (zip): [docs/INSTALL_ZIP.md](./docs/INSTALL_ZIP.md)

## SETUP

Setup local nginx per [deploy/README.md](deploy/README.md). Also see `just setup-dev` for notes and scripts.

Git hooks (recommended):

```
just setup-git-hooks
```

This enables repo-shared hooks in `.githooks/`, including a `pre-push` check that blocks force-pushes to `main`.

Front-end:

```
just dev-front
```

Back-end:

```
just dev-back
```

Python service (optional, for NLP stuff only):

```
just dev-py
```

Sigint signal worker (reads messages from signal):

```
(cd wdintel-rs && cargo run --release -- --mode=debug sigint-worker)
```

nginx macos: see [[deploy/README]]

Then open http://wildducks.localhost

Documentation web app:

you need to install `Zola` project first: https://www.getzola.org/documentation/getting-started/installation/

Then, use following scripts:

```bash
just doc # builds documentation webapp
just dev-dock #serves documentation webapp on local machine
```


### Codegen

SeaORM:

```
just gen-seaorm
```

Elm:

```
just gen-elm
```

### Dependencies

This might include for full jvln and build-machine setup, for ECHO-server-only dependencies see [[deploy/server.md]]

```
sudo apt-get install llvm libclang-dev clang poppler-utils ffmpeg libssl-dev pkgconf cmake libopencv-dev libproj-dev sqlite3
# maybe do
# wget http://launchpadlibrarian.net/471013869/poppler-utils_0.86.1-0ubuntu1_amd64.deb
# wget http://launchpadlibrarian.net/471013868/libpoppler97_0.86.1-0ubuntu1_amd64.deb
wget https://github.com/pdf2htmlEX/pdf2htmlEX/releases/download/v0.18.8.rc1/pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.deb
sudo apt install ./pdf2htmlEX-0.18.8.rc1-master-20200630-Ubuntu-focal-x86_64.deb
```

Install `yt-dlp` (instead of previous youtube-dl) from source (for restreamer).

```
sudo pip3 install -U yt-dlp
```

PostgreSQL:

Install postgis extension for shema. IMPORTANT: You must use admin user for that (postgres mostly)

```
CREATE EXTENSION postgis;
```

macOS:

```
brew install pdf2htmlex poppler
```

**upgrade ffmpeg**

```
ssh jvln
sudo su
for server in restreamer01 restreamer02 restreamer03; do ssh $server "wget https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz; tar xf ffmpeg-master-latest-linux64-lgpl.tar.xz; sudo ln -s /home/ubuntu/ffmpeg-master-latest-linux64-lgpl/bin/ffmpeg /usr/local/bin/ffmpeg"; done
```

**python microservices**

see [[wdintel-py/README]]

## Ports

- 8081 - web server (main rust api)
- 8082 - restreamer
- 8083 - docker signal cli rest api (see deploy/README.md)
- 5000 - python api
- 8061..8072 (or more) - oauth callback api

## Building signal-cli and signal-cli-rest-api

read echo-im repo instructions

## DEPLOY

For server like echo-kherson do:

```
just builder=$BUILDER server=$SERVER deploy
```

Batch-deploy:

```
for server in echo-kherson echo-soledarnist; do echo "\n🚀🚀🚀 deploying $server 🚀🚀🚀\n"; just server=$server deploy; done
```
## Docs maintainance

### [Postman.md](postman/README.md)

### Generate and deploy rust docs

```bash
just server=echo-gpu deploy-rustdocs
```

## Delta integration

[Delta.md](DELTA.md)

Config with access details for delta is being stored in Hashicorp Vault. 
Vault secrets are backed up in Bitwarden.
One-off commands for backup Vault secrets:
- backup: OneoffBackupVaultSecretsToBitwarden
- restore: OneoffRestoreVaultSecretsFromBitwarden

## Wipe DB

in order to erase data from db you may just run [clear_db.sql](deploy/clear_db.sql).
it's useful for resetting local db or preparing fresh `wd-init.pgrestore`

# Reports
## РЕО
Доповідь про радіоелектронну обстановку.
- неприв'язані мережі: показуємо лише топ 90% активних за кількістю сеансів зв'язку, групуємо по частотах в межах +-12.5КГц
- на неприв'язаних частотах показуємо лише позивні які б'ються із білим списком [callsigns_whitelist.txt](wdintel-rs/data/callsigns_whitelist.txt). він генеруєжться в модулі callsign-crawler проету milgeo-rs: https://github.com/echoua/milgeo-rs/tree/main/callsigns_crawler
