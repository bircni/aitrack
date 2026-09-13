//! PDF receipt rendering using printpdf.

use crate::data::usage_report::UsageReport;
use crate::format::{fmt, fmt_usd_cost};
use crate::providers::provider_label;
use chrono::{DateTime, Local};
use printpdf::ops::PdfFontHandle;
use printpdf::*;

const PAGE_WIDTH_MM: f32 = 127.0; // ~360 points, narrow receipt-like
const MARGIN_MM: f32 = 7.8; // ~22 points
const CONTENT_WIDTH_MM: f32 = PAGE_WIDTH_MM - MARGIN_MM * 2.0;

const TOKENS_W_MM: f32 = 22.0; // ~62 points
const PRICE_W_MM: f32 = 22.0; // ~62 points
const LEFT_W_MM: f32 = CONTENT_WIDTH_MM - TOKENS_W_MM - PRICE_W_MM;
const ROW_HEIGHT_MM: f32 = 4.6; // ~13 points

fn mm_to_pt(mm: f32) -> Pt {
    Mm(mm).into_pt()
}

fn y_from_top(page_height_mm: f32, y_top_mm: f32) -> Mm {
    Mm(page_height_mm - y_top_mm)
}

fn text_color() -> Color {
    Color::Rgb(Rgb {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        icc_profile: None,
    })
}

fn divider_color() -> Color {
    Color::Rgb(Rgb {
        r: 0.88,
        g: 0.88,
        b: 0.88,
        icc_profile: None,
    })
}

fn push_text(
    ops: &mut Vec<Op>,
    page_height_mm: f32,
    font: BuiltinFont,
    size_pt: f32,
    x_mm: f32,
    y_top_mm: f32,
    text: &str,
) {
    ops.extend([
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point::new(Mm(x_mm), y_from_top(page_height_mm, y_top_mm)),
        },
        Op::SetFont {
            font: PdfFontHandle::Builtin(font),
            size: Pt(size_pt),
        },
        Op::SetLineHeight { lh: Pt(size_pt) },
        Op::SetFillColor { col: text_color() },
        Op::ShowText {
            items: vec![TextItem::Text(text.to_string())],
        },
        Op::EndTextSection,
    ]);
}

fn push_divider(ops: &mut Vec<Op>, page_height_mm: f32, y_top_mm: f32) {
    let height_mm = 0.5;
    let y_bottom_mm = page_height_mm - y_top_mm - height_mm;
    ops.extend([
        Op::SetFillColor {
            col: divider_color(),
        },
        Op::DrawRectangle {
            rectangle: Rect::from_xywh(
                mm_to_pt(MARGIN_MM),
                mm_to_pt(y_bottom_mm),
                mm_to_pt(CONTENT_WIDTH_MM),
                mm_to_pt(height_mm),
            ),
        },
    ]);
}

/// ASCII-safe: Courier is a PDF standard font with WinAnsi (Latin-1) encoding.
/// Map unicode characters to ASCII equivalents, drop anything outside Latin-1.
fn ascii_safe(text: &str) -> String {
    let mut out = String::new();
    for ch in text.replace('→', "->").chars() {
        let code = ch as u32;
        // Keep printable Latin-1 (0x20–0xFF); replace anything else
        if (0x20..=0xFF).contains(&code) {
            out.push(ch);
        } else {
            out.push('?');
        }
    }
    out
}

fn local_timestamp(at: &DateTime<Local>) -> String {
    at.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn price_cell(has_cost: bool, cost_usd: f64) -> String {
    if has_cost {
        fmt_usd_cost(cost_usd)
    } else {
        "-".to_string()
    }
}

/// Render a usage report as a PDF receipt.
pub fn render_receipt_pdf(
    report: &UsageReport,
    generated_at: Option<DateTime<Local>>,
) -> anyhow::Result<Vec<u8>> {
    let generated = generated_at.unwrap_or_else(Local::now);

    // First pass: measure content height
    let mut y_cursor = 0.0_f32;

    // Header
    y_cursor += 16.0 + 9.0 + 4.0 + 8.0 + 8.0 + 4.0 + 2.0 + 4.0 + 3.0; // ~58mm

    // Provider sections
    for provider in &report.providers {
        y_cursor += 9.0; // provider label
        y_cursor += ROW_HEIGHT_MM * provider.rows.len() as f32; // model rows
        y_cursor += ROW_HEIGHT_MM; // subtotal
        y_cursor += 4.0; // spacing
    }

    // Footer
    y_cursor += 2.0 + 4.0 + 2.0 + ROW_HEIGHT_MM + 2.0 + 10.0 + 7.0; // ~30mm

    let page_height_mm = (y_cursor + MARGIN_MM * 2.0).max(100.0);
    let doc_title = format!(
        "aitrack usage receipt - {}",
        ascii_safe(&report.window_label)
    );

    let mut ops = Vec::new();
    let mut y = MARGIN_MM;

    // Header
    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::CourierBold,
        16.0,
        PAGE_WIDTH_MM / 2.0,
        y,
        &ascii_safe("aitrack"),
    );
    y += 16.0 + 2.0;

    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::Courier,
        9.0,
        PAGE_WIDTH_MM / 2.0,
        y,
        &ascii_safe("AI USAGE RECEIPT"),
    );
    y += 9.0 + 4.0;

    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::Courier,
        8.0,
        PAGE_WIDTH_MM / 2.0,
        y,
        &ascii_safe(&report.window_label),
    );
    y += 8.0 + 2.0;

    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::Courier,
        8.0,
        PAGE_WIDTH_MM / 2.0,
        y,
        &ascii_safe(&local_timestamp(&generated)),
    );
    y += 8.0 + 4.0;

    push_divider(&mut ops, page_height_mm, y);
    y += 4.0;

    // Provider sections
    for provider in &report.providers {
        let label = provider_label(&provider.key);
        push_text(
            &mut ops,
            page_height_mm,
            BuiltinFont::CourierBold,
            9.0,
            MARGIN_MM,
            y,
            &ascii_safe(&label),
        );
        y += ROW_HEIGHT_MM;

        for row in &provider.rows {
            let model_text = format!("  {}", row.model);
            let tokens_text = fmt(row.tokens);
            let price_text = price_cell(row.has_cost, row.cost_usd);

            push_text(
                &mut ops,
                page_height_mm,
                BuiltinFont::Courier,
                9.0,
                MARGIN_MM,
                y,
                &ascii_safe(&model_text),
            );
            push_text(
                &mut ops,
                page_height_mm,
                BuiltinFont::Courier,
                9.0,
                MARGIN_MM + LEFT_W_MM,
                y,
                &ascii_safe(&tokens_text),
            );
            push_text(
                &mut ops,
                page_height_mm,
                BuiltinFont::Courier,
                9.0,
                MARGIN_MM + LEFT_W_MM + TOKENS_W_MM,
                y,
                &ascii_safe(&price_text),
            );
            y += ROW_HEIGHT_MM;
        }

        let subtotal_text = "  subtotal";
        let subtotal_tokens = fmt(provider.subtotal_tokens);
        let subtotal_price = price_cell(provider.subtotal_has_cost, provider.subtotal_cost_usd);

        push_text(
            &mut ops,
            page_height_mm,
            BuiltinFont::CourierBold,
            9.0,
            MARGIN_MM,
            y,
            subtotal_text,
        );
        push_text(
            &mut ops,
            page_height_mm,
            BuiltinFont::CourierBold,
            9.0,
            MARGIN_MM + LEFT_W_MM,
            y,
            &ascii_safe(&subtotal_tokens),
        );
        push_text(
            &mut ops,
            page_height_mm,
            BuiltinFont::CourierBold,
            9.0,
            MARGIN_MM + LEFT_W_MM + TOKENS_W_MM,
            y,
            &ascii_safe(&subtotal_price),
        );
        y += ROW_HEIGHT_MM + 4.0;
    }

    push_divider(&mut ops, page_height_mm, y);
    y += 4.0;

    let total_tokens = fmt(report.totals.tokens);
    let total_price = price_cell(report.totals.has_cost, report.totals.cost_usd);

    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::CourierBold,
        9.0,
        MARGIN_MM,
        y,
        "TOTAL",
    );
    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::CourierBold,
        9.0,
        MARGIN_MM + LEFT_W_MM,
        y,
        &ascii_safe(&total_tokens),
    );
    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::CourierBold,
        9.0,
        MARGIN_MM + LEFT_W_MM + TOKENS_W_MM,
        y,
        &ascii_safe(&total_price),
    );
    y += ROW_HEIGHT_MM + 2.0;

    push_divider(&mut ops, page_height_mm, y);
    y += 10.0;

    push_text(
        &mut ops,
        page_height_mm,
        BuiltinFont::Courier,
        7.0,
        PAGE_WIDTH_MM / 2.0,
        y,
        &ascii_safe("Costs are API-equivalent estimates. Thank you for shipping!"),
    );

    let mut doc = PdfDocument::new(&doc_title);
    doc.with_pages(vec![PdfPage::new(
        Mm(PAGE_WIDTH_MM),
        Mm(page_height_mm),
        ops,
    )]);

    let mut warnings = Vec::new();
    let bytes = doc.save(&PdfSaveOptions::default(), &mut warnings);
    if !warnings.is_empty() {
        eprintln!("PDF save warnings: {:?}", warnings);
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::usage_report::{UsageReportProvider, UsageReportRow, UsageReportTotals};

    #[test]
    fn test_ascii_safe() {
        assert_eq!(ascii_safe("hello"), "hello");
        assert_eq!(ascii_safe("test→arrow"), "test->arrow");
        assert_eq!(ascii_safe("emoji😀test"), "emoji?test");
    }

    #[test]
    fn test_render_receipt_pdf() {
        let report = UsageReport {
            window_label: "Test Week".to_string(),
            providers: vec![UsageReportProvider {
                key: "claude_code".to_string(),
                label: "Claude Code".to_string(),
                rows: vec![UsageReportRow {
                    model: "claude-3.5-sonnet".to_string(),
                    input_tokens: 1000,
                    output_tokens: 500,
                    tokens: 1500,
                    cached_input_tokens: 100,
                    has_cached: true,
                    cost_usd: 0.05,
                    has_cost: true,
                }],
                subtotal_tokens: 1500,
                subtotal_cost_usd: 0.05,
                subtotal_has_cost: true,
            }],
            totals: UsageReportTotals {
                input_tokens: 1000,
                output_tokens: 500,
                tokens: 1500,
                cached_input_tokens: 100,
                has_cached: true,
                cost_usd: 0.05,
                has_cost: true,
            },
            row_count: 1,
        };

        let result = render_receipt_pdf(&report, None);
        assert!(result.is_ok());
        let pdf_bytes = result.unwrap();
        assert!(pdf_bytes.len() > 100);
        assert!(pdf_bytes.starts_with(b"%PDF"));
    }
}
