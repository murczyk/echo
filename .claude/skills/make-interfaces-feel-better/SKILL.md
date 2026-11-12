---
name: make-interfaces-feel-better
description: "Use when explicitly requested or assigned by the managed Echo dev role for approved interface details using existing components and tokens. It does not authorize a redesign or activate the Echo workflow."
disable-model-invocation: true
---

# make-interfaces-feel-better: Claude Code entrypoint

Read the [shared skill](../../../.github/skills/make-interfaces-feel-better/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
