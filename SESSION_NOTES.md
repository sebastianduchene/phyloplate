# PhyloPlate session notes

## Project
A local webapp that turns BEAST X (BEAST 1.x) XML files into plate diagrams
and probabilistic notation. Originally a viewer; expanded earlier sessions to
also generate XML from templates (the *builder*).  The builder was removed
this session; the webapp is now viewer + editor of an existing model.

Repo: `/mnt/c/Users/john/Documents/PhD/Dev/phyloplate`

User: John H. Tay (jtay). Branch: `main`.

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
js/mcmc-editor.js   prior / operator / MCMC editor (mutates XML in place)
js/d3.v7.min.js     vendored
```

`app.js` orchestrates: theme, loading, tabs, sidebar, search, audit,
toolbar, keyboard shortcuts, drawer, paste, drag-drop,
compare (right-click → second XML), and the MCMC editor.

## Changes this session

### Removed
- `js/builder.js` (XML generator with templates, palette, FASTA drop,
  drag-anywhere).
- Header buttons: `Build new` (`#btn-build`), `Edit in builder`
  (`#btn-edit-build`).
- The `#builder` container, all builder-related CSS (`.builder`, `.palette`,
  `.props`, `.fasta-drop`, etc.).
- `openBuilder` / `closeBuilder` / `Builder` import + state in `js/app.js`.
- The `phyloplate:open-builder` event listener.

### Added
- `js/mcmc-editor.js` — slim editor that operates directly on the loaded
  XML.  Lists every prior, every operator, and the `<mcmc>`/`<log>`/`<logTree>`
  rows, with form fields for the editable attributes and a live density
  preview for each prior.  Edits mutate the XML text in place; the source
  view, diagram, notation, and audit update from the new XML on every
  commit (i.e. on blur or Enter).
- Header button `Edit priors & MCMC` (`#btn-edit`).
- The `#mcmc-editor` container.
- An `Export XML` button in the editor header for downloading the edited
  file.

### Other direction notes

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

### Prior PDF x-axis

User complained the x-axis was out of scale and right-tail skewed for
positively-supported distributions.  The editor now uses a **log scale**
when the support spans more than a factor of 5, which catches:
- `logNormal` (always, since `xMax/xMin = exp(9*sigma)` is huge for any
  reasonable σ).
- `exponential` (range `[0.0001·mean, 12·mean]`).
- `gamma` when `shape < 1` (always, since the density has a pole at 0) or
  when the range is wide.
- `oneOnX` (improper, always).
`normal`, `laplace`, `uniform`, and `beta` stay on a linear axis because
they're not right-tailed.

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

### MCMC editor
- Operates on the XML text directly (regex on `<tag attrs/>` and a body
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
- The editor only edits attribute values; it cannot add or remove priors,
  operators, or other elements.  Users wanting structural changes edit the
  XML in the Source tab.

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

