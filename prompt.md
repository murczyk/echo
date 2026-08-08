we have /admin/all-reports page under Адмін -> Бази Даних. please add a new page in the
  same dropdown, next to All Reports, called Дублікати Підрозділів (/admin/unit-duplicates).
  it should contain the same table component we use for Бази Даних; just collect all orbit
  units that have 2+ sigint_units linked to them, and show that sigint units in the table. we
 
  want columns for sigint_unit.name, sigint_unit name segments (company, army etc) just like
  we have on /rer-unit and /rer-unit/{id} (skip empty, canocatenate with space), ornit_unit
  full name (look it up in the same place), button Об'єднати that does the same what
  Об`єднати es at /rer-units in sigint unit actions
