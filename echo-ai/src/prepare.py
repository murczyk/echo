import argparse
import tempfile

import duckdb
import mlflow

from echo_ai.prepare import fetch_from_postgres


def real_main(args):
    databases = args["databases"].split(None)
    file_name = args["file_name"]

    with tempfile.TemporaryDirectory() as temp_dir:
        config = {
            "preserve_insertion_order": False,
            "temp_directory": temp_dir,
        }
        with duckdb.connect(config=config) as con:
            fetch_from_postgres(con, databases, file_name)


def main():
    parser = argparse.ArgumentParser(fromfile_prefix_chars="@")
    parser.add_argument(
        "-o",
        "--output",
        dest="file_name",
        type=str,
        help="Name of the output file (e.g., results.parquet)",
    )
    parser.add_argument("databases", type=str)
    args = vars(parser.parse_args())
    tags = {"task": "prepare"}
    print("starting data file preparation")
    with mlflow.start_run(tags=tags):
        mlflow.log_params(args)
        real_main(args)


if __name__ == "__main__":
    main()
