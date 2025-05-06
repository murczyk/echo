import os

feature_callsign_autocomplete = False

import pymorphy3
import spacy
from flask import Flask, json, jsonify, request
from words2numsrus import NumberExtractor

# import ha.attention as hat
# import sentencepiece as spm
# import torch

# if feature_callsign_autocomplete:
#     sp = spm.SentencePieceProcessor(model_file=os.environ.get("WD_CALLSIGNS_SPM", "wiki.model"))
#     callsigns_model = hat.load_model(os.environ.get("WD_CALLSIGNS", "callsigns.pt"), map_location='cpu')

nlp = spacy.load("ru_core_news_md")
morph = pymorphy3.MorphAnalyzer()
app = Flask(__name__)
json.provider.DefaultJSONProvider.ensure_ascii = False


@app.route("/")
def hello_world():
    return "<p>Hello, World!</p>"


@app.post("/api/tokenize/words")
def tokenize_words():
    req = request.get_json()
    doc = nlp(req["sentence"])
    words = []
    for token in doc:
        words.append({
            "text": token.text,
            "start": token.idx,       
            "end": token.idx + len(token.text)
        })
    return jsonify({"words": words})


@app.post("/api/token/lexeme")
def token_normal_form():
    req = request.get_json()
    token = req["token"]
    res = morph.parse(token)[0]
    return jsonify({"lexeme": [x.word for x in res.lexeme]})


@app.post("/api/extract/numbers")
def extract_numbers():
    return jsonify(
        {"sentance": (NumberExtractor().replace_groups(request.get_json()["sentence"]))}
    )


# @app.post("/api/completions/callsigns")
# def complete_callsigns():
#     """Complete callsigns.

#     Example:
#     $ cat test.txt
#     20.04.2023-15:24 F=148,7500(МГц)
#     УКХ р/м управління 50 сап (НОВОПРОКОПІВКА, СОЛОДКА БАЛКА)
#     OMCK (HB)
#     БРЕСТ (HB)
#     "1. брест я омск прийом.
#     2. на прийоме.
#     1. вертухай дорма.
#     2. принял."
#     $ cat test.txt | jq -Rsc '{message:.}' | cur] -H Content-Type:application/json -d @- http://127.0.0.1:5000/api/completions/callsigns -s
#     {"completions": ["омск, брест"]}
#     """
#     if not feature_callsign_autocomplete:
#         return jsonify({"completions": []})

#     req = request.get_json()

#     prompt_text = req["message"]
#     prompt_tokens = torch.LongTensor([50256] + sp.encode(prompt_text.rstrip() + "\nзадача:"))[None, :]
#     generated_tokens = [token.item() for token in hat.generate(callsigns_model, prompt_tokens, max_new_tokens=100, temperature=1.0, top_k=1)]
#     completions = sp.decode(generated_tokens)
#     return jsonify({"completions": [completions]})
