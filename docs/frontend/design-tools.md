# Shared design tools

The main Echo UI uses root [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md)
and repository-owned skill instructions. [Context use](design-workflow.md)
describes the small brief/review loop; [explicit Echo workflows](echo-workflows.md)
provides optional managed spec/designer/dev/QA roles. Personal plugins are optional.

For ordinary tasks, a supplied Figma screen/page link can be read without an
Echo-role invocation. Shared client configuration and the personal sign-in/access
flow are covered in [Figma access](figma-access.md); no local Figma server or plugin
installation is required for that flow.

For explicitly requested editable wireframes/designs, the designer can use the
official Figma MCP with Echo context, tokens and component sources; see the
[Figma guide](figma-design.md). Start without a library by creating only the
foundations/components needed for the task. Account/file access is checked per
developer. The shared `echo_figma` connection is for reading; existing authoring
connections and their permissions are not replaced.

## Team access and prerequisites

Git supplies the context and Markdown guidance. An AI client/account, model
access, optional plugins, browser access and application dependencies remain
separate capabilities. No Impeccable engine or hook setup is required.

| Client / OS | Delivery | Acceptance |
| --- | --- | --- |
| Codex CLI / Linux x64 | `.agents/skills`; relative links to `.github/skills` and the local Impeccable subset | Local validation target; CLI `0.162.0` |
| Codex desktop or IDE / each developer's OS | Same repository skills where the client supports them | Actual client/version/OS inventory and teammate checks pending |
| Claude Code CLI / Linux x64 | `.claude/agents` native adapters and explicit-only `.claude/skills` wrappers reading shared sources | Local CLI `2.1.199`; source/metadata validation only, native role runtime unverified |
| Other clients used by the team | Verify native `.github/skills` discovery or a necessary supported adapter without copying skill content | Inventory pending; not claimed supported by this change |
| Windows checkout without working Git symlinks | Use a verified symlink-capable checkout, for example WSL, or validate a client-specific adapter | Not accepted until checked on that configuration |

Complete the inventory with the team. Local Linux discovery does not establish
access for every developer. Missing frontend dependencies do not prevent reading
context or preparing a specification; running the app and `tokens:check` needs
the existing [frontend setup](../../README.md#setup), including private-package access.

## Repository skill discovery

Codex reads `.agents/skills` from cwd up to the Git root and supports symlinked
skill folders ([official documentation](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)).
Reload/start a session after checkout or updates; a running session may retain
an older catalog, including aliases removed from the checkout.

Four relative links expose `echo-spec`, `echo-designer`, `echo-dev` and `echo-qa`. Six more
expose `playwright-best-practices`, `make-interfaces-feel-better`, `ponytail`,
`brainstorming`, `systematic-debugging` and `verification-before-completion`; Impeccable
lives directly in `.agents/skills/impeccable`. All eleven have
`policy.allow_implicit_invocation: false`. Helper guidance does not launch stages.

Claude Code discovers eleven thin `.claude/skills` wrappers with native
`disable-model-invocation: true` frontmatter. They read the same shared entrypoints
and helper files; skill bodies/resources are not duplicated. Claude does not use
`agents/openai.yaml`. Children read their profile's guidance directly rather than
preloading disabled skills or selecting personal copies with the Skill tool.
The existing `CLAUDE.md` points to `AGENTS.md` and the shared workflow.

Explicitly invoke `$echo-spec`, `$echo-designer`, `$echo-dev` or `$echo-qa` in Codex
(or `/echo-spec`, `/echo-designer`, `/echo-dev`, `/echo-qa` in Claude Code), including the target
task, plan or criteria, or ask to apply the named skill. Ordinary requests and
skill-maintenance requests do not activate these workflows. Entrypoints dispatch
the native roles through the [client adapter](echo-workflows.md#native-dispatch);
role instructions and client-specific controls restrict their guidance. See the [invocation contract](echo-workflows.md#invocation-and-chaining)
and [runtime limits](echo-workflows.md#availability-and-validation).

`echo-spec` prepares requirements and acceptance criteria for approval;
`echo-designer` consumes an approved specification (including a compact manual
brief) for UX flows, wireframes and design. One stage never implicitly starts
the other. Missing requirements return to their owner; designer does not rewrite
them. A designer-only request returns the requested design artifacts and notes
without companion repository PNGs or an implementation plan. Main handles technical planning
only for separately requested planning/dev work.

The five existing frontend/Power skills remain at their original `.github/skills`
paths, listed in the [dev contract](echo-workflows.md#dev). Dev reads the applicable
files directly; QA reads regression safety. This change adds no discovery aliases
or auto-invocation metadata for those existing references. Their earlier usage
by other clients remains unchanged.

If skill discovery is unavailable, an explicit request to read an exact `SKILL.md`
can load its instructions; this does not emulate a missing native named role.
Managed entrypoints stop when role dispatch is unavailable. Resolve paths from
the Git root and retain working symlinks. Metadata discovery is not execution.

## Managed-role helper skills

| Helper | Assigned role | Pinned source | Included material |
| --- | --- | --- | --- |
| [playwright-best-practices](../../.github/skills/playwright-best-practices/SKILL.md) | QA prepare/verify | [currents-dev, `0b75b5835a87de1fdd202ba965f3bc5a27738fdf`](https://github.com/currents-dev/playwright-best-practices-skill/tree/0b75b5835a87de1fdd202ba965f3bc5a27738fdf/playwright-best-practices) | Echo entrypoint, nine selected Markdown references, MIT license and source notice |
| [make-interfaces-feel-better](../../.github/skills/make-interfaces-feel-better/SKILL.md) | Dev, approved UI details | [jakubkrehel, `35545ea1512ad59fa463e6b1f95ca9c052981fe6`](https://github.com/jakubkrehel/make-interfaces-feel-better/tree/35545ea1512ad59fa463e6b1f95ca9c052981fe6/skills/make-interfaces-feel-better) | Echo entrypoint, five Markdown references, MIT license and source notice |
| [ponytail](../../.github/skills/ponytail/SKILL.md) | Dev, minimal complete implementation | [DietrichGebert, `356918eba965ee1eac64bd3a7f0dd02108350de5`](https://github.com/DietrichGebert/ponytail/tree/356918eba965ee1eac64bd3a7f0dd02108350de5) | Self-contained Echo adaptation of the core skill, MIT license and source notice |
| [brainstorming](../../.github/skills/brainstorming/SKILL.md) | Spec requirements, designer UX discovery | [Superpowers `v7.0.1`, `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b) | Self-contained Echo adaptation, MIT license, source pin/hash and notice |
| [systematic-debugging](../../.github/skills/systematic-debugging/SKILL.md) | Dev/QA failure investigation | [Superpowers `v7.0.1`, `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b) | Self-contained Echo adaptation, MIT license, source pin/hash and notice |
| [verification-before-completion](../../.github/skills/verification-before-completion/SKILL.md) | Dev/QA evidence before reporting results | [Superpowers `v7.0.1`, `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`](https://github.com/obra/superpowers/tree/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b) | Self-contained Echo adaptation, MIT license, source pin/hash and notice |

These are project-local adaptations, not personal-plugin installations or full
upstream bundles. Each `NOTICE.md` records the source, pinned version and local
adaptations. No executable helpers, hooks, installer, CI configuration or product
package dependency is included.

Dev always reads repository Ponytail directly; a personal Ponytail installation
is not needed and is not substituted when present. Its default level is `full`;
`lite`/`ultra` remain task choices within the approved scope. The plugin router,
code-simplification and review/audit/debt/gain/help modes are not bundled or used
by this role. Echo's Power components, test scope and handoff requirements take
precedence over upstream native-control, demo-test and terse-output advice.

The three Superpowers adaptations are read directly from their repository paths;
personal copies and namespaced aliases are not substituted. Brainstorming keeps
the spec/designer ownership split; debugging keeps QA reporting separate from
dev repairs; verification respects test scope, evidence reuse and environment
approval. No other Superpowers skills, runtime, task-document commits, automatic
planning/delegation or browser setup are required. Their presence does not invoke
an Echo stage or override the owner's requested scope.

The static review identified instructional risks in generic examples: Playwright
setup, reporters/uploads, cleanup, retries/force clicks and incompatible tag
conventions; UI guidance prescribes fixed motion/color values and global styles.
The Echo entrypoints and role instructions restrict examples to the assigned stage,
existing test environment, components/tokens and approved design. CI/Docker/install/
platform guides are omitted. Pinned links to omitted upstream material are optional
references, not permission to fetch or execute it. New names/aliases need catalog
review because exact-name filters are not an ACL.

## Impeccable provenance

[Repository Impeccable](../../.agents/skills/impeccable/SKILL.md) is an adapted
Markdown subset of [Impeccable `4.8.0`](https://github.com/pbakaus/impeccable/tree/414603bf14c7a344edb466bb1f85690c77ce8b7d),
source commit `414603bf14c7a344edb466bb1f85690c77ce8b7d`. It retains the Apache-2.0
license, upstream notice and documented local changes in
[NOTICE.md](../../.agents/skills/impeccable/NOTICE.md).

The selected `shape`, `critique` and `audit` references cover task clarification,
layout, usability, accessibility, theming, responsive behavior and evidence.
They are adapted for Echo's documents/review scope. Engine commands, runtime files,
additional agent definitions, live tooling and hook configuration are omitted.
`agents/openai.yaml` is explicit-only skill metadata, not a child-agent definition.
No shared `.impeccable` config or special Git whitespace rules are needed.

Use source files and an already available authorized synthetic preview. A missing
browser leaves rendered checks unverified; source review is not detector output
or proof of usability. Do not restore runtime dependencies to use these references.

## Personal plugins and optional Product Design

Check the source before loading a skill: repository and personal/plugin copies
with the same name are not merged, and repository precedence is not guaranteed.
Managed roles read the repository paths directly. Do not uninstall plugins or
change global settings to resolve a naming conflict; this local explicit-only
policy does not alter a developer's personal copy.

Product Design is optional per developer/client/account. The designer uses focused
`audit` for existing-flow review and `ideate` for requested image alternatives,
with authorized synthetic/redacted inputs. Check tool/browser availability and
preserve evidence limits. Do not copy personal `user-context.md` into Git or assume
plugin access transfers with a clone. Without plugins, use repository context,
source analysis and simple SVG/Mermaid diagrams; no image generation is required.

## Updates and validation

Update each Markdown subset only in a reviewed change: select a source commit,
inspect changed instructions/examples, preserve license/notices, document adapted
files and update the source pin. Keep explicit-only metadata and role scope; do
not import full runtime bundles or auto-update personal tools.

Validate relative links, role configuration, skill metadata and discovery from
root/subdirectory after updates. Roll back to a reviewed repository version if
needed; personal configuration remains separate.

The safety review is static: provenance, file types, instructions/examples, scope
and invocation metadata. It cannot guarantee model compliance, isolation or external
service behavior. A read-only native-role smoke verified current profile injection
and direct reading of every assigned repository skill for all four roles. Automatic
catalog exposure differs from direct access; complete effective filters, backend
model identity, context isolation and Figma execution remain unverified. See the
[validation contract](echo-workflows.md#availability-and-validation).

Before calling rollout complete, run the [pilot measurements](design-workflow.md#pilot-measurements),
include another developer and verify every required client/OS. Static checks and
metadata discovery do not replace teammate acceptance or user research.
