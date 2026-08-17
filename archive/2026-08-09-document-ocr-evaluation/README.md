# Local document OCR evaluation

## Final combined result

Generated semantic HTML, XLSX, Markdown, provenance, and validation artifacts are stored under the Git-ignored `raw/results/` directory.

HTML is the source of truth because it preserves tables, merged cells, page boundaries, visual sections, and non-text image cells more faithfully than Markdown. The generated derivatives are:

- standalone canonical HTML documents;
- XLSX workbooks for the seven table documents, with a separate worksheet per source page/table;
- Markdown for the three prose documents;
- machine-readable provenance, repairs, and validation results.

The selected result uses Gemma on 3 pages and NuExtract3 on 14 pages. Deterministic, source-verified spelling and cell-topology repairs are recorded individually in the index. All 17 pages pass the declared row/column/section checks after selection and repair. This is a topology result backed by targeted visual review, not a claim that every cell has received a full human character-by-character audit.

The two earlier, fully audited page reconstructions are stored under `raw/legacy/`.

## Model comparison

Models are columns. CER/WER rows use the same two fully audited, full-page text regions; the expanded layout rows use the 17-page `/var/tmp/14AUG26/` suite. A dash means that variant was not run on the expanded suite, not that it failed. Only the best Gemma precision/vision variant is retained.

| Metric | **NuExtract3 BF16<br>non-thinking** | **NuExtract3 BF16<br>thinking** | **NuMarkdown 8B<br>BNB 4-bit** | **NuMarkdown 8B<br>BF16** | **Gemma 4 26B<br>FP8 / vision 1120** | **Selected hybrid output<br>(not a model)** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Host | Flyingskull | Flyingskull | Flyingskull | Spark-02 | Spark-02 | Both |
| **l54 CER** | 6.04% | **0.93%** | 5.03% | 3.25% | 10.64% | n/a — audited separately |
| **l54 WER** | 7.03% | **1.81%** | 6.58% | 6.80% | 16.78% | n/a — audited separately |
| **J5 CER** | 1.43% | 0.20% | 0.20% | 3.78% | **0.00%** | n/a — audited separately |
| **J5 WER** | 2.05% | 0.59% | 0.59% | 3.52% | **0.00%** | n/a — audited separately |
| **Overall CER** | 4.05% | **0.62%** | 2.95% | 3.48% | 6.06% | n/a — audited separately |
| **Overall WER** | 4.86% | **1.28%** | 3.96% | 5.37% | 9.46% | n/a — audited separately |
| Expanded pages completed with normal `stop` | 17/17 | — | — | 17/17 | 17/17 | 17/17 source pages |
| Expanded exact layout checks before repair | 8/17 | — | — | 7/17 | **9/17** | n/a |
| Expanded exact layout checks after selection/repair | n/a | n/a | n/a | n/a | n/a | **17/17** |
| Expanded median latency per page | **27.34 s** | — | — | 148.26 s | 36.86 s | n/a |
| Main failure mode | Occasional missing/misaligned cells | Added facts despite low edit distance | Merged an l54 two-column block | Collapsed dense table columns; slow | Dense table topology and one l54 entity | Requires recorded source-based repairs |
| Recommended role | **Primary OCR/layout** | Validator-triggered fallback only | Independent fallback on low-memory GPUs | Not selected | Tables/maps and selective verifier | **Canonical deliverable** |

The comparison is reproducible from [the CER/WER metric artifact](./gemma-spark-02/metrics/original-model-comparison.json) and the three expanded-suite metric files: [NuExtract3 BF16](./gemma-spark-02/metrics/layout-suite-nuextract3-bf16.json), [NuMarkdown BF16](./gemma-spark-02/metrics/layout-suite-numarkdown-bf16.json), and [Gemma FP8/1120](./gemma-spark-02/metrics/layout-suite-fp8-1120.json).

Normalization applies Unicode NFKC, case folding, `ё→е`, punctuation/whitespace normalization, and removal of HTML/Markdown layout markup. The non-text J5 image row is excluded for every model. Overall CER/WER is a micro-average of the summed edit distances. Edit distance alone does not detect incorrect cell boundaries, reordered coordinates, or invented facts, which is why the strict layout and factual checks remain separate.

## What happened to the Gemma loop?

`Зациклення; length 5000` describes only the historical full-page l54 run on the original Spark host. It is not the current Spark-02 result.

Temperature changes did not independently fix repetition. With the original prompt, temperature 0, 0.2, and 0.5 stopped normally, while 0.7 and 1.0 each triggered repetition detection for 1/3 seeds. The combination of the 1120-token vision budget and a bounded, region-once prompt stopped normally for 5/5 deterministic l54 seeds. The best Gemma finalist still retained only 46/47 critical entities, and J5 repetition-detection acceptance runs still terminated as `repetition`; therefore Gemma is not the sole primary extractor.

## RAM and the larger-model experiment

The extra unified memory on Spark-02 made it practical to load and test NuMarkdown 8B in full BF16. It did not improve the result enough to justify replacing the selected pipeline: BF16 improved l54 CER relative to 4-bit, but worsened J5 and overall WER, passed only 7/17 expanded layout checks, and had a 148.26-second median page latency.

NuExtract3 BF16 itself ran on `echo-gpu-flyingskull`; moving the same weights to Spark-02 would mainly change capacity and throughput, not OCR accuracy. The current NuExtract3 release is approximately 4–5B, so more RAM does not reveal a larger NuExtract3 checkpoint. The useful larger alternative was NuMarkdown 8B BF16, and that comparison is now complete. Sequentially winding down Gemma to test it was sensible; the wrapper restored Gemma afterward.

## Runtime and reproducibility

- Spark-02: NVIDIA vLLM 26.07 ARM64 / vLLM 0.24.0, loopback-only `127.0.0.1:8000`.
- Gemma: `google/gemma-4-26B-A4B-it`, revision `4d7ae4984b7db7de8f8457170b3f1a419ee76d52`, FP8 weights/KV cache, vision budget 1120.
- NuMarkdown: `numind/NuMarkdown-8B-Thinking`, revision `8dfc5236ae68b799d86308aae2f9717fdb50286e`, full BF16 on Spark-02 and BNB 4-bit on Flyingskull.
- NuExtract3: revision `2e9fca82ee641e6bb6e1f5d905241e994be27a07`, BF16 on Flyingskull.
- Every expanded request ran sequentially. Raw artifacts include the complete redacted request, model/container revision, response, finish reason, usage, latency, prompt version, seed, and sampling parameters.
- Source images remain outside Git. [The layout manifest](./gemma-spark-02/layout-suite-manifest.json) records only filenames, dimensions, MIME types, and SHA-256 hashes.
- The experimental service, model caches, and raw results remain on Spark-02. Nothing is registered with the production router.

Official model references: [NuExtract3](https://huggingface.co/numind/NuExtract3), [NuMarkdown-8B-Thinking](https://huggingface.co/numind/NuMarkdown-8B-Thinking), and [Gemma 4 model card](https://huggingface.co/google/gemma-4-26B-A4B-it/blob/main/README.md).
