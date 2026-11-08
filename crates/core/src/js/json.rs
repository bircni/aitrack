use std::io;

use serde::Serialize;
use serde_json::ser::{CompactFormatter, Formatter, PrettyFormatter};

use super::number::number_to_string;

/// `JSON.stringify(value)`.
pub fn to_string<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    write(value, JsFormatter(CompactFormatter))
}

/// `JSON.stringify(value, null, 2)`, with no trailing newline.
pub fn to_string_pretty<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    write(value, JsFormatter(PrettyFormatter::with_indent(b"  ")))
}

fn write<T: Serialize + ?Sized, F: Formatter>(value: &T, formatter: F) -> serde_json::Result<String> {
    let mut out = Vec::with_capacity(256);
    value.serialize(&mut serde_json::Serializer::with_formatter(&mut out, formatter))?;
    Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
}

/// Keeps the wrapped layout and writes doubles as JavaScript does: `45000`, not `45000.0`; `0.0000045`, not `4.5e-6`.
struct JsFormatter<F>(F);

impl<F: Formatter> Formatter for JsFormatter<F> {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(number_to_string(value).as_bytes())
    }

    fn write_f32<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn begin_array<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_array(writer)
    }

    fn end_array<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_array(writer)
    }

    fn begin_array_value<W: ?Sized + io::Write>(&mut self, writer: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_array_value(writer, first)
    }

    fn end_array_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_array_value(writer)
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object(writer)
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object(writer)
    }

    fn begin_object_key<W: ?Sized + io::Write>(&mut self, writer: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_object_key(writer, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object_value(writer)
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object_value(writer)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{to_string, to_string_pretty};

    #[test]
    fn writes_what_json_stringify_writes() {
        let value = json!({
            "schemaVersion": 2,
            "costUSD": 0.000_004_5,
            "total": 45000.0,
            "empty": {},
            "list": [],
            "nested": { "text": "tab\there \u{1f} \"quoted\" /" }
        });
        assert_eq!(
            to_string(&value).unwrap(),
            r#"{"schemaVersion":2,"costUSD":0.0000045,"total":45000,"empty":{},"list":[],"nested":{"text":"tab\there \u001f \"quoted\" /"}}"#
        );
        assert_eq!(
            to_string_pretty(&json!({ "a": [1.5, {}], "b": {} })).unwrap(),
            "{\n  \"a\": [\n    1.5,\n    {}\n  ],\n  \"b\": {}\n}"
        );
    }
}
