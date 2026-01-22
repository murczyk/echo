import argparse
import multiprocessing
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import mlflow

from echo_ai.loader import LABEL_DICT, load_parquet
from echo_ai.supervised import train_supervised


def resolve_pretrain(pretrained_vectors, args):
    if os.path.isfile(pretrained_vectors):
        print(f"using pretrained word vectors from file '{pretrained_vectors}'")
    else:
        dim = args["dim"]
        complex_filter = f"""
            params.model IN ('cbow', 'skipgram')
            AND params.dim = {dim}
        """

        models_with_complex_filter = mlflow.search_logged_models(
            filter_string=complex_filter,
            output_format="list",
            max_results=1,
            order_by=[
                {"field_name": "creation_time", "ascending": False},
            ],
        )
        if models_with_complex_filter:
            model = models_with_complex_filter[0]
            path = f"{model.artifact_location}/{pretrained_vectors}"
            if os.path.isfile(path):
                print(f"found pretrained vectors at {path}")
                args["pretrainedVectors"] = path
            else:
                print(f"pretrained vectors '{path}' do not exist")
                sys.exit(1)
        else:
            print(f"pretrained vectors '{pretrained_vectors}' do not exist")
            sys.exit(1)


def real_main(args):
    dataset = load_parquet(
        LABEL_DICT,
        args["data_file"],
        embeddings=False,
        unsupervised=False,
    )

    label_list = args["labels"]
    label_dict = {}
    if label_list:
        label_dict = {
            key: value
            for key, value in LABEL_DICT.items()
            if value in label_list or str(key) in label_list
        }
    else:
        label_dict = LABEL_DICT.copy()
    label_list = list(label_dict.values())

    print(f"starting training for labels: {label_list}")
    pretrained_vectors = args.get("pretrainedVectors")
    if pretrained_vectors:
        resolve_pretrain(pretrained_vectors, args)

    train_supervised(label_dict, dataset, **args)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--thread", type=int, default=multiprocessing.cpu_count())
    parser.add_argument("--dim", type=int, default=100)
    parser.add_argument("--seed", type=int, default=4313)
    parser.add_argument("--model", type=str, default="skipgram")
    parser.add_argument("--lr", type=float)
    parser.add_argument("--ws", type=int)
    parser.add_argument("--epoch", type=int)
    parser.add_argument("--minCount", type=int)
    parser.add_argument("--wordNgrams", type=int)
    parser.add_argument("--verbose", type=int, default=3)
    parser.add_argument("--pretrainedVectors", type=str, default="pretrained.vec")
    parser.add_argument("--autotuneMetric", type=str)  # precisionAtRecall:80:__label__1
    parser.add_argument("--autotuneDuration", type=int)
    parser.add_argument("--autotunePredictions", type=int)
    parser.add_argument("--autotuneModelSize", type=str)
    parser.add_argument("--minCountLabel", type=int)
    parser.add_argument("--minn", type=int)
    parser.add_argument("--maxn", type=int)
    parser.add_argument("--neg", type=int)
    parser.add_argument("--bucket", type=int)
    parser.add_argument("--lrUpdateRate", type=int)
    parser.add_argument("--t", type=float)
    parser.add_argument("-l", "--labels", action="extend", nargs=1, required=False)
    parser.add_argument("data_file", type=str)
    args = vars(parser.parse_args())

    tags = {"label": "supervised", "model": "supervised"}
    print("starting training for supervised model")
    with mlflow.start_run(tags=tags) as run:
        print(f"run {run.info.run_name}, id: {run.info.run_id}")
        real_main(args)


if __name__ == "__main__":
    main()
