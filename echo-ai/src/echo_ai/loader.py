import multiprocessing
import re
from pathlib import Path

import datasets
import pyarrow as pa
import pyarrow.compute as pc
from datasets import ClassLabel, Dataset, Features, List, Value
from mlflow.data.huggingface_dataset import HuggingFaceDataset, from_huggingface
from mlflow.data.sources import LocalArtifactDatasetSource

from echo_ai import arrow

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
pat_alnum_apostrophe = re.compile(r"[\w`'’ʼ]+", re.UNICODE)


def preprocess_text(text: str) -> str:
    words = pat_alnum_apostrophe.findall(text.lower())
    return " ".join(words)


def preprocess_batched(texts: list[str]):
    return {"text": [text for text in map(preprocess_text, texts)]}


def text_not_empty(t: pa.Table, unsupervised: bool):
    s = arrow.to_pandas_series(t["text"])

    mask = s != ""
    if not unsupervised:
        l_count = pc.list_value_length(t["labels"])  # pyright: ignore
        l_count_series = arrow.to_pandas_series(l_count)
        mask = mask & (l_count_series > 0)

    return pa.array(mask)


def prepend_labels(t: pa.Table):
    df = arrow.to_pandas_df(t)
    df.dropna(subset=["label"], inplace=True)

    label = df["label"]
    text = df["text"]

    with_label = label == 1
    text[with_label] = "__label__1 " + text[with_label]

    without_label = label == 0
    text[without_label] = "__label__0 " + text[without_label]

    return pa.Table.from_pandas(df, preserve_index=False)


def slice_for_label(ds: Dataset, label_column_name: str):
    ds = ds.rename_column(label_column_name, "label")
    ds = ds.select_columns(["text", "label"])
    ds = ds.with_format("arrow")
    ds = ds.map(
        prepend_labels,
        batched=True,
        num_proc=multiprocessing.cpu_count(),
        remove_columns=["text", "label"],
    )
    ds = ds.select_columns(["text", "label"])

    return ds


def load_parquet(
    label_dict: dict[int, str],
    data_file: str,
    embeddings: bool = False,
    unsupervised: bool = False,
) -> HuggingFaceDataset:
    features = {
        "__source": Value("string"),
        "__id": Value("int64"),
        "__created_at": Value("timestamp[us, tz=UTC]"),
        "__datetime": Value("timestamp[us, tz=UTC]"),
        "__tags": List(Value("int64")),
        "labels": List(
            ClassLabel(num_classes=len(LABEL_DICT), names=list(LABEL_DICT.values()))
        ),
        "text": Value("string"),
    }
    for label_index in label_dict.keys():
        features[f"label_{label_index}"] = ClassLabel(num_classes=2)
    if embeddings:
        features["embeddings"] = List(Value("float32"))  # pyright: ignore
    dataset_dict = datasets.load_dataset(
        "parquet",
        data_files=data_file,
        features=Features(features),
    )

    hf_dataset = dataset_dict["train"]

    hf_dataset = hf_dataset.with_format(None).map(
        preprocess_batched,
        input_columns=["text"],
        batched=True,
        num_proc=multiprocessing.cpu_count(),
        remove_columns="text",
    )
    hf_dataset = hf_dataset.with_format("arrow").filter(
        lambda t: text_not_empty(t, unsupervised), batched=True
    )

    dataset = from_huggingface(
        hf_dataset,
        data_files=data_file,
        name=Path(data_file).stem,
        source=LocalArtifactDatasetSource(data_file),
    )
    return dataset
