//! Usage for the popup, from the same report builder as `aitrack usage`, so the numbers match the CLI.

use std::time::Duration;

use aitrack_core::config::resolve_machine_id;
use aitrack_core::data::aggregate::has_unpriced_usage;
use aitrack_core::data::local_data::build_machine_data;
use aitrack_core::data::project_usage::ProjectBreakdown;
use aitrack_core::data::types::MachineFile;
use aitrack_core::data::usage_data::{is_cloned, load_merged_provider_data, merge_usage_sources, ZonedUsageData};
use aitrack_core::data::usage_periods::{PeriodArgs, UsagePeriod};
use aitrack_core::data::usage_report::{
    build_project_breakdown, build_usage_report, ReportContext, ReportOptions, UsageReport,
};
use aitrack_core::git::pull;
use aitrack_core::pricing::model_pricing::ModelPricing;
use aitrack_core::providers::PROVIDERS;
use aitrack_core::sync::read_local_provider_maps;
use aitrack_core::time::Clock;
use aitrack_core::Core;
use jiff::Timestamp;

use crate::state::{
    DailyUsage, MachineUsage, ModelUsage, PeriodUsage, ProjectProviderEntry, ProjectUsageEntry, ProjectUsages,
    ProviderUsage, ProviderUsages, UsageSummary,
};

/// The usage grid's 18 weeks; the machine strips show the last 30 of these days.
const TREND_DAYS: i64 = 126;

pub const GIT_TIMEOUT: Duration = Duration::from_secs(60);

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
fn period_for(report: Option<&UsageReport>, key: &str) -> PeriodUsage {
    let Some(provider) = report.and_then(|r| r.providers.iter().find(|p| p.key == key)) else {
        return PeriodUsage::default();
    };
    PeriodUsage {
        tokens: provider.subtotal_tokens as f64,
        cost_usd: provider.subtotal_cost_usd,
        has_cost: provider.subtotal_has_cost,
        has_unpriced_tokens: provider.has_unpriced_tokens,
        models: provider
            .rows
            .iter()
            .map(|row| ModelUsage {
                model: row.model.clone(),
                tokens: row.tokens as f64,
                cost_usd: row.cost_usd,
                has_cost: row.has_cost,
                has_unpriced_tokens: row.has_unpriced_tokens,
            })
            .collect(),
    }
}

fn options(period: UsagePeriod) -> ReportOptions {
    ReportOptions { period, args: PeriodArgs::default(), project: None }
}

fn provider_usages(context: &ReportContext<'_>, loaded: &ZonedUsageData, dates: &[String]) -> ProviderUsages {
    let report = |period| build_usage_report(context, loaded, &options(period)).ok();
    let [today, yesterday, week, month, all] =
        [UsagePeriod::Today, UsagePeriod::Yesterday, UsagePeriod::Week, UsagePeriod::Month, UsagePeriod::All]
            .map(report);
    let mut providers = ProviderUsages::new();
    for descriptor in &PROVIDERS {
        let key = descriptor.key;
        let Some(days) = loaded.provider_data.get(key) else { continue };
        let daily = dates
            .iter()
            .map(|date| {
                let day = aitrack_core::day::Day::parse(date).and_then(|d| days.get(&d));
                DailyUsage {
                    date: date.clone(),
                    cost_usd: day.and_then(|d| d.counts.cost_usd).unwrap_or(0.0),
                    has_unpriced_tokens: day.is_some_and(|d| has_unpriced_usage(&d.counts)),
                }
            })
            .collect();
        providers.insert(
            key.to_owned(),
            ProviderUsage {
                today: period_for(today.as_ref(), key),
                yesterday: period_for(yesterday.as_ref(), key),
                last7_days: period_for(week.as_ref(), key),
                last30_days: period_for(month.as_ref(), key),
                all_time: period_for(all.as_ref(), key),
                daily,
            },
        );
    }
    providers
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
)]
fn project_entries(breakdown: Option<ProjectBreakdown>) -> Vec<ProjectUsageEntry> {
    let Some(breakdown) = breakdown else { return Vec::new() };
    breakdown
        .projects
        .into_iter()
        .chain(breakdown.unattributed)
        .map(|project| ProjectUsageEntry {
            project: project.project,
            tokens: project.tokens as f64,
            cost_usd: project.cost_usd,
            has_cost: project.has_cost,
            has_unpriced_tokens: project.has_unpriced_tokens,
            providers: project
                .providers
                .into_iter()
                .map(|part| ProjectProviderEntry {
                    key: part.key,
                    label: part.label,
                    tokens: part.tokens as f64,
                    cost_usd: part.cost_usd,
                    has_cost: part.has_cost,
                    has_unpriced_tokens: part.has_unpriced_tokens,
                })
                .collect(),
            unattributed: project.unattributed,
        })
        .collect()
}

fn project_usages(context: &ReportContext<'_>, loaded: &ZonedUsageData) -> ProjectUsages {
    let breakdown = |period| project_entries(build_project_breakdown(context, loaded, &options(period)).ok());
    ProjectUsages {
        today: breakdown(UsagePeriod::Today),
        last7_days: breakdown(UsagePeriod::Week),
        last30_days: breakdown(UsagePeriod::Month),
        all_time: breakdown(UsagePeriod::All),
    }
}

/// Same report builder as `aitrack usage`, so the numbers match the CLI.
pub fn summarize_usage(
    pricing: &ModelPricing,
    clock: &Clock,
    loaded: Option<&ZonedUsageData>,
    now: Timestamp,
) -> UsageSummary {
    let Some(loaded) = loaded else { return UsageSummary::default() };
    let context = ReportContext { pricing, clock, now };
    let last = clock.local_day(now);
    let dates: Vec<String> = (0..TREND_DAYS).map(|index| last.shift(index - (TREND_DAYS - 1)).to_string()).collect();
    let machines = loaded
        .zoned_sources
        .iter()
        .map(|source| MachineUsage {
            name: source.hostname.clone(),
            timezone: source.timezone.clone(),
            last_updated: source.last_updated.clone(),
            current: source.current,
            providers: provider_usages(&context, &merge_usage_sources(pricing, vec![source.clone()]), &dates),
        })
        .collect();
    UsageSummary {
        providers: provider_usages(&context, loaded, &dates),
        projects: Some(project_usages(&context, loaded)),
        machines: Some(machines),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageLoadOptions {
    /// Only enabled providers are read.
    pub providers: Vec<String>,
    pub pull: bool,
    /// This machine's logs as a sync just read them, so they are not parsed again.
    pub local_machine: Option<MachineFile>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageLoadResult {
    pub summary: Result<UsageSummary, String>,
    /// Why the pull failed; the local usage is still read.
    pub warning: Option<String>,
}

fn is_usage_not_configured(core: &Core) -> bool {
    core.try_load_config().is_none() || !is_cloned(core)
}

fn pull_synced(core: &Core) -> Result<(), String> {
    core.with_repo_lock(|guard| pull(core, guard, &guard.git().clone().with_timeout(Some(GIT_TIMEOUT))))
        .map_err(|error| format!("Could not pull synced data: {error}"))
}

fn load_summary(core: &Core, options: &UsageLoadOptions, pulled: impl FnOnce()) -> Result<UsageSummary, String> {
    let config = core.try_load_config();
    let machine_id = resolve_machine_id(config.as_ref()).map_err(str::to_owned)?;
    let local = options.local_machine.as_ref().map_or_else(
        || {
            read_local_provider_maps(core, None, Some(&options.providers))
                .map(|maps| build_machine_data(&machine_id, &maps, core.clock.zone_name(), core.clock.now(), true))
                .map_err(|error| error.to_string())
        },
        |machine| Ok(machine.clone()),
    );
    pulled();
    let local = local?;
    let pricing = core.pricing().current();
    let loaded = load_merged_provider_data(core, &pricing, &machine_id, Some(&local), Some(&options.providers));
    Ok(summarize_usage(&pricing, &core.clock, loaded.as_ref().map(|l| &l.zoned), core.clock.now()))
}

/// Pulls while this machine's logs are parsed; only the synced files wait for it.
pub fn load_usage_summary(core: &Core, options: &UsageLoadOptions) -> UsageLoadResult {
    std::thread::scope(|scope| {
        let pulling = (options.pull && !is_usage_not_configured(core)).then(|| scope.spawn(|| pull_synced(core)));
        let pulling = std::cell::RefCell::new(pulling);
        let warning = std::cell::OnceCell::new();
        let settle = || {
            warning
                .get_or_init(|| pulling.borrow_mut().take().and_then(|handle| handle.join().unwrap_or(Ok(())).err()))
                .clone()
        };
        let summary = load_summary(core, options, || {
            settle();
        });
        UsageLoadResult { summary, warning: settle() }
    })
}

#[cfg(test)]
mod tests {
    use aitrack_core::data::types::{MachineDays, ProviderDay, TokenCounts};
    use aitrack_core::data::usage_data::ZonedUsageSource;
    use aitrack_core::day::Day;
    use indexmap::IndexMap;

    use super::*;

    type Days<'a> = Vec<(&'a str, Vec<(&'a str, ProviderDay)>)>;

    fn counts(input: u64, output: u64, cost: f64) -> TokenCounts {
        TokenCounts { input_tokens: input, output_tokens: output, cost_usd: Some(cost), ..TokenCounts::default() }
    }

    fn day(input: u64, output: u64, cost: f64, model: &str) -> ProviderDay {
        ProviderDay {
            totals: counts(input, output, cost),
            by_model: IndexMap::from([(model.to_owned(), counts(input, output, cost))]),
            by_project: None,
            by_cwd: None,
        }
    }

    fn source(name: &str, zone: &str, last_updated: &str, current: bool, data: Days<'_>) -> ZonedUsageSource {
        let mut days = MachineDays::new();
        for (key, entries) in data {
            for (date, entry) in entries {
                days.entry(Day::parse(date).unwrap()).or_default().insert(key.to_owned(), entry);
            }
        }
        ZonedUsageSource {
            hostname: name.into(),
            timezone: zone.into(),
            last_updated: last_updated.into(),
            current,
            days,
        }
    }

    fn pricing() -> ModelPricing {
        aitrack_core::pricing::store::PricingStore::bundled()
    }

    /// One machine in the viewer's zone.
    fn summarize(data: Days<'_>, zone: &str, now: &str) -> UsageSummary {
        let loaded = merge_usage_sources(&pricing(), vec![source("laptop", zone, "", true, data)]);
        summarize_usage(&pricing(), &Clock::in_zone(zone).unwrap(), Some(&loaded), now.parse().unwrap())
    }

    #[test]
    fn marks_a_day_whose_cost_is_only_partly_priced() {
        let mut partial = day(10, 2, 1.0, "gpt-5");
        partial.by_model["gpt-5"].has_unpriced_tokens = Some(true);
        let data = vec![("codex", vec![("2026-06-15", partial), ("2026-06-14", day(10, 2, 1.0, "gpt-5"))])];
        let daily = &summarize(data, "UTC", "2026-06-15T12:00:00Z").providers["codex"].daily;
        assert_eq!(
            daily[124..],
            [
                DailyUsage { date: "2026-06-14".into(), cost_usd: 1.0, has_unpriced_tokens: false },
                DailyUsage { date: "2026-06-15".into(), cost_usd: 1.0, has_unpriced_tokens: true },
            ]
        );
    }

    #[test]
    #[expect(clippy::float_cmp, reason = "test values are sums of small integers and halves, exact in f64")]
    fn builds_every_period_and_the_daily_series_empty_where_a_provider_has_nothing() {
        let sonnet = "claude-sonnet-4-6";
        let data = vec![
            (
                "claude_code",
                vec![
                    ("2026-06-15", day(100, 50, 1.5, sonnet)),
                    ("2026-06-14", day(10, 5, 0.25, sonnet)),
                    ("2026-04-16", day(20, 10, 0.5, sonnet)),
                ],
            ),
            ("codex", vec![("2026-06-12", day(1, 1, 0.0, "gpt-5"))]),
        ];
        let summary = summarize(data, "UTC", "2026-06-15T12:00:00Z");
        let claude = &summary.providers["claude_code"];
        assert_eq!(
            claude.today,
            PeriodUsage {
                tokens: 150.0,
                cost_usd: 1.5,
                has_cost: true,
                has_unpriced_tokens: false,
                models: vec![ModelUsage {
                    model: sonnet.into(),
                    tokens: 150.0,
                    cost_usd: 1.5,
                    has_cost: true,
                    has_unpriced_tokens: false
                }],
            }
        );
        let tokens = [&claude.yesterday, &claude.last7_days, &claude.last30_days, &claude.all_time].map(|p| p.tokens);
        assert_eq!(tokens, [15.0, 165.0, 165.0, 195.0]);
        assert_eq!(claude.daily.len(), 126);
        assert_eq!(claude.daily.last().unwrap().date, "2026-06-15");
        assert_eq!(summary.providers["codex"].today, PeriodUsage::default());
        assert_eq!(summarize_usage(&pricing(), &Clock::system(), None, Timestamp::now()), UsageSummary::default());
    }

    #[test]
    #[expect(clippy::float_cmp, reason = "test values are sums of small integers and halves, exact in f64")]
    fn groups_usage_by_project_and_adds_the_remainder_up_to_the_provider_totals() {
        let mut attributed = day(100, 50, 1.5, "claude-sonnet-4-6");
        attributed.by_project = Some(IndexMap::from([("acme/widget".to_owned(), counts(90, 0, 1.0))]));
        let data = vec![(
            "claude_code",
            vec![("2026-06-15", attributed), ("2026-06-01", day(20, 10, 0.5, "claude-sonnet-4-6"))],
        )];
        let summary = summarize(data, "UTC", "2026-06-15T12:00:00Z");
        let projects = summary.projects.unwrap();
        let today: Vec<(&str, f64)> = projects.today.iter().map(|p| (p.project.as_str(), p.tokens)).collect();
        assert_eq!(today, [("acme/widget", 90.0), ("(unattributed)", 60.0)]);
        assert!(projects.today[1].unattributed);
        assert_eq!(projects.today[1].cost_usd, 0.5);
        assert_eq!(projects.last7_days, projects.today);
        let sum = |entries: &[ProjectUsageEntry]| entries.iter().map(|e| e.tokens).sum::<f64>();
        assert_eq!(sum(&projects.last30_days), summary.providers["claude_code"].last30_days.tokens);
        assert_eq!(sum(&projects.all_time), summary.providers["claude_code"].all_time.tokens);
    }

    #[test]
    #[expect(clippy::float_cmp, reason = "test values are sums of small integers and halves, exact in f64")]
    fn splits_usage_per_machine() {
        let desk = vec![
            ("claude_code", vec![("2026-06-15", day(100, 50, 1.5, "claude-sonnet-4-6"))]),
            ("cursor", vec![("2026-06-15", day(5, 5, 0.5, "auto"))]),
        ];
        let laptop = vec![("codex", vec![("2026-06-14", day(10, 10, 0.2, "gpt-5"))])];
        let data = merge_usage_sources(
            &pricing(),
            vec![source("desk", "UTC", "2026-06-15T08:00:00Z", false, desk), source("laptop", "UTC", "", true, laptop)],
        );
        let now = "2026-06-15T12:00:00Z".parse().unwrap();
        let summary = summarize_usage(&pricing(), &Clock::in_zone("UTC").unwrap(), Some(&data), now);
        let machines = summary.machines.unwrap();
        let (desk, laptop) = (&machines[0], &machines[1]);
        assert_eq!(
            (desk.name.as_str(), desk.current, desk.last_updated.as_str()),
            ("desk", false, "2026-06-15T08:00:00Z")
        );
        assert_eq!(
            (desk.providers["claude_code"].today.tokens, desk.providers["claude_code"].today.cost_usd),
            (150.0, 1.5)
        );
        assert_eq!(desk.providers.keys().collect::<Vec<_>>(), ["claude_code"], "an unknown provider is dropped");
        assert_eq!((laptop.name.as_str(), laptop.current), ("laptop", true));
        assert_eq!(laptop.providers["codex"].yesterday.tokens, 20.0);
        assert_eq!(laptop.providers["codex"].daily[124].cost_usd, 0.2);
    }

    #[test]
    fn anchors_report_periods_and_chart_days_to_the_same_calendar_instant_in_extreme_zones() {
        for zone in ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kathmandu", "America/St_Johns"] {
            let now: Timestamp = "2026-01-01T00:15:00Z".parse().unwrap();
            let date = Clock::in_zone(zone).unwrap().local_day(now).to_string();
            let mut entry = day(10, 2, 1.0, "claude-sonnet-4-6");
            for counts in entry.by_model.values_mut() {
                counts.has_unpriced_tokens = Some(true);
            }
            let summary = summarize(vec![("claude_code", vec![(&date, entry)])], zone, "2026-01-01T00:15:00Z");
            let today = &summary.providers["claude_code"].today;
            assert_eq!((today.tokens, today.cost_usd, today.has_unpriced_tokens), (12.0, 1.0, true), "{zone}");
            let last = summary.providers["claude_code"].daily.last().unwrap();
            assert_eq!((last.date.as_str(), last.has_unpriced_tokens), (date.as_str(), true), "{zone}");
        }
    }
}
