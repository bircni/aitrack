//! `aitrack report --pdf`: a narrow one-page receipt in the standard-14 Courier fonts, laid out as pdfkit
//! lays it out so lines wrap and truncate where 4.x's did.

use std::fmt::Write as _;

use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};

use super::format::{fmt, fmt_usd_cost, unpriced_footnote};
use crate::data::usage_report::UsageReport;
use crate::js::{is_space, number_to_string};
use crate::quota::pacing::js_round;

const PAGE_WIDTH: f64 = 360.0;
const MARGIN: f64 = 22.0;
const CONTENT_WIDTH: f64 = PAGE_WIDTH - MARGIN * 2.0;
const TOKENS_W: f64 = 62.0;
const PRICE_W: f64 = 62.0;
const LEFT_W: f64 = CONTENT_WIDTH - TOKENS_W - PRICE_W;
const ROW_HEIGHT: f64 = 13.0;
/// Laid out once on a page too tall to paginate, so the real page fits with no blank tail.
const PROBE_HEIGHT: f64 = 100_000.0;

/// Courier's AFM metrics, in thousandths of the font size.
const ASCENDER: f64 = 629.0;
const DESCENDER: f64 = -157.0;
const ADVANCE: u32 = 600;
const ELLIPSIS: char = '…';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Face {
    Regular,
    Bold,
}

impl Face {
    /// The font bounding box's height beyond ascender and descender.
    const fn line_gap(self) -> f64 {
        match self {
            Self::Regular => 269.0,
            Self::Bold => 265.0,
        }
    }

    const fn resource(self) -> &'static str {
        match self {
            Self::Regular => "F1",
            Self::Bold => "F2",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug)]
struct TextOptions {
    width: Option<f64>,
    height: Option<f64>,
    align: Align,
    ellipsis: bool,
}

const LEFT: TextOptions = TextOptions { width: None, height: None, align: Align::Left, ellipsis: false };
const CENTER: TextOptions = TextOptions { align: Align::Center, ..LEFT };

#[derive(Clone, Debug, PartialEq)]
enum Mark {
    /// `y` is the line's top, measured down from the page's top edge.
    Text {
        x: f64,
        y: f64,
        face: Face,
        size: f64,
        bytes: Vec<u8>,
    },
    Rule {
        x0: f64,
        x1: f64,
        y: f64,
    },
}

/// The largest float32 at or below `n`, as pdfkit stores widths and limits.
fn pdf_number(n: f64) -> f64 {
    #[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
    let rounded = n as f32;
    if f64::from(rounded) <= n { f64::from(rounded) } else { f64::from(rounded.next_down()) }
}

fn number(n: f64) -> String {
    number_to_string(js_round(n * 1e6) / 1e6)
}

/// The `WinAnsi` code pdfkit writes for a UTF-16 unit.
const fn win_ansi(unit: u16) -> u16 {
    match unit {
        402 => 131,
        8211 => 150,
        8212 => 151,
        8216 => 145,
        8217 => 146,
        8218 => 130,
        8220 => 147,
        8221 => 148,
        8222 => 132,
        8224 => 134,
        8225 => 135,
        8226 => 149,
        8230 => 133,
        8364 => 128,
        8240 => 137,
        8249 => 139,
        8250 => 155,
        710 => 136,
        8482 => 153,
        338 => 140,
        339 => 156,
        732 => 152,
        352 => 138,
        353 => 154,
        376 => 159,
        381 => 142,
        382 => 158,
        other => other,
    }
}

/// Codes with no Courier glyph draw as a zero-width `.notdef`.
const fn advance(unit: u16) -> u32 {
    match win_ansi(unit) {
        0x7f | 0x81 | 0x8d | 0x8f | 0x90 | 0x9d => 0,
        0x20..=0xff => ADVANCE,
        _ => 0,
    }
}

/// Courier is `WinAnsi` (Latin-1): "→" becomes "->", other code points outside it "?".
#[must_use]
pub fn ascii_safe(text: &str) -> String {
    text.replace('→', "->").chars().map(|c| if ('\u{20}'..='\u{ff}').contains(&c) { c } else { '?' }).collect()
}

/// Local time, to match the local calendar dates in the window labels.
#[must_use]
pub fn local_timestamp(at: &Zoned) -> String {
    format!("{} {:02}:{:02}:{:02}", at.date().strftime("%Y-%m-%d"), at.hour(), at.minute(), at.second())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    Space,
    Hyphen,
    SoftHyphen,
    Slash,
    Digit,
    Open,
    /// Closing punctuation and infix separators, never broken before.
    Close,
    Quote,
    Glue,
    Other,
}

const fn class(c: char) -> Class {
    match c {
        ' ' => Class::Space,
        '-' => Class::Hyphen,
        '\u{ad}' => Class::SoftHyphen,
        '/' => Class::Slash,
        '0'..='9' => Class::Digit,
        '(' | '[' | '{' | '\u{a1}' | '\u{bf}' => Class::Open,
        ')' | ']' | '}' | ',' | '.' | ':' | ';' | '!' | '?' => Class::Close,
        '"' | '\'' | '\u{ab}' | '\u{bb}' => Class::Quote,
        '\u{a0}' => Class::Glue,
        _ => Class::Other,
    }
}

/// Break opportunities from the Latin-only part of UAX #14 a receipt meets: after spaces, and after a
/// hyphen or slash that a letter follows.
fn allows_break(before: Class, spaced: bool, after: Class) -> bool {
    if matches!(after, Class::Space | Class::Close) {
        return false;
    }
    if spaced {
        return before != Class::Open;
    }
    if matches!(after, Class::Quote | Class::Glue) {
        return false;
    }
    match before {
        Class::Hyphen | Class::Slash => !matches!(after, Class::Digit | Class::Hyphen | Class::SoftHyphen),
        Class::SoftHyphen => !matches!(after, Class::Hyphen | Class::SoftHyphen),
        Class::Space | Class::Digit | Class::Open | Class::Close | Class::Quote | Class::Glue | Class::Other => false,
    }
}

/// Words with their trailing spaces, as pdfkit's line breaker yields them.
fn words(text: &str) -> Vec<Vec<u16>> {
    let chars: Vec<char> = text.chars().collect();
    let mut words = Vec::new();
    let mut current = String::new();
    let mut before = Class::Other;
    for (i, &c) in chars.iter().enumerate() {
        current.push(c);
        let spaced = class(c) == Class::Space;
        if !spaced {
            before = class(c);
        }
        if let Some(&next) = chars.get(i + 1)
            && allows_break(before, spaced, class(next))
        {
            words.push(current.encode_utf16().collect());
            current.clear();
        }
    }
    if !current.is_empty() {
        words.push(current.encode_utf16().collect());
    }
    words
}

struct Layout {
    x: f64,
    y: f64,
    face: Face,
    size: f64,
    page_height: f64,
    marks: Vec<Mark>,
}

/// One `text()` call's line wrapper.
struct Wrap {
    line_width: f64,
    space_left: f64,
    max_y: f64,
    column: u32,
    height: bool,
    ellipsis: bool,
    align: Align,
    buffer: Vec<u16>,
    text_width: f64,
    words: u32,
}

impl Layout {
    const fn new(page_height: f64) -> Self {
        Self { x: MARGIN, y: MARGIN, face: Face::Regular, size: 12.0, page_height, marks: Vec::new() }
    }

    const fn font(&mut self, face: Face, size: f64) -> &mut Self {
        self.face = face;
        self.size = size;
        self
    }

    fn line_height(&self) -> f64 {
        (ASCENDER + self.face.line_gap() - DESCENDER) / 1000.0 * self.size
    }

    fn move_down(&mut self, lines: f64) {
        self.y += self.line_height() * lines;
    }

    fn width_of(&self, units: &[u16]) -> f64 {
        f64::from(units.iter().map(|&u| advance(u)).sum::<u32>()) * (self.size / 1000.0)
    }

    fn word_width(&self, units: &[u16]) -> f64 {
        pdf_number(self.width_of(units))
    }

    fn divider(&mut self) {
        let y = self.y + 2.0;
        self.marks.push(Mark::Rule { x0: MARGIN, x1: MARGIN + CONTENT_WIDTH, y });
        self.y = y + 4.0;
    }

    fn text(&mut self, text: &str, at: Option<(f64, f64)>, options: TextOptions) {
        if let Some((x, y)) = at {
            self.x = x;
            self.y = y;
        }
        let line_width = options.width.unwrap_or(PAGE_WIDTH - self.x - MARGIN).max(0.0);
        let start_x = self.x;
        let max_y = pdf_number(options.height.map_or(self.page_height - MARGIN, |h| self.y + h));
        let mut wrap = Wrap {
            line_width,
            space_left: line_width,
            max_y,
            column: 1,
            height: options.height.is_some(),
            ellipsis: options.ellipsis,
            align: options.align,
            buffer: Vec::new(),
            text_width: 0.0,
            words: 0,
        };
        if self.y > max_y || self.y + self.line_height() > max_y {
            wrap.column += 1;
        }
        self.each_word(text, &mut wrap);
        if wrap.words > 0 {
            self.emit_line(&wrap);
        }
        self.x = start_x;
    }

    /// pdfkit's `eachWord`: a word wider than the line is cut into pieces that fit.
    fn each_word(&mut self, text: &str, wrap: &mut Wrap) {
        let mut last: Option<bool> = None;
        for word in words(text) {
            let mut w = self.word_width(&word);
            if w > wrap.line_width {
                let mut piece_last = last;
                let mut rest: &[u16] = &word;
                while !rest.is_empty() {
                    let len = rest.len();
                    let mut l;
                    let mut might_grow = if w > wrap.space_left {
                        #[expect(
                            clippy::cast_precision_loss,
                            clippy::cast_possible_truncation,
                            clippy::cast_sign_loss,
                            reason = "a bounded, rounded number converted between float and integer"
                        )]
                        let fit = (wrap.space_left / (w / len as f64)).ceil().max(0.0) as usize;
                        l = fit.min(len);
                        w = self.word_width(&rest[..l]);
                        w <= wrap.space_left && l < len
                    } else {
                        l = len;
                        false
                    };
                    let mut must_shrink = w > wrap.space_left && l > 0;
                    while must_shrink || might_grow {
                        if must_shrink {
                            l -= 1;
                            w = self.word_width(&rest[..l]);
                            must_shrink = w > wrap.space_left && l > 0;
                        } else {
                            l += 1;
                            w = self.word_width(&rest[..l]);
                            must_shrink = w > wrap.space_left && l > 0;
                            might_grow = w <= wrap.space_left && l < len;
                        }
                    }
                    #[expect(clippy::float_cmp, reason = "exact equality is what is meant here")]
                    if l == 0 && wrap.space_left == wrap.line_width {
                        l = 1;
                    }
                    let carry_on = self.on_word(wrap, &rest[..l], w, l < len, piece_last);
                    piece_last = Some(false);
                    rest = &rest[l..];
                    w = self.word_width(rest);
                    if !carry_on {
                        return;
                    }
                }
            } else if !self.on_word(wrap, &word, w, false, last) {
                return;
            }
            last = Some(false);
        }
    }

    fn can_fit(&self, wrap: &Wrap, word: &[u16], w: f64) -> bool {
        if word.last() == Some(&0xad) {
            w + self.word_width(&[u16::from(b'-')]) <= wrap.space_left
        } else {
            w <= wrap.space_left
        }
    }

    #[expect(clippy::expect_used, reason = "a hyphen is only placed after at least one character")]
    fn on_word(&mut self, wrap: &mut Wrap, word: &[u16], w: f64, required: bool, last: Option<bool>) -> bool {
        if last.is_none_or(|r| r) {
            wrap.space_left = wrap.line_width;
        }
        let fits = self.can_fit(wrap, word, w);
        if fits {
            wrap.buffer.extend_from_slice(word);
            wrap.text_width += w;
            wrap.words += 1;
        }
        if !required && fits {
            wrap.space_left -= w;
            return true;
        }
        let lh = self.line_height();
        if wrap.height && wrap.ellipsis && pdf_number(self.y + lh * 2.0) > wrap.max_y && wrap.column >= 1 {
            let ellipsis = ELLIPSIS as u16;
            trim_end(&mut wrap.buffer);
            let with_ellipsis = |buffer: &[u16]| [buffer, &[ellipsis]].concat();
            let mut width = self.word_width(&with_ellipsis(&wrap.buffer));
            while !wrap.buffer.is_empty() && width > wrap.line_width {
                wrap.buffer.pop();
                trim_end(&mut wrap.buffer);
                width = self.word_width(&with_ellipsis(&wrap.buffer));
            }
            if width <= wrap.line_width {
                wrap.buffer.push(ellipsis);
            }
            wrap.text_width = self.word_width(&wrap.buffer);
        }
        if required && w > wrap.space_left {
            self.emit_line(wrap);
            wrap.buffer = word.to_vec();
            wrap.text_width = w;
            wrap.words = 1;
        }
        if wrap.buffer.last() == Some(&0xad) {
            *wrap.buffer.last_mut().expect("non-empty") = u16::from(b'-');
            wrap.space_left -= self.word_width(&[u16::from(b'-')]);
        }
        self.emit_line(wrap);
        if pdf_number(self.y + lh) > wrap.max_y {
            wrap.column += 1;
            if wrap.height {
                wrap.words = 0;
                wrap.buffer.clear();
                return false;
            }
        }
        if required {
            wrap.space_left = wrap.line_width;
            wrap.buffer.clear();
            wrap.text_width = 0.0;
            wrap.words = 0;
        } else {
            wrap.space_left = wrap.line_width - w;
            wrap.buffer = word.to_vec();
            wrap.text_width = w;
            wrap.words = 1;
        }
        true
    }

    fn emit_line(&mut self, wrap: &Wrap) {
        let units = &wrap.buffer;
        if !units.is_empty() {
            let x = self.x
                + match wrap.align {
                    Align::Left => 0.0,
                    Align::Center => wrap.line_width / 2.0 - wrap.text_width / 2.0,
                    Align::Right => {
                        let mut trimmed = units.clone();
                        trim_end(&mut trimmed);
                        wrap.line_width - self.width_of(&trimmed)
                    }
                };
            #[expect(
                clippy::cast_possible_truncation,
                reason = "the value is rounded and bounded to the target range first"
            )]
            let bytes = units.iter().map(|&u| win_ansi(u) as u8).collect();
            self.marks.push(Mark::Text { x, y: self.y, face: self.face, size: self.size, bytes });
        }
        self.y += self.line_height();
    }
}

/// `/\s+$/` removed.
fn trim_end(units: &mut Vec<u16>) {
    while units.last().is_some_and(|&u| char::from_u32(u32::from(u)).is_some_and(is_space)) {
        units.pop();
    }
}

fn price_cell(has_cost: bool, cost: f64) -> String {
    if has_cost { fmt_usd_cost(cost) } else { "-".to_owned() }
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
fn tokens(n: u64) -> String {
    fmt(n as f64)
}

/// One model/tokens/price row on a single line, so a long model name cannot run into the next row.
fn row(layout: &mut Layout, left: &str, tokens: &str, price: &str, bold: bool) {
    let y = layout.y;
    layout.font(if bold { Face::Bold } else { Face::Regular }, 9.0);
    let fixed = |width| TextOptions { width: Some(width), ..LEFT };
    layout.text(
        &ascii_safe(left),
        Some((MARGIN, y)),
        TextOptions { height: Some(ROW_HEIGHT), ellipsis: true, ..fixed(LEFT_W) },
    );
    layout.text(tokens, Some((MARGIN + LEFT_W, y)), TextOptions { align: Align::Right, ..fixed(TOKENS_W) });
    layout.text(price, Some((MARGIN + LEFT_W + TOKENS_W, y)), TextOptions { align: Align::Right, ..fixed(PRICE_W) });
    layout.y = y + ROW_HEIGHT;
}

fn draw(layout: &mut Layout, report: &UsageReport, stamp: &str) {
    layout.font(Face::Bold, 16.0).text("aitrack", None, CENTER);
    layout.font(Face::Regular, 9.0).text("AI USAGE RECEIPT", None, CENTER);
    layout.move_down(0.5);
    layout.font(Face::Regular, 8.0).text(&ascii_safe(&report.window_label), None, CENTER);
    layout.text(stamp, None, CENTER);
    layout.move_down(0.5);
    layout.divider();
    layout.move_down(0.3);

    let full = TextOptions { width: Some(CONTENT_WIDTH), ..LEFT };
    for provider in &report.providers {
        let y = layout.y;
        layout.font(Face::Bold, 9.0).text(&ascii_safe(&provider.label), Some((MARGIN, y)), full);
        for item in &provider.rows {
            row(
                layout,
                &format!("  {}", item.model),
                &tokens(item.tokens),
                &price_cell(item.has_cost, item.cost_usd),
                false,
            );
        }
        let subtotal = price_cell(provider.subtotal_has_cost, provider.subtotal_cost_usd);
        row(layout, "  subtotal", &tokens(provider.subtotal_tokens), &subtotal, true);
        layout.move_down(0.4);
    }

    layout.divider();
    layout.move_down(0.2);
    let totals = &report.totals;
    row(layout, "TOTAL", &tokens(totals.tokens), &price_cell(totals.has_cost, totals.cost_usd), true);
    layout.divider();

    let partial =
        (totals.has_cost && totals.has_unpriced_tokens).then(|| "Partial estimate: some usage is unpriced.".to_owned());
    let footnote = unpriced_footnote(totals.unpriced_models.as_deref().unwrap_or_default());
    let note = [partial, footnote].into_iter().flatten().collect::<Vec<_>>().join(" ");
    if !note.is_empty() {
        let y = layout.y;
        layout.font(Face::Regular, 8.0).text(&ascii_safe(&note), Some((MARGIN, y)), full);
    }
    layout.move_down(1.0);
    let y = layout.y;
    layout.font(Face::Regular, 7.0).text(
        "Costs are API-equivalent estimates. Thank you for shipping!",
        Some((MARGIN, y)),
        TextOptions { align: Align::Center, ..full },
    );
}

/// A PDF literal string: UTF-16BE with a byte-order mark when any unit is past ASCII.
fn pdf_string(text: &str) -> Vec<u8> {
    let bytes: Vec<u8> = if text.chars().any(|c| u32::from(c) > 0x7f) {
        [0xfe, 0xff].into_iter().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect()
    } else {
        text.bytes().collect()
    };
    let mut out = vec![b'('];
    for b in bytes {
        match b {
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            b'(' | b')' | b'\\' => out.extend_from_slice(&[b'\\', b]),
            other => out.push(other),
        }
    }
    out.push(b')');
    out
}

fn content(marks: &[Mark], page_height: f64) -> Vec<u8> {
    let mut out = Vec::new();
    for mark in marks {
        match mark {
            Mark::Text { x, y, face, size, bytes } => {
                let baseline = page_height - y - ASCENDER / 1000.0 * size;
                let mut hex = String::with_capacity(bytes.len() * 2);
                for b in bytes {
                    let _ = write!(hex, "{b:02x}");
                }
                let resource = face.resource();
                let (x, baseline, size) = (number(*x), number(baseline), number(*size));
                out.extend_from_slice(
                    format!("BT\n/{resource} {size} Tf\n{x} {baseline} Td\n<{hex}> Tj\nET\n").as_bytes(),
                );
            }
            Mark::Rule { x0, x1, y } => {
                let y = number(page_height - y);
                out.extend_from_slice(format!("{} {y} m\n{} {y} l\n0.5 w\nS\n", number(*x0), number(*x1)).as_bytes());
            }
        }
    }
    out
}

fn write_pdf(marks: &[Mark], page_height: f64, title: &str, created: Timestamp) -> Vec<u8> {
    let font =
        |name: &str| format!("<<\n/Type /Font\n/BaseFont /{name}\n/Subtype /Type1\n/Encoding /WinAnsiEncoding\n>>");
    let stream = content(marks, page_height);
    let mut info = b"<<\n/Producer (aitrack)\n/Title ".to_vec();
    info.extend(pdf_string(title));
    info.extend(format!("\n/CreationDate (D:{}Z)\n>>", created.strftime("%Y%m%d%H%M%S")).bytes());
    let mut contents = format!("<<\n/Length {}\n>>\nstream\n", stream.len()).into_bytes();
    contents.extend(&stream);
    contents.extend_from_slice(b"\nendstream");
    let objects: Vec<Vec<u8>> = vec![
        b"<<\n/Type /Catalog\n/Pages 2 0 R\n>>".to_vec(),
        b"<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>".to_vec(),
        format!(
            "<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 {} {}]\n/Contents 4 0 R\n/Resources <<\n/Font <<\n/F1 5 0 R\n/F2 6 0 R\n>>\n>>\n>>",
            number(PAGE_WIDTH),
            number(page_height)
        )
        .into_bytes(),
        contents,
        font("Courier").into_bytes(),
        font("Courier-Bold").into_bytes(),
        info,
    ];
    let mut out = b"%PDF-1.3\n%\xff\xff\xff\xff\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n", i + 1).bytes());
        out.extend(object);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    out.extend(
        format!("trailer\n<<\n/Size {}\n/Root 1 0 R\n/Info 7 0 R\n>>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1)
            .bytes(),
    );
    out
}

/// Stamped with `now` in the system timezone.
#[must_use]
pub fn render_receipt_pdf(report: &UsageReport, now: Timestamp) -> Vec<u8> {
    render_receipt_pdf_at(report, &now.to_zoned(TimeZone::system()))
}

#[must_use]
pub fn render_receipt_pdf_at(report: &UsageReport, generated_at: &Zoned) -> Vec<u8> {
    let stamp = local_timestamp(generated_at);
    let mut probe = Layout::new(PROBE_HEIGHT);
    draw(&mut probe, report, &stamp);
    let page_height = probe.y.ceil() + MARGIN;
    let mut page = Layout::new(page_height);
    draw(&mut page, report, &stamp);
    let title = format!("aitrack usage receipt - {}", ascii_safe(&report.window_label));
    write_pdf(&page.marks, page_height, &title, generated_at.timestamp())
}
