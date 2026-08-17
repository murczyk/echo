# Gemma and layout OCR experiments on echo-gpu-spark-02

This directory contains the reproducible, isolated, headless experiment. Production `echo-gpu-spark`, its router, and the callsign workload were not changed. All archive files remain uncommitted.

The final cross-model result is documented in the [main README](../README.md); generated output remains under the Git-ignored `../raw/results/` directory.

## Pinned environment

- Host: `echo-gpu-spark-02`; Tailscale `100.95.57.33`.
- GPU: `GPU-a2db5163-9f88-101b-6db3-df4f83412d48` (`NVIDIA GB10`).
- Container: NVIDIA vLLM `26.07-py3`, vLLM 0.24.0, ARM64 digest `sha256:1de8e6bfdb4c81c1f31a806cc9b13b5c6352714a7cec87f4d24964bcc91159b2`.
- Gemma: `google/gemma-4-26B-A4B-it`, revision `4d7ae4984b7db7de8f8457170b3f1a419ee76d52`.
- NuMarkdown: `numind/NuMarkdown-8B-Thinking`, revision `8dfc5236ae68b799d86308aae2f9717fdb50286e`.
- Endpoint: only `127.0.0.1:8000`; never registered with the production router.
- Gemma runtime: `max-model-len=16384`, `gpu-memory-utilization=0.7`, one image/request, 8192 batched tokens, FP8 weights/KV cache, and vision budget 1120.
- Gemma reasoning parser: `gemma4`; tool calling disabled.
- Structured output: xgrammar with `disable_any_whitespace=true`.

Every mutating host script verifies the exact hostname, Tailscale IP, and full GPU UUID before acting.

## Reproduction

```bash
python3 -m pip install -r requirements-layout.txt
ssh echo-gpu-spark-02 'bash /srv/echo-gemma-ocr/deploy/prepare_host.sh'
./deploy/copy_pinned_model.sh
./deploy/copy_inputs.sh /path/to/legacy-source-images
./deploy/copy_layout_suite_inputs.sh /var/tmp/14AUG26
ssh echo-gpu-spark-02 'cd /srv/echo-gemma-ocr && bash deploy/set_runtime.sh 1120 fp8'
ssh echo-gpu-spark-02 'cd /srv/echo-gemma-ocr && python3 harness/run_experiment.py --phase baseline --vision-budget 1120 --precision fp8'
ssh echo-gpu-spark-02 'cd /srv/echo-gemma-ocr && python3 harness/run_layout_suite.py --manifest layout-suite-manifest.json --input-dir input --output-dir raw/layout-suite-fp8-1120'
```

`copy_inputs.sh` and `copy_layout_suite_inputs.sh` verify SHA-256 before and after transfer. The remote input directory is mode `0700`, source images are mode `0600`, and images are excluded from Git.

Requests run sequentially. Each artifact stores the full request with `<image-base64-omitted>` replacing the image, runtime and model revisions, the unmodified response, finish reason, usage, latency, prompt version, seed, and every sampling parameter.

## Legacy Gemma matrix

1. Original prompts at vision budgets 280 and 1120.
2. Temperatures 0, 0.2, 0.5, 0.7, and 1.0, with `top_p=0.95`, `top_k=64`, and seeds 0–2 for sampled runs.
3. Original prompt versus the bounded region-once prompt with `<END_OCR>` as a stop sequence.
4. Explicit repetition detection with `min_pattern_size=3`, `max_pattern_size=20`, and `min_count=4`.
5. Repetition penalties 1.03 and 1.05 only after looping remained.
6. Five-seed finalist validation on both legacy documents.
7. BF16 weights/automatic KV cache comparison.
8. Compact-xgrammar structured-output retest.

`repetition` and `repetition_detected` are scored as failed OCR, not automatic repairs.

## Expanded layout suite

The expanded suite contains 10 logical documents and 17 unique pages from `/var/tmp/14AUG26/`. It evaluates semantic HTML, exact table row/column topology, merged cells, image placeholders, and visual prose sections.

- Gemma FP8/vision 1120: 17/17 normal stops; 9/17 strict pre-repair layout passes.
- NuExtract3 BF16 non-thinking: 17/17 normal stops; 8/17 strict pre-repair layout passes.
- NuMarkdown 8B BF16: 17/17 normal stops; 7/17 strict pre-repair layout passes.
- Selected cross-model output: 17/17 topology passes after explicit source-verified repairs.

Build and validate the selected output with:

```bash
python3 harness/build_selected_layout_outputs.py \
  --output-dir ../raw/results/derived/layout-suite/final
python3 harness/score_original_comparison.py \
  --archive-dir .. \
  --numarkdown-bf16-dir raw/original-numarkdown-bf16 \
  --output metrics/original-model-comparison.json
```

The larger full-BF16 NuMarkdown run temporarily stops Gemma and restores it on exit:

```bash
ssh echo-gpu-spark-02 \
  'cd /srv/echo-gemma-ocr && ./deploy/run_numarkdown_layout.sh'
```

## Result

The historical Gemma study completed 83 sequential requests. The expanded suite added 17 Gemma and 19 full-BF16 NuMarkdown requests. The bounded prompt and larger vision budget removed the historical l54 token loop, but no Gemma-only finalist passed every five-seed acceptance criterion. NuMarkdown BF16 did not improve the overall result. Spark-02 is therefore restored to the Gemma FP8/FP8-KV service, while NuMarkdown remains stopped with its model cache and raw results retained.
