//! Heatmap rendering components.

pub mod layout;
pub mod themes;
pub mod view_model;

pub use layout::{
    HEATMAP_WEEKS, MONTHS, ProviderLayout, ProviderLayoutOptions, build_date_grid,
    filter_provider_data_by_year, merge_all_provider_day_maps, resolve_provider_layout,
};
pub use themes::{CellRamp, ColorMode, Palette, get_palette, get_provider_theme};
pub use view_model::{
    ProviderSectionViewModel, StatCell, build_provider_section_view_model, percentile,
    token_intensity_level,
};
