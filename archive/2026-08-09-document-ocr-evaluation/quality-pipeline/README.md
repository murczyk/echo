# High-quality document extraction pipeline

Конвеєр об'єднує:

- NuExtract3 BF16 non-thinking як основний OCR/layout і schema extractor;
- NuExtract3 thinking та NuMarkdown як fallback-кандидати;
- Gemma на Spark для незалежного crop-verification і українського підсумку;
- детерміновані перевірки чисел, X/Y-пар, структури колонок, арифметики та розбіжностей у критичних назвах.

Запуск після отримання сирих model outputs:

```bash
python3 quality_pipeline.py \
  --results /home/ubuntu/Downloads/eval-storage/results \
  --output /home/ubuntu/Downloads/eval-storage/results/quality-run
```

`raw/results/quality-run/REVIEW.md` є чергою точкової перевірки. Скрипт не виправляє спірний OCR-текст без provenance. Для поточних двох документів візуально перевірені фінальні Markdown-файли залишаються канонічними.

Сирі запуски NuExtract3 створюються скриптами з `../numarkdown-harness/`:

```bash
bash run_nuextract3_with_restore.sh
NUEXTRACT3_CLIENT_SCRIPT=run_nuextract3_structured_eval.py \
  bash run_nuextract3_with_restore.sh
```

Обидва host-wrapper скрипти мають systemd backstop і trap, які відновлюють production-контейнер за будь-якого виходу.
