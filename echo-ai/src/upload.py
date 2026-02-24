import argparse

import mlflow

from echo_ai.upload import upload_run


def real_main(experiment_id: str, args: dict):
    upload_run(experiment_id, args)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_id", type=str)
    parser.add_argument("bucket", type=str)
    parser.add_argument("prefix", type=str)
    parser.add_argument("--ap_limit", type=float, default=-0.05)
    parser.add_argument("--pr_limit", type=float, default=-0.05)
    args = vars(parser.parse_args())

    tags = {"task": "upload"}
    print(f"starting upload with args={args}")
    with mlflow.start_run(tags=tags) as run:
        real_main(run.info.experiment_id, args)


if __name__ == "__main__":
    main()
