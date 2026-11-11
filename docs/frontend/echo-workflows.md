# Explicit Echo workflows

These workflows run only when the user explicitly invokes the matching
`echo-spec`, `echo-designer`, `echo-dev` or `echo-qa` skill for the current task. Ordinary work
follows the existing repository rules; reading this guide, mentioning a role,
quoting a command or asking an ordinary UI/coding/review question does not activate one.

| Entrypoint (Codex / Claude Code) | Native role | Codex model / reasoning | Assigned output |
| --- | --- | --- | --- |
| `$echo-spec` / `/echo-spec` | `spec` | `gpt-6.1-sol` / `high` | Requirements, business rules, scenarios and acceptance criteria for approval |
| `$echo-designer` / `/echo-designer` | `designer` | `gpt-6.1-sol` / `high` | UX flows, wireframes/Figma design and design notes from an approved specification |
| `$echo-dev` / `/echo-dev` | `dev` | `gpt-6.1-sol` / `high` | Approved implementation, focused self-checks and browser observations |
| `$echo-qa` / `/echo-qa` | `qa`, mode `prepare` or `verify` | `gpt-6-luna` / `high` | Prepared tests/coverage map, or verification findings |

The main chat retains the user's chosen model and coordinates stages/questions.
The four `.codex/agents/*.toml` files define Codex child roles; their
`developer_instructions` strings are the canonical shared role prompts. Claude
Code adapters read those strings after their own invocation check. `agents/openai.yaml`
files are Codex skill metadata, not agent definitions. The project
`.codex/config.toml` configures only the separate [Figma reading connection](figma-access.md);
it changes no role model, shell environment or sandbox settings. For subagent enablement and concurrency
limits, the developer's effective client
settings apply. If subagents are disabled, report the blocker without changing
those settings. Main runs this workflow's stages sequentially, with one writer
at a time, regardless of the available slots. This ordering applies only to the
explicitly invoked Echo workflow, not other developer workflows.

## Native dispatch

Use the adapter for the actual client; file format or tool availability does not
authorize a different role, model or stage.

| Client | Role definitions | Main-chat entrypoints | Dispatch |
| --- | --- | --- | --- |
| Codex | `.codex/agents/{spec,designer,dev,qa}.toml` | `.agents/skills/echo-*` links to `.github/skills` | Native named role with `fork_turns="none"`, no model/effort overrides |
| Claude Code | `.claude/agents/{spec,designer,dev,qa}.md` | `.claude/skills/echo-*/SKILL.md` wrappers | Native `Agent` tool selecting the exact named subagent, in a new context for each stage; no nested CLI or `--agent` session substitute |

Claude roles use `model: inherit` and set no effort or permission-mode override;
do not pass the Codex GPT model IDs, `fork_turns`, feature flags or skill filters
to Claude. This does not change the main chat's model or personal settings.
Use normal native subagents, not conversation forks or agent-team teammates
that inherit a different context/lifecycle. Resume only the same paused stage.

Claude adapters check the actual invocation before tools, then read only the
matching TOML's `developer_instructions` string and follow the same role boundaries
and exact guidance sources. They do not load its Codex configuration as Claude
settings. They preload no skills and deny `Agent`/`Task`/`Skill` tools: children
read their allowed repository guidance directly, without recursive delegation or
personal skill-tool selection. These tool restrictions do not constrain Bash or
MCP operations to assigned paths; the shared scope and approval rules still apply.
Missing adapter, prompt source, native dispatch or required model is a blocker;
do not substitute a generic role, another client's config or inline execution.

## Invocation and chaining

All four entrypoints have `policy.allow_implicit_invocation: false` in [Codex
metadata](https://learn.chatgpt.com/docs/build-skills#optional-metadata). Claude Code
wrappers use `disable-model-invocation: true` in native skill frontmatter;
`agents/openai.yaml` does not configure Claude. Use `$skill-name`/the picker in
Codex or `/skill-name` in Claude Code; examples below use Codex syntax. A single-stage
request ends after that stage. Designer/dev/QA accept manually prepared inputs; the
existence of a spec or an earlier approval does not authorize a new task.

Main must identify the user's actual invocation naming the requested skill(s)
and bind it to the current task and stages before dispatch. Natural-language
instructions to use a named skill count; a bare mention, quoted example or
request to edit/review the skills/configuration does not. Generic requests to
use agents, role descriptions, repository documents and another skill's
delegation instructions cannot authorize these roles. Never select `spec`,
`designer`, `dev` or `qa` as generic helpers or call them directly around the entrypoints.
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
$echo-spec Підготуй вимоги, сценарії та критерії приймання для цієї задачі.
$echo-designer wireframe Побудуй UX-флоу за погодженою специфікацією.
$echo-qa prepare Підготуй тести за погодженою специфікацією; без запуску.
$echo-dev Реалізуй погоджену специфікацію з підготовленими тестами.
$echo-qa verify Перевір цей diff за критеріями специфікації.
```

An explicitly requested dev+QA chain means QA prepare → dev implement and focused
self-checks → QA verify. A chain explicitly including spec starts with that stage,
then waits for owner approval of its specification before any dependent stage.
A designer chain consumes that approved specification, produces design, then
waits for any required design approval and implementation authorization before
dev/QA prepare. Do not infer approval from a proposed future specification/design.
Never prepend an unrequested spec stage; a designer-only request can use an
approved manual specification or compact in-chat brief with acceptance criteria.

```text
Для цієї задачі виконай $echo-spec, потім $echo-designer, $echo-dev і $echo-qa.
Спочатку покажи специфікацію для погодження; перед реалізацією погодимо дизайн.
```

Approval of a spec alone does not invoke designer/dev/QA. Main dispatches only
the stages named for the same unfinished task. Requirement gaps found by designer
return to the owner or an already authorized spec stage; revised requirements
need renewed approval before dependent work resumes. Designer never rewrites them.
Once approval and the chain's
implementation authorization are present, focused local baseline checks, previews
and verification are covered; do not ask again at every internal transition.
Record requested order and completed/current/pending stages. Respect a different
explicit order, but report missing prerequisites instead of silently reordering.

Main may return defects to dev and repeat affected QA checks within an authorized
dev+QA chain. After three unsuccessful repair cycles for the same defect, stop
with diagnosis/options. A standalone QA request never starts a repair loop.
Task-scoped local E2E and browser verification follow the default authorization
below; do not request a separate testing-permission sentence. Real-environment
mutations retain the operation/target approval gate in `AGENTS.md`. Human
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

Dispatch the actual named role through the client's [native adapter](#native-dispatch)
with fresh context. Do not override its configured model/effort. If named roles,
fresh context or the configured model are unavailable, report a blocker; do not
substitute a generic agent, another chat, inline execution or a nested AI CLI.
For a paused stage, relay answers through main and retain that stage's context;
a new stage starts fresh. Do not reconstruct parent history from session files.

Fresh context avoids copying the previous chat transcript; it is not token-free
or proof of lower total cost. Each role still receives applicable instructions,
its tool/skill context and handoff, and spends tokens reading the required files.
Main retains the coordinating conversation. Designer reads the approved
specification and its acceptance IDs, not the spec role's exploratory transcript.
Dev reads the approved specification, design notes/frames when applicable,
plan, prepared tests/coverage map, relevant contracts and code; it does not need
the designer's exploratory conversation. Load only relevant references and return
short evidence summaries rather than copying full logs between stages.

Use a short brief with absolute artifact paths rather than copying complete
code/logs. Every task specification must exist as a Markdown document before
handoff. Main assigns `specs/<task-id-or-slug>/specification.md` from the Git root
by default, or the user's explicit destination, without asking for routine path
confirmation. The existing `specs/` ignore rule keeps the default artifacts local.
Main materializes approved in-chat/manual requirements before dispatch too; a
previous spec-role run is not required. Keep the document current after owner
corrections and include the task, settled decisions, acceptance IDs, scope,
source revision, approval status, coverage and evidence limits so a fresh agent
can work without this chat. When technical planning is requested, main also
saves `implementation-plan.md` beside it, referencing the exact spec revision.
Pass `spec_path` and applicable `plan_path`, verify they are readable from the
destination checkout/host, and return their links to the user. Saving documents
does not grant approval or invoke another stage. Do not pass the exploratory
conversation or reconstruct it from session history.

```text
role / stage / requested sequence:
invocation: actual user request excerpt / named skill(s) / task and permitted stages
authorization: owner-approved scope, current phase, execution permission
spec_path (absolute Markdown path) / document revision / owner approval and decisions:
plan_path (absolute Markdown path, when planning was requested) / input spec revision:
cleanup_paths (exact temporary documents created for this task; retain until dev + QA verify pass):
design_paths / design approval (when applicable):
output_preset / explicit task overrides:
output_format / Figma target, permitted operations and synthetic input scope (when requested):
revision / staged, unstaged and untracked starting changes:
relevant_paths: contracts, source, shared consumers, prepared tests
allowed_write_paths: assigned files or none
allowed_commands: actual local commands, environment/API mode or none
local verification: default task-scoped permission / explicit owner restrictions
dev/QA CPU baseline: 4x slowdown; affected browser scenarios/data and execution limits
spec/designer UX: mandatory ongoing analysis, best-practice check and findings in output
stop_after:
return: artifact paths, changes, commands/results, gaps and blockers
```

Every writer is told to preserve other people's changes. Assigned paths are
instructions, not filesystem ACLs; main inspects the actual diff after each
handoff and resolves material scope expansion. Roles inherit the parent's
permissions; this configuration does not create independent sandboxes.

| Artifact | Required content |
| --- | --- |
| Specification (spec role or manual input) | Saved Markdown path and document revision/approval status; user/task/outcome; sources/revision; scope/non-goals; decisions versus hypotheses; stable acceptance/scenario IDs; preconditions/actions/results; business rules, state transitions, permissions, validation, recovery and context; applicable width/theme/accessibility requirements; UX analysis and best-practice check for spec-role output; owner decisions and unresolved questions |
| Design result (designer) | Input specification revision/approval; acceptance-ID → UX flow/frame/state mapping; reused component/token sources; design links/notes, observations, UX decisions, UX analysis and best-practice check, design approval and evidence limits; requirement gaps returned to the owner |
| Implementation plan (main, only for requested planning/dev work) | Saved Markdown path; input specification path/revision and approval evidence; needed design links; expected files/reasons; shared consumers/invariants; exact existing test paths/cases and gaps; new tests marked planned; small steps and real verification commands |
| QA prepare result | Acceptance ID → existing/new test → preserved/changed behavior → observed result or not-run; gaps, baseline readiness, execution limits |
| Dev result | Input versions/revision/dirty scope; expected versus actual changes; scenario/test outcomes; commands/environment/API mode; browser observations; deviations and unverified work |
| QA verify result | Exact criteria/revision/dirty diff; pass/fail/not-run with evidence; severity, reproduction, expected/actual; coverage gaps and readiness for joint review |

Task specifications and requested implementation plans are mandatory Markdown
handoff documents at the assigned paths; chat summaries alone are insufficient.
Design notes and audit reports still default to chat unless a document was
assigned. Do not automatically put generated task artifacts under `docs/` or
add them to Git. Shared skill/workflow documentation stays in the repository.
An implementation plan still requires a separate planning/dev scope and belongs
to main, not spec or designer.
For Figma deliverables, images/screenshots are transient inspection evidence;
do not save companion PNG/mockup files into repository documentation or link them
there unless the user explicitly requests an export.
Keep role results in its evidence section or the task/PR, with full sanitized
logs/captures in a stated ignored local directory. No report publication or new
status database is implied. Resume from these materials after compaction.

## Handoff document lifecycle

Specifications and implementation plans created for a task are temporary handoff
documents. Keep them available through dev, QA prepare/verify and any repairs.
After implementation is complete and QA verify passes the applicable criteria
for the same final revision/dirty diff, main records the final result and
automatically deletes the exact task-created files listed in `cleanup_paths`.
Dev and QA return these paths and completion/verification evidence to main;
neither deletes the documents while another stage still needs them. No extra
cleanup confirmation is needed for these generated files.

Dev self-checks, QA prepare, a failed/interrupted verify or a required not-run
check do not satisfy this condition: retain the files for continuation. Do not
invoke an unrequested QA stage to unlock cleanup. Remove only the listed
generated documents, never a whole `specs/` tree, another task's files,
user-provided source documents, shared guidance, product code, tests or QA
evidence. Honor an explicit user instruction to retain the documents. Saving or
cleaning up artifacts does not grant Git, publication or deployment authority.

## UX analysis and best-practice check

Spec and designer must analyze UX throughout their work: establish the user task
and current friction during discovery, assess meaningful alternatives as decisions
are made, and recheck the proposed result before handoff. A final checklist alone
does not replace this analysis. Use repository product context, contracts and
actual source/artifacts; preserve established patterns and approved decisions.

Check relevant UX principles: clear system status and feedback; familiar domain
language and consistency; user control, Back/cancel and context preservation;
error prevention and recovery; recognition over recall and cognitive load;
efficient frequent tasks; information/action hierarchy; keyboard/focus,
accessibility and responsive behavior; loading, empty, error and success states.
Explain material tradeoffs rather than citing a generic best practice as proof.

Include a **UX analysis** section in the specification or design notes: checked
principles; scenario/acceptance ID → evidence or hypothesis → user impact →
decision/proposed change and rationale → validation needed. Record supported
no-change conclusions, unresolved risks and evidence limits; do not invent issues.
For work without user-facing impact, state why the check is not applicable.

Spec translates findings into proposed behavioral requirements and observable
acceptance criteria for approval, leaving layout to designer. Designer checks
concrete flows/states with repository Impeccable `critique`, documents UX choices
and returns requirement changes to their owner before dependent work continues.
Plugins, live previews and user research are not prerequisites for this analysis;
label source-only/static checks and hypotheses. Heuristic review does not prove
rendered interactions or user-tested usability and grants no extra tool access.

## Specification

The `spec` role owns requirements and acceptance criteria, not visual design.
Read repository [brainstorming](../../.github/skills/brainstorming/SKILL.md)
directly for requirements discovery; no personal Superpowers plugin is needed.
Read the feature description, current business logic, owning contracts and
existing coverage before asking targeted questions through main. For main UI,
use PRODUCT.md and the relevant UI context; derive permissions from code/contracts.
Record the user/task/outcome, scope/non-goals, inputs/outputs, business rules,
state transitions, permissions, persistence, validation, errors/retry/cancel,
navigation/context and shared-consumer impact. Distinguish confirmed decisions,
source facts and hypotheses. Unresolved material decisions block readiness.

Assign stable acceptance/scenario IDs and observable outcomes, preserve existing
behavior, and name exact existing coverage/gaps without claiming tests ran.
Describe applicable accessibility/theme/responsive constraints, leaving UX layout
and styling to designer unless already constrained by the owner or contracts.
Write the specification to its assigned Markdown `spec_path`, update it after
owner corrections and return the document link/revision in chat. No wireframes,
Figma access, implementation plans, product code, executable tests or test/build
execution. No Figma destination is needed. Return readiness/open questions and
evidence limits, then stop for owner approval. Main owns technical planning.

## Designer

Require the approved specification and its revision/approval evidence, or a
compact approved manual brief with acceptance criteria. A prior `echo-spec` run
is optional. Missing input goes back to main; designer does not author a substitute
specification or launch spec. For Figma, main resolves the destination/page before
dispatch. Retain the [request flow](figma-design.md#request-flow) and shared presets.

Translate acceptance IDs into UX flows, screens/states, navigation, hierarchy,
focus/keyboard, responsive layouts and approved visual design. Preserve the
specification's business rules and acceptance IDs. Resolve UX decisions through
main and report requirement gaps/changes to the specification owner; pause
dependent design until revised requirements are approved. Record UX decisions
and state mappings in design notes, not rewritten requirements.

Read repository [brainstorming](../../.github/skills/brainstorming/SKILL.md)
directly for UX discovery within those requirements; it does not start planning
or implementation. No personal Superpowers plugin is needed.

Read actual routes/components and relevant coverage; name reused exports,
source paths and variants/props. Where relevant, inspect the
existing synthetic MessageCard stories at
`wdintel-web/src/stories/message-card/MessageCard.stories.tsx`; this is not a
complete component catalog. Inspect an already available synthetic preview or
state source-only limits. No server/dependency setup is implied by discovery.
New components/variants or styling changes need rationale and owner approval.

Use [designer tool selection](../../.github/skills/echo-designer/SKILL.md#design-tools):
repository Impeccable Markdown first; optional Product Design audit/ideate when
its tools and authorized synthetic inputs are available. Missing plugins use
source-based analysis and direct drawing, with explicit evidence limits.
The designer writes design notes/diagrams and requested Figma Design artifacts,
not specifications, implementation plans, product code, scaffolds or tests.
For editable Figma wireframes and
design, follow the [Figma guide](figma-design.md), including a new-file destination,
official skill loading, Echo token/component mappings and screenshot inspection.
For a designer-only request, main and designer stop after the requested design
artifacts and notes; they do not create an implementation plan or invoke a planning workflow.
Main prepares technical plans only for separately requested planning/dev work,
using the approved specification and any needed design. Design approval and
implementation authorization remain separate from specification approval.

### Wireframe options

For requested Figma output, build editable native frames/components in the assigned
Design file. The [output presets](figma-design.md#output-presets) define the
`wireframes` / `design` shorthand, Figma format and reusable presentation defaults.
Without a preset or Figma format request, use a static SVG layout or compact
Mermaid flow. Keep explanations, scenarios and state rules beside the drawing.
Render/inspect and show inline with a source link when supported;
otherwise mark rendering unverified. A diagram never proves interaction behavior.
HTML/interactive prototypes require an explicit format request. Image alternatives
and external editable canvases are optional requested outputs, not prerequisites;
external data/publication permissions still apply.

## Default local verification authorization

An actual invocation of `echo-dev` for approved implementation or `echo-qa` for
task preparation/verification includes the necessary local verification. Main
derives and records the affected baseline/regression tests, task-scoped E2E,
browser checks and applicable build/type/lint commands and local API mode in the
handoff. Use synthetic or isolated test-owned data; browser scenarios use CPU
slowdown **4x**. QA prepare may run relevant baseline/RED checks as part of test
preparation; it still cannot implement product behavior. The user need not repeat
an additional sentence permitting these checks or reconfirm each transition.

Use existing installed runners and browsers, reusing an appropriate local preview
or starting the repository's task-local test/preview process when needed. Stop
only processes started for this task; do not replace another running environment.
Test data mutations stay within isolated test-owned resources. This permission
does not include package/browser installation, unrelated test campaigns, external
accounts/uploads or changes to shared databases and real environments. Staging,
including `echo-staging`, production and all their mutations retain the explicit
operation/target approval gate in `AGENTS.md`. Human acceptance is not implied.

Explicit read-only, prepare-without-execution, command or environment restrictions
take precedence and must be passed to the child. Missing tools/CPU controls or
safe test resources remain reported gaps, not reasons to weaken checks or bypass
sandbox approvals. Skill/configuration maintenance, quoted invocations and
read-only role smokes do not invoke dev/QA or authorize product verification.
This is task authorization, not a tool ACL or permission-mode change, and never
invokes another stage or a real environment implicitly.

## CPU throttling baseline

Functionality is always developed with **CPU throttling: 4x slowdown** in mind.
This is the default browser baseline for dev and QA, even when the approved spec
does not repeat it. Dev accounts for it during implementation and self-checks;
QA prepare includes it in affected browser scenarios and QA verify checks them.

Use available browser CPU controls to set 4x before navigation/interactions and
keep it enabled for affected flows, including relevant loading, input/filtering,
scrolling and recovery, with representative data volumes. Check correctness and
responsiveness against approved criteria; report freezes, delayed feedback and
timing/race defects. Do not invent numerical performance budgets or hide failures
with extra sleeps, retries or increased timeouts.

Record browser, CPU setting/method, data volume, scenario IDs and observed results
in dev/QA evidence. Unthrottled runs are supplementary. If authorized execution
or CPU controls are unavailable, report the 4x scenarios as not-run/unverified
with the reason; do not claim the baseline passed. Execution follows the default
local verification authorization and any explicit owner restrictions. Browser
CPU slowdown does not emulate network latency
or backend load, and does not replace other required checks or environment gates.

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
change follows from loading it. Task-scoped local E2E is covered by the default
verification authorization; real-environment approval and human acceptance remain
separate.

Before implementation, read repository [Ponytail](../../.github/skills/ponytail/SKILL.md)
directly and apply its default `full` level unless the task selects `lite`/`ultra`.
This core Markdown adaptation needs no personal plugin. Do not substitute a
personal copy or its router/code-simplification modes. Minimal implementation
still preserves the entire approved scope, Power wrappers and required checks.

For failures, read repository [systematic-debugging](../../.github/skills/systematic-debugging/SKILL.md)
directly. Before reporting results, read repository
[verification-before-completion](../../.github/skills/verification-before-completion/SKILL.md).
Neither requires a personal Superpowers plugin or expands permitted commands,
test scope or real-environment approval. Reuse evidence only for matching source,
dirty state, environment and scenarios; rerun affected checks after changes.

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

Read repository [systematic-debugging](../../.github/skills/systematic-debugging/SKILL.md)
for failures and [verification-before-completion](../../.github/skills/verification-before-completion/SKILL.md)
before returning prepare/verify results, not personal copies or Superpowers aliases.
Necessary local execution is covered by an actual QA invocation unless the owner
restricts it. Prepared tests that were not executed remain not-run; a verify
assignment does not permit product or permanent test/assertion edits.

**Prepare:** after spec approval, map stable acceptance IDs to existing tests/gaps,
then add useful behavior tests/fixtures before product changes. Follow Echo's
Playwright, Vitest, Elm and backend test boundaries. Preserve existing behavior
with green baseline cases and identify changed behavior intended to fail before
implementation. Main includes necessary local checks under the default
verification authorization in the brief, honoring explicit owner limits. Without
execution, record not-run instead of inventing RED/GREEN. Return readiness/gaps
and stop.

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

- Children use only their declared skill profile; missing/unrecognized skills are reported, not installed or silently substituted. All four entrypoint skills are disabled in child catalogs to prevent recursive dispatch. No child delegates, invokes nested Codex/Claude CLI, changes branches/worktrees or performs Git/release operations.
- Read repository sources for the six helpers, even if personal copies share a name. Their entrypoints and [source notices](design-tools.md#managed-role-helper-skills) describe the reviewed subset and precedence. Optional personal plugin access is checked per developer; a clone grants no account access.
- Repository Impeccable contains only adapted Markdown guidance (`shape`, `critique`, `audit`), explicit-only metadata and provenance/license files. No runtime, hooks, detector or additional agents are included. Use product/design files and authorized source/browser tools; do not fetch or substitute a personal runtime. Preserve the caller's environment/settings.
- Product Design is limited to assigned audit/ideate with authorized synthetic/redacted inputs. Do not publish/upload operational messages, identifiers, raw traces, credentials or other sensitive data. An external tool request needs the corresponding user-authorized destination/data scope.
- No package/browser/plugin installation, automatic updates, remote reporters/webhooks, CI changes, destructive cleanup or sandbox/approval bypass follows from skill examples. Report missing capabilities to main. Use existing runners and disposable local/test-owned data; all real-environment mutations require the existing explicit approval.
- Scope and approved design override generic helper suggestions. Preserve tokens/components, title-based test selection and meaningful stronger coverage; never hide failures or assume global styling/animation changes are authorized.
- Explicit Figma design tasks permit only the handed-off file/page/node operations and synthetic inputs under the [Figma guide](figma-design.md). Tool scripts build design artifacts, not repository implementation. No account-wide publication, sharing changes, Code Connect writes or unrestricted source uploads are inferred.

The TOML `skills.config` rules match exact names/known aliases; they are a finite
catalog filter, not a wildcard allowlist or a tool/network ACL. New names may be
unmatched and same-name personal copies may exist. Instructions restrict use to
the profile and repo sources; review filters and verify effective catalogs after
plugin changes. Do not claim that disabling a skill disables all equivalent tools.

## Availability and validation

Canonical role prompts and Codex configuration are tracked under `.codex/agents`;
Claude native adapters are in `.claude/agents`. Dispatcher and the six helper sources
are in `.github/skills` with relative `.agents/skills` links. The Markdown-only
Impeccable subset lives directly in `.agents/skills/impeccable`; Claude skill wrappers
point at these same sources. Root/subdirectory discovery,
client trust, managed policy, model access and effective filters must be verified
on each team's client/OS. Do not change global trust, permissions or main defaults.
Unsupported clients can read documentation but cannot silently emulate named roles.

**Codex runtime smoke: PASSED (read-only, 2026-11-09; this client).** Native `agent_type`
was available; `spec` → `designer` → `dev` → `qa` launched sequentially with
`fork_turns="none"` and no model/effort overrides. Before file reads, each role
reported its injected safety/skill profiles and visible catalog. The injected
skill profiles matched the current files: spec `v3`, designer `v6`, dev `v3`, QA `v2`.
All read the synthetic metadata marker and every assigned repository skill
entrypoint: spec 1, designer 2, dev 9, QA 4, without executing helper workflows.
HEAD, diff, status and hashes of all 32 preexisting changed/untracked paths
remained unchanged; no product tests/builds or external operations were run.

**Catalog exposure is separate from source access.** No automatic skill catalog
was exposed to spec/dev/QA. Designer saw `imagegen` and Product Design
`index`/`audit`/`ideate`; the four optional Figma skills were absent. Local
explicit-only skills were not exposed in these catalogs, but all assigned exact
repository paths were readable. The five frontend/Power references remain
direct-path guidance without discovery aliases. This smoke verifies that path,
not automatic invocation, every filter rule or optional Figma access.

**Actual backend models/reasoning effort and complete context isolation:
UNVERIFIED.** Configured roles specify `gpt-6.1-sol` / `high` for designer/dev and
`gpt-6-luna` / `high` for QA, but runtime metadata did not expose backend identity.
No role reported seeing the parent-only canary; fresh-context dispatch and these
self-reports provide limited evidence, not proof of complete isolation.

Reload/start a session after profile changes and check actual native role
availability; if a required role is absent, report the blocker without a
generic/inline replacement. Figma MCP access, authoring/rendering and complete
effective-filter behavior remain **UNVERIFIED** until explicitly invoked tasks
exercise them. This client's direct-read smoke does not establish teammate or
other client/OS availability.

Claude Code adapter validation covers frontmatter, shared-source links, explicit
invocation, role mapping and private-file exclusions. It does not establish native
role execution, effective tools, backend models or isolation. A Claude smoke needs
an explicitly invoked read-only task in that client; do not use a nested AI CLI
from Codex to emulate it. Report the injected adapter profile before reads and
the shared prompt's profile only after reading it; source-read IDs are not injected
profile evidence. New `.claude/agents` directories require a new Claude session.

When the user explicitly invokes the desired entrypoints for a read-only smoke in
a supported client, run it sequentially and preserve that invocation in handoffs:
request each actual named role with fresh context using that client's adapter;
before file reads ask it to report injected profile IDs/catalog (without feeding expected IDs); then read a
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
