---
name: echo-spec
description: "Use only when the user explicitly invokes echo-spec for Echo requirements, business rules, scenarios or acceptance criteria. Ordinary questions and skill/configuration maintenance do not activate it."
disable-model-invocation: true
---

# echo-spec: Claude Code entrypoint

Read the [shared skill](../../../.github/skills/echo-spec/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
