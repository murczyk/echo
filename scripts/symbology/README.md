# APP-6(D) symbol catalog

`gen_app6d_catalog.py` builds one JSON catalog of APP-6(D) point symbols:
symbol sets, entities with their Entity/Type/Subtype path, sector 1/2
modifiers, identities, statuses, HQ/task-force flags, echelons and mobility,
plus Ukrainian aliases. It is written to:

- `wdintel-web/static/data/app6d-catalog.json` — the map workspace symbol editor
  and labels;
- `echo-ai-agent/template/python/echomap/app6d-catalog.json` — `sidc.find`,
  `sidc.retype` and `sidc.describe` in agent map scripts.

The two copies must stay identical (checked by
`echo-ai-agent/tests/test_echomap.py`). Entity tables come from the MIT-licensed
[`stanag-app6`](https://github.com/spatialillusions/stanag-app6) package by the
milsymbol author; the tarball is checksum-verified. Control measures keep only
point symbols.

## Updating

Edit `app6d-aliases.uk.json` to add or correct Ukrainian names. Each alias
names a symbol set and entity (optionally `m1`, `m2`, `hq`); `terms` are
lowercase word prefixes, and the longest match wins (ties go to the earliest
occurrence in the text). The generator rejects codes missing from the tables.

```sh
python3 scripts/symbology/gen_app6d_catalog.py            # downloads stanag-app6
python3 scripts/symbology/gen_app6d_catalog.py --tsv-dir path/to/tsv-tables/app6d
```

Map markers are drawn with milsymbol, which renders any valid SIDC, so the
catalog only drives names, search and validation.
