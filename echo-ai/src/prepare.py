import argparse

from echo_ai.prepare import fetch_from_postgres


def real_main(args):
    databases = args["databases"]
    file_name = args["file_name"]
    fetch_from_postgres(databases, file_name)


def main():
    parser = argparse.ArgumentParser(fromfile_prefix_chars="@")
    parser.add_argument(
        "-o",
        "--output",
        dest="file_name",
        type=str,
        help="Name of the output file (e.g., results.parquet)",
    )
    parser.add_argument("databases", type=str, nargs="+")
    args = vars(parser.parse_args())
    real_main(args)


if __name__ == "__main__":
    main()
