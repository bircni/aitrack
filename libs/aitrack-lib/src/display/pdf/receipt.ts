import PDFDocument from 'pdfkit';

import { toLocalDateString } from '../../data/dayMap.js';
import type { UsageReport } from '../../data/usageReport.js';
import { fmt, fmtUSD, unpricedFootnote } from '../format.js';

const PAGE_WIDTH = 360; // narrow, receipt-like
const MARGIN = 22;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT = 'Courier';
const FONT_BOLD = 'Courier-Bold';

const TOKENS_W = 62;
const PRICE_W = 62;
const LEFT_W = CONTENT_WIDTH - TOKENS_W - PRICE_W;
const ROW_HEIGHT = 13;

// Courier is WinAnsi (Latin-1): map "→" and replace other codepoints with "?" instead of notdef glyphs.
function asciiSafe(text: string): string {
  let out = '';
  for (const ch of text.replaceAll('→', '->')) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0xff ? ch : '?';
  }
  return out;
}

/** Local time, to match the local calendar dates in the window labels. */
export function localTimestamp(at: Date): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${toLocalDateString(at)} ${time}`;
}

function priceCell(hasCost: boolean, costUSD: number): string {
  return hasCost ? fmtUSD(costUSD) : '-';
}

function divider(document: PDFKit.PDFDocument): void {
  const y = document.y + 2;
  document
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.5)
    .stroke();
  document.y = y + 4;
}

/** Draw one model/tokens/price row on a single line, never wrapping. */
function row(
  document: PDFKit.PDFDocument,
  left: string,
  tokens: string,
  price: string,
  bold = false,
): void {
  const y = document.y;
  document.font(bold ? FONT_BOLD : FONT).fontSize(9);
  document.text(asciiSafe(left), MARGIN, y, { width: LEFT_W, ellipsis: true, lineBreak: false });
  document.text(tokens, MARGIN + LEFT_W, y, { width: TOKENS_W, align: 'right', lineBreak: false });
  document.text(price, MARGIN + LEFT_W + TOKENS_W, y, {
    width: PRICE_W,
    align: 'right',
    lineBreak: false,
  });
  document.y = y + ROW_HEIGHT;
}

function drawReceipt(document: PDFKit.PDFDocument, report: UsageReport, generatedAt: Date): void {
  document.font(FONT_BOLD).fontSize(16).text('aitrack', { align: 'center' });
  document.font(FONT).fontSize(9).text('AI USAGE RECEIPT', { align: 'center' });
  document.moveDown(0.5);
  document.fontSize(8).text(asciiSafe(report.windowLabel), { align: 'center' });
  document.text(localTimestamp(generatedAt), { align: 'center' });
  document.moveDown(0.5);
  divider(document);
  document.moveDown(0.3);

  for (const provider of report.providers) {
    document
      .font(FONT_BOLD)
      .fontSize(9)
      .text(asciiSafe(provider.label), MARGIN, document.y, { width: CONTENT_WIDTH });
    for (const item of provider.rows) {
      row(document, `  ${item.model}`, fmt(item.tokens), priceCell(item.hasCost, item.costUSD));
    }
    row(
      document,
      '  subtotal',
      fmt(provider.subtotalTokens),
      priceCell(provider.subtotalHasCost, provider.subtotalCostUSD),
      true,
    );
    document.moveDown(0.4);
  }

  divider(document);
  document.moveDown(0.2);
  row(
    document,
    'TOTAL',
    fmt(report.totals.tokens),
    priceCell(report.totals.hasCost, report.totals.costUSD),
    true,
  );
  divider(document);

  const note = [
    report.totals.hasCost && report.totals.hasUnpricedTokens
      ? 'Partial estimate: some usage is unpriced.'
      : null,
    unpricedFootnote(report.totals.unpricedModels),
  ]
    .filter((line) => line !== null)
    .join(' ');
  if (note !== '') {
    document.font(FONT).fontSize(8).text(asciiSafe(note), MARGIN, document.y, {
      width: CONTENT_WIDTH,
    });
  }
  document.moveDown(1);
  document
    .font(FONT)
    .fontSize(7)
    .text('Costs are API-equivalent estimates. Thank you for shipping!', MARGIN, document.y, {
      width: CONTENT_WIDTH,
      align: 'center',
    });
}

// Laid out once on a page too tall to paginate, so the real page fits with no blank tail.
function contentHeight(report: UsageReport, generatedAt: Date): number {
  const probe = new PDFDocument({ size: [PAGE_WIDTH, 100_000], margin: MARGIN });
  drawReceipt(probe, report, generatedAt);
  return Math.ceil(probe.y) + MARGIN;
}

export function renderReceiptPdf(
  report: UsageReport,
  generatedAt: Date = new Date(),
): Promise<Buffer> {
  const document = new PDFDocument({
    size: [PAGE_WIDTH, contentHeight(report, generatedAt)],
    margin: MARGIN,
    info: { Title: `aitrack usage receipt - ${asciiSafe(report.windowLabel)}` },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    document.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    document.on('error', reject);
  });

  drawReceipt(document, report, generatedAt);

  document.end();
  return done;
}
