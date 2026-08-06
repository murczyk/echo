module Core.UnitHierarchy exposing (Config, UnitHierarchy, buildHierarchy, getUnitCount, calculateGroupCount, view)

{-| UnitHierarchy module provides pure functions for organizing military units into hierarchical structures.

This module extracts the unit filtering and grouping logic from the callsigns page,
making it testable and reusable across the application.

The hierarchy follows the military structure: Army -> Division -> Regiment -> Battalion -> Company

Units without child levels (e.g., units that are themselves the army/division/regiment/battalion)
are rendered as clickable filter options rather than expandable dropdowns.


## Usage

    import UnitHierarchy exposing (Config, view)

    -- Create a configuration for your specific use case
    config : Config Msg
    config =
        { onUnitClick = FilterUnitMsg
        , onArmyToggle = ToggleArmyExpanded
        , onDivisionToggle = ToggleDivisionExpanded
        , onRegimentToggle = ToggleRegimentExpanded
        , onBattalionToggle = ToggleBattalionExpanded
        , isArmyExpanded = \armyName -> Set.member armyName model.expandedArmies
        , isDivisionExpanded = \armyName divisionName -> Set.member (armyName ++ ":" ++ divisionName) model.expandedDivisions
        , isRegimentExpanded = \armyName divisionName regimentName -> Set.member (armyName ++ ":" ++ divisionName ++ ":" ++ regimentName) model.expandedRegiments
        , isBattalionExpanded = \armyName divisionName regimentName battalionName -> Set.member (armyName ++ ":" ++ divisionName ++ ":" ++ regimentName ++ ":" ++ battalionName) model.expandedBattalions
        , selectedUnit = model.filterUnit
        }

    -- Use the view function to render the hierarchy
    UnitHierarchy.view config model.units model.unitStats


## API

@docs Config, UnitHierarchy, buildHierarchy, getUnitCount, calculateGroupCount, view

-}

import Bindings as B
import Dict exposing (Dict)
import Html exposing (Html, div)
import Html.Attributes as Attr exposing (class)
import Html.Events
import List.Extra as ListX



-- Types


{-| Configuration for the unit hierarchy
-}
type alias Config msg =
    { onUnitClick : String -> msg
    , onArmyToggle : String -> msg
    , onDivisionToggle : String -> String -> msg
    , onRegimentToggle : String -> String -> String -> msg
    , onBattalionToggle : String -> String -> String -> String -> msg
    , isArmyExpanded : String -> Bool
    , isDivisionExpanded : String -> String -> Bool
    , isRegimentExpanded : String -> String -> String -> Bool
    , isBattalionExpanded : String -> String -> String -> String -> Bool
    , selectedUnit : String
    , autoExpandArmies : Bool
    , autoExpandDivisions : Bool
    , autoExpandRegiments : Bool
    , autoExpandBattalions : Bool
    }


{-| Represents the complete hierarchical structure of units
-}
type alias UnitHierarchy =
    { armies : List ( String, List B.Unit )
    }



-- Internal types
-- Core grouping function (internal)


groupByField : (B.Unit -> String) -> List B.Unit -> List ( String, List B.Unit )
groupByField field units =
    let
        add : B.Unit -> Dict String (List B.Unit) -> Dict String (List B.Unit)
        add unit acc =
            let
                key =
                    field unit
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
        Just stat ->
            stat.count

        Nothing ->
            0


{-| Calculates the total count for a group of units
-}
calculateGroupCount : List B.Unit -> List B.CallsignUnitStatRow -> Int
calculateGroupCount units unitStats =
    List.sum (List.map (\unit -> getUnitCount unit.id unitStats) units)



-- Internal filtering functions


filterActiveUnits : List B.Unit -> List B.Unit
filterActiveUnits units =
    List.filter .active units


topHierarchyLevel : B.Unit -> String
topHierarchyLevel unit =
    if not (String.isEmpty unit.army) then
        unit.army

    else if not (String.isEmpty unit.militaryDistrict) then
        unit.militaryDistrict

    else
        unit.armyRegion



-- Internal hierarchy building functions


buildArmies : List B.Unit -> List ( String, List B.Unit )
buildArmies units =
    groupByField topHierarchyLevel (filterActiveUnits units)


buildDivisions : String -> List B.Unit -> List ( String, List B.Unit )
buildDivisions armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName)
        |> groupByField .division


buildRegiments : String -> String -> List B.Unit -> List ( String, List B.Unit )
buildRegiments armyName divisionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && u.division == divisionName)
        |> groupByField .regiment


buildRegimentsUnderArmy : String -> List B.Unit -> List ( String, List B.Unit )
buildRegimentsUnderArmy armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && String.isEmpty u.division && not (String.isEmpty u.regiment))
        |> groupByField .regiment


buildBattalions : String -> String -> String -> List B.Unit -> List ( String, List B.Unit )
buildBattalions armyName divisionName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && u.division == divisionName && u.regiment == regimentName)
        |> groupByField .battalion


buildBattalionsUnderArmy : String -> String -> List B.Unit -> List ( String, List B.Unit )
buildBattalionsUnderArmy armyName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && String.isEmpty u.division && u.regiment == regimentName)
        |> groupByField .battalion


buildCompanies : String -> String -> String -> String -> List B.Unit -> List B.Unit
buildCompanies armyName divisionName regimentName battalionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && u.division == divisionName && u.regiment == regimentName && u.battalion == battalionName)
        |> sortUnitsByName



-- Internal utility functions


sortUnitsByName : List B.Unit -> List B.Unit
sortUnitsByName units =
    List.sortBy .name units



-- Auto-expansion helper functions


{-| Counts total units under a specific army branch
-}
countUnitsUnderArmy : String -> List B.Unit -> Int
countUnitsUnderArmy armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName)
        |> List.length


{-| Counts total units under a specific division branch
-}
countUnitsUnderDivision : String -> String -> List B.Unit -> Int
countUnitsUnderDivision armyName divisionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && u.division == divisionName)
        |> List.length


{-| Counts total units under a specific regiment branch
-}
countUnitsUnderRegiment : String -> String -> String -> List B.Unit -> Int
countUnitsUnderRegiment armyName divisionName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> topHierarchyLevel u == armyName && u.division == divisionName && u.regiment == regimentName)
        |> List.length


{-| Determines if a branch should be auto-expanded (≤ 3 total units)
-}
shouldAutoExpand : Int -> Bool
shouldAutoExpand unitCount =
    unitCount <= 3



-- Public API


{-| Builds the complete unit hierarchy from a list of units
-}
buildHierarchy : List B.Unit -> UnitHierarchy
buildHierarchy units =
    { armies = buildArmies units
    }



-- View functions


{-| Renders the complete unit hierarchy view
-}
view : Config msg -> List B.Unit -> List B.CallsignUnitStatRow -> Html msg
view config units unitStats =
    let
        hierarchy =
            buildHierarchy units
    in
    div [ class "w-full h-full max-w-md bg-card border rounded-lg flex flex-col" ]
        [ div [ class " overflow-y-auto grow-1" ]
            (List.map (renderArmy config unitStats units) hierarchy.armies)
        ]



-- Internal view functions


renderArmy : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> ( String, List B.Unit ) -> Html msg
renderArmy config unitStats units ( armyName, armyUnits ) =
    let
        armyCount =
            calculateGroupCount armyUnits unitStats

        armyCountText =
            if armyCount > 0 then
                " (" ++ String.fromInt armyCount ++ ")"

            else
                ""

        displayName =
            if String.isEmpty armyName then
                "Без армії"

            else
                armyName

        isExpanded =
            config.isArmyExpanded armyName

        -- Check if this army has any child levels
        divisionGroups =
            buildDivisions armyName units

        regimentsUnderArmyGroups =
            buildRegimentsUnderArmy armyName units

        hasChildLevels =
            not (List.isEmpty divisionGroups) || not (List.isEmpty regimentsUnderArmyGroups)

        -- True leaf: only one unit, and all child fields are empty
        isTrueLeaf =
            case armyUnits of
                [ u ] ->
                    String.isEmpty u.division && String.isEmpty u.regiment && String.isEmpty u.battalion && String.isEmpty u.company

                _ ->
                    False

        -- If no child levels or true leaf, treat as a clickable unit
        isClickableUnit =
            not hasChildLevels || isTrueLeaf

        -- Auto-expansion logic
        shouldAutoExpandArmy =
            config.autoExpandArmies && shouldAutoExpand (countUnitsUnderArmy armyName units)

        effectiveIsExpanded =
            isExpanded || shouldAutoExpandArmy
    in
    div [ class "border-b border-gray-200 dark:border-gray-700" ]
        [ if isClickableUnit then
            -- Render as clickable unit
            div
                [ class
                    ("px-3 py-2 font-semibold text-gray-900 dark:text-gray-100 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors "
                        ++ (if config.selectedUnit == displayName then
                                "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

                            else
                                ""
                           )
                    )
                , Html.Events.onClick (config.onUnitClick displayName)
                ]
                [ Html.span [ class "flex items-center gap-2" ]
                    [ armyIndicator
                    , Html.text (displayName ++ armyCountText)
                    ]
                ]

          else
            -- Render as expandable army
            div
                [ class "px-3 py-2 font-semibold text-gray-900 dark:text-gray-100 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-between"
                , Html.Events.onClick (config.onArmyToggle armyName)
                ]
                [ Html.span [ class "flex items-center gap-2" ]
                    [ armyIndicator
                    , Html.text (displayName ++ armyCountText)
                    ]
                , Html.i
                    [ class
                        ("bi "
                            ++ (if effectiveIsExpanded then
                                    "bi-chevron-up"

                                else
                                    "bi-chevron-down"
                               )
                            ++ " text-gray-500"
                        )
                    ]
                    []
                ]
        , renderDivisions config unitStats units armyName
        ]


renderDivisions : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> Html msg
renderDivisions config unitStats units armyName =
    let
        divisionGroups =
            buildDivisions armyName units

        regimentsUnderArmyGroups =
            buildRegimentsUnderArmy armyName units

        isExpanded =
            config.isArmyExpanded armyName

        -- Auto-expansion logic
        shouldAutoExpandArmy =
            config.autoExpandArmies && shouldAutoExpand (countUnitsUnderArmy armyName units)

        effectiveIsExpanded =
            isExpanded || shouldAutoExpandArmy
    in
    if List.isEmpty divisionGroups && List.isEmpty regimentsUnderArmyGroups then
        Html.text ""

    else if not effectiveIsExpanded then
        Html.text ""

    else
        div [ class "ml-6 space-y-1" ]
            (List.concatMap
                (\( divisionName, divisionUnits ) ->
                    if String.isEmpty divisionName then
                        []

                    else
                        let
                            divisionCount =
                                calculateGroupCount divisionUnits unitStats

                            divisionCountText =
                                if divisionCount > 0 then
                                    " (" ++ String.fromInt divisionCount ++ ")"

                                else
                                    ""

                            isDivisionExpanded =
                                config.isDivisionExpanded armyName divisionName

                            -- Check if this division has any child levels
                            regimentGroups =
                                buildRegiments armyName divisionName units

                            hasChildLevels =
                                not (List.isEmpty regimentGroups)

                            isClickableUnit =
                                not hasChildLevels

                            -- Auto-expansion logic for division
                        in
                        if isClickableUnit then
                            -- Render as clickable unit
                            [ div
                                [ class
                                    ("font-medium text-gray-700 dark:text-gray-300 py-1 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors "
                                        ++ (if config.selectedUnit == divisionName then
                                                "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

                                            else
                                                ""
                                           )
                                    )
                                , Html.Events.onClick (config.onUnitClick divisionName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ divisionIndicator
                                    , Html.text (divisionName ++ divisionCountText)
                                    ]
                                ]
                            ]

                        else
                            -- Render as expandable division
                            [ div
                                [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                , Html.Events.onClick (config.onDivisionToggle armyName divisionName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ divisionIndicator
                                    , Html.text (divisionName ++ divisionCountText)
                                    ]
                                , if config.autoExpandDivisions then
                                    Html.text ""

                                  else
                                    Html.i
                                        [ class
                                            ("bi "
                                                ++ (if isDivisionExpanded then
                                                        "bi-chevron-up"

                                                    else
                                                        "bi-chevron-down"
                                                   )
                                                ++ " text-gray-500"
                                            )
                                        ]
                                        []
                                ]
                            , renderRegiments config unitStats units armyName divisionName
                            ]
                )
                divisionGroups
                ++ List.concatMap
                    (\( regimentName, regimentUnits ) ->
                        let
                            regimentCount =
                                calculateGroupCount regimentUnits unitStats

                            regimentCountText =
                                if regimentCount > 0 then
                                    " (" ++ String.fromInt regimentCount ++ ")"

                                else
                                    ""

                            isRegimentExpanded =
                                config.isRegimentExpanded armyName "" regimentName

                            -- Check if this regiment has any child levels
                            battalionGroups =
                                buildBattalionsUnderArmy armyName regimentName units

                            hasChildLevels =
                                not (List.isEmpty battalionGroups)

                            isClickableUnit =
                                not hasChildLevels

                            -- Auto-expansion logic for regiment
                        in
                        if isClickableUnit then
                            -- Render as clickable unit
                            [ div
                                [ class
                                    ("font-medium text-gray-700 dark:text-gray-300 py-1 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors "
                                        ++ (if config.selectedUnit == regimentName then
                                                "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

                                            else
                                                ""
                                           )
                                    )
                                , Html.Events.onClick (config.onUnitClick regimentName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ regimentIndicator
                                    , Html.text (regimentName ++ regimentCountText)
                                    ]
                                ]
                            ]

                        else
                            -- Render as expandable regiment
                            [ div
                                [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                , Html.Events.onClick (config.onRegimentToggle armyName "" regimentName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ regimentIndicator
                                    , Html.text (regimentName ++ regimentCountText)
                                    ]
                                , if config.autoExpandRegiments then
                                    Html.text ""

                                  else
                                    Html.i
                                        [ class
                                            ("bi "
                                                ++ (if isRegimentExpanded then
                                                        "bi-chevron-up"

                                                    else
                                                        "bi-chevron-down"
                                                   )
                                                ++ " text-gray-500"
                                            )
                                        ]
                                        []
                                ]
                            , renderBattalions config unitStats units armyName "" regimentName
                            ]
                    )
                    regimentsUnderArmyGroups
            )


renderRegiments : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> String -> Html msg
renderRegiments config unitStats units armyName divisionName =
    let
        regimentGroups =
            buildRegiments armyName divisionName units

        isExpanded =
            config.isDivisionExpanded armyName divisionName

        -- Auto-expansion logic for division
        shouldAutoExpandDivision =
            config.autoExpandDivisions && shouldAutoExpand (countUnitsUnderDivision armyName divisionName units)

        effectiveIsExpanded =
            isExpanded || shouldAutoExpandDivision
    in
    if List.isEmpty regimentGroups then
        Html.text ""

    else if not effectiveIsExpanded then
        Html.text ""

    else
        div [ class "ml-6 space-y-1" ]
            (List.concatMap
                (\( regimentName, regimentUnits ) ->
                    if String.isEmpty regimentName then
                        List.map (renderUnit config unitStats) regimentUnits

                    else
                        let
                            regimentCount =
                                calculateGroupCount regimentUnits unitStats

                            regimentCountText =
                                if regimentCount > 0 then
                                    " (" ++ String.fromInt regimentCount ++ ")"

                                else
                                    ""

                            isRegimentExpanded =
                                config.isRegimentExpanded armyName divisionName regimentName

                            -- Check if this regiment has any child levels
                            battalionGroups =
                                buildBattalions armyName divisionName regimentName units

                            hasChildLevels =
                                not (List.isEmpty battalionGroups)

                            isClickableUnit =
                                not hasChildLevels

                            -- Auto-expansion logic for regiment
                        in
                        if isClickableUnit then
                            -- Render as clickable unit
                            [ div
                                [ class
                                    ("font-medium text-gray-700 dark:text-gray-300 py-1 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors "
                                        ++ (if config.selectedUnit == regimentName then
                                                "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

                                            else
                                                ""
                                           )
                                    )
                                , Html.Events.onClick (config.onUnitClick regimentName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ regimentIndicator
                                    , Html.text (regimentName ++ regimentCountText)
                                    ]
                                ]
                            ]

                        else
                            -- Render as expandable regiment
                            [ div
                                [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                , Html.Events.onClick (config.onRegimentToggle armyName divisionName regimentName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ regimentIndicator
                                    , Html.text (regimentName ++ regimentCountText)
                                    ]
                                , if config.autoExpandRegiments then
                                    Html.text ""

                                  else
                                    Html.i
                                        [ class
                                            ("bi "
                                                ++ (if isRegimentExpanded then
                                                        "bi-chevron-up"

                                                    else
                                                        "bi-chevron-down"
                                                   )
                                                ++ " text-gray-500"
                                            )
                                        ]
                                        []
                                ]
                            , renderBattalions config unitStats units armyName divisionName regimentName
                            ]
                )
                regimentGroups
            )


renderBattalions : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> String -> String -> Html msg
renderBattalions config unitStats units armyName divisionName regimentName =
    let
        battalionGroups =
            if String.isEmpty divisionName then
                buildBattalionsUnderArmy armyName regimentName units

            else
                buildBattalions armyName divisionName regimentName units

        isExpanded =
            config.isRegimentExpanded armyName divisionName regimentName

        -- Auto-expansion logic for regiment
        shouldAutoExpandRegiment =
            config.autoExpandRegiments && shouldAutoExpand (countUnitsUnderRegiment armyName divisionName regimentName units)

        effectiveIsExpanded =
            isExpanded || shouldAutoExpandRegiment
    in
    if List.isEmpty battalionGroups then
        Html.text ""

    else if not effectiveIsExpanded then
        Html.text ""

    else
        div [ class "ml-6 space-y-1" ]
            (List.concatMap
                (\( battalionName, battalionUnits ) ->
                    if String.isEmpty battalionName then
                        List.map (renderUnit config unitStats) battalionUnits

                    else
                        let
                            battalionCount =
                                calculateGroupCount battalionUnits unitStats

                            battalionCountText =
                                if battalionCount > 0 then
                                    " (" ++ String.fromInt battalionCount ++ ")"

                                else
                                    ""

                            isBattalionExpanded =
                                config.isBattalionExpanded armyName divisionName regimentName battalionName

                            -- Check if this battalion has any child levels
                            companyUnits =
                                buildCompanies armyName divisionName regimentName battalionName units

                            hasChildLevels =
                                not (List.isEmpty companyUnits)

                            isClickableUnit =
                                not hasChildLevels

                            -- Auto-expansion logic for battalion
                        in
                        if isClickableUnit then
                            -- Render as clickable unit
                            [ div
                                [ class
                                    ("font-medium text-gray-700 dark:text-gray-300 py-1 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors "
                                        ++ (if config.selectedUnit == battalionName then
                                                "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

                                            else
                                                ""
                                           )
                                    )
                                , Html.Events.onClick (config.onUnitClick battalionName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ battalionIndicator
                                    , Html.text (battalionName ++ battalionCountText)
                                    ]
                                ]
                            ]

                        else
                            -- Render as expandable battalion
                            [ div
                                [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                , Html.Events.onClick (config.onBattalionToggle armyName divisionName regimentName battalionName)
                                ]
                                [ Html.span [ class "flex items-center gap-2" ]
                                    [ battalionIndicator
                                    , Html.text (battalionName ++ battalionCountText)
                                    ]
                                , if config.autoExpandBattalions then
                                    Html.text ""

                                  else
                                    Html.i
                                        [ class
                                            ("bi "
                                                ++ (if isBattalionExpanded then
                                                        "bi-chevron-up"

                                                    else
                                                        "bi-chevron-down"
                                                   )
                                                ++ " text-gray-500"
                                            )
                                        ]
                                        []
                                ]
                            , renderCompanies config unitStats units armyName divisionName regimentName battalionName
                            ]
                )
                battalionGroups
            )


renderCompanies : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> String -> String -> String -> Html msg
renderCompanies config unitStats units armyName divisionName regimentName battalionName =
    let
        companyUnits =
            buildCompanies armyName divisionName regimentName battalionName units
    in
    if List.isEmpty companyUnits then
        Html.text ""

    else
        div [ class "ml-6 space-y-1" ]
            (List.map (renderUnit config unitStats) companyUnits)


renderUnit : Config msg -> List B.CallsignUnitStatRow -> B.Unit -> Html msg
renderUnit config unitStats unit =
    let
        count =
            getUnitCount unit.id unitStats

        isSelected =
            config.selectedUnit == unit.name

        countText =
            if count > 0 then
                " (" ++ String.fromInt count ++ ")"

            else
                ""
    in
    div
        [ class
            ("px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors "
                ++ (if isSelected then
                        "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

                    else
                        ""
                   )
            )
        , Html.Events.onClick (config.onUnitClick unit.name)
        ]
        [ Html.text (unit.name ++ countText) ]



-- Military hierarchy indicators


armyIndicator : Html msg
armyIndicator =
    Html.span [ class "badge badge--neutral font-mono font-bold mr-2", Attr.title "Армія" ]
        [ Html.text "XXXX" ]


divisionIndicator : Html msg
divisionIndicator =
    Html.span [ class "badge badge--neutral font-mono font-bold mr-2", Attr.title "Дивізія" ]
        [ Html.text "XX" ]


regimentIndicator : Html msg
regimentIndicator =
    Html.span [ class "badge badge--neutral font-mono font-bold mr-2", Attr.title "Полк" ]
        [ Html.text "III" ]


battalionIndicator : Html msg
battalionIndicator =
    Html.span [ class "badge badge--neutral font-mono font-bold mr-2", Attr.title "Батальйон" ]
        [ Html.text "II" ]
