# Tapiz MCP Server

Tapiz exposes an MCP server from the API app so an MCP client can inspect and edit boards in the same realtime path as a connected user.

The endpoint is:

```text
POST /api/mcp
```

There is also a basic health endpoint:

```text
GET /api/mcp/health
```

## Architecture

The MCP server lives in `apps/api/src/app/mcp.ts` and is registered from `apps/api/src/app/init-server.ts`.

It uses the official TypeScript MCP SDK with the Streamable HTTP transport. Each MCP request creates a stateless MCP transport, authenticates the caller with a Tapiz API token, and registers tools for that authenticated user.

Board write tools do not mutate board state directly. They create a server-side virtual `Client`, join the requested board, and call `Client.applyStateActions()` with normal Tapiz `StateActions`. That keeps MCP edits on the same path as websocket users:

1. Board access is checked with the authenticated user.
2. The board is loaded into the shared `Server` state if needed.
3. Existing node validators accept or reject the action. MCP batches are
   validated in order against a working copy of the board (see
   [Write results](#write-results)); websocket batches keep their own path.
4. Valid actions update the in-memory board state.
5. Changes are broadcast to connected websocket clients.
6. The board is persisted by the existing server persistence flow.

Read-only board tools avoid joining as a client when possible. `get_board` checks board access and reads the loaded board state, falling back to the persisted board JSON.

## Authentication

MCP uses the same personal API token generated in the web settings page.

In Tapiz:

1. Open `Settings`.
2. Generate an API token.
3. Copy the token immediately. It is hidden after reload.

MCP clients must send it as a bearer token:

```text
Authorization: Bearer tapiz_pat_...
```

The API stores only the token hash. The MCP endpoint hashes incoming tokens and resolves the Tapiz user from `accounts.api_token_hash`.

Only registered accounts can hold API tokens. Guests who joined a board through a shared link can't generate one, and a token never resolves to a guest, so guests can't use MCP; they need to sign up first. Resetting or changing the password revokes the account's token.

For local browser screenshots, the same token can be exchanged for a normal
browser session through the development-only agent login endpoint. See
[AI screenshot sessions](dev-guide.md#ai-screenshot-sessions). The token owner
must already have access to the requested board.

## Tools

### Board Tools

`get_board`

Reads current board nodes for a board the token can access. While the board
hides notes (`notesHidden` in its settings), other users' notes come back as
blank cards.

The result also has `viewer: { userId, isAdmin, readOnly, notesHidden }`:

- `isAdmin`: the token user is a board or team admin, so it may use layer `1`.
- `readOnly`: the board's read-only setting; it blocks changes from users who
  are not admins.
- `notesHidden`: other users' notes are masked.

`contentBounds: { x, y, width, height } | null` is the box around every
positioned node on the board (`null` when there is none). Place new content
outside it.

`format` is `full` (default) or `compact`. Compact returns one entry per node,
with children right after their parent:
`{ id, type, layer?, x?, y?, width?, height?, parent?, text? }`. `text` is the
rich text with tags removed, cut to 120 characters. Use it to place new content,
and `full` before patching existing content.

`add_node`

Adds one node. The node must match the Tapiz schema for its type.

`patch_node`

Patches one existing node. Only include changed content fields.

`remove_node`

Removes one existing node.

`apply_board_actions`

Applies multiple Tapiz `StateActions` in order. Use this for larger operations such as grouping notes, moving many nodes, or creating a full retrospective layout.

Pass `includeBoard: false` to leave the board out of the result (default
`true`).

`create_layout`

Creates a columns, grid or quadrants layout of panels with note slots in one
call. See [Layouts](#layouts).

`lint_board`

Read-only. Checks the board, or only the nodes in `nodeIds`, for layout
problems. See [Lint](#lint).

`get_user_settings`

Reads the authenticated user settings, including default note styling.

### Write Results

All write tools (`add_node`, `patch_node`, `remove_node`,
`apply_board_actions`, `add_cocomaterial_asset`) return:

```ts
{
  status: 'applied' | 'partial' | 'rejected';
  appliedActions: StateActions[];
  rejected: {
    index: number; // position in the submitted batch
    op?: string;
    id?: string;
    type?: string;
    code: string;
    message: string;
    hint?: string;
    issues?: { path: (string | number)[]; message: string; code: string }[];
    dependsOn?: number; // index of the rejected action this one relied on
  }[];
  board?: TuNode[]; // omitted when includeBoard is false
}
```

Same-batch semantics:

- Actions are validated in order, each against the board as the earlier
  actions left it. A batch can add a note, patch it, remove it, or comment on
  it.
- A batch is all-or-nothing. If any action is rejected, nothing is applied,
  and every action that passed is reported as `batch_aborted`.
- An action on a node whose add was rejected is reported as
  `depends_on_rejected`, with `dependsOn` set to that add's index.
- `status` is `applied` when nothing was rejected, and `rejected` otherwise.
  A read-only board rejects every action except `user` actions with code
  `read_only`, so it also returns `rejected`. `partial` (some board changes
  applied, others dropped) is reserved; MCP batches do not produce it.

Rejection codes:

| Code                  | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `invalid_shape`       | The action is not a `StateAction` (`op`, `data.type`, …).                      |
| `layer_admin_only`    | The user is not a board admin and the action adds or targets a layer-1 node.   |
| `node_not_found`      | A patch or remove names an id that does not exist.                             |
| `type_mismatch`       | The id exists, but with another type than `data.type`.                         |
| `schema`              | The content fails the type's schema; `issues` lists the fields.                |
| `notes_hidden_owner`  | Notes are hidden and a new note is not owned by the token user.                |
| `masked_note`         | The change touches another user's hidden note beyond moving or resizing it.    |
| `parent_invalid`      | `parent` names no existing node, or a comment's `parent` is not a note.        |
| `forbidden`           | Another rule refused the change, e.g. editing someone else's comment.          |
| `unsupported_type`    | No validator handles this type and op.                                         |
| `duplicate_id`        | An add reuses an id that already exists, on the board or earlier in the batch. |
| `depends_on_rejected` | The action targets a node whose add was rejected.                              |
| `read_only`           | The board is read-only and the user is not an admin.                           |
| `board_unavailable`   | The board could not be loaded.                                                 |
| `batch_aborted`       | The action was valid but another action of the batch was rejected.             |

Each rejection carries a `hint` on how to fix it.

### Cocomaterial Tools

`list_cocomaterial_tags`

Lists available Cocomaterial tag slugs.

`search_cocomaterial_vectors`

Searches Cocomaterial assets by tag. Results include compact metadata and usable asset URLs.

`add_cocomaterial_asset`

Adds a selected Cocomaterial asset to a board. SVG URLs become `vector` nodes. GIF and other URLs become `image` nodes. The tool uses centered placement and converts it to Tapiz's top-left node position. Assets go on layer `1` by default, which only board admins can write; pass `layer: 0` otherwise.

### Template Tools

See [Templates](#templates) for scopes, access and results.

`list_templates`

Read-only. Lists the personal and team templates the token user can read.

`get_template`

Read-only. Reads one template; `includeData: true` adds its nodes.

`save_board_as_template`

Saves nodes of a board (or the whole board) as a personal or team template.

`insert_template`

Inserts a copy of a template into a board, with fresh ids.

`delete_template`

Deletes a template. Boards it was inserted into keep their copies.

## Layouts

`create_layout` turns a short spec into panels, header text and notes, sized
around Tapiz's real `300x300` note, and inserts them in one batch. Use it
for retrospectives, kanban lanes, brainstorm grids and 2x2 matrices instead of
hand-building panels with `apply_board_actions`.

The code lives in `libs/board-commons/src/lib/layout/` (spec, expansion,
presets, lint) and `apps/api/src/app/layout-service.ts` (insertion).

### Input

```ts
{
  boardId: string;
  layout: {
    kind: 'columns' | 'grid' | 'quadrants';
    title?: string; // display preset text above the cells
    description?: string; // caption preset text under the title
    cells: {
      title: string; // title preset in the panel header
      subtitle?: string; // caption preset under the title
      backgroundColor?: string; // #rrggbb panel background
      notes?: string[]; // seed notes, in reading order
      capacity?: number; // note slots to reserve (default 6)
    }[];
    gridColumns?: number; // grid: cells per row (default about square)
    noteColumns?: number; // note columns per cell, 1-4 (default 2)
    axes?: { x?: [string, string]; y?: [string, string] }; // quadrants only
    noteColor?: string; // default: the user's note colour setting
  };
  origin?: { x: number; y: number }; // top-left of the layout
  placement?: 'right' | 'below'; // without origin (default right)
  layer?: 'auto' | 'asStored'; // default auto
  dryRun?: boolean; // default false
}
```

- `columns` takes at most 12 cells, side by side.
- `grid` wraps the cells into rows of `gridColumns`.
- `quadrants` takes exactly 4 cells: top-left, top-right, bottom-left,
  bottom-right. Axis captions are in reading order: `axes.y` is
  `[top, bottom]`, left of the rows (for example
  `["High impact", "Low impact"]`), and `axes.x` is `[left, right]`, under
  the grid.
- A layout expands to at most 300 nodes; split bigger ones into several calls.

Example, a 3-column retro:

```json
{
  "boardId": "…",
  "layout": {
    "kind": "columns",
    "title": "Sprint 42 retro",
    "cells": [
      { "title": "Went well", "notes": ["Pairing on the API", "Fast reviews"] },
      { "title": "To improve", "notes": ["Flaky e2e tests"] },
      { "title": "Actions", "subtitle": "Owner and date", "notes": [] }
    ]
  }
}
```

### Sizing

The geometry is deterministic:

- Notes are `300x300`, `40px` apart, inside `40px` panel padding.
- A cell is `80 + n·300 + (n−1)·40` wide for `n = noteColumns`.
- The header band fits the estimated height of the title and subtitle (at
  least `120px`), and notes start below it.
- Rows: `max(ceil(capacity / n), ceil(notes / n) + 1)`, so there is always at
  least one empty row. Every cell gets the largest cell's size.
- Cells are `60px` apart, and the title block sits `60px` above them.
- Panels never get `color`, which would recolour the notes inside; use
  `backgroundColor` for a tinted lane.

Without `origin`, the layout goes `400px` right of (or below) the
`contentBounds` of the existing board, as the user sees it; an empty board
puts it at `(0, 0)`.

### Text presets

Header text uses these presets, and hand-built text should too. Every size is
in the editor's font-size list:

| Preset       | Size           | Line height | Style          |
| ------------ | -------------- | ----------- | -------------- |
| `display`    | 96px           | 1.1         | bold           |
| `title`      | 64px           | 1.15        | bold           |
| `heading`    | 40px           | 1.2         | bold           |
| `subheading` | 28px           | 1.25        | bold           |
| `body`       | 24px (default) | 1.3         |                |
| `label`      | 20px           | 1.3         | bold           |
| `caption`    | 28px           | 1.3         | grey `#868e96` |

The markup is the sanitizer's normal form, so it is stored unchanged:

```html
<p>
  <span style="font-size: 40px; line-height: 1.2"><strong>Went well</strong></span>
</p>
```

Bold goes through `<strong>` (`font-weight` is not an allowed style), and
`body` text leaves out `font-size`. Never use `h1`–`h3`.

### Layer policies

- `auto` (default): board admins get panels and text on layer `1` and notes
  on layer `0`. Anyone else gets every node on layer `0`,
  and the result says `layerCoerced: true`.
- `asStored`: panels and text stay on layer `1`. For a user who is not a
  board admin, the call is rejected with `layer_admin_only` and nothing is
  written.

Panels are inserted after the last existing panel, so they render behind
existing notes, in the layout's own order. A websocket edit landing at the
same moment can shift a panel by one array slot.

### Result

```ts
{
  status: 'applied' | 'dry_run' | 'rejected';
  origin: { x: number; y: number };
  bounds: { x: number; y: number; width: number; height: number };
  nodeCount: number;
  layerCoerced: boolean;
  refs: Record<string, string>; // ref -> node id (provisional in a dry run, empty when rejected)
  lint: LintIssue[]; // advisory, see Lint
  rejected: Rejection[]; // as in Write Results; index -1 for the whole call
  nodes?: { ref; id; type; layer; x; y; width?; height? }[]; // dry run only
  cells: {
    ref: string; // cell-0, cell-1, …
    title: string;
    panelId?: string;
    bounds: { x: number; y: number; width: number; height: number };
    noteIds: string[];
    freeSlots: { x: number; y: number }[]; // top-left of each empty 300x300 slot
  }[];
}
```

All coordinates are board coordinates. To add notes to a cell later, add
`300x300` notes on layer `0` at its `freeSlots` with `apply_board_actions`.

- `dryRun: true` checks access without joining the board, so it writes
  nothing, not even a board membership.
- A read-only board rejects users who are not admins with `read_only`, in a
  dry run too.
- While notes are hidden, the inserted notes are owned by the token user, so
  they are accepted.

### Lint

`create_layout` returns `lint` for the inserted nodes, and `lint_board`
checks any board:

```ts
lint_board({ boardId, nodeIds? }) => {
  issues: {
    level: 'error' | 'warning';
    code: string;
    nodeIds: string[];
    message: string;
    hint?: string;
  }[];
  counts: { error: number; warning: number };
  contentBounds: Rect | null;
  missingNodeIds?: string[]; // nodeIds that are not on the board
}
```

`nodeIds` takes 1-500 ids; omit it to lint the whole board. An empty list is
rejected, because it would check nothing and read as a clean board.

Lint runs on the board as the user sees it (hidden notes are blank) and never
blocks a write. Text heights are estimates, so confirm in the browser.

| Code                         | Level   | Meaning                                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------------------- |
| `layer_admin_only`           | error   | A layer-1 node from a user who is not a board admin (not reported today).    |
| `nonpositive_size`           | error   | A width or height of 0 or less.                                              |
| `text_overflow`              | warning | Text or panel header text needs more height than the node has.               |
| `raw_heading`                | warning | Rich text uses `h1`–`h3`, which render at 320/160/80px.                      |
| `note_text_too_long`         | warning | The note shrinks its text below 18px to fit.                                 |
| `note_overlap`               | warning | Two notes overlap.                                                           |
| `note_in_header`             | warning | A note covers a panel's header text.                                         |
| `panel_color_recolors_notes` | warning | A panel with `color` contains notes, whose own colour it overrides.          |
| `overlaps_existing`          | warning | Inserted nodes overlap content that was already on the board (inserts only). |
| `dangling_attachment`        | warning | An arrow is attached to a node that does not exist.                          |

## Templates

A template is a saved set of board nodes that can be inserted into any board
the user can edit. The web app and MCP share the code in
`apps/api/src/app/template-service.ts`; the data format and copy rules live in
`libs/board-commons/src/lib/layout/`.

### Scopes and access

- `personal`: only the owner can read, insert or delete it.
- `team`: every team member can read and insert it; team admins and the member
  who saved it can delete it. A member who leaves the team loses access.
- A template the user cannot read is reported as `Template not found`, so its
  existence is not revealed. A `templateId` that is not a UUID fails input
  validation instead.
- Quotas: 200 personal templates per account, 500 per team. A template holds
  at most 500 nodes and 512 KB.

### Saving

```ts
save_board_as_template({
  boardId: string;
  name: string; // 1-256 characters, trimmed
  description?: string; // up to 2000 characters
  nodeIds?: string[]; // up to 500; default: the whole board
  includeContained?: boolean; // default true
  scope?: 'personal' | 'team'; // default personal
  teamId?: string; // team scope; default: the board's team
}) => {
  template: TemplateSummary;
  dropped: { id: string; type: string; reason: string }[];
  detachedArrows: string[];
  lint: LintIssue[];
}
```

- Pass the `refs` values that `create_layout` returned, or node ids from
  `get_board`. An id that is not on the board fails the call.
- With `includeContained`, nodes lying inside a selected panel or group are
  saved too.
- Team scope needs team membership, even for a board admin; `teamId` with
  `scope: 'personal'` is an error.
- Only `panel`, `text`, `note`, `group`, `arrow`, `vector` and `image` nodes
  are saved. Everything else is listed in `dropped`:
  - `type_not_allowed`: user, settings, timer, poll, estimation and other
    runtime nodes;
  - `masked_note`: another user's note the token user cannot read: notes
    are hidden on the board, or the note's text is private (its
    `textHidden`, or else its owner's hidden-text setting);
  - `board_scoped_asset`: images and vectors with `data:` or uploaded-file
    URLs.
- An arrow attached to a node outside the selection keeps where it renders
  but loses that attachment, and is listed in `detachedArrows`.
- Votes, emojis, note owners and comments are not saved, and rich text is
  sanitized. Template refs are usually the source node ids.

`TemplateSummary` is
`{ id, name, description, scope, nodeCount, width, height, createdBy, createdAt, updatedAt, canEdit }`,
with `scope` either `{ kind: 'personal' }` or
`{ kind: 'team', teamId, teamName }`. `canEdit` means the user may delete it.
`list_templates` returns `{ templates: TemplateSummary[] }`, newest first, and
`get_template` returns `{ template }`, with `data: { version, size, nodes }`
when `includeData` is true.

### Inserting

```ts
insert_template({
  boardId: string;
  templateId: string;
  origin?: { x: number; y: number };
  placement?: 'right' | 'below';
  layer?: 'auto' | 'asStored';
  dryRun?: boolean;
})
```

`origin`, `placement`, `layer` and `dryRun` work as in
[`create_layout`](#layer-policies), and the result is the `create_layout`
result without `cells`. `refs` maps each template ref to the new node id.
Every insert gets fresh ids, so inserting twice gives two independent copies.
Arrows attached inside the template point at the new nodes, and notes are owned
by the token user with no votes or emojis.

### Errors

Template errors come back as tool errors with a readable message, for example
`Template not found`, `Board not found`, `Only members of the team can save
team templates` or `This account already has 200 templates, the limit is
200`. A save whose nodes do not make a valid template lists the failing paths
in the message. Inserting into a board the user cannot access fails with
`Unable to join board with this API token` (`Unable to read board…` in a dry
run) and changes nothing.

## Local Setup

Install dependencies:

```shell
pnpm install
```

Start the API:

```shell
pnpm start:api
```

Start the web app if you need to generate a token from the settings UI:

```shell
pnpm start
```

By default, the web app runs at:

```text
http://localhost:4300
```

The API MCP endpoint uses the configured API port:

```text
http://localhost:<API_PORT>/api/mcp
```

## Connecting an MCP Client

Use Streamable HTTP transport and pass the Tapiz API token as a bearer token.

For Claude Code, a local example is:

```shell
claude mcp add --transport http tapiz http://localhost:<API_PORT>/api/mcp \
  --header "Authorization: Bearer tapiz_pat_..."
```

For hosted MCP clients, expose the API over HTTPS and configure the same endpoint and bearer token.

## Example Workflows

Create a fun retrospective:

1. Call `get_board` to see `viewer` and `contentBounds`.
2. Call `create_layout` with the columns and seed notes (try `dryRun: true`
   first to check `lint`).
3. Call `list_cocomaterial_tags` and `search_cocomaterial_vectors` for
   relevant assets.
4. Call `add_cocomaterial_asset` for decorations, outside the cells.
5. Call `apply_board_actions` to add more notes at the cells' `freeSlots`.
6. Open the board in a browser and verify the actual rendered result. Rich text
   can render much larger than its node box if you use raw heading tags.

Reuse a layout on other boards:

1. Call `create_layout` on a scratch board, and adjust it until it looks right.
2. Call `save_board_as_template` with the layout's `refs` values as `nodeIds`
   (or no `nodeIds` for the whole board), and `scope: 'team'` to share it.
3. Later, call `list_templates` to find it.
4. Call `insert_template` with the target `boardId`; try `dryRun: true` first
   to see where it lands.

Group all notes in a board:

1. Call `get_board`.
2. Infer categories from existing note text.
3. Call `apply_board_actions` with group additions and note patches that move notes into the relevant group positions.

## MCP Board-Building Guidance

Use the same mental model as the web app: nodes are persisted user-facing
objects on an infinite canvas, and MCP writes go through normal realtime
validation.

- Always call `get_board` before editing an existing board. Preserve existing
  user, settings, timer, poll, estimation, and content nodes unless the user
  asked to replace them.
- For lanes, grids and quadrants, use `create_layout`; it handles sizing,
  header bands, layers and placement. Check hand-built layouts with
  `lint_board`.
- To reuse a layout, save it with `save_board_as_template` and place copies
  with `insert_template` instead of rebuilding it.
- Use `apply_board_actions` for multi-node changes. A full layout should arrive
  as one batch so ordering, layers, parent/child relationships, and validation
  are handled together.
- Use board coordinates for `content.position`; do not use browser screen
  coordinates. Keep related nodes near the current viewport unless the user asks
  for a large template.
- Do not use `content.layer` as z-index. Tapiz uses layer `0` for participant
  board content such as notes/text and layer `1` for edit/template content such
  as panels. Do not invent arbitrary layers such as `2`: validation accepts only
  layers `0` and `1`, and board-mode interactions such as area selection are
  designed around those roles.
- Layer `1` is the board edit mode: only board admins, team admins included,
  can add, change, or remove layer `1` nodes. For any other user these actions
  are rejected along with the rest of their batch, so use layer `0` when the
  API token's user is not a board admin. `get_board` reports this as
  `viewer.isAdmin`.
- While the board settings have `notesHidden: true`, other users' notes are
  returned as blank cards (empty text, drawing and emojis, no comments), admins
  included. New notes must be owned by the API token's user, and other users'
  notes can only be moved or resized until a board admin reveals them; any
  other change is rejected along with the rest of its batch.
- Visual depth/z-index comes from node order in the board array. Later sibling
  nodes render above earlier sibling nodes. To put an element in front of or
  behind another element, move it in the array with `apply_board_actions`
  `position`/ordering rather than changing `content.layer`. For example, put
  lane panels earlier than the notes that should appear on top of them.
- Prefer explicit `width` and `height`. Resize text boxes and notes based on the
  rendered content you expect, not just the number of characters.
- For retrospective/post-it layouts, design around Tapiz's real default note
  size: `300x300`. Make lanes wide and tall enough for multiple `300x300` notes,
  leave room for at least a few additional notes per lane, reserve a header band
  inside each panel, and keep notes below panel labels/instructions.
- Do not set `panel.content.color` on lanes that contain notes unless you
  intentionally want every note inside that panel to use the panel color. Tapiz
  notes inside a panel use the panel `color` instead of their own note `color`.
- Note text renders black and notes may expose footer/author UI, so use light
  high-contrast note colors and make notes tall enough that the content does not
  collide with footer text.
- Verify in the web app with Playwright after MCP writes. Check at least the
  visible text, bounding boxes, and a screenshot. If the browser redirects to
  login locally, create a real local session for verification instead of relying
  only on `get_board`.
- Rich text supports HTML, but raw `h1`, `h2`, and `h3` tags are styled for
  canvas templates and can become huge. For compact MCP-created labels, use
  paragraph/span markup with explicit `font-size` and `line-height` (see
  [Text presets](#text-presets)), then verify that the text fits in its node.

## Node Type Tradeoffs

Use the narrowest node type that matches the user workflow:

| Node type             | Best use                                                                     | Advantages                                                                                                                                                         | Disadvantages and cautions                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note`                | Retrospective ideas, brainstorm items, voting targets, discussion cards.     | Designed for editable sticky-note content; supports votes, emojis, comments, drawing, note visibility, author display, and user defaults from `get_user_settings`. | Requires full content on add: `text`, `votes`, `emojis`, `drawing`, `ownerId`, `width`, `height`, `color`, `position`, and layer `0` for participant notes. User-created notes default to about `300x300`; use that when reserving lane space. Text renders black, so use light high-contrast colors. Make notes tall enough for content plus footer/author UI. Avoid using notes as large static headers. |
| `panel`               | Background areas, columns, frames, template sections, visual grouping zones. | Resizable, rotatable, can have background, border, radius, text, and drawing. Good for labeled lanes behind notes.                                                 | Use layer `1` for template/edit panels. Panel rich text uses canvas-scale heading styles. Use explicit inline font sizes for compact labels. Reserve a header band and leave empty lane space for future notes. Avoid `content.color` for lanes with notes because it overrides note colors inside the panel.                                                                                              |
| `group`               | Movable clusters of related nodes or voted note groups.                      | Supports a title and votes, and works with board grouping interactions.                                                                                            | It is a semantic cluster, not a decorative column. Use panels for static lanes; use groups when users should move or vote on the cluster.                                                                                                                                                                                                                                                                  |
| `text`                | Standalone titles, instructions, legends, and labels.                        | Lightweight rich-text node without a frame. Good for instructions above a layout.                                                                                  | Raw heading tags can render very large. Give text nodes explicit dimensions and use inline font sizes for predictable MCP output.                                                                                                                                                                                                                                                                          |
| `arrow`               | Connectors between flow steps, dependencies, or annotations.                 | Supports straight/curved/elbow lines, stroke styles, widths, arrowheads, and node attachments.                                                                     | Endpoints are local to the arrow box, while attachments store node-local offsets. Use the geometry guidance before creating attached arrows.                                                                                                                                                                                                                                                               |
| `vector`              | Cocomaterial SVG decorations or icons.                                       | Scales cleanly and stores only a URL plus dimensions. `add_cocomaterial_asset` handles centered placement.                                                         | External URL availability affects rendering. Avoid decorative vectors when they distract from editable board content.                                                                                                                                                                                                                                                                                      |
| `image`               | Uploaded or external bitmap references.                                      | Good for screenshots, diagrams, and non-SVG assets.                                                                                                                | External URLs can fail or load slowly. Prefer vectors for simple illustrations and avoid images for text-heavy content.                                                                                                                                                                                                                                                                                    |
| `token`               | Small personal markers, status chips, or labels created from the toolbar.    | Compact, colorable, and useful as movable markers.                                                                                                                 | Not a replacement for notes; no rich content, votes, or comments.                                                                                                                                                                                                                                                                                                                                          |
| `poll`                | Structured voting with fixed options.                                        | Enforces one vote per user and supports anonymous/public modes.                                                                                                    | Poll title/options/mode are intentionally hard to change after creation. Use only when the board needs a real poll, not casual note voting.                                                                                                                                                                                                                                                                |
| `estimation`          | Planning poker style estimation boards.                                      | Specialized workflow for stories, scales, and result collection.                                                                                                   | Requires related config/result nodes and app workflow knowledge. Do not create for ordinary retrospectives.                                                                                                                                                                                                                                                                                                |
| `timer`               | A single shared board timer.                                                 | Useful for facilitated activities such as silent writing.                                                                                                          | Only one timer node with id `timer` is allowed. Avoid adding one unless the user requested timed facilitation.                                                                                                                                                                                                                                                                                             |
| `comment`             | Threaded discussion attached to a note.                                      | Keeps discussion with the note.                                                                                                                                    | Must be a child of a `note`; do not add as a top-level node.                                                                                                                                                                                                                                                                                                                                               |
| `settings` and `user` | Board/user runtime state.                                                    | Needed by the app for visibility, cursor, and settings behavior.                                                                                                   | Do not create or remove these for layout work. Preserve them when editing boards.                                                                                                                                                                                                                                                                                                                          |

For node schema details, read the validators in
`libs/board-commons/src/lib/validators` and the API validation registry in
`apps/api/src/app/validation.ts`.

## Validation

Run focused API checks after changing MCP code:

```shell
pnpm exec nx typecheck api
pnpm exec nx test api -- --run src/app/mcp.spec.ts src/app/layout-service.spec.ts
pnpm exec nx lint api
```
