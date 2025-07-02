module UnitHierarchy exposing 
    ( Config
    , UnitGroup
    , UnitHierarchy
    , buildHierarchy
    , getUnitCount
    , calculateGroupCount
    , view
    )

{-| UnitHierarchy module provides pure functions for organizing military units into hierarchical structures.

This module extracts the unit filtering and grouping logic from the RerCallsigns page,
making it testable and reusable across the application.

The hierarchy follows the military structure: Army -> Division -> Regiment -> Battalion -> Company

## Usage

```elm
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
```

## API

@docs Config, UnitGroup, UnitHierarchy, buildHierarchy, getUnitCount, calculateGroupCount, view
-}

import Bindings as B
import Dict exposing (Dict)
import Html exposing (Html, div, h3, p, span, i, button)
import Html.Attributes as Attr exposing (class, title)
import Html.Events exposing (onClick)
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
    }


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


-- Internal types

type alias InternalUnitGroup =
    { name : String
    , units : List B.Unit
    }


-- Core grouping function (internal)

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


-- Internal filtering functions

filterActiveUnits : List B.Unit -> List B.Unit
filterActiveUnits units =
    List.filter .active units


-- Internal hierarchy building functions

buildArmies : List B.Unit -> List ( String, List B.Unit )
buildArmies units =
    groupByField .army (filterActiveUnits units)


buildDivisions : String -> List B.Unit -> List ( String, List B.Unit )
buildDivisions armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName)
        |> groupByField .division


buildRegiments : String -> String -> List B.Unit -> List ( String, List B.Unit )
buildRegiments armyName divisionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && u.division == divisionName)
        |> groupByField .regiment


buildRegimentsUnderArmy : String -> List B.Unit -> List ( String, List B.Unit )
buildRegimentsUnderArmy armyName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && String.isEmpty u.division && not (String.isEmpty u.regiment))
        |> groupByField .regiment


buildBattalions : String -> String -> String -> List B.Unit -> List ( String, List B.Unit )
buildBattalions armyName divisionName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && u.division == divisionName && u.regiment == regimentName)
        |> groupByField .battalion


buildBattalionsUnderArmy : String -> String -> List B.Unit -> List ( String, List B.Unit )
buildBattalionsUnderArmy armyName regimentName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && String.isEmpty u.division && u.regiment == regimentName)
        |> groupByField .battalion


buildCompanies : String -> String -> String -> String -> List B.Unit -> List B.Unit
buildCompanies armyName divisionName regimentName battalionName units =
    units
        |> filterActiveUnits
        |> List.filter (\u -> u.army == armyName && u.division == divisionName && u.regiment == regimentName && u.battalion == battalionName)
        |> sortUnitsByName


-- Internal utility functions

sortUnitsByName : List B.Unit -> List B.Unit
sortUnitsByName units =
    List.sortBy .name units


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
        hierarchy = buildHierarchy units
    in
    div [ class "w-full max-w-md bg-card border rounded-lg shadow-sm overflow-hidden" ]
        [ div [ class "p-4 border-b border-gray-200 dark:border-gray-700" ]
            [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2" ] 
                [ Html.text "Підрозділи" ]
            , p [ class "text-sm text-gray-600 dark:text-gray-400" ] 
                [ Html.text "Оберіть підрозділ для фільтрації" ]
            ]
        , div [ class "max-h-96 overflow-y-auto" ]
            (List.map (renderArmy config unitStats units) hierarchy.armies)
        , if not (String.isEmpty config.selectedUnit) then
            div [ class "p-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800" ]
                [ Html.button
                    [ class "btn btn-secondary"
                    , Html.Events.onClick (config.onUnitClick "")
                    ]
                    [ Html.text "Очистити фільтр" ]
                ]
          else
            Html.text ""
        ]


-- Internal view functions

renderArmy : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> ( String, List B.Unit ) -> Html msg
renderArmy config unitStats units ( armyName, armyUnits ) =
    let
        armyCount = calculateGroupCount armyUnits unitStats
        armyCountText = if armyCount > 0 then " (" ++ String.fromInt armyCount ++ ")" else ""
        displayName = if String.isEmpty armyName then "Без армії" else armyName
        isExpanded = config.isArmyExpanded armyName
    in
    div [ class "border-b border-gray-200 dark:border-gray-700" ]
        [ div 
            [ class "px-3 py-2 font-semibold text-gray-900 dark:text-gray-100 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-between"
            , Html.Events.onClick (config.onArmyToggle armyName)
            ]
            [ Html.span [ class "flex items-center gap-2" ] 
                [ armyIndicator
                , Html.text (displayName ++ armyCountText)
                ]
            , Html.i [ class ("bi " ++ (if isExpanded then "bi-chevron-up" else "bi-chevron-down") ++ " text-gray-500") ] []
            ]
        , renderDivisions config unitStats units armyName
        ]


renderDivisions : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> Html msg
renderDivisions config unitStats units armyName =
    let
        divisionGroups = buildDivisions armyName units
        regimentsUnderArmyGroups = buildRegimentsUnderArmy armyName units
        isExpanded = config.isArmyExpanded armyName
    in
    if List.isEmpty divisionGroups && List.isEmpty regimentsUnderArmyGroups then
        Html.text ""
    else if not isExpanded then
        Html.text ""
    else
        div [ class "ml-6 space-y-1" ]
            (List.concatMap
                (\(divisionName, divisionUnits) ->
                    if String.isEmpty divisionName then
                        []
                    else
                        let
                            divisionCount = calculateGroupCount divisionUnits unitStats
                            divisionCountText = if divisionCount > 0 then " (" ++ String.fromInt divisionCount ++ ")" else ""
                            isDivisionExpanded = config.isDivisionExpanded armyName divisionName
                        in
                        [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                            , Html.Events.onClick (config.onDivisionToggle armyName divisionName)
                            ]
                            [ Html.span [ class "flex items-center gap-2" ] 
                                [ divisionIndicator
                                , Html.text (divisionName ++ divisionCountText)
                                ]
                            , Html.i [ class ("bi " ++ (if isDivisionExpanded then "bi-chevron-up" else "bi-chevron-down") ++ " text-gray-500") ] []
                            ]
                        , renderRegiments config unitStats units armyName divisionName
                        ]
                )
                divisionGroups
            ++ List.concatMap
                (\(regimentName, regimentUnits) ->
                    let
                        regimentCount = calculateGroupCount regimentUnits unitStats
                        regimentCountText = if regimentCount > 0 then " (" ++ String.fromInt regimentCount ++ ")" else ""
                        isRegimentExpanded = config.isRegimentExpanded armyName "" regimentName
                    in
                    [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        , Html.Events.onClick (config.onRegimentToggle armyName "" regimentName)
                        ]
                        [ Html.span [ class "flex items-center gap-2" ] 
                            [ regimentIndicator
                            , Html.text (regimentName ++ regimentCountText)
                            ]
                        , Html.i [ class ("bi " ++ (if isRegimentExpanded then "bi-chevron-up" else "bi-chevron-down") ++ " text-gray-500") ] []
                        ]
                    , renderBattalions config unitStats units armyName "" regimentName
                    ]
                )
                regimentsUnderArmyGroups
            )


renderRegiments : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> String -> Html msg
renderRegiments config unitStats units armyName divisionName =
    let
        regimentGroups = buildRegiments armyName divisionName units
        isExpanded = config.isDivisionExpanded armyName divisionName
    in
    if List.isEmpty regimentGroups then
        Html.text ""
    else if not isExpanded then
        Html.text ""
    else
        div [ class "ml-6 space-y-1" ]
            (List.concatMap
                (\(regimentName, regimentUnits) ->
                    if String.isEmpty regimentName then
                        List.map (renderUnit config unitStats) regimentUnits
                    else
                        let
                            regimentCount = calculateGroupCount regimentUnits unitStats
                            regimentCountText = if regimentCount > 0 then " (" ++ String.fromInt regimentCount ++ ")" else ""
                            isRegimentExpanded = config.isRegimentExpanded armyName divisionName regimentName
                        in
                        [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                            , Html.Events.onClick (config.onRegimentToggle armyName divisionName regimentName)
                            ]
                            [ Html.span [ class "flex items-center gap-2" ] 
                                [ regimentIndicator
                                , Html.text (regimentName ++ regimentCountText)
                                ]
                            , Html.i [ class ("bi " ++ (if isRegimentExpanded then "bi-chevron-up" else "bi-chevron-down") ++ " text-gray-500") ] []
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
        isExpanded = config.isRegimentExpanded armyName divisionName regimentName
    in
    if List.isEmpty battalionGroups then
        Html.text ""
    else if not isExpanded then
        Html.text ""
    else
        div [ class "ml-6 space-y-1" ]
            (List.concatMap
                (\(battalionName, battalionUnits) ->
                    if String.isEmpty battalionName then
                        List.map (renderUnit config unitStats) battalionUnits
                    else
                        let
                            battalionCount = calculateGroupCount battalionUnits unitStats
                            battalionCountText = if battalionCount > 0 then " (" ++ String.fromInt battalionCount ++ ")" else ""
                            isBattalionExpanded = config.isBattalionExpanded armyName divisionName regimentName battalionName
                        in
                        [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                            , Html.Events.onClick (config.onBattalionToggle armyName divisionName regimentName battalionName)
                            ]
                            [ Html.span [ class "flex items-center gap-2" ] 
                                [ battalionIndicator
                                , Html.text (battalionName ++ battalionCountText)
                                ]
                            , Html.i [ class ("bi " ++ (if isBattalionExpanded then "bi-chevron-up" else "bi-chevron-down") ++ " text-gray-500") ] []
                            ]
                        , renderCompanies config unitStats units armyName divisionName regimentName battalionName
                        ]
                )
                battalionGroups
            )


renderCompanies : Config msg -> List B.CallsignUnitStatRow -> List B.Unit -> String -> String -> String -> String -> Html msg
renderCompanies config unitStats units armyName divisionName regimentName battalionName =
    let
        companyUnits = buildCompanies armyName divisionName regimentName battalionName units
    in
    if List.isEmpty companyUnits then
        Html.text ""
    else
        div [ class "ml-6 space-y-1" ]
            (List.map (renderUnit config unitStats) companyUnits)


renderUnit : Config msg -> List B.CallsignUnitStatRow -> B.Unit -> Html msg
renderUnit config unitStats unit =
    let
        count = getUnitCount unit.id unitStats
        isSelected = config.selectedUnit == unit.name
        countText = if count > 0 then " (" ++ String.fromInt count ++ ")" else ""
    in
    div
        [ class ("px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors " ++ 
                if isSelected then "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500" else "")
        , Html.Events.onClick (config.onUnitClick unit.name)
        ]
        [ Html.text (unit.name ++ countText) ]


-- Military hierarchy indicators

armyIndicator : Html msg
armyIndicator = 
    Html.span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Армія" ] 
        [ Html.text "XXX" ]


divisionIndicator : Html msg
divisionIndicator = 
    Html.span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Дивізія" ] 
        [ Html.text "XX" ]


regimentIndicator : Html msg
regimentIndicator = 
    Html.span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Полк" ] 
        [ Html.text "X" ]


battalionIndicator : Html msg
battalionIndicator = 
    Html.span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Батальйон" ] 
        [ Html.text "I" ]


companyIndicator : Html msg
companyIndicator = 
    Html.span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Рота" ] 
        [ Html.text "II" ] 