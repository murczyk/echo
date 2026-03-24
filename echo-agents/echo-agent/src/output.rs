use anyhow::Result;

pub fn print_markdown(markdown: &str) {
    print!("{markdown}");
    if !markdown.ends_with('\n') {
        println!();
    }
}

pub fn print_wrapped_markdown(markdown: &str) -> Result<()> {
    let payload = serde_json::json!({
        "format": "markdown",
        "content": markdown.trim_end(),
    });
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}
