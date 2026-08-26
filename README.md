<img src="assets/logo.svg" alt="" width="86" align="left" hspace="18" vspace="4">

# PhyloPlate

**[Open the app →](https://sebastianduchene.github.io/phyloplate/)**

<br clear="left">

Drop a BEAST X XML on the page and read the model back two ways: as a **plate
diagram** in the notation of Höhna *et al.* (2014), and as the **written-out
probabilistic model** — posterior factorisation, likelihood, priors, and
deterministic transforms. Or click **Build new** to construct a model from a
template and export the XML.

Everything runs in your browser. Your XML is never uploaded; the page has no
back end and makes no network requests once loaded.

![The plate diagram of a mixed-effects clock model](docs/img/diagram.png)

## Why

A BEAST XML says exactly what the model is, and says it almost unreadably. The
generative structure — what depends on what, which variables are sampled,
which are transforms, where the data attaches — is spread across a few hundred
lines of nested elements and `idref`s. PhyloPlate recovers that structure and
draws it.

## The two views

### Diagram

| Shape | Meaning |
| --- | --- |
| Square | constant — fixed value, including prior hyperparameters |
| Solid circle | stochastic — a sampled random variable |
| Dashed circle | deterministic — a function of its parents |
| Shaded circle | clamped — observed data |
| Rounded box | factor — a likelihood or density term |
| Dashed rectangle | plate — replication over branches or sites |

Circles carry the conventional symbol — Ψ for the tree, *Q* for the rate
matrix, ε for per-branch random effects — with the BEAST `id` printed
underneath. Arrows run from a variable to whatever depends on it, so the graph
reads top-to-bottom in the generative direction and ends at the clamped
alignment.

Nodes are draggable and plates refit as you move them. Hovering a node shows
its type, prior, operators, and line in the source XML, and highlights its
edges. Scroll to zoom, drag the background to pan, and **Reset view** puts the
picture back as it was drawn — restoring the computed layout, so it undoes
dragging as well as the pan and zoom.

**Collapse modules** gives the high-level modular view of Fig. 8a of the
paper — Tree, Rate matrix, Site rates, Branch rates, PhyloCTMC — with each box
expandable on click.

![The same model collapsed into modules](docs/img/collapsed.png)

### Notation

The same model as mathematics:

```
p(Ψ, g, Nₑ, β, εⱼ, σ, κ, α | Dᵢ) ∝ p(Dᵢ | M, Ψ, rⱼ) · p(κ) · p(α) · p(β₀ | Ψ)
                                   · p(β₁) · p(σ) · p(εⱼ | σ) · p(Nₑ) · p(g)
                                   · p(Ψ | N(t))
```

followed by one statement per factor (`εⱼ ~ Normal(0, σ)`), the deterministic
definitions (`Q := HKY(π, κ)`, `β₀ := β[1]`), the fixed values, and a glossary
tying every symbol back to its BEAST id.

That product is not guesswork. It is read from the `<joint>` block — one term
per child of `<prior>` and `<likelihood>` — so it is exactly the density the
sampler targets. Where the algebra matters more than the component name, the
form is spelled out and guarded by the attributes that imply it; for example
`arbitraryBranchRates shrinkage="true"` over a `<fixedEffects>` prints

```
rⱼ = ( Σₖ βₖ zⱼₖ ) · exp(εⱼ)
```

**Copy LaTeX** puts the whole thing on the clipboard as an `equation` plus an
`align` block, ready to paste into a manuscript.

![The notation view](docs/img/notation.png)

## Source view

The **Source** tab shows the underlying XML with line numbers and a faint
syntax colouring. Hover any node in the diagram and the matching lines
highlight; click and the pane scrolls to the block. Useful when you want to
read what the model actually says in BEAST's grammar, not just the abstracted
graph.

## Auditing priors and operators

The sidebar lists every prior and every operator as compact tables, one row
each. Click a row to focus the node and jump to its source line.

## Searching

Type into the sidebar search box to filter the diagram to nodes whose id, tag,
or symbol matches. Press `Enter` to cycle matches; `Escape` to clear.

## Comparing two models

Right-click the canvas (or use a button) to load a second BEAST X file and
diff the two DAGs. Added, removed, and changed (attribute-different) nodes
and edges are reported in a new **Compare** tab.

## Editing priors and MCMC parameters

Once a model is loaded, click **Edit priors &amp; MCMC** in the header.  A
side panel lists every prior and every operator in the file, grouped by
target parameter, with form fields for the editable attributes.  The inline
density plot next to each prior updates as you type; the larger plot opens
in a popup for inspection.  `<mcmc>` and `<log>`/`<logTree>` rows expose
`chainLength`, `autoOptimize`, `logEvery`, `fileName`, and so on.

Edits go directly into the XML text in place — formatting, comments, and
ordering of unrelated elements are preserved — and the diagram, notation,
audit, and source view update from the new XML on every commit (i.e. on
blur or Enter).

The editor only edits attribute values on existing elements.  It does not
add or remove priors, operators, or other model components; for that, edit
the XML directly in the **Source** tab or in your editor of choice.

## Running it locally

```sh
git clone https://github.com/sebastianduchene/phyloplate.git
cd phyloplate
./serve.sh
```

`serve.sh` picks the next free port if 8000 is taken and prints the URL to
open. Append `?demo=1` to go straight to an example.

**A server is required.** The app is written as ES modules, which browsers
refuse to load over `file://` — double-clicking `index.html` runs none of the
code. The page detects that and says so rather than sitting there looking
broken.

## Examples

| File | Model |
| --- | --- |
| [`gtr-strict-clock-6taxa.xml`](examples/gtr-strict-clock-6taxa.xml) | Tip-dated GTR+Γ, strict clock, constant-size coalescent. 6 taxa, 240 nt. |
| [`sim_local_MEclock_MCMC_HMCtuned.xml`](examples/sim_local_MEclock_MCMC_HMCtuned.xml) | Mixed-effects molecular clock with per-branch random effects sampled by HMC, HKY+Γ, exponential-growth coalescent. 50 taxa, 5000 nt. |

Both use simulated sequences.

## How it works

`js/parse-beast.js` walks the XML generically rather than pattern-matching
known models:

- every element with an `id` becomes a candidate node, and any identified
  element nested inside or referenced by another points *into* it — which is
  the generative direction
- nodes are typed from their tag, plus whether an operator moves them and
  whether a prior constrains them
- `<patterns>` folds into its alignment, tree node-height parameters fold into
  the tree, and observed data is flipped below the likelihood
- modules are assigned by tag and then propagated across edges, so components
  the tag tables do not know about still land in the right group
- anything whose only consumers are gradients, logged statistics, or the
  starting-tree simulator is flagged as inference machinery and hidden behind a
  toggle

Unfamiliar models therefore still draw; they fall back to generic labels where
no symbol is known. `js/notation.js` reuses the same graph — a factor's
conditioning set is just its parents in the DAG — so the two views cannot
drift apart.

```
index.html          layout and controls
css/style.css       Material teal/orange palette (with dark mode)
js/parse-beast.js   XML  -> typed DAG, modules, plates, posterior structure
js/layout.js        layered DAG layout with plate compaction
js/render.js        D3 drawing, drag, zoom, tooltips, SVG export
js/notation.js      DAG  -> probabilistic notation and LaTeX
js/extras.js        source view, audit, search, comparison, BN export
js/mcmc-editor.js   prior / operator / MCMC editor (mutates XML in place)
js/d3.v7.min.js     vendored, so the app works offline
assets/             logo, icons and social card
```

## The icon

<img src="assets/logo.svg" alt="" width="60" align="left" hspace="14" vspace="2">

Two offset dashed plates holding the smallest phylogenetic model there is: one
ancestor, two descendants, the right one shaded because it is observed. The
plates are the notation's mark for replication, so the icon says "a graphical
model, repeated" &mdash; which is what the app draws.

<br clear="left">

| File | Use |
| --- | --- |
| `assets/logo.svg` | the mark, for light backgrounds |
| `assets/logo-reversed.svg` | white version, for the app header and dark grounds |
| `assets/icon.svg` | small-size form: one plate, three solid nodes |
| `favicon.ico` | 16 / 32 / 48 px, each rendered from the SVG rather than downscaled |
| `assets/apple-touch-icon.png` | 180 px opaque tile |
| `assets/og-image.png` | 1200 &times; 630 social card |

The full mark does not survive a 16 px favicon &mdash; two dashed plates plus a
three-node graph is more detail than a browser tab can show. `icon.svg` is a
genuine reduction rather than a restyle, keeping the plate and the three nodes
but dropping the second plate and the edges.

## Scope and limitations

- **BEAST X / BEAST 1.x only** — the dialect BEAUti v10 emits, with elements
  such as `<treeModel>` and `<treeDataLikelihood>`. BEAST2 files use the same
  `<beast>` root but a `spec="…"` attribute style; they are detected and
  rejected with a message rather than drawn as an empty graph.
- The layout is heuristic. Large models draw correctly but may need dragging
  before they are presentable.
- The algebraic forms cover a handful of common clock and substitution
  components. Anything else is shown as `component(parents…)`, which is
  accurate but less informative.

## Citation

The notation is from:

> Höhna S., Heath T.A., Boussau B., Landis M.J., Ronquist F., Huelsenbeck J.P.
> (2014) Probabilistic graphical model representation in phylogenetics.
> *Systematic Biology* 63(5):753–771. doi:[10.1093/sysbio/syu039](https://doi.org/10.1093/sysbio/syu039)

BEAST X is at [beast.community](https://beast.community/) and
[github.com/beast-dev](https://github.com/beast-dev/beast-mcmc).

## Licence

MIT — see [LICENSE](LICENSE).
