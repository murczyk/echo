import multiprocessing
import re
from pathlib import Path

import datasets
from mlflow.data.huggingface_dataset import HuggingFaceDataset, from_huggingface

pat_alnum_apostrophe = re.compile(r"[\w'`\u2019\u02BC]+", re.UNICODE)


def preprocess_text(text: str) -> str:
    words = pat_alnum_apostrophe.findall(text)
    return " ".join(words)


def preprocess_batched(texts: list[str]):
    return {"text": [text for text in map(preprocess_text, texts) if text]}


def load_dataset(data_file: str, data_dir: str | None = None) -> HuggingFaceDataset:
    dataset_dict = datasets.load_dataset(
        "parquet", data_files=data_file, data_dir=data_dir
    )
    hf_dataset = dataset_dict["train"].map(
        preprocess_batched,
        input_columns=["text"],
        batched=True,
        num_proc=multiprocessing.cpu_count(),
        remove_columns="text",
    )

    dataset = from_huggingface(
        hf_dataset,
        "parquet",
        name=Path(data_file).stem,
        data_files=data_file,
        data_dir=data_dir,
        source=data_file,
    )

    return dataset
