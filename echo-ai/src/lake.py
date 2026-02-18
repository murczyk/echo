import argparse
import tempfile

from echo_ai.lake import Lake


def real_main(args):
    db = args["db"]
    with tempfile.TemporaryDirectory() as temp_dir:
        print("creating connection to datalake")
        lake = Lake(temp_directory=temp_dir)
        print("creating lake schema")
        lake.create_schema_if_not_exists()

        print(f"attaching '{db}'")
        lake.attach_local(db)

        print(f"merging tags from '{db}'")
        lake.merge_tags(db)
        print(f"finished merging tags from '{db}'")

        print(f"merging inbox item tags from '{db}'")
        lake.merge_inbox_item_tags(db)
        print(f"finished merging inbox item tags from '{db}'")

        print(f"inserting model errors from '{db}'")
        lake.insert_model_error(db)
        print(f"finished model errors from '{db}'")

        print(f"inserting inbox messages from '{db}'")
        lake.insert_inbox_message(db)
        print(f"finished inserting inbox messages from '{db}'")

        rel = lake.create_messages_labeled_onehot()
        print(rel)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("db", type=str)
    args = vars(parser.parse_args())
    real_main(args)


if __name__ == "__main__":
    main()
