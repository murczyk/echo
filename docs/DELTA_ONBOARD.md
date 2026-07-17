# Delta onboarding

When a new Echo server is being onboarded to Delta and we want Delta login and
other integrations to work, we need to put configs for this server into our
Hashicorp Vault instance first.

## Vault config

1. Create a Bitwarden note named `echo-vault-<server>`:

```toml
server="echo"
login="echo-<server>-api"
password="<generated-password>"
url="https://srv-vault.golden-banded.ts.net:7300"
```

2. Create a Bitwarden note named `echo-vault-config-<server>` with the secret
   config key-value pairs for that server, including Delta and other integration
   credentials.

3. Write the policy, Vault userpass account, and config secret:

```bash
just setup-vault --server <server>
```

This writes the runtime config secret to:

```text
echo/<server>/config
```

4. Deploy the server config with `vault_config` enabled and restart the service
   so `secret_worker` loads the config from Vault.
