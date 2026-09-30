/*
 * Splitter — monthly spend chart (stacked columns by category), plus legend and table view.
 * Plain SVG + DOM; every label is inserted with textContent.
 *
 *   SplitCharts.renderSpending(container, summary, { formatMoney })
 *     summary = SplitCategories.monthlySpend(...)
 */
(function (root) {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';

  // Palette hexes (light steps) → theme-aware CSS variables, so charts re-colour in dark mode.
  const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  function cssColor(hex) {
    const i = PALETTE.indexOf(String(hex).toLowerCase());
    return i < 0 ? hex : `var(--viz-${i + 1}, ${hex})`;
  }
  const el = (tag, attrs, parent) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  };
  const html = (tag, cls, parent, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  };

  /** Short axis labels in Indian units: ₹950, ₹12k, ₹1.5L. */
  function shortRupees(paise) {
    const r = paise / 100;
    const trim = (n) => n.toFixed(1).replace(/\.0$/, '');
    if (r >= 100000) return `₹${trim(r / 100000)}L`;
    if (r >= 1000) return `₹${trim(r / 1000)}k`;
    return `₹${Math.round(r)}`;
  }

  /** A "nice" axis maximum and step for 4–5 gridlines. */
  function niceScale(max) {
    if (max <= 0) return { top: 100, step: 25 };
    const raw = max / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
    return { top: Math.ceil(max / step) * step, step };
  }

  /** Column with only the top corners rounded (square at the baseline). */
  function topRoundedPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
  }

  function renderSpending(container, summary, opts) {
    const money = (opts && opts.formatMoney) || ((p) => String(p));
    container.replaceChildren();
    if (!summary.months.length) {
      const empty = html('div', 'empty', container);
      html('strong', null, empty, 'No spending yet');
      empty.appendChild(document.createTextNode('Add expenses to see where the money goes, month by month.'));
      return;
    }

    const wrap = html('div', 'chart-wrap', container);
    const tooltip = html('div', 'chart-tooltip', wrap);
    tooltip.setAttribute('role', 'status');
    tooltip.hidden = true;

    const width = Math.max(280, Math.round(wrap.clientWidth || container.clientWidth || 560));
    const height = 220;
    const pad = { top: 12, right: 8, bottom: 26, left: 46 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const { top, step } = niceScale(Math.max(...summary.months.map((m) => m.total)));
    const yOf = (v) => pad.top + plotH - (v / top) * plotH;

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'chart-svg', role: 'group',
      'aria-label': `${(opts && opts.bucketName) === 'Day' ? 'Daily' : 'Monthly'} spending by category, ${summary.months[0].label} to ${summary.months[summary.months.length - 1].label}` }, wrap);

    // recessive gridlines + y labels
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      el('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: v === 0 ? 'chart-baseline' : 'chart-grid' }, svg);
      const t = el('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end', class: 'chart-axis' }, svg);
      t.textContent = shortRupees(v);
    }

    const n = summary.months.length;
    const band = plotW / n;
    const barW = Math.max(6, Math.min(24, band * 0.56));
    const longest = Math.max(...summary.months.map((m) => m.label.length));
    const labelEvery = Math.max(1, Math.ceil((longest * 6.4 + 10) / band)); // ~6.4px per 11px glyph
    const GAP = 2;
    const columns = [];

    if (opts && opts.animate) svg.classList.add('enter'); // columns grow from the baseline, one after another

    summary.months.forEach((month, i) => {
      const cx = pad.left + band * i + band / 2;
      const g = el('g', { class: 'chart-col', style: `animation-delay:${Math.min(i * 45, 540)}ms` }, svg);
      const present = summary.series.filter((s) => month.byCategory[s.name] > 0);
      let cum = 0;
      present.forEach((s, k) => {
        const v = month.byCategory[s.name];
        const y1 = yOf(cum + v);
        const y0 = yOf(cum) - (k > 0 ? GAP : 0); // 2px surface gap above the segment below
        const h = Math.max(0, y0 - y1);
        cum += v;
        if (h <= 0) return;
        const isTop = k === present.length - 1;
        if (isTop) el('path', { d: topRoundedPath(cx - barW / 2, y1, barW, h, 4), style: `fill:${cssColor(s.color)}` }, g);
        else el('rect', { x: cx - barW / 2, y: y1, width: barW, height: h, style: `fill:${cssColor(s.color)}` }, g);
      });
      if ((n - 1 - i) % labelEvery === 0) {
        const t = el('text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'chart-axis' }, svg);
        t.textContent = month.label;
      }
      // hit target: the whole band, taller than the marks
      const hit = el('rect', { x: pad.left + band * i, y: pad.top, width: band, height: plotH, class: 'chart-hit', tabindex: 0,
        'aria-label': `${month.label}: ${money(month.total)}` + present.map((s) => `, ${s.name} ${money(month.byCategory[s.name])}`).join('') }, svg);
      columns.push({ g, hit, month, present, cx });
    });

    function show(col) {
      for (const c of columns) c.g.classList.toggle('dim', c !== col);
      tooltip.replaceChildren();
      html('div', 'tt-head', tooltip, col.month.label);
      const total = html('div', 'tt-row tt-total', tooltip);
      html('strong', null, total, money(col.month.total));
      html('span', null, total, 'total');
      for (const s of col.present.slice().reverse()) {
        const row = html('div', 'tt-row', tooltip);
        const key = html('i', 'tt-key', row);
        key.style.background = cssColor(s.color);
        html('strong', null, row, money(col.month.byCategory[s.name]));
        html('span', null, row, s.name);
      }
      tooltip.hidden = false;
      // beside the column (right if it fits, else left), never covering the marks it describes
      const scale = wrap.clientWidth / width;
      const x = col.cx * scale;
      const half = (barW / 2) * scale + 12;
      const tw = tooltip.offsetWidth;
      const leftSide = x + half + tw > wrap.clientWidth;
      tooltip.style.left = `${Math.max(0, leftSide ? x - half - tw : x + half)}px`;
      tooltip.style.top = `${pad.top}px`;
    }
    function hide() {
      for (const c of columns) c.g.classList.remove('dim');
      tooltip.hidden = true;
    }
    const onSelect = opts && opts.onSelect;
    for (const col of columns) {
      col.hit.addEventListener('pointerenter', () => show(col));
      col.hit.addEventListener('focus', () => show(col));
      col.hit.addEventListener('blur', hide);
      if (onSelect && col.month.total > 0) {
        col.hit.classList.add('selectable');
        col.hit.setAttribute('role', 'button');
        col.hit.setAttribute('aria-label', `${col.hit.getAttribute('aria-label')}. Show by day`);
        col.hit.addEventListener('click', () => onSelect(col.month));
        col.hit.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(col.month); }
        });
      }
    }
    svg.addEventListener('pointerleave', hide);

    // legend with totals (always present for ≥ 2 series; values in text ink, colour only on the key)
    const legend = html('ul', 'chart-legend', container);
    for (const s of summary.series) {
      const li = html('li', null, legend);
      const key = html('i', 'legend-key', li);
      key.style.background = cssColor(s.color);
      const name = html('span', 'legend-name', li, s.name);
      if (s.includes.length) name.title = `Also includes: ${s.includes.join(', ')}`;
      html('span', 'legend-value num', li, money(s.total));
      html('span', 'legend-share num', li, `${Math.round((s.total / summary.total) * 100)}%`);
    }

    // table view: every value reachable without hovering
    const details = html('details', 'chart-table', container);
    html('summary', null, details, 'Show as table');
    const scroller = html('div', 'table-scroll', details);
    const table = html('table', null, scroller);
    const head = html('tr', null, html('thead', null, table));
    html('th', null, head, (opts && opts.bucketName) || 'Month');
    for (const s of summary.series) html('th', null, head, s.name);
    html('th', null, head, 'Total');
    const body = html('tbody', null, table);
    for (const m of summary.months) {
      const tr = html('tr', null, body);
      html('th', null, tr, m.label);
      for (const s of summary.series) html('td', 'num', tr, m.byCategory[s.name] ? money(m.byCategory[s.name]) : '—');
      html('td', 'num', tr, money(m.total));
    }
    const foot = html('tr', null, html('tfoot', null, table));
    html('th', null, foot, 'Total');
    for (const s of summary.series) html('td', 'num', foot, money(s.total));
    html('td', 'num', foot, money(summary.total));
  }

  /** Arc path for a donut slice from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise). */
  function slicePath(cx, cy, r0, r1, a0, a1) {
    const pt = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = pt(r1, a0);
    const [x1, y1] = pt(r1, a1);
    const [x2, y2] = pt(r0, a1);
    const [x3, y3] = pt(r0, a0);
    return `M${x0},${y0}A${r1},${r1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
  }

  /**
   * Donut of parts of a whole, with a centre total, per-slice tooltip and a legend.
   *   items: [{ name, color, total, includes? }]  (zeros already dropped)
   */
  function renderDonut(container, data, opts) {
    const money = (opts && opts.formatMoney) || ((p) => String(p));
    container.replaceChildren();
    if (!data.items.length || data.total <= 0) {
      const empty = html('div', 'empty', container);
      html('strong', null, empty, (opts && opts.emptyTitle) || 'Nothing to show yet');
      empty.appendChild(document.createTextNode((opts && opts.emptyText) || 'Add expenses to see who spent what.'));
      return;
    }

    const layout = html('div', 'donut-layout', container);
    const wrap = html('div', 'donut-wrap', layout);
    const size = 184;
    const c = size / 2;
    const r1 = 88;
    const r0 = 58;
    const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut-svg', role: 'group',
      'aria-label': `${(opts && opts.title) || 'Share'}: ${data.items.map((it) => `${it.name} ${money(it.total)}`).join(', ')}` }, wrap);
    const tooltip = html('div', 'chart-tooltip donut-tooltip', wrap);
    tooltip.hidden = true;

    const pct = (v) => Math.round((v / data.total) * 1000) / 10;
    const slices = [];
    let angle = 0;
    if (opts && opts.animate) svg.classList.add('enter');
    for (const [k, it] of data.items.entries()) {
      const sweep = (it.total / data.total) * Math.PI * 2;
      // a single 100% slice can't be one arc: draw it as two halves
      const d = sweep >= Math.PI * 2 - 1e-6
        ? slicePath(c, c, r0, r1, 0, Math.PI) + slicePath(c, c, r0, r1, Math.PI, Math.PI * 2)
        : slicePath(c, c, r0, r1, angle, angle + sweep);
      const path = el('path', { d, style: `fill:${cssColor(it.color)};animation-delay:${k * 70}ms`, class: 'donut-slice', tabindex: 0,
        'aria-label': `${it.name}: ${money(it.total)}, ${pct(it.total)}%` }, svg);
      slices.push({ path, it, mid: angle + sweep / 2 });
      angle += sweep;
    }

    const centre = el('text', { x: c, y: c - 4, 'text-anchor': 'middle', class: 'donut-total' }, svg);
    centre.textContent = money(data.total);
    const caption = el('text', { x: c, y: c + 16, 'text-anchor': 'middle', class: 'donut-caption' }, svg);
    caption.textContent = (opts && opts.centerLabel) || 'total';

    function show(s) {
      for (const o of slices) o.path.classList.toggle('dim', o !== s);
      tooltip.replaceChildren();
      const row = html('div', 'tt-row', tooltip);
      html('strong', null, row, money(s.it.total));
      html('span', null, row, `${pct(s.it.total)}%`);
      html('div', 'tt-head', tooltip, s.it.name);
      if (s.it.includes) html('div', 'tt-sub', tooltip, s.it.includes.join(', '));
      tooltip.hidden = false;
      // outside the ring, on the slice's side
      const scale = wrap.clientWidth / size;
      const x = (c + (r1 + 10) * Math.sin(s.mid)) * scale;
      const y = (c - (r1 + 10) * Math.cos(s.mid)) * scale;
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      // keep it inside the chart area (the layout box), even when the ring is centred on a phone
      const box = layout.getBoundingClientRect();
      const self = wrap.getBoundingClientRect();
      const minLeft = box.left - self.left;
      const maxLeft = box.right - self.left - tw;
      const want = Math.sin(s.mid) >= 0 ? x : x - tw;
      tooltip.style.left = `${Math.max(minLeft, Math.min(want, maxLeft))}px`;
      tooltip.style.top = `${Math.max(-th / 2, Math.min(y - th / 2, wrap.clientHeight - th / 2))}px`;
    }
    function hide() {
      for (const o of slices) o.path.classList.remove('dim');
      tooltip.hidden = true;
    }
    for (const s of slices) {
      s.path.addEventListener('pointerenter', () => show(s));
      s.path.addEventListener('focus', () => show(s));
      s.path.addEventListener('blur', hide);
    }
    svg.addEventListener('pointerleave', hide);

    const legend = html('ul', 'donut-legend', layout);
    for (const it of data.items) {
      const li = html('li', null, legend);
      const key = html('i', 'legend-key', li);
      key.style.background = cssColor(it.color);
      const name = html('span', 'legend-name', li, it.name);
      if (it.includes) name.title = it.includes.join(', ');
      html('span', 'legend-value num', li, money(it.total));
      html('span', 'legend-share num', li, `${Math.round((it.total / data.total) * 100)}%`);
    }
  }

  root.SplitCharts = { renderSpending, renderDonut, shortRupees, niceScale, cssColor };
})(typeof self !== 'undefined' ? self : this);
