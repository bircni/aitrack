//! Local timezone of this machine.

pub fn machine_timezone() -> String {
    // chrono's Local::now() uses the system zone; iana name via iana-time-zone.
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned())
}
