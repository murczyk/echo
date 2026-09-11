module UnitHierarchyTests exposing (suite)

import Bindings as B
import Core.UnitHierarchy
import Expect
import Test exposing (Test, describe, test)


createUnit : Int -> String -> String -> String -> String -> Bool -> B.Unit
createUnit id army militaryDistrict armyRegion name active =
    { id = id
    , other = ""
    , teamOrCrew = ""
    , section = ""
    , squad = ""
    , platoon = ""
    , company = ""
    , battalion = ""
    , regiment = ""
    , brigade = ""
    , division = ""
    , corps = ""
    , army = army
    , militaryDistrict = militaryDistrict
    , armyRegion = armyRegion
    , comment = ""
    , orbitNote = Nothing
    , presentInOrbit = Nothing
    , name = name
    , active = active
    , isDeduplicateCandidate = Nothing
    , createdAt = 0
    , createdByLoginId = ""
    , hasOrbit = False
    , orbitUnitIds = []
    , orbitUnitGenerativeNames = []
    }


suite : Test
suite =
    describe "UnitHierarchy"
        [ describe "getUnitCount"
            [ test "returns 0 for non-existent unit" <|
                \_ ->
                    let
                        unitStats =
                            [ { unitId = 1, count = 5 }
                            , { unitId = 2, count = 3 }
                            ]
                    in
                    Core.UnitHierarchy.getUnitCount 999 unitStats
                        |> Expect.equal 0
            , test "returns correct count for existing unit" <|
                \_ ->
                    let
                        unitStats =
                            [ { unitId = 1, count = 5 }
                            , { unitId = 2, count = 3 }
                            ]
                    in
                    Core.UnitHierarchy.getUnitCount 1 unitStats
                        |> Expect.equal 5
            ]
        , describe "calculateGroupCount"
            [ test "calculates total count for a group of units" <|
                \_ ->
                    let
                        units =
                            [ createUnit 1 "" "" "" "Unit 1" True
                            , createUnit 2 "" "" "" "Unit 2" True
                            ]

                        unitStats =
                            [ { unitId = 1, count = 5 }
                            , { unitId = 2, count = 3 }
                            ]
                    in
                    Core.UnitHierarchy.calculateGroupCount units unitStats
                        |> Expect.equal 8
            ]
        , describe "buildHierarchy"
            [ test "builds hierarchy from units" <|
                \_ ->
                    let
                        units =
                            [ createUnit 1 "Army A" "" "" "Unit 1" True
                            , createUnit 2 "Army B" "" "" "Unit 2" True
                            , createUnit 3 "Army A" "" "" "Unit 3" True
                            ]
                    in
                    Core.UnitHierarchy.buildHierarchy units
                        |> .armies
                        |> List.length
                        |> Expect.equal 2
            , test "filters out inactive units" <|
                \_ ->
                    let
                        units =
                            [ createUnit 1 "Army A" "" "" "Unit 1" True
                            , createUnit 2 "Army B" "" "" "Unit 2" False
                            ]
                    in
                    Core.UnitHierarchy.buildHierarchy units
                        |> .armies
                        |> List.length
                        |> Expect.equal 1
            , test "handles units with no child levels" <|
                \_ ->
                    let
                        units =
                            [ createUnit 1 "управління авіацією ПКС зс рф" "" "" "управління авіацією ПКС зс рф" True
                            ]
                    in
                    Core.UnitHierarchy.buildHierarchy units
                        |> .armies
                        |> List.length
                        |> Expect.equal 1
            , test "uses upper echelons instead of an empty army group" <|
                \_ ->
                    let
                        units =
                            [ createUnit 1 "" "Західний ВО" "ЗС РФ" "Західний ВО ЗС РФ" True
                            , createUnit 2 "" "" "ЗС РФ" "ЗС РФ" True
                            ]
                    in
                    Core.UnitHierarchy.buildHierarchy units
                        |> .armies
                        |> List.map Tuple.first
                        |> Expect.equal (List.sort [ "Західний ВО ЗС РФ", "ЗС РФ" ])
            , test "keeps same-named armies in different districts and regions separate" <|
                \_ ->
                    let
                        units =
                            [ createUnit 1 "1 А" "Західний ВО" "ЗС РФ" "1 А Західний ВО ЗС РФ" True
                            , createUnit 2 "1 А" "Східний ВО" "ЗС РФ" "1 А Східний ВО ЗС РФ" True
                            , createUnit 3 "1 А" "Західний ВО" "Інший регіон" "1 А Західний ВО Інший регіон" True
                            ]
                    in
                    Core.UnitHierarchy.buildHierarchy units
                        |> .armies
                        |> List.map Tuple.first
                        |> Expect.equal (List.sort [ "1 А Західний ВО ЗС РФ", "1 А Східний ВО ЗС РФ", "1 А Західний ВО Інший регіон" ])
            ]
        ]
