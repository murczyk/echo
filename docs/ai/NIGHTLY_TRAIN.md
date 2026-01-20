# Нічне тренування

- білд-контейнер: echo-ai-train-build
- трейн-контейнер: echo-ai-train

## Запуск:

```
$ cd /usr/local/echo-ai-train
$ ./train-download-backups.sh
```

## Сетап (налаштування скриптів, одноразове)

- імпортуйте gpg-ключ Echo яким зчитуються бекапи (`gpg --import ...`, `gpg --edit-key <...> trust 5 y`)
- запустіть (із попереднім `bw login` нашим sergeantbtzr):

```
just setup-echo-ai-train
```

це покладе на сервер код та конфіги що дозволяють запускати скрипти тренування