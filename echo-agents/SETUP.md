# SETUP

- launch vllm on echo-gpu-spark like:


```
echo@echo-gpu-spark:~/workspace/dgx-spark-vllm/spark-vllm-docker$ ./launch-cluster.sh --solo --launch-script ./examples/vllm-openai-gpt-oss-120b.sh
```

- launch incus container (like `echo-gpu-agent`), attach GPU, see Knowledge Base "Incus"
- put vllm-host in /etc/hosts
    - determine `incusbr0` gateway: like `10.16.206.1` (via `ip a`)
    - inside of the container put it in /etc/hosts like:

```
10.16.206.1 vllm-host
```
- check

```
root@echo-gpu-agent:~# curl -sS http://10.16.206.1:8000/v1/models | jq .
{
  "object": "list",
  "data": [
    {
      "id": "openai/gpt-oss-120b",
	  ...
    }
  ]
}
```

- install `node` and `opencode`:

```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
curl -fsSL https://opencode.ai/install | bash
```

- if `opencode` binary is not in `PATH`, set `OPENCODE_BIN`:

```bash
export OPENCODE_BIN=/home/echo/.opencode/bin/opencode
```

- run Rust wrapper:

```bash
cd echo-agents/echo-agent
cargo run -- freeform "What time is it?"
```

- agent config:

- on deploy, the deb package creates `/etc/echo-agent/config.toml`
  automatically from `config.toml.example` if it is missing

- fill fields in `/etc/echo-agent/config.toml`:
  - `echo_login`
  - `echo_password`
  - `echo_server`

- try callsign extraction on a raw message:

```bash
cd echo-agents/echo-agent
cargo run -- sigint-extract-callsigns --body '— Фаза, Фаза, я Мирный, прием.'
```

- install tailscale:

```
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --auth-key=tskey-auth-...
```

- tailscale post-setup:
    - disable key expiry
	- enable MagicDNS (rename to something nice)
	- enable HTTPS
- install openssh-server
    - disable password login
