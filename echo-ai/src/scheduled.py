import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import mlflow

from echo_ai.prepare import fetch_from_postgres


def real_main(
    unsupervised: bool, restore: bool, restore_databases: str, databases: str
):
    databases_list = databases.split(None)
    if restore or restore_databases:
        tags = {"task": "download-backups"}
        with mlflow.start_run(nested=True, tags=tags):
            print(f"downloading and restoring databases {restore_databases}")
            restore_status = subprocess.run(
                ["./train-download-backups.sh", restore_databases],
                cwd="/usr/local/echo-ai-train",
            )
            restore_status.check_returncode()

    if len(databases_list) == 1 and os.path.isfile(databases_list[0]):
        data_file = databases_list[0]
        process_file(data_file, unsupervised)
    else:
        with tempfile.NamedTemporaryFile(suffix=".parquet") as temp_file:
            data_file = temp_file.name
            with mlflow.start_run(nested=True, tags={"task": "prepare"}):
                print(
                    f"preparing data file '{data_file}' for databases: {databases_list}"
                )
                fetch_from_postgres(databases_list, data_file)
                process_file(data_file, unsupervised)


def process_file(data_file: str, unsupervised: bool):
    parameters = {"data_file": data_file}

    src = Path(__file__).parent
    project = str(src.parent)

    if unsupervised:
        mlflow.run(
            project,
            entry_point="unsupervised",
            env_manager="uv",
            parameters=parameters,
        )
    mlflow.run(
        project, entry_point="supervised", env_manager="uv", parameters=parameters
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
