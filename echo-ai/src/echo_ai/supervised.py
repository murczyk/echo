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
from mlflow.models.evaluation.evaluators import classifier
from mlflow.pyfunc import PyFuncModel

from .fasttext_model import (
    SUPERVISED_ARGS,
    FastTextPythonModel,
    get_model_params,
    get_pyfunc_model,
    get_training_args,
    log_model,
)
from .loader import slice_for_label, to_pandas_arrow

original_extract_predict_fns = classifier._extract_predict_fn_and_prodict_proba_fn  # pyright: ignore


def _patched_extract_predict_fns(model: PyFuncModel):
    predict_fn, predict_proba_fn = original_extract_predict_fns(model)

    if predict_proba_fn is None:
        model_predict_fn = model._predict_fn
        if model_predict_fn.__func__ is FastTextPythonModel.predict:

            def fun(input_data):
                params = {"method": "predict_proba"}
                return model_predict_fn(input_data, params)

            predict_proba_fn = fun

    return predict_fn, predict_proba_fn


classifier._extract_predict_fn_and_prodict_proba_fn = _patched_extract_predict_fns  # pyright: ignore


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
        print(f"converting test to pandas for label {label_name}")
        df_test = ds_test.to_pandas()
        pd_test = from_pandas(df_test, name=f"{label_name}.test", targets="label")

        train_path = to_csv(ds_train, pd_train)
        test_path = to_csv(ds_test, pd_test)

        experiment_name = f"ECHO AI Supervised for '{label_name}'"
        print(f"starting experiment {experiment_name}")
        mlflow.set_experiment(experiment_name)
        with mlflow.start_run():
            print(f"starting training for {label_name}")
            print(f"fasttext arguments: {fasttext_kwargs}")
            fasttext_model = fasttext.train_supervised(
                input=train_path, **fasttext_kwargs
            )

            model_params = get_model_params(fasttext_model)
            print(f"params: {model_params}")
            mlflow.log_params(model_params)

            name = f"supervised-{label_name}"
            model_info = log_model(fasttext_model, name=name)
            logged_model = LoggedModelInput(model_id=model_info.model_id)
            mlflow.log_input(pd_train, context="training", model=logged_model)
            mlflow.log_input(pd_test, context="testing", model=logged_model)

            positive_label = "__label__1"
            model_config = {"positive_label": positive_label, "threshold": 0.5}
            model = get_pyfunc_model(
                fasttext_model, model_config, model_id=model_info.model_id
            )

            mlflow.models.evaluate(
                model,
                pd_test,
                model_id=model_info.model_id,
                model_type="classifier",
                evaluators="default",
                evaluator_config={
                    "label_list": [False, True],
                    "pos_label": True,
                },
            )
