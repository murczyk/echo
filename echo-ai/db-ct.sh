# Allows echo-ai-train to connect to remote postgresql over tailscale
# Example:
# ssh echo@ct-echo-kherson2-dev.alpines-banded.ts.net "bash -s" < db-ct.sh
PG_HBA_CONF="/etc/postgresql/14/main/pg_hba.conf"
POSTGRES_CONF="/etc/postgresql/14/main/postgresql.conf"

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
host    wd              wd              100.88.242.43/32            scram-sha-256
EOF
   sudo systemctl reload postgresql@14-main.service
fi
