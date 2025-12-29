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

from .fasttext_model import (
    SUPERVISED_ARGS,
    FastTextModelWrapper,
    get_model_params,
    get_training_args,
    log_model,
)
from .loader import slice_for_label, to_pandas

LABEL_DICT = {
    0: "переміщення",
    1: "бпла",
    2: "звʼязок",
    3: "забезп",
    4: "арта",
    5: "втрати",
    6: "іфо",
    7: "палітра",
    8: "мораль",
    9: "зіткнення",
}


def to_csv(ds: Dataset, pd: PandasDataset) -> str:
    path = f"{pd.name}.{pd.digest}.txt"
    if not os.path.isfile(path):
        ds.to_csv(
            path,
            num_proc=multiprocessing.cpu_count(),
            columns=["text"],
            index=False,
            header=False,
        )

    return path


def train_supervised(
    executor: ThreadPoolExecutor, dataset: HuggingFaceDataset, **kwargs
):
    fasttext_kwargs = get_training_args(SUPERVISED_ARGS, **kwargs)

    jobs = []

    seed = kwargs.get("seed")
    stratify = kwargs.get("stratify", True)
    train_size = kwargs.get("train_size", 0.8)
    shuffle = kwargs.get("shuffle", True)

    if stratify:
        for label_index, label_name in LABEL_DICT.items():
            label_column_name = f"label_{label_index}"
            ds = slice_for_label(dataset.ds, label_column_name)

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
        for label_index, label_name in LABEL_DICT.items():
            print(f"preparing splits for {label_name}")
            label_column_name = f"label_{label_index}"

            ds_train = slice_for_label(ds_dict["train"], label_column_name)
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

    for job in jobs:
        label_index = job["label_index"]
        label_name = job["label_name"]
        if "dataset_dict" in job:
            dataset_dict = job["dataset_dict"]
        else:
            dataset_dict = job["dataset_dict_future"].result()

        ds_train = dataset_dict["train"]
        df_train = ds_train.to_pandas()
        pd_train = from_pandas(df_train, name=f"{label_name}.train", targets="label")

        ds_test = dataset_dict["test"]
        df_test = ds_test.to_pandas()
        pd_test = from_pandas(df_test, name=f"{label_name}.test", targets="label")

        train_path = to_csv(ds_train, pd_train)
        test_path = to_csv(ds_test, pd_test)

        mlflow.set_experiment(f"ECHO AI Supervised for '{label_name}'")
        with mlflow.start_run():
            print(f"starting training for {label_name}")
            print(f"fasttext arguments: {fasttext_kwargs}")
            model = fasttext.train_supervised(input=train_path, **fasttext_kwargs)

            model_params = get_model_params(model)
            print(f"params: {model_params}")
            mlflow.log_params(model_params)

            name = f"supervised-{label_name}"
            model_info = log_model(model, name=name)
            logged_model = LoggedModelInput(model_id=model_info.model_id)
            mlflow.log_input(pd_train, context="training", model=logged_model)
            mlflow.log_input(pd_test, context="testing", model=logged_model)

            model_wrapper = FastTextModelWrapper(model)
            positive_label = "__label__1"
            predict_params = {"positive_label": "__label__1", "threshold": 0.5}
            mlflow.models.evaluate(
                lambda model_input: model_wrapper.predict(model_input, predict_params),
                pd_test,
                model_id=model_info.model_id,
                model_type="classifier",
                evaluators="default",
                predictions=positive_label,
                evaluator_config={
                    "label_list": [0, 1],
                    "pos_label": 1,
                },
            )
