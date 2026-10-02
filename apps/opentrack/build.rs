fn main() {
    // Shared with opentrack-ui; rebuild when a provider console URL changes.
    println!("cargo:rerun-if-changed=../opentrack-ui/src/shared/provider-dashboards.json");
    tauri_build::build();
}
