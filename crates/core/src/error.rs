/// A failure as the user reads it: one message, like the errors 4.x throws.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub String);

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

macro_rules! from_display {
    ($($t:ty),*) => {$(
        impl From<$t> for Error {
            fn from(error: $t) -> Self {
                Self(error.to_string())
            }
        }
    )*};
}

from_display!(
    std::io::Error,
    crate::git::GitError,
    crate::config::ConfigError,
    crate::store::machine_files::MachineFileError
);

pub type Result<T, E = Error> = std::result::Result<T, E>;
