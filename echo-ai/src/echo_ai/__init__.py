import argparse
import multiprocessing
from concurrent.futures import ThreadPoolExecutor

import mlflow

from .loader import load_dataset, to_pandas_arrow
from .supervised import train_supervised
from .unsupervised import train_unsupervised

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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--unsupervised", action="store_true", default=False)
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
    parser.add_argument("--autotuneMetric", type=str)  # precisionAtRecall:80:__label__1
    parser.add_argument("--corpus", type=str, default="corpus.txt")
    parser.add_argument("--pretrainedVectors", type=str, default="pretrained.vec")
    parser.add_argument("--autotuneDuration", type=int)
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

    dataset = load_dataset(LABEL_DICT, args["data_file"])
    df = to_pandas_arrow(dataset.ds)
    print(df.head())

    if args["unsupervised"]:
        mlflow.set_experiment("ECHO AI Unsupervised")
        with mlflow.start_run() as run:
            print(f"starting training for unsupervised model: {run.info.run_id}")
            model, model_info = train_unsupervised(dataset, **args)
    else:
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
        label_list = label_dict.values()
        print(f"starting train_supervised for labels: {label_list}")
        with ThreadPoolExecutor(max_workers=multiprocessing.cpu_count()) as executor:
            train_supervised(label_dict, executor, dataset, **args)
