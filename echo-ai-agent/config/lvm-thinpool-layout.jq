def incus_thin_volume:
  .segtype == "thin"
  and (.lv_name | test("^(containers|virtual-machines|images|custom|backups)_"));

([.report[].lv[] | select(.vg_name == $vg)] | length >= 1)
and ([.report[].lv[] | select(
  .vg_name == $vg
  and .lv_name == $thinpool
  and .segtype == "thin-pool"
)] | length == 1)
and (all(
  .report[].lv[];
  .vg_name != $vg
  or (.lv_name == $thinpool and .segtype == "thin-pool")
  or incus_thin_volume
))
