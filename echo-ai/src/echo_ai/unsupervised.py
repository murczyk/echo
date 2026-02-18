import fasttext
import mlflow
from mlflow.data.pandas_dataset import from_pandas
from mlflow.entities.logged_model_input import LoggedModelInput

from echo_ai import arrow, quack
from echo_ai.lake import Lake

from .fasttext_model import (
    UNSUPERVISED_ARGS,
    get_model_params,
    get_training_args,
    log_model,
)


def train_unsupervised(lake: Lake, **kwargs):
    seed = kwargs.get("seed", 4507)
    shuffle = kwargs.get("shuffle", True)
    rel = lake.messages_including_unlabeled(shuffle=shuffle, seed=seed)
    count = quack.count_star(rel)
    print(f"found {count} training rows")
    df = quack.to_df_arrow(rel.select("text").limit(1000))
    print(df.head())
    dataset = from_pandas(
        df,
        name="corpus",
        digest=arrow.digest(df, str(count)),
    )
    corpus = lake.to_plain_text(rel, dataset)

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
