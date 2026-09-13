//! Data layer: types, aggregation, validation, and usage reports.

pub mod aggregate;
pub mod budget;
pub mod day_map;
pub mod diagnostics;
pub mod duplicate_machines;
pub mod empty_state;
pub mod guards;
pub mod local_data;
pub mod messages;
pub mod model_id;
pub mod sort;
pub mod top_usage;
pub mod types;
pub mod usage_data;
pub mod usage_periods;
pub mod usage_report;
pub mod validate;

pub use aggregate::{
    AggregateModelsFilter, ModelAgg, TokenTotals, aggregate_models_by_day_map, date_in_filter,
    sum_day_map,
};
pub use budget::{BUDGET_WARN_RATIO, BudgetLevel, BudgetStatus, budget_status};
pub use day_map::{
    add_model_usage, add_token_counts, filter_day_map_by_year, filter_provider_data_by_year,
    get_or_create_day, merge_day_maps, to_local_date_string, try_local_date_string,
};
pub use diagnostics::{
    DiagnosticInfo, MachineDiagnostic, diagnose_machine_file, diagnose_provider_data,
};
pub use duplicate_machines::{DuplicateMachineDays, find_duplicate_machine_days};
pub use empty_state::{
    UsageEmptyReason, format_usage_empty_message, usage_empty_message, usage_empty_window_message,
};
pub use guards::{is_finite_number, is_record};
pub use local_data::{
    build_machine_data, machine_has_data, merge_persisted_days, read_local_provider_maps,
};
pub use messages::{INIT_HINT, NO_CONFIG_MESSAGE, REPO_NOT_CLONED_MESSAGE, REPO_URL_UNSET_MESSAGE};
pub use model_id::{
    CLAUDE_FAMILIES, canonicalize_claude_model_id, strip_model_alias_suffix,
    strip_model_effort_suffix, strip_model_version_suffixes,
};
pub use sort::{compare_by_cost, compare_by_days, compare_by_input, compare_by_output};
pub use top_usage::{UsageSortKey, sort_models_by, top_models};
pub use types::{
    CURRENT_SCHEMA_VERSION, DayBucket, DayEntry, DayMap, MachineFile, ProviderData, ProviderDay,
    TokenCounts,
};
pub use usage_data::{
    LoadOptions, LoadedUsageData, load_merged_provider_data, merge_provider_day,
    usage_empty_message as data_usage_empty_message,
};
pub use usage_periods::{
    UsagePeriod, UsageWindow, UsageWindowOptions, compute_previous_usage_window,
    compute_usage_window,
};
pub use usage_report::{
    UsageComparison, UsageComparisonMetric, UsageComparisonReport, UsageModelComparison,
    UsageReport, UsageReportOptions, UsageReportProvider, UsageReportRow, UsageReportTotals,
    build_usage_comparison, build_usage_report,
};
pub use validate::validate_machine_file;
