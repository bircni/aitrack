//! Rendering utilities for tables, CSV, PDF, and PNG heatmaps.

pub mod csv;
pub mod heatmap;
pub mod pdf;
pub mod png;
pub mod table;

pub use csv::render_usage_report_csv;
pub use heatmap::{
    ColorMode, MONTHS, ProviderLayoutOptions, build_date_grid, build_provider_section_view_model,
    get_palette, get_provider_theme, resolve_provider_layout,
};
pub use pdf::render_receipt_pdf;
pub use png::{RenderOptions, render_to_png};
pub use table::render_usage_table;

// Public API as specified in requirements
pub fn render_tui(
    _provider_data: &crate::data::types::ProviderData,
    options: &RenderOptions,
) -> String {
    // TUI rendering using table for now
    // In a full implementation, this would render a proper TUI
    format!(
        "TUI rendering (mode: {}, all: {})",
        if options.dark { "dark" } else { "light" },
        options.all
    )
}

pub fn render_usage_report_csv_api(report: &crate::data::usage_report::UsageReport) -> String {
    render_usage_report_csv(report)
}

pub fn render_receipt_pdf_api(
    report: &crate::data::usage_report::UsageReport,
    generated_at: Option<chrono::DateTime<chrono::Local>>,
) -> anyhow::Result<Vec<u8>> {
    render_receipt_pdf(report, generated_at)
}
