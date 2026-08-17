for units we have hierarchy of echeclons - companym, batallion, brigade etc. when we link sigint unit to orbit unit - we should fill in missing echeclons for sigint unit: select lowest filled in echelon in sigint unit,
  then find all higher echelons that are empty (we consider Other as a special case, always check it), and if checked sigint_unit echelon is empty but orbit_unit echelon is filled in - propagate value from orbit unit. this
  should be default behavior for new units, als add his as a oneoff command in orbit units TUI. also, please add a function and call it both within this oneoff and within code that links sigint unit to orbit unit; the
  function should perform this check: if sigint unit is linked to an orbit unit, and orbit unit has lowest echelon that is lower than sigint_unit's lowest echelon - we should mark this sigint_unit as inconsistent. please
  add a new db column to sigint column called is_inconsistent (boolean not null default false), and et it to true in this case. if somebody edits sigint_unit - this property shoule be re-calculated. it should not be visible
 
  or editable anywhere on web UI. please also add tab Неконсистентні підрозділи to /admin/unit-duplicates, it should contain neatly formatted card that explains what is this tab and why units end up here, then we should
  render the table with all sigint_units with is_inconsistent = true, column with name, column with comma-separated list of problematic echelons, and a link to sigint_unit details page, so user could go fix that unit.

also, this oneoff should join duplicate candidates that have identical names.
