// Small, dependency-free SVG charts for the Reports page.
// Marks follow fixed specs: bars at most 24px thick with 4px rounded ends at
// the data side, 2px gaps between touching marks, 2px lines, 8px end dots with
// a surface ring, hairline gridlines. Colours come from CSS variables
// (--series-1 ... --series-7) so light and dark themes each use their own
// validated steps. Every chart has a hover tooltip; the report table below the
// charts is the table view.

(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const H = 240;
  const M = { top: 14, right: 12, bottom: 30, left: 58 };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function tip() {
    let t = document.getElementById('chart-tip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'chart-tip';
      t.className = 'chart-tip';
      t.setAttribute('role', 'status');
      t.hidden = true;
      document.body.appendChild(t);
    }
    return t;
  }
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const left = Math.min(window.innerWidth - t.offsetWidth - 8, x + 14);
    const top = y + 14 + t.offsetHeight > window.innerHeight ? y - t.offsetHeight - 10 : y + 14;
    t.style.left = `${Math.max(8, left)}px`;
    t.style.top = `${top}px`;
  }
  function hideTip() { tip().hidden = true; }

  // Round an axis range to clean numbers.
  function niceStep(span, count) {
    const raw = span / count;
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function scale(min, max) {
    if (max === min) max = min + 1;
    const step = niceStep(max - min, 4);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    return { lo, hi, ticks };
  }

  function frame(container, { label, height = H }) {
    container.innerHTML = '';
    const width = Math.max(280, container.clientWidth || 600);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': label, class: 'chart-svg' });
    container.appendChild(svg);
    return { svg, width, height, plotW: width - M.left - M.right, plotH: height - M.top - M.bottom };
  }

  function legend(container, series) {
    if (series.length < 2) return;
    const div = document.createElement('div');
    div.className = 'chart-legend';
    div.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
    container.prepend(div);
  }

  function yAxis(g, sc, plotW, plotH, fmtAxis) {
    for (const v of sc.ticks) {
      const y = M.top + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
      el('line', { x1: M.left, x2: M.left + plotW, y1: y, y2: y, class: v === 0 ? 'chart-zero' : 'chart-grid' }, g);
      const t = el('text', { x: M.left - 8, y: y + 4, class: 'chart-axis', 'text-anchor': 'end' }, g);
      t.textContent = fmtAxis(v);
    }
  }

  // Column with a 4px rounded end at the data side, square at the baseline.
  function column(x, y0, y1, w, r = 4) {
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const h = bottom - top;
    if (h <= 0) return '';
    const rr = Math.min(r, h, w / 2);
    if (y1 <= y0) {
      return `M${x},${bottom} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + w - rr} Q${x + w},${top} ${x + w},${top + rr} V${bottom} Z`;
    }
    return `M${x},${top} V${bottom - rr} Q${x},${bottom} ${x + rr},${bottom} H${x + w - rr} Q${x + w},${bottom} ${x + w},${bottom - rr} V${top} Z`;
  }

  // Grouped or stacked columns. series: [{ name, color, values }]
  function columns(container, { labels, series, stacked = false, fmt, fmtAxis, label }) {
    const f = frame(container, { label });
    const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i]), 0));
    const max = stacked ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((s) => s.values));
    const sc = scale(0, max);
    const g = el('g', {}, f.svg);
    yAxis(g, sc, f.plotW, f.plotH, fmtAxis);
    const yOf = (v) => M.top + f.plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * f.plotH;
    const band = f.plotW / labels.length;
    labels.forEach((lab, i) => {
      const cx = M.left + band * i + band / 2;
      const t = el('text', { x: cx, y: f.height - 10, class: 'chart-axis', 'text-anchor': 'middle' }, g);
      t.textContent = lab;
      if (stacked) {
        const w = Math.min(24, band * 0.6);
        let acc = 0;
        const visible = series.filter((s) => s.values[i] > 0);
        visible.forEach((s, k) => {
          const v = s.values[i];
          const yBase = yOf(acc);
          const yTop = yOf(acc + v) + (k < visible.length - 1 ? 2 : 0); // 2px surface gap
          const isTop = k === visible.length - 1;
          const d = isTop ? column(cx - w / 2, yBase, yTop, w) : `M${cx - w / 2},${yTop} H${cx + w / 2} V${yBase} H${cx - w / 2} Z`;
          if (yBase - yTop > 0.5) el('path', { d, fill: s.color, class: 'chart-mark' }, g);
          acc += v;
        });
      } else {
        const n = series.length;
        const w = Math.min(24, (band * 0.7 - (n - 1) * 2) / n);
        const start = cx - (n * w + (n - 1) * 2) / 2;
        series.forEach((s, k) => {
          const v = s.values[i];
          if (!v) return;
          el('path', { d: column(start + k * (w + 2), yOf(0), yOf(v), w), fill: s.color, class: 'chart-mark' }, g);
        });
      }
      // Hit target: the whole band.
      const hit = el('rect', { x: M.left + band * i, y: M.top, width: band, height: f.plotH, class: 'chart-hit' }, g);
      const rows = series.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(fmt(s.values[i]))}</b></div>`).join('');
      const totalRow = stacked ? `<div class="tip-total">Total <b>${esc(fmt(totals[i]))}</b></div>` : '';
      hit.addEventListener('mousemove', (e) => showTip(`<div class="tip-title">${esc(lab)}</div>${rows}${totalRow}`, e.clientX, e.clientY));
      hit.addEventListener('mouseleave', hideTip);
    });
    legend(container, series);
  }

  // Lines over time with a crosshair. series: [{ name, color, values }]
  function lines(container, { labels, series, fmt, fmtAxis, label }) {
    const f = frame(container, { label });
    const all = series.flatMap((s) => s.values);
    const sc = scale(Math.min(0, ...all), Math.max(0, ...all));
    const g = el('g', {}, f.svg);
    yAxis(g, sc, f.plotW, f.plotH, fmtAxis);
    const yOf = (v) => M.top + f.plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * f.plotH;
    const step = labels.length > 1 ? f.plotW / (labels.length - 1) : 0;
    const xOf = (i) => M.left + (labels.length > 1 ? step * i : f.plotW / 2);
    labels.forEach((lab, i) => {
      const t = el('text', { x: xOf(i), y: f.height - 10, class: 'chart-axis', 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle' }, g);
      t.textContent = lab;
    });
    for (const s of series) {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${xOf(i)},${yOf(v)}`).join(' ');
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
      const last = s.values.length - 1;
      el('circle', { cx: xOf(last), cy: yOf(s.values[last]), r: 4, fill: s.color, class: 'chart-dot' }, g);
    }
    const cross = el('line', { y1: M.top, y2: M.top + f.plotH, class: 'chart-cross', visibility: 'hidden' }, g);
    const hit = el('rect', { x: M.left, y: M.top, width: f.plotW, height: f.plotH, class: 'chart-hit' }, g);
    hit.addEventListener('mousemove', (e) => {
      const box = f.svg.getBoundingClientRect();
      const x = ((e.clientX - box.left) / box.width) * f.width;
      const i = Math.max(0, Math.min(labels.length - 1, Math.round((x - M.left) / (step || 1))));
      cross.setAttribute('x1', xOf(i));
      cross.setAttribute('x2', xOf(i));
      cross.setAttribute('visibility', 'visible');
      const rows = series.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(fmt(s.values[i]))}</b></div>`).join('');
      showTip(`<div class="tip-title">${esc(labels[i])}</div>${rows}`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    legend(container, series);
  }

  // Horizontal bars for a single series, value at the tip. items: [{ label, value }]
  function hbars(container, { items, color, fmt, label }) {
    container.innerHTML = '';
    const rowH = 30;
    const labelW = Math.min(170, Math.max(100, (container.clientWidth || 600) * 0.3));
    const height = items.length * rowH + 8;
    const f = frame(container, { label, height });
    const valueW = 86;
    const plotW = f.width - labelW - valueW;
    const max = Math.max(1, ...items.map((it) => it.value));
    const g = el('g', {}, f.svg);
    items.forEach((it, i) => {
      const y = 4 + i * rowH;
      const t = el('text', { x: labelW - 10, y: y + rowH / 2 + 4, class: 'chart-label', 'text-anchor': 'end' }, g);
      t.textContent = it.label.length > 24 ? `${it.label.slice(0, 23)}…` : it.label;
      const w = Math.max(2, (it.value / max) * plotW);
      const h = 14;
      const by = y + (rowH - h) / 2;
      const r = Math.min(4, w / 2);
      const d = `M${labelW},${by} H${labelW + w - r} Q${labelW + w},${by} ${labelW + w},${by + r} V${by + h - r} Q${labelW + w},${by + h} ${labelW + w - r},${by + h} H${labelW} Z`;
      el('path', { d, fill: color, class: 'chart-mark' }, g);
      const v = el('text', { x: labelW + w + 8, y: y + rowH / 2 + 4, class: 'chart-value' }, g);
      v.textContent = fmt(it.value);
      const hit = el('rect', { x: 0, y, width: f.width, height: rowH, class: 'chart-hit' }, g);
      hit.addEventListener('mousemove', (e) => showTip(`<div class="tip-title">${esc(it.label)}</div><div><b>${esc(fmt(it.value))}</b>${it.note ? ` · ${esc(it.note)}` : ''}</div>`, e.clientX, e.clientY));
      hit.addEventListener('mouseleave', hideTip);
    });
  }

  const api = { columns, lines, hbars };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Charts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
