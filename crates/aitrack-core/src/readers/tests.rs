//! Tests for reader modules.

#[cfg(test)]
mod tests {
    use super::super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_jsonl_stream() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, r#"{{"type": "test", "value": 42}}"#).unwrap();
        writeln!(file, "").unwrap(); // blank line
        writeln!(file, r#"{{"type": "test2", "value": 100}}"#).unwrap();

        let objects: Vec<_> = jsonl::stream_jsonl_objects(file.path()).unwrap().collect();

        assert_eq!(objects.len(), 2);
        assert_eq!(
            objects[0].get("type").and_then(|v| v.as_str()),
            Some("test")
        );
        assert_eq!(objects[1].get("value").and_then(|v| v.as_i64()), Some(100));
    }

    #[test]
    fn test_cache_format() {
        use crate::data::types::DayMap;
        use cache::{CachedParse, open_parse_cache};

        let cache = open_parse_cache("test_cache");
        let _parse = CachedParse {
            days: DayMap::new(),
            keys: vec!["test_key".to_string()],
        };

        // Save should not crash
        cache.save();
    }

    #[test]
    fn test_path_resolution() {
        let paths = paths::split_configured_paths(Some("path1,path2,  path3  "));
        assert_eq!(paths.len(), 3);
        assert_eq!(paths[0], "path1");
        assert_eq!(paths[1], "path2");
        assert_eq!(paths[2], "path3");
    }

    #[test]
    fn test_jwt_decode() {
        use cursor::jwt::decode_jwt_payload;

        // Valid JWT with payload {"sub": "test-user"}
        let token = "header.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.signature";
        let payload = decode_jwt_payload(token);

        assert!(payload.is_some());
        let payload = payload.unwrap();
        assert_eq!(payload.sub, Some("test-user".to_string()));
    }

    #[test]
    fn test_cursor_csv_parse_date() {
        use cursor::csv::parse_cursor_date_string;

        let date = parse_cursor_date_string(Some(&"2026-01-15".to_string()));
        assert_eq!(date, Some("2026-01-15".to_string()));

        let empty = parse_cursor_date_string(Some(&"".to_string()));
        assert_eq!(empty, None);
    }
}
