import argparse
import re
import os
import fasttext
from datasets import load_dataset, Dataset, DatasetDict, Features, ClassLabel, Value, Sequence
import numpy as np
import matplotlib.pyplot as plt
from sklearn.metrics import precision_recall_curve, average_precision_score

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
    9: "зіткнення"
}
label_pred_thresholds = {
    "переміщення": 0.672,
    "бпла": 0.424,
    "звʼязок": 0.280,
    "забезп": 0.413,
    "арта": 0.680,
    "втрати": 0.350,
    "іфо": 0.148,
    "палітра": 0.068,
    "мораль": 0.125,
    "зіткнення": 0.183
}
label_ids = list(label_dict.keys())

pat_alnum_apostrophe = re.compile(r"[\w'`\u2019\u02BC]+", re.UNICODE)

def preprocess_text(text):
  words = pat_alnum_apostrophe.findall(text)
  return ' '.join(words)


def preprocess_batched(examples):
    text = []
    labels = {}
    label_count = []

    for label_id in label_ids:
        labels[label_id] = []

    for row_text, row_labels in zip(examples['text'], examples['labels']):
        row_text = preprocess_text(row_text)
        text.append(row_text)

        label_count.append(len(row_labels))

        for label_id in label_ids:
            if label_id in row_labels:
                labels[label_id].append(1)
            else:
                labels[label_id].append(0)

    result = {
        'text': text,
        'label_count': label_count
    }
    for label_id in label_ids:
        result[f'label_{label_id}'] = labels[label_id]

    return result

def train_unsupervised(args, dataset: DatasetDict):
    if not os.path.isfile(args.corpus):
        dataset['train'].to_csv(args.corpus, num_proc=args.cpus, columns=['text'], index=False, header=False)

    model = fasttext.train_unsupervised(
        input=args.corpus,
        model=args.model,
        lr=args.lr,
        ws=args.ws,
        dim=args.dim,
        epoch=args.epoch,
        minCount=args.minCount,
        thread=args.cpus,
        verbose=args.verbose,
    )
    
    return model

def prepend_labels(examples):
    mask = examples['label'] == 1
    text = examples['text']
    text[mask] = np.char.add('__label__1 ', text[mask])
    text[~mask] = np.char.add('__label__0 ', text[~mask])
    return {
        'text': text
    }

def generate_splits(args, dataset: Dataset):
    splits = []
    for label_index, label_name in label_dict.items():
        column_name = f'label_{label_index}'
        ds = dataset.select_columns(['text', column_name, '__source', '__id', '__datetime'])
        ds = ds.rename_column(column_name, 'label')
        print(f'generating splits for {label_name}')
        ds = ds.train_test_split(train_size=0.8, seed=4313, shuffle=True, stratify_by_column='label')
        split = DatasetDict({
            'train': ds['train'].map(prepend_labels, batched=True, num_proc=args.cpus),
            'test': ds['test'],
        })

        train_csv = f'train/{label_name}.txt'
        if not os.path.isfile(train_csv):
            split['train'].to_csv(train_csv, num_proc=args.cpus, columns=['text'], index=False, header=False)

        test_csv = f'test/{label_name}.txt'
        if not os.path.isfile(test_csv):
            test = ds['test'].map(prepend_labels, batched=True, num_proc=args.cpus)
            test.to_csv(test_csv, num_proc=args.cpus, columns=['text'], index=False, header=False)

        splits.append(split)
    return splits

def train_supervised(args):
    models = []
    for label_name in label_dict.values():
        input = f'{label_name}.txt'
        model_name = input.replace(".txt", ".bin")
        if os.path.isfile(model_name):
          print("Loading:", model_name)
          model = fasttext.load_model(model_name)
        else:
          print("Training:", model_name)
          train_csv = f'train/{input}'
          if args.autotune:
            test_csv = f'test/{input}'
            model = fasttext.train_supervised(
                train_csv,
                # ws=args.ws,
                autotuneValidationFile=test_csv,
                autotuneMetric=args.autotuneMetric,
                autotuneDuration=args.autotuneDuration,
                autotunePredictions=args.autotunePredictions,
                pretrainedVectors=args.pretrainedVectors,
                wordNgrams=args.wordNgrams,
                minCount=args.minCount,
                dim=args.dim,
                thread=args.cpus,
                verbose=args.verbose,
            )
          else:
            model = fasttext.train_supervised(
                train_csv,
                ws=args.ws,
                lr=args.lr,
                epoch=args.epoch,
                dim=args.dim,
                wordNgrams=args.wordNgrams,
                minCount=args.minCount,
                pretrainedVectors=args.pretrainedVectors,
                thread=args.cpus,
                verbose=args.verbose,
            )
        model.save_model(model_name)
        models.append(model)
    return models

def write_word_vectors(path, model):
    words = model.get_words()
    l = len(words)
    dim = model.get_dimension()

    print(f'saving word vectors (len={l}, dim={dim}) to {path}...')
    with open(path, 'w') as f:   
        f.write(f'{l} {dim}\n')
        for w in words:
            f.write(w)
            f.write(' ')

            v = model.get_word_vector(w)
            vstr = ' '.join(map(str, v))
            f.write(vstr)
            f.write('\n')

def test_batch(examples, label_index, model):
    text = examples['text'].tolist()
    all_labels, all_probs = model.predict(text, k=1)

    all_labels = np.array(all_labels)
    all_probs = np.array(all_probs)

    all_labels = all_labels[:, 0]
    all_probs = all_probs[:, 0]

    mask = all_labels == '__label__0'
    all_probs[mask] = 1.0 - all_probs[mask]

    label_name = label_dict[label_index]
    threshold = label_pred_thresholds[label_name]
    
    y_scores = all_probs
    y_pred = np.where(y_scores >= threshold, 1, 0)

    return {
        'y_scores': y_scores,
        'y_pred': y_pred,
    }

def test_models(splits: list[DatasetDict], models, target):
    results = []
    plt.clf()
    plt.figure(figsize=(12, 10))
    num_labels = len(label_dict)

    label_recalls = []
    label_thresholds = []

    for label_index, label_name in label_dict.items():
        split = splits[label_index]
        model = models[label_index]
        print(f'testing model {label_name} on {target}')
        res = split[target].map(lambda examples: test_batch(examples, label_index, model), load_from_cache_file=False, batched=True)
        res = res.with_format('numpy')
        results.append(res)

        y_true = np.array(res['label'])
        y_pred = np.array(res['y_pred'])
        y_scores = np.array(res['y_scores'])

        precision, recall, thresholds = precision_recall_curve(y_true, y_scores)
        label_recalls.append(recall[:-1])
        label_thresholds.append(thresholds)
        ap = average_precision_score(y_true, y_scores)
        plt.plot(recall, precision, label=f"{label_name} (AP={ap:.3f})")

    plt.grid(True)
    plt.xlabel("Recall")
    plt.ylabel("Precision")
    plt.title(f"Precision-Recall Curves for {num_labels} FastText Models ({target})")
    plt.legend(loc="lower left")
    plt.savefig(f'Precision-Recall-{target}.png')
    plt.clf()
    

    plt.figure(figsize=(12, 10))
    for label_index, label_name in label_dict.items():
        recall = label_recalls[label_index]
        thresholds = label_thresholds[label_index]
        indexes = np.argwhere(recall >= 0.8)
        best_threshold = np.max(thresholds[indexes])

        plt.plot(recall, thresholds, label=f"{label_name} (0.8={best_threshold:.3f})")

    plt.grid(True)
    plt.xlabel("Recall")
    plt.ylabel("Threshold")
    plt.title(f"Threshold-Recall Curves for {num_labels} FastText Models ({target})")
    plt.legend(loc="lower left")
    plt.savefig(f'Threshold-Recall-{target}.png')
    plt.clf()

    return results

def main(args):
    features = Features({
        'text': Value('string'),
        'labels': Sequence(ClassLabel(names=list(label_dict.values()))),
        '__source': Value('string'),
        '__id': Value('int64'),
        '__datetime': Value('timestamp[s, tz=UTC]'),
    })
    dataset = load_dataset('parquet', data_files=args.datafile, features=features)

    binary_features = {
        'text': Value('string'),
        'label_count': Value('int32'),
        '__source': Value('string'),
        '__id': Value('int64'),
        '__datetime': Value('timestamp[s, tz=UTC]'),
    }
    for label_id in label_ids:
        binary_features[f'label_{label_id}'] = ClassLabel(num_classes=2)
    dataset = dataset.map(preprocess_batched, batched=True, num_proc=args.cpus, features=Features(binary_features), remove_columns=['labels'])

    if not os.path.isfile(args.pretrainedVectors):
        model = train_unsupervised(args, dataset)
        write_word_vectors(args.pretrainedVectors, model)

    dataset.set_format('numpy')
    dataset = dataset['train'].filter(lambda x: x['label_count'] > 0, batched=True, num_proc=args.cpus)
    dataset = dataset.remove_columns('label_count')
    splits = generate_splits(args, dataset)
    models = train_supervised(args)
    test_models(splits, models, 'test')
    test_models(splits, models, 'train')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cpus', type=int)
    parser.add_argument('--model', type=str, default='skipgram')
    parser.add_argument('--lr', type=float, default=0.05)
    parser.add_argument('--ws', type=int, default=5)
    parser.add_argument('--dim', type=int, default=100)
    parser.add_argument('--epoch', type=int, default=20)
    parser.add_argument('--minCount', type=int, default=1)
    parser.add_argument('--wordNgrams', type=int, default=1)
    parser.add_argument('--verbose', type=int, default=3)
    parser.add_argument('--autotune', action='store_true', default=False)
    parser.add_argument('--autotunePredictions',type=int, default=2)
    parser.add_argument('--autotuneMetric', type=str, default='precisionAtRecall:80:__label__1')
    parser.add_argument('--corpus', type=str, default='corpus.txt')
    parser.add_argument('--pretrainedVectors', type=str, default='pretrained.vec')
    parser.add_argument('--autotuneDuration',type=int, default=600)
    parser.add_argument('datafile', nargs='+')
    args = parser.parse_args()
    main(args)
