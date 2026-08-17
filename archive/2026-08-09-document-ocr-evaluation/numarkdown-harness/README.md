# Відтворення NuMarkdown/NuExtract3 benchmark

Harness містить успішні vLLM-запуски NuMarkdown і NuExtract3, schema extraction, валідований Gemma summary, невдалий Transformers baseline і скрипт однакового CER/WER-порівняння.

## Перевірене середовище

- Host: Ubuntu 26.04, Incus.
- Container: Debian 13, 8 CPU, 20 GiB RAM, RTX 4070 Ti SUPER 16 GB.
- Модель: `numind/NuMarkdown-8B-Thinking`, revision `8dfc5236ae68b799d86308aae2f9717fdb50286e`.
- Модель: `numind/NuExtract3`, revision `2e9fca82ee641e6bb6e1f5d905241e994be27a07`, BF16 без квантування.
- vLLM 0.26.0, PyTorch 2.11.0+cu130, BitsAndBytes 0.50.0.

`run_vllm_with_restore.sh` запускається **на Incus-host**. Він ставить незалежний systemd backstop timer, зупиняє production-контейнер тільки на час inference, запускає vLLM усередині experiment-контейнера та відновлює production через trap за будь-якого виходу. Перед повторним використанням перевірте назви контейнерів і шляхи на початку файла.

```bash
bash run_vllm_with_restore.sh
```

`run_vllm_eval.py` запускається всередині контейнера після готовності локального OpenAI-compatible endpoint. Результат записується інкрементально після кожного документа.

Рекомендований NuExtract3 benchmark на Incus-host:

```bash
bash run_nuextract3_with_restore.sh
NUEXTRACT3_CLIENT_SCRIPT=run_nuextract3_structured_eval.py \
  bash run_nuextract3_with_restore.sh
```

Перший запуск перевіряє Markdown у non-thinking/thinking режимах, другий — profile-specific JSON. За результатами тесту non-thinking є default, а thinking запускається лише після failed validation.

`run_gemma_summary.py` запускається на `echo-cbr-staging`, де доступний Spark vLLM. Він перевіряє, що український підсумок не додає нових чисел, не змінює згадані власні назви та не залишає відомі російські описові фрагменти; за потреби виконує один feedback-retry.

Transformers/NF4/SDPA baseline у `run_eval.py` не завершив першу сторінку за 3300 с; він збережений лише для відтворення невдалого конфігураційного варіанта. Для практичної роботи використовуйте vLLM.

Ваги моделі не дублюються у цьому каталозі. Зафіксований snapshot у тестовому контейнері збережено в `/workspace/numarkdown-eval/hf-cache`.
