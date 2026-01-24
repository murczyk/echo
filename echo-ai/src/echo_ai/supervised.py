import datetime
import multiprocessing
import sys
from typing import cast

import fasttext
import mlflow
from duckdb import DuckDBPyConnection, DuckDBPyRelation
from mlflow.data.dataset import Dataset
from mlflow.data.pandas_dataset import from_pandas
from mlflow.entities.logged_model_input import LoggedModelInput

from echo_ai import arrow, quack
from echo_ai.evaluate import (
    plot_precision_recall,
    plot_threshold_recall,
    run_evaluate_model,
)

from .fasttext_model import (
    SUPERVISED_ARGS,
    get_model_params,
    get_training_args,
    log_model,
)


def to_csv(temp_dir: str, rel: DuckDBPyRelation, dataset: Dataset) -> str:
    path = f"{temp_dir}/{dataset.name}.{dataset.digest}.txt"
    print(f"creating file '{path}'")
    rel.select("text").to_csv(
        path,
        header=False,
        quoting=None,
    )

    return path


def define_train_test_split(
    con: DuckDBPyConnection, file: str, seed: int, shuffle: bool
):
    result = con.query(f"select max(__created_at) from {file}").fetchone()
    if not result:
        print("input file is empty")
        sys.exit(1)

    (created_at_max,) = result
    last_week = cast(datetime.datetime, created_at_max) - datetime.timedelta(weeks=1)
    print(f"splitting train and test at '{last_week}'")

    if shuffle:
        quack.define_sql_view(
            con,
            "train",
            f"select * exclude(file_row_number) from {file} where __created_at < '{last_week}' order by hash(__id + {seed})",
        )
        quack.define_sql_view(
            con,
            "test",
            f"select * exclude(file_row_number) from {file} where __created_at >= '{last_week}' order by hash(__id + {seed})",
        )
    else:
        quack.define_sql_view(
            con,
            "train",
            f"select * exclude(file_row_number) from {file} where __created_at < '{last_week}'",
        )
        quack.define_sql_view(
            con,
            "test",
            f"select * exclude(file_row_number) from {file} where __created_at >= '{last_week}'",
        )


def define_slice_for_label(con: DuckDBPyConnection, split: str, label_column_name: str):
    regex = r"[\pL\pN'’ʼ]+"
    return quack.define_sql_view(
        con,
        f"split_{split}_{label_column_name}",
        f"""
    SELECT
        '__label__' || {label_column_name}::int || ' ' || array_to_string(regexp_extract_all(lower(text), $${regex}$$), ' ') AS text,
        {label_column_name} AS label
    FROM {split}
    WHERE
        {label_column_name} IS NOT NULL
    """,
    )


def train_supervised(
    temp_dir: str,
    label_dict: dict[int, str],
    data_file: str,
    con: DuckDBPyConnection,
    args,
):
    fasttext_kwargs = get_training_args(SUPERVISED_ARGS, **args)

    file = con.from_parquet(data_file, file_row_number=True)

    jobs = []

    seed = args.get("seed", 4507)
    shuffle = args.get("shuffle", True)

    print("preparing split for all labels")
    define_train_test_split(
        con, quack.define_rel_view(file, "file"), seed=seed, shuffle=shuffle
    )
    for label_index, label_name in label_dict.items():
        label_column_name = f"label_{label_index}"
        ds_train = define_slice_for_label(con, "train", label_column_name)
        ds_test = define_slice_for_label(con, "test", label_column_name)
        jobs.append(
            {
                "label_index": label_index,
                "label_name": label_name,
                "train": ds_train,
                "test": ds_test,
            }
        )

    eval_jobs = []

    for job in jobs:
        label_index = job["label_index"]
        label_name = job["label_name"]

        rel_train = con.view(job["train"])
        df_train = quack.to_df_arrow(rel_train)
        df_train.info(verbose=True)
        pd_train = from_pandas(
            df_train,
            name=f"{label_name}.train",
            digest=arrow.digest(df_train),
            targets="label",
        )

        rel_test = con.view(job["test"])
        df_test = quack.to_df_arrow(rel_test)
        df_test.info(verbose=True)
        pd_test = from_pandas(
            df_test,
            name=f"{label_name}.test",
            digest=arrow.digest(df_test),
            targets="label",
        )

        train_path = to_csv(temp_dir, rel_train, pd_train)
        test_path = to_csv(temp_dir, rel_test, pd_test)

        tags = {"label": label_name, "task": "supervised"}
        with mlflow.start_run(nested=True, tags=tags) as run:
            print(f"starting training for {label_name}")

            if fasttext_kwargs.get("autotuneMetric"):
                fasttext_kwargs["autotuneValidationFile"] = test_path
            else:
                fasttext_kwargs.pop("autotuneValidationFile", None)
                fasttext_kwargs.pop("autotuneDuration", None)
                fasttext_kwargs.pop("autotunePredictions", None)
                fasttext_kwargs.pop("autotuneDuration", None)
                fasttext_kwargs.pop("autotuneModelSize", None)

            print(f"fasttext arguments: {fasttext_kwargs}")
            fasttext_model = fasttext.train_supervised(
                input=train_path, **fasttext_kwargs
            )

            model_params = get_model_params(fasttext_model)
            print(f"params: {model_params}")
            model_params["label_name"] = label_name
            mlflow.log_params(model_params)

            name = f"supervised-{label_name}"
            model_info = log_model(
                fasttext_model,
                name=name,
                model_type="classifier",
            )
            del fasttext_model
            logged_model = LoggedModelInput(model_id=model_info.model_id)
            mlflow.log_input(pd_train, context="training", model=logged_model)
            split_csv = {
                "train": train_path,
                "test": test_path,
            }
            experiment_id = run.info.experiment_id
            eval_jobs.append([experiment_id, label_name, model_info, split_csv])

    with multiprocessing.Pool() as pool:
        results_per_split = pool.map(process_evalute_job, eval_jobs)
        results_test = [item["test"] for item in results_per_split]
        results_train = [item["train"] for item in results_per_split]

        labels = list(label_dict.values())
        plot_precision_recall(labels, "test", results_test)
        plot_threshold_recall(labels, "test", results_test)
        plot_precision_recall(labels, "train", results_train)
        plot_threshold_recall(labels, "train", results_train)


def process_evalute_job(job):
    experiment_id, label_name, model_info, split_csv = job
    return run_evaluate_model(
        experiment_id, model_info.run_id, label_name, model_info.model_uri, split_csv
    )
