import argparse
import shutil
import signal
import sys
import tempfile
from functools import partial
from pathlib import Path

import mlflow

from echo_ai.lake import Lake


def signal_handler(temp_dir, lake: Lake, signum, frame):
    lake.close()
    shutil.rmtree(temp_dir, ignore_errors=True)
    sys.exit(1)


def refresh(temp_dir: str, databases: str):
    if databases:
        databases_list = databases.split(None)
        if databases_list:
            print("creating connection to datalake", flush=True)
            lake = Lake(temp_directory=temp_dir)
            handler = partial(signal_handler, temp_dir, lake)
            signal.signal(signal.SIGTERM, handler)
            signal.signal(signal.SIGINT, handler)
            try:
                refresh_datalake(lake, databases_list)
            finally:
                lake.close()


def real_main(unsupervised: str, databases: str):
    src = Path(__file__).parent
    project = str(src.parent)

    with tempfile.TemporaryDirectory() as temp_dir:
        refresh(temp_dir, databases)

    flag_unsupervised = False
    if unsupervised == "true":
        flag_unsupervised = True

    process_file(project, flag_unsupervised)


def refresh_datalake(lake: Lake, databases_list: list[str]):
    print("creating lake schema", flush=True)
    lake.create_schema_if_not_exists()

    for db in databases_list:
        print(f"trying to attach local '{db}'", flush=True)
        try:
            lake.attach_local(db)
            print(f"attached local '{db}'", flush=True)
        except:
            print(f"trying to attach remote '{db}'", flush=True)
            lake.attach_remote(db)
            print(f"attached remote '{db}'", flush=True)

        try:
            refresh_from_db(lake, db)
        finally:
            lake.detach(db)


def refresh_from_db(lake: Lake, db: str):
    print(f"merging tags from '{db}'", flush=True)
    lake.merge_tags(db)
    print(f"finished merging tags from '{db}'", flush=True)

    print(f"merging tags keywords from '{db}'", flush=True)
    lake.merge_tag_keywords(db)
    print(f"finished merging tag keywords from '{db}'", flush=True)

    print(f"merging inbox item tags from '{db}'", flush=True)
    lake.merge_inbox_item_tags(db)
    print(f"finished merging inbox item tags from '{db}'", flush=True)

    print(f"inserting model errors from '{db}'", flush=True)
    lake.insert_model_error(db)
    print(f"finished model errors from '{db}'", flush=True)

    print(f"inserting inbox messages from '{db}'", flush=True)
    lake.insert_inbox_message(db)
    print(f"finished inserting inbox messages from '{db}'", flush=True)


def process_file(project: str, unsupervised: bool):

    if unsupervised:
        mlflow.run(
            project,
            entry_point="unsupervised",
            env_manager="uv",
        )
    run = mlflow.run(project, entry_point="supervised", env_manager="uv")

    mlflow.run(
        project,
        entry_point="upload",
        env_manager="uv",
        parameters={"run_id": run.run_id},
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--unsupervised", type=str, default="false")
    parser.add_argument("--databases", type=str, required=False)

    args = vars(parser.parse_args())

    tags = {"task": "scheduled"}
    print(f"starting scheduled training with params: {args}", flush=True)
    with mlflow.start_run(tags=tags):
        real_main(**args)


if __name__ == "__main__":
    main()
