import argparse
import datetime
import gc
import multiprocessing
import os
import pickle
import re
from typing import Any, List

import fasttext
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from datasets import (
    ClassLabel,
    Dataset,
    DatasetDict,
    Features,
    Value,
    load_dataset,
)
from sklearn.metrics import average_precision_score, precision_recall_curve

label_dict = {
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
label_ids = list(label_dict.keys())

pat_alnum_apostrophe = re.compile(r"[\w'`\u2019\u02BC]+", re.UNICODE)


def get_split_path(args: dict[str, Any], key: str, label: str, ext=".txt") -> str:
    testFromDate = args["testFromDate"]
    trainFromDate = args["trainFromDate"]

    if trainFromDate and testFromDate:
        if key == "test":
            key = f"test-from-{testFromDate}"
        elif key == "train":
            key = f"train-from-{trainFromDate}-to-{testFromDate}"

    return os.path.join(key, f"{label}{ext}")


def take_keys(args: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {key: value for key, value in args.items() if value and key in keys}


def is_not_empty(text):
    return not "".__eq__(text)


def preprocess_text(text):
    words = pat_alnum_apostrophe.findall(text)
    return " ".join(words)


def preprocess_batched(texts):
    return {"text": [preprocess_text(text) for text in texts]}


def train_unsupervised(args, dataset: Dataset):
    if not os.path.isfile(args["corpus"]):
        dataset.to_csv(
            args["corpus"],
            num_proc=args["thread"],
            columns=["text"],
            index=False,
            header=False,
        )
    unsupervised_kwargs = take_keys(
        args,
        [
            "ws",
            "lr",
            "epoch",
            "dim",
            "minCount",
            "model",
            "neg",
            "bucket",
            "t",
            "thread",
            "verbose",
            "lrUpdateRate",
            "t",
        ],
    )
    model = fasttext.train_unsupervised(
        input=args["corpus"], model="skipgram", loss="ns", **unsupervised_kwargs
    )

    return model


def prepend_labels(examples):
    label = examples["label"].astype(float)
    text = examples["text"]
    is_not_na = ~np.isnan(label)

    label = label[is_not_na].astype(int)
    text = text[is_not_na]

    mask = label == np.bool_(True)
    text[mask] = np.char.add("__label__1 ", text[mask])
    text[~mask] = np.char.add("__label__0 ", text[~mask])
    return {"text": text, "label": label}


def generate_time_splits(
    trainFromDate, testFromDate, df: pd.DataFrame, dataset: Dataset
) -> DatasetDict:
    train_from = pd.Timestamp(trainFromDate, tz="UTC")
    test_from = pd.Timestamp(testFromDate, tz="UTC")
    datetime = df["__datetime"]

    train_start = int(datetime.searchsorted(train_from, side="right"))
    test_start = int(datetime.searchsorted(test_from, side="right"))

    ds_train = dataset.train_test_split(train_size=train_start, shuffle=False)

    ds_test = dataset.train_test_split(train_size=test_start, shuffle=False)

    train = ds_train["test"]
    test = ds_test["test"]

    print(f"train between {trainFromDate} and {testFromDate} (test)")
    print(
        f"split points {train_start} (train), {test_start} (test): {train.num_rows} train rows, {test.num_rows} test rows"
    )

    return DatasetDict({"train": train, "test": test})


def generate_splits(args, df: pd.DataFrame | None, dataset: DatasetDict):
    trainFromDate = args["trainFromDate"]
    testFromDate = args["testFromDate"]

    stratify = True
    if trainFromDate and testFromDate and df is not None:
        dataset = generate_time_splits(
            trainFromDate, testFromDate, df, dataset["train"]
        )
        stratify = False

    for label_index, label_name in label_dict.items():
        train_csv = get_split_path(args, "train", label_name)
        test_csv = get_split_path(args, "test", label_name)
        if os.path.isfile(test_csv) and os.path.isfile(train_csv):
            continue
        column_name = f"label_{label_index}"
        ds = dataset.select_columns(
            ["text", column_name, "__source", "__id", "__datetime"]
        )

        ds = ds.rename_column(column_name, "label")
        print(f"generating splits for {label_name}")

        if stratify:
            ds = ds["train"].train_test_split(
                train_size=0.8,
                seed=args["seed"],
                shuffle=True,
                stratify_by_column="label",
            )

        ds = ds.select_columns(["label", "text"])
        ds = ds.map(
            prepend_labels,
            batched=True,
            num_proc=args["thread"],
            remove_columns=["label", "text"],
        )

        if not os.path.isfile(train_csv):
            ds["train"].to_csv(
                train_csv,
                num_proc=args["thread"],
                columns=["text"],
                index=False,
                header=False,
            )

        if not os.path.isfile(test_csv):
            ds["test"].to_csv(
                test_csv,
                num_proc=args["thread"],
                columns=["text"],
                index=False,
                header=False,
            )


def train_supervised(args):
    save_dir = ""
    if "saveDir" in args:
        save_dir = args["saveDir"]

    for label_name in label_dict.values():
        train_csv = get_split_path(args, "train", label_name)

        model_name = get_split_path(args, "train", label_name, ".bin")
        model_name = os.path.join(save_dir, model_name)
        if not os.path.isfile(model_name):
            print("Training:", model_name)
            if args["autotune"]:
                test_csv = get_split_path(args, "test", label_name)
                autotune_kwargs = take_keys(
                    args,
                    [
                        "autotuneMetric",
                        "autotuneDuration",
                        "autotuneModelSize",
                        "pretrainedVectors",
                        "dim",
                        "thread",
                        "verbose",
                    ],
                )
                print(f'starting autotune on "{train_csv}" and "{test_csv}"')
                print(autotune_kwargs)
                model = fasttext.train_supervised(
                    input=train_csv,
                    loss="softmax",
                    autotuneValidationFile=test_csv,
                    autotunePredictions=2,
                    **autotune_kwargs,
                )
            else:
                print(f'starting train_supervised on "{train_csv}"')
                supervised_kwargs = take_keys(
                    args,
                    [
                        "ws",
                        "lr",
                        "epoch",
                        "dim",
                        "wordNgrams",
                        "minCount",
                        "minCountLabel",
                        "minn",
                        "maxn",
                        "neg",
                        "loss",
                        "bucket",
                        "lrUpdateRate",
                        "t",
                        "pretrainedVectors",
                        "verbose",
                        "thread",
                    ],
                )
                print(supervised_kwargs)
                model = fasttext.train_supervised(
                    input=train_csv,
                    loss="softmax",
                    **supervised_kwargs,
                )
            os.makedirs(os.path.dirname(model_name), exist_ok=True)
            model.save_model(model_name)
            del model
            gc.collect()


def write_word_vectors(path, model):
    words = model.get_words()
    num_words = len(words)
    dim = model.get_dimension()

    print(f"saving word vectors (len={num_words}, dim={dim}) to {path}...")
    with open(path, "w") as f:
        f.write(f"{num_words} {dim}\n")
        for w in words:
            f.write(w)
            f.write(" ")

            v = model.get_word_vector(w)
            vstr = " ".join(map(str, v))
            f.write(vstr)
            f.write("\n")


def test_label(job) -> dict:
    split, args, label_name, target_recall = job
    save_dir = ""
    if "saveDir" in args:
        save_dir = args["saveDir"]
    test_cache_name = os.path.join(
        save_dir, get_split_path(args, "train", label_name, f".eval-on-{split}.pkl")
    )

    if os.path.isfile(test_cache_name):
        with open(test_cache_name, "rb") as cache:
            res = pickle.load(cache)
        return res

    model_name = os.path.join(
        save_dir, get_split_path(args, "train", label_name, ".bin")
    )
    model = fasttext.load_model(model_name)

    input = get_split_path(args, split, label_name)
    print(f"testing {save_dir} on {input}:")
    meter = model.get_meter(input, k=2)
    label_id = model.get_label_id("__label__1")
    precision_at_recall = meter.m.precisionAtRecallLabel(label_id, target_recall)
    print(
        f"precision_at_recall ({target_recall:.2f}) for {input} is: {precision_at_recall:.3f}"
    )
    y_score, y_true = zip(*meter.m.scoreVsTrue(label_id))
    del model
    gc.collect()

    y_score = np.array(y_score)
    y_true = np.array(y_true)
    ap = average_precision_score(y_true, y_score)
    precision, recall, threshold = precision_recall_curve(y_true, y_score)

    res = {
        "ap": ap,
        "y_true": y_true,
        "y_score": y_score,
        "recall": recall,
        "precision": precision,
        "threshold": threshold,
        "target_recall": target_recall,
        "precision_at_recall": precision_at_recall,
    }
    os.makedirs(os.path.dirname(test_cache_name), exist_ok=True)
    with open(test_cache_name, "wb") as cache:
        os.makedirs(os.path.dirname(test_cache_name), exist_ok=True)
        pickle.dump(res, cache, protocol=pickle.HIGHEST_PROTOCOL)

    return res


def plot_precision_recall(args, split: str, save_dir: str, results: list[dict]):
    plt.figure(figsize=(12, 10))
    for label_index, label_name in label_dict.items():
        values = results[label_index]
        ap = values["ap"]
        recall = values["recall"]
        precision = values["precision"]
        plt.plot(recall, precision, label=f"{label_name} (AP={ap:.3f})")

    plt.grid(True)
    plt.xlabel("Recall")
    plt.ylabel("Precision")

    plt.legend(loc="lower left")
    fig_path = os.path.join(
        save_dir,
        get_split_path(args, "train", "Precision–Recall", f".eval-on-{split}.png"),
    )
    plt.title(fig_path)
    plt.savefig(fig_path)
    plt.close()


def plot_threshold_recall(args, split: str, save_dir: str, results: list[dict]):
    plt.figure(figsize=(12, 10))
    for label_index, label_name in label_dict.items():
        values = results[label_index]
        recall = values["recall"][:-1]
        threshold = values["threshold"]
        target_recall = values["target_recall"]
        precision_at_recall = values["precision_at_recall"]

        mask = np.argwhere(recall >= 0.8)
        max_threshold = np.max(threshold[mask])

        plt.plot(
            recall,
            threshold,
            label=f"{label_name} {target_recall:.1f}r={max_threshold:.3f}th, p({precision_at_recall:.3f})",
        )

    plt.grid(True)
    plt.xlabel("Recall")
    plt.ylabel("Threshold")

    plt.legend(loc="lower left")
    fig_path = os.path.join(
        save_dir,
        get_split_path(args, "train", "Threshold–Recall", f".eval-on-{split}.png"),
    )
    plt.title(fig_path)
    plt.savefig(fig_path)
    plt.close()


def test_models(pool, split, args, labels, target_recall=0.8) -> List[dict]:
    jobs = [(split, args, label, target_recall) for label in labels]
    return pool.map(test_label, jobs)


def train_test_run(pool, args: dict):
    train_supervised(args)

    save_dir = ""
    if "saveDir" in args:
        save_dir = args["saveDir"]

    test_results = test_models(pool, "test", args, label_dict.values())
    plot_precision_recall(args, "test", save_dir, test_results)
    plot_threshold_recall(args, "test", save_dir, test_results)
    train_results = test_models(pool, "train", args, label_dict.values())
    plot_precision_recall(args, "train", save_dir, train_results)
    plot_threshold_recall(args, "train", save_dir, train_results)
    return {"test_results": test_results, "train_results": train_results}


def plot_param_sensitivity(split, axis_x, axis_y, x_label, metric):
    plt.figure(figsize=(12, 10))

    dates = axis_x[0] is datetime.date
    if dates:
        plt.gca().xaxis.set_major_formatter(mdates.DateFormatter("%d.%m.%Y"))
        plt.gca().xaxis.set_major_locator(mdates.DayLocator())

    for label_index, label_name in label_dict.items():
        plot_x = axis_x
        plot_y = []
        for y_val in axis_y:
            label_results = y_val[label_index]
            label_metric = label_results[metric]
            plot_y.append(label_metric)
        plt.plot(plot_x, plot_y, label=label_name)

    num_labels = len(label_dict)
    plt.grid(True)
    plt.xlabel(x_label)
    if dates:
        plt.gcf().autofmt_xdate()
    else:
        plt.xticks(axis_x)

    plt.ylabel(metric)
    plt.title(f"{x_label}-AP plot for {num_labels} FastText Models in {split}")
    plt.legend(loc="lower left")
    plt.savefig(f"{x_label}–{metric}-{split}.png")
    plt.close()


def test_date_splits(pool, df, dataset, args, range, param, metric):
    val_y_test = []
    val_y_train = []

    for val in range:
        args = args.copy()
        args["trainFromDate"] = val.isoformat()
        generate_splits(args, df, dataset)

        test_results, train_results = train_test_run(pool, args).values()
        val_y_test.append(test_results)
        val_y_train.append(train_results)

    if len(range) > 1:
        plot_param_sensitivity("test", range, val_y_test, param, metric)
        plot_param_sensitivity("train", range, val_y_train, param, metric)


def test_hyper_paramater(pool, args, template, range, param, metric):
    val_y_test = []
    val_y_train = []

    for val in range:
        args = args.copy()
        args["saveDir"] = template(val)
        args[param] = val
        test_results, train_results = train_test_run(pool, args).values()
        val_y_test.append(test_results)
        val_y_train.append(train_results)

    if len(range) > 1:
        plot_param_sensitivity("test", range, val_y_test, param, metric)
        plot_param_sensitivity("train", range, val_y_train, param, metric)


def main(args):
    features = {
        "text": Value("string"),
        "__source": Value("string"),
        "__id": Value("int64"),
        "__datetime": Value("timestamp[s, tz=UTC]"),
    }
    for label_id in label_ids:
        features[f"label_{label_id}"] = ClassLabel(num_classes=2)
    dataset: DatasetDict = load_dataset(
        "parquet",
        data_files=args["datafile"],
        features=Features(features),
    )
    dataset = dataset.map(
        preprocess_batched,
        input_columns=["text"],
        batched=True,
        num_proc=args["thread"],
        remove_columns="text",
    )
    dataset = dataset.filter(
        is_not_empty, input_columns=["text"], num_proc=args["thread"]
    )

    if not os.path.isfile(args["pretrainedVectors"]):
        model = train_unsupervised(args, dataset["train"])
        write_word_vectors(args["pretrainedVectors"], model)

    dataset.set_format("numpy")
    pool = multiprocessing.Pool()

    df = None
    trainFromDate = args["trainFromDate"]
    testFromDate = args["testFromDate"]
    if trainFromDate and testFromDate:
        dataset = dataset.sort("__datetime")
        df = dataset["train"].to_pandas()

        trainFromDate = datetime.date.fromisoformat(trainFromDate)
        testFromDate = datetime.date.fromisoformat(testFromDate)

        min_days = datetime.timedelta(days=args["minDays"])
        step = datetime.timedelta(days=args["stepDays"])
        to = testFromDate - min_days
        range = []
        while trainFromDate < to:
            range.append(trainFromDate)
            trainFromDate += step
        range.append(to)
        test_date_splits(pool, df, dataset, args.copy(), range, "trainFromDate", "ap")
    else:
        generate_splits(args, None, dataset)

        # lr = np.linspace(0.01, 0.1, num=10).tolist()
        # test_hyper_paramater(pool, args.copy(), lambda x: f'lr_{x:.2f}', lr, 'lr', 'ap')
        # epoch = range(5, 25)
        # test_hyper_paramater(pool, args.copy(), lambda x: f'epoch_{x}', epoch, 'epoch', 'ap')
        wordNgrams = [3]
        test_hyper_paramater(
            pool,
            args.copy(),
            lambda x: f"wordNgrams_{x}",
            wordNgrams,
            "wordNgrams",
            "ap",
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--thread", type=int, default=multiprocessing.cpu_count())
    parser.add_argument("--seed", type=int, default=4313)
    parser.add_argument("--lr", type=float)
    parser.add_argument("--ws", type=int)
    parser.add_argument("--dim", type=int, default=100)
    parser.add_argument("--epoch", type=int)
    parser.add_argument("--minCount", type=int)
    parser.add_argument("--wordNgrams", type=int)
    parser.add_argument("--verbose", type=int, default=3)
    parser.add_argument("--autotune", action="store_true", default=False)
    parser.add_argument(
        "--autotuneMetric", type=str, default="precisionAtRecall:80:__label__1"
    )
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
    parser.add_argument("--trainFromDate", type=str)
    parser.add_argument("--testFromDate", type=str)
    parser.add_argument("--stepDays", type=int, default=7)
    parser.add_argument("--minDays", type=int, default=7)
    parser.add_argument("datafile", nargs="+")
    args = vars(parser.parse_args())
    main(args)
