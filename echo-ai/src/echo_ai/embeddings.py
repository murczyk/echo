from typing import cast

import mlflow
import pandas as pd
from mlflow import models, sklearn
from mlflow.data.huggingface_dataset import HuggingFaceDataset
from sklearn.linear_model import LogisticRegression

from echo_ai import arrow


def train_embeddings(
    label_dict: dict[int, str],
    dataset: HuggingFaceDataset,
):
    ds = dataset.ds

    ds = ds.train_test_split(train_size=0.8)
    ds_train = arrow.to_pandas_df(ds["train"])
    ds_test = arrow.to_pandas_df(ds["test"])

    ds_train = ds_train.dropna()
    ds_test = ds_test.dropna()

    x_train = cast(pd.Series, ds_train["embeddings"])
    x_train = arrow.to_numpy_matrix(x_train)
    x_test = cast(pd.Series, ds_test["embeddings"])
    x_test = arrow.to_numpy_matrix(x_test)

    for label_index, label_name in label_dict.items():
        key = f"label_{label_index}"
        print(f"training {key} {label_name}")

        m = LogisticRegression(class_weight="balanced")
        run_tags = {
            "label": label_name,
            "model": "embeddings",
            "estimator": type(m).__name__,
        }
        with mlflow.start_run(nested=True, tags=run_tags):
            y_train = ds_train[key].to_numpy()
            m.fit(x_train, y_train)
            mlflow.log_params(m.get_params(deep=True))
            model_info = sklearn.log_model(m, name=f"embeddings-{label_name}")
            y_test = ds_test[key].to_numpy()

            models.evaluate(
                model_info.model_uri,
                x_test,
                targets=y_test,
                model_type="classifier",
            )
