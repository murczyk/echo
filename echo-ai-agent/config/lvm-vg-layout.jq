([.report[].vg[]] | length == 1)
and ([.report[].vg[]][0].vg_name == $vg)
and ([.report[].vg[]][0].pv_count == "1")
and (([.report[].vg[]][0].lv_count | tonumber) >= 1)
