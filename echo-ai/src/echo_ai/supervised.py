import datetime
import multiprocessing
import sys
from typing import cast

import fasttext
import humanfriendly
import mlflow
from mlflow.data.pandas_dataset import from_pandas
from mlflow.entities.logged_model_input import LoggedModelInput

from echo_ai import arrow, quack
from echo_ai.evaluate import (
    evaluate_model,
    plot_precision_recall,
    plot_threshold_recall,
)
from echo_ai.lake import Lake

from .fasttext_model import (
    SUPERVISED_ARGS,
    get_cutoff_for_file_size,
    get_model_params,
    get_training_args,
    log_model,
)


def train_model(return_dict: dict, job: dict):
    experiment_id = job["experiment_id"]
    run_id = job["run_id"]
    mlflow.set_experiment(experiment_id=experiment_id)
    mlflow.start_run(run_id=run_id)

    fasttext_kwargs = job["fasttext_kwargs"]
    len_test = job["len_test"]
    test_path = job["test_path"]
    autotuneMetric = fasttext_kwargs.get("autotuneMetric")
    autotuneModelSize = fasttext_kwargs.get("autotuneModelSize")

    if autotuneMetric and len_test > 0:
        fasttext_kwargs["autotuneValidationFile"] = test_path
    else:
        fasttext_kwargs.pop("autotuneValidationFile", None)
        fasttext_kwargs.pop("autotuneDuration", None)
        fasttext_kwargs.pop("autotunePredictions", None)
        fasttext_kwargs.pop("autotuneDuration", None)
        fasttext_kwargs.pop("autotuneModelSize", None)

    train_path = job["train_path"]
    print(f"fasttext arguments: {fasttext_kwargs}", flush=True)
    fasttext_model = fasttext.train_supervised(input=train_path, **fasttext_kwargs)

    if autotuneModelSize and not autotuneMetric:
        qnorm = False
        qout = False
        retrain = True
        file_size = humanfriendly.parse_size(autotuneModelSize, binary=True)
        cutoff = get_cutoff_for_file_size(
            fasttext_model, qnorm=qnorm, qout=qout, file_size=file_size
        )
        q_params = {
            "qnorm": qnorm,
            "qout": qout,
            "file_size": file_size,
            "cutoff": cutoff,
            "retrain": retrain,
        }
        mlflow.log_params(q_params)
        print(f"starting quantize arguments: {q_params}", flush=True)

        fasttext_model.quantize(
            input=train_path,
            retrain=retrain,
            cutoff=cutoff,
            qnorm=qnorm,
            qout=qout,
            thread=fasttext_kwargs["thread"],
        )
        print("finished quantize", flush=True)

    label_name = job["label_name"]
    model_params = get_model_params(fasttext_model)
    print(f"params: {model_params}", flush=True)
    model_params["label_name"] = label_name
    mlflow.log_params(model_params)

    name = f"supervised-{label_name}"
    model_info = log_model(
        fasttext_model,
        name=name,
        model_type="classifier",
    )
    del fasttext_model
    return_dict["model_id"] = model_info.model_id
    return_dict["model_uri"] = model_info.model_uri


def train_supervised(
    lake: Lake,
    label_dict: dict[int, str],
    args,
):
    fasttext_kwargs = get_training_args(SUPERVISED_ARGS, **args)

    seed = args.get("seed", 4507)
    shuffle = args.get("shuffle", True)
    print(f"preparing training dataset, seed {seed}, shuffle {shuffle}", flush=True)
    rel = lake.create_messages_labeled_onehot(shuffle=shuffle, seed=seed)
    result = rel.max("created_at").fetchone()
    if not result:
        print("input file is empty")
        sys.exit(1)
    (created_at_max,) = result
    last_week = cast(datetime.datetime, created_at_max) - datetime.timedelta(weeks=1)
    print(f"splitting train and test at '{last_week}'", flush=True)

    and_train = f"created_at < '{last_week.isoformat()}'"
    and_test = f"created_at >= '{last_week.isoformat()}'"

    results_per_split = []
    for label_index, label_name in label_dict.items():
        label_column_name = f"label_{label_index}"

        rel_train = lake.split_for_label(label_column_name, and_train)
        train_stats = rel_train.aggregate("label, count(*) AS samples", "label")
        print(f"training samples for {label_name}: ", flush=True)
        print(train_stats, flush=True)
        df_train = quack.to_df_arrow(rel_train.limit(1000))
        (len_train,) = rel_train.count("*").fetchone()  # pyright: ignore
        print(f"{len_train} rows for {label_name} train dataset", flush=True)
        pd_train = from_pandas(
            df_train,
            name=f"{label_name}.train",
            digest=arrow.digest(df_train, str(len_train)),
            targets="label",
        )
        train_path = lake.to_plain_text(rel_train, pd_train)
        rel_test = lake.split_for_label(label_column_name, and_test)
        test_stats = rel_test.aggregate("label, count(*) AS samples", "label")
        print(f"test samples for {label_name}: ", flush=True)
        print(test_stats, flush=True)
        df_test = quack.to_df_arrow(rel_test.limit(1000))
        (len_test,) = rel_test.count("*").fetchone()  # pyright: ignore
        print(f"{len_test} rows for {label_name} test dataset", flush=True)
        pd_test = from_pandas(
            df_test,
            name=f"{label_name}.test",
            digest=arrow.digest(df_test, str(len_test)),
            targets="label",
        )
        test_path = lake.to_plain_text(rel_test, pd_test)

        tags = {"label": label_name, "task": "supervised"}
        with mlflow.start_run(nested=True, tags=tags) as run:
            print(f"starting training for {label_name}", flush=True)

            manager = multiprocessing.Manager()
            return_dict = manager.dict()
            p = multiprocessing.Process(
                target=train_model,
                args=[
                    return_dict,
                    {
                        "run_id": run.info.run_id,
                        "experiment_id": run.info.experiment_id,
                        "label_name": label_name,
                        "fasttext_kwargs": fasttext_kwargs,
                        "train_path": train_path,
                        "len_test": len_test,
                        "test_path": test_path,
                    },
                ],
            )
            p.start()
            p.join()
            model_id = return_dict["model_id"]
            model_uri = return_dict["model_uri"]

            logged_model = LoggedModelInput(model_id=model_id)
            mlflow.log_input(pd_train, context="training", model=logged_model)
            split_csv = {
                "train": train_path,
            }
            if len_test > 0:
                split_csv["test"] = test_path
            eval_results = evaluate_model(label_name, model_uri, split_csv)
            results_per_split.append(eval_results)

    results_test = [item["test"] for item in results_per_split]
    results_train = [item["train"] for item in results_per_split]
    labels = list(label_dict.values())
    plot_precision_recall(labels, "test", results_test)
    plot_threshold_recall(labels, "test", results_test)
    plot_precision_recall(labels, "train", results_train)
    plot_threshold_recall(labels, "train", results_train)
