//! Core library for aitrack: readers, pricing, sync, reports, renderers, and quota.

pub mod calendar;
pub mod config;
pub mod constants;
pub mod data;
pub mod doctor;
pub mod env;
pub mod errors;
pub mod format;
pub mod git;
pub mod machine_id;
pub mod paths;
pub mod pricing;
pub mod providers;
pub mod quota;
pub mod readers;
pub mod render;
pub mod store;
pub mod timezone;
pub mod version;

pub use config::{
    Config, load_config, read_config, resolve_machine_id, save_config, try_load_config,
};
pub use data::local_data::{build_machine_data, merge_persisted_days, read_local_provider_maps};
pub use data::types::{
    DayBucket, DayEntry, DayMap, MachineFile, ProviderData, ProviderDay, TokenCounts,
};
pub use data::usage_data::{LoadOptions, LoadedUsageData, load_merged_provider_data};
pub use data::usage_report::{
    UsageComparisonReport, UsageReport, build_usage_comparison, build_usage_report,
};
pub use doctor::{
    CheckResult, CheckStatus, DoctorReport, MachineSummary, doctor_report, machines_report,
};
pub use machine_id::{machine_data_filename, machine_id_validation_error, normalize_machine_id};
pub use pricing::fallback::{FallbackCollector, create_fallback_collector};
pub use quota::{refresh_all as refresh_quota, refresh_all_simple as refresh_quota_simple};
pub use version::package_version;
