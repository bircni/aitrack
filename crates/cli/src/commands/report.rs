//! What the report commands share: loading, pricing warnings and the empty-result envelope.

use aitrack_core::Core;
use aitrack_core::data::types::{MachineFile, ProviderData};
use aitrack_core::data::usage_data::{LoadedUsage, load_usage};
use aitrack_core::pricing::cost::FallbackCollector;
use aitrack_core::sync::{record_pricing_fallbacks, report_fallback_pricing};
use serde_json::{Value, json};

use crate::Failure;
use crate::json::print_json_command;

/// Every machine's usage, warning about models priced by a family guess.
pub fn load(
    core: &Core,
    providers: Option<&[String]>,
    refresh: bool,
    local: Option<MachineFile>,
) -> Result<Option<LoadedUsage>, Failure> {
    let loaded = load_usage(core, providers, refresh, local)?;
    if let Some(loaded) = &loaded {
        warn_about_pricing_fallbacks(core, &loaded.zoned.provider_data);
    }
    Ok(loaded)
}

pub fn warn_about_pricing_fallbacks(core: &Core, data: &ProviderData) {
    let fallbacks = FallbackCollector::default();
    record_pricing_fallbacks(core, data, &fallbacks);
    report_fallback_pricing(core, &fallbacks);
}

/// `payload` holds the keys the command's JSON has when it has a result, at their empty values.
pub fn print_empty_result(core: &Core, command: &str, json: bool, message: &str, payload: Value) {
    if json {
        let mut payload = if payload.is_object() { payload } else { json!({}) };
        payload["message"] = Value::from(message);
        print_json_command(command, payload);
    } else {
        core.output.info(message);
    }
}

/// Whether reports can only see this machine's logs.
pub fn not_configured(core: &Core) -> bool {
    core.try_load_config().is_none() || !aitrack_core::git::is_cloned(core)
}
