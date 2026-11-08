//! Box-drawn tables for the terminal, measured in UTF-16 units as 4.x pads.

use super::format::pad;
use super::style::{self, BOLD, BOLD_CYAN, BOLD_WHITE, DIM, GRAY, Style};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug)]
pub struct Column<'a> {
    pub header: &'a str,
    pub align: Align,
}

#[derive(Clone, Copy, Debug)]
pub struct TableStyle {
    pub border: Style,
    pub header: Style,
    pub total: Style,
}

#[must_use]
pub const fn default_table_style(dark: bool) -> TableStyle {
    if dark {
        TableStyle { border: GRAY, header: BOLD_WHITE, total: BOLD_CYAN }
    } else {
        TableStyle { border: DIM, header: BOLD, total: BOLD }
    }
}

/// A total row and the style it is drawn in.
pub type Footer<'a> = (&'a [String], fn(&str) -> String);

pub struct TableOptions<'a> {
    pub style: TableStyle,
    pub color: bool,
    pub footer: Option<&'a [String]>,
    /// Defaults to the style's total.
    pub footer_style: Option<&'a dyn Fn(&str) -> String>,
    pub first_column_style: Option<Style>,
}

/// The default light style, coloured as stdout allows; `footer` pairs the total row with its style.
#[must_use]
pub fn render_terminal_table(columns: &[Column<'_>], rows: &[Vec<String>], footer: Option<Footer<'_>>) -> String {
    let paint = footer.map(|(_, paint)| paint);
    render_table(
        columns,
        rows,
        &TableOptions {
            style: default_table_style(false),
            color: style::enabled(),
            footer: footer.map(|(cells, _)| cells),
            footer_style: paint.as_ref().map(|p| p as &dyn Fn(&str) -> String),
            first_column_style: None,
        },
    )
}

#[must_use]
pub fn render_table(columns: &[Column<'_>], rows: &[Vec<String>], options: &TableOptions<'_>) -> String {
    let len = |s: &str| s.encode_utf16().count();
    let cell = |row: &[String], i: usize| row.get(i).map_or("", String::as_str).to_owned();
    let widths: Vec<usize> = columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            rows.iter()
                .map(Vec::as_slice)
                .chain(options.footer)
                .map(|row| len(&cell(row, i)))
                .fold(len(col.header), usize::max)
        })
        .collect();
    let border = |text: &str| options.style.border.paint(text, options.color);
    let h_line = |left: &str, mid: &str, right: &str| {
        let segments: Vec<String> = widths.iter().map(|w| "─".repeat(w + 2)).collect();
        border(&format!("{left}{}{right}", segments.join(mid)))
    };
    let render_row = |cells: &[String], row_style: &dyn Fn(&str, usize) -> String| {
        let rendered: Vec<String> = (0..columns.len())
            .map(|i| {
                let padded = pad(&cell(cells, i), widths[i], columns[i].align == Align::Left);
                format!(" {} ", row_style(&padded, i))
            })
            .collect();
        format!("{}{}{}", border("│"), rendered.join(&border("│")), border("│"))
    };

    let headers: Vec<String> = columns.iter().map(|c| c.header.to_owned()).collect();
    let header = |text: &str, _: usize| options.style.header.paint(text, options.color);
    let body = |text: &str, i: usize| match options.first_column_style {
        Some(style) if i == 0 => style.paint(text, options.color),
        _ => text.to_owned(),
    };
    let mut lines = vec![h_line("┌", "┬", "┐"), render_row(&headers, &header), h_line("├", "┼", "┤")];
    lines.extend(rows.iter().map(|row| render_row(row, &body)));
    if let Some(footer) = options.footer {
        let total = |text: &str, _: usize| match options.footer_style {
            Some(paint) => paint(text),
            None => options.style.total.paint(text, options.color),
        };
        lines.push(h_line("├", "┼", "┤"));
        lines.push(render_row(footer, &total));
    }
    lines.push(h_line("└", "┴", "┘"));
    lines.join("\n")
}
