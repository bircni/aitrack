use serde_json::{Map, Value};

/// `{ "command": <command>, ...payload }`, pretty, on stdout: with `--json` it is the only thing there.
#[expect(
    clippy::expect_used,
    reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail"
)]
pub fn print_json_command(command: &str, payload: Value) {
    let mut object = Map::new();
    object.insert("command".into(), Value::from(command));
    if let Value::Object(fields) = payload {
        object.extend(fields);
    }
    println!("{}", aitrack_core::js::to_string_pretty(&Value::Object(object)).expect("JSON serializes"));
}

pub fn print_json_error(command: &str, error: &str) {
    print_json_command(command, serde_json::json!({ "error": error }));
}
