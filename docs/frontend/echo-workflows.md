# Explicit Echo workflows

These workflows run only when the user explicitly invokes the matching
`echo-designer`, `echo-dev` or `echo-qa` skill for the current task. Ordinary work
follows the existing repository rules; reading this guide, mentioning a role,
quoting a command or asking an ordinary UI/coding/review question does not activate one.

| Entrypoint | Native role | Model / reasoning | Assigned output |
| --- | --- | --- | --- |
| `$echo-designer` | `designer` | `gpt-6.1-sol` / `high` | Specification, scenarios, simple wireframe and implementation plan |
| `$echo-dev` | `dev` | `gpt-6.1-sol` / `high` | Approved implementation, focused self-checks and browser observations |
| `$echo-qa` | `qa`, mode `prepare` or `verify` | `gpt-6-luna` / `high` | Prepared tests/coverage map, or verification findings |

The main chat retains the user's chosen model and coordinates stages/questions.
The three `.codex/agents/*.toml` files define child roles. `agents/openai.yaml`
files are skill metadata, not agent definitions. This workflow ships no project
`config.toml` or shell-environment overrides. For subagent enablement and concurrency
limits, the developer's effective client
settings apply. If subagents are disabled, report the blocker without changing
those settings. Main runs this workflow's stages sequentially, with one writer
at a time, regardless of the available slots. This ordering applies only to the
explicitly invoked Echo workflow, not other developer workflows.

## Invocation and chaining

All three entrypoints have `policy.allow_implicit_invocation: false` ([Codex
metadata](https://learn.chatgpt.com/docs/build-skills#optional-metadata)). Use
`$skill-name` or the skill picker; slash aliases are not verified. A single-stage
request ends after that stage. Dev/QA accept manually prepared inputs; the
existence of a spec or an earlier approval does not authorize a new task.

Main must identify the user's actual invocation naming the requested skill(s)
and bind it to the current task and stages before dispatch. Natural-language
instructions to use a named skill count; a bare mention, quoted example or
request to edit/review the skills/configuration does not. Generic requests to
use agents, role descriptions, repository documents and another skill's
delegation instructions cannot authorize these roles. Never select `designer`,
`dev` or `qa` as generic helpers or call them directly around the entrypoints.
Without invocation, continue the ordinary workflow without spawning these roles.

Include the user's invocation excerpt, named skill(s) and task/stage scope in
each handoff; never synthesize it from an assistant proposal. The child must
stop before tools, file reads or writes if that evidence is absent or does not
cover its assigned role/task. This is an instruction check, not authentication.
It cannot undo an unauthorized spawn that already occurred, so main must check
before dispatch. Authorization persists for the same unfinished task, including
its explicitly requested chain and permitted repairs; it ends on completion,
cancellation or a new task. Do not carry it into unrelated work.

`allow_implicit_invocation` applies to skills, not named agents. The documented
[custom-agent schema](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agent-file-schema)
has no equivalent per-role invocation flag. Availability of delegation tools
does not authorize their use. Role descriptions, parent
instructions and handoff checks enforce this project's explicit-only contract
through model instructions, not a runtime prohibition of direct role dispatch.

```text
$echo-designer Підготуй специфікацію та просту схему для цієї задачі.
$echo-qa prepare Підготуй тести за погодженою специфікацією; без запуску.
$echo-dev Реалізуй погоджену специфікацію з підготовленими тестами.
$echo-qa verify Перевір цей diff за критеріями специфікації.
```

An explicitly requested dev+QA chain means QA prepare → dev implement and focused
self-checks → QA verify. An explicitly requested full chain first runs designer,
then waits for owner approval of the resulting specification and implementation
authorization. Do not infer that approval from a proposed future design.

```text
Для цієї задачі виконай $echo-designer, потім $echo-dev і $echo-qa.
Перед реалізацією покажи специфікацію для погодження.
```

Approval of a spec alone does not start dev/QA. Once approval and the chain's
implementation authorization are present, focused local baseline checks, previews
and verification are covered; do not ask again at every internal transition.
Record requested order and completed/current/pending stages. Respect a different
explicit order, but report missing prerequisites instead of silently reordering.

Main may return defects to dev and repeat affected QA checks within an authorized
dev+QA chain. After three unsuccessful repair cycles for the same defect, stop
with diagnosis/options. A standalone QA request never starts a repair loop.
Final acceptance/full E2E requires the owner's separate authorization naming the
test scope/environment. It never weakens required checks before merge. Human
acceptance, QA verification and dev self-checks are distinct. Children never
commit, push, manage PRs, merge or deploy; main follows existing Git permissions,
and push/PR/publication is not implied by a workflow request. Real-environment
mutations retain the explicit `AGENTS.md` approval gate.

## Context and handoff

Resolve root using `git rev-parse --show-toplevel`, including from `wdintel-web`.
Read applicable [AGENTS.md](../../AGENTS.md), [CODE_REVIEW.md](../../CODE_REVIEW.md)
and the owning contracts. Main UI uses [PRODUCT.md](../../PRODUCT.md),
[DESIGN.md](../../DESIGN.md), the [layout contract](layout-component-contract.md)
and affected [behavior contracts](react-behavior-contracts/README.md).
Do not apply main Echo rules to GOI/docs by analogy.

Dispatch the actual named role through the client's native interface with
`fork_turns="none"`. Do not override its configured model/effort. If named roles,
fresh context or the configured model are unavailable, report a blocker; do not
substitute a generic agent, another chat, inline execution or a nested AI CLI.
For a paused stage, relay answers through main and retain that stage's context;
a new stage starts fresh. Do not reconstruct parent history from session files.

Fresh context avoids copying the previous chat transcript; it is not token-free
or proof of lower total cost. Each role still receives applicable instructions,
its tool/skill context and handoff, and spends tokens reading the required files.
Main retains the coordinating conversation. Dev reads the approved specification,
plan, prepared tests/coverage map, relevant contracts and code; it does not need
the designer's exploratory conversation. Load only relevant references and return
short evidence summaries rather than copying full logs between stages.

Use a short brief with paths rather than copying complete code/specs/logs:

```text
role / stage / requested sequence:
invocation: actual user request excerpt / named skill(s) / task and permitted stages
authorization: owner-approved scope, current phase, execution permission
spec_path / owner decisions:
revision / staged, unstaged and untracked starting changes:
relevant_paths: contracts, source, shared consumers, prepared tests
allowed_write_paths: assigned files or none
allowed_commands: actual local commands, environment/API mode or none
stop_after:
return: artifact paths, changes, commands/results, gaps and blockers
```

Every writer is told to preserve other people's changes. Assigned paths are
instructions, not filesystem ACLs; main inspects the actual diff after each
handoff and resolves material scope expansion. Roles inherit the parent's
permissions; this configuration does not create independent sandboxes.

| Artifact | Required content |
| --- | --- |
| Specification | User/task/outcome; sources/revision; scope/non-goals; decisions versus hypotheses; stable acceptance/scenario IDs; preconditions/actions/results; business rules, state transitions, permissions, validation, recovery and context; applicable width/theme/accessibility requirements; owner decisions and unresolved questions |
| Implementation plan | Spec/wireframe links; expected files/reasons; shared consumers/invariants; exact existing test paths/cases and gaps; new tests marked planned; small steps and real verification commands |
| QA prepare result | Acceptance ID → existing/new test → preserved/changed behavior → observed result or not-run; gaps, baseline readiness, execution limits |
| Dev result | Input versions/revision/dirty scope; expected versus actual changes; scenario/test outcomes; commands/environment/API mode; browser observations; deviations and unverified work |
| QA verify result | Exact criteria/revision/dirty diff; pass/fail/not-run with evidence; severity, reproduction, expected/actual; coverage gaps and readiness for joint review |

Reuse an agreed location. Otherwise store the spec at
`docs/superpowers/specs/YYYY-MM-DD-<task-key>.md`, the plan at
`docs/superpowers/plans/YYYY-MM-DD-<task-key>.md` and any SVG under
`docs/superpowers/specs/assets/<task-key>/`. A small task may use one document.
Keep role results in its evidence section or the task/PR, with full sanitized
logs/captures in a stated ignored local directory. No report publication or new
status database is implied. Resume from these materials after compaction.

## Designer

Read actual routes/components and coverage before asking targeted questions.
Clarify the concrete user outcome, navigation/Back, ownership of state,
permissions, errors/retry, cancellation, persistence and affected consumers.
Distinguish confirmed facts, code facts, hypotheses and human observations.
Pause dependent decisions when critical answers are missing; continue independent
analysis. Do not repeat settled questions or invent priorities from role names.

Create scenarios before the plan. Describe loading/empty/error/permission states,
long content, relevant themes/widths, focus/keyboard and preserved context. Name
reused exports, source paths and variants/props. Where relevant, inspect the
existing synthetic MessageCard stories at
`wdintel-web/src/stories/message-card/MessageCard.stories.tsx`; this is not a
complete component catalog. Inspect an already available synthetic preview or
state source-only limits. No server/dependency setup is implied by discovery.
New components/variants or styling changes need rationale and owner approval.

Use [designer tool selection](../../.github/skills/echo-designer/SKILL.md#design-tools):
repository Impeccable Markdown first; optional Product Design audit/ideate when
its tools and authorized synthetic inputs are available. Missing plugins use
source-based analysis and direct drawing, with explicit evidence limits.
The designer writes documents/diagrams only, not product code, scaffolds or tests.
Main handles technical planning outside the UI role's competence.

### Wireframe options

Default to static SVG monochrome blocks with short labels for layout, or a compact
Mermaid flow for navigation. Keep explanations, scenarios and state rules beside
the drawing. Render/inspect and show inline with a source link when supported;
otherwise mark rendering unverified. A diagram never proves interaction behavior.
HTML/interactive prototypes require an explicit format request. Image alternatives
and external editable canvases are optional requested outputs, not prerequisites;
external data/publication permissions still apply.

## Dev

Require the approved spec, implementation authorization and QA-prepared or
otherwise equivalent tests/coverage map. Trivial docs/static styling can have an
explicitly justified no-behavior-tests entry under `CODE_REVIEW.md`. Test readiness
is not a claim that tests passed. Inspect actual files and the starting dirty state.

1. Execute authorized preserved baseline tests before product edits. Important affected user journeys missing coverage need QA preparation first. Observe relevant RED for changed behavior; a bug reproduction is RED while preserved neighbors remain green. Setup failures/flakes are not RED. If the required baseline cannot run, stop dependent edits.
2. Implement the whole approved scope in small coherent blocks. Use existing components/tokens and stack skills. Inspect cumulative staged/unstaged/untracked changes after each block. Explain every new area; update the impact map and checks before shared-component/API expansion. Resolve material product changes through main.
3. Never weaken tests, add skips/retries or replace stronger integration evidence to get green. Return needed test corrections to main/QA with rationale. New regressions require meaningful cases, not implementation-mirroring tests.
4. Run affected suites and applicable build/type/lint checks. In `wdintel-web`, `npm run e2e` is smoke only; select affected existing specs with the installed Playwright runner. `--list` is not execution. Preserve `@regression` title tags and stronger Vitest/backend tests. Use actual Echo commands, not copied pytest/Compose commands from another project.
5. Inspect the implemented UI with available Playwright browser control: main/negative paths, permissions, Back/context, focus/keyboard, relevant widths/themes and shared consumers. Correct scoped mismatches and repeat affected checks. Automated runs and interactive observations are distinct; unavailable checks remain unverified.

Use repository `make-interfaces-feel-better` for approved details with Echo tokens
and reduced-motion/accessibility rules. No new styling system or global visual
change follows from loading it. Full E2E/final acceptance waits for its owner gate.

Read applicable existing guidance directly from `.github/skills`:
[Elm](../../.github/skills/frontend-elm-implementation/SKILL.md),
[React/MUI](../../.github/skills/frontend-react-mui-implementation/SKILL.md),
[HTML/CSS/accessibility](../../.github/skills/frontend-html-css-accessibility/SKILL.md),
[regression safety](../../.github/skills/frontend-regression-safety/SKILL.md) and
[Power wrappers](../../.github/skills/power-wrapper-components/SKILL.md).
These sources are unchanged; this workflow adds no `.agents/skills` aliases for them.

## QA

Main assigns exactly one mode. Use the repository `playwright-best-practices` and
[regression guidance](../../.github/skills/frontend-regression-safety/SKILL.md)
within that mode; guidance cannot authorize product fixes or extra execution.

**Prepare:** after spec approval, map stable acceptance IDs to existing tests/gaps,
then add useful behavior tests/fixtures before product changes. Follow Echo's
Playwright, Vitest, Elm and backend test boundaries. Preserve existing behavior
with green baseline cases and identify changed behavior intended to fail before
implementation. Execute only the commands allowed in the brief; without execution,
record not-run instead of inventing RED/GREEN. Return readiness/gaps and stop.

**Verify:** inspect the actual implementation/diff and criteria, not only the dev
report. Run relevant authorized checks and rendered interactions; report missing
scenario coverage. Reuse evidence only when revision, dirty diff, environment and
scenario match. Report pass/fail/not-run, API mode, exact commands and reproduction.
Verify user-visible outcomes; screenshots/API 200/mocks are insufficient for
unobserved interactions, real authorization or persistence. Do not change product
code, assertions or permanent tests during verify; return defects to main.

Prepared tests are not passes. A role's report is not owner acceptance or proof
of human usability. Separate contexts reduce shared assumptions but do not prove
independent review quality. Keep captures local and synthetic/redacted.

## Skill and tool boundaries

These boundaries apply to main while coordinating this workflow and to every
assigned child. They do not install or reconfigure teammates' personal plugins.

- Children use only their declared skill profile; missing/unrecognized skills are reported, not installed or silently substituted. The three entrypoint skills are disabled in child catalogs to prevent recursive dispatch. No child delegates, invokes nested Codex/Claude CLI, changes branches/worktrees or performs Git/release operations.
- Read repository sources for the two new helpers, even if personal copies share a name. Their entrypoints and [source notices](design-tools.md#managed-role-helper-skills) describe the reviewed subset and precedence. Optional personal plugin access is checked per developer; a clone grants no account access.
- Repository Impeccable contains only adapted Markdown guidance (`shape`, `critique`, `audit`), explicit-only metadata and provenance/license files. No runtime, hooks, detector or additional agents are included. Use product/design files and authorized source/browser tools; do not fetch or substitute a personal runtime. Preserve the caller's environment/settings.
- Product Design is limited to assigned audit/ideate with authorized synthetic/redacted inputs. Do not publish/upload operational messages, identifiers, raw traces, credentials or other sensitive data. An external tool request needs the corresponding user-authorized destination/data scope.
- No package/browser/plugin installation, automatic updates, remote reporters/webhooks, CI changes, destructive cleanup or sandbox/approval bypass follows from skill examples. Report missing capabilities to main. Use existing runners and disposable local/test-owned data; all real-environment mutations require the existing explicit approval.
- Scope and approved design override generic helper suggestions. Preserve tokens/components, title-based test selection and meaningful stronger coverage; never hide failures or assume global styling/animation changes are authorized.

The TOML `skills.config` rules match exact names/known aliases; they are a finite
catalog filter, not a wildcard allowlist or a tool/network ACL. New names may be
unmatched and same-name personal copies may exist. Instructions restrict use to
the profile and repo sources; review filters and verify effective catalogs after
plugin changes. Do not claim that disabling a skill disables all equivalent tools.

## Availability and validation

Role files are tracked under `.codex/agents`; dispatcher and the two helper sources
are in `.github/skills` with relative `.agents/skills` links. The Markdown-only
Impeccable subset lives directly in `.agents/skills/impeccable`. Root/subdirectory discovery,
client trust, managed policy, model access and effective filters must be verified
on each team's client/OS. Do not change global trust, permissions or main defaults.
Unsupported clients can read documentation but cannot silently emulate named roles.

**Runtime smoke: UNVERIFIED.** This adaptation validates configuration, local
skill discovery and source integrity. The current chat's dispatch schema lacks native `agent_type`;
no role launch, filtered runtime catalog, fresh-context isolation or effective
model has been verified. Metadata discovery is not that smoke.

When the user explicitly invokes the three entrypoints for a read-only smoke in
a supported client, run it sequentially and preserve that invocation in handoffs:
request each actual named role with fresh context; before file reads ask it to
report injected profile IDs/catalog (without feeding expected IDs); then read a
synthetic marker file and one assigned skill entrypoint without executing it.
Compare native dispatch metadata and output, check a parent-only marker was not
inherited, and inspect the diff. State that canaries/self-reports are limited
proof, not measured backend model identity or complete isolation. No product
pipeline, builds, tests, install, deployment or generic-agent fallback belongs to
that smoke. Then pilot ordinary/quoted prompts, skill-maintenance requests, generic
delegation, completed-task authorization, single stages, a requested chain,
missing baseline/browser, stale inputs and unexplained files with a teammate.

## Pilot measurements

Before a comparable real task, record baseline, scope, conditions, target and
observation window. Track missed decisions/scenarios, stage time, model/token
usage when available, rework/UI correction rounds, unexplained changed files,
and regressions by discovery stage/severity/repair time. Zero unexplained files
is the target; a low file count alone is not quality.

Measure user outcomes separately: correct unassisted completions / attempts,
median successful completion time, errors and context loss; distinguish failures,
timeouts and assistance, participant role, device and theme. Zero attempts is
not measured. A small pilot is descriptive and adds no telemetry or claim of
improved usability from agent checks alone.
