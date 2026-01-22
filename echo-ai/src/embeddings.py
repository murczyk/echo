import argparse

import mlflow

from echo_ai.embeddings import train_embeddings
from echo_ai.loader import LABEL_DICT, load_parquet


def real_main(args):
    data_file = args["data_file"]
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
    dataset = load_parquet(
        LABEL_DICT,
        data_file,
        embeddings=True,
        unsupervised=False,
    )
    print(f"starting training on embeddings for labels: {label_list}")
    train_embeddings(label_dict, dataset)


def main():
    parser = argparse.ArgumentParser(fromfile_prefix_chars="@")
    parser.add_argument("--labels", action="extend", nargs=1, required=False)
    parser.add_argument("data_file", type=str)
    args = vars(parser.parse_args())

    tags = {"label": "embeddings", "model": "embeddings"}
    print("starting training for embeddings model")
    with mlflow.start_run(tags=tags) as run:
        print(f"run {run.info.run_name}, id: {run.info.run_id}")
        real_main(args)


if __name__ == "__main__":
    main()
