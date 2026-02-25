# Allows echo-ai-train to connect to remote postgresql over tailscale
# Example:
# ssh echo@ct-echo-kherson2-dev.alpines-banded.ts.net "bash -s" -- < db-ct.sh $(tailscale ip -4)
PG_HBA_CONF="/etc/postgresql/14/main/pg_hba.conf"
POSTGRES_CONF="/etc/postgresql/14/main/postgresql.conf"
TRAIN_IP="$1"

if [ -z "${TRAIN_IP}" ];
then
    echo 'Provide an tailscale IP as argument to add to pg_hba.conf' >&2
    echo 'Usage: ssh <SERVER> "bash -s" -- < db-ct.sh $(tailscale ip -4)' >&2
    exit 1
fi

if ! command -v jq > /dev/null 2>&1; then
    sudo apt-get -y install jq
fi

if ! grep -q '^listen_addresses' "$POSTGRES_CONF"; then
    DOMAIN=$(tailscale status --json | jq -r ".CertDomains[0]")
    echo "setting listen_addresses to localhost and $DOMAIN"
    sudo sed -i "s/^#listen_addresses.*/listen_addresses = 'localhost, $DOMAIN'/" "$POSTGRES_CONF"
    sudo systemctl restart postgresql@14-main.service
fi

if ! sudo grep -q echo-ai-train "$PG_HBA_CONF"; then
  echo "adding echo-ai-train to pg_hba.conf"
  cat <<EOF | sudo tee -a "$PG_HBA_CONF"
# echo-ai-train
host    wd              wd              ${TRAIN_IP}/32            scram-sha-256
EOF
   sudo systemctl reload postgresql@14-main.service
fi


SERVICE_UNIT_FILE="/etc/systemd/system/pgbackrest-restore.service"
if [[ ! -f "${SERVICE_UNIT_FILE}" ]]; then
    STANZA=$(pgbackrest info --output=json | jq -r '.[0].name')
    cat << EOF | sudo tee /etc/systemd/system/pgbackrest-restore.service
[Unit]
Description=Restore latest pgBackRest backup
Before=postgresql@14-main.service
Conflicts=postgresql@14-main.service

[Service]
Type=oneshot
User=postgres
ExecStart=/usr/bin/pgbackrest --stanza=${STANZA} --delta --log-level-console=info restore
ExecStopPost=+/usr/bin/systemctl start --no-block postgresql@14-main.service
EOF
fi

TIMER_UNIT="pgbackrest-restore.timer"
TIMER_UNIT_FILE="/etc/systemd/system/${TIMER_UNIT}"
if [[ ! -f "${TIMER_UNIT_FILE}" ]]; then
    cat << EOF | sudo tee "${TIMER_UNIT_FILE}"
[Unit]
Description=Run pgbackrest-restore daily at 01:01
[Timer]

OnCalendar=*-*-* 01:01:00 Europe/Kyiv
Persistent=true

[Install]
WantedBy=timers.target
EOF
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "${TIMER_UNIT}"
