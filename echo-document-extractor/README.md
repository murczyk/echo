# Echo Document Extractor

Local-first semantic extraction for PNG/JPEG and PDF documents. The extractor
reconciles geometry/OCR evidence with NuExtract3 and Gemma output, then writes a
canonical HTML document and projections to Markdown and XLSX.

```bash
python -m pip install -e '.[dev]'
echo-doc extract scan.pdf --output raw/result --config config.example.yaml
echo-doc validate raw/result
```

Separate images require a manifest containing an ordered `inputs` list. API
tokens are read from the endpoint `token_env` variables and are never stored in
configuration or output artifacts.

Use `config.split_gpu.yaml` for the recommended independent router pools at
`100.105.172.96:8001` (OCR-Gemma) and `100.105.172.96:8002` (NuExtract3).
Deployment of this package as a shared service, including its own metrics, is
planned separately. `config.single_spark.yaml` is a serial, benchmarking-only
profile. Paddle evidence is required by default; set `enable_paddle: false`
explicitly for a local degraded setup without PP-OCRv5 and PP-StructureV3.

Packages are written atomically into a new or empty private directory. They contain
canonical HTML, Markdown, optional XLSX, typed provenance and quality records,
lossless SHA-256-named assets, and private page images for `echo-doc inspect`.
