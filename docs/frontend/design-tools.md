# Shared design tools

The main Echo UI uses root [PRODUCT.md](../../PRODUCT.md) and [DESIGN.md](../../DESIGN.md), two team skills, and a project-local Impeccable skill. [Context use](design-workflow.md) describes the minimal brief/review loop; the full task lifecycle is a separate planned deliverable.

## Team access and prerequisites

Git supplies the context and skill instructions. An AI client/account, optional plugins, browser access, engine installation, and personal hook trust are separate capabilities.

| Client / OS | Delivery | Acceptance |
| --- | --- | --- |
| Codex CLI / Linux x64 | `.agents/skills`; relative links to `.github/skills` and vendored Impeccable | Local validation target; CLI `0.162.0` |
| Codex desktop or IDE / each developer's OS | Same repository skills where the client supports them | Actual client/version/OS inventory and teammate checks pending |
| Other clients used by the team | Verify native `.github/skills` discovery or add a necessary supported adapter without copying skill content | Inventory pending; not claimed supported by this change |
| Windows checkout without working Git symlinks | Use a verified symlink-capable checkout, for example WSL, or validate a client-specific adapter | Not accepted until checked on that configuration |

Complete the inventory with the team. Two successful Linux runs do not establish access for every developer. Missing frontend dependencies do not prevent reading context or using the team brief/review skills; running the app and `tokens:check` needs the existing [frontend setup](../../README.md#setup), including private-package access.

## Repository skill discovery

Codex reads `.agents/skills` from cwd up to the Git root and supports symlinked skill folders ([official documentation](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)). Reload/start a session after checkout or updates; a running session may retain an older catalog.

The seven links expose `echo-ui-brief`, `echo-ui-review`, `frontend-elm-implementation`, `frontend-react-mui-implementation`, `frontend-html-css-accessibility`, `frontend-regression-safety`, and `power-wrapper-components`. Their maintained source is `.github/skills`. Duty rendering safety remains reference-only.

In Codex, invoke `$echo-ui-brief` for a brief and `$echo-ui-review` for review. Include the requested route/change. Both work from the root or `wdintel-web` without Product Design, ImageGen, a browser, or an Impeccable engine. Without a browser the result is source review with explicit visual/interaction limits.

If discovery is unavailable, ask the agent to read the exact repository `SKILL.md` and follow it; this is a manual fallback, not evidence that automatic discovery works. Resolve repository paths from `git rev-parse --show-toplevel` and retain working symlinks.

## Impeccable provenance

The project skill is vendored under `.agents/skills/impeccable`, unmodified from the official Codex project bundle, with upstream `LICENSE` and `NOTICE.md` added. There are no committed engine binaries or dependency changes to the application. The scoped `.gitattributes` rule preserves upstream bytes/line endings and excludes upstream whitespace from Git checks; Echo-owned files retain normal checks.

| Item | Pin |
| --- | --- |
| Skill / npm CLI | `4.8.0` |
| Skill and CLI source commit | `414603bf14c7a344edb466bb1f85690c77ce8b7d` |
| Skill release | [skill-v4.8.0](https://github.com/pbakaus/impeccable/releases/tag/skill-v4.8.0) |
| Bundle | [universal.zip](https://github.com/pbakaus/impeccable/releases/download/skill-v4.8.0/universal.zip) |
| Bundle SHA-256 | `82e6f6ff3a2b18f46f0f2fc388c1ab7abf3ccc52bbfc522456396d13011d6706` |
| Signature | [universal.zip.sig.json](https://github.com/pbakaus/impeccable/releases/download/skill-v4.8.0/universal.zip.sig.json), key `release-2026-09` |
| Signature SHA-256 | `b4e1ac4ed9d3050fcedae38fa3d57e1e685cfd628a47b3d5c2f2ee9b3303ee02` |
| Engine / source commit | `0.1.18` / `f29cd24fdecfa5612e35e34c1c868d4a3fca930c` |

The bundle's signature covers its version, artifact, size, and digest; see [upstream verification format and keyring](https://github.com/pbakaus/impeccable/blob/414603bf14c7a344edb466bb1f85690c77ce8b7d/docs/BUNDLE-SIGNING.md). Engine digests are in the vendored `scripts/engine-checksums.txt`. Pinning only `npx impeccable@4.8.0` would not pin the separately fetched skill bundle.

The verified import used this command in a disposable Git project, with the signed bundle and pinned engine already verified locally:

```sh
IMPECCABLE_BUNDLE_PATH=/absolute/path/to/verified/universal.zip \
IMPECCABLE_BIN=/absolute/path/to/verified/engine-0.1.18 \
node /absolute/path/to/unpacked/impeccable-4.8.0/cli/bin/cli.js \
  install --providers=codex --scope=project --no-hooks -y
```

Those paths are import-time inputs, not repository configuration. Local bundle overrides bypass remote signature verification, so verify the bundle first. The installer can exit successfully after installing skills even if the engine download fails; verify the engine separately. Ordinary onboarding uses the committed skill, **not** `install`, `update`, or an unpinned `npx` command.

## Install the local engine

The Linux x64 setup below downloads only the pinned engine and checks the digest before placing it beside the launcher. It does not install hooks or modify global client settings. Requirements: Git, `curl`, `sha256sum`, a POSIX shell, network access, and write access to this checkout.

```sh
(
  set -eu
  echo_root=$(git rev-parse --show-toplevel)
  echo_scripts="$echo_root/.agents/skills/impeccable/scripts"
  echo_engine_dir="$echo_scripts/bin/linux-x64"
  echo_digest=736ed785e74ae2344d3036127f614ddde5ab520a527d8bc82a891612ef71f648
  mkdir -p "$echo_engine_dir"
  curl --fail --location \
    https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.18/impeccable-linux-x64 \
    --output "$echo_engine_dir/impeccable.download"
  printf '%s  %s\n' "$echo_digest" "$echo_engine_dir/impeccable.download" | sha256sum --check
  chmod +x "$echo_engine_dir/impeccable.download"
  mv "$echo_engine_dir/impeccable.download" "$echo_engine_dir/impeccable"
  "$echo_scripts/impeccable" engine-probe
)
```

Expected probe: `impeccable-engine 0.1.18`. Stop on a download/hash/version failure; do not treat an installed skill as an installed engine. For other OS/architectures, validate the matching asset, digest, executable name and launcher from the same manifest before adding that configuration to the supported matrix.

The upstream launcher prefers `IMPECCABLE_BIN`, then its sibling binary, then an unversioned home binary, a versioned cache, and PATH. A personal override or home/PATH engine can differ from the pin. Use the sibling installation above, inspect any override, and confirm `engine-probe`; do not edit a colleague's environment automatically. The `scripts/bin` directory is ignored, so a clone needs its own engine setup. First download requires network; already installed context/skills remain usable if downloads are unavailable.

## Context, detector, and hooks

Use an explicit target. This Rust-root repository needs `projectRoots: ["wdintel-web"]` in the shared config so Impeccable recognizes the workspace and inherits the same root context from either cwd. These commands resolve the same two Markdown files:

```sh
# From the repository root:
.agents/skills/impeccable/scripts/impeccable context --target wdintel-web/src/ts/react/routes/rer-duty-neo/index.tsx

# From wdintel-web:
../.agents/skills/impeccable/scripts/impeccable context --target src/ts/react/routes/rer-duty-neo/index.tsx
```

The shared config selects `buildPath: "code"`, enables quiet hooks as a default, and disables only design-system drift checks. `DESIGN.md` intentionally contains descriptive metadata and canonical links rather than duplicate machine token scales. General detector checks remain available; live-panel `design.json`, token projections, and a global MUI palette migration are outside this iteration.

Run a manual check on changed supported UI files with `impeccable detect --json <target>` through the repository launcher. A findings exit code of `2` is different from a command/setup failure. Built-in source detection does not support `.elm`; use the existing Elm skill and review the rendered UI in the browser. An empty result can mean an unsupported file was skipped, and proves neither accessibility nor task usability.

Hooks are optional and need two separate steps:

1. From the **repository root**, explicitly run `$impeccable hooks on` in the client, or `.agents/skills/impeccable/scripts/impeccable hooks on` in the terminal. This writes local consent and installs `.codex/hooks.json`; it does not grant client trust.
2. Review and trust the definitions in Codex Settings → Hooks or CLI `/hooks`, then confirm actual feedback on a disposable supported UI fixture. New or changed definitions require review again.

Use `hooks status` and `doctor` through the same launcher. `state: enabled` describes configuration, not proof of trusted or executed hooks. Quiet mode suppresses clean acknowledgements; silence is not verification. The committed config includes the engine's default finding limits so repeated `hooks on` does not add shared defaults. Keep consent, generated manifests, caches, logs, and runtime artifacts ignored; ordinary/repeated setup must leave tracked files unchanged.

For a session-local opt-out use `IMPECCABLE_HOOK_DISABLED=1`. Upstream `hooks off` changes the **shared** config; do not use it as an unnoticed personal preference. Do not automatically run `init`, `document`, or broad ignore commands over the shared context.

## Personal plugins and optional Product Design

Check discovered skill sources and versions before invoking Impeccable. Codex can expose both repo and personal/plugin copies with the same name; they are not merged and repo precedence is not guaranteed. Select the repository source when identifiable, or explicitly ask to read its `SKILL.md` and use its launcher. Do not use `--force`, uninstall plugins, or edit global settings as a conflict workaround.

Product Design is optional per developer and supported client/account. Provide the same repo context and relevant synthetic screenshots/components, check browser availability, and respect its evidence limits. Do not copy a personal `user-context.md` into Git or assume another developer inherited plugin access. Image generation is optional; source-based brief/review needs neither it nor Product Design.

## Updates and recovery

Update the vendored tool only in a reviewed change: select a release, verify its signed artifact, import in a disposable project with explicit provider/project scope and `--no-hooks`, compare the full file tree, preserve notices, record source commits/hashes, and check launcher/engine compatibility. Do not hand-edit the upstream skill to encode Echo rules; those belong in repo context and the team skills.

Repeat root/subdirectory context checks, a known-problem detector fixture, skill discovery, and onboarding with/without a personal plugin. Install/trust hooks separately when requested. Roll back tool files/config to a known reviewed commit and restore its matching local engine; review hook definitions again. Keep product/design decisions unless the rollback intentionally changes them.

Before calling rollout complete, run the [pilot measurements](design-workflow.md#pilot-measurements), include a second real developer, and verify every required client/OS configuration. Browserless agent dry runs establish skill behavior only; they do not replace teammate acceptance or user research.
