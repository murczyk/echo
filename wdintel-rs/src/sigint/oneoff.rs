use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use log::info;
use sea_orm::ConnectionTrait;

pub async fn oneoff_fill_sigint_inbox_item_tags(
    mode: Mode,
) -> Result<(), AppError> {
    info!("starting oneoff_fill_sigint_inbox_item_tags...");
    let config = crate::config::read_config(mode)?;
    let db = crate::new_pg_pool_from_config(&config).await?;

    db.execute_unprepared(
        r#"
            insert into sigint_inbox_item_tag (
                sigint_inbox_item_id,
                tag_id
            )
            select distinct
                x.sigint_inbox_item_id,
                x.tag_id::bigint
            from (
                select
                    id as sigint_inbox_item_id,
                    jsonb_array_elements(tags) as tag_id
                from
                    sigint_inbox_item i
                where
                    i.tags is not null  
                    and not exists (
                        select 1 from sigint_inbox_item_tag it
                        where it.sigint_inbox_item_id = i.id
                    )
            ) as x;
    "#,
    )
    .await
    .c(h!())?;
    info!("done oneoff_fill_sigint_inbox_item_tags");
    Ok(())
}
