import os

import fasttext
import mlflow
from mlflow.data.huggingface_dataset import HuggingFaceDataset
from mlflow.entities.logged_model_input import LoggedModelInput

from .fasttext_model import (
    UNSUPERVISED_ARGS,
    get_model_params,
    get_training_args,
    log_model,
)


def train_unsupervised(dataset: HuggingFaceDataset, **kwargs):
    corpus = f"corpus.{dataset.digest}.txt"

    if os.path.isfile(corpus):
        print(f"found existing corpus file: '{corpus}', reusing")
    else:
        print(f"creating new corpus file: '{corpus}'")
        dataset.ds.to_csv(
            corpus,
            columns=["text"],
            index=False,
            quoting=None,
            lineterminator="\n",
            header=False,
        )

    pretrained_vectors = kwargs.get("pretrainedVectors", "pretrained.vec")

    fasttext_kwargs = get_training_args(UNSUPERVISED_ARGS, **kwargs)

    print(f"fasttext arguments: {fasttext_kwargs}")
    model = fasttext.train_unsupervised(input=corpus, **fasttext_kwargs)

    model_params = get_model_params(model)

    print(f"params: {model_params}")
    mlflow.log_params(model_params)

    name = "unsupervised"
    model_info = log_model(model, name=name, pretrained_vectors=pretrained_vectors)
    logged_model = LoggedModelInput(model_id=model_info.model_id)
    mlflow.log_input(dataset, context="pretraining", model=logged_model)
    mlflow.log_metric(
        "num_words", len(model.words), model_id=model_info.model_id, dataset=dataset
    )

    return model, model_info
