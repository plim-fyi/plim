// Small dependency-free SVG charts: columns (per-mark hover) and a line
// (crosshair hover). Single-series, so no legend; the card title names it.
// Every chart also renders a table view. All text goes in via textContent.

const NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 190;
const M = { top: 20, right: 12, bottom: 24, left: 40 };
const BAR_MAX = 24;
const RADIUS = 4;

const tooltip = () => document.getElementById('tooltip');

function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

/** Four even steps of a clean size (1/2/5 × 10^k); whole numbers for counts. */
function scale(max, integer) {
  const raw = Math.max(max, integer ? 4 : 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw);
  if (integer) step = Math.max(1, Math.ceil(step));
  return { top: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
}

function showTip(value, label, x, y) {
  const t = tooltip();
  const strong = document.createElement('strong');
  strong.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  t.replaceChildren(strong, span);
  t.hidden = false;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  t.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`;
  t.style.top = `${y - h - 12 < 8 ? y + 16 : y - h - 12}px`;
}

const hideTip = () => (tooltip().hidden = true);

/** Rounded data-end on top, square at the baseline. */
function barPath(x, y, w, h) {
  const r = Math.min(RADIUS, h, w / 2);
  const b = y + h;
  return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
}

function frame(container, points, { integer = true }) {
  const width = Math.max(240, container.clientWidth);
  const svg = svgEl('svg', { width, height: HEIGHT, role: 'img' });
  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const { top, ticks } = scale(Math.max(...points.map((p) => p.value), 0), integer);
  const y = (v) => M.top + plotH - (v / top) * plotH;
  const grid = svgEl('g', { class: 'grid' }, svg);
  for (const t of ticks) {
    if (t > 0) svgEl('line', { x1: M.left, x2: width - M.right, y1: y(t), y2: y(t) }, grid);
    svgEl('text', { x: M.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent =
      integer ? t.toLocaleString() : t.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
  svgEl('line', { x1: M.left, x2: width - M.right, y1: y(0), y2: y(0), class: 'axis-line' }, svg);
  return { svg, width, plotW, plotH, y };
}

function xLabels(svg, items) {
  for (const { x, text, anchor = 'middle' } of items) {
    svgEl('text', { x, y: HEIGHT - 6, 'text-anchor': anchor, class: 'tick' }, svg).textContent = text;
  }
}

/** Table view: the values are reachable without hovering. */
function tableView(points, valueHeader) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Show as table';
  const table = document.createElement('table');
  table.className = 'data';
  const head = table.createTHead().insertRow();
  for (const h of ['', valueHeader]) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const p of points) {
    const row = body.insertRow();
    row.insertCell().textContent = p.label;
    const c = row.insertCell();
    c.className = 'num';
    c.textContent = p.display;
  }
  details.append(summary, table);
  return details;
}

/**
 * points: [{ label, value, display, detail? }]
 * opts: { xTicks: indexes to label, xText(i), valueHeader, describe }
 */
export function columns(container, points, opts) {
  const { svg, plotW, y } = frame(container, points, opts);
  svg.setAttribute('aria-label', opts.describe);
  const band = plotW / points.length;
  const w = Math.max(2, Math.min(BAR_MAX, band - 2));
  const bars = [];
  points.forEach((p, i) => {
    const x = M.left + i * band + (band - w) / 2;
    const h = y(0) - y(p.value);
    bars.push(h > 0 ? svgEl('path', { d: barPath(x, y(p.value), w, h), class: 'bar' }, svg) : null);
  });
  // Label only the peak.
  const peak = points.reduce((best, p, i) => (p.value > (points[best]?.value ?? 0) ? i : best), -1);
  if (peak >= 0) {
    const t = svgEl('text', { x: M.left + peak * band + band / 2, y: y(points[peak].value) - 6, 'text-anchor': 'middle', class: 'value-label' }, svg);
    t.textContent = points[peak].display;
  }
  xLabels(svg, opts.xTicks.map((i) => ({ x: M.left + i * band + band / 2, text: opts.xText(i) })));
  // Hit targets: the full band height, bigger than the mark.
  points.forEach((p, i) => {
    const hit = svgEl('rect', { x: M.left + i * band, y: M.top, width: band, height: y(0) - M.top, class: 'hit', tabindex: 0 }, svg);
    hit.setAttribute('aria-label', `${p.label}: ${p.display}`);
    const on = (ev) => {
      bars[i]?.classList.add('active');
      const r = hit.getBoundingClientRect();
      showTip(p.display, p.detail ?? p.label, ev?.clientX ?? r.left + r.width / 2, y(p.value) - M.top + r.top);
    };
    const off = () => (bars[i]?.classList.remove('active'), hideTip());
    hit.addEventListener('pointermove', on);
    hit.addEventListener('focus', () => on());
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('blur', off);
  });
  container.replaceChildren(svg, tableView(points, opts.valueHeader));
}

/** A 2px line with a wash, an end-dot + end label, and a snapping crosshair. */
export function line(container, points, opts) {
  const { svg, plotW, y } = frame(container, points, opts);
  svg.setAttribute('aria-label', opts.describe);
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (i) => M.left + i * step;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  svgEl('path', { d: `${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: 'area' }, svg);
  svgEl('path', { d, class: 'line' }, svg);
  const last = points.length - 1;
  svgEl('circle', { cx: x(last), cy: y(points[last].value), r: 4, class: 'dot' }, svg);
  const endLabel = svgEl('text', { x: x(last), y: y(points[last].value) - 10, 'text-anchor': 'end', class: 'value-label' }, svg);
  endLabel.textContent = points[last].display;
  xLabels(svg, opts.xTicks.map((i) => ({ x: x(i), text: opts.xText(i), anchor: i === 0 ? 'start' : i === last ? 'end' : 'middle' })));

  const cross = svgEl('line', { y1: M.top, y2: y(0), class: 'crosshair', visibility: 'hidden' }, svg);
  const marker = svgEl('circle', { r: 4, class: 'dot', visibility: 'hidden' }, svg);
  const overlay = svgEl('rect', { x: M.left - step / 2, y: M.top, width: plotW + step, height: y(0) - M.top, class: 'hit', tabindex: 0 }, svg);
  overlay.setAttribute('aria-label', `${opts.describe}. Use arrow keys to read values.`);
  let current = last;
  const show = (i, clientX) => {
    current = Math.max(0, Math.min(last, i));
    const p = points[current];
    for (const [k, v] of [['x1', x(current)], ['x2', x(current)], ['visibility', 'visible']]) cross.setAttribute(k, v);
    for (const [k, v] of [['cx', x(current)], ['cy', y(p.value)], ['visibility', 'visible']]) marker.setAttribute(k, v);
    const r = svg.getBoundingClientRect();
    showTip(p.display, p.detail ?? p.label, clientX ?? r.left + x(current), r.top + y(p.value));
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    marker.setAttribute('visibility', 'hidden');
    hideTip();
  };
  overlay.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    show(Math.round((ev.clientX - r.left - M.left) / (step || 1)));
  });
  overlay.addEventListener('pointerleave', hide);
  overlay.addEventListener('focus', () => show(current));
  overlay.addEventListener('blur', hide);
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      show(current + (ev.key === 'ArrowRight' ? 1 : -1));
    }
  });
  container.replaceChildren(svg, tableView(points, opts.valueHeader));
}
