# Echo Chumak integration

Dependency-free Python CLI for checking the Echo endpoints needed by Chumak.

## Configuration

```sh
cp .env.example .env
```

Fill in Echo URL, login, password, and sample Chumak values.

## Commands

Login and print the obtained session cookies:

```sh
just login
```

Find live networks by required frequency and optional AOR/color code:

```sh
just find-networks
```

Endpoint:

```text
POST /api/sigint/network/find-live
```

Payload:

```json
{
  "freq": "145.0260",
  "aor_id": null,
  "color_code": "1"
}
```

Create a new Chumak inbox message:

```sh
just submit-message
```

Endpoint:

```text
POST /api/rer-importer/inbox/chumak-submit
```

The script prints the exact JSON payload before sending it. The payload includes message text, timestamp, frequency, locations, group name, optional coordinates, callsigns, network color code, and DMR metadata.
