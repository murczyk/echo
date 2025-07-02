module UnitHierarchy exposing 
    ( UnitGroup
    , UnitHierarchy
    , groupByField
    , getUnitCount
    , filterActiveUnits
    , buildArmies
    , buildDivisions
    , buildRegiments
    , buildBattalions
    , buildCompanies
    , buildRegimentsUnderArmy
    , buildBattalionsUnderArmy
    , calculateGroupCount
    , sortUnitsByName
    )

{-| UnitHierarchy module provides pure functions for organizing military units into hierarchical structures.

This module extracts the unit filtering and grouping logic from the RerCallsigns page,
making it testable and reusable across the application.

The hierarchy follows the military structure: Army -> Division -> Regiment -> Battalion -> Company
-}

import Bindings as B
import Dict exposing (Dict)
import List.Extra as ListX


-- Types

{-| Represents a group of units at any hierarchy level with metadata
-}
type alias UnitGroup =
    { name : String
    , units : List B.Unit
    , count : Int
    }


{-| Represents the complete hierarchical structure of units
-}
type alias UnitHierarchy =
    { armies : List ( String, List B.Unit )
    }


-- Core grouping function

{-| Groups units by a specific field (e.g., army, division, regiment)
Returns a list of tuples with the field value and the list of units
-}
groupByField : (B.Unit -> String) -> List B.Unit -> List ( String, List B.Unit )
groupByField field units =
    let
        add : B.Unit -> Dict String (List B.Unit) -> Dict String (List B.Unit)
        add unit acc =
            let 
                key = field unit
            in
            Dict.update key (\maybe -> Just (unit :: Maybe.withDefault [] maybe)) acc
    in
    List.foldr add Dict.empty units
        |> Dict.toList
        |> List.sortBy Tuple.first


-- Unit count functions

{-| Gets the count for a specific unit from unit statistics
-}
getUnitCount : Int -> List B.CallsignUnitStatRow -> Int
getUnitCount unitId unitStats =
    case ListX.find (\s -> s.unitId == unitId) unitStats of
        Just stat -> stat.count
        Nothing -> 0


{-| Calculates the total count for a group of units
-}
calculateGroupCount : List B.Unit -> List B.CallsignUnitStatRow -> Int
calculateGroupCount units unitStats =
    List.sum (List.map (\unit -> getUnitCount unit.id unitStats) units)


-- Filtering functions

{-| Filters out inactive units from a list
-}
filterActiveUnits : List B.Unit -> List B.Unit
filterActiveUnits units =
    List.filter .active units


-- Hierarchy building functions

{-| Groups all active units by army
-}
buildArmies : List B.Unit -> List ( String, List B.Unit )
buildArmies units =
    groupByField .army (filterActiveUnits units)


{-| Groups units by division within a specific army
-}
buildDivisions : String -> List B.Unit -> List ( String, List B.Unit )
buildDivisions armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName)
        |> groupByField .division


{-| Groups units by regiment within a specific division and army
-}
buildRegiments : String -> String -> List B.Unit -> List ( String, List B.Unit )
buildRegiments armyName divisionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && u.division == divisionName)
        |> groupByField .regiment


{-| Groups units by regiment directly under an army (for units without division)
-}
buildRegimentsUnderArmy : String -> List B.Unit -> List ( String, List B.Unit )
buildRegimentsUnderArmy armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && String.isEmpty u.division && not (String.isEmpty u.regiment))
        |> groupByField .regiment


{-| Groups units by battalion within a specific regiment, division, and army
-}
buildBattalions : String -> String -> String -> List B.Unit -> List ( String, List B.Unit )
buildBattalions armyName divisionName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && u.division == divisionName && u.regiment == regimentName)
        |> groupByField .battalion


{-| Groups units by battalion within a regiment directly under an army (for regiments without division)
-}
buildBattalionsUnderArmy : String -> String -> List B.Unit -> List ( String, List B.Unit )
buildBattalionsUnderArmy armyName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && String.isEmpty u.division && u.regiment == regimentName)
        |> groupByField .battalion


{-| Gets companies within a specific battalion, regiment, division, and army
Returns a flat list of units sorted by company name
-}
buildCompanies : String -> String -> String -> String -> List B.Unit -> List B.Unit
buildCompanies armyName divisionName regimentName battalionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && u.division == divisionName && u.regiment == regimentName && u.battalion == battalionName)
        |> sortUnitsByName


-- Utility functions

{-| Sorts units by their name
-}
sortUnitsByName : List B.Unit -> List B.Unit
sortUnitsByName units =
    List.sortBy .name units 