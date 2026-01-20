#!/usr/bin/env bash
set -euo pipefail

set -a
source .env
set +a

for SERVER in echo-kherson2 echo-volyn2 echo-kharkiv2 echo-luhansk echo-zp2 echo-siversk echo-kupiansk echo-donetsk2 echo-pivnich echo-skhid; do
    RESTORE_DB=${SERVER//-/_}
    GPG_PASSPHRASE=Baggage-Paralyses1-Expansive ./copy-db-backup.sh --restore --restore-db=$RESTORE_DB $SERVER
    set -x
done
