---
name: playwright-best-practices
description: "Use when explicitly requested or assigned by the managed Echo QA role for scoped Playwright test preparation, verification or debugging. It does not activate the Echo workflow or authorize setup changes."
disable-model-invocation: true
---

# playwright-best-practices: Claude Code entrypoint

Read the [shared skill](../../../.github/skills/playwright-best-practices/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
