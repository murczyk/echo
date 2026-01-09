import os
from typing import Any

import matplotlib.pyplot as plt
import mlflow
import mlflow.models
import numpy as np
import pandas as pd
from fasttext.FastText import _FastText
from mlflow.data.pandas_dataset import from_pandas
from mlflow.entities.logged_model_input import LoggedModelInput
from mlflow.pyfunc import PyFuncModel
from sklearn.metrics import average_precision_score, precision_recall_curve

POSITIVE_LABEL_NAME = "__label__1"


def run_evaluate_model(
    experiment_id: str,
    run_id: str,
    label_name: str,
    model_uri: str,
    split_csv: dict[str, str],
):
    metrics = {}
    mlflow.set_experiment(experiment_id=experiment_id)
    with mlflow.start_run(run_id=run_id):
        metrics = evaluate_model(label_name, model_uri, split_csv)
    return metrics


def evaluate_model(label_name: str, model_uri: str, split_csv: dict[str, str]):
    model = mlflow.pyfunc.load_model(model_uri)
    mlflow.set_active_model(model_id=model.model_id)
    fasttext_model = model.get_raw_model()
    results = _do_evaluate_model(label_name, model, fasttext_model, split_csv)
    labels = [label_name]
    plot_precision_recall(labels, "test", [results["test"]])
    plot_threshold_recall(labels, "train", [results["train"]])
    return results


def _do_evaluate_model(
    label_name: str,
    model: PyFuncModel,
    fasttext_model: _FastText,
    split_csv: dict[str, str],
    target_recall=0.8,
) -> dict[str, Any]:
    results = {}
    for split, dataset_path in split_csv.items():
        print(
            f"evaluating model for label {label_name} split {split} on with '{dataset_path}'"
        )

        meter = fasttext_model.get_meter(dataset_path, k=-1)
        label_id = fasttext_model.get_label_id(POSITIVE_LABEL_NAME)
        precision_at_recall = meter.m.precisionAtRecallLabel(label_id, target_recall)
        print(
            f"precision_at_recall ({target_recall:.2f}) for {split} on with '{dataset_path}' is: {precision_at_recall:.3f}"
        )
        y_score, y_true = zip(*meter.m.scoreVsTrue(label_id))

        y_score = np.array(y_score)
        y_true = np.array(y_true)
        ap = average_precision_score(y_true, y_score)
        precision, recall, threshold = precision_recall_curve(y_true, y_score)
        threshold = np.array(threshold)

        mask = np.argwhere(recall >= target_recall)
        pred_threshold = np.max(threshold[mask])
        y_pred = np.where(y_score > pred_threshold, 1, 0)

        metrics = {
            "ap": ap,
            "target_recall": target_recall,
            "precision_at_recall": precision_at_recall,
            "threshold_at_recall": pred_threshold,
        }
        plot_data = {
            # "y_true": y_true,
            # "y_score": y_score,
            # "y_pred": y_pred,
            "recall": recall,
            "precision": precision,
            "threshold": threshold,
        }
        results[split] = {"metrics": metrics, "plot_data": plot_data}

        df = pd.DataFrame({"label": y_true, "y_pred": y_pred})
        dataset_name = f"{label_name}.{split}"
        dataset_digest = dataset_path.replace(f"{dataset_name}.", "").replace(
            ".txt", ""
        )

        dataset = from_pandas(
            df,
            name=dataset_name,
            source=dataset_path,
            digest=dataset_digest,
            targets="label",
            predictions="y_pred",
        )

        logged_model = LoggedModelInput(model_id=str(model.model_id))
        mlflow.log_input(dataset, context="testing", model=logged_model)
        mlflow.log_metrics(metrics, dataset=dataset)

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
    return results


def plot_precision_recall(labels: list[str], split: str, results: list[dict]):
    fig = plt.figure(figsize=(12, 10))
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
    fig = plt.figure(figsize=(12, 10))
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
