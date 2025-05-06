# Kibana

## Preparation

- set `vm.max_map_count` (per [SO answer](https://stackoverflow.com/a/64855285/540810))

<details>
$ echo "vm.max_map_count=262144" | sudo tee /etc/sysctl.d/99-sysctl.conf
$ sudo sysctl -w vm.max_map_count=262144
</details>

- ensure nginx has proxy_pass for HTTPS

## Kibana

Our docker compose is based on this excellent [SO answer](https://stackoverflow.com/a/77752130/540810)

See [[compose-jvln.yaml]] for staging setup. Deploy via `just setup-kibana-staging`

## Vector

**Developing**. See [[vector_play.yaml]] for stdin playground, play like:

<details>
```
cat vector_input.txt | vector -c ./vector.yaml | jq .
```
</details>

- **Install** via [apt](https://vector.dev/docs/setup/installation/package-managers/apt/):

```
bash -c "$(curl -L https://setup.vector.dev)"
sudo apt-get install vector
```

- `just setup-vector-staging` (або без -staging)
