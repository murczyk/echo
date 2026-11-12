---
name: echo-qa
description: "Use only when the user explicitly invokes echo-qa to prepare tests or verify an Echo implementation with the managed qa role. Ordinary review requests, quoted names and recommendations do not activate it."
disable-model-invocation: true
---

# echo-qa: Claude Code entrypoint

Read the [shared skill](../../../.github/skills/echo-qa/SKILL.md) from the Git root and follow
its instructions within the user’s actual task and authorized stage. This is
a thin entrypoint, not a separate copy of the workflow.

For Echo role dispatch, use the Claude Code branch of
[native dispatch](../../../docs/frontend/echo-workflows.md#native-dispatch);
stay in the main chat until its invocation/prerequisite checks are satisfied.
Reading or maintaining this wrapper alone does not authorize role dispatch.
An explicitly invoked read-only smoke follows the shared validation contract.

Task arguments: $ARGUMENTS
