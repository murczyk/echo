# OpenCode config

This directory contains the project-specific `opencode` configuration.

By default it expects the local model endpoint at `http://vllm-host:8000/v1`.
The default model is `vllm/google/gemma-4-26B-A4B-it`.
`vllm/openai/gpt-oss-120b` is kept as an alternative when that model is running
on the same endpoint.
If the binary is not in `PATH`, export `OPENCODE_BIN` before using `run.sh`.

The `skills/` directory contains local instructions used by
`echo-agent sigint-extract-callsigns`.

## Direct one-shot usage

Formatted markdown-like output:

```bash
./opencode/run.sh run "What time is it?"
```

Use the OpenAI GPT-OSS alternative:

```bash
OPENCODE_MODEL=vllm/openai/gpt-oss-120b ./opencode/run.sh run "What time is it?"
```

Or pass a model explicitly:

```bash
./opencode/run.sh run --model vllm/openai/gpt-oss-120b "What time is it?"
```

Raw JSON events:

```bash
./opencode/run.sh run --format json "What time is it?"
```

Explicit binary form without the helper script:

```bash
OPENCODE_CONFIG=./opencode/opencode.jsonc \
/home/echo/.opencode/bin/opencode run --dir . "What time is it?"
```
