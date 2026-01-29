import argparse

import mlflow

from echo_ai.upload import upload_run


def real_main(experiment_id: str, args):
    run_id = args["run_id"]
    bucket = args["bucket"]
    prefix = args["prefix"]
    upload_run(experiment_id, run_id, bucket, prefix)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_id", type=str)
    parser.add_argument("bucket", type=str)
    parser.add_argument("prefix", type=str)
    args = vars(parser.parse_args())

    tags = {"task": "upload"}
    print(f"starting upload with args={args}")
    with mlflow.start_run(tags=tags) as run:
        real_main(run.info.experiment_id, args)


if __name__ == "__main__":
    main()
