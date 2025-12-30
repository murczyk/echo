import multiprocessing
import os
from concurrent.futures import ThreadPoolExecutor

import fasttext
import mlflow
import mlflow.models
from datasets import Dataset, DatasetDict
from mlflow.data.huggingface_dataset import HuggingFaceDataset
from mlflow.data.pandas_dataset import PandasDataset, from_pandas
from mlflow.entities.logged_model_input import LoggedModelInput

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
from .loader import slice_for_label, to_pandas_arrow


def to_csv(ds: Dataset, pd: PandasDataset) -> str:
    path = f"{pd.name}.{pd.digest}.txt"
    if not os.path.isfile(path):
        ds.to_csv(
            path,
            columns=["text"],
            index=False,
            header=False,
        )

    return path


def train_supervised(
    label_dict: dict[int, str],
    executor: ThreadPoolExecutor,
    dataset: HuggingFaceDataset,
    **kwargs,
):
    fasttext_kwargs = get_training_args(SUPERVISED_ARGS, **kwargs)

    jobs = []

    seed = kwargs.get("seed")
    stratify = kwargs.get("stratify", True)
    train_size = kwargs.get("train_size", 0.8)
    shuffle = kwargs.get("shuffle", True)

    if stratify:
        for label_index, label_name in label_dict.items():
            label_column_name = f"label_{label_index}"

            print(f"preparing train and test slices for label {label_name}")
            ds = slice_for_label(dataset.ds, label_column_name)

            print(f"scheduled train and test split for label {label_name}")
            dataset_dict_future = executor.submit(
                lambda: ds.train_test_split(
                    train_size=train_size,
                    seed=seed,
                    shuffle=True,
                    stratify_by_column="label",
                )
            )

            jobs.append(
                {
                    "label_index": label_index,
                    "label_name": label_name,
                    "dataset_dict_future": dataset_dict_future,
                }
            )

    else:
        print("preparing split for all labels")
        ds_dict = dataset.ds.train_test_split(
            train_size=train_size, seed=seed, shuffle=shuffle
        )
        for label_index, label_name in label_dict.items():
            label_column_name = f"label_{label_index}"

            print(f"preparing train split for label {label_name}")
            ds_train = slice_for_label(ds_dict["train"], label_column_name)

            print(f"preparing test split for label {label_name}")
            ds_test = slice_for_label(ds_dict["test"], label_column_name)
            dataset_dict = DatasetDict(
                {
                    "train": ds_train,
                    "test": ds_test,
                }
            )
            jobs.append(
                {
                    "label_index": label_index,
                    "label_name": label_name,
                    "dataset_dict": dataset_dict,
                }
            )

    eval_jobs = []

    for job in jobs:
        label_index = job["label_index"]
        label_name = job["label_name"]

        if "dataset_dict" in job:
            dataset_dict = job["dataset_dict"]
        else:
            print(f"waiting for train and test split for label {label_name}")
            dataset_dict = job["dataset_dict_future"].result()

        ds_train = dataset_dict["train"]
        df_train = to_pandas_arrow(ds_train)
        pd_train = from_pandas(df_train, name=f"{label_name}.train", targets="label")

        ds_test = dataset_dict["test"]
        df_test = to_pandas_arrow(ds_test)
        pd_test = from_pandas(df_test, name=f"{label_name}.test", targets="label")

        train_path = to_csv(ds_train, pd_train)
        test_path = to_csv(ds_test, pd_test)

        experiment_name = f"ECHO AI Supervised for '{label_name}'"
        print(f"starting experiment {experiment_name}")
        mlflow.set_experiment(experiment_name)
        with mlflow.start_run() as run:
            print(f"starting training for {label_name}")
            print(f"fasttext arguments: {fasttext_kwargs}")
            fasttext_model = fasttext.train_supervised(
                input=train_path, **fasttext_kwargs
            )

            model_params = get_model_params(fasttext_model)
            print(f"params: {model_params}")
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

        mlflow.set_experiment("ECHO AI Supervised")
        with mlflow.start_run():
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
