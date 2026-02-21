import argparse
import multiprocessing
import tempfile

import mlflow

from echo_ai.lake import Lake
from echo_ai.unsupervised import train_unsupervised


def real_main(args):
    with tempfile.TemporaryDirectory() as temp_dir:
        print("creating connection to datalake", flush=True)
        lake = Lake(temp_directory=temp_dir)
        lake.create_schema_if_not_exists()
        train_unsupervised(lake, **args)


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
    parser.add_argument("--seed", type=int, default=4507)
    args = vars(parser.parse_args())

    tags = {"task": "unsupervised"}
    print(f"starting training for unsupervised model, parameters: {args}", flush=True)
    with mlflow.start_run(tags=tags) as run:
        print(f"run {run.info.run_name}, id: {run.info.run_id}", flush=True)
        real_main(args)


if __name__ == "__main__":
    main()
