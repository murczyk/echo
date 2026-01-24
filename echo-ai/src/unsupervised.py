import argparse
import multiprocessing

import mlflow

from echo_ai.loader import LABEL_DICT, load_parquet
from echo_ai.unsupervised import train_unsupervised


def real_main(args):
    data_file = args["data_file"]
    dataset = load_parquet(
        LABEL_DICT,
        data_file,
        embeddings=False,
        unsupervised=True,
    )
    train_unsupervised(dataset, **args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=str, default="skipgram")
    parser.add_argument("--lr", type=float)
    parser.add_argument("--dim", type=int, default=100)
    parser.add_argument("--ws", type=int)
    parser.add_argument("--epoch", type=int)
    parser.add_argument("--minCount", type=int)
    parser.add_argument("--minCountLabel", type=int)
    parser.add_argument("--minn", type=int)
    parser.add_argument("--maxn", type=int)
    parser.add_argument("--neg", type=int)
    parser.add_argument("--wordNgrams", type=int)
    parser.add_argument("--loss", type=str)
    parser.add_argument("--bucket", type=int)
    parser.add_argument("--thread", type=int, default=multiprocessing.cpu_count())
    parser.add_argument("--lrUpdateRate", type=int)
    parser.add_argument("--t", type=float)
    parser.add_argument("--verbose", type=int, default=3)
    parser.add_argument("--pretrainedVectors", type=str, default="pretrained.vec")
    parser.add_argument("--seed", type=int, default=4313)
    parser.add_argument("--labels", action="extend", nargs=1, required=False)
    parser.add_argument("data_file", type=str)
    args = vars(parser.parse_args())

    tags = {"task": "unsupervised"}
    print(f"starting training for unsupervised model, parameters: {args}")
    with mlflow.start_run(tags=tags) as run:
        print(f"run {run.info.run_name}, id: {run.info.run_id}")
        real_main(args)


if __name__ == "__main__":
    main()
