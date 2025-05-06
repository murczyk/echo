# wdintel-py

Microservices for python libs. It's one little Flask app with REST API atm.

## Setup


```
pip3 install -r requirements.txt
python3 -m spacy download ru_core_news_md
```

## Running in dev

```
curl -o ~/storage/wiki.model https://a.wilab.org.ua/gpt/wiki.model
curl -o ~/storage/callsigns20230512.pt https://a.wilab.org.ua/gpt/callsigns20230512.pt
export WD_CALLSIGNS_SPM=$HOME/storage/wiki.model
export WD_CALLSIGNS=$HOME/storage/callsigns20230512.pt
flask --app service run
```
