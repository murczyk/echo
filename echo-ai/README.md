## echo-ai

Contains code for training FastText models on schedule.

### Server setup

Run `just deploy-ai-train` to rsync-deploy to a training server (by default `echo-ai-train`)

MLflow tracking server and training scripts are deployed as systemd user units.

See `deploy.sh` for details.


### Project struture

Training scripts are set-up using [MLflow projects](https://mlflow.org/docs/latest/ml/projects/)

Default values for parameters are stored in `.env` and `MLProject`.

### Database access

To keep 

### Starting training (remote)

```bash
systemctl --user start --no-block echo-ai-train
journalctl --user -u echo-ai-train -f
```

`echo-ai-train.service` is also started using `echo-ai-train.timer`.

### Starting training (local)

```bash
# ensure mlflow is running
just ai-mlflow-server
just ai-mlflow-run --databases
```

### Legacy training models
