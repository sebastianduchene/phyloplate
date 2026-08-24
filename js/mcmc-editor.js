/* Prior / operator / MCMC editor.
 *
 * Two UI surfaces share a single XML-edit pipeline:
 *
 *  1. `PriorDock` — a right-docked panel that opens when the user clicks
 *     a prior (or its target parameter) in the diagram.  The dock renders
 *     one prior at a time: a live density preview on the left, the
 *     editable attribute form on the right.  The two halves share the
 *     same vertical viewport, so the form and the curve never scroll
 *     apart.
 *
 *  2. `McmcEditor` — fills the "Edit MCMC" tab.  Lists every operator
 *     grouped by target, plus a row for the <mcmc> element and one per
 *     <log>/<logTree> element.
 *
 * Both surfaces mutate the XML text in place (regex on `<tag attrs/>` plus
 * a body scan for `idref`), and call the registered onApply callback so
 * the viewer re-parses and re-renders.
 *
 * The previous full-window "Edit priors & MCMC" pane (one row per prior
 * with a global preview at the top) is gone; the per-prior preview now
 * lives in the dock so it sits next to its own edit form.
 */

const PRIOR_KINDS = [
  'logNormal', 'exponential', 'normal', 'gamma', 'uniform', 'beta',
  'oneOnX', 'ctmcScale', 'laplace',
];

const PRIOR_INFO = {
  logNormal: {
    label: 'LogNormal',
    text: 'Heavy right tail; values are strictly positive. BEAST X default ' +
          'parameters (mean=1, stdev=1.25, meanInRealSpace=false) encode ' +
          '\u03BC and \u03C3 of ln X.  The median is e^\u03BC \u2248 2.7.',
  },
  exponential: {
    label: 'Exponential',
    text: 'Memoryless decay on x \u2265 offset.  mean is the mean of the ' +
          'distribution (BEAST uses mean, not rate \u03BB = 1/mean).',
  },
  gamma: {
    label: 'Gamma',
    text: 'Strictly positive, flexible shape. shape and scale fields encode ' +
          'shape \u03B1 and scale \u03B8 so mean = \u03B1\u00B7\u03B8 and ' +
          'var = \u03B1\u00B7\u03B8\u00B2.  An offset shifts the support to ' +
          'x \u2265 offset.',
  },
  invgamma: {
    label: 'Inverse gamma',
    text: 'Inverse-gamma prior.  Convention: BEAST X stores shape \u03B1 ' +
          'and scale \u03B2; mean = \u03B2 / (\u03B1 \u2212 1) for \u03B1 > 1.',
  },
  normal: {
    label: 'Normal',
    text: 'Symmetric bell on the whole real line.  Heavier tails than Laplace ' +
          'but lighter than Cauchy; defaults to mean=0, stdev=1 as a hyperprior.',
  },
  laplace: {
    label: 'Laplace',
    text: 'Sharp peak at \u03BC with exponential tails.  Sometimes preferred ' +
          'over Normal when occasional outliers are expected \u2014 the L1 norm.',
  },
  uniform: {
    label: 'Uniform',
    text: 'Flat density on [lower, upper].  Use only when every value in ' +
          'the interval is genuinely equally likely.',
  },
  beta: {
    label: 'Beta',
    text: 'Density on [0, 1].  shape1 = \u03B1, shape2 = \u03B2.  ' +
          '\u03B1 = \u03B2 = 1 is uniform; \u03B1, \u03B2 > 1 puts mass ' +
          'in the middle; one of them < 1 puts mass at one endpoint.  An ' +
          'offset+scale shifts the support to [offset, offset+scale].',
  },
  cauchy: {
    label: 'Cauchy',
    text: 'Heavy-tailed location family.  Median equals \u03BC; mean and ' +
          'variance are undefined.  Use sparingly as a hyperprior.',
  },
  poisson: {
    label: 'Poisson',
    text: 'Discrete count distribution on non-negative integers, mean = \u03BB.',
  },
  oneOnX: {
    label: '1 / x  (improper)',
    text: 'Jeffreys-style scale prior p(x) \u221D 1/x.  Improper \u2014 needs ' +
          'a bounded parameter to make the posterior proper.',
  },
  ctmcScale: {
    label: 'ctmcScale (BEAST coupling)',
    text: 'Couples the clock rate to the tree height so the posterior is ' +
          'invariant to rate \u00D7 time rescalings.  Added by BEAST X ' +
          'automatically; the user does not pick a shape for this one.',
  },
};

/* -------------------------------------------------------------- PDF plotting */

/* Probability density functions.  We work in real space (not log-space) for
 * the log-normal so that the curve's area is 1. */
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const lnpdf = (x, mu, sigma) =>
  x <= 0 ? 0 :
  Math.exp(-Math.log(x) - Math.log(sigma) - 0.5 * Math.log(2 * Math.PI)
           - Math.pow(Math.log(x) - mu, 2) / (2 * sigma * sigma)) / x;
const exppdf = (x, mean) => x < 0 ? 0 : Math.exp(-x / mean) / mean;
const gammapdf = (x, k, theta) => x <= 0 ? 0 :
  Math.exp((k - 1) * Math.log(x) - x / theta - lgamma(k) - k * Math.log(theta));
const normalpdf = (x, mu, sigma) =>
  Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma)) / (sigma * SQRT_2PI);
const laplacepdf = (x, mu, b) => Math.exp(-Math.abs(x - mu) / b) / (2 * b);
const betapdf = (x, a, b) => x <= 0 || x >= 1 ? 0 :
  Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x)
           - lgamma(a) - lgamma(b) + lgamma(a + b));

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (let j = 0; j < 6; j++) s += c[j] / ++y;
  return Math.log(2.5066282746310005 * s / x) - t;
}

function linspace(a, b, n) {
  const out = new Array(n);
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  return out;
}
function logspace(a, b, n) {
  const la = Math.log(a), lb = Math.log(b);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.exp(la + (lb - la) * i / (n - 1));
  return out;
}

const num = v => (v === '' || v == null) ? NaN : Number(v);

/* Returns { xs, ys, logScale, xLabel, offsetPos } for a prior.
 *
 * `offsetPos` is the (x, y) position of the offset marker in plot units
 * — null if the prior has no offset.  We always return the offset even
 * when offset === 0 because the user might edit it; the marker just sits
 * at the left edge of the support in that case.
 *
 * The x-axis uses log scale whenever the support spans more than a
 * factor of 5 (so logNormal / exponential / gamma don't get crushed by
 * their right tail), otherwise linear. */
function samplePrior(p, N = 200) {
  const mu    = num(p.mean);
  const sigma = num(p.stdev);
  const shape = num(p.shape) || num(p.shape1);
  const scale = num(p.scale) || num(p.stdev) || num(p.shape2);
  const lo    = num(p.lower);
  const hi    = num(p.upper);
  const offset = Number(p.offset || 0);
  let xs, ys, xLabel = 'x', logScale = false;
  let offsetAt = null;

  if (p.kind === 'logNormal') {
    /* BEAST X's logNormalPrior uses two conventions for `mean` and `stdev`,
     * selected by `meanInRealSpace`.  When false (the BEAST default),
     * mean and stdev are the mu and sigma of ln X.  When true, they are
     * the real-space mean and SD of X, which we convert to log-space
     * parameters.  An `offset` shifts the support right by `offset`, so
     * the density is lnpdf(x - offset, m, s) for x >= offset. */
    let m, s;
    if (p.meanInRealSpace === 'true' && isFinite(mu) && mu > 0 && isFinite(sigma) && sigma > 0) {
      const v = sigma * sigma;
      m = Math.log(mu * mu / Math.sqrt(mu * mu + v));
      s = Math.sqrt(Math.log(1 + v / (mu * mu)));
    } else {
      m = isFinite(mu) ? mu : 0;
      s = (isFinite(sigma) && sigma > 0) ? sigma : 1;
    }
    const loEff = Math.max(offset, 0);
    const xMin = Math.max(1e-9, loEff + Math.exp(m - 4 * s));
    const xMax = loEff + Math.exp(m + 5 * s);
    xs = logspace(xMin, xMax, N);
    ys = xs.map(x => lnpdf(x - loEff, m, s));
    logScale = (xMax / xMin) > 5;
    xLabel = 'x';
    offsetAt = offset > 0 ? offset : null;
  } else if (p.kind === 'exponential') {
    const m = isFinite(mu) && mu > 0 ? mu : 1;
    const loEff = Math.max(offset, 0);
    /* For an offset exponential, x ranges from offset to offset+12*mean. */
    const xMin = Math.max(1e-9, loEff);
    const xMax = loEff + m * 12;
    xs = linspace(xMin, xMax, N);
    ys = xs.map(x => exppdf(x - loEff, m));
    logScale = xMax / Math.max(xMin, 1e-9) > 5;
    xLabel = 'x';
    offsetAt = loEff;
  } else if (p.kind === 'gamma') {
    /* BEAST X uses `shape` (alpha) and `scale` (theta); fall back to the
     * generic shape1/shape2 spellings for callers that prefer them.  An
     * `offset` shifts the support right by `offset`, so the density is
     * gammapdf(x - offset, k, th) for x >= offset. */
    const k  = (isFinite(shape) && shape > 0) ? shape
              : (isFinite(mu) && mu > 0) ? mu : 1;
    const th = (isFinite(scale) && scale > 0) ? scale
              : (isFinite(sigma) && sigma > 0) ? sigma : 1;
    const lo = isFinite(offset) ? offset : 0;
    const xMax = Math.max(lo + 0.5, lo + k * th * 10);
    xs = linspace(Math.max(1e-5, lo), xMax, N);
    ys = xs.map(x => gammapdf(x - lo, k, th));
    logScale = k < 1 || xMax / Math.max(lo, 1e-5) > 5;
    xLabel = 'x';
    offsetAt = lo;
  } else if (p.kind === 'normal') {
    const m = isFinite(mu) ? mu : 0;
    const s = (isFinite(sigma) && sigma > 0) ? sigma : 1;
    const xMin = m - 4 * s, xMax = m + 4 * s;
    xs = linspace(xMin, xMax, N);
    ys = xs.map(x => normalpdf(x, m, s));
    logScale = false;
    xLabel = 'x';
    offsetAt = isFinite(offset) ? offset : null;
  } else if (p.kind === 'laplace') {
    const m = isFinite(mu) ? mu : 0;
    const b = (isFinite(sigma) && sigma > 0) ? sigma : 1;
    const xMin = m - 6 * b, xMax = m + 6 * b;
    xs = linspace(xMin, xMax, N);
    ys = xs.map(x => laplacepdf(x, m, b));
    logScale = false;
    xLabel = 'x';
    offsetAt = isFinite(offset) ? offset : null;
  } else if (p.kind === 'uniform') {
    const a = isFinite(lo) ? lo : 0;
    const b = isFinite(hi) ? hi : Math.max(a + 1, 1);
    xs = linspace(a, b, N);
    ys = xs.map(() => 1 / Math.max(b - a, 1e-9));
    logScale = false;
    xLabel = 'x';
  } else if (p.kind === 'beta') {
    /* BEAST X's beta prior uses shape1, shape2, plus an optional offset
     * and scale that map [0, 1] -> [offset, offset+scale]. */
    const a = isFinite(shape) && shape > 0 ? shape : 1;
    const b = isFinite(scale) && scale > 0 ? scale : 1;
    const off = isFinite(offset) ? offset : 0;
    const sc  = isFinite(p.scale) ? Number(p.scale) : 1;
    const loEff = off, hiEff = off + sc;
    xs = linspace(loEff + 1e-4 * sc, hiEff - 1e-4 * sc, N);
    ys = xs.map(x => betapdf((x - loEff) / sc, a, b) / sc);
    logScale = false;
    xLabel = 'x';
    offsetAt = off;
  } else if (p.kind === 'oneOnX') {
    const xMin = 0.01, xMax = 10;
    xs = logspace(xMin, xMax, N);
    ys = xs.map(x => 1 / x);
    logScale = true;
    xLabel = 'x  (improper)';
  } else if (p.kind === 'ctmcScale') {
    /* ctmcScale has no plotted density \u2014 the prior is whatever the prior on
     * the tree height is, mediated through the clock.rate.  Render a marker
     * placeholder. */
    xs = [0, 1]; ys = [1, 1];
    xLabel = '(no fixed shape)';
  } else {
    return null;
  }
  return { xs, ys, logScale, xLabel, offsetAt };
}

/* Render the density as an inline SVG string. */
export function priorPdfSvg(p, opts = {}) {
  const compact = !!opts.compact;
  const sample = samplePrior(p, compact ? 80 : 240);
  if (!sample) return '';
  const { xs, ys, logScale, xLabel, offsetAt } = sample;
  const N = xs.length;

  /* Display dimensions: render at the prior dock content width (360 px
   * dock width minus 12 px padding on each side minus 2 px border) so
   * the SVG renders at native size and tick labels stay readable.
   * Override via opts.width to fit other layouts. */
  const W = compact ? 120 : (opts.width || 336);
  /* Vertical layout: top margin (Mt), curve area, x-axis line, tick
   * labels (~14 px below the line), gap, axis title, bottom margin.
   * The total height is the curve area plus ~50 px of axis stack so
   * the title does not collide with the tick labels. */
  const H = compact ? 36 : Math.round(W * 0.62);
  /* Left margin is wider than the right/top/bottom to give the
   * rotated y-axis title ("density") its own lane, separated from
   * the y-tick labels. */
  const M = compact ? 4 : 22;
  const Ml = compact ? 4 : 36;
  const Mr = M, Mt = M;
  /* Reserve enough bottom space for: tick labels (14 px), a 6-px gap,
   * and the axis title (12 px ascent + 3 px descender) plus a 2-px
   * safety margin. */
  const Mb = 22 + 14 + 6 + 12 + 3 + 2;
  /* Vertical layout constants for the x-axis stack: x-axis line at
   * y = H - Mb, tick labels sit just below, axis title sits below the
   * tick labels with a clear gap so the two don't collide. */
  const tickBaselineDy = 14;     /* distance from axis line to tick label baseline */
  const titleBaselineDy = Mb + 4; /* axis title baseline from bottom */
  /* Tick and label font sizes scale with the SVG width so that the
   * final on-screen text is roughly the same size regardless of how
   * the SVG is laid out. */
  const tickFs = compact ? 8 : 11;
  const axisFs = compact ? 8 : 12;
  const offsetFs = compact ? 7 : 10;

  let xsPlot;
  if (logScale) {
    const lx = xs.map(x => Math.log(Math.max(x, 1e-12)));
    const lxMin = lx[0], lxMax = lx[N - 1];
    xsPlot = lx.map(v => Ml + (v - lxMin) / (lxMax - lxMin || 1e-9) * (W - Ml - Mr));
  } else {
    const xMin = xs[0], xMax = xs[N - 1];
    xsPlot = xs.map(x => Ml + (x - xMin) / (xMax - xMin || 1e-9) * (W - Ml - Mr));
  }
  const ymax = Math.max(...ys, 1e-12);
  const sy = y => H - Mb - (y / ymax) * (H - Mt - Mb);

  let d = '';
  for (let i = 0; i < N; i++) {
    d += (i ? 'L' : 'M') + xsPlot[i].toFixed(2) + ',' + sy(ys[i]).toFixed(2) + ' ';
  }

  if (compact) {
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="prior-pdf">
      <line x1="${Ml}" y1="${H - Mb}" x2="${W - Mr}" y2="${H - Mb}"
            stroke="currentColor" stroke-opacity="0.25" stroke-width="0.5"/>
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  }

  /* Full plot: ticks, axis labels, the curve, and the offset marker. */
  const ticks = 5;
  const xTickVals = logScale
    ? Array.from({ length: ticks + 1 }, (_, i) => {
        const lxMin = Math.log(Math.max(xs[0], 1e-12));
        const lxMax = Math.log(Math.max(xs[N - 1], 1e-12));
        return Math.exp(lxMin + (i / ticks) * (lxMax - lxMin));
      })
    : Array.from({ length: ticks + 1 }, (_, i) =>
        xs[0] + (i / ticks) * (xs[N - 1] - xs[0]));
  const yTickVals = Array.from({ length: ticks + 1 }, (_, i) => (i / ticks) * ymax);

  const fmt = v => {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e4 || a < 1e-3) return v.toExponential(1);
    return String(Number(v.toPrecision(3)));
  };

  let xTickMarks = '';
  for (let i = 0; i < xTickVals.length; i++) {
    const v = xTickVals[i];
    const px = logScale
      ? Ml + (Math.log(Math.max(v, 1e-12)) - Math.log(Math.max(xs[0], 1e-12))) /
              (Math.log(Math.max(xs[N - 1], 1e-12)) - Math.log(Math.max(xs[0], 1e-12)) || 1e-9) * (W - Ml - Mr)
      : Ml + (v - xs[0]) / (xs[N - 1] - xs[0] || 1e-9) * (W - Ml - Mr);
    const x = px.toFixed(2);
    xTickMarks +=
      `<line x1="${x}" y1="${H - Mb}" x2="${x}" y2="${H - Mb + 4}" stroke="currentColor"/>` +
      `<text x="${x}" y="${H - Mb + 13}" text-anchor="middle" font-size="${tickFs}" ` +
      `fill="currentColor" opacity="0.7">${fmt(v)}</text>`;
  }
  let yTickMarks = '';
  for (let i = 0; i < yTickVals.length; i++) {
    const v = yTickVals[i];
    const y = sy(v).toFixed(2);
    yTickMarks +=
      `<line x1="${Ml - 4}" y1="${y}" x2="${Ml}" y2="${y}" stroke="currentColor"/>` +
      `<text x="${Ml - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" ` +
      `font-size="${tickFs}" fill="currentColor" opacity="0.7">${fmt(v)}</text>`;
  }

  /* Offset marker.  Draws a dashed vertical line at the offset x position
   * and a small label "offset" near the top, so the user can see what
   * the offset field does to the plot.  Skipped for ctmcScale / oneOnX. */
  let offsetMark = '';
  if (offsetAt !== null && offsetAt !== undefined &&
      isFinite(offsetAt) && p.kind !== 'ctmcScale' && p.kind !== 'oneOnX') {
    const xMinR = xs[0], xMaxR = xs[N - 1];
    const inRange = offsetAt >= xMinR && offsetAt <= xMaxR;
    if (inRange) {
      const px = logScale
        ? Ml + (Math.log(Math.max(offsetAt, 1e-12)) - Math.log(Math.max(xMinR, 1e-12))) /
                (Math.log(Math.max(xMaxR, 1e-12)) - Math.log(Math.max(xMinR, 1e-12)) || 1e-9) * (W - Ml - Mr)
        : Ml + (offsetAt - xMinR) / (xMaxR - xMinR || 1e-9) * (W - Ml - Mr);
      const x = px.toFixed(2);
      offsetMark =
        `<line x1="${x}" y1="${Mt}" x2="${x}" y2="${H - Mb}"
              stroke="currentColor" stroke-opacity="0.4" stroke-dasharray="3 3" stroke-width="1"/>` +
        `<text x="${x}" y="${Mt - 4}" text-anchor="middle" font-size="${offsetFs}"
              fill="currentColor" opacity="0.7">offset = ${fmt(offsetAt)}</text>`;
    }
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="prior-pdf-full">
    <line x1="${Ml}" y1="${Mt}" x2="${Ml}" y2="${H - Mb}" stroke="currentColor" stroke-width="1"/>
    <line x1="${Ml}" y1="${H - Mb}" x2="${W - Mr}" y2="${H - Mb}" stroke="currentColor" stroke-width="1"/>
    ${xTickMarks}
    ${yTickMarks}
    ${offsetMark}
    <text x="${(Ml + W - Mr) / 2}" y="${H - 4}" text-anchor="middle" font-size="${axisFs}"
          fill="currentColor" opacity="0.85">${xLabel}${logScale ? '  (log scale)' : ''}</text>
    <text x="${axisFs / 2 + 1}" y="${(Mt + H - Mb) / 2}" text-anchor="middle" font-size="${axisFs}"
          fill="currentColor" opacity="0.85"
          transform="rotate(-90 ${axisFs / 2 + 1} ${(Mt + H - Mb) / 2})">density</text>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

/* ------------------------------------------------------ XML editing helpers */

/* Two equivalent editing strategies:
 *
 *  1. **Regex editing on the original text.**  When the user edits a value
 *     on a row, we know the tag, the index of the matching element, and
 *     the attribute name.  We locate the matching opening tag and rewrite
 *     its attribute in place.  This keeps the original XML formatting
 *     (indentation, comments, element ordering) intact, which matters
 *     because the source view still has to look right.
 *
 *  2. **DOM editing on a parsed document.**  Fallback for edits that need
 *     to add/remove attributes; used by setAttr.
 *
 * Both paths produce the same XML text.  Regex editing is preferred because
 * it preserves everything the user did not touch. */

function buildElementIndex(text) {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(!\w[\s\S]*?|[A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  const out = [];
  let depth = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    if (full.startsWith('<!--') || full.startsWith('<?')) continue;
    const tag = m[1];
    const attrStr = m[2];
    const selfClose = m[3] === '/';
    const start = m.index;
    const end = m.index + full.length;
    const attrs = parseAttrs(attrStr);
    const isClose = tag.startsWith('/');
    const tagName = isClose ? tag.slice(1) : tag;
    out.push({
      tag: tagName, attrs, start, end, depth, isClose, selfClose,
    });
    if (isClose) depth--;
    else if (!selfClose) depth++;
  }
  return out;
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  return out;
}

function serializeAttrs(attrs) {
  const keys = Object.keys(attrs);
  return keys.map(k => `${k}="${(attrs[k] || '').replace(/"/g, '&quot;')}"`).join(' ');
}

function findElementByTagAndRef(text, tagName, targetId, i) {
  const idx = buildElementIndex(text);
  let n = 0;
  for (const e of idx) {
    if (e.isClose) continue;
    if (e.tag !== tagName) continue;
    if (targetId !== null && !elementReferencesId(e, text, targetId)) continue;
    if (n === i) return { ...e, idx };
    n++;
  }
  return null;
}

/* Convert a byte offset into a 1-based line number.  Used to jump
 * from a MCMC sidebar row to the source view at the matching XML
 * line.  Returns null if the offset is past the end of the text. */
function offsetToLine(text, offset) {
  if (offset < 0) return null;
  let line = 1, col = 0;
  for (let i = 0; i < text.length && i <= offset; i++) {
    if (text[i] === '\n') { line++; col = 0; }
    else col++;
    if (i === offset) return line;
  }
  return line;
}

/* Find the line number of the i-th element of `tagName` whose body
 * includes an idref to `targetId`.  Returns null if no such element
 * exists.  Used to jump from the MCMC sidebar to the source view. */
export function findElementLine(text, tagName, targetId, i) {
  const found = findElementByTagAndRef(text, tagName, targetId, i);
  return found ? offsetToLine(text, found.start) : null;
}

function elementReferencesId(elEntry, text, targetId) {
  const bodyStart = elEntry.end;
  const closeRe = new RegExp(`</\\s*${elEntry.tag}\\s*>`, 'g');
  closeRe.lastIndex = bodyStart;
  const closeMatch = closeRe.exec(text);
  const bodyEnd = closeMatch ? closeMatch.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);
  const re = /idref\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const v = m[2] !== undefined ? m[2] : m[3];
    if (v === targetId) return true;
  }
  return false;
}

export function setAttrOnElement(text, tagName, targetId, i, attrName, attrValue) {
  const found = findElementByTagAndRef(text, tagName, targetId, i);
  if (!found) return null;
  const tagSrc = text.slice(found.start, found.end);
  const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(tagSrc);
  let newTag;
  if (m) {
    if (attrValue === null || attrValue === undefined || attrValue === '') {
      let start = m.index, end = m.index + m[0].length;
      const before = start > 0 && /\s/.test(tagSrc[start - 1]);
      const after  = end < tagSrc.length && /\s/.test(tagSrc[end]);
      if (before && after) {
        end++;
      } else if (after) {
        end++;
      } else if (before) {
        start--;
      }
      newTag = tagSrc.slice(0, start) + tagSrc.slice(end);
    } else {
      newTag = tagSrc.slice(0, m.index) +
        `${attrName}="${String(attrValue).replace(/"/g, '&quot;')}"` +
        tagSrc.slice(m.index + m[0].length);
    }
  } else {
    if (attrValue === null || attrValue === undefined || attrValue === '') return text;
    const insertRe = /(\s*\/?>)$/;
    const insertMatch = insertRe.exec(tagSrc);
    if (!insertMatch) return null;
    const before = tagSrc.slice(0, insertMatch.index);
    const tail = insertMatch[0];
    const sep = before.endsWith(' ') || before.length === 0 ? '' : ' ';
    newTag = before + sep + `${attrName}="${String(attrValue).replace(/"/g, '&quot;')}"` + tail;
  }
  return text.slice(0, found.start) + newTag + text.slice(found.end);
}

export function setAttrOnAll(text, tagName, attrName, attrValue) {
  const re = new RegExp(`(<\s*${tagName}\\b)([^>]*?)(/?>)`, 'g');
  return text.replace(re, (full, head, body, tail) => {
    const attrs = parseAttrs(body);
    if (attrValue === null || attrValue === undefined || attrValue === '') {
      delete attrs[attrName];
    } else {
      attrs[attrName] = String(attrValue);
    }
    return head + (Object.keys(attrs).length ? ' ' + serializeAttrs(attrs) : '') + tail;
  });
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(err.textContent);
  return doc;
}

export function serializeXml(doc) {
  return new XMLSerializer().serializeToString(doc);
}

/* DOM-based helpers retained for callers that prefer a parsed document. */
export function findPrior(doc, distName, targetId, i) {
  const all = [...doc.getElementsByTagName(distName)];
  let n = 0;
  for (const el of all) {
    if (elementReferences(doc, el, targetId)) {
      if (n === i) return el;
      n++;
    }
  }
  return null;
}
export function findOperator(doc, tagName, targetId, i) {
  const all = [...doc.getElementsByTagName(tagName)];
  let n = 0;
  for (const el of all) {
    if (elementReferences(doc, el, targetId)) {
      if (n === i) return el;
      n++;
    }
  }
  return null;
}
function elementReferences(doc, el, targetId) {
  for (const d of el.getElementsByTagName('*')) {
    if (d.getAttribute('idref') === targetId) return true;
  }
  return false;
}

export function readPriorAttrsFromDoc(doc, distName, targetId, i) {
  const el = findPrior(doc, distName, targetId, i);
  if (!el) return null;
  const out = { kind: distName.replace(/Prior$/, '') };
  for (const a of el.attributes) {
    if (a.name === 'idref') continue;
    out[a.name] = a.value;
  }
  return out;
}

export function applyPriorEdit(text, distName, targetId, index, key, value) {
  return setAttrOnElement(text, distName, targetId, index, key, value);
}
export function applyOperatorEdit(text, tagName, targetId, index, key, value) {
  return setAttrOnElement(text, tagName, targetId, index, key, value);
}
export function applyMcmcEdit(text, key, value) {
  return setAttrOnElement(text, 'mcmc', null, 0, key, value);
}
export function applyLogEdit(text, kind, key, value) {
  return setAttrOnAll(text, kind, key, value);
}

/* --------------------------------------------------------- prior collection */

/* Build a list of priors exposed by the model.  Each entry is the
 * minimal info needed by PriorDock and McmcEditor: {key, dist,
 * targetId, attrs, index, label}.  The (targetId, dist) pair is the
 * natural key; we number occurrences of the same pair so setAttr
 * can find the i-th element of that kind. */
function collectPriors(model) {
  const out = [];
  const seen = new Map();
  for (const node of model.nodes) {
    for (const p of node.priors || []) {
      const k = p.dist + ':' + node.id;
      const i = seen.get(k) || 0;
      seen.set(k, i + 1);
      out.push({
        key: `pri-${node.id}-${p.dist}-${i}`,
        dist: p.dist,
        targetId: node.id,
        attrs: p.attrs,
        index: i,
        label: p.label || node.id,
      });
    }
  }
  return out;
}

function findPriorByKey(model, key) {
  for (const p of collectPriors(model)) {
    if (p.key === key) return p;
  }
  return null;
}

/* Find a prior entry by its target node id and the prior's dist tag.
 * Returns the first match; mostly used to look up priors when the
 * user clicks a parameter or hyperparameter node in the diagram. */
function findPriorByTarget(model, targetId) {
  const priors = collectPriors(model);
  return priors.filter(p => p.targetId === targetId);
}

function collectOperators(model) {
  const out = [];
  /* Count i-th occurrence of each (tag, target) pair so the McmcEditor
   * can pass the right index to setAttrOnElement / findElementLine. */
  const seen = new Map();
  for (const n of model.nodes) {
    for (const o of n.operators || []) {
      const k = o.tag + ':' + n.id;
      const i = seen.get(k) || 0;
      seen.set(k, i + 1);
      out.push({
        tag: o.tag,
        targetId: n.id,
        attrs: o.attrs,
        index: i,
        label: n.id,
      });
    }
  }
  /* Index each operator by its (tag, target, index) tuple so the
   * McmcEditor can look it up when wiring a click-to-jump. */
  return out;
}

function readMcmcAttrs(doc) {
  const mcmc = doc.querySelector('mcmc');
  if (!mcmc) return [];
  const out = [];
  for (const a of mcmc.attributes) out.push([a.name, a.value]);
  return out;
}
function readLogAttrs(doc) {
  const out = [];
  for (const tag of ['log', 'logTree']) {
    for (const el of doc.getElementsByTagName(tag)) {
      const row = { kind: tag };
      for (const a of el.attributes) row[a.name] = a.value;
      out.push(row);
    }
  }
  return out;
}

/* ------------------------------------------------------- shared form helpers */

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Escape a string for use as a CSS attribute-selector value. */
const cssEscape = (s) => {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
};

function attrInputs(spec, values, ns) {
  return spec.map(({ key, label, type }) => {
    const v = values[key] != null ? values[key] : '';
    const safe = esc(String(v));
    if (type === 'select') {
      const opt = spec.find(s => s.key === key);
      return `<label>${label}</label>
        <select data-${ns}="" data-key="${key}">
          ${opt.options.map(o =>
            `<option value="${esc(o)}" ${String(v) === o ? 'selected' : ''}>${esc(o)}</option>`
          ).join('')}
        </select>`;
    }
    return `<label>${label}</label>
      <input type="${type === 'number' ? 'number' : 'text'}" data-${ns}="" data-key="${key}" value="${safe}">`;
  }).join('');
}

function priorFields(kind) {
  switch (kind) {
    case 'logNormal':
      return [
        { key: 'mean', label: 'mean (\u03BC of log)', type: 'text' },
        { key: 'stdev', label: 'stdev (\u03C3 of log)', type: 'text' },
        { key: 'offset', label: 'offset (shifts support right)', type: 'text' },
        { key: 'meanInRealSpace', label: 'meanInRealSpace', type: 'select',
          options: ['false', 'true'] },
      ];
    case 'exponential':
      return [
        { key: 'mean', label: 'mean', type: 'text' },
        { key: 'offset', label: 'offset (shifts support right)', type: 'text' },
      ];
    case 'gamma':
      return [
        { key: 'shape', label: 'shape (\u03B1)', type: 'text' },
        { key: 'scale', label: 'scale (\u03B8)', type: 'text' },
        { key: 'offset', label: 'offset (shifts support right)', type: 'text' },
      ];
    case 'normal':
      return [
        { key: 'mean', label: 'mean', type: 'text' },
        { key: 'stdev', label: 'stdev', type: 'text' },
        { key: 'offset', label: 'offset (shifts support)', type: 'text' },
      ];
    case 'laplace':
      return [
        { key: 'mean', label: 'mean', type: 'text' },
        { key: 'scale', label: 'scale', type: 'text' },
        { key: 'offset', label: 'offset (shifts support)', type: 'text' },
      ];
    case 'uniform':
      return [
        { key: 'lower', label: 'lower', type: 'text' },
        { key: 'upper', label: 'upper', type: 'text' },
      ];
    case 'beta':
      return [
        { key: 'shape1', label: 'shape1 (\u03B1)', type: 'text' },
        { key: 'shape2', label: 'shape2 (\u03B2)', type: 'text' },
        { key: 'offset', label: 'offset (start of support)', type: 'text' },
        { key: 'scale', label: 'scale (length of support)', type: 'text' },
      ];
    case 'oneOnX':
      return [];
    default:
      return [];
  }
}

function operatorFields() {
  return [
    { key: 'weight', label: 'weight', type: 'number' },
    { key: 'scaleFactor', label: 'scaleFactor', type: 'number' },
    { key: 'size', label: 'size', type: 'text' },
    { key: 'windowSize', label: 'windowSize', type: 'text' },
    { key: 'delta', label: 'delta', type: 'text' },
    { key: 'gaussian', label: 'gaussian', type: 'select', options: ['true', 'false'] },
    { key: 'autoOptimize', label: 'autoOptimize', type: 'select', options: ['true', 'false'] },
    { key: 'type', label: 'type (nodeHeightOperator)', type: 'text' },
    { key: 'boundaryCondition', label: 'boundaryCondition', type: 'text' },
  ];
}

/* ----------------------------------------------------- PriorDock (right panel) */

/* The right-docked prior editor.  Renders a single prior at a time: a
 * live density preview on the left, the editable attribute form on the
 * right.  Both halves share one vertical scroll container so they
 * never separate. */
export class PriorDock {
  constructor(rootEl, opts = {}) {
    this.root = rootEl;
    this.body = rootEl.querySelector('.prior-dock-body');
    this.closeBtn = rootEl.querySelector('.prior-dock-close');
    this.title = rootEl.querySelector('.prior-dock-title');
    this.onApply = opts.onApply || (() => {});
    this.onEditError = opts.onEditError || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.model = null;
    this.xmlText = null;
    this.doc = null;
    this.prior = null;
    this.pendingInputs = {};
    this.closeBtn.onclick = () => this.close();
  }

  open(model, xmlText, prior) {
    this.model = model;
    this.xmlText = xmlText;
    this.doc = parseXml(xmlText);
    this.prior = prior;
    this.pendingInputs = {};
    this.root.hidden = false;
    this.title.textContent = `Prior: ${prior.dist.replace(/Prior$/, '')}`;
    this.render();
  }

  /* Update the model and XML text from the outside (e.g. after the
   * MCMC editor commits an operator change).  We do not re-render the
   * dock here: a full re-render would steal focus from the input the
   * user is typing in.  The dock keeps its current prior and form
   * values, and subsequent commits will read the fresh model. */
  sync(model, xmlText) {
    this.model = model;
    this.xmlText = xmlText;
    try {
      this.doc = parseXml(xmlText);
    } catch { /* leave stale doc; the next commit will surface the error */ }
  }

  close() {
    this.root.hidden = true;
    this.prior = null;
    this.pendingInputs = {};
    this.onClose();
  }

  render() {
    if (!this.body) return;
    const p = this.prior;
    if (!p) return;
    const distKind = p.dist.replace(/Prior$/, '');
    const info = PRIOR_INFO[distKind] || { label: distKind, text: '' };
    const isCtmc = distKind === 'ctmcScale';
    const spec = isCtmc ? [] : priorFields(distKind);

    /* Header.  The dist name, the target parameter id, and a small
     * link to swap to the next prior on the same target. */
    const siblings = findPriorByTarget(this.model, p.targetId);
    const idx = siblings.findIndex(s => s.key === p.key);
    const hasPrev = idx > 0;
    const hasNext = idx >= 0 && idx < siblings.length - 1;

    this.body.innerHTML = `
      <div class="pd-head">
        <div class="pd-head-row">
          <strong>${esc(info.label)}</strong>
          <code class="pd-target">${esc(p.targetId)}</code>
        </div>
        <div class="pd-head-row pd-siblings">
          <button class="pd-sib" data-dir="-1" ${hasPrev ? '' : 'disabled'}>&larr; previous prior</button>
          <span class="pd-sib-count">${idx + 1} / ${siblings.length}</span>
          <button class="pd-sib" data-dir="1" ${hasNext ? '' : 'disabled'}>next prior &rarr;</button>
        </div>
        <p class="pd-info">${esc(info.text || '')}</p>
      </div>
      <div class="pd-stack">
        <div class="pd-preview">
          <div class="pd-preview-plot" id="pd-plot"></div>
        </div>
        <div class="pd-form">
          ${spec.length ? attrInputs(spec, p.attrs, 'pd') :
            '<div class="hint">No editable parameters on this prior.</div>'}
        </div>
      </div>`;

    this.body.querySelectorAll('.pd-sib').forEach(b => {
      b.onclick = () => {
        const dir = +b.dataset.dir;
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= siblings.length) return;
        this.pendingInputs = {};
        this.prior = siblings[newIdx];
        this.render();
      };
    });

    this.refreshPlot();
    this.wireForm();
  }

  refreshPlot() {
    const plot = this.body.querySelector('#pd-plot');
    if (!plot || !this.prior) return;
    const p = this.prior;
    const kind = p.dist.replace(/Prior$/, '');
    const base = readPriorAttrsFromDoc(this.doc, p.dist, p.targetId, p.index);
    const pending = this.pendingInputs || {};
    const vals = Object.assign({ kind }, base || {}, pending);
    plot.innerHTML = priorPdfSvg(vals);
  }

  wireForm() {
    const inputs = this.body.querySelectorAll('[data-pd]');
    const p = this.prior;
    inputs.forEach(inp => {
      const commit = () => {
        const result = this.commit(xml =>
          applyPriorEdit(xml, p.dist, p.targetId, p.index, inp.dataset.key, inp.value));
        if (result === null && inp.value !== '') {
          this.onEditError(
            `${p.dist} on ${p.targetId}: attribute "${inp.dataset.key}" was not applied`);
        }
        if (this.pendingInputs[inp.dataset.key]) {
          delete this.pendingInputs[inp.dataset.key];
        }
        /* Refresh the plot now that the in-progress value is committed
         * and pending state is cleared.  The plot is built from base
         * attrs (now from the freshly parsed XML) plus any remaining
         * pending inputs. */
        this.refreshPlot();
      };
      let timer = null;
      inp.addEventListener('input', () => {
        this.pendingInputs[inp.dataset.key] = inp.value;
        this.refreshPlot();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; commit(); }, 600);
      });
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (timer) { clearTimeout(timer); timer = null; }
          commit();
          inp.blur();
        }
      });
    });
  }

  commit(mutator) {
    const next = mutator(this.xmlText);
    if (next == null) return null;
    this.xmlText = next;
    try {
      this.doc = parseXml(next);
    } catch (e) {
      this.onApply(next, e, /*stayOnDock=*/true);
      return null;
    }
    this.onApply(next, null, /*stayOnDock=*/true);
    return next;
  }
}

/* ---------------------------------------------------------- McmcEditor (tab) */

/* The Edit MCMC tab content.  Lists every operator and exposes the
 * <mcmc> / <log> / <logTree> rows for editing.  Priors are not
 * here \u2014 they live in the right-docked PriorDock and are
 * opened by clicking the corresponding prior or parameter node in
 * the diagram. */
export class McmcEditor {
  constructor(rootEl, opts = {}) {
    this.root = rootEl;
    this.onApply = opts.onApply || (() => {});
    this.onEditError = opts.onEditError || (() => {});
    /* onJumpToLine(line) is invoked when the user clicks an operator
     * row or a prior row in the sidebar.  The host (app.js) is
     * responsible for switching to the source tab and scrolling the
     * source view to that line. */
    this.onJumpToLine = opts.onJumpToLine || (() => {});
    this.model = null;
    this.xmlText = null;
    this.doc = null;
    this.selectedPrior = null;
    this.priorPreviewValues = {};
    /* The currently "active" row in the sidebar, used to draw the
     * orange highlight bar.  The bar is independent of source-line
     * highlighting; it just shows which row the user last clicked or
     * edited.  Format: "pri:<key>", "op:<rowIndex>", "mcmc", or
     * "log:<rowIndex>". */
    this.selectedRowKey = null;
  }

  open(model, xmlText) {
    this.model = model;
    this.xmlText = xmlText;
    this.doc = parseXml(xmlText);
    this.render();
  }

  /* Update the model and XML text from the outside.  We deliberately do
   * not re-render here: a full re-render would steal focus from the
   * input the user is typing in.  Subsequent commits will read the
   * fresh model when the user blurs or presses Enter, so the existing
   * form values stay correct as long as the user only edits attributes
   * that already exist on the rows we built. */
  sync(model, xmlText) {
    this.model = model;
    this.xmlText = xmlText;
    try {
      this.doc = parseXml(xmlText);
    } catch { /* leave stale doc; the next commit will surface the error */ }
  }

  render() {
    if (!this.root) return;
    const m = this.model;
    const priors = collectPriors(m);
    const operators = collectOperators(m);
    const mcmc = readMcmcAttrs(this.doc);
    const logs = readLogAttrs(this.doc);

    /* Keep the previously selected prior (if any) after a re-render;
     * fall back to the first prior that has editable form fields, so
     * the preview has something meaningful to show. */
    if (!priors.find(p => p.key === this.selectedPrior)) {
      const withFields = priors.find(p => priorFields(p.dist.replace(/Prior$/, '')).length);
      this.selectedPrior = withFields ? withFields.key :
                            (priors[0] ? priors[0].key : null);
    }

    this.root.innerHTML = `
      <div class="mcmc-pane-head">
        <h2>Edit MCMC</h2>
        <p class="mcmc-pane-sub">
          Edit priors, operators, and chain settings.  Click a row to
          jump to it in the source XML on the left.  Edits update the
          XML as you type.
        </p>
      </div>

      <div class="mcmc-prior-preview" id="mcmc-prior-preview"></div>

      <section>
        <h3>Priors <span class="me-count">${priors.length}</span></h3>
        ${priors.length ? '' :
          '<div class="hint">No priors declared.</div>'}
        ${priors.map(p => this.priorRow(p, p.key === this.selectedPrior)).join('')}
      </section>

      <section>
        <h3>Operators <span class="me-count">${operators.length}</span></h3>
        ${operators.length ? '' :
          '<div class="hint">No operators in this model.</div>'}
        ${operators.map((op, i) => this.operatorRow(op, i)).join('')}
      </section>

      <section>
        <h3>MCMC</h3>
        ${mcmc.length ? this.mcmcRow(mcmc) :
          '<div class="hint">No <code>&lt;mcmc&gt;</code> element found.</div>'}
      </section>

      <section>
        <h3>Log &amp; log tree <span class="me-count">${logs.length}</span></h3>
        ${logs.length ? logs.map((lg, i) => this.logRow(lg, i)).join('') :
          '<div class="hint">No <code>&lt;log&gt;</code> / <code>&lt;logTree&gt;</code> elements.</div>'}
      </section>`;

    this.refreshPriorPreview();
    this.wirePriorRows();
    this.wireOperatorRows();
    this.wireMcmcRows();
  }

  /* Render the prior preview at the top of the sidebar.  The preview
   * shows the currently selected prior's density curve, with the
   * field values layered on top of the parsed XML so the user can see
   * the curve update as they edit. */
  refreshPriorPreview() {
    const preview = this.root.querySelector('#mcmc-prior-preview');
    if (!preview) return;
    const p = this.findPrior(this.selectedPrior);
    if (!p) { preview.innerHTML = ''; return; }
    const kind = p.dist.replace(/Prior$/, '');
    const base = readPriorAttrsFromDoc(this.doc, p.dist, p.targetId, p.index);
    const pending = this.priorPreviewValues[p.key] || {};
    const vals = Object.assign({ kind }, base || {}, pending);
    const info = PRIOR_INFO[kind] || { label: kind, text: '' };
    preview.innerHTML = `
      <div class="mpp-head">
        <strong>${esc(info.label)}</strong>
        <code>${esc(p.targetId)}</code>
      </div>
      <div class="mpp-plot">${priorPdfSvg(vals)}</div>
      <p class="mpp-info">${esc(info.text || '')}</p>`;
  }

  findPrior(key) {
    if (!this.model || !key) return null;
    return findPriorByKey(this.model, key);
  }

  selectPrior(key) {
    if (this.selectedPrior === key) return;
    this.selectedPrior = key;
    this.selectRow('pri:' + key);
    this.refreshPriorPreview();
  }

  /* Mark a row as the active sidebar row.  Clears the highlight on
   * all other rows and applies it to the matching one.  Used by
   * click handlers across priors, operators, mcmc, and logs. */
  selectRow(key) {
    if (!this.root) return;
    if (this.selectedRowKey === key) return;
    this.selectedRowKey = key;
    for (const row of this.root.querySelectorAll('.slot')) {
      row.classList.remove('selected');
    }
    if (!key) return;
    const sel = this.root.querySelector(`.slot[data-row-key="${cssEscape(key)}"]`);
    if (sel) sel.classList.add('selected');
  }

  operatorRow(op, i) {
    const spec = operatorFields();
    return `
      <div class="slot" data-op-row="${i}" data-tag="${esc(op.tag)}"
           data-target="${esc(op.targetId)}" data-row-key="op:${i}" tabindex="0"
           title="Click to jump to this operator in the source XML">
        <div class="slot-head">
          <strong>${esc(op.tag)}</strong>
          <code class="slot-target">${esc(op.targetId)}</code>
        </div>
        <div class="slot-form">
          ${attrInputs(spec, op.attrs, 'op')}
        </div>
      </div>`;
  }

  /* Render a single prior as a row.  The row is clickable to select
   * the prior (showing its preview at the top of the sidebar) and to
   * jump to its location in the source XML. */
  priorRow(p, isSelected) {
    const distKind = p.dist.replace(/Prior$/, '');
    const info = PRIOR_INFO[distKind] || { label: distKind, text: '' };
    const isCtmc = distKind === 'ctmcScale';
    const spec = isCtmc ? [] : priorFields(distKind);
    return `
      <div class="slot ${isSelected ? 'selected' : ''}"
           data-pri-row="0" data-pri-key="${esc(p.key)}"
           data-dist="${esc(p.dist)}" data-target="${esc(p.targetId)}"
           data-index="${p.index}" data-row-key="pri:${esc(p.key)}" tabindex="0"
           title="Click to select and jump to this prior in the source XML">
        <div class="slot-head">
          <strong>${esc(info.label)}</strong>
          <code class="slot-target">${esc(p.targetId)}</code>
        </div>
        <div class="slot-form">
          ${spec.length ? attrInputs(spec, p.attrs, 'pri') :
            '<div class="hint">No editable parameters.</div>'}
        </div>
      </div>`;
  }

  mcmcRow(attrs) {
    const obj = Object.fromEntries(attrs);
    const spec = [
      { key: 'chainLength', label: 'chainLength', type: 'number' },
      { key: 'autoOptimize', label: 'autoOptimize', type: 'select', options: ['true', 'false'] },
      { key: 'preBurnin', label: 'preBurnin', type: 'number' },
    ];
    return `<div class="slot" data-mcmc-row="" data-row-key="mcmc" tabindex="0"
       title="Click to jump to &lt;mcmc&gt; in the source XML">
      <div class="slot-head"><strong>&lt;mcmc&gt;</strong></div>
      <div class="slot-form">${attrInputs(spec, obj, 'mcmc')}</div>
    </div>`;
  }

  logRow(lg, i) {
    return `
      <div class="slot" data-log-row="${i}" data-kind="${esc(lg.kind)}"
           data-row-key="log:${i}" tabindex="0"
           title="Click to jump to this &lt;${esc(lg.kind)}&gt; in the source XML">
        <div class="slot-head"><strong>&lt;${esc(lg.kind)}&gt;</strong></div>
        <div class="slot-form">
          <label>logEvery</label>
          <input type="number" data-log="" data-key="logEvery"
                 value="${esc(lg.logEvery || '')}">
          ${lg.fileName ? `<label>fileName</label>
            <input type="text" data-log="" data-key="fileName"
                   value="${esc(lg.fileName)}">` : ''}
        </div>
      </div>`;
  }

  wireOperatorRows() {
    /* Pre-compute the (tag, target, i) triples for each operator in
     * the same order they appear in the sidebar, so row clicks can
     * look up the right i-th occurrence. */
    const operators = collectOperators(this.model);
    for (const row of this.root.querySelectorAll('[data-op-row]')) {
      const rowIndex = +row.dataset.opRow;
      const op = operators[rowIndex];
      if (!op) continue;
      const { tag, targetId, index: i } = op;
      row.querySelectorAll('[data-op]').forEach(inp => {
        inp.addEventListener('focus', () => this.selectRow('op:' + rowIndex));
        inp.addEventListener('change', () => {
          this.selectRow('op:' + rowIndex);
          this.commit(xml =>
            applyOperatorEdit(xml, tag, targetId, i, inp.dataset.key, inp.value));
        });
      });
      /* Click on the row header (not the form fields) jumps to the
       * operator's location in the source XML.  Clicks inside the
       * form fall through to the input. */
      const head = row.querySelector('.slot-head');
      if (head) {
        head.style.cursor = 'pointer';
        head.addEventListener('click', e => {
          if (e.target.closest('input, select, textarea, label')) return;
          this.selectRow('op:' + rowIndex);
          this.jumpToElement(tag, targetId, i);
        });
      }
    }
  }

  /* Wire prior rows.  Clicking the row head selects the prior and
   * jumps to its source location; typing in a form field updates the
   * live preview when the prior is selected. */
  wirePriorRows() {
    for (const row of this.root.querySelectorAll('[data-pri-row]')) {
      const key = row.dataset.priKey;
      const dist = row.dataset.dist;
      const target = row.dataset.target;
      const idx = +row.dataset.index;
      row.querySelectorAll('[data-pri]').forEach(inp => {
        const fieldKey = inp.dataset.key;
        const commit = () => {
          const result = this.commit(xml =>
            applyPriorEdit(xml, dist, target, idx, fieldKey, inp.value));
          if (result === null && inp.value !== '') {
            this.onEditError(
              `${dist} on ${target}: attribute "${fieldKey}" was not applied`);
          }
          /* Clear the pending value so the preview falls back to
           * the freshly parsed XML. */
          if (this.priorPreviewValues[key]) {
            delete this.priorPreviewValues[key][fieldKey];
          }
          this.refreshPriorPreview();
        };
        let timer = null;
        inp.addEventListener('input', () => {
          /* Layer the in-progress value on top of the parsed XML
           * so the preview updates as the user types. */
          this.priorPreviewValues[key] = this.priorPreviewValues[key] || {};
          this.priorPreviewValues[key][fieldKey] = inp.value;
          this.selectPrior(key);
          this.refreshPriorPreview();
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { timer = null; commit(); }, 600);
        });
        inp.addEventListener('change', commit);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (timer) { clearTimeout(timer); timer = null; }
            commit();
            inp.blur();
          }
        });
      });
      /* Click on the row head (not the form fields) selects the prior
       * and jumps to its source location. */
      const head = row.querySelector('.slot-head');
      if (head) {
        head.style.cursor = 'pointer';
        head.addEventListener('click', e => {
          if (e.target.closest('input, select, textarea, label')) return;
          this.selectPrior(key);  // also calls selectRow internally
          this.jumpToElement(dist, target, idx);
        });
      }
    }
  }

  /* Resolve the i-th element of (tagName, targetId) to a source line
   * and ask the host to jump there. */
  jumpToElement(tagName, targetId, i) {
    const line = findElementLine(this.xmlText, tagName, targetId, i);
    if (line != null) this.onJumpToLine(line);
  }

  wireMcmcRows() {
    for (const inp of this.root.querySelectorAll('[data-mcmc]')) {
      inp.addEventListener('focus', () => this.selectRow('mcmc'));
      inp.addEventListener('change', () => {
        this.selectRow('mcmc');
        this.commit(xml =>
          applyMcmcEdit(xml, inp.dataset.key, inp.value));
      });
    }
    for (const inp of this.root.querySelectorAll('[data-log]')) {
      const row = inp.closest('[data-log-row]');
      const rowKey = 'log:' + row.dataset.logRow;
      inp.addEventListener('focus', () => this.selectRow(rowKey));
      inp.addEventListener('change', () => {
        this.selectRow(rowKey);
        const kind = row.dataset.kind;
        this.commit(xml =>
          applyLogEdit(xml, kind, inp.dataset.key, inp.value));
      });
    }
    /* Click on the <mcmc> row header jumps to the <mcmc> element's
     * source line.  The <mcmc> element is the only one of its kind. */
    const mcmcRow = this.root.querySelector('[data-mcmc-row]');
    if (mcmcRow) {
      const head = mcmcRow.querySelector('.slot-head');
      if (head) {
        head.style.cursor = 'pointer';
        head.addEventListener('click', e => {
          if (e.target.closest('input, select, textarea, label')) return;
          this.selectRow('mcmc');
          const line = findElementLine(this.xmlText, 'mcmc', null, 0);
          if (line != null) this.onJumpToLine(line);
        });
      }
    }
    /* Click on a <log> or <logTree> row header jumps to the i-th
     * <log> or <logTree> element's source line. */
    const logRows = this.root.querySelectorAll('[data-log-row]');
    /* Group by kind to compute the i-th occurrence of each kind. */
    const seenByKind = new Map();
    logRows.forEach(row => {
      const kind = row.dataset.kind;
      const i = seenByKind.get(kind) || 0;
      seenByKind.set(kind, i + 1);
      const head = row.querySelector('.slot-head');
      if (head) {
        head.style.cursor = 'pointer';
        head.addEventListener('click', e => {
          if (e.target.closest('input, select, textarea, label')) return;
          this.selectRow('log:' + i);
          const line = findElementLine(this.xmlText, kind, null, i);
          if (line != null) this.onJumpToLine(line);
        });
      }
    });
  }

  commit(mutator) {
    const next = mutator(this.xmlText);
    if (next == null) return null;
    this.xmlText = next;
    try {
      this.doc = parseXml(next);
    } catch (e) {
      this.onApply(next, e);
      return null;
    }
    this.onApply(next, null);
    return next;
  }
}
