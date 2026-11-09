//! JavaScript-compatible output, so files written here are byte-identical to the ones 4.x writes.

mod collate;
mod json;
pub(crate) mod number;
mod text;
mod value;

pub use collate::locale_compare;
pub use json::{stringify, stringify_pretty, to_string, to_string_pretty};
pub use number::number_to_string;
pub use text::{decode_uri_component, is_space, parse_number, trim};
pub use value::{INHERITED_KEYS, Lenient, is_inherited_key, is_truthy, parse_object, template_string};
