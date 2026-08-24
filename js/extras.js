/* Auxiliary views and shared helpers used by the main app: source XML view,
 * audit panel of priors/operators, search/highlight, model comparison, and
 * Bayesian-network export.  Each is a small class or factory that the app.js
 * orchestrator calls into. */

const esc = s => String(s).replace(/[&<>]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------------------------------------------------------------- source view

/* Renders the parsed XML as a line-numbered, syntax-highlighted pane.  Each
 * line is interactive: hovering a node in the diagram dims everything but its
 * source span, and clicking a node jumps to and highlights its span here. */
export class SourceView {
  constructor(el) {
    this.el = el;
    /* When the source pane hosts a sidebar (the MCMC editor), the
     * SourceView renders into a dedicated child element so the
     * sidebar is preserved across re-renders. */
    this.bodyEl = el.querySelector('.source-body') || el;
    this.lines = [];
    this.activeId = null;
    this.hoverId = null;
  }
  setSource(text) {
    this.lines = text.split('\n');
    this.render();
  }
  render() {
    const head = `<div class="src-head">
      <span class="src-label">Hover a node, or click to jump:</span>
      <span class="src-current" id="src-current"></span>
    </div>`;
    const body = this.lines.map((ln, i) => {
      const lineNo = i + 1;
      const code = esc(ln).replace(/^(\s*&lt;!--.*?--&gt;)/,
        '<span class="com">$1</span>');
      const tagStyled = code.replace(
        /(&lt;\/?)([a-zA-Z][\w:-]*)/g,
        '$1<span class="tag">$2</span>');
      const finalStyled = tagStyled.replace(
        /\s([a-zA-Z\-:]+)=&quot;([^&]*)&quot;/g,
        ' <span class="attr">$1</span>=<span class="str">"$2"</span>');
      return `<div class="src-line" data-line="${lineNo}">
        <span class="ln">${lineNo}</span><span class="code">${finalStyled || '&nbsp;'}</span>
      </div>`;
    }).join('');
    this.bodyEl.innerHTML = head + `<div class="src-body">${body}</div>`;
  }
  /* nodeRange: { line, endLine } from parser */
  highlightId(node, opts = {}) {
    const { line, endLine } = node;
    if (!line) return;
    this.el.querySelectorAll('.src-line').forEach(el => {
      const ln = +el.dataset.line;
      el.classList.toggle('hi', ln >= line && ln <= (endLine || line));
      el.classList.toggle('dim', opts.dimOthers &&
        !(ln >= line && ln <= (endLine || line)));
    });
    const cur = this.el.querySelector('#src-current');
    if (cur) cur.textContent = node.id;
    if (opts.scroll) {
      const first = this.el.querySelector(`.src-line[data-line="${line}"]`);
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  clearHighlight() {
    this.el.querySelectorAll('.src-line').forEach(el => {
      el.classList.remove('hi', 'dim');
    });
    const cur = this.el.querySelector('#src-current');
    if (cur) cur.textContent = '';
  }
}

// ---------------------------------------------------------------- audit panel

/* Renders the priors and operators in two compact tables, one row per
 * element.  Each row is clickable: clicking it jumps to the node's source
 * line and highlights the source pane. */
export function renderAudit(model, onPickNode) {
  const el = document.getElementById('audit');
  if (!el) return;
  const esc = s => String(s).replace(/[&<>]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = [];
  // priors
  rows.push(`<div>
    <h3>Priors <span class="audit-count">${model.stats.priors || 0}</span></h3>
    ${priorsTable(model, esc, onPickNode)}
  </div>`);
  // operators
  rows.push(`<div>
    <h3>Operators <span class="audit-count">${model.stats.operators || 0}</span></h3>
    ${operatorsTable(model, esc, onPickNode)}
  </div>`);
  el.innerHTML = rows.join('');
}

function priorsTable(model, esc, onPickNode) {
  const items = [];
  for (const n of model.nodes) {
    for (const p of (n.priors || [])) {
      const detail = Object.entries(p.attrs)
        .filter(([k]) => !['id', 'idref'].includes(k))
        .map(([k, v]) => `${k}=${v}`).join(', ');
      items.push({ id: n.id, label: n.label, tag: p.dist,
                   detail: `${p.label}${detail ? '(' + detail + ')' : ''}`,
                   line: n.xmlLine });
    }
  }
  if (!items.length) return `<div class="hint">No priors declared.</div>`;
  return `<table class="audit-table"><thead>
    <tr><th>Variable</th><th>Distribution</th></tr></thead>
    <tbody>${items.map(p => `
      <tr data-id="${esc(p.id)}" data-line="${p.line || ''}">
        <td class="audit-id">${esc(p.id)}</td>
        <td class="audit-detail">${esc(p.detail)}</td>
      </tr>`).join('')}</tbody></table>`;
}

function operatorsTable(model, esc, onPickNode) {
  const items = [];
  for (const n of model.nodes) {
    for (const o of (n.operators || [])) {
      const weight = o.attrs.weight ? `w=${o.attrs.weight}` : '';
      const scale  = o.attrs.scaleFactor ? `×${o.attrs.scaleFactor}` : '';
      const size   = o.attrs.size || o.attrs.windowSize
                     ? `${o.attrs.size ? 'size=' + o.attrs.size : ''}` : '';
      items.push({ id: n.id, label: n.label, tag: o.tag,
                   detail: `<${esc(o.tag)}> ${[weight, scale, size].filter(Boolean).join(' ')}`.trim(),
                   line: n.xmlLine });
    }
  }
  if (!items.length) return `<div class="hint">No operators declared.</div>`;
  return `<table class="audit-table"><thead>
    <tr><th>Variable</th><th>Operator</th></tr></thead>
    <tbody>${items.map(p => `
      <tr data-id="${esc(p.id)}" data-line="${p.line || ''}">
        <td class="audit-id">${esc(p.id)}</td>
        <td class="audit-detail">${p.detail}</td>
      </tr>`).join('')}</tbody></table>`;
}

export function wireAuditClicks(model) {
  const el = document.getElementById('audit');
  if (!el) return;
  el.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.onclick = () => {
      const id = tr.dataset.id;
      const n = model.nodes.find(x => x.id === id);
      if (!n) return;
      document.dispatchEvent(new CustomEvent('phyloplate:focus-node', {
        detail: { id, line: n.xmlLine, scrollSource: true }
      }));
    };
  });
}

// ---------------------------------------------------------------- search

/* Highlight matching nodes in the diagram and matching rows in the sidebar
 * (modules + audit).  Pressing Enter cycles through matches; Escape clears. */
export class Search {
  constructor(model, getDiagram, getSource) {
    this.model = model;
    this.getDiagram = getDiagram;
    this.getSource = getSource;
    this.matches = [];
    this.cursor = -1;
  }
  refresh() {
    const q = (document.getElementById('search').value || '').trim().toLowerCase();
    const diag = this.getDiagram();
    this.matches = !q ? [] : this.model.nodes.filter(n =>
      n.id.toLowerCase().includes(q) ||
      (n.tag || '').toLowerCase().includes(q) ||
      (n.label || '').toLowerCase().includes(q) ||
      (n.role || '').toLowerCase().includes(q));
    this.cursor = -1;
    this.updateCount();
    diag?.highlightMatches(this.matches);
    this.paintSidebar(q);
  }
  updateCount() {
    const c = document.getElementById('search-count');
    if (c) c.textContent = this.matches.length ? `${this.cursor + 1}/${this.matches.length}` : '';
  }
  paintSidebar(q) {
    const ids = new Set(this.matches.map(n => n.id));
    document.querySelectorAll('#audit tr[data-id]').forEach(tr => {
      tr.classList.toggle('match-hi', ids.has(tr.dataset.id));
    });
    document.querySelectorAll('.mod-item').forEach(li => {
      li.classList.remove('match-hi');
    });
  }
  next(dir = 1) {
    if (!this.matches.length) return;
    this.cursor = (this.cursor + dir + this.matches.length) % this.matches.length;
    this.updateCount();
    const n = this.matches[this.cursor];
    document.dispatchEvent(new CustomEvent('phyloplate:focus-node', {
      detail: { id: n.id, line: n.xmlLine, scrollSource: false }
    }));
  }
  clear() {
    document.getElementById('search').value = '';
    this.refresh();
  }
}

// ---------------------------------------------------------------- compare

/* Naive model diff: compare two parsed models node-by-node by id and edge-by-
 * edge by (source, target).  Used by the Compare tab; the UI is just a table
 * with three classes: added, removed, changed (different attributes). */
export function diffModels(a, b) {
  const aNodes = new Map(a.nodes.map(n => [n.id, n]));
  const bNodes = new Map(b.nodes.map(n => [n.id, n]));
  const added = [], removed = [], changed = [];
  for (const [id, n] of bNodes) {
    if (!aNodes.has(id)) added.push(n);
    else {
      const an = aNodes.get(id);
      const av = JSON.stringify(stableAttrs(an));
      const bv = JSON.stringify(stableAttrs(n));
      if (av !== bv) changed.push({ a: an, b: n });
    }
  }
  for (const [id, n] of aNodes) {
    if (!bNodes.has(id)) removed.push(n);
  }
  const aEdges = new Set(a.edges.map(e => `${e.source}>${e.target}`));
  const bEdges = new Set(b.edges.map(e => `${e.source}>${e.target}`));
  const addedE = [...bEdges].filter(e => !aEdges.has(e)).map(parseE);
  const removedE = [...aEdges].filter(e => !bEdges.has(e)).map(parseE);
  return { added, removed, changed, addedE, removedE,
           statsA: a.stats, statsB: b.stats,
           nameA: a.meta.fileName || 'A', nameB: b.meta.fileName || 'B' };
}

function stableAttrs(n) {
  const { value, dimension, priors, operators } = n;
  return { value, dimension,
           priors: (priors || []).map(p => `${p.dist}:${JSON.stringify(p.attrs)}`),
           operators: (operators || []).map(o => `${o.tag}:${JSON.stringify(o.attrs)}`) };
}
function parseE(s) {
  const i = s.indexOf('>');
  return { source: s.slice(0, i), target: s.slice(i + 1) };
}

export function renderDiff(diff, el) {
  const esc = s => String(s).replace(/[&<>]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rowN = (n, cls) => `<tr class="${cls}">
    <td class="id">${esc(n.id)}</td>
    <td class="label">&lt;${esc(n.tag)}&gt;</td>
    <td>${esc(n.label || '')}</td>
  </tr>`;
  const rowE = (e, cls) => `<tr class="${cls}">
    <td class="id">${esc(e.source)}</td>
    <td colspan="2">→ ${esc(e.target)}</td>
  </tr>`;
  const rowC = (c) => `<tr class="changed">
    <td class="id">${esc(c.a.id)}</td>
    <td class="label">&lt;${esc(c.a.tag)}&gt;</td>
    <td><b>before:</b> ${esc(JSON.stringify(stableAttrs(c.a)).slice(0, 220))}<br>
        <b>after:</b> ${esc(JSON.stringify(stableAttrs(c.b)).slice(0, 220))}</td>
  </tr>`;
  el.innerHTML = `
    <h2>Summary</h2>
    <p>Comparing <b>${esc(diff.nameA)}</b> and <b>${esc(diff.nameB)}</b>.
       ${diff.added.length} added, ${diff.removed.length} removed,
       ${diff.changed.length} changed nodes;
       ${diff.addedE.length} added, ${diff.removedE.length} removed edges.</p>
    <h2>Nodes added in ${esc(diff.nameB)}</h2>
    ${diff.added.length ? `<table><thead><tr><th>id</th><th>tag</th><th>label</th></tr></thead>
      <tbody>${diff.added.map(n => rowN(n, 'added')).join('')}</tbody></table>` : '<p>None.</p>'}
    <h2>Nodes removed</h2>
    ${diff.removed.length ? `<table><thead><tr><th>id</th><th>tag</th><th>label</th></tr></thead>
      <tbody>${diff.removed.map(n => rowN(n, 'removed')).join('')}</tbody></table>` : '<p>None.</p>'}
    <h2>Nodes with changed attributes</h2>
    ${diff.changed.length ? `<table><thead><tr><th>id</th><th>tag</th><th>change</th></tr></thead>
      <tbody>${diff.changed.map(rowC).join('')}</tbody></table>` : '<p>None.</p>'}
    <h2>Edges added in ${esc(diff.nameB)}</h2>
    ${diff.addedE.length ? `<table><thead><tr><th>source</th><th colspan="2">target</th></tr></thead>
      <tbody>${diff.addedE.map(e => rowE(e, 'added')).join('')}</tbody></table>` : '<p>None.</p>'}
    <h2>Edges removed</h2>
    ${diff.removedE.length ? `<table><thead><tr><th>source</th><th colspan="2">target</th></tr></thead>
      <tbody>${diff.removedE.map(e => rowE(e, 'removed')).join('')}</tbody></table>` : '<p>None.</p>'}
  `;
}

// ---------------------------------------------------------------- BN export

/* Serialise the parsed model as a BayesianNetwork (.bif) file that bnlearn,
 * pgmpy, and similar libraries can read.  Each stochastic variable becomes a
 * node with a CPD table; the entries are written as the literal density name
 * since the actual conditional table is parameterised, not enumerated.  This
 * gives structure-only output for learners that want to fit parameters from
 * data, not a full probability table. */
export function exportBN(model) {
  const idOf = n => n.id.replace(/[^A-Za-z0-9_]/g, '_');
  const stochastic = model.nodes.filter(n => n.type === 'stochastic');
  const parentsOf = new Map(model.nodes.map(n => [n.id, []]));
  for (const e of model.edges) {
    if (parentsOf.has(e.target)) parentsOf.get(e.target).push(e.source);
  }
  const nameOf = n => n.label || n.id;
  const lines = [];
  lines.push('// Bayesian-network structure extracted from BEAST X XML');
  lines.push('// Each node carries a placeholder CPD — replace with a fitted table.');
  lines.push('');
  for (const n of stochastic) {
    const parents = (parentsOf.get(n.id) || [])
      .map(pid => model.nodes.find(x => x.id === pid))
      .filter(p => p && p.type === 'stochastic')
      .map(idOf);
    if (parents.length) {
      lines.push(`network ${nameOf(n).replace(/\s+/g, '_')} {`);
      for (const p of parents) lines.push(`    parent ${p};`);
      lines.push(`    // CPD placeholder; parameterise from data.`);
      lines.push('}');
    } else {
      lines.push(`network ${nameOf(n).replace(/\s+/g, '_')} { /* root */ }`);
    }
  }
  // Also a flat edge list in case the consumer wants it
  lines.push('');
  lines.push('// Edges (child <- parent):');
  for (const n of stochastic) {
    for (const pid of (parentsOf.get(n.id) || [])) {
      const p = model.nodes.find(x => x.id === pid);
      if (!p) continue;
      if (p.type === 'stochastic') {
        lines.push(`${nameOf(n)} <- ${nameOf(p)}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- notation extras

/* Format a compact LaTeX block with light syntax colouring for the most common
 * commands.  Returns HTML (not a string) for direct insertion. */
export function highlightLatex(text) {
  let s = esc(text);
  // escape backslashes that we want to render verbatim
  s = s.replace(/\\([a-zA-Z]+)/g, '<span class="lt-cmd">\\$1</span>');
  s = s.replace(/(\^|_)(\{[^}]+\})/g, '$1<span class="lt-group">$2</span>');
  s = s.replace(/(\^|_)([a-zA-Z0-9])/g, '$1<span class="lt-group">$2</span>');
  s = s.replace(/(=|~|\\sim|\\propto|\\coloneqq|\\mid)/g,
    '<span class="lt-op">$1</span>');
  return s;
}
