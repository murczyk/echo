use crate::config::NETWORK_RECALCULATION_LAST_SEEN_PROBE_LIMIT;

pub(super) fn values_query() -> String {
    let probe_limit = NETWORK_RECALCULATION_LAST_SEEN_PROBE_LIMIT;
    let dated = dated_activity_query();
    format!(
        r#"
        with target as materialized (
            select nf.id, nf.network_id, nf.freq,
                   greatest(nf.active_from, network.active_from) as since,
                   least(coalesce(nf.active_to, current_timestamp at time zone 'utc'),
                         coalesce(network.active_to, current_timestamp at time zone 'utc')) as till,
                   network.id is not null as network_exists
            from sigint_network_freq nf
            left join sigint_network network on network.id = nf.network_id and not network.deleted
            where nf.id = any($1::bigint[]) and not nf.deleted
        )
        select target.id, (
            with members as materialized (
                select sigint_inbox_item_id as id
                from sigint_inbox_item_network
                where target.network_exists and sigint_network_id = target.network_id
                order by sigint_inbox_item_id
                limit {probe_limit}
            )
            select case when (select count(*) from members) < {probe_limit} then (
                select max(coalesce(ii.datetime, sm.timestamp, sm.created_at))
                from members
                join sigint_inbox_item ii on ii.id = members.id and ii.freq = target.freq
                join signal_message sm on sm.id = ii.id and not sm.deleted
                where coalesce(ii.datetime, sm.timestamp, sm.created_at) between target.since and target.till
            ) else greatest(
                ({dated}),
                (
                    select max(coalesce(sm.timestamp, sm.created_at))
                    from sigint_inbox_item ii
                    join signal_message sm on sm.id = ii.id and not sm.deleted
                    where ii.freq = target.freq and ii.datetime is null
                      and coalesce(sm.timestamp, sm.created_at) between target.since and target.till
                      and exists (
                          select 1 from sigint_inbox_item_network member
                          where member.sigint_network_id = target.network_id
                            and member.sigint_inbox_item_id = ii.id
                      )
                )
            ) end
        ) as last_seen_dt
        from target
        "#
    )
}

fn dated_activity_query() -> String {
    // A failed recent probe must still inspect older network members.
    let probe_limit = NETWORK_RECALCULATION_LAST_SEEN_PROBE_LIMIT;
    format!(
        r#"
        with recent as materialized (
            select id, datetime
            from sigint_inbox_item
            where freq = target.freq and datetime is not null
              and datetime between target.since and target.till
            order by datetime desc
            limit {probe_limit}
        )
        select coalesce(
            (
                select recent.datetime
                from recent
                where exists (
                    select 1 from sigint_inbox_item_network member
                    where member.sigint_network_id = target.network_id
                      and member.sigint_inbox_item_id = recent.id
                )
                  and exists (
                      select 1 from signal_message sm
                      where sm.id = recent.id and not sm.deleted
                      offset 0
                  )
                order by recent.datetime desc
                limit 1
            ),
            case when (select count(*) from recent) = {probe_limit} then (
                select max(ii.datetime)
                from sigint_inbox_item_network member
                join lateral (
                    select id, datetime from sigint_inbox_item
                    where id = member.sigint_inbox_item_id and freq = target.freq
                      and datetime is not null
                      and datetime between target.since and target.till
                    offset 0
                ) ii on true
                join signal_message sm on sm.id = ii.id and not sm.deleted
                where member.sigint_network_id = target.network_id
            ) end
        )
        "#
    )
}
