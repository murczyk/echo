# PostgreSQL 14 -> 18 Upgrade Runbook

Scope: Ubuntu 22.04 containers with local PostgreSQL `14/main`, pgBackRest to B2, and Echo services.

## Preflight

```bash
SERVER=echo-example
STANZA=wd-echo-example

ssh $SERVER 'pg_lsclusters; echo-install-utils --version'
ssh $SERVER "sudo echo-install-utils pg18-migration --phase preflight --stanza $STANZA"
ssh $SERVER "sudo echo-install-utils pg18-migration --phase check --stanza $STANZA"
ssh $SERVER "sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=$STANZA info"
```

If preflight fails because PG18 is absent, install packages first:

```bash
ssh $SERVER 'sudo echo-install-utils ensure-pgdg-apt-repo && sudo apt-get update -qq && sudo apt-get install -y postgresql-18 postgresql-18-postgis-3 postgresql-18-postgis-3-scripts postgresql-18-repack pg-uuidv7-postgresql-18'
```

## Online Backup

Run before downtime:

```bash
ssh $SERVER "sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=$STANZA --type=full backup"
```

Wait for backup and expire to finish:

```bash
ssh $SERVER "sudo tail -80 /var/log/pgbackrest/$STANZA-backup.log; sudo tail -80 /var/log/pgbackrest/$STANZA-expire.log"
```

## Downtime Upgrade

```bash
ssh $SERVER 'set -euo pipefail
units=$(systemctl list-units --type=service --all --no-legend "wdintel-*" "echo-signal-bot@*" "echo-whatsapp-bot@*" | awk "{print \$1}" | grep -E "^(wdintel-|echo-signal-bot@|echo-whatsapp-bot@)" || true)
if systemctl list-unit-files wdintel-rs.socket >/dev/null 2>&1; then units="$units wdintel-rs.socket"; fi
if [ -n "$units" ]; then sudo systemctl stop $units; fi
sudo systemctl stop wdintel-rs.socket wdintel-rs.service wdintel-rs-bgworker.service wdintel-py.service 2>/dev/null || true
sudo -u postgres psql -Atqc "select count(*) from pg_stat_activity where datname is not null;"

sudo cp -a /etc/postgresql/18/main/postgresql.conf /etc/postgresql/18/main/postgresql.conf.pre-pg18-migration.$(date +%Y%m%d%H%M%S)
sudo sed -i -E "s/^#?port = .*/port = 5432/" /etc/postgresql/18/main/postgresql.conf
sudo mkdir -p /etc/postgresql/18/main/conf.d
sudo cp -a /etc/postgresql/14/main/conf.d/90-pgbackrest.conf /etc/postgresql/18/main/conf.d/90-pgbackrest.conf
'

ssh $SERVER "sudo echo-install-utils pg18-migration --phase upgrade --stanza $STANZA --backup-mode skip"
```

## After Upgrade

```bash
ssh $SERVER "sudo cp -a /etc/pgbackrest/conf.d/pgbackrest-$STANZA.conf /etc/pgbackrest/conf.d/pgbackrest-$STANZA.conf.pre-pg18-migration.$(date +%Y%m%d%H%M%S)"
ssh $SERVER "sudo sed -i 's#pg1-path=/var/lib/postgresql/14/main#pg1-path=/var/lib/postgresql/18/main#' /etc/pgbackrest/conf.d/pgbackrest-$STANZA.conf"
ssh $SERVER "sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=$STANZA stanza-upgrade"
ssh $SERVER "sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=$STANZA check"
ssh $SERVER "sudo echo-install-utils pg18-migration --phase verify --stanza $STANZA"

ssh $SERVER 'cd /var/lib/postgresql && sudo -u postgres /usr/lib/postgresql/18/bin/psql -f update_extensions.sql'
ssh $SERVER 'sudo -u postgres /usr/lib/postgresql/18/bin/vacuumdb --all --analyze-in-stages --missing-stats-only'
```

Start services:

```bash
ssh $SERVER 'sudo systemctl start wdintel-rs.socket wdintel-rs.service wdintel-rs-bgworker.service wdintel-py.service || true'
ssh $SERVER 'pg_lsclusters; systemctl is-active wdintel-rs wdintel-rs-bgworker wdintel-py nginx postgresql@18-main'
```

Take first PG18 full backup:

```bash
ssh $SERVER "sudo -u postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --config-include-path=/etc/pgbackrest/conf.d --stanza=$STANZA --type=full backup"
```

Update Bitwarden/source config: `pg1-path=/var/lib/postgresql/18/main`.

## Timing Observed

- `echo-staging`: downtime about 3 minutes; DB 9.5GB before upgrade.
- `echo-cbr`: downtime about 2m36s; DB 3.9GB before upgrade.
- `echo-kharkiv2`: downtime about 2m40s; DB 41GB before upgrade.
- Full backup is online and can be long; do it before downtime.
- `pg_upgrade --link` downtime is mostly service stop/start, schema restore, config, pgBackRest check, extension update, and analyze. Data size matters less than object/schema count.

## Notes

- Do not start PG14 after successful `--link` upgrade and PG18 start.
- Keep SSH DB tunnels closed before migration; they can exhaust `max_connections`.
- WhatsApp/signal bot failures caused by missing env files are unrelated to PG upgrade; do not block core app recovery on them.
