//! Error helpers.

pub fn error_message(error: &dyn std::error::Error) -> String {
    error.to_string()
}

pub fn error_message_any(error: &impl std::fmt::Display) -> String {
    error.to_string()
}
