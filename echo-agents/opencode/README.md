# OpenCode config

This directory contains the project-specific `opencode` configuration.

By default it expects the local model endpoint at `http://vllm-host:8000/v1`.
If the binary is not in `PATH`, export `OPENCODE_BIN` before using `run.sh`.

## Direct one-shot usage

Formatted markdown-like output:

```bash
./opencode/run.sh run "What time is it?"
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
