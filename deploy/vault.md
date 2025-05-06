# Hashicorp Vault

## Onboard flow for Vault
> in this example the app name is MyApp and application server name is Server1

1. generate a new password for userpass access for your app.
2. put this password along with the rest of the `vault.coml` config (as key-value pairs, one per line) to Bitwarden as `myapp-vault-server1`. common format we use:
```toml
server="myapp"
login="myapp-api"
password="password-from-step-1"
url="https://srv-vault.golden-banded.ts.net:7300"
```
3. put your secret (as set of key-value pairs, same format as in previous step) to bitwarden under `myapp-vault-config-server1`.
4. run deploy script (see `setup-vault` scripts in Echo and Target projects as reference). they should create policies, userpass access accounts and secrets in Vault.



## Manual setup on a server:

1. create config at ~/vault/config.hcl:

```bash
storage "raft" {
  path    = "/home/hammer/vault/data"
  node_id = "node1"
}

listener "tcp" {
  address     = "127.0.0.1:7200"
  tls_disable = "true"
}

disable_mlock = true

api_addr = "http://127.0.0.1:7200"
cluster_addr = "http://127.0.0.1:7201"
ui = true
```

2. to enable autostart just add this to /etc/systemd/system/vault.service:

```
[Unit]
Description=HashiCorp Vault Server
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=/home/hammer/vault
ExecStart=/usr/bin/vault server -config=/home/hammer/vault/config.hcl
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

also, update `~/.bashrc` - add following line:
```bash
export VAULT_ADDR=http://127.0.0.1:7200

```

3. start the service:

```
sudo systemctl enable vault
sudo systemctl start vault
```

4. configure Vault: run this command, it returns keys to Vault. please save them, otherwise you may loose your data

```
vault operator init
```

5. enable login/password auth and key-value storage for echo (repeat 2nd command for other projects):

```
vault auth enable userpass
vault secrets enable -path=echo kv-v2
```

if it fails with `Vault is sealed` error - unseal the Vault and set the Vault token first (using keys from step 4):

```
vault operator unseal  # do this 3 times with different keys in order to unseal it
vault login  # use master token


```

## Manually setup secrets for your app in Vault
> this is not a preferred way to do things, please refer to Onboard flow for Vault.

1. create your secret via Vault CLI for your App Server:

```
vault kv put echo/volyn/my-secret-map value=foo_value value2=bar_value
```

2. create access policy for your App server:

```
cat <<EOL > volyn_policy.hcl
path "echo/data/volyn/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "echo/metadata/volyn/*" {
  capabilities = ["list"]
}
EOL

vault policy write volyn-policy volyn_policy.hcl
```

3. create creds for your App Server, so it could access vault:

```
vault write auth/userpass/users/volyn-api password=foo policies=volyn-policy
```

4. copy /etc/echo/secret.toml from other server and put it to yours, with the credentials you've just created

now App Backend should be able to gain access to Vault!