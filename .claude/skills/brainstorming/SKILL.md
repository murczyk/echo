---
name: brainstorming
description: "Use when explicitly requested or assigned by the managed Echo spec or designer role to clarify requirements or explore UX choices within its stage. Ordinary requests do not activate Echo roles."
disable-model-invocation: true
---

# brainstorming: Claude Code entrypoint

Read the [shared skill](../../../.github/skills/brainstorming/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
