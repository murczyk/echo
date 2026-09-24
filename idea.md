# Items to fix:
1. at /rer-units-neo get rid of 'probably a duplicate' warning, we don't want them there.
2. we shold add Activity tab and Interceptions tab as last 2 tabs at /rer-units/id page (Activity is last, Interceptions is second to last). 
when you open Activity - you can select period of day, week, month or 3 months - and we show chart that says how much 
  interceptions were linked to this unit during the period; it's basic columns chart, similar to radionetworks activity chart at /rer-freqs page. check whether we need to add a new index
  in order to support this functionality.
when you open Interceptions - it's basically the same as clicking ПЕРЕЙТИ in 'Приклади перехоплень' column at /admin/units?tab=unparsed: 
  we load latest 5 interceptions that user is allowed to view and show the 'show more' button. 
3. let's have a worker running once an hour. it runs this sql query: 
  'select iu.unit_id, count(*) as cnt from sigint_inbox_item_unit iu inner join sigint_unit u on u.id = iu.unit_id where u.active = false and not (u.deleted) and iu.created_at > now() - interval '7 days' group by iu.unit_id having count(*) > 100;'
resulting unit IDs are units that should be activated. we activate them and make sure it's represented in the changelog that they were activated at some point in time.
4. We should not create sigint units for orbit units that have echelon name = 'Other'. 
  you can find them with this sql query: 'select unit_id from orbit_unit where unit_echelon_id = (select id from orbit_unit where key = 'other')'.
  so we need to add integrations tab to /admin/system-settings-neo (like /admin/system-settings-neo#integrations), the last one - Інтеграції. There we should add a block called Orbit.
  there we should have toggle 'Не імпортувати підрозділи управління, штаби, полігони' (optional bool, nullable, fall back to true, if false - we do not exclude them on import actions I've mentined); and
  'Видалити підрозділи управління' red button (double-check ARE YOU SURE when pressed) - findes the orbit units with mentioned sql query, deletes 
  ONLY their linked inactive sigint units. if there's at least one linked active sigint unit that is linked to orbit sigint unit taht's up for removal - do not delete anything, 
  collect such roadblock units and show them as a list (name is clickable to open that unit's page on name clicked), and warning that ths operation is blocked until user manually deletes 
  these units or at least unlinks them from orbit and fixes them; also allow to ignore them (so we don't remove such active sigint units and just proceed with removing inactive ones).
  if no roadblocks - delete the sigint_unitas that are up to removal + show quantity of deleted items. We want to keep unlinked orbit units. 
5. at page rer-units/{id} tabs Керування, Журнал змін, Активність, Перехоплення should all be only available for admin, 
  add shield icon before tab name for all 4 tabs - so it's clear it's admin-only stuff.
6. when we have orbit_unit but no corresponding sigint_unit - let's still show it at 'Підпорядковані підрозділи' tab at /rer-units/{id}, but such units names have format like regular text 
  (so format them correspondingly) and not clickable - because there's no unit to click on.
7. when editing sigint unit at /rer-units/{id} and press edit on sigint unit data - we should allow to set wheter unit is present/absent in orbit and whether it's a dupe. right now we can do that only from /rer-units-neo.
8. when we show that unit is not linked to orbit - we show a red crossed circle now, with tooltip 'Не прив'язано до ORBIT'. instead let's do this: we have 3 conditions - linked to orbit, not linked but might be in orbit, definetely absent in orbit. for the st state it's the green circle like now, 
  for 2nd let's show a warning sign with tooltip 'Не вдалося встановити прив'язку підрозділу до запису в Orbit', 
  for 3rd keep the red circle right now and tooltip 'Підрозділ відсутній в Orbit'.
  let's support sorting on backend in that order - green, yellow, red.
