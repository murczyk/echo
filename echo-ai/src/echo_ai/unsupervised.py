import multiprocessing
import os

import fasttext
import mlflow
from mlflow.data.huggingface_dataset import HuggingFaceDataset
from mlflow.entities.logged_model_input import LoggedModelInput
from mlflow.tracking.fluent import _initialize_logged_model

from .fasttext_model import FLAVOR_NAME, log_model


def get_unsupervised_args(args):
    arg_names = [
        "model",
        "lr",
        "dim",
        "ws",
        "epoch",
        "minCount",
        "minCountLabel",
        "minn",
        "maxn",
        "neg",
        "wordNgrams",
        "loss",
        "bucket",
        "thread",
        "lrUpdateRate",
        "t",
        "label",
        "verbose",
        "pretrainedVectors",
    ]
    return {
        key: value
        for key, value in args.items()
        if key in arg_names and value is not None
    }


def train_unsupervised(dataset: HuggingFaceDataset, **kwargs):
    num_proc = kwargs.get("thread", multiprocessing.cpu_count())

    corpus = f"{dataset.digest}.corpus.txt"
    if not os.path.isfile(corpus):
        dataset.ds.to_csv(
            corpus,
            num_proc=num_proc,
            columns=["text"],
            index=False,
            header=False,
        )

    pretrained_vectors = kwargs.get("pretrainedVectors", "pretrained.vec")
    del kwargs["pretrainedVectors"]
    args = get_unsupervised_args(kwargs)

    print(args)
    model = fasttext.train_unsupervised(input=corpus, **args)

    params = args.copy()
    del params["verbose"]
    del params["thread"]

    mlflow.log_params(params)

    name = "unsupervised"
    model_info = log_model(model, name=name, pretrained_vectors=pretrained_vectors)
    logged_model = LoggedModelInput(model_id=model_info.model_id)
    mlflow.log_input(dataset, context="pretraining", model=logged_model)
    mlflow.log_metric(
        "num_words", len(model.words), model_id=model_info.model_id, dataset=dataset
    )

    return model, model_info
