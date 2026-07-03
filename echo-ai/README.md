## echo-ai

Contains code for training FastText models on schedule.

### Server setup

Run `just setup-echo-ai-train` to rsync-deploy to a training server (by default `echo-ai-train`)

MLflow tracking server and training scripts are deployed as systemd user units.

See `deploy.sh` for details.


### Project struture

Training scripts are set-up using [MLflow projects](https://mlflow.org/docs/latest/ml/projects/)

Default values for parameters are stored in `.env` and `MLProject`.


### Starting training (remote)

```bash
ssh echo-ai-train
systemctl --user start --no-block echo-ai-train
journalctl --user -u echo-ai-train -f
# View results on http://echo-ai-train.eagle-atria.ts.net:5000

# Setting up a new -dev database (after pgbackrest)
# this will setup nightly restore and allow psql connections from echo-ai-train tailscale IP
# one time setup requires Tailscale and SSH access
cd echo-ai
ssh echo@ct-echo-kherson2-dev.alpines-banded.ts.net "bash -s" -- < db-ct.sh $(tailscale ip -4)

# Re-registering access after a major PostgreSQL upgrade (e.g. to PG 18)
# pg_upgrade writes a fresh config, dropping listen_addresses / pg_hba.conf entries,
# so echo-ai-train can no longer connect. pg-access.sh re-runs itself on echo-ai-train
# (so the hop to the DB servers uses the keys stored there, not ProxyJump),
# auto-detects the running cluster/version, and re-adds echo-ai-train's tailscale IP.
# Run it via just (jump server defaults to echo-ai-train):
just setup-echo-ai-train-db ct-echo-kherson2-dev.alpines-banded.ts.net echo-skhid-dev.serengeti-porbeagle.ts.net
```

`echo-ai-train.service` is also started using `echo-ai-train.timer`.

### Starting training (local)

```bash
# ensure mlflow is running
just ai-mlflow-server &
just ai-mlflow-run --databases 'wd' --unsupervised true 
# a local datalake with training data is maintained
# --databases can refer to a localhost postgres database name,
# or it can be a hostname like echo-skhid-dev.serengeti-porbeagle.ts.net (database name is wd in that case)
# for remote databases ensure .env contains the required PGPASSWORD PGUSER
# for echo-ai-train it's set-up in /usr/local/echo-ai-train/.env.train
# pre train at least once, can pass --unsupervised false next time
# View results on http://localhost:5000
```
