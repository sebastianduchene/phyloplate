/* D3 rendering of the plate diagram.
 * Draw order: plates (back) -> module hulls -> edges -> nodes (front). */

import { layout, collapseModules } from './layout.js';

const R = 24;                 // node radius
const MOD_R = 42;             // collapsed-module box half-width baseline
const PLATE_PAD = 30;

const MODULE_LABEL = {
  tree: 'Tree', rateMatrix: 'Rate matrix', siteRates: 'Site rates',
  branchRates: 'Branch rates', phyloCTMC: 'PhyloCTMC', data: 'Data', other: 'Other',
};

export class DiagramView {
  constructor(svgEl, tooltipEl) {
    this.svg = d3.select(svgEl);
    this.tooltip = d3.select(tooltipEl);
    this.collapsed = new Set();
    this.showMachinery = false;
    this.showModules = false;
    this.model = null;

    this.svg.selectAll('*').remove();
    const defs = this.svg.append('defs');
    for (const [id, cls] of [['arrow', 'arrow'], ['arrow-hi', 'arrow-hi'], ['arrow-dim', 'arrow-dim']]) {
      defs.append('marker')
        .attr('id', id).attr('viewBox', '0 -5 10 10').attr('refX', 9).attr('refY', 0)
        .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L9,0L0,4').attr('class', cls);
    }

    this.root = this.svg.append('g').attr('class', 'zoom-root');
    this.gPlates = this.root.append('g').attr('class', 'plates');
    this.gHulls = this.root.append('g').attr('class', 'hulls');
    this.gEdges = this.root.append('g').attr('class', 'edges');
    this.gNodes = this.root.append('g').attr('class', 'nodes');

    this.zoom = d3.zoom().scaleExtent([0.2, 4])
      .on('zoom', e => this.root.attr('transform', e.transform));
    this.svg.call(this.zoom);
  }

  setModel(model) {
    this.model = model;
    this.collapsed = new Set();
    // A new model in an old pan/zoom would open off-screen.
    this.svg.call(this.zoom.transform, d3.zoomIdentity);
    this.draw();
  }

  /** Search-time: dim everything but the matching nodes. */
  highlightMatches(matches) {
    if (!this.model) return;
    const ids = new Set((matches || []).map(m => m.id));
    this.svg.select('.zoom-root').selectAll('.node')
      .classed('dim', d => matches && !ids.has(d.id));
  }

  /** Imperatively focus a node (hover-equivalent behaviour from outside). */
  focusNode(id) {
    if (!this.model) return;
    const node = this.model.nodes.find(n => n.id === id);
    if (!node) return;
    const sel = this.svg.selectAll('.node').filter(d => d.id === id);
    if (sel.empty()) return;
    const ev = sel.node();
    if (!ev) return;
    const rect = ev.getBoundingClientRect();
    // Build a real MouseEvent so the existing mouseenter handler runs.
    const fakeEvent = new MouseEvent('mouseenter', {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    ev.dispatchEvent(fakeEvent);
  }

  /** Fit the graph into the viewport. */
  fitToView() {
    if (!this.model) return false;
    this.svg.transition().duration(250).call(this.zoom.transform, d3.zoomIdentity);
    return true;
  }

  zoomBy(factor) {
    if (!this.model) return false;
    this.svg.transition().duration(150).call(this.zoom.scaleBy, factor);
    return true;
  }

  toggleModule(m) {
    this.collapsed.has(m) ? this.collapsed.delete(m) : this.collapsed.add(m);
    this.draw();
  }

  collapseAll() {
    this.collapsed = new Set(this.model.nodes.map(n => n.module));
    this.draw();
  }

  expandAll() { this.collapsed = new Set(); this.draw(); }

  setMachinery(v) { this.showMachinery = v; this.draw(); }
  setModules(v) { this.showModules = v; this.draw(); }

  /** Modules present in the current model, for the sidebar. */
  modules() {
    if (!this.model) return [];
    const counts = new Map();
    for (const n of this.visibleNodes()) {
      counts.set(n.module, (counts.get(n.module) || 0) + 1);
    }
    return [...counts].map(([m, c]) => ({
      id: m, label: MODULE_LABEL[m] || m, count: c, collapsed: this.collapsed.has(m),
    })).sort((a, b) => a.label.localeCompare(b.label));
  }

  visibleNodes() {
    return this.model.nodes.filter(n => this.showMachinery || !n.machinery);
  }

  draw() {
    if (!this.model) return;
    const self = this;

    let nodes = this.visibleNodes().map(n => ({ ...n }));
    const ids = new Set(nodes.map(n => n.id));
    let edges = this.model.edges
      .filter(e => ids.has(e.source) && ids.has(e.target))
      .map(e => ({ ...e }));

    ({ nodes, edges } = collapseModules(nodes, edges, this.collapsed));

    // size each node so its label fits, before laying out
    for (const n of nodes) {
      if (n.type === 'module') {
        n.w = Math.max(150, textWidth(MODULE_LABEL[n.module] || n.module, MOD_FONT) + 44);
        n.h = 52;
      } else if (n.type === 'constant') {
        n.w = Math.max(52, textWidth(n.label, SMALL_FONT) + 18); n.h = 28;
      } else if (n.type === 'factor') {
        n.w = Math.max(72, textWidth(n.label, SMALL_FONT) + 22); n.h = 34;
      } else {
        n.r = R;
      }
    }

    // Circles are narrow but their id caption is not, so reserve room for it.
    const widthOf = n => n.r
      ? Math.max(n.r * 2, Math.min(132, n.caption ? textWidth(fit(n.caption, 26), CAP_FONT) : 0))
      : n.w;

    const livePlates = (this.model.plates || [])
      .map(p => ({ ...p, members: p.members.filter(m => ids.has(m)) }))
      .filter(p => p.members.length >= 2 && !this.collapsed.size);

    const dim = layout(nodes, edges, { widthOf, plates: livePlates });
    const byId = new Map(nodes.map(n => [n.id, n]));

    const pad = 80;
    this.svg.attr('viewBox',
      `${-pad} ${dim.offsetY - pad} ${dim.width + 2 * pad} ${dim.height + 2 * pad}`);

    // ---------------------------------------------------------------- plates
    const activePlates = livePlates.map(p => ({ ...p, live: p.members }));

    const plateSel = this.gPlates.selectAll('g.plate')
      .data(activePlates, d => d.id)
      .join(enter => {
        const g = enter.append('g').attr('class', 'plate');
        g.append('rect').attr('class', d => `plate-rect plate-${d.kind}`)
          .attr('rx', d => d.kind === 'tree' ? 14 : 4);
        g.append('text').attr('class', 'plate-label');
        return g;
      });

    // ---------------------------------------------------------------- hulls
    const modGroups = this.showModules
      ? [...d3.group(nodes.filter(n => n.type !== 'module'), n => n.module)]
          .filter(([, ns]) => ns.length >= 2)
          .map(([m, ns]) => ({ id: m, label: MODULE_LABEL[m] || m, members: ns.map(n => n.id) }))
      : [];

    const hullSel = this.gHulls.selectAll('g.hull')
      .data(modGroups, d => d.id)
      .join(enter => {
        const g = enter.append('g').attr('class', 'hull');
        g.append('path').attr('class', d => `hull-shape mod-${d.id}`);
        g.append('text').attr('class', 'hull-label');
        return g;
      });

    // ---------------------------------------------------------------- edges
    const edgeSel = this.gEdges.selectAll('path.edge')
      .data(edges, d => `${d.source}->${d.target}`)
      .join('path')
      .attr('class', d => `edge edge-${d.kind}`)
      .attr('marker-end', 'url(#arrow)');

    // ---------------------------------------------------------------- nodes
    const nodeSel = this.gNodes.selectAll('g.node')
      .data(nodes, d => d.id)
      .join(enter => {
        const g = enter.append('g');
        g.append('title');
        return g;
      })
      .attr('class', d => `node node-${d.type} mod-${d.module}`)
      .attr('transform', d => `translate(${d.x},${d.y})`);

    nodeSel.selectAll('.node-shape, .node-inner, .node-text').remove();

    nodeSel.each(function (d) {
      const g = d3.select(this);
      if (d.type === 'constant') {
        g.append('rect').attr('class', 'node-shape')
          .attr('x', -d.w / 2).attr('y', -d.h / 2).attr('width', d.w).attr('height', d.h).attr('rx', 3);
      } else if (d.type === 'factor') {
        g.append('rect').attr('class', 'node-shape')
          .attr('x', -d.w / 2).attr('y', -d.h / 2).attr('width', d.w).attr('height', d.h).attr('rx', 17);
      } else if (d.type === 'module') {
        g.append('rect').attr('class', 'node-shape')
          .attr('x', -d.w / 2).attr('y', -d.h / 2).attr('width', d.w).attr('height', d.h).attr('rx', 8);
      } else {
        g.append('circle').attr('class', 'node-shape').attr('r', R);
        if (d.type === 'clamped') g.append('circle').attr('class', 'node-inner').attr('r', R - 5);
      }

      if (d.type === 'module') {
        g.append('text').attr('class', 'node-text')
          .attr('text-anchor', 'middle').attr('dy', '-0.1em')
          .text(MODULE_LABEL[d.module] || d.module);
        g.append('text').attr('class', 'node-text node-sub')
          .attr('text-anchor', 'middle').attr('dy', '1.25em')
          .text(`${d.memberCount} node${d.memberCount === 1 ? '' : 's'} · click to expand`);
        return;
      }

      g.append('text').attr('class', 'node-text')
        .attr('text-anchor', 'middle').attr('dy', '0.35em')
        .text(fit(d.label, d.r ? 7 : 24));

      // The full BEAST id sits under the shape; the shape itself carries the
      // conventional symbol, as in the figures of the paper.
      if (d.caption && d.caption !== d.label) {
        g.append('text').attr('class', 'node-text node-caption')
          .attr('text-anchor', 'middle')
          .attr('dy', (d.r ? d.r : d.h / 2) + 14)
          .text(fit(d.caption, 26));
      }
    });

    // ---------------------------------------------------------------- update
    const updateEdges = () => {
      edgeSel.attr('d', d => {
        const s = byId.get(d.source), t = byId.get(d.target);
        if (!s || !t) return null;
        const [x1, y1] = boundary(s, t.x, t.y);
        const [x2, y2] = boundary(t, s.x, s.y, 6);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const dx = x2 - x1, dy = y2 - y1;
        const curve = Math.min(40, Math.abs(dx) * 0.18);
        const cx = mx - (dy / (Math.hypot(dx, dy) || 1)) * curve;
        const cy = my + (dx / (Math.hypot(dx, dy) || 1)) * curve;
        return `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
      });
    };

    const fitBox = (sel, memberIds, padding) => {
      const ms = memberIds.map(i => byId.get(i)).filter(Boolean);
      if (!ms.length) return null;
      const xs = ms.map(n => [n.x - halfW(n), n.x + halfW(n)]).flat();
      const ys = ms.map(n => [n.y - halfH(n), n.y + halfH(n)]).flat();
      return {
        x: Math.min(...xs) - padding, y: Math.min(...ys) - padding,
        w: Math.max(...xs) - Math.min(...xs) + 2 * padding,
        h: Math.max(...ys) - Math.min(...ys) + 2 * padding,
      };
    };

    const updatePlates = () => {
      plateSel.each(function (d) {
        const b = fitBox(null, d.live, PLATE_PAD);
        const g = d3.select(this);
        if (!b) { g.attr('display', 'none'); return; }
        g.attr('display', null);
        b.h += 22;   // room for the id captions and the plate label below them
        g.select('rect').attr('x', b.x).attr('y', b.y).attr('width', b.w).attr('height', b.h);
        g.select('text').attr('x', b.x + b.w - 10).attr('y', b.y + b.h - 9)
          .attr('text-anchor', 'end').text(d.label);
      });
      hullSel.each(function (d) {
        const g = d3.select(this);
        const ms = d.members.map(i => byId.get(i)).filter(Boolean);
        if (ms.length < 2) { g.attr('display', 'none'); return; }
        g.attr('display', null);
        const pts = ms.flatMap(n => corners(n, 22));
        const hull = ms.length >= 2 && pts.length >= 3 ? d3.polygonHull(pts) : null;
        g.select('path').attr('d', hull ? roundedHull(hull, 16) : null);
        const top = ms.reduce((a, b) => (a.y < b.y ? a : b));
        g.select('text').attr('x', top.x).attr('y', top.y - halfH(top) - 34)
          .attr('text-anchor', 'middle').text(d.label);
      });
    };

    updateEdges();
    updatePlates();

    // ---------------------------------------------------------------- interaction
    nodeSel.call(d3.drag()
      .on('start', function () { d3.select(this).raise().classed('dragging', true); })
      .on('drag', function (event, d) {
        d.x = event.x; d.y = event.y;
        d3.select(this).attr('transform', `translate(${d.x},${d.y})`);
        updateEdges(); updatePlates();
      })
      .on('end', function () { d3.select(this).classed('dragging', false); }));

    nodeSel
      .on('mouseenter', function (event, d) {
        const touching = new Set();
        edgeSel.classed('hi', e => {
          const on = e.source === d.id || e.target === d.id;
          if (on) { touching.add(e.source); touching.add(e.target); }
          return on;
        }).classed('dim', e => !(e.source === d.id || e.target === d.id))
          .attr('marker-end', e => (e.source === d.id || e.target === d.id)
            ? 'url(#arrow-hi)' : 'url(#arrow-dim)');
        nodeSel.classed('dim', n => n.id !== d.id && !touching.has(n.id));
        self.showTip(event, d);
        // Notify other panes: source view can highlight this node's lines.
        self.hoveredNode = d;
        self.onHover?.(d);
      })
      .on('mousemove', function (event) { self.moveTip(event); })
      .on('mouseleave', function () {
        edgeSel.classed('hi', false).classed('dim', false).attr('marker-end', 'url(#arrow)');
        nodeSel.classed('dim', false);
        self.hideTip();
        self.hoveredNode = null;
        self.onHover?.(null);
      })
      .on('click', function (event, d) {
        if (d.type === 'module') { self.toggleModule(d.module); self.onChange?.(); }
        self.onPick?.(d);
      });

    this.onChange?.();
  }

  // ---------------------------------------------------------------- tooltip
  showTip(event, d) {
    const rows = [];
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    if (d.type === 'module') {
      rows.push(['contains', `${d.memberCount} nodes`]);
      rows.push(['members', d.role.replace(/^\d+ nodes: /, '')]);
    } else {
      rows.push(['type', TYPE_NAME[d.type] || d.type]);
      if (d.role) rows.push(['xml', d.role]);
      if (d.tag) rows.push(['element', `<${d.tag}>`]);
      if (d.value) rows.push(['value', d.value]);
      if (d.dimension) rows.push(['dimension', d.dimension]);
      if (d.priors?.length) {
        rows.push(['prior', d.priors.map(p => {
          const a = Object.entries(p.attrs).filter(([k]) => !['id', 'idref'].includes(k))
            .map(([k, v]) => `${k}=${v}`).join(', ');
          return a ? `${p.label}(${a})` : p.label;
        }).join('; ')]);
      }
      if (d.operators?.length) {
        rows.push(['operators', d.operators.map(o =>
          `${o.tag}${o.attrs.weight ? ` (w=${o.attrs.weight})` : ''}`).join(', ')]);
      }
      if (d.module) rows.push(['module', MODULE_LABEL[d.module] || d.module]);
      if (d.xmlLine) rows.push(['line', `${d.xmlLine}`]);
    }

    this.tooltip.html(
      `<div class="tt-title">${esc(d.type === 'module' ? MODULE_LABEL[d.module] : d.id)}</div>` +
      rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${esc(v)}</b></div>`).join('')
    ).classed('visible', true);
    this.moveTip(event);
  }

  moveTip(event) {
    const pad = 16;
    const w = this.tooltip.node().offsetWidth, h = this.tooltip.node().offsetHeight;
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
    this.tooltip.style('left', x + 'px').style('top', y + 'px');
  }

  hideTip() { this.tooltip.classed('visible', false); }

  /* Reset means "put the picture back how it was drawn", which is both the
   * pan/zoom and the layout: dragging mutates node positions in place, so
   * resetting only the transform leaves a rearranged graph sitting there and
   * looks like the button did nothing. */
  resetView() {
    this.draw();
    this.svg.transition().duration(300).call(this.zoom.transform, d3.zoomIdentity);
  }

  exportSVG() {
    const clone = this.svg.node().cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const css = [...document.styleSheets]
      .flatMap(s => { try { return [...s.cssRules].map(r => r.cssText); } catch { return []; } })
      .filter(r => /\.(node|edge|plate|hull|arrow)/.test(r)).join('\n');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }
}

const TYPE_NAME = {
  constant: 'constant (fixed value)',
  stochastic: 'stochastic (random variable)',
  deterministic: 'deterministic (function of parents)',
  clamped: 'clamped (observed data)',
  factor: 'factor (likelihood / density)',
};

// ---------------------------------------------------------------- geometry

const halfW = n => n.r ? n.r : n.w / 2;
const halfH = n => n.r ? n.r : n.h / 2;

/** Point on the boundary of node n, in the direction of (tx,ty). */
function boundary(n, tx, ty, extra = 0) {
  const dx = tx - n.x, dy = ty - n.y;
  const len = Math.hypot(dx, dy) || 1;
  if (n.r) {
    const r = n.r + extra;
    return [n.x + (dx / len) * r, n.y + (dy / len) * r];
  }
  const hw = n.w / 2 + extra, hh = n.h / 2 + extra;
  const scale = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6));
  return [n.x + dx * scale, n.y + dy * scale];
}

const BODY_FONT = '13px system-ui, -apple-system, sans-serif';
const SMALL_FONT = '11px ui-monospace, monospace';
const MOD_FONT = '600 14px system-ui, -apple-system, sans-serif';
const CAP_FONT = '10.5px ui-monospace, monospace';

/** The four padded corners of a node, as hull input points. */
function corners(n, pad) {
  const hw = halfW(n) + pad, hh = halfH(n) + pad;
  return [[n.x - hw, n.y - hh], [n.x + hw, n.y - hh],
          [n.x + hw, n.y + hh], [n.x - hw, n.y + hh]];
}

/** Hull polygon with its corners rounded off, so it reads as a soft region. */
function roundedHull(pts, r) {
  if (pts.length < 3) return null;
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const a = trim(p, prev, r), b = trim(p, next, r);
    d += (i === 0 ? `M${a[0]},${a[1]}` : `L${a[0]},${a[1]}`);
    d += ` Q${p[0]},${p[1]} ${b[0]},${b[1]}`;
  }
  return d + 'Z';

  function trim(from, to, dist) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.min(dist, len / 2) / len;
    return [from[0] + dx * t, from[1] + dy * t];
  }
}

const CANVAS = document.createElement('canvas').getContext('2d');
function textWidth(s, font = BODY_FONT) {
  CANVAS.font = font;
  return CANVAS.measureText(s).width;
}

const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
