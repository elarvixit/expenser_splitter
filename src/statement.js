/*
 * Splitter — PDF statement for one group (downloaded as a file).
 * jsPDF + jspdf-autotable are loaded from cdnjs only when the user exports, pinned with
 * Subresource Integrity so a tampered copy is refused.
 *
 *   await SplitStatement.download(group, deps)
 *   deps = { calculateBalances, suggestSettlements, formatPaise, categoryOf, monthlySpend }
 *
 * The PDF's standard fonts have no ₹ glyph, so amounts read "Rs. 1,234.56".
 */
(function (root) {
  'use strict';

  const LIBS = [
    { src: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
      integrity: 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk' },
    { src: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
      integrity: 'sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3' },
  ];
  let loading = null;

  function loadLibs() {
    if (root.jspdf && root.jspdf.jsPDF && root.jspdf.jsPDF.API.autoTable) return Promise.resolve();
    if (!loading) {
      loading = LIBS.reduce((chain, lib) => chain.then(() => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = lib.src;
        s.integrity = lib.integrity;
        s.crossOrigin = 'anonymous';
        s.referrerPolicy = 'no-referrer';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load the PDF library — check your connection'));
        document.head.appendChild(s);
      })), Promise.resolve()).catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  // Standard PDF fonts cover Latin-1 only.
  const pdfText = (s) => String(s == null ? '' : s)
    .replace(/₹/g, 'Rs. ').replace(/[−–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/→/g, '->').replace(/[^\x00-\xff]/g, '?');

  const ORANGE = [234, 88, 12];
  const INK = [28, 21, 18];
  const MUTED = [138, 125, 116];
  const WASH = [255, 247, 237];

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fileName(group) {
    const safe = String(group.groupName || 'group').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'group';
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${safe}-statement-${ymd}.pdf`;
  }

  /** Build the jsPDF document (exported for testing). */
  function build(group, deps) {
    const { calculateBalances, suggestSettlements, formatPaise, categoryOf, monthlySpend } = deps;
    const money = (p, opts) => pdfText(formatPaise(p, opts));
    const nameOf = (id) => pdfText((group.members.find((m) => m.id === id) || { name: 'Unknown' }).name);
    const { balances } = calculateBalances(group);
    const transfers = suggestSettlements(balances);
    const spend = monthlySpend(group.expenses, { maxMonths: 1200 });

    const doc = new root.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const M = 40;
    doc.setProperties({ title: `${pdfText(group.groupName)} - statement`, creator: 'Splitter' });

    // header band
    doc.setFillColor(...ORANGE);
    doc.rect(0, 0, W, 96, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('SPLITTER · GROUP STATEMENT', M, 32);
    doc.setFontSize(22);
    doc.text(pdfText(group.groupName), M, 60);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const dates = group.expenses.map((e) => Date.parse(e.createdAt)).filter(Boolean).sort((a, b) => a - b);
    const period = dates.length ? `${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}` : 'No expenses yet';
    doc.text(pdfText(`${period}  ·  Generated ${fmtDate(new Date().toISOString())}`), M, 80);

    // summary tiles
    const spent = group.expenses.reduce((a, e) => a + e.amount, 0);
    const paidBack = group.settlements.reduce((a, s) => a + s.amount, 0);
    const outstanding = Object.values(balances).reduce((a, v) => a + (v > 0 ? v : 0), 0);
    const tiles = [['Total spent', money(spent)], ['Payments recorded', money(paidBack)],
      ['Still owed', money(outstanding)], ['People', String(group.members.length)]];
    const tileW = (W - M * 2 - 12 * 3) / 4;
    tiles.forEach(([label, value], i) => {
      const x = M + i * (tileW + 12);
      doc.setFillColor(...WASH);
      doc.setDrawColor(254, 215, 170);
      doc.roundedRect(x, 112, tileW, 52, 6, 6, 'FD');
      doc.setTextColor(...MUTED);
      doc.setFontSize(9);
      doc.text(label, x + 10, 130);
      doc.setTextColor(...INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text(value, x + 10, 151);
      doc.setFont('helvetica', 'normal');
    });

    let y = 188;
    const heading = (text) => {
      if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = 50; }
      doc.setTextColor(...INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text(text, M, y);
      doc.setFont('helvetica', 'normal');
      y += 8;
    };
    const table = (head, body, columnStyles) => {
      doc.autoTable({
        startY: y, head: [head], body, margin: { left: M, right: M },
        styles: { font: 'helvetica', fontSize: 9, textColor: INK, cellPadding: 5, lineColor: [242, 230, 218], lineWidth: 0.5 },
        headStyles: { fillColor: ORANGE, textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: WASH },
        columnStyles: columnStyles || {},
      });
      y = doc.lastAutoTable.finalY + 26;
    };
    const right = { halign: 'right' };

    // balances per person
    heading('Balances');
    const rows = group.members.map((m) => {
      const paid = group.expenses.filter((e) => e.paidBy === m.id).reduce((a, e) => a + e.amount, 0);
      const share = group.expenses.reduce((a, e) => a + ((e.splits.find((s) => s.memberId === m.id) || {}).amount || 0), 0);
      const sent = group.settlements.filter((s) => s.from === m.id).reduce((a, s) => a + s.amount, 0);
      const got = group.settlements.filter((s) => s.to === m.id).reduce((a, s) => a + s.amount, 0);
      const b = balances[m.id];
      const status = b > 0 ? `gets back ${money(b)}` : b < 0 ? `owes ${money(-b)}` : 'settled up';
      return [pdfText(m.name), money(paid), money(share), money(sent), money(got), status];
    });
    table(['Person', 'Paid', 'Share', 'Payments sent', 'Payments received', 'Balance'], rows,
      { 1: right, 2: right, 3: right, 4: right, 5: { halign: 'right', fontStyle: 'bold' } });

    // settle up
    heading('Settle up');
    if (transfers.length) {
      table(['From', 'To', 'Amount'], transfers.map((t) => [nameOf(t.from), nameOf(t.to), money(t.amount)]), { 2: right });
    } else {
      doc.setFontSize(10);
      doc.setTextColor(...MUTED);
      doc.text('Everyone is settled up. No payments needed.', M, y + 10);
      y += 36;
    }

    // spending by category and by month
    if (spend.total > 0) {
      heading('Spending by category');
      table(['Category', 'Amount', 'Share'], spend.series.map((s) => [
        pdfText(s.name + (s.includes.length ? ` (incl. ${s.includes.join(', ')})` : '')),
        money(s.total), `${Math.round((s.total / spend.total) * 100)}%`,
      ]), { 1: right, 2: right });
      heading('Spending by month');
      table(['Month', ...spend.series.map((s) => pdfText(s.name)), 'Total'], spend.months.map((m) => [
        pdfText(m.label), ...spend.series.map((s) => (m.byCategory[s.name] ? money(m.byCategory[s.name]) : '-')), money(m.total),
      ]), Object.fromEntries(spend.series.map((_, i) => [i + 1, right]).concat([[spend.series.length + 1, { halign: 'right', fontStyle: 'bold' }]])));
    }

    // every expense
    heading('Expenses');
    const expenses = group.expenses.slice().sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
    if (expenses.length) {
      table(['Date', 'Description', 'Category', 'Paid by', 'Split', 'Amount'], expenses.map((e) => {
        const people = e.splits.filter((s) => s.amount > 0);
        const split = e.splitMode === 'equal'
          ? `Equally: ${people.map((s) => nameOf(s.memberId)).join(', ')}`
          : people.map((s) => `${nameOf(s.memberId)} ${money(s.amount).replace('Rs. ', '')}`).join(', ');
        return [fmtDate(e.createdAt), pdfText(e.description), pdfText(categoryOf(e)), nameOf(e.paidBy), split, money(e.amount)];
      }), { 0: { cellWidth: 72 }, 4: { cellWidth: 140 }, 5: { halign: 'right', fontStyle: 'bold' } });
    } else {
      doc.setFontSize(10);
      doc.setTextColor(...MUTED);
      doc.text('No expenses recorded.', M, y + 10);
      y += 36;
    }

    // payments
    if (group.settlements.length) {
      heading('Payments');
      const pays = group.settlements.slice().sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
      table(['Date', 'From', 'To', 'Note', 'Amount'], pays.map((s) => [
        fmtDate(s.createdAt), nameOf(s.from), nameOf(s.to), pdfText(s.note || ''), money(s.amount),
      ]), { 4: right });
    }

    // footer on every page
    const pages = doc.internal.getNumberOfPages();
    const H = doc.internal.pageSize.getHeight();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(pdfText(`Splitter statement · ${group.groupName} · amounts in Indian rupees`), M, H - 22);
      doc.text(`Page ${p} of ${pages}`, W - M, H - 22, { align: 'right' });
    }
    return doc;
  }

  async function download(group, deps) {
    await loadLibs();
    const doc = build(group, deps);
    doc.save(fileName(group));
    return fileName(group);
  }

  root.SplitStatement = { download, build, loadLibs, fileName, pdfText };
})(typeof self !== 'undefined' ? self : this);
