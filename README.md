## Running

SIGINT analytical platform webapp.

**USE THIS REPO WITH [GIT Large File Storage](https://git-lfs.com/)**

## Deploy

- Архітектура: [docs/README.md](./docs/README.md)
- Встановлення (apt): [docs/INSTALL_APT.md](./docs/INSTALL_APT.md)
- **рекомендовано** Встановлення (zip): [docs/INSTALL_ZIP.md](./docs/INSTALL_ZIP.md)

## Setup

Setup local nginx per [deploy/README.md](deploy/README.md). Also see `just setup-dev` for notes and scripts.

Git hooks (recommended):

```
just setup-git-hooks
```

This enables repo-shared hooks in `.githooks/`, including a `pre-push` check that blocks force-pushes to `main`.
Running `npm install` in `wdintel-web` also configures these hooks automatically for frontend developers.

Front-end:

```
export GITHUB_TOKEN=ghp_...   # personal token with read:packages; see wdintel-web/.npmrc
just dev-front
```

Back-end:

```
just dev-back
```

Background and report workers run together in a separate process. Start one
additional terminal when working with report generation:

```
just dev-bgworker
```

Python service (optional, for NLP stuff only):

```
just dev-py
```

nginx macos: see [[deploy/README]]

Then open http://wildducks.localhost

## Tests

Frontend unit checks:

```bash
just test-fe
```

This runs the frontend test pipeline in `wdintel-web`:
- `elm-test`
- `vitest`
- the generated frontend test setup

Frontend end-to-end checks:

```bash
cd wdintel-web
npm run e2e
```

This runs the Playwright smoke suite for the current React/Elm hybrid frontend. For the slower loading comparisons, use:

```bash
npm run e2e:perf
```

Before running Playwright locally for the first time, install the browser once:

```bash
npm run e2e:install
```

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
- 8088 - goi-echo-worker
- 5000 - python api
- 8061..8072 (or more) - oauth callback api

## Building signal-cli and signal-cli-rest-api

read echo-im repo instructions

## Deploy

For server like echo-kherson do:

```
just deploy --server=$SERVER
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

## Message card highlights

The same message card is used in both the new duty page and the analysis page.

It can show four visual kinds of content:

- Keywords are shown as orange text highlights.
- Map points are shown as orange clickable labels with a map menu.
- Callsigns are shown as blue links when they are recognized in the catalog.
- Unrecognized but relevant callsigns are shown as plain white text.

Callsigns have four product states:

1. The callsign is in the radio-network catalog and matches the current message network.
   - Blue link
   - Filled info hint
2. The callsign is in the general callsign catalog, but has no radio-network affiliation.
   - Blue link
   - Outlined info hint
3. The callsign is in the radio-network catalog, but does not belong to the current message network.
   - Blue link
   - No hint
4. The callsign does not fit the catalog rules above, but should still be noticed.
   - White text
   - No link
   - No hint

Search results are highlighted separately from the callsign state:

- Search matches use a flat translucent orange background.
- If a search match is also a callsign, it keeps the normal blue link styling and gets the search highlight on top.
- Search highlighting does not change the callsign state or hint rules.
