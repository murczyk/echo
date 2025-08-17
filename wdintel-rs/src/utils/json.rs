use crate::types::*;
use crate::AppError;

#[derive(Debug, PartialEq, Clone)]
pub struct ParsePartialRes {
    pub value: serde_json::Value,
    pub error: Option<String>,
}

/// Parses a partially-valid value like `[{"foo": "bar"}, Error: abc` into `Some([{"foo": "bar"}])`
pub fn parse_partial(inp: &str) -> Result<ParsePartialRes, AppError> {
    let res = serde_json::from_str(inp);
    match res {
        Ok(v) => Ok(ParsePartialRes {
            value: v,
            error: None,
        }),
        Err(e) => {
            let line = e.line();
            let col = e.column();
            // try removing everything after line+col, then add a closing bracket
            let s = inp.to_string();
            // split in lines
            let mut lines = s.split('\n').collect::<Vec<&str>>();
            // remove `line` lines
            lines.truncate(line);
            // remove `col` chars from last line
            let Some(last_line) = lines.last() else {
                return Err(AppError::AnyhowError { source: e.into() });
            };
            let mut last_line = last_line.to_string();
            lines.pop();
            let mut unlines = lines.join("\n");
            // remember everything at col-1 and forward
            let err_s = last_line.split_off(col - 1);
            last_line.truncate(col - 1);
            last_line = last_line.trim().to_string();
            if last_line.ends_with(',') {
                last_line.pop();
            }
            // println!("> last_line: {last_line}");
            unlines.push_str(&last_line);
            unlines.push(']');
            // println!("> unlines: {unlines}");
            let res2 = serde_json::from_str(&unlines).context(h!())?;
            Ok(ParsePartialRes {
                value: res2,
                error: Some(err_s.to_string()),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn parse_partial_01() {
        let input = r#"[{"foo": "bar"}, Error: abc"#;
        let output = parse_partial(input).unwrap();
        assert_eq!(output.value, serde_json::json!([{"foo": "bar"}]));
    }

    #[test]
    fn parse_partial_02() {
        let input =
            std::fs::read_to_string("data/parse_partial_02.txt").unwrap();
        let output = parse_partial(&input).unwrap();
        assert_eq!(
            output.value,
            serde_json::json!([{"envelope":{"source":"8c7e6aad-d7e7-4d69-be03-05f713221e54","sourceNumber":null,"sourceUuid":"8c7e6aad-d7e7-4d69-be03-05f713221e54","sourceName":"ГОВЕРЛА","sourceDevice":3,"timestamp":1713428670962_i64},"account":"+380504118655"}])
        );
    }

    #[test]
    #[serial]
    fn parse_partial_03() {
        // print cwd
        println!("> cwd: {:?}", std::env::current_dir().unwrap());

        // check data/json_partial_03.json
        let input =
            std::fs::read_to_string("data/json_partial_03.json").unwrap();
        let output = parse_partial(&input).unwrap();
        println!(
            "> output: {}",
            serde_json::to_string_pretty(&output.value).unwrap()
        );
        assert_eq!(
            output.value,
            serde_json::json!([
              {
                "account": "+380504118655",
                "envelope": {
                  "source": "+380504118655",
                  "sourceDevice": 4,
                  "sourceName": "Іванич",
                  "sourceNumber": "+380504118655",
                  "sourceUuid": "bcfaa6e0-dfaf-43aa-92ec-a9f7a1b4d801",
                  "syncMessage": {},
                  "timestamp": 1713428666918_i64
                }
              }
            ])
        );
    }
}
