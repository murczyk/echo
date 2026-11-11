# Source and local adaptations

Source: [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/356918eba965ee1eac64bd3a7f0dd02108350de5).
Pinned commit: `356918eba965ee1eac64bd3a7f0dd02108350de5`. License: [LICENSE](LICENSE).

The core Ponytail guidance and its `lite`, `full` and `ultra` levels are adapted
from the MIT-licensed source bundled in Engineering Suite Ponytail `2.0.0`.
Its `UPSTREAM_LOCK.json` records this upstream commit; the upstream copyright
and license are preserved verbatim.

Echo rewrites the entrypoint and adds Codex invocation metadata. The adaptation
retains the reuse/stdlib/native-first ladder and root-cause reasoning, while
giving approved scope, Power components, accessibility, error handling and
`CODE_REVIEW.md` precedence. Session persistence, slash commands, mandatory demo
tests and fixed output limits are replaced by the assigned Echo task contract.

Only the core implementation guidance is included. The plugin router,
code-simplification skill, review/audit/debt/gain/help modes, benchmarks, hooks
and installers are not required or bundled. No personal configuration is copied.

For updates, review the upstream changes, preserve attribution, update the pin
and repeat skill, link and role-profile validation. A repository copy does not
install or update a developer's personal plugin.
