import argparse
import os
import sys
import tempfile
from pathlib import Path

import mlflow


def real_main(
    unsupervised: bool, restore: bool, restore_databases: str, databases: str
):
    src = Path(__file__).parent
    project = str(src.parent)

    databases_list = databases.split(None)
    if restore or restore_databases:
        tags = {"task": "download-backups"}
        with mlflow.start_run(nested=True, tags=tags):
            mlflow.run(
                project,
                entry_point="restore",
                env_manager="uv",
                parameters={"restore_databases": restore_databases},
            )

    if len(databases_list) == 1 and os.path.isfile(databases_list[0]):
        data_file = databases_list[0]
        process_file(project, data_file, unsupervised)
    else:
        with tempfile.NamedTemporaryFile() as temp_file:
            data_file = temp_file.name
            mlflow.run(
                project,
                entry_point="prepare",
                env_manager="uv",
                parameters={"data_file": data_file, "prepare_databases": databases},
            )
            process_file(project, data_file, unsupervised)


def process_file(project: str, data_file: str, unsupervised: bool):
    parameters = {"data_file": data_file}

    if unsupervised:
        mlflow.run(
            project,
            entry_point="unsupervised",
            env_manager="uv",
            parameters=parameters,
        )
    run = mlflow.run(
        project, entry_point="supervised", env_manager="uv", parameters=parameters
    )

    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        mlflow.run(
            project,
            entry_point="upload",
            env_manager="uv",
            parameters={"run_id": run.run_id},
        )


def main():
    parser = argparse.ArgumentParser(fromfile_prefix_chars="@")
    parser.add_argument("--restore", action="store_true", required=False)
    parser.add_argument("--unsupervised", action="store_true", required=False)
    parser.add_argument("--restore_databases", type=str)
    parser.add_argument("--databases", type=str, required=True)

    args = vars(parser.parse_args())

    databases = args["databases"]
    if not databases or not databases.strip():
        print("provide at least one database")
        sys.exit(1)

    tags = {"task": "scheduled"}
    print(f"starting scheduled training with params: {args}")
    with mlflow.start_run(tags=tags):
        real_main(**args)


if __name__ == "__main__":
    main()
