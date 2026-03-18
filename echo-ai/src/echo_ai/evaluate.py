from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import mlflow
import mlflow.models
import numpy as np
import pandas as pd
from fasttext.FastText import _FastText
from mlflow.data.pandas_dataset import from_pandas
from mlflow.data.sources import LocalArtifactDatasetSource  # pyright: ignore
from mlflow.entities.logged_model_input import LoggedModelInput
from mlflow.pyfunc import PyFuncModel
from sklearn.metrics import average_precision_score, precision_recall_curve

from echo_ai.lake import Lake

POSITIVE_LABEL_NAME = "__label__1"
TARGET_RECALL = 0.8


def get_meter_metrics(
    fasttext_model: _FastText, dataset_path: str, pred_threshold: float | None = None
):
    meter = fasttext_model.get_meter(dataset_path, k=-1)
    label_id = fasttext_model.get_label_id(POSITIVE_LABEL_NAME)
    precision_at_recall = meter.m.precisionAtRecallLabel(label_id, TARGET_RECALL)

    y_score, y_true = zip(*meter.m.scoreVsTrue(label_id))

    y_score = np.array(y_score)
    y_true = np.array(y_true)
    ap = average_precision_score(y_true, y_score)
    precision, recall, threshold = precision_recall_curve(y_true, y_score)
    threshold = np.array(threshold)

    if pred_threshold is None or np.isnan(pred_threshold):
        mask = np.argwhere(recall >= TARGET_RECALL)
        pred_threshold = np.max(threshold[mask])

    y_pred = np.where(y_score > pred_threshold, 1.0, 0.0)

    metrics = {
        "ap": ap,
        "target_recall": TARGET_RECALL,
        "precision_at_recall": precision_at_recall,
        "threshold_at_recall": pred_threshold,
    }
    predictions = pd.DataFrame(
        {
            "y_true": pd.Categorical(y_true, categories=[0.0, 1.0], copy=False),
            "y_pred": pd.Categorical(y_pred, categories=[0.0, 1.0], copy=False),
        },
        copy=False,
    )
    plot_data = {
        "recall": recall,
        "precision": precision,
        "threshold": threshold,
    }
    return {"metrics": metrics, "predictions": predictions, "plot_data": plot_data}


def evaluate_trained_model(label_name: str, model_uri: str, split_csv: dict[str, str]):
    labels = [label_name]
    model = mlflow.pyfunc.load_model(model_uri)
    mlflow.set_active_model(model_id=model.model_id)

    validation_results = do_evaluate_split(
        label_name, model, "validation", split_csv["validation"]
    )
    validation_metrics = validation_results["metrics"]
    plot_precision_recall(labels, "validation", [validation_results])
    plot_threshold_recall(labels, "validation", [validation_results])

    pred_threshold = validation_metrics["threshold_at_recall"]

    test_results = do_evaluate_split(
        label_name, model, "test", split_csv["test"], pred_threshold
    )

    test_dataset_name = f"{label_name}.test"
    test_dataset_path = split_csv["test"]
    test_dataset_digest = (
        Path(test_dataset_path)
        .stem.replace(f"{test_dataset_name}.", "")
        .replace(".txt", "")
    )

    dataset = from_pandas(
        test_results["predictions"],
        name=test_dataset_name,
        source=LocalArtifactDatasetSource(test_dataset_path),
        digest=test_dataset_digest,
        targets="y_true",
        predictions="y_pred",
    )

    logged_model = LoggedModelInput(model_id=str(model.model_id))
    mlflow.log_input(dataset, context="testing", model=logged_model)
    mlflow.log_metrics(test_results["metrics"], dataset=dataset)

    mlflow.models.evaluate(
        data=dataset,
        model_id=model.model_id,
        model_type="classifier",
        evaluators="default",
        evaluator_config={
            "label_list": [0, 1],
            "pos_label": 1,
        },
    )
    plot_precision_recall(labels, "test", [test_results])
    plot_threshold_recall(labels, "test", [test_results])

    train_results = do_evaluate_split(
        label_name, model, "train", split_csv["train"], pred_threshold
    )
    plot_precision_recall(labels, "train", [train_results])
    plot_threshold_recall(labels, "train", [train_results])

    return {
        "train": train_results,
        "validation": validation_results,
        "test": test_results,
    }


def evaluate_regex_model(
    model_id, label_index: int, label_name: str, split: str, lake: Lake
):

    df = lake.evaluate_regex(label_index, split)
    dataset = from_pandas(
        df,
        name=f"{label_name}.{split}.regex",
        targets="y_true",
        predictions="y_pred",
    )
    logged_model = LoggedModelInput(model_id=str(model_id))
    mlflow.log_input(dataset, context="testing", model=logged_model)
    mlflow.models.evaluate(
        data=dataset,
        model_id=model_id,
        model_type="classifier",
        evaluators="default",
        evaluator_config={
            "label_list": [0, 1],
            "pos_label": 1,
        },
    )


def is_split(dataset_name: str | None, split: str):
    return (not dataset_name) or (not split) or (split in dataset_name)


def evaluate_model(model_id: str, split: str, dataset_path: str):
    logged_model = mlflow.get_logged_model(model_id=model_id)
    model = mlflow.pyfunc.load_model(logged_model.model_uri)

    metrics = logged_model.metrics or []
    pred_threshold = None
    for metric in metrics:
        if metric.key == "threshold_at_recall" and is_split(metric.dataset_name, split):
            pred_threshold = float(metric.value)
            break

    label_name = logged_model.params["label_name"]

    split_results = do_evaluate_split(
        label_name, model, split, dataset_path, pred_threshold
    )

    return split_results


def do_evaluate_split(
    label_name: str,
    model: PyFuncModel,
    split: str,
    dataset_path: str,
    pred_threshold: float | None = None,
) -> dict[str, Any]:
    fasttext_model = model.get_raw_model()
    print(
        f"evaluating model for label {label_name} split {split} on with '{dataset_path}'"
    )

    meter = get_meter_metrics(fasttext_model, dataset_path, pred_threshold)
    metrics = meter["metrics"]
    precision_at_recall = metrics["precision_at_recall"]

    print(
        f"precision_at_recall ({TARGET_RECALL:.2f}) for {split} on with '{dataset_path}' is: {precision_at_recall:.3f}"
    )

    return meter


def plot_precision_recall(labels: list[str], split: str, results: list[dict]):
    fig = plt.figure(figsize=(10, 6))
    for values, label_name in zip(results, labels):
        metrics = values["metrics"]
        plot_data = values["plot_data"]

        ap = metrics["ap"]
        recall = plot_data["recall"]
        precision = plot_data["precision"]
        plt.plot(recall, precision, label=f"{label_name} (AP={ap:.3f})")

    plt.grid(True)
    plt.xlabel("Recall")
    plt.ylabel("Precision")

    plt.legend(loc="lower left")
    name = f"precision-recall.{split}.png"
    plt.title(name)
    plt.close(fig)
    mlflow.log_figure(fig, name)


def plot_threshold_recall(labels: list[str], split: str, results: list[dict]):
    fig = plt.figure(figsize=(10, 6))
    for values, label_name in zip(results, labels):
        metrics = values["metrics"]
        plot_data = values["plot_data"]

        target_recall = metrics["target_recall"]
        precision_at_recall = metrics["precision_at_recall"]
        threshold_at_recall = metrics["threshold_at_recall"]

        recall = plot_data["recall"][:-1]
        threshold = plot_data["threshold"]

        plt.plot(
            recall,
            threshold,
            label=f"{label_name} {target_recall:.1f}r={threshold_at_recall:.3f}th, p({precision_at_recall:.3f})",
        )

    plt.grid(True)
    plt.xlabel("Recall")
    plt.ylabel("Threshold")

    plt.legend(loc="lower left")
    name = f"threshold–recall-{split}.png"
    plt.title(name)
    plt.close(fig)
    mlflow.log_figure(fig, name)
