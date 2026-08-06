module UnitHierarchyTests exposing (suite)

import Core.UnitHierarchy
import Expect
import Test exposing (Test, describe, test)


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
                            [ { id = 1, company = "", battalion = "", regiment = "", division = "", army = "", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 1", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
                            , { id = 2, company = "", battalion = "", regiment = "", division = "", army = "", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 2", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
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
                            [ { id = 1, company = "", battalion = "", regiment = "", division = "", army = "Army A", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 1", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
                            , { id = 2, company = "", battalion = "", regiment = "", division = "", army = "Army B", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 2", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
                            , { id = 3, company = "", battalion = "", regiment = "", division = "", army = "Army A", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 3", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
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
                            [ { id = 1, company = "", battalion = "", regiment = "", division = "", army = "Army A", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 1", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
                            , { id = 2, company = "", battalion = "", regiment = "", division = "", army = "Army B", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "Unit 2", active = False, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
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
                            [ { id = 1, company = "", battalion = "", regiment = "", division = "", army = "управління авіацією ПКС зс рф", militaryDistrict = "", armyRegion = "", comment = "", orbitNote = Nothing, name = "управління авіацією ПКС зс рф", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
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
                            [ { id = 1, company = "", battalion = "", regiment = "", division = "", army = "", militaryDistrict = "Західний ВО", armyRegion = "ЗС РФ", comment = "", orbitNote = Nothing, name = "Західний ВО ЗС РФ", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
                            , { id = 2, company = "", battalion = "", regiment = "", division = "", army = "", militaryDistrict = "", armyRegion = "ЗС РФ", comment = "", orbitNote = Nothing, name = "ЗС РФ", active = True, isDeduplicateCandidate = Nothing, createdAt = 0, createdByLoginId = "", hasOrbit = False, orbitUnitIds = [] }
                            ]
                    in
                    Core.UnitHierarchy.buildHierarchy units
                        |> .armies
                        |> List.map Tuple.first
                        |> Expect.equal (List.sort [ "Західний ВО", "ЗС РФ" ])
            ]
        ]
