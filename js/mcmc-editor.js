/* Prior / operator / MCMC editor.
 *
 * Operates directly on the loaded XML text (not on the parsed DAG).  For each
 * prior, operator, and MCMC parameter exposed by the parser, the editor builds
 * a row with the right form fields.  Edits mutate the XML via a tiny DOM
 * helper, then call the registered onApply callback so the viewer can
 * re-parse and re-render.
 *
 * The original builder (template-based, FASTA drop, drag-drop) was removed in
 * this revision.  We keep only the parts that edit a *loaded* model.
 */

/* ---------------------------------------------------------------- exports */

/* SVG density plot for a single prior.  Returns an SVG string.
 *
 *  - `compact`: small inline preview (no axes); retained for callers that
 *    still want a thumbnail.
 *  - otherwise: full plot with axes, ticks, and labels, used in the
 *    editor's preview pane.
 *
 * For positively-supported distributions (logNormal, exponential, gamma,
 * oneOnX), the x-axis uses a log scale when the value range spans more
 * than a factor of 5, otherwise linear.  This keeps the mode visible
 * while preventing the long right tail from squashing the curve into a
 * spike. */

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
    text: 'Memoryless decay on x \u2265 0.  mean is the mean of the ' +
          'distribution (BEAST uses mean, not rate \u03BB = 1/mean).',
  },
  gamma: {
    label: 'Gamma',
    text: 'Strictly positive, flexible shape. shape and stdev fields encode ' +
          'shape \u03B1 and scale \u03B8 so mean = \u03B1\u00B7\u03B8 and ' +
          'var = \u03B1\u00B7\u03B8\u00B2.',
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
          'in the middle; one of them < 1 puts mass at one endpoint.',
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

/* Returns { xs, ys, logScale, xLabel } for a prior.  `p` is the
 * {kind, mean, stdev, shape, scale, offset, lower, upper, ...} object the
 * editor builds from the parsed XML.  Attribute names follow the BEAST X
 * XML convention so that values copied straight from the parser flow into
 * the chart without translation.
 *
 * The x-axis is in log scale whenever the support spans more than a factor of
 * 5 (so logNormal / exponential / gamma don't get crushed by their right
 * tail), otherwise linear.  This is what the user wants: a curve that you
 * can read, not a hairline on the left edge of the chart.
 *
 * Range is chosen to cover ~99.5% of the mass where possible. */
function samplePrior(p, N = 200) {
  /* Each distribution's parameters.  We accept both the BEAST X spelling
   * (`shape` / `scale` for gamma; `mean` / `stdev` for logNormal) and the
   * generic spellings used elsewhere (shape1 / shape2 / scale) so values
   * flow in from either source. */
  const mu    = num(p.mean);
  const sigma = num(p.stdev);
  const shape = num(p.shape) || num(p.shape1);
  const scale = num(p.scale) || num(p.stdev) || num(p.shape2);
  const lo    = num(p.lower);
  const hi    = num(p.upper);
  const offset = Number(p.offset || 0);
  let xs, ys, xLabel = 'x', logScale = false;

  if (p.kind === 'logNormal') {
    /* BEAST X's logNormalPrior uses two conventions for `mean` and `stdev`,
     * selected by `meanInRealSpace`.  When false (the BEAST default),
     * mean and stdev are the mu and sigma of ln X — the curve's "log
     * scale" parameters.  When true, mean and stdev are the real-space
     * mean and SD of X, which we convert to log-space parameters. */
    let m, s;
    if (p.meanInRealSpace === 'true' && isFinite(mu) && mu > 0 && isFinite(sigma) && sigma > 0) {
      const v = sigma * sigma;
      m = Math.log(mu * mu / Math.sqrt(mu * mu + v));
      s = Math.sqrt(Math.log(1 + v / (mu * mu)));
    } else {
      m = isFinite(mu) ? mu : 0;
      s = (isFinite(sigma) && sigma > 0) ? sigma : 1;
    }
    const xMin = Math.max(1e-9, Math.exp(m - 4 * s));
    const xMax = Math.exp(m + 5 * s);
    xs = logspace(xMin, xMax, N);
    ys = xs.map(x => lnpdf(x, m, s));
    logScale = (xMax / xMin) > 5;
    xLabel = 'x';
  } else if (p.kind === 'exponential') {
    const m = isFinite(mu) && mu > 0 ? mu : 1;
    xs = linspace(m * 1e-4, m * 12, N);
    ys = xs.map(x => exppdf(x, m));
    logScale = 12 > 5;
    xLabel = 'x';
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
    /* shape < 1 puts mass at zero with a long tail — always use log scale
     * there.  shape >= 1 with a wide range also benefits from log scale. */
    logScale = k < 1 || xMax > 5;
    xLabel = 'x';
  } else if (p.kind === 'normal') {
    const m = isFinite(mu) ? mu : 0;
    const s = isFinite(sigma) && sigma > 0 ? sigma : 1;
    xs = linspace(m - 4 * s, m + 4 * s, N);
    ys = xs.map(x => normalpdf(x, m, s));
    logScale = false;
    xLabel = 'x';
  } else if (p.kind === 'laplace') {
    const m = isFinite(mu) ? mu : 0;
    const b = isFinite(sigma) && sigma > 0 ? sigma : 1;
    xs = linspace(m - 6 * b, m + 6 * b, N);
    ys = xs.map(x => laplacepdf(x, m, b));
    logScale = false;
    xLabel = 'x';
  } else if (p.kind === 'uniform') {
    const a = isFinite(lo) ? lo : 0;
    const b = isFinite(hi) ? hi : Math.max(a + 1, 1);
    xs = linspace(a, b, N);
    ys = xs.map(() => 1 / Math.max(b - a, 1e-9));
    logScale = false;
    xLabel = 'x';
  } else if (p.kind === 'beta') {
    const a = isFinite(shape1) && shape1 > 0 ? shape1 : 1;
    const b = isFinite(shape2) && shape2 > 0 ? shape2 : 1;
    xs = linspace(1e-4, 1 - 1e-4, N);
    ys = xs.map(x => betapdf(x, a, b));
    logScale = false;
    xLabel = 'x';
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
  return { xs, ys, logScale, xLabel };
}

/* Render the density as an inline SVG string. */
export function priorPdfSvg(p, opts = {}) {
  const compact = !!opts.compact;
  const sample = samplePrior(p, compact ? 80 : 240);
  if (!sample) return '';
  const { xs, ys, logScale, xLabel } = sample;
  const N = xs.length;

  const W = compact ? 120 : 480;
  const H = compact ? 36 : 240;
  const M = compact ? 4 : 36;

  let xsPlot;
  if (logScale) {
    /* Log x-axis: convert to log, then linearly map. */
    const lx = xs.map(x => Math.log(x));
    const lxMin = lx[0], lxMax = lx[N - 1];
    xsPlot = lx.map(v => M + (v - lxMin) / (lxMax - lxMin || 1e-9) * (W - 2 * M));
  } else {
    const xMin = xs[0], xMax = xs[N - 1];
    xsPlot = xs.map(x => M + (x - xMin) / (xMax - xMin || 1e-9) * (W - 2 * M));
  }
  const ymax = Math.max(...ys, 1e-12);
  const sy = y => H - M - (y / ymax) * (H - 2 * M);

  let d = '';
  for (let i = 0; i < N; i++) {
    d += (i ? 'L' : 'M') + xsPlot[i].toFixed(2) + ',' + sy(ys[i]).toFixed(2) + ' ';
  }

  if (compact) {
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="prior-pdf">
      <line x1="${M}" y1="${H - M}" x2="${W - M}" y2="${H - M}"
            stroke="currentColor" stroke-opacity="0.25" stroke-width="0.5"/>
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  }

  /* Full plot: ticks, axis labels, and the curve. */
  const ticks = 5;
  const xTickVals = logScale
    ? Array.from({ length: ticks + 1 }, (_, i) => {
        const lxMin = Math.log(xs[0]);
        const lxMax = Math.log(xs[N - 1]);
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
    /* Compute the plot position the same way as xsPlot. */
    const px = logScale
      ? M + (Math.log(v) - Math.log(xs[0])) /
              (Math.log(xs[N - 1]) - Math.log(xs[0]) || 1e-9) * (W - 2 * M)
      : M + (v - xs[0]) / (xs[N - 1] - xs[0] || 1e-9) * (W - 2 * M);
    const x = px.toFixed(2);
    xTickMarks +=
      `<line x1="${x}" y1="${H - M}" x2="${x}" y2="${H - M + 4}" stroke="currentColor"/>` +
      `<text x="${x}" y="${H - M + 18}" text-anchor="middle" font-size="10" ` +
      `fill="currentColor" opacity="0.7">${fmt(v)}</text>`;
  }
  let yTickMarks = '';
  for (let i = 0; i < yTickVals.length; i++) {
    const v = yTickVals[i];
    const y = sy(v).toFixed(2);
    yTickMarks +=
      `<line x1="${M - 4}" y1="${y}" x2="${M}" y2="${y}" stroke="currentColor"/>` +
      `<text x="${M - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" ` +
      `font-size="10" fill="currentColor" opacity="0.7">${fmt(v)}</text>`;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="prior-pdf-full">
    <line x1="${M}" y1="${M}" x2="${M}" y2="${H - M}" stroke="currentColor" stroke-width="1"/>
    <line x1="${M}" y1="${H - M}" x2="${W - M}" y2="${H - M}" stroke="currentColor" stroke-width="1"/>
    ${xTickMarks}
    ${yTickMarks}
    <text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="11"
          fill="currentColor" opacity="0.85">${xLabel}${logScale ? '  (log scale)' : ''}</text>
    <text x="12" y="${H / 2}" text-anchor="middle" font-size="11"
          fill="currentColor" opacity="0.85"
          transform="rotate(-90 12 ${H / 2})">density</text>
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

/* ------------------------------------------------------ XML editing helpers */

/* We support two equivalent editing strategies and pick the simpler one for
 * the common case:
 *
 *  1. **Regex editing on the original text.**  When the user edits a value
 *     on a row, we know the tag (`gammaPrior`, `scaleOperator`, `mcmc`,
 *     etc.), the index of the matching element, and the attribute name.  We
 *     locate the matching opening tag and rewrite its attribute in place.
 *     This keeps the original XML formatting (indentation, comments,
 *     element ordering) intact, which matters because the source view
 *     still has to look right.
 *
 *  2. **DOM editing on a parsed document.**  Fallback for edits that need
 *     to add/remove attributes; used by setAttr.
 *
 * Both paths produce the same XML text.  Regex editing is preferred because
 * it preserves everything the user did not touch. */

function buildElementIndex(text) {
  /* Find every opening tag in the document and its byte offset, in source
   * order.  Each entry is { tag, attrs: {name -> value}, start (offset of
   * `<`), end (offset just past `>`), depth }. */
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
  /* Quote attribute values with double quotes.  Emit in the same order they
   * were declared in, then any new ones alphabetically. */
  const keys = Object.keys(attrs);
  return keys.map(k => `${k}="${(attrs[k] || '').replace(/"/g, '&quot;')}"`).join(' ');
}

/* Find the i-th element in `text` whose tag matches `tagName` AND whose
 * idref (under <parameter>/<treeModel>) matches `targetId`.  Returns
 * { start, end, attrs, selfClose } or null.  Pass `targetId = null` to skip
 * the idref check (for elements that have no idref, e.g. <mcmc>). */
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

function elementReferencesId(elEntry, text, targetId) {
  /* Walk the element body until matching close tag and check every idref. */
  const bodyStart = elEntry.end;
  /* Naively search forward for </tagName> with the same depth.  Robust
   * enough for well-formed BEAST X XML. */
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

/* Rewrite an attribute on the i-th element of `tagName` (whose idref
 * descendants include `targetId`, if given).  Returns the new XML text.
 * If `targetId` is null, only matches by tag (used for <mcmc>). */
export function setAttrOnElement(text, tagName, targetId, i, attrName, attrValue) {
  const found = findElementByTagAndRef(text, tagName, targetId, i);
  if (!found) return null;
  const tagSrc = text.slice(found.start, found.end);
  /* Locate the attribute inside tagSrc. */
  const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(tagSrc);
  let newTag;
  if (m) {
    if (attrValue === null || attrValue === undefined || attrValue === '') {
      /* Remove the attribute.  Strip a single adjacent space (before or
       * after) so we don't leave two spaces next to the surrounding
       * attributes. */
      let start = m.index, end = m.index + m[0].length;
      const before = start > 0 && /\s/.test(tagSrc[start - 1]);
      const after  = end < tagSrc.length && /\s/.test(tagSrc[end]);
      if (before && after) {
        /* Prefer to drop the trailing space so the leading space stays as
         * a separator from the previous attribute. */
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
    /* Add a new attribute before the closing `>` or `/>`. */
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

/* Set an attribute on every element of `tagName` whose depth/identity makes
 * sense (e.g. all <log> and <logTree>).  Returns the updated text. */
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

/* Backwards-compat: the DOM helpers below are kept for callers that need
 * to manipulate elements in a parsed doc.  The editor itself uses the
 * text-based helpers above so the source view remains intact. */

/* DOM-based helpers retained for callers that prefer a parsed document.  The
 * editor itself uses the text-based helpers above so the source view remains
 * byte-identical. */
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

/* Read all attributes of a prior/operator element (skipping idref) and
 * return a flat object suitable for priorPdfSvg / re-rendering. */
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

/* Apply an attribute edit to the matching prior/operator element on the
 * text.  Returns the new text, or null if no match was found.  We keep the
 * old DOM-based helper around (findPrior / findOperator) but the editor
 * uses these so the source view remains byte-identical. */
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

/* ----------------------------------------------------------- editor UI */

/* Build a config for a single prior row, by inspecting the i-th prior element
 * with `dist` on `targetId`.  (DOM helper, currently unused by the editor —
 * retained for callers that prefer the parsed-document API.) */
function priorFromElement(el) {
  const out = { kind: el.tagName.replace(/Prior$/, '') };
  for (const a of el.attributes) {
    if (a.name === 'idref') continue;
    out[a.name] = a.value;
  }
  return out;
}
function operatorFromElement(el) {
  const out = { kind: el.tagName };
  for (const a of el.attributes) {
    out[a.name] = a.value;
  }
  return out;
}

/* Render the editor into `root`.  Pass the parsed model (for picking priors
 * and operators to edit) and the original XML text (so we can mutate and
 * re-serialise).
 *
 * Callbacks:
 *  - onApply(updatedXml) — user committed an edit; parse & re-render
 *  - onClose() — user dismissed the editor
 */
export class McmcEditor {
  constructor(rootEl, opts = {}) {
    this.root = rootEl;
    this.onApply = opts.onApply || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.model = null;
    this.xmlText = null;
    this.doc = null;
  }

  open(model, xmlText) {
    this.model = model;
    this.xmlText = xmlText;
    this.doc = parseXml(xmlText);
    this.render();
  }

  render() {
    const m = this.model;
    const priors = collectPriors(m);
    const operators = collectOperators(m);
    const mcmc = readMcmcAttrs(this.doc);
    const logs = readLogAttrs(this.doc);

    /* Preserve the currently-selected prior across re-renders (e.g. after
     * the user adds an attribute and the editor rebuilds).  Falls back to
     * the first prior, or null if there are none. */
    const sel = this.selectedPrior || (priors[0] && priors[0].key) || null;

    this.root.innerHTML = `
      <div class="mcmc-editor">
        <div class="me-head">
          <h2>Edit priors &amp; MCMC</h2>
          <div class="me-spacer"></div>
          <button class="me-export">Export XML</button>
          <button class="me-close" aria-label="Close">&times;</button>
        </div>
        <div class="me-body">
          ${priors.length ? previewPane(priors, sel) :
            '<div class="hint">No priors in this model \u2014 nothing to preview.</div>'}
          <section>
            <h3>Priors <span class="me-count">${priors.length}</span></h3>
            ${priors.length ? '' : '<div class="hint">No priors in this model.</div>'}
            ${priors.map(p => priorRow(p, p.key === sel)).join('')}
          </section>

          <section>
            <h3>Operators <span class="me-count">${operators.length}</span></h3>
            ${operators.length ? '' : '<div class="hint">No operators in this model.</div>'}
            ${operators.map((op, i) => operatorRow(op, i)).join('')}
          </section>

          <section>
            <h3>MCMC</h3>
            ${mcmc.length ? mcmcRow(mcmc) : '<div class="hint">No <code>&lt;mcmc&gt;</code> element found.</div>'}
            ${logs.length ? logsRow(logs) : ''}
          </section>
        </div>
      </div>`;

    this.root.querySelector('.me-close').onclick = () => this.onClose();
    this.root.querySelector('.me-export').onclick = () => this.exportXml();
    wirePriorRows(this, this.root);
    wireOperatorRows(this, this.root);
    wireMcmcRows(this, this.root);
    wirePreviewPane(this, this.root);
    if (sel) this.refreshPreview(sel);
  }

  /* Set the currently-previewed prior.  Called by the dropdown, by input
   * focus events, and internally on initial render. */
  selectPrior(key) {
    if (this.selectedPrior === key) {
      this.refreshPreview(key);
      return;
    }
    this.selectedPrior = key;
    /* Mark the row that holds this prior as selected so the user can see
     * which row is being previewed. */
    for (const r of this.root.querySelectorAll('[data-pri-row]')) {
      r.classList.toggle('selected', r.dataset.priKey === key);
    }
    /* Sync the dropdown. */
    const dd = this.root.querySelector('#pri-select');
    if (dd && dd.value !== key) dd.value = key;
    this.refreshPreview(key);
  }

  /* Re-render the preview graph for `key` using its current XML values
   * layered with any pending input values that the user is typing. */
  refreshPreview(key) {
    const plot = this.root.querySelector('#pri-preview');
    const desc = this.root.querySelector('#pri-desc');
    if (!plot) return;
    const p = findPriorByKey(this.model, key);
    if (!p) {
      plot.innerHTML = '';
      if (desc) desc.textContent = '';
      return;
    }
    /* Build the values object for the PDF.  We always include `kind` so
     * `samplePrior` can pick the right branch even when the doc lookup
     * returns null.  Pending values (the in-progress edit) layer on top
     * of the committed values. */
    const kind = p.dist.replace(/Prior$/, '');
    const base = readPriorAttrsFromDoc(this.doc, p.dist, p.targetId, p.index);
    const pending = this.pendingInputs && this.pendingInputs[key];
    const vals = Object.assign(
      { kind },
      base || {},
      pending || {});
    plot.innerHTML = priorPdfSvg(vals);
    if (desc) {
      const info = PRIOR_INFO[kind] || { text: '' };
      desc.textContent = info.text || '';
    }
  }

  /* Download the current (edited) XML as a file. */
  exportXml() {
    const blob = new Blob([this.xmlText], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'edited.xml';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* Apply a mutation: rewrite the XML text in place, re-parse so the next
   * render reflects fresh values, then ask the parent to refresh the
   * viewer.  We keep the source view's formatting by editing the text
   * directly rather than re-serialising the DOM.  Returns the new XML
   * text on success, `null` if the mutator could not find its target
   * (e.g. the attribute did not exist on the prior element). */
  commit(mutator) {
    const next = mutator(this.xmlText);
    if (next == null) return null;
    this.xmlText = next;
    try {
      this.doc = parseXml(next);
    } catch (e) {
      /* If the user's edit broke the XML, leave the text as-is but skip the
       * viewer re-render so the source view shows what they typed. */
      this.onApply(next, e);
      return null;
    }
    this.onApply(next, null);
    return next;
  }
}

function collectPriors(model) {
  /* The parser exposes one entry per (targetId, prior-dist) pair.  We
   * give every prior a stable key (used by the preview pane to identify
   * which row's curve to draw) and dedupe so each (target, dist) pair
   * appears exactly once. */
  const out = [];
  const seen = new Set();
  let n = 0;
  for (const node of model.nodes) {
    for (const p of node.priors || []) {
      const k = p.dist + ':' + node.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        key: `pri-${n++}`,
        dist: p.dist,
        targetId: node.id,
        attrs: p.attrs,
        index: 0,
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

function collectOperators(model) {
  const out = [];
  const seen = new Set();
  for (const n of model.nodes) {
    for (const o of n.operators || []) {
      const k = o.tag + ':' + n.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        tag: o.tag,
        targetId: n.id,
        attrs: o.attrs,
        index: 0,
        label: n.id,
      });
    }
  }
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

/* ----------------------------------------------- row renderers */

function attrInputs(spec, values, ns) {
  /* spec: [{key, label, type}].  Returns HTML for the labeled inputs and the
   * data-pri / data-op / data-mcmc / data-log attributes the wirer uses. */
  return spec.map(({ key, label, type }) => {
    const v = values[key] != null ? values[key] : '';
    const safe = esc(String(v));
    if (type === 'select') {
      return `<label>${label}</label>
        <select data-${ns}="" data-key="${key}">
          ${spec.find(s => s.key === key).options.map(opt =>
            `<option value="${esc(opt)}" ${String(v) === opt ? 'selected' : ''}>${esc(opt)}</option>`
          ).join('')}
        </select>`;
    }
    return `<label>${label}</label>
      <input type="${type === 'number' ? 'number' : 'text'}" data-${ns}="" data-key="${key}" value="${safe}">`;
  }).join('');
}

function priorRow(p, isSelected) {
  const distKind = p.dist.replace(/Prior$/, '');
  const vals = { ...p.attrs };
  const isCtmc = distKind === 'ctmcScale';
  const info = PRIOR_INFO[distKind] || { label: distKind, text: '' };
  /* The editor exposes the common attributes.  ctmcScale has nothing. */
  const spec = isCtmc ? [] : priorFields(distKind, vals);
  return `
    <div class="slot ${isSelected ? 'selected' : ''}" data-pri-row="0"
         data-pri-key="${esc(p.key)}" data-dist="${esc(p.dist)}"
         data-target="${esc(p.targetId)}" data-pri-index="${p.index}">
      <div class="slot-head">
        <strong>${esc(info.label)}</strong>
        <code class="slot-target">${esc(p.targetId)}</code>
      </div>
      <details class="slot-edit" open>
        <summary>Edit parameters</summary>
        ${spec.length ? attrInputs(spec, vals, 'pri') : '<div class="hint">No editable parameters.</div>'}
      </details>
    </div>`;
}

/* Render the persistent preview pane at the top of the editor.  A dropdown
 * lists every prior; the selected prior's density curve is drawn full-size
 * with axes below.  Focus events on any prior input auto-switch the
 * selection so the preview follows the user's attention. */
function previewPane(priors, selectedKey) {
  return `
    <section class="me-preview">
      <div class="me-preview-bar">
        <label>Preview:</label>
        <select id="pri-select">
          ${priors.map(p =>
            `<option value="${esc(p.key)}" ${p.key === selectedKey ? 'selected' : ''}>` +
            `${esc((PRIOR_INFO[p.dist.replace(/Prior$/, '')] || { label: p.dist }).label)}` +
            ` on <code>${esc(p.targetId)}</code></option>`
          ).join('')}
        </select>
      </div>
      <div class="me-preview-plot" id="pri-preview"></div>
      <p class="me-preview-desc" id="pri-desc"></p>
    </section>`;
}

/* The set of editable attributes for each prior kind.  We pick a sensible
 * subset of the BEAST X attribute set; advanced/uncommon fields stay in the
 * source XML. */
function priorFields(kind, vals) {
  switch (kind) {
    case 'logNormal':
      return [
        { key: 'mean', label: 'mean (\u03BC of log)', type: 'text' },
        { key: 'stdev', label: 'stdev (\u03C3 of log)', type: 'text' },
        { key: 'offset', label: 'offset', type: 'text' },
        { key: 'meanInRealSpace', label: 'meanInRealSpace', type: 'select',
          options: ['false', 'true'] },
      ];
    case 'exponential':
      return [
        { key: 'mean', label: 'mean', type: 'text' },
        { key: 'offset', label: 'offset', type: 'text' },
      ];
    case 'gamma':
      return [
        { key: 'shape', label: 'shape (\u03B1)', type: 'text' },
        { key: 'scale', label: 'scale (\u03B8)', type: 'text' },
        { key: 'offset', label: 'offset', type: 'text' },
      ];
    case 'normal':
      return [
        { key: 'mean', label: 'mean', type: 'text' },
        { key: 'stdev', label: 'stdev', type: 'text' },
      ];
    case 'laplace':
      return [
        { key: 'mean', label: 'mean', type: 'text' },
        { key: 'scale', label: 'scale', type: 'text' },
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
        { key: 'offset', label: 'offset', type: 'text' },
        { key: 'scale', label: 'scale', type: 'text' },
      ];
    case 'oneOnX':
      return [];
    default:
      return [];
  }
}

function operatorRow(op, i) {
  const tag = op.tag;
  const vals = { ...op.attrs };
  const spec = operatorFields(tag);
  return `
    <div class="slot" data-op-row="${i}" data-tag="${esc(tag)}"
         data-target="${esc(op.targetId)}">
      <div class="slot-head">
        <strong>${esc(tag)}</strong>
        <code class="slot-target">${esc(op.targetId)}</code>
      </div>
      <details class="slot-edit" open>
        <summary>Edit parameters</summary>
        ${spec.length ? attrInputs(spec, vals, 'op') : '<div class="hint">No editable parameters.</div>'}
      </details>
    </div>`;
}

function operatorFields(tag) {
  /* Most operators share {weight, scaleFactor}.  Tree operators use
   * {size, gaussian} etc; we expose the common ones plus anything present
   * in the source so the user can edit back without losing context. */
  const common = [
    { key: 'weight', label: 'weight', type: 'number' },
  ];
  const sized = [
    ...common,
    { key: 'scaleFactor', label: 'scaleFactor', type: 'number' },
    { key: 'size', label: 'size', type: 'text' },
    { key: 'windowSize', label: 'windowSize', type: 'text' },
    { key: 'delta', label: 'delta', type: 'text' },
    { key: 'gaussian', label: 'gaussian', type: 'select', options: ['true', 'false'] },
    { key: 'autoOptimize', label: 'autoOptimize', type: 'select', options: ['true', 'false'] },
    { key: 'type', label: 'type (nodeHeightOperator)', type: 'text' },
    { key: 'boundaryCondition', label: 'boundaryCondition', type: 'text' },
  ];
  return sized;
}

function mcmcRow(attrs) {
  const obj = Object.fromEntries(attrs);
  const spec = [
    { key: 'chainLength', label: 'chainLength', type: 'number' },
    { key: 'autoOptimize', label: 'autoOptimize', type: 'select', options: ['true', 'false'] },
    { key: 'preBurnin', label: 'preBurnin', type: 'number' },
  ];
  return `<div class="slot" data-mcmc-row="">
    <div class="slot-head"><strong>&lt;mcmc&gt;</strong></div>
    <details class="slot-edit" open>
      <summary>Edit MCMC parameters</summary>
      ${attrInputs(spec, obj, 'mcmc')}
    </details>
  </div>`;
}

function logsRow(logs) {
  return logs.map((lg, i) => `
    <div class="slot" data-log-row="${i}" data-kind="${esc(lg.kind)}">
      <div class="slot-head"><strong>&lt;${esc(lg.kind)}&gt;</strong></div>
      <details class="slot-edit">
        <summary>Edit log every</summary>
        <label>logEvery</label>
        <input type="number" data-log="" data-key="logEvery"
               value="${esc(lg.logEvery || '')}">
        ${lg.fileName ? `<label>fileName</label>
          <input type="text" data-log="" data-key="fileName"
                 value="${esc(lg.fileName)}">` : ''}
      </details>
    </div>`).join('');
}

/* ----------------------------------------------- row wirers */

function wirePriorRows(editor, root) {
  /* The preview graph lives in a single pane at the top of the editor.
   * Every prior input listens for:
   *   - `focus` / `click`: switch the preview to this prior.
   *   - `input`: cache the in-progress value and redraw the preview.
   *   - `change`: commit the edit to the XML.
   *   - `keydown` Enter: blur the input so `change` fires.
   *
   * The change event fires on blur for text/number inputs and
   * immediately on `<select>` change.  We commit on each change so the
   * preview is always backed by the freshly-parsed XML; the in-progress
   * pending map only lives between an `input` and the next `change`.
   */
  editor.pendingInputs = editor.pendingInputs || {};

  for (const row of root.querySelectorAll('[data-pri-row]')) {
    const key = row.dataset.priKey;
    const dist = row.dataset.dist;
    const target = row.dataset.target;
    const idx = +row.dataset.priIndex;
    const inputs = row.querySelectorAll('[data-pri]');

    inputs.forEach(inp => {
      const focus = () => editor.selectPrior(key);
      inp.addEventListener('focus', focus);
      inp.addEventListener('click', focus);

      const commit = () => {
        const result = editor.commit(xml =>
          applyPriorEdit(xml, dist, target, idx, inp.dataset.key, inp.value));
        if (result === null && inp.value !== '') {
          /* applyPriorEdit returns null when the target element is not
           * found.  Surface the failure so the user knows the edit did
           * not land, instead of silently no-op'ing. */
          if (editor.onEditError) editor.onEditError(
            `${dist} on ${target}: attribute "${inp.dataset.key}" was not applied`);
        }
        if (editor.pendingInputs[key]) {
          delete editor.pendingInputs[key][inp.dataset.key];
        }
      };

      /* Per-input debounced commit.  Each input has its own timer so
       * rapid edits across multiple fields do not collide. */
      let commitTimer = null;
      inp.addEventListener('input', () => {
        editor.pendingInputs[key] = editor.pendingInputs[key] || {};
        editor.pendingInputs[key][inp.dataset.key] = inp.value;
        editor.selectPrior(key);
        /* Debounced auto-commit: even if the user never blurs the
         * input (e.g. clicks on the preview graph or the next field
         * without an explicit blur in some browsers), the edit lands
         * in the XML after ~600ms of idle typing. */
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          commitTimer = null;
          commit();
        }, 600);
      });
      inp.addEventListener('change', commit);
      /* Pressing Enter inside a text/number input normally doesn't fire
       * change unless we blur first.  Some browser/keyboard combos
       * don't dispatch the change event reliably, so we commit
       * explicitly on Enter. */
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
          commit();
          inp.blur();
        }
      });
    });
  }
}

function wirePreviewPane(editor, root) {
  /* The dropdown above the preview switches the active prior. */
  const dd = root.querySelector('#pri-select');
  if (dd) dd.addEventListener('change', () => editor.selectPrior(dd.value));
}

function wireOperatorRows(editor, root) {
  for (const row of root.querySelectorAll('[data-op-row]')) {
    const i = +row.dataset.opRow;
    const tag = row.dataset.tag;
    const target = row.dataset.target;
    row.querySelectorAll('[data-op]').forEach(inp => {
      inp.addEventListener('change', () => {
        editor.commit(xml =>
          applyOperatorEdit(xml, tag, target, i, inp.dataset.key, inp.value));
      });
    });
  }
}

function wireMcmcRows(editor, root) {
  for (const inp of root.querySelectorAll('[data-mcmc]')) {
    inp.addEventListener('change', () => {
      editor.commit(xml =>
        applyMcmcEdit(xml, inp.dataset.key, inp.value));
    });
  }
  for (const inp of root.querySelectorAll('[data-log]')) {
    inp.addEventListener('change', () => {
      const kind = inp.closest('[data-log-row]').dataset.kind;
      editor.commit(xml =>
        applyLogEdit(xml, kind, inp.dataset.key, inp.value));
    });
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
