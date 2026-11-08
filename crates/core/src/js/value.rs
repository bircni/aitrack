use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{self, DeserializeOwned, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use super::number_to_string;

/// A field read the way optional chaining reads it: an object of the expected shape, or nothing.
///
/// Logs are cast in 4.x rather than validated, so `entry.message?.usage` on a string `message` is
/// just `undefined`. A strict type would reject the whole line instead.
#[derive(Debug)]
pub struct Lenient<T>(pub Option<T>);

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<T> Lenient<T> {
    pub fn get(&self) -> Option<&T> {
        self.0.as_ref()
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectOrNothing<T>(PhantomData<T>);

        impl<'de, T: DeserializeOwned> Visitor<'de> for ObjectOrNothing<T> {
            type Value = Lenient<T>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(de::value::MapAccessDeserializer::new(map)).map(|value| Lenient(Some(value)))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Lenient(None))
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
                deserializer.deserialize_any(self)
            }
        }

        deserializer.deserialize_any(ObjectOrNothing(PhantomData))
    }
}

/// Parses one JSON line into `T` when it holds an object, as `JSON.parse` plus an `isRecord` check would.
/// Invalid UTF-8 is replaced with U+FFFD first, as Node's `Buffer.toString` does.
pub fn parse_object<T: DeserializeOwned>(line: &[u8]) -> Option<T> {
    match serde_json::from_slice::<Lenient<T>>(line) {
        Ok(parsed) => parsed.0,
        Err(_) if std::str::from_utf8(line).is_err() => {
            serde_json::from_str::<Lenient<T>>(&String::from_utf8_lossy(line)).ok().and_then(|parsed| parsed.0)
        }
        Err(_) => None,
    }
}

/// JavaScript truthiness of a JSON value.
#[must_use]
pub fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `${value ?? ''}`: how a template literal writes a JSON value.
#[must_use]
pub fn template_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => to_js_string(value),
    }
}

fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// Keys every plain object inherits; as a record key they would resolve to the inherited member.
pub const INHERITED_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

#[must_use]
pub fn is_inherited_key(key: &str) -> bool {
    INHERITED_KEYS.contains(&key)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Inner {
        id: Option<Value>,
    }

    #[derive(Debug, Deserialize)]
    struct Outer {
        #[serde(default)]
        message: Lenient<Inner>,
    }

    #[test]
    fn reads_wrong_shapes_as_absent_instead_of_rejecting_the_line() {
        for (line, id) in [
            (r#"{"message":{"id":"a","content":[1,{"x":2}]}}"#, Some(json!("a"))),
            (r#"{"message":"text"}"#, None),
            (r#"{"message":[1,2]}"#, None),
            (r#"{"message":null}"#, None),
            ("{}", None),
        ] {
            let outer: Outer = parse_object(line.as_bytes()).unwrap();
            assert_eq!(outer.message.get().and_then(|m| m.id.clone()), id, "{line}");
        }
        assert!(parse_object::<Outer>(b"[1]").is_none());
        assert!(parse_object::<Outer>(b"5").is_none());
        assert!(parse_object::<Outer>(br#"{"message":{"id":"a"}"#).is_none());
        let lossy: Outer = parse_object(b"{\"message\":{\"id\":\"\xff\"}}").unwrap();
        assert_eq!(lossy.message.get().and_then(|m| m.id.clone()), Some(json!("\u{fffd}")));
    }

    #[test]
    fn writes_values_as_template_literals_do() {
        assert_eq!(template_string(None), "");
        assert_eq!(template_string(Some(&json!(null))), "");
        assert_eq!(template_string(Some(&json!(12.0))), "12");
        assert_eq!(template_string(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(template_string(Some(&json!({"a": 1}))), "[object Object]");
        assert!(!is_truthy(Some(&json!(0))) && is_truthy(Some(&json!([]))) && !is_truthy(Some(&json!(""))));
    }
}
