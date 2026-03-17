import multiprocessing
from typing import cast

import fasttext
import humanfriendly
import mlflow
from mlflow.data.pandas_dataset import PandasDataset, from_pandas
from mlflow.entities.logged_model_input import LoggedModelInput

from echo_ai import arrow
from echo_ai.evaluate import (
    evaluate_model,
    evaluate_regex_model,
    evaluate_trained_model,
    plot_precision_recall,
    plot_threshold_recall,
)
from echo_ai.lake import Lake
from echo_ai.registry import TrainedModel

from .fasttext_model import (
    SUPERVISED_ARGS,
    get_cutoff_for_file_size,
    get_model_params,
    get_training_args,
    log_model,
)


def train_model(return_dict: dict, job: dict):
    experiment_id = job["experiment_id"]
    run_id = job["run_id"]
    mlflow.set_experiment(experiment_id=experiment_id)
    mlflow.start_run(run_id=run_id)

    fasttext_kwargs = job["fasttext_kwargs"]
    len_tune = job["len_tune"]
    tune_path = job["tune_path"]
    autotuneMetric = fasttext_kwargs.get("autotuneMetric")
    autotuneModelSize = fasttext_kwargs.get("autotuneModelSize")

    if autotuneMetric and len_tune > 0:
        fasttext_kwargs["autotuneValidationFile"] = tune_path
    else:
        fasttext_kwargs.pop("autotuneValidationFile", None)
        fasttext_kwargs.pop("autotuneDuration", None)
        fasttext_kwargs.pop("autotunePredictions", None)
        fasttext_kwargs.pop("autotuneDuration", None)
        fasttext_kwargs.pop("autotuneModelSize", None)

    train_path = job["train_path"]
    print(f"fasttext arguments: {fasttext_kwargs}", flush=True)
    fasttext_model = fasttext.train_supervised(input=train_path, **fasttext_kwargs)

    if autotuneModelSize and not autotuneMetric:
        qnorm = False
        qout = False
        retrain = True
        file_size = humanfriendly.parse_size(autotuneModelSize, binary=True)
        cutoff = get_cutoff_for_file_size(
            fasttext_model, qnorm=qnorm, qout=qout, file_size=file_size
        )
        q_params = {
            "qnorm": qnorm,
            "qout": qout,
            "file_size": file_size,
            "cutoff": cutoff,
            "retrain": retrain,
        }
        mlflow.log_params(q_params)
        print(f"starting quantize arguments: {q_params}", flush=True)

        fasttext_model.quantize(
            input=train_path,
            retrain=retrain,
            cutoff=cutoff,
            qnorm=qnorm,
            qout=qout,
            thread=fasttext_kwargs["thread"],
        )
        print("finished quantize", flush=True)

    label_name = job["label_name"]
    model_params = get_model_params(fasttext_model)
    print(f"params: {model_params}", flush=True)
    model_params["label_name"] = label_name
    mlflow.log_params(model_params)

    step = job.pop("step", None)
    name = f"supervised-{label_name}"
    model_info = log_model(
        fasttext_model, name=name, model_type="classifier", step=step
    )
    del fasttext_model
    return_dict["model_id"] = model_info.model_id
    return_dict["model_uri"] = model_info.model_uri


def create_dataset(
    lake: Lake, label_column_name: str, label_name: str, split: str, shuffle_seed
) -> tuple[PandasDataset, str, int]:
    rel_split = lake.split_for_label(label_column_name, split, shuffle_seed)
    split_stats = rel_split.aggregate(f"""
        count(*) AS {split}_total_samples,
        count(*) filter(label = 1) AS {split}_positive_samples,
        count(*) filter(label = 0) AS {split}_negative_samples
    """).to_df()

    stats_dict = cast(dict[str, float], split_stats.iloc[0].to_dict())
    stats_dict[f"{split}_pos_neg_ratio"] = float(
        stats_dict[f"{split}_positive_samples"]
    ) / float(stats_dict[f"{split}_negative_samples"])
    mlflow.log_metrics(stats_dict)

    print(f"{split} samples for {label_name}: ", flush=True)
    print(stats_dict, flush=True)
    df_split = arrow.to_df_arrow(rel_split.limit(1000))
    (len_split,) = rel_split.count("*").fetchone()  # pyright: ignore
    print(f"{len_split} rows for {label_name} {split} dataset", flush=True)
    pd_split = from_pandas(
        df_split,
        name=f"{label_name}.{split}",
        digest=arrow.digest(df_split, str(len_split)),
        targets="label",
    )
    split_path = lake.to_plain_text(rel_split, pd_split)
    return pd_split, split_path, len_split


def train_supervised(
    lake: Lake,
    label_dict: dict[int, str],
    args,
):
    fasttext_kwargs = get_training_args(SUPERVISED_ARGS, **args)

    seed = args.get("seed", 4507)
    shuffle = args.get("shuffle", True)
    print(f"preparing datasets, seed {seed}, shuffle {shuffle}", flush=True)
    lake.create_messages_labeled_onehot()

    shuffle_seed = int(seed) if shuffle else None

    results_per_split = []
    for label_index, label_name in label_dict.items():
        label_column_name = f"label_{label_index}"

        pd_train, train_path, len_train = create_dataset(
            lake, label_column_name, label_name, "train", shuffle_seed
        )
        pd_validation, validation_path, len_validation = create_dataset(
            lake, label_column_name, label_name, "validation", shuffle_seed
        )
        pd_test, test_path, len_test = create_dataset(
            lake, label_column_name, label_name, "test", shuffle_seed
        )

        tags = {"label": label_name, "task": "regex"}
        with mlflow.start_run(nested=True, tags=tags) as run:
            external_model = mlflow.create_external_model(
                name=f"regex-{label_name}",
                model_type="regex",
            )
            mlflow.set_active_model(model_id=external_model.model_id)
            evaluate_regex_model(
                external_model.model_id, label_index, label_name, "test", lake
            )

        tags = {"label": label_name, "task": "supervised"}
        with mlflow.start_run(nested=True, tags=tags) as run:
            print(f"starting training for {label_name}", flush=True)

            manager = multiprocessing.Manager()
            return_dict = manager.dict()
            p = multiprocessing.Process(
                target=train_model,
                args=[
                    return_dict,
                    {
                        "run_id": run.info.run_id,
                        "experiment_id": run.info.experiment_id,
                        "label_name": label_name,
                        "fasttext_kwargs": fasttext_kwargs,
                        "train_path": train_path,
                        "len_tune": len_validation,
                        "tune_path": validation_path,
                    },
                ],
            )
            p.start()
            p.join()
            if p.exitcode != 0:
                raise RuntimeError(
                    f"Training process for {label_name} failed with exit code {p.exitcode}"
                )

            model_id = return_dict["model_id"]
            model_uri = return_dict["model_uri"]

            mlflow.set_active_model(model_id=model_id)
            logged_model = LoggedModelInput(model_id=model_id)
            mlflow.log_input(pd_train, context="training", model=logged_model)
            mlflow.log_input(pd_validation, context="validation", model=logged_model)
            split_csv = {
                "train": train_path,
                "validation": validation_path,
                "test": test_path,
            }
            eval_results = evaluate_trained_model(label_name, model_uri, split_csv)
            results_per_split.append(eval_results)
            process_eval_results(
                run.info.run_id,
                model_id,
                eval_results,
                split_csv,
                label_column_name,
                shuffle_seed,
                lake,
            )

    results_test = [item["test"] for item in results_per_split]
    results_train = [item["train"] for item in results_per_split]
    labels = list(label_dict.values())
    plot_precision_recall(labels, "test", results_test)
    plot_threshold_recall(labels, "test", results_test)
    plot_precision_recall(labels, "train", results_train)
    plot_threshold_recall(labels, "train", results_train)


def process_eval_results(
    run_id: str,
    model_id: str,
    eval_results: dict,
    split_csv: dict,
    label_column_name: str,
    shuffle_seed: int | None,
    lake: Lake,
):
    run = mlflow.get_run(run_id=run_id)

    trained_model = TrainedModel(run, model_id)
    registered_model = trained_model.find_registered_model()
    if registered_model:
        trained_results = eval_results["test"]
        trained_metrics = trained_results["metrics"]

        if compare_models(trained_metrics, registered_model, split_csv):
            promote(trained_model, label_column_name, shuffle_seed, lake)
    else:
        promote(trained_model, label_column_name, shuffle_seed, lake)


def compare_models(
    trained_metrics: dict,
    registered_model: TrainedModel,
    split_csv,
) -> bool:
    registered_results = evaluate_model(
        registered_model.model_id, "test", split_csv["test"]
    )
    registered_metrics = registered_results["metrics"]

    trained_ap = float(trained_metrics["ap"])
    registered_ap = float(registered_metrics["ap"])
    trained_precision_at_recall = float(trained_metrics["precision_at_recall"])
    registered_precision_at_recall = float(registered_metrics["precision_at_recall"])

    ap_improvement = (
        (trained_ap - registered_ap) / registered_ap if registered_ap > 0 else 1
    )
    pr_improvement = (
        (trained_precision_at_recall - registered_precision_at_recall)
        / registered_precision_at_recall
        if registered_precision_at_recall > 0
        else 1
    )

    stats = {
        "ap_improvement": ap_improvement,
        "pr_improvement": pr_improvement,
    }
    if registered_model.version:
        stats["compare_to_version"] = float(registered_model.version.version)

    mlflow.log_metrics(stats)

    return (
        trained_ap > registered_ap
        and trained_precision_at_recall > registered_precision_at_recall
    )


def promote(
    trained_model: TrainedModel,
    label_column_name: str,
    shuffle_seed: int | None,
    lake: Lake,
):
    print(f"starting re-training for {trained_model.label_name}", flush=True)

    pd_all, all_path, len_all = create_dataset(
        lake, label_column_name, trained_model.label_name, "all", shuffle_seed
    )

    fasttext_kwargs = {
        "lr": float(trained_model.params["lr"]),
        "dim": int(trained_model.params["dim"]),
        "ws": int(trained_model.params["ws"]),
        "epoch": int(trained_model.params["epoch"]),
        "minCount": int(trained_model.params["minCount"]),
        "minCountLabel": int(trained_model.params["minCountLabel"]),
        "minn": int(trained_model.params["minn"]),
        "maxn": int(trained_model.params["maxn"]),
        "neg": int(trained_model.params["neg"]),
        "wordNgrams": int(trained_model.params["wordNgrams"]),
        "loss": str(trained_model.params["loss"]),
        "bucket": int(trained_model.params["bucket"]),
        "thread": int(trained_model.params["thread"]),
        "lrUpdateRate": int(trained_model.params["lrUpdateRate"]),
        "t": float(trained_model.params["t"]),
        "label": str(trained_model.params["label"]),
        "verbose": int(trained_model.params["verbose"]),
        "pretrainedVectors": str(trained_model.params["pretrainedVectors"]),
        "seed": int(trained_model.params["seed"]),
        "autotuneModelSize": str(trained_model.params["autotuneModelSize"]),
    }

    manager = multiprocessing.Manager()
    return_dict = manager.dict()
    p = multiprocessing.Process(
        target=train_model,
        args=[
            return_dict,
            {
                "run_id": trained_model.run.info.run_id,
                "experiment_id": trained_model.run.info.experiment_id,
                "label_name": trained_model.label_name,
                "fasttext_kwargs": fasttext_kwargs,
                "train_path": all_path,
                "len_tune": 0,
                "tune_path": "",
                "step": 1,
            },
        ],
    )
    p.start()
    p.join()
    if p.exitcode != 0:
        raise RuntimeError(
            f"re-training process for {trained_model.label_name} failed with exit code {p.exitcode}"
        )

    model_id = return_dict["model_id"]
    mlflow.set_active_model(model_id=model_id)
    mlflow.log_metrics(trained_model.get_metrics())
    logged_model = LoggedModelInput(model_id=model_id)

    mlflow.log_input(pd_all, context="training", model=logged_model)
    run = mlflow.get_run(run_id=trained_model.run.info.run_id)
    new_model = TrainedModel(run, model_id)
    new_model.register()
