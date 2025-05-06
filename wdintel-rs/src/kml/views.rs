use super::types::*;
use crate::error::AppError;
use crate::h;
use anyhow::Context;

pub fn render_kml(kml: &Kml) -> Result<String, AppError> {
    if let Some(folder) =
        super::node_as_folder(kml.nodes.get(0).ok_or("kml must not be empty")?)?
    {
        Ok(format!(
            r###"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:atom="http://www.w3.org/2005/Atom">
{folder}
</kml>
"###,
            folder = quick_xml::se::to_string(&folder).context(h!())?,
        ))
    } else {
        Err(AppError::BL {
            msg: "Kml.document must be a folder or a document".to_string(),
        })
    }
}
