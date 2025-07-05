## Running

**USE THIS REPO WITH [GIT Large File Storage](https://git-lfs.com/)**

Setup local nginx per [deploy/README.md](deploy/README.md). Also see `just setup-dev` for notes and scripts.

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

## Adding more restreamer instances

- create new lightsail instance named `restreamerXX` in your region of choice
  - if key pair wasn't known you'll need to put it on server to refer from /root/.ssh/config
- ssh into every host to make it known
- setup:

```
sudo apt-get update
sudo apt-get install -y ffmpeg python3-pip
# sudo pip3 install -U yt-dlp
sudo pip install -U git+https://github.com/ytdl-org/youtube-dl.git
```

## Building signal-cli and signal-cli-rest-api

**signal-cli-rest-api**

<details>
Build:

```
ssh jvln
cd /fast/kon/workspace/signal-cli-rest-api/src
git pull
go build
```

Get the result:

```
cd ~/Downloads
scp jvln:/fast/kon/workspace/signal-cli-rest-api/src/signal-cli-rest-api .
```

</details>

**signal-cli-native**

<details>
```
ssh jvln
cd /fast/kon/workspace/signal-cli
git pull
GRAALVM_HOME=/fast/kon/Downloads/graalvm-jdk-21.0.2+13.1 ./gradlew --no-daemon nativeCompile
```

Get the result:

```
scp jvln:/fast/kon/workspace/signal-cli/build/native/nativeCompile/signal-cli ./signal-cli-native
```

</details>

## DEPLOY

For server like echo-kherson do:

```
just server=echo-kherson deploy-echo
```

Batch-deploy:

```
for server in echo-kherson echo-soledarnist; do echo "\n🚀🚀🚀 deploying $server 🚀🚀🚀\n"; just server=$server deploy-echo; done
```
## Docs maintainance
### [Postman.md](postman/README.md)

### Generate and deploy rust docs
```bash
just server=echo-gpu deploy-rustdocs
```