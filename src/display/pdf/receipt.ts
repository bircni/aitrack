import PDFDocument from 'pdfkit';

import { toLocalDateString } from '../../data/dayMap.js';
import type { UsageReport } from '../../data/usageReport.js';
import { fmt, fmtUSD } from '../format.js';

const PAGE_WIDTH = 360; // narrow, receipt-like
const MARGIN = 22;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT = 'Courier';
const FONT_BOLD = 'Courier-Bold';

// Three-column layout: model name (left), tokens, price (both right-aligned).
const TOKENS_W = 62;
const PRICE_W = 62;
const LEFT_W = CONTENT_WIDTH - TOKENS_W - PRICE_W;
const ROW_HEIGHT = 13;

// Courier is a PDF standard font with WinAnsi (Latin-1) encoding, so any
// codepoint above 0xFF renders as a wrong/notdef glyph. Map the few unicode
// characters we deliberately emit (the "→" in window labels) to ASCII, then
// drop anything else outside the encoding so unexpected model names degrade to
// a visible placeholder instead of silent garbage.
function asciiSafe(text: string): string {
  let out = '';
  for (const ch of text.replaceAll('→', '->')) {
    const code = ch.codePointAt(0) ?? 0;
    // Keep printable Latin-1 (0x20–0xFF); replace anything else with a visible
    // placeholder so it can't render as a wrong/notdef glyph.
    out += code >= 0x20 && code <= 0xff ? ch : '?';
  }
  return out;
}

// Local-time stamp (YYYY-MM-DD HH:MM:SS) so the receipt's "generated at" line
// matches the local calendar dates used throughout the window labels.
export function localTimestamp(at: Date): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${toLocalDateString(at)} ${time}`;
}

function priceCell(hasCost: boolean, costUSD: number): string {
  return hasCost ? fmtUSD(costUSD) : '-';
}

function divider(doc: PDFKit.PDFDocument): void {
  const y = doc.y + 2;
  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.5)
    .stroke();
  doc.y = y + 4;
}

/** Draw one model/tokens/price row on a single line, never wrapping. */
function row(
  doc: PDFKit.PDFDocument,
  left: string,
  tokens: string,
  price: string,
  bold = false,
): void {
  const y = doc.y;
  doc.font(bold ? FONT_BOLD : FONT).fontSize(9);
  doc.text(asciiSafe(left), MARGIN, y, { width: LEFT_W, ellipsis: true, lineBreak: false });
  doc.text(tokens, MARGIN + LEFT_W, y, { width: TOKENS_W, align: 'right', lineBreak: false });
  doc.text(price, MARGIN + LEFT_W + TOKENS_W, y, {
    width: PRICE_W,
    align: 'right',
    lineBreak: false,
  });
  doc.y = y + ROW_HEIGHT;
}

/** Draw the full receipt onto an already-created document. */
function drawReceipt(doc: PDFKit.PDFDocument, report: UsageReport, generatedAt: Date): void {
  // Header
  doc.font(FONT_BOLD).fontSize(16).text('aitrack', { align: 'center' });
  doc.font(FONT).fontSize(9).text('AI USAGE RECEIPT', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(8).text(asciiSafe(report.windowLabel), { align: 'center' });
  doc.text(localTimestamp(generatedAt), { align: 'center' });
  doc.moveDown(0.5);
  divider(doc);
  doc.moveDown(0.3);

  // Line items grouped by provider
  for (const provider of report.providers) {
    doc
      .font(FONT_BOLD)
      .fontSize(9)
      .text(asciiSafe(provider.label), MARGIN, doc.y, { width: CONTENT_WIDTH });
    for (const item of provider.rows) {
      row(doc, `  ${item.model}`, fmt(item.tokens), priceCell(item.hasCost, item.costUSD));
    }
    row(
      doc,
      '  subtotal',
      fmt(provider.subtotalTokens),
      priceCell(provider.subtotalHasCost, provider.subtotalCostUSD),
      true,
    );
    doc.moveDown(0.4);
  }

  divider(doc);
  doc.moveDown(0.2);
  row(
    doc,
    'TOTAL',
    fmt(report.totals.tokens),
    priceCell(report.totals.hasCost, report.totals.costUSD),
    true,
  );
  divider(doc);

  doc.moveDown(1);
  doc
    .font(FONT)
    .fontSize(7)
    .text('Costs are API-equivalent estimates. Thank you for shipping!', MARGIN, doc.y, {
      width: CONTENT_WIDTH,
      align: 'center',
    });
}

// Measure the exact content height by laying the receipt out on a throwaway
// page tall enough that nothing auto-paginates, then reading where the cursor
// ends up. Sizing the real page to this avoids both a blank trailing page
// (under-estimate) and dead whitespace (over-estimate) that a static guess hits.
function contentHeight(report: UsageReport, generatedAt: Date): number {
  const probe = new PDFDocument({ size: [PAGE_WIDTH, 100_000], margin: MARGIN });
  drawReceipt(probe, report, generatedAt);
  return Math.ceil(probe.y) + MARGIN;
}

/**
 * Render an itemized, receipt-style PDF for a usage report. Returns the PDF as
 * a Buffer so callers can write it to disk (or a stream) however they like.
 */
export function renderReceiptPdf(
  report: UsageReport,
  generatedAt: Date = new Date(),
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, contentHeight(report, generatedAt)],
    margin: MARGIN,
    info: { Title: `aitrack usage receipt - ${asciiSafe(report.windowLabel)}` },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  drawReceipt(doc, report, generatedAt);

  doc.end();
  return done;
}
