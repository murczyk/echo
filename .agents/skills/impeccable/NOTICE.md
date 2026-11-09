# Echo adaptation and third-party notices

This directory contains a Markdown-only adaptation of Impeccable 4.8.0,
source commit `414603bf14c7a344edb466bb1f85690c77ce8b7d`, under the included
[Apache-2.0 license](LICENSE).

Echo rewrote `SKILL.md`, `agents/openai.yaml` and the selected `shape`, `critique`
and `audit` references for scoped documentation/review with explicit invocation.
The adaptation preserves useful UX checks and removes runtime/engine commands,
automatic delegation, live overlays, persistence helpers and setup instructions.
Other references, executable/runtime files and upstream child agents are omitted.
`SHA256SUMS` records the local adapted snapshot; these are not pristine upstream files.

Original source files and SHA-256 before adaptation:

| File | Original SHA-256 |
| --- | --- |
| [SKILL.md](https://github.com/pbakaus/impeccable/blob/414603bf14c7a344edb466bb1f85690c77ce8b7d/skill/SKILL.md) | `fab04b31f946573b00a8559db1fc070f8ea5825254d491c2b13156e5661a86d7` |
| [reference/shape.md](https://github.com/pbakaus/impeccable/blob/414603bf14c7a344edb466bb1f85690c77ce8b7d/skill/reference/shape.md) | `a55f016c046cb6a27c55bd7f346375aeb506a755c4fbca19a5f92dbd42309c23` |
| [reference/critique.md](https://github.com/pbakaus/impeccable/blob/414603bf14c7a344edb466bb1f85690c77ce8b7d/skill/reference/critique.md) | `c210c9506877c6c8d88880a337fddd95d4315daf70ed6bc631ee6520481f1a0c` |
| [reference/audit.md](https://github.com/pbakaus/impeccable/blob/414603bf14c7a344edb466bb1f85690c77ce8b7d/skill/reference/audit.md) | `5ba9e3a090fc4c4d212c8cbfa5a48f7454ceb10fa81a284b4a7b4e8351ece2f1` |

## Preserved upstream notice

The notice below is retained from upstream. The native platform references it
describes are not included in this Echo subset.

### Third-Party Notices

This project includes content derived from third-party work, used under the terms of its original license.

#### Platform Design Skills

The `skill/reference/ios.md` and `skill/reference/android.md` platform reference files are distilled from ehmo's `platform-design-skills` (Apple Human Interface Guidelines and Material Design 3 rules), rewritten in Impeccable's voice.

**Original work:** https://github.com/ehmo/platform-design-skills
**Original license:** MIT
**Author:** ehmo
