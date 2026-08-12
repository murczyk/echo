# AI callsign prompt evaluation archive

Issue [#3108](https://github.com/echoua/echo/issues/3108) makes the deployed
4,102-character callsign prompt the compiled Rust fallback and records an
evaluation corpus for later prompt work.

Non-sensitive extraction metadata, row counts, checksums, and the B2 location
are maintained in the tracked
[`ai-eval/2026-08-10-callsign-prompt/README.md`](../../ai-eval/2026-08-10-callsign-prompt/README.md).
The raw corpus remains gitignored and is stored only in B2.

Extraction used the four August 8 activation cutoffs and one shared snapshot,
2026-08-10 08:27:08 UTC. The enabled workers retained prompt MD5
`e28582ad0a1e6e07be76c95dd2f33cbf`. The corpus contains 174,618 rows
(`echo-siversk` 14,353, `echo-zp2` 27,402, `echo-pivnich` 69,427,
`echo-skhid` 63,436) and has SHA-256
`f210df0071e3e1fea2e52306f8804acc5d880d8d9a8f81cea6790cc0a0dcb646`.
Its verified B2 location is
`s3://echouastorage/lfs/echo-ai/evals/2026-08-10-callsign-prompt/`.

The later `echo-skhid` `batch-01` extract selected at most one exact message per
supplied callsign: 62 of 806 callsigns matched the frozen window, producing 62
unique messages and corpus SHA-256
`80920d8d5da627d2d046bdb23de535900e494707b4ba0c226bbb48473571c0aa`.

The `batch-01` review and larger WIP corpus produced 72,562 unambiguous labeled
messages and a focused 307-case prompt set. The selected
5,335-character prompt has SHA-256
`25a1321e9a39ce8590967c3d63f4039606a34f9527b92083cd9ab901df097c52`;
it reduced focused-set item errors from 364 to 256 and is now the compiled
fallback. Detailed metrics are tracked in
[`runs/2026-08-10-iteration.md`](../../ai-eval/2026-08-10-callsign-prompt/runs/2026-08-10-iteration.md).
