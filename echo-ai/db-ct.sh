# Allows echo-ai-train to connect to remote postgresql over tailscale
# Example:
# ssh echo@ct-echo-kherson2-dev.alpines-banded.ts.net "bash -s" -- < db-ct.sh $(tailscale ip -4)
PG_HBA_CONF="/etc/postgresql/14/main/pg_hba.conf"
POSTGRES_CONF="/etc/postgresql/14/main/postgresql.conf"
TRAIN_IP="$1"

if [ -z "${TRAIN_IP}" ];
then
    echo "Usage: db-ct.sh \$(tailscale ip -4)"  >&2
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
  TRAIN_IP=$(tailscale ip -4)
  cat <<EOF | sudo tee -a "$PG_HBA_CONF"
# echo-ai-train
host    wd              wd              ${TRAIN_IP}/32            scram-sha-256
EOF
   sudo systemctl reload postgresql@14-main.service
fi
