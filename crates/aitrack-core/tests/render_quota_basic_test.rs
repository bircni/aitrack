//! Simple compile test for new render and quota modules

#[cfg(test)]
mod tests {
    #[test]
    fn test_quota_types() {
        use aitrack_core::quota::{ProviderSnapshot, QuotaWindow};
        use std::collections::HashMap;

        let window = QuotaWindow {
            period_start: None,
            period_end: None,
            limit: Some(1000.0),
            used: Some(500.0),
            remaining: Some(500.0),
            unit: "tokens".to_string(),
        };

        assert_eq!(window.unit, "tokens");

        let snapshot = ProviderSnapshot {
            provider_key: "test".to_string(),
            provider_label: "Test".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            windows: vec![window],
            metadata: HashMap::new(),
            error: None,
        };

        assert_eq!(snapshot.provider_key, "test");
    }

    #[test]
    fn test_render_csv() {
        use aitrack_core::data::usage_report::{UsageReport, UsageReportTotals};
        use aitrack_core::render::render_usage_report_csv;

        let report = UsageReport {
            window_label: "Test".to_string(),
            providers: vec![],
            totals: UsageReportTotals {
                input_tokens: 1000,
                output_tokens: 500,
                tokens: 1500,
                cached_input_tokens: 0,
                has_cached: false,
                cost_usd: 0.05,
                has_cost: true,
            },
            row_count: 0,
        };

        let csv = render_usage_report_csv(&report);
        assert!(csv.contains("provider,model,input_tokens"));
        assert!(csv.contains("TOTAL"));
    }

    #[test]
    fn test_heatmap_themes() {
        use aitrack_core::render::heatmap::{ColorMode, get_palette, get_provider_theme};

        let theme = get_provider_theme("claude_code", false);
        assert_eq!(theme.len(), 5);

        let palette = get_palette(ColorMode::Light);
        assert_eq!(palette.bg, "#ffffff");
    }
}
