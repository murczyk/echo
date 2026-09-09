# React test-cleanup recovery

`react-test-removal-dispositions.json` is the machine-readable recovery ledger for this migration.

Its reference inventory is `main` at `009062bd10c51ca280689165dcd0dd96b69fd1b9`:

- 2,752 original test identities;
- 2,353 retained AST identities in the final React tree;
- 1,444 relocation records with existing final targets;
- 555 genuinely removed identities with explicit dispositions;
- 5 incoming identities with an explicit admission decision.

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
