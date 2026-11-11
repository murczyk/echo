---
name: systematic-debugging
description: "Use when explicitly requested or assigned by the managed Echo dev or QA role to investigate a bug, test failure or unexpected behavior within its authorized scope."
disable-model-invocation: true
---

# systematic-debugging: Claude Code entrypoint

Read the [shared skill](../../../.github/skills/systematic-debugging/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
