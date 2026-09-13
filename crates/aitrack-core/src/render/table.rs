//! Terminal table rendering using comfy-table.

use crate::data::usage_report::UsageReport;
use crate::format::{fmt, fmt_usd};
use crate::providers::provider_label;
use comfy_table::{Cell, CellAlignment, Color, ContentArrangement, Table};

pub fn render_usage_table(report: &UsageReport) -> String {
    let mut table = Table::new();
    table
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(vec![
            Cell::new("Provider").set_alignment(CellAlignment::Left),
            Cell::new("Model").set_alignment(CellAlignment::Left),
            Cell::new("Input").set_alignment(CellAlignment::Right),
            Cell::new("Cached").set_alignment(CellAlignment::Right),
            Cell::new("Output").set_alignment(CellAlignment::Right),
            Cell::new("Total").set_alignment(CellAlignment::Right),
            Cell::new("Cost").set_alignment(CellAlignment::Right),
        ]);

    for provider in &report.providers {
        let label = provider_label(&provider.key);

        for (idx, row) in provider.rows.iter().enumerate() {
            let provider_cell = if idx == 0 {
                Cell::new(&label).fg(Color::Cyan)
            } else {
                Cell::new("")
            };

            let cached_str = if row.has_cached {
                fmt(row.cached_input_tokens)
            } else {
                "—".to_string()
            };

            let cost_str = if row.has_cost {
                fmt_usd(Some(row.cost_usd))
            } else {
                "—".to_string()
            };

            table.add_row(vec![
                provider_cell,
                Cell::new(&row.model).set_alignment(CellAlignment::Left),
                Cell::new(fmt(row.input_tokens)).set_alignment(CellAlignment::Right),
                Cell::new(cached_str).set_alignment(CellAlignment::Right),
                Cell::new(fmt(row.output_tokens)).set_alignment(CellAlignment::Right),
                Cell::new(fmt(row.tokens)).set_alignment(CellAlignment::Right),
                Cell::new(cost_str).set_alignment(CellAlignment::Right),
            ]);
        }
    }

    // Add total row
    let cached_total_str = if report.totals.has_cached {
        fmt(report.totals.cached_input_tokens)
    } else {
        "—".to_string()
    };

    let cost_total_str = if report.totals.has_cost {
        fmt_usd(Some(report.totals.cost_usd))
    } else {
        "—".to_string()
    };

    table.add_row(vec![
        Cell::new("TOTAL")
            .fg(Color::Green)
            .set_alignment(CellAlignment::Left),
        Cell::new("").set_alignment(CellAlignment::Left),
        Cell::new(fmt(report.totals.input_tokens))
            .fg(Color::Green)
            .set_alignment(CellAlignment::Right),
        Cell::new(cached_total_str)
            .fg(Color::Green)
            .set_alignment(CellAlignment::Right),
        Cell::new(fmt(report.totals.output_tokens))
            .fg(Color::Green)
            .set_alignment(CellAlignment::Right),
        Cell::new(fmt(report.totals.tokens))
            .fg(Color::Green)
            .set_alignment(CellAlignment::Right),
        Cell::new(cost_total_str)
            .fg(Color::Green)
            .set_alignment(CellAlignment::Right),
    ]);

    table.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::usage_report::UsageReportTotals;

    #[test]
    fn test_render_empty_table() {
        let report = UsageReport {
            window_label: "Test".to_string(),
            providers: vec![],
            totals: UsageReportTotals {
                input_tokens: 0,
                output_tokens: 0,
                tokens: 0,
                cached_input_tokens: 0,
                has_cached: false,
                cost_usd: 0.0,
                has_cost: false,
            },
            row_count: 0,
        };

        let result = render_usage_table(&report);
        assert!(result.contains("TOTAL"));
    }
}
