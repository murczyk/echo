#!/bin/bash

# bash helper functions

ensure_nonempty() {
	if [[ -z "$2" ]]; then
		echo "❌ $1 is empty"
		exit 1
	fi
}

# function to get config from bitwarden and server, compare them and update the server if needed
bw_sync() {
	SERVER=$1
	NAME=$2
	SERVER_CONFIG=$3
	SERVICE=$4
	bw sync
	ssh $SERVER "cat $SERVER_CONFIG" > /tmp/config-server.toml || echo "" > /tmp/config-server.toml
	res=$(bw list items --pretty $NAME | jq -r '[.[] | select(.name=="'$NAME'")][0].notes')
	if [[ "$res" == "null" ]]; then
		echo "❌ Config not found in Bitwarden or it has empty notes field"
		exit 1
	else
		echo "$res" > /tmp/config-bitwarden.toml
	fi

	set +x
	# using https://github.com/Wilfred/difftastic
	diff_result=$(difft --display=inline --color=always /tmp/config-server.toml /tmp/config-bitwarden.toml || true)
	if echo "$diff_result" | grep -q "No changes."; then
		echo "✅ Configs are equal"
	else
		echo "❌ Configs are different"
		echo "diff: $diff_result"
		read -p "Do you want to update the config on the server? (y/N) " -n 1 -r
		echo
		if [[ $REPLY =~ ^[Yy]$ ]]; then
			# ensure $SERVER_CONFIG's parent dir exists
			ssh $SERVER "sudo -S mkdir -p $(dirname $SERVER_CONFIG)"
			scp /tmp/config-bitwarden.toml $SERVER:/tmp/config.toml && ssh $SERVER "sudo -S mv /tmp/config.toml $SERVER_CONFIG"
			 if [[ "$SERVICE" == "" ]]; then
			   echo "✅ Config updated"
       else
			   ssh $SERVER "sudo -S systemctl restart $SERVICE"
			   echo "✅ Config updated and $SERVICE restarted"
       fi
		else
			echo "❌ Config not updated"
		fi
	fi
	set -x
	rm /tmp/config-server.toml /tmp/config-bitwarden.toml || true
}

vault_ensure_enabled() {
    local VAULT_SERVER=$1
    local VAULT_ADDR=$2
    local VAULT_ROOT=$3
    local VAULT_CACERT_PATH=$4
    local IS_LOCAL=$5
    ssh -t "$VAULT_SERVER" "
         export VAULT_ADDR=$VAULT_ADDR
         if [[ $IS_LOCAL == 'true' ]]; then
            export VAULT_CACERT='$VAULT_CACERT_PATH'
        fi
        vault login
        if ! vault secrets list -format=json | jq -e '.[\"$VAULT_ROOT/\"]'; then
            vault secrets enable -path=$VAULT_ROOT kv-v2
        else
            echo 'Secret engine already enabled at path: $VAULT_ROOT'
        fi
    "
}

generate_policy() {
	local ROOT=$1
    local SERVER=$2

	cat <<EOL
path "$ROOT/data/$SERVER/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "$ROOT/metadata/$SERVER/*" {
  capabilities = ["list"]
}
EOL
}

bw_get_note() {
	local NAME=$1
    bw sync 1>&2
	bw list items --pretty $NAME | jq -r '[.[] | select(.name=="'$NAME'")][0].notes'
}
