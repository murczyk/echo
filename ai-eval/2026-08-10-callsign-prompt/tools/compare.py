#!/usr/bin/env python3
import argparse
import json
import pathlib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("metrics", nargs="+", type=pathlib.Path)
    args = parser.parse_args()
    print("| run | cases | exact | FP | FN | invalid | F1 |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for path in args.metrics:
        metrics = json.loads(path.read_text(encoding="utf-8"))
        overall = metrics["overall"]
        print(
            f"| {metrics['run']} | {overall['cases']} | {overall['exactCases']} | "
            f"{overall['falsePositives']} | {overall['falseNegatives']} | "
            f"{overall['invalidResponses']} | {overall['f1']:.6f} |"
        )


if __name__ == "__main__":
    main()
