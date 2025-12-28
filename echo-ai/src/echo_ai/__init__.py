import argparse

import fasttext
import mlflow
import pandas as pd

from .fasttext_model import load_model, log_model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_bin_file", type=str)
    args = vars(parser.parse_args())

    mlflow.set_experiment("ЕХО AI")

    fasttext_model = fasttext.load_model(args["model_bin_file"])

    with mlflow.start_run():
        model_info = log_model(fasttext_model, artifact_path="test-arta")
        print(model_info)

        loaded_pyfunc = mlflow.pyfunc.load_model(model_info.model_uri)
        df = pd.DataFrame({"text": ["наведи влево"]})

        prediction = loaded_pyfunc.predict(df)
        print(prediction)
