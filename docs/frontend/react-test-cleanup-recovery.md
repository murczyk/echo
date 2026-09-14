# React test-cleanup recovery

`react-test-removal-dispositions.json` is the machine-readable recovery ledger for this migration.

Its final checkpoint is `e3f020aa1`; the current working tree is the authoritative AST source:

- 2,460 retained React AST identities in the final tree;
- 1,465 relocation records with existing final targets;
- 28 genuinely removed identities with explicit final-removal dispositions;
- 466 incoming identities with an explicit admission decision.

Counters are derived by `test-ledger-check.mjs`: `current` is the unique AST
identity count under `src/ts/react`; `incoming` is the number of unique
`file + id` incoming records; `genuinelyRemoved` is moved records with a valid
final-removal object; and `relocated` is moved records without one.

An empty test-scope baseline is not evidence that a removal is valid. A removal becomes complete only when its ledger record has an admitted disposition and, where the test protected visible behavior, a linked behavior contract or stronger retained test.

Playwright remains under `wdintel-web/tests/e2e`; its audit and execution status are recorded separately from Vitest disposition work.

## Safe packing policy

Canonical packing is complete. Recovery directories have been eliminated; all
retained React specs are in their nearest `__tests__/` directory except the
five occupied-target exceptions. Relocation alone does not admit a test.

Only a one-to-one relocation is permitted:
`dir/Foo.spec.ts` to `dir/__tests__/Foo.spec.ts`. Each leaf directory is
audited before its files move, and each move compares the resolved production
imports and `vi.mock()` targets before and after relocation. The moved spec and
its directory cohort must pass before the next leaf is considered; a full
serial run follows every 10--20 files.

If relocation alone introduces module-cache, hoisted-mock, global-state,
fixture-path, or order-dependent behavior, the source path is restored and
recorded in `react-test-packing-exceptions.md`. Existing target collisions are
also recorded there rather than merged, flattened, or renamed.
