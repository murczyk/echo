module Le.Block.CallsignsPopupTests exposing (suite)

import Bindings as B
import Core.Callsigns.HintStrategy as HintStrategy
import Dict exposing (Dict)
import Expect
import List.Extra as ListX
import Shared.CallsignsPopup as CallsignsPopup
import Test exposing (Test, describe, test)


{-| Створює тестовий юніт
-}
createUnit : Int -> String -> String -> String -> String -> String -> B.Unit
createUnit id army division regiment battalion company =
    let
        -- Динамічно складаємо назву з заповнених полів
        name =
            [ company, battalion, regiment, division, army ]
                |> List.filter (not << String.isEmpty)
                |> String.join " "
    in
    { id = id
    , armyRegion = ""
    , militaryDistrict = ""
    , army = army
    , division = division
    , regiment = regiment
    , battalion = battalion
    , company = company
    , comment = ""
    , orbitNote = Nothing
    , name = name
    , active = True
    , isDeduplicateCandidate = Nothing
    , createdAt = 0
    , createdByLoginId = ""
    , hasOrbit = False
    , orbitUnitIds = []
    }


{-| Створює тестову мережу
-}
createNetwork : Int -> List String -> List Int -> B.Network
createNetwork id freqs unitIds =
    { id = id
    , name = "Test Network " ++ String.fromInt id
    , freqs = List.map (\freq -> { id = 0, networkId = id, freq = freq, deleted = False, activeFrom = 0, activeTo = Nothing, createdAt = 0, modulation = "NFM", encryptionId = Nothing, encryptionKeys = [] }) freqs
    , unitIds = Just unitIds
    , aorIds = []
    , location = ""
    , radioStation = Nothing
    , createdAt = 0
    , purpose = Nothing
    , operationMode = Nothing
    , operationType = Nothing
    , operationPeriod = Nothing
    , lastUpdatedAt = 0
    , lastUpdatedBy = Nothing
    , activeFrom = Nothing
    , activeTo = Nothing
    , postIds = []
    , descriptions = []
    , deleted = False
    , doNotArchive = False
    , unitMask = []
    , status = B.NetworkActive
    }


{-| Створює тестову інформацію про позивний
-}
createCallsignInfo : Int -> String -> String -> String -> Int -> B.CallsignInfo
createCallsignInfo id callsign position unit1 unitId =
    { id = id
    , callsign = callsign
    , position = position
    , comment = ""
    , unit1 = unit1
    , unit2 = ""
    , unitId = Just unitId
    , networkIdsReportedIn = []
    }


{-| Створює тестові параметри для CallsignsPopup
-}
createParams : Dict Int B.Unit -> Dict String (List B.CallsignInfo) -> List String -> CallsignsPopup.Params {}
createParams masterUnits callsignsInfo callsigns =
    { masterUnits = masterUnits
    , callsignsInfo = callsignsInfo
    , callsigns = callsigns
    }


suite : Test
suite =
    describe "CallsignsPopup - перевірка роботи підказок позивних"
        [ describe "Сценарій: Тестування публічного API HintStrategy"
            [ test "getCallsignHints правильно визначає стратегію для частоти з мережею" <|
                \_ ->
                    let
                        freq =
                            "123.45"

                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        unit1 =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "2 мсб" ""

                        masterUnits =
                            Dict.fromList [ ( 1, unit1 ) ]

                        callsignsInfo =
                            Dict.fromList [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир" unit1.name unit1.id ] ) ]

                        message =
                            { freq = Just freq, networkIds = Nothing }

                        context =
                            { networks = networks, masterUnits = masterUnits, callsignsInfo = callsignsInfo }

                        result =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "зевс"
                    in
                    Expect.all
                        [ \_ ->
                            case result.strategy of
                                HintStrategy.NetworkBased _ ->
                                    Expect.pass

                                _ ->
                                    Expect.fail "Очікували NetworkBased стратегію"
                        ]
                        ()
            ]
        , describe "Сценарій: Показ підказок для частоти без мережі"
            [ test "Коли частота не має мережі, система показує підказки з каталогу (SystemWide стратегія)" <|
                \_ ->
                    let
                        -- Частота без мережі
                        freq =
                            "999.99"

                        networks =
                            Dict.empty

                        -- Юніти в системі
                        unit1 =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "2 мсб" ""

                        unit2 =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "3 мсб" ""

                        masterUnits =
                            Dict.fromList [ ( 1, unit1 ), ( 2, unit2 ) ]

                        -- Позивні в каталозі
                        callsignsInfo =
                            Dict.fromList
                                [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир" unit1.name unit1.id ] )
                                , ( "альфа", [ createCallsignInfo 2 "АЛЬФА" "Заступник" unit2.name unit2.id ] )
                                ]

                        params =
                            createParams masterUnits callsignsInfo [ "зевс", "альфа" ]

                        -- Тестуємо нову функцію сортування
                        result =
                            CallsignsPopup.sortCallsignsNew freq networks params
                    in
                    Expect.all
                        [ \_ ->
                            -- Має бути 2 результати
                            List.length result |> Expect.equal 2
                        , \_ ->
                            -- Перший результат має бути для "зевс"
                            result
                                |> List.head
                                |> Maybe.map Tuple.second
                                |> Expect.equal (Just "зевс")
                        , \_ ->
                            -- Другий результат має бути для "альфа"
                            result
                                |> List.drop 1
                                |> List.head
                                |> Maybe.map Tuple.second
                                |> Expect.equal (Just "альфа")
                        , \_ ->
                            -- Всі результати мають мати SystemWide стратегію
                            result
                                |> List.all (\r -> (r |> Tuple.first |> .strategy) == HintStrategy.SystemWide)
                                |> Expect.equal True
                        ]
                        ()
            ]
        , describe "Сценарій: Показ підказок для частоти з мережею"
            [ test "Коли частота має мережу, система показує підказки по мережі (NetworkBased стратегія)" <|
                \_ ->
                    let
                        -- Частота з мережею
                        freq =
                            "123.45"

                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        -- Юніти в мережі
                        unit1 =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "2 мсб" ""

                        unit2 =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "3 мсб" ""

                        masterUnits =
                            Dict.fromList [ ( 1, unit1 ), ( 2, unit2 ) ]

                        -- Позивні в каталозі
                        callsignsInfo =
                            Dict.fromList
                                [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир" unit1.name unit1.id ] )
                                , ( "альфа", [ createCallsignInfo 2 "АЛЬФА" "Заступник" unit2.name unit2.id ] )
                                ]

                        params =
                            createParams masterUnits callsignsInfo [ "зевс", "альфа" ]

                        -- Тестуємо нову функцію сортування
                        result =
                            CallsignsPopup.sortCallsignsNew freq networks params
                    in
                    Expect.all
                        [ \_ ->
                            List.length result |> Expect.equal 2
                        , \_ ->
                            result
                                |> ListX.find (\r -> Tuple.second r == "зевс")
                                |> Maybe.map (Tuple.first >> .strategy)
                                |> Expect.equal (Just (HintStrategy.NetworkBased { networks = [ network ], units = [ unit1 ] }))
                        , \_ ->
                            -- АЛЬФА має мати SystemWide стратегію (немає в мережі)
                            result
                                |> ListX.find (\r -> Tuple.second r == "альфа")
                                |> Maybe.map (Tuple.first >> .strategy)
                                |> Expect.equal (Just HintStrategy.SystemWide)
                        ]
                        ()
            ]
        ]
