# PhyloPlate session notes

## Project
A local webapp that turns BEAST X (BEAST 1.x) XML files into plate diagrams
and probabilistic notation. Originally a viewer; expanded earlier sessions to
also generate XML from templates (the *builder*).  The builder was removed;
the webapp is now viewer + editor of an existing model.

Repo: `/mnt/c/Users/john/Documents/PhD/Dev/phyloplate` (also live at
`https://github.com/EDIDPasteur/phyloplate`).

User: John H. Tay (jtay). Branch: `test`.

## How to run
```
cd /mnt/c/Users/john/Documents/PhD/Dev/phyloplate
./serve.sh
```
Opens `http://localhost:8000/?demo=1` by default. Also accepts
`?demo=.xml`.

## Architecture

ES modules, vendored d3.v7. No build step. Open `index.html` (or serve over
http because file:// blocks modules).

```
index.html          shell: header, tabs, sidebar, canvas, footer dialogs
css/style.css       Material teal/orange palette with [data-theme="dark"] override
js/parse-beast.js   XML -> typed DAG, modules, plates, posterior structure
js/layout.js        layered DAG layout (Sugiyama-lite) with plate compaction
js/render.js        D3 drawing, drag/zoom, tooltips, SVG export
js/notation.js      DAG -> posterior factorisation + per-factor statements + LaTeX
js/extras.js        SourceView, audit panel, Search, diffModels, exportBN
js/mcmc-editor.js   PriorDock (right-docked) + McmcEditor (Source-tab sidebar)
js/d3.v7.min.js     vendored
```

`app.js` orchestrates: theme, loading, tabs, sidebar, search, audit,
toolbar, keyboard shortcuts, drawer, paste, drag-drop,
compare (right-click → second XML), and the editor surfaces.

## Changes this session

### Editor refactor

The old full-window "Edit priors & MCMC" pane is gone.  The work is now
split between two surfaces:

- **`PriorDock`** — a right-docked panel (360 px wide) that opens when
  the user clicks a prior's hyperparameter square **or** a parameter
  that has priors, in the diagram.  The dock shows one prior at a
  time: the live density preview is stacked **above** the editable
  attribute form, both inside a single scrolling container so the
  two halves never separate.  The dock sizes to its content (no
  bottom anchor), so it ends naturally after the form rather than
  stretching to the bottom of the canvas.  Previous/next buttons
  at the top move between priors on the same parameter.  The SVG is
  rendered at native size (336 × 208 viewBox) with a 36-px left
  margin so the rotated y-axis title "density" sits in its own
  lane, separated from the y-tick labels; the bottom margin (59 px)
  reserves room for tick labels + a gap + the axis title.
- **`McmcEditor`** — lives in the right sidebar of the **Source** tab.
  Three editable sections plus a live prior preview at the top:
  1. **Priors** — one row per prior with its editable attributes.  The
     currently-selected prior's density curve is shown in the preview
     panel at the top; the preview updates as the user types.
  2. **Operators** — one row per operator with its editable attributes
     (weight, scaleFactor, size, etc.).
  3. **MCMC** and **Log & log tree** — one row per `<mcmc>` and
     `<log>` / `<logTree>` element.

  Clicking a row's header (the slot name + target id) jumps to that
  element's source line in the XML on the left.  Clicking the form
  fields does not trigger a jump.  The user edits a field and
  watches the underlying XML update on the left.  An "Export XML"
  button in the Source tab bar downloads the edited file.  The
  diagram's right-docked `PriorDock` is still available for
  editing a single prior with the larger preview.

Both surfaces operate on the XML text in place (regex on
`<tag attrs/>` plus a body scan for `idref`) so the source view stays
byte-identical when the user only edits attribute values.  The
preview graph and the edit form share a single vertical scroll
container inside the dock so the curve and the inputs cannot drift
out of alignment.

### Prior PDF x-axis

The x-axis is on a log scale whenever the support spans more than a
factor of 5, which catches `logNormal`, `exponential`, and `gamma`
with `shape < 1` or wide range.  `normal`, `laplace`, `uniform`, and
`beta` stay on a linear axis.  An offset marker (dashed vertical
line + label) is now drawn at `offsetAt` for the prior kinds that
support an offset, so the user can see the offset's effect on the
plot.

### Offset

The `offset` attribute is now respected by `logNormal`, `exponential`,
`gamma`, `normal`, `laplace`, and `beta` in the preview plot.  The
density is sampled from `offset` upward (e.g. `gammapdf(x - offset,
k, theta)` for `gamma`), the x-axis is shifted to start at
`max(0, offset)`, and a dashed offset marker is drawn at the offset
position.  Editing the offset field in the dock's form updates the
preview live (every keystroke) and commits to the XML on blur or
Enter.

### Other

- Tab order is now Diagram → Source → Notation.  Keyboard shortcuts:
  1 = Diagram, 2 = Source, 3 = Notation.
- Removed the standalone `Edit MCMC` tab and header button
  `#btn-edit`.  MCMC editing lives in the right sidebar of the
  Source tab.  Removed the old `#mcmc-editor` container.
- `statusFlash` messages surface edit failures and parse errors via
  the existing helper.

### Click-to-jump on every sidebar row

The McmcEditor sidebar lists priors, operators, `<mcmc>`, and
`<log>` / `<logTree>` elements.  Every row has a clickable header
(the slot name + target id) and a `data-row-key`.  Clicking a
header:
1. Highlights that row in orange (matching the prior-row visual
   that was already there).
2. Jumps the source view to the matching XML line via the
   `onJumpToLine` callback.  `app.js` switches to the Source tab
   and calls `source.highlightId({ line, endLine: line, id: '(jump)' }, ...)`.

The host (`app.js`) wires the callback; the McmcEditor doesn't
know about tabs.  The diagram's right-docked `PriorDock` is
unchanged (still used for the larger preview when clicking a prior
node directly in the diagram).

### Source tab layout

The Source tab is a horizontal split:
- **Left:** the source XML in a line-numbered `<div class="src-body">`
  container.  No more `<pre>` wrapping (which leaked whitespace into
  the layout).  Hover highlights, click-to-jump from a node, and
  audit-panel row clicks all still work.
- **Right (340 px sidebar):** the McmcEditor with a live prior preview
  at the top, then sections for Priors, Operators, MCMC, and Logs.
  An "Export XML" button in the tab bar downloads the edited file.

On narrow viewports (≤920 px) the sidebar drops below the body.

### Auto-cleanup on reload

`load()` and `btn-clear` now tear down the McmcEditor
(`root.innerHTML = ''` and `mcmcEditor = null`).  Without this,
loading a new model and visiting the Source tab would re-use the
old McmcEditor instance, which still has the previous model's
rendered DOM and only the model/xmlText fields updated — the
form fields would show the wrong parameters.  Defensive
null-guards were also added at the top of `render()` so a stale
render cannot throw "Cannot set properties of null (setting
innerHTML)".

## Other direction notes

The viewer is unchanged. Features it has (added in previous sessions):
- Source XML view with line highlighting (click a node → jump to its lines).
- Audit panel listing every prior and every operator.
- Clickable legend that filters the diagram by node type.
- Search (`/`) that dims non-matching nodes.
- Model comparison (right-click → pick second XML → diff).
- BN-learner export (a flat .bn-style file).
- Theme toggle (◐ in header): light / dark / auto (follows prefers-color-scheme).
- Wider sidebar (320 px) with module list, view toggles, audit, legend.
- Inline canvas toolbar (fit, zoom, search, modules, machinery).
- Keyboard shortcuts: F, +/=, −/_, /, M, G, 1/2/3, R, Esc.
- Sticky filename chip in the header.
- Mobile drawer for the sidebar (≤920 px).
- Notation collapsible sections.

## Things to watch out for

### Parser
- `parse-beast.js` records `xmlLine`/`xmlEndLine` per node via a binary-search
  line offset table built once.
- Stats include `operators` and `priors` counts in addition to type tallies.
- `<patterns>` aliases into its `<alignment>`; canonical id resolver unwraps.
- Hyperparameter squares and machinery gating (logged-only / gradient
  elements are hidden unless the toggle is on).

### Render
- Drag mutates positions in place; `resetView`/`fitToView` re-runs the
  layout to restore the original arrangement.
- The hover effect is dispatched imperatively from `focusNode` by building a
  real `MouseEvent` and calling `dispatchEvent` (D3 `.dispatch` doesn't take
  event objects).

### PriorDock / McmcEditor
- Operate on the XML text directly (regex on `<tag attrs/>` and a body
  scan for `idref`), not on a parsed DOM, so the source view stays
  byte-identical when the user only edits attribute values.
- Prior inputs commit on `change` (blur / Enter); `input` (every keystroke)
  only updates the inline PDF preview.  This keeps focus on the field the
  user is typing in.
- Operator and `<mcmc>` / `<log>` rows use `change` and rebuild the viewer.
- `<parameter idref="..."/>` is matched via `elementReferencesId` which
  scans the element body for any idref — that handles `<ctmcScalePrior>`,
  `<upDownOperator>` with `<up>`/`<down>`, and `<subtreeSlide>` referencing
  a `<treeModel>`.
- `findElementLine(text, tagName, targetId, i)` returns the source
  line of the i-th element matching (tagName, targetId).  Used by
  the McmcEditor's click-to-jump.
- The editor only edits attribute values; it cannot add or remove priors,
  operators, or other elements.  Users wanting structural changes edit the
  XML in the Source tab.
- Operator rows are deduped by `(tag, targetId)` so the i-th occurrence
  is what's passed to `setAttrOnElement` / `findElementLine`.  Click
  handlers read the operator's own `i` from the in-memory operators
  list, not the row index, so a click always targets the right
  element.

## Things deferred / known limitations

- The editor does not validate prior parameter values; an out-of-range
  `mean="abc"` propagates to the XML and shows up as a broken curve.
- Adding/removing priors, operators, or model components is out of scope;
  edit the XML directly.
- The `<up>`/`<down>` blocks of an upDown operator are not exposed; the
  operator is listed once per parameter it touches, and editing any of
  those rows edits the same DOM element.
- BN export uses placeholder CPDs; intended for structure-only
  consumption by learners that fit parameters from data.
- Layout is heuristic; the README warns large models may need dragging.
- On narrow viewports (<720 px) the prior dock goes full-width and stacks
  preview above form, so the side-by-side layout becomes a top/bottom
  layout.  Acceptable on phones; desktop users see the side-by-side.

