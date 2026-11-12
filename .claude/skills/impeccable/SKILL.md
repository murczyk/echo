---
name: impeccable
description: "Use only when explicitly requested or assigned by the managed Echo designer for UX shaping, critique or technical UI review. Repository Markdown guidance; ordinary UI requests do not activate it."
disable-model-invocation: true
---

# impeccable: Claude Code entrypoint

Read the [shared skill](../../../.agents/skills/impeccable/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
