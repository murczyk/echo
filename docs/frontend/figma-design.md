# Echo wireframes and design in Figma

Use this guide when an explicitly invoked `echo-designer` task requests editable
Figma output, including the preset shorthand below. It extends the [designer stage](echo-workflows.md#designer);
it does not invoke that stage, approve implementation or require Figma for other
tasks. Configuration maintenance creates no sample design or remote file.
Reload/start a session after profile changes, then verify the effective designer
catalog; source validation alone does not establish named-role Figma authoring.

Designer consumes an owner-approved specification or compact approved manual
brief with acceptance criteria. `echo-spec` can prepare it when explicitly
invoked; it is not a mandatory prior run. Designer writes UX/design notes and
maps frames to acceptance IDs, without authoring or changing requirements.

## Deliverables

For Figma tasks, return the editable file/node links and concise design notes
in chat. Generated task specs, design notes and audit reports stay out of the
repository; if a document file is needed, agree on a location outside it.
This shared Figma guide and skill configuration remain repository-owned guidance.
Screenshots support visual inspection only: view them inline, or use temporary
storage outside the repository when the tool requires a local file. Do not save
PNGs or companion mockup images into `docs/` or elsewhere in the repository, or embed/link them in
documents, unless the user explicitly requests an export. An explicitly requested
static SVG/Mermaid deliverable is a separate format, not a companion Figma export.

Stop when the design result is returned. A designer-only request does not create
an implementation plan, even through main or a helper's planning workflow.
Technical implementation planning belongs to separately requested planning/dev work.

## Output presets

This section owns the reusable presentation defaults. Entrypoints and role
profiles reference it; shared product values remain in the canonical token
manifest. An actual task invocation can select a preset without restating styles:

| Preset in an explicit `echo-designer` request | Default output | Presentation |
| --- | --- | --- |
| `wireframe` or `wireframes` | Editable structural frames in Figma | Low fidelity, one neutral light presentation; Echo layout geometry, control sizes and typography; meaningful Ukrainian labels and placeholders for media/maps |
| `design` (or `дизайн`) | Editable visual-design frames in Figma | Existing Echo component appearance and semantic tokens; Light and Dark versions of the main state; real component variants/icons and synthetic content |

For `wireframes`, use canvas `#ffffff`, surfaces `#f5f5f5`, outlines `#bdbdbd`
and text `#212121`; omit shadows, gradients, decorative imagery and brand/status
colors. Show status meanings with labels/icons. These neutral values describe
wireframe presentation only, not new product tokens or an Echo theme. Reuse
Echo spacing, sizes, radii and font-size roles; do not invent a parallel scale.

Make selected/pressed buttons, active tabs and selected navigation items clearly
distinct from inactive ones. Use a medium-light gray fill (`#d0d0d0`) with dark
text (`#212121`), plus a visible selection indicator or stronger outline;
a subtle `#f5f5f5` background change alone is insufficient. Do not use black
active fills. Verify that labels and icons remain visible in every affected
instance, including those with existing fill bindings. Keep disabled states
distinct from both active and inactive controls. Apply this consistently across
the wireframe set without introducing brand colors.

Use familiar standard icons for obvious actions such as download, edit, clear,
close and panel toggles, rather than permanent text buttons. Reuse existing
project icons and icon-button geometry; provide a tooltip and an accessible
action name, including the target or format when needed (for example, ZIP).
Keep text when an action's meaning or scope is not clear from a standard icon.
Navigation labels, content-type tabs and informative counts remain text.

Follow the [flat side-navigation layout](../../DESIGN.md#layout): use the workspace
background, or an explicitly approved shared header surface, with dividers instead
of card wrappers or individual panel surfaces.
Present navigation destinations as list items, not a stack of individually outlined buttons.
Mutually exclusive peer choices, such as “Ехо групи / Telegram”, form one joined
button group with a shared outline and visible selected state, without gaps or
independent outer rounding between segments.

Separate navigation-list items with visible neutral dividers. Keep each item
name on one line and truncate overflow with an ellipsis (`…`); secondary metadata
may occupy a separate line. Highlight navigation controls according to the
current screen, including controls that return to an entity's overview.
Accordion headers must show a chevron indicating expanded or collapsed state.
Apply these conventions to every affected frame, including shared instances.

Keep unread state distinct from the selected navigation item. Pair emphasis with
a numeric badge rather than color alone; hide the badge when the count is zero.
Explain the count's scope and show the corresponding read/unread transitions.
Show the unread boundary as a centered label between two horizontal rules.
In visual designs, use the primary color for the label and rules; keep wireframes
neutral according to their preset.

For opening and closing left and right side panels, reuse the existing
`SidePanelToggleButton` appearance and its side-specific active/inactive icons in
the page header. Do not introduce parallel text actions such as “Згорнути меню”,
“Відкрити меню” or “Відомості” for the same panels. Keep explanatory labels in
tooltips rather than permanently beside the icons. Distinguish panel
visibility from navigation to a full page; a page is left through navigation,
not through a panel-close control.

Let table rows grow when cell text wraps, preserving vertical padding so text
does not touch or cross row dividers. Keep neighboring cells aligned consistently.

Explain each search field's scope and matching behavior, with filtered and
no-results states and a clear/reset path. Put the clear action inside the input
or immediately beside it, never below the results or empty-state message. Keep
it available while the input is nonempty, including when there are no results.
Distinguish filtering a navigation list from searching its content.
Place edit actions beside the editable value; replace only that value with the
input, preserving surrounding read-only data.

In file galleries and media previews, clicking a card opens the file; do not add
a separate “Open” button. In galleries, put a visible checkbox at the top of each
card for single or multiple file selection. Place the individual download action
in the same top row beside selection. Show only the filename beneath the preview,
without a second checkbox or repeated opening/download actions. Checking or
unchecking the top checkbox changes selection without opening the file; download
also remains independent of opening and selection. Do not add “Обрати” or
“Вибрано” beside individual card checkboxes; the checkbox and card outline show
selection. Preserve an accessible filename-specific checkbox label and keep the
aggregate selected-file count separate.
Show the selected count and the corresponding bulk-action state consistently
across gallery screens; this does not introduce selection in contact lists.

For `design`, follow the affected surface's effective theme and source components,
including the documented MUI/legacy differences. Reuse existing variants rather
than proposing a new visual language. Preserve the contrast-review limits in
DESIGN.md; using a token does not establish accessibility.

When borrowing UX from familiar products, reproduce the reading and interaction
patterns, not just rounded containers. For messenger views, use recognizable chat
rows, compact timestamps, sender grouping and content-sized bubbles; show previews
and avatars where the data supports them. Keep Echo colors, typography and controls.
Photo and video messages use the media preview itself as the bubble, with compact
time and relevant playback controls; keep captions attached to that media.
Show the affected surface's supported content types using synthetic examples,
rather than representing every attachment as the same generic file card.
Do not add sending, calls, read receipts or other capabilities merely because the
reference messenger has them. Respect the requested theme scope; a dark-only
iteration does not require updating the light version.

In Figma, both presets use native editable auto layout. Use synthetic Ukrainian
content and the relevant loading/empty/error/permission states from the task's contracts.
Place field icons in supported adornment slots or a native auto-layout composition
with the text. Do not overlay an icon on an unadorned input and compensate with
descendant position or padding overrides. Verify nested widths, source properties
and spacing after layout recalculation; an outer-bounds check or screenshot alone
does not establish that an instance will lay out correctly in the editor.
Use brief/reference widths when supplied; otherwise derive relevant wide/narrow
layouts from the affected surface's responsive behavior and record the chosen
sizes. Do not duplicate every state across every theme/width by default. Keep
annotations, UX decisions, acceptance-ID mappings and unresolved questions in design notes.

Select the preset from the requested output, carry its name and task overrides
in the handoff, and apply these defaults without asking the user to repeat them.
A request for both wireframes and design produces both sets of frames. An
existing wireframe board owns wireframe screens and flows; the assigned design
frame owns visual designs, detail states and content-type examples. Keep these
outputs in their respective containers rather than on a mixed standalone board.
An explicit task instruction overrides a presentation default within the authorized
scope; it does not change shared tokens or future defaults. An explicit SVG or
Mermaid format overrides the preset's Figma format. Without a preset or Figma
request, retain the existing static-wireframe workflow.

If only a mode is supplied, reuse the already agreed task and target. If the
screen/flow or target is missing, ask for that context; resolve the Figma page
under the rule below before writes. A mode alone does not choose a destination,
authorize a new file or resolve product decisions. Quoted examples and requests
to configure presets do not invoke a designer stage.

## Request flow

1. Accept the approved specification and an explicit instruction such as
   “Застосуй echo-designer wireframe для створення флоу”. Natural-language
   invocation selects the same preset as `$echo-designer wireframes`; the user
   does not need to repeat style rules or rewrite the specification as a command.
   If only an unapproved feature description is available, request an approved
   specification/brief or suggest an explicit `echo-spec` stage; do not invoke it
   automatically or dispatch designer to write the requirements.
2. Main resolves the Figma file and page before dispatch. If missing, ask where
   to work and wait for the answer, retaining the specification. A supplied
   unambiguous target or the same task's settled choice needs no repeat question.
3. With the approved specification and target resolved, hand off its revision/
   approval, preset and authorized scope to the named designer and start the
   design stage. Requirement gaps return through main to the specification owner;
   revised requirements need approval before dependent design. Do not ask for
   another start confirmation for the already authorized stage.

For a requested UI flow, build a sequence of editable screen/state frames with
labeled connector lines and arrowheads between the actual frames. Label each
connector with its triggering action and any relevant condition/result; include
back, close, cancel and error/retry branches. Route lines around frames and labels
so their source, destination and direction are clear. A separate text legend or
list of transitions does not replace these connections.
Keep the flow on the selected Figma Design page; this does not request a FigJam
diagram or a working interactive prototype.

Keep the wireframe canvas focused on screens and their connections. Do not add
administrative blocks such as “Погоджено власником · r1”, approval histories,
revision summaries or repeated textual flow maps. Keep approval/revision evidence,
source and acceptance-ID mappings in the chat design notes. On the canvas, use
only brief behavioral explanations or unresolved UX questions beside the affected
screen or transition.

## Inputs and destination

Main includes the actual invocation, approved specification/revision and owner
decisions, acceptance/scenario IDs, source revision/dirty state, output location
(chat by default, or an agreed external file) and stop condition in the handoff, plus:

- Output preset and task overrides, with relevant themes/widths/states.
- Target: existing Design-file URL and assigned pages/nodes, or permission to
  create a new Design file with its name and selected team/plan/project.
- Permitted Figma operations and synthetic/redacted content to include.

Check the official Figma MCP tools and account access. For a new file, use the
provided plan selection or `whoami`; if multiple plans remain, ask through main
which to use. Do not infer a destination from a matching product/team name.
Reuse settled choices. Keep account IDs, personal access settings and credentials
out of Git; record task file/node links in design notes for later stages.

Resolve the target Figma page before any Figma mutation. If the user has not
selected one and a supplied frame/node link does not identify it unambiguously,
ask through main which page to use and wait for the answer. For an existing file,
inspect its pages read-only and offer their names/links or a new page; for a new
file, ask for the intended page name before creating the file. Never select the
first/current page or create a page by default. Record the choice in the handoff
and design notes, and reuse it within the same task without asking again.

## Load focused official guidance

Prefer the installed official Figma plugin's matching skills. Otherwise read the
official Figma MCP `skill://index.json`, then the relevant resources below using
`get_figma_skill` when available, or MCP resource reading on server `figma`.
Resolve a skill's relative reference links within its official resource directory;
do not interpret `skill://` as a local path or install missing plugins/helpers.

| Work | Required official guidance |
| --- | --- |
| Create a new Design file | `skill://figma/figma-create-new-file/SKILL.md` before `create_new_file` |
| Run Figma Plugin API scripts | `skill://figma/figma-use/SKILL.md` before `use_figma` |
| Assemble wireframes/screens | `skill://figma/figma-generate-design/SKILL.md` alongside `figma-use` |
| Create missing variables/styles/reusable components | `skill://figma/figma-generate-library/SKILL.md` alongside `figma-use` |

Pass the loaded skill names in `use_figma.skillNames` as official guidance
requires; resource-loaded names use `resource:`. These four skills and their
relevant references are the designer's Figma profile. Other Figma workflows,
including Make/Code Layers, FigJam, publishing and Code Connect writes, need
separate scope and are not part of this integration.

## Ground the design in Echo

Read [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md), the
[layout contract](layout-component-contract.md), affected local `AGENTS.md`,
behavior contracts and actual route/component sources. These cover main
`wdintel-web`, not GOI/docs. Preserve Ukrainian copy, applicable permissions,
loading/empty/error/recovery states, keyboard/focus and navigation/context rules.

Use [tokens.json](../../wdintel-web/src/design-system/tokens.json) as the canonical
shared value source. Figma is a derived representation, not a second token source.
Create only the foundations required by the task and preset: shared geometry
and typography, plus semantic color variables with Light/Dark modes and effects
for visual design. Keep neutral wireframe styling separate. Record each
Figma variable/style's manifest path and source revision; use generated CSS only
to find existing CSS names for code syntax. Convert px values to numeric Figma
values and CSS shadows to effects without inventing a new scale. Resolve CSS font
stacks to an available font supporting Ukrainian and record any substitution.
Preserve existing contrast concerns as findings rather than silently fixing tokens.

Inspect actual [Power components](../../wdintel-web/src/ts/react/components/README.md),
`EchoChip`, affected exports/props and available synthetic stories. Existing MUI
and legacy surfaces may differ from semantic tokens; inspect the effective theme
and report those differences instead of treating the manifest as a global MUI
palette. Map needed Figma components to source exports, variants and relevant
behavior. React/Elm code is not itself a native Figma component or a Code Connect
mapping. Recreate missing representations from source; do not add a full library
or unrelated variants just to design one screen.

## Build and verify

1. Read the approved specification and resolve requirement gaps through main
   before dependent design. Create a
   new `design` file only when authorized and no target exists; retain its returned
   file key. Call `create_session` before file reads/edits and reuse its returned
   `sessionId` on every tool that accepts it.
2. Inspect the target; call `get_libraries`, then `search_design_system` as the
   first design-system lookup. Reuse compatible assets in the selected scope.
   If no libraries are returned, still search the local file. A failed lookup
   does not prove assets are absent. Resolve conflicting code/Figma values before
   mutation. An empty file starts with only the missing Echo foundations and
   component representations needed by this task, using `figma-generate-library`.
3. Use sequential `use_figma` calls to build native editable frames, auto layout,
   text and component instances with variable/style bindings. Separate wireframe
   structure from visual-design frames and name them by preset/scenario/state/theme/width.
   Apply the output preset above. Preserve unrelated pages/nodes and return affected
   node IDs from each mutation. No screenshot-only deliverable.
4. Inspect node structure, text, bindings and instance reuse, then obtain and view
   screenshots transiently for the agreed frames; follow the deliverable limits
   above rather than exporting them to repository documents. Check clipping,
   long Ukrainian content, active/inactive/disabled distinction, readable connector
   labels and unambiguous arrow endpoints, relevant widths/themes and state
   coverage. Record missing fonts, source-only
   assumptions and unverified interactions. Figma visuals do not establish browser
   behavior, server permissions, persistence or human acceptance.
5. Return file/node links and design notes with input specification revision/
   approval, source revision, acceptance-ID mappings, component/token sources,
   visual inspection observations, checks and gaps. Record design approval
   separately; stop before spec/planning/dev/QA or implementation.

Use only synthetic/redacted design content and the authorized destination. A live
app capture or source/asset upload requires its own input/destination scope and an
already available authorized preview; no server, dependency or browser setup is
implied. Do not change sharing, publish libraries, delete unrelated content or
export operational data. If tools, guidance, edit access or rendering are missing,
report the blocked output and continue only independent design/source analysis
within the approved requirements;
offer SVG/Mermaid as an explicit alternative rather than claiming Figma success.
