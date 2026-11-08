/// Options every renderer shares.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderOptions {
    pub dark: bool,
    /// One merged heatmap across providers instead of one per provider.
    pub all: bool,
    /// Only days from this calendar year.
    pub year: Option<i16>,
}
