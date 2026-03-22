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

- if `opencode` binary is not in `PATH`, set `OPENCODE_BIN`:

```bash
export OPENCODE_BIN=/home/echo/.opencode/bin/opencode
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
