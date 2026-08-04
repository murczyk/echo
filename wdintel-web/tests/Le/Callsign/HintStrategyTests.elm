module Le.Callsign.HintStrategyTests exposing (suite)

import Bindings as B
import Core.Callsigns.HintStrategy as HintStrategy
import Dict exposing (Dict)
import Expect
import Test exposing (Test, describe, test)


{-| Створює тестовий юніт
-}
createUnit : Int -> String -> String -> String -> String -> String -> String -> B.Unit
createUnit id army division regiment battalion company name =
    { id = id
    , army = army
    , division = division
    , regiment = regiment
    , battalion = battalion
    , company = company
    , comment = ""
    , name = name
    , active = True
    , isDeduplicateCandidate = Nothing
    , createdAt = 0
    , createdByLoginId = ""
    , hasOrbit = False
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
createCallsignInfo : Int -> String -> String -> String -> String -> Maybe Int -> List Int -> B.CallsignInfo
createCallsignInfo id callsign position unit1 unit2 unitId networkIdsReportedIn =
    { id = id
    , callsign = callsign
    , position = position
    , comment = ""
    , unit1 = unit1
    , unit2 = unit2
    , unitId = unitId
    , networkIdsReportedIn = networkIdsReportedIn
    }


{-| Створює тестове повідомлення
-}
createMessage : Maybe String -> Maybe (List Int) -> { freq : Maybe String, networkIds : Maybe (List Int) }
createMessage freq networkIds =
    { freq = freq
    , networkIds = networkIds
    }


{-| Створює тестовий контекст
-}
createContext : Dict Int B.Network -> Dict Int B.Unit -> Dict String (List B.CallsignInfo) -> { networks : Dict Int B.Network, masterUnits : Dict Int B.Unit, callsignsInfo : Dict String (List B.CallsignInfo) }
createContext networks masterUnits callsignsInfo =
    { networks = networks
    , masterUnits = masterUnits
    , callsignsInfo = callsignsInfo
    }


suite : Test
suite =
    describe "Система підсвідки позивних - як користувач отримує допомогу з розумінням повідомлень"
        [ describe "Сценарій: Користувач читає повідомлення з відомою частотою"
            [ test "Коли оператор бачить повідомлення на частоті 123.45 і для неї є мережа, система показує підказки тільки по цій мережі" <|
                \_ ->
                    let
                        message =
                            createMessage (Just "123.45") Nothing

                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        unit1 =
                            createUnit 1 "1-ша армія" "" "" "" "" "Test"

                        masterUnits =
                            Dict.fromList [ ( 1, unit1 ) ]

                        -- Додаємо позивний який реально пов'язаний з мережевим юнітом
                        callsignsInfo =
                            Dict.fromList [ ( "test", [ createCallsignInfo 1 "TEST" "Командир" unit1.name "" (Just unit1.id) [] ] ) ]

                        context =
                            createContext networks masterUnits callsignsInfo
                    in
                    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "test"
                        |> .strategy
                        |> Expect.equal
                            (HintStrategy.NetworkBased
                                { networks = [ network ]
                                , units = [ unit1 ]
                                }
                            )
            , test "Коли оператор бачить повідомлення на частоті 123.45, але в системі немає мережі з цією частотою, система показує підказки з каталогу позивних" <|
                \_ ->
                    let
                        message =
                            createMessage (Just "123.45") Nothing

                        network =
                            createNetwork 1 [ "999.99" ] [ 1, 2 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        context =
                            createContext networks Dict.empty Dict.empty
                    in
                    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "test"
                        |> .strategy
                        |> Expect.equal HintStrategy.SystemWide
            ]
        , describe "Сценарій: Користувач читає повідомлення без частоти але з вказаними мережами"
            [ test "Коли оператор бачить повідомлення без частоти, але з вказаними мережами [1,2], система показує підказки по цих мережах" <|
                \_ ->
                    let
                        message =
                            createMessage Nothing (Just [ 1, 2 ])

                        networks =
                            Dict.empty

                        context =
                            createContext networks Dict.empty Dict.empty
                    in
                    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "test"
                        |> .strategy
                        |> Expect.equal (HintStrategy.NetworkBased { networks = [], units = [] })
            , test "Коли оператор бачить повідомлення без частоти і без вказаних мереж, система показує підказки по всій системі" <|
                \_ ->
                    let
                        message =
                            createMessage Nothing (Just [])

                        networks =
                            Dict.empty

                        context =
                            createContext networks Dict.empty Dict.empty
                    in
                    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "test"
                        |> .strategy
                        |> Expect.equal HintStrategy.SystemWide
            ]
        , describe "Сценарій: Користувач читає повідомлення без додаткової інформації"
            [ test "Коли оператор бачить повідомлення без частоти і без вказаних мереж, система показує підказки по всій системі" <|
                \_ ->
                    let
                        message =
                            createMessage Nothing Nothing

                        networks =
                            Dict.empty

                        context =
                            createContext networks Dict.empty Dict.empty
                    in
                    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "test"
                        |> .strategy
                        |> Expect.equal HintStrategy.SystemWide
            ]
        , describe "Сценарій: Користувач отримує контекстну допомогу для позивного"
            [ test "Коли оператор наводить мишку на позивний 'TEST' в повідомленні з мережею, система показує підказки з правильною іконкою" <|
                \_ ->
                    let
                        message =
                            createMessage (Just "123.45") Nothing

                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        masterUnits =
                            Dict.fromList [ ( 1, createUnit 1 "1-ша армія" "" "" "" "" "Test" ) ]

                        callsignsInfo =
                            Dict.fromList
                                [ ( "test", [ createCallsignInfo 1 "TEST" "Підказка" "1-ша армія" "" (Just 1) [] ] ) ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        result =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "test"
                    in
                    Expect.all
                        [ \_ ->
                            result.strategy
                                |> Expect.equal
                                    (HintStrategy.NetworkBased
                                        { networks = [ network ], units = [ createUnit 1 "1-ша армія" "" "" "" "" "Test" ] }
                                    )
                        , \_ -> result.iconClass |> Expect.equal "bi-info-circle-fill"
                        ]
                        ()
            , test "✅ ВИПРАВЛЕНО: Коли є мережа з батьківським юнітом, кожен позивний показує тільки свої підказки" <|
                \_ ->
                    let
                        message =
                            createMessage (Just "123.45") Nothing

                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        -- Батьківський юніт: 2 мсб 122 мсп 68 мсд 6 А
                        parentUnit =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб 122 мсп 68 мсд 6 А"

                        -- Дитячий юніт: мінбат 2 мсб 122 мсп 68 мсд 6 А
                        childUnit =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "2 мсб" "мінбат" "мінбат 2 мсб 122 мсп 68 мсд 6 А"

                        masterUnits =
                            Dict.fromList
                                [ ( 1, parentUnit )
                                , ( 2, childUnit )
                                ]

                        -- Позивні для обох юнітів
                        callsignsInfo =
                            Dict.fromList
                                [ ( "parent", [ createCallsignInfo 1 "PARENT" "Батьківський" "2 мсб" "" (Just 1) [] ] )
                                , ( "child", [ createCallsignInfo 2 "CHILD" "Дитячий" "мінбат" "" (Just 2) [] ] )
                                ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        -- Перевіряємо підказки для батьківського позивного
                        parentHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "parent"

                        -- Перевіряємо підказки для дитячого позивного
                        childHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "child"
                    in
                    Expect.all
                        [ \_ ->
                            -- Позивний "parent" має показувати тільки 1 підказку (свою)
                            List.length parentHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- Позивний "child" має показувати тільки 1 підказку (свою)
                            List.length childHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- Підказка для PARENT має містити правильну інформацію
                            parentHints.prioritizedCallsigns
                                |> List.head
                                |> Maybe.map .callsign
                                |> Expect.equal (Just "PARENT")
                        , \_ ->
                            -- Підказка для CHILD має містити правильну інформацію
                            childHints.prioritizedCallsigns
                                |> List.head
                                |> Maybe.map .callsign
                                |> Expect.equal (Just "CHILD")
                        ]
                        ()
            , test "Коли немає мережі, SystemWide показує тільки існуючі позивні, а не всі можливі" <|
                \_ ->
                    let
                        message =
                            createMessage Nothing Nothing

                        networks =
                            Dict.empty

                        -- В системі є тільки 2 юніти
                        unit1 =
                            createUnit 1 "1-ша армія" "" "" "" "" "Unit 1"

                        unit2 =
                            createUnit 2 "2-га армія" "" "" "" "" "Unit 2"

                        masterUnits =
                            Dict.fromList
                                [ ( 1, unit1 )
                                , ( 2, unit2 )
                                ]

                        -- В базі позивних є тільки 2 позивні
                        callsignsInfo =
                            Dict.fromList
                                [ ( "apple", [ createCallsignInfo 1 "APPLE" "Позиція 1" "1-ша армія" "" (Just 1) [] ] )
                                , ( "banana", [ createCallsignInfo 2 "BANANA" "Позиція 2" "2-га армія" "" (Just 2) [] ] )
                                ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        -- Перевіряємо позивний "apple"
                        appleHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "apple"

                        -- Перевіряємо позивний "banana"
                        bananaHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "banana"

                        -- Перевіряємо неіснуючий позивний
                        unknownHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "unknown"
                    in
                    Expect.all
                        [ \_ ->
                            -- SystemWide стратегія для існуючого позивного
                            appleHints.strategy |> Expect.equal HintStrategy.SystemWide
                        , \_ ->
                            -- Позивний "apple" має показувати тільки 1 підказку (свою)
                            List.length appleHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- Позивний "banana" має показувати тільки 1 підказку (свою)
                            List.length bananaHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- Неіснуючий позивний не має показувати підказки
                            List.length unknownHints.prioritizedCallsigns |> Expect.equal 0
                        ]
                        ()
            , test "ПРОБЛЕМА: NetworkBased показує підказки всіх позивних мережі замість тільки конкретного" <|
                \_ ->
                    let
                        message =
                            createMessage (Just "123.45") Nothing

                        -- Мережа містить 2 юніти
                        network =
                            createNetwork 1 [ "123.45" ] [ 1, 2 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        -- 2 юніти в мережі
                        unit1 =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб"

                        unit2 =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "3 мсб" "" "3 мсб"

                        masterUnits =
                            Dict.fromList
                                [ ( 1, unit1 )
                                , ( 2, unit2 )
                                ]

                        -- 3 різні позивні в мережі
                        callsignsInfo =
                            Dict.fromList
                                [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир" "2 мсб" "122 мсп" (Just 1) [] ] )
                                , ( "альфа", [ createCallsignInfo 2 "АЛЬФА" "Заступник" "3 мсб" "122 мсп" (Just 2) [] ] )
                                , ( "бета", [ createCallsignInfo 3 "БЕТА" "Начальник штабу" "2 мсб" "122 мсп" (Just 1) [] ] )
                                ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        -- Запитуємо підказки для конкретного позивного "ЗЕВС"
                        zeusHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "зевс"

                        -- Запитуємо підказки для конкретного позивного "АЛЬФА"
                        alfaHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "альфа"
                    in
                    Expect.all
                        [ \_ ->
                            -- Стратегія має бути NetworkBased
                            zeusHints.strategy
                                |> (\strategy ->
                                        case strategy of
                                            HintStrategy.NetworkBased _ ->
                                                Expect.pass

                                            _ ->
                                                Expect.fail "Очікували NetworkBased стратегію"
                                   )
                        , \_ ->
                            -- 🐛 ПРОБЛЕМА: зараз повертається 3 підказки (ЗЕВС, АЛЬФА, БЕТА)
                            -- 🎯 ОЧІКУЄМО: тільки 1 підказку для ЗЕВС
                            List.length zeusHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- 🐛 ПРОБЛЕМА: зараз повертається 3 підказки (ЗЕВС, АЛЬФА, БЕТА)
                            -- 🎯 ОЧІКУЄМО: тільки 1 підказку для АЛЬФА
                            List.length alfaHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- Підказка для ЗЕВС має містити тільки інформацію про ЗЕВС
                            zeusHints.prioritizedCallsigns
                                |> List.head
                                |> Maybe.map .callsign
                                |> Expect.equal (Just "ЗЕВС")
                        , \_ ->
                            -- Підказка для АЛЬФА має містити тільки інформацію про АЛЬФА
                            alfaHints.prioritizedCallsigns
                                |> List.head
                                |> Maybe.map .callsign
                                |> Expect.equal (Just "АЛЬФА")
                        ]
                        ()
            ]
        , describe "🐛 КРИТИЧНА ПРОБЛЕМА: Неправильна фільтрація підказок"
            [ test "Різні батальйони НЕ повинні показувати підказки один для одного" <|
                \_ ->
                    let
                        -- Мережа з 1 мсб
                        network1 =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        networks =
                            Dict.fromList [ ( 1, network1 ) ]

                        -- Юніти: 1 мсб та 2 мсб (РІЗНІ батальйони!)
                        unit1msb =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "1 мсб" "" "1 мсб 122 мсп 68 мсд 6А"

                        unit2msb =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб 122 мсп 68 мсд 6А"

                        masterUnits =
                            Dict.fromList [ ( 1, unit1msb ), ( 2, unit2msb ) ]

                        -- Позивні для РІЗНИХ батальйонів
                        callsignsInfo =
                            Dict.fromList
                                [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир 1 мсб" unit1msb.name "" (Just unit1msb.id) [] ] )
                                , ( "альфа", [ createCallsignInfo 2 "АЛЬФА" "Командир 2 мсб" unit2msb.name "" (Just unit2msb.id) [] ] )
                                ]

                        message =
                            { freq = Just "123.45", networkIds = Nothing }

                        context =
                            { networks = networks, masterUnits = masterUnits, callsignsInfo = callsignsInfo }

                        -- Тестуємо підказки для ЗЕВС (1 мсб)
                        zeusHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "зевс"

                        -- Тестуємо підказки для АЛЬФА (2 мсб)
                        alfaHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "альфа"
                    in
                    Expect.all
                        [ \_ ->
                            -- ЗЕВС (1 мсб) має NetworkBased стратегію (є в мережі)
                            case zeusHints.strategy of
                                HintStrategy.NetworkBased _ ->
                                    Expect.pass

                                _ ->
                                    Expect.fail "ЗЕВС має бути NetworkBased (є в мережі)"
                        , \_ ->
                            -- ЗЕВС повинен мати 1 підказку (тільки свою)
                            List.length zeusHints.prioritizedCallsigns |> Expect.equal 1
                        , \_ ->
                            -- АЛЬФА (2 мсб) має SystemWide стратегію (НЕ в мережі)
                            case alfaHints.strategy of
                                HintStrategy.SystemWide ->
                                    Expect.pass

                                HintStrategy.NetworkBased data ->
                                    Expect.fail <| "🐛 АЛЬФА отримала NetworkBased замість SystemWide! Networks: " ++ String.fromInt (List.length data.networks) ++ ", Units: " ++ String.fromInt (List.length data.units)

                                _ ->
                                    Expect.fail "АЛЬФА має бути SystemWide (НЕ в мережі з 1 мсб)"
                        , \_ ->
                            -- АЛЬФА повинен мати 1 підказку (тільки свою)
                            List.length alfaHints.prioritizedCallsigns |> Expect.equal 1
                        ]
                        ()
            ]
        , describe "🧪 TDD: Різні контексти використання (MessageContext vs FrequencyContext)"
            [ test "MessageContext: Повідомлення з мережею НЕ показує каталог для непов'язаних позивних" <|
                \_ ->
                    let
                        -- Повідомлення з мережею (як в RerMessage.elm)
                        message =
                            { freq = Just "123.45", networkIds = Just [ 1 ] }

                        -- ← Повідомлення ПРИВ'ЯЗАНЕ до мережі
                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        -- Мережа з 1 мсб
                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        unit1msb =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "1 мсб" "" "1 мсб 122 мсп 68 мсд 6А"

                        unit2msb =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб 122 мсп 68 мсд 6А"

                        masterUnits =
                            Dict.fromList [ ( 1, unit1msb ), ( 2, unit2msb ) ]

                        callsignsInfo =
                            Dict.fromList
                                [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир 1 мсб" unit1msb.name "" (Just unit1msb.id) [ 1 ] ] )
                                , ( "альфа", [ createCallsignInfo 2 "АЛЬФА" "Командир 2 мсб" unit2msb.name "" (Just unit2msb.id) [] ] )
                                ]

                        context =
                            { networks = networks, masterUnits = masterUnits, callsignsInfo = callsignsInfo }

                        -- В MessageContext: позивні НЕ з мережі повідомлення мають NoHints
                        zeusHints =
                            HintStrategy.getCallsignHints HintStrategy.MessageContext message context "зевс"

                        -- В мережі
                        alfaHints =
                            HintStrategy.getCallsignHints HintStrategy.MessageContext message context "альфа"

                        -- НЕ в мережі
                    in
                    Expect.all
                        [ \_ ->
                            -- ЗЕВС (в мережі повідомлення) → NetworkBased
                            case zeusHints.strategy of
                                HintStrategy.NetworkBased _ ->
                                    Expect.pass

                                _ ->
                                    Expect.fail "ЗЕВС має бути NetworkBased"
                        , \_ ->
                            -- 🔥 TDD FAIL: АЛЬФА (НЕ в мережі повідомлення) → має бути NoHints, а не SystemWide
                            case alfaHints.strategy of
                                HintStrategy.NoHints ->
                                    Expect.pass

                                HintStrategy.SystemWide ->
                                    Expect.fail "🔥 TDD FAIL: У MessageContext АЛЬФА не повинна показувати каталог (SystemWide), має бути NoHints"

                                _ ->
                                    Expect.fail "АЛЬФА має бути NoHints в MessageContext"
                        ]
                        ()
            , test "FrequencyContext: Частота з мережею показує каталог для непов'язаних позивних" <|
                \_ ->
                    let
                        -- Частота з мережею (як в RerFreqs.elm)
                        message =
                            { freq = Just "123.45", networkIds = Nothing }

                        -- ← Частота БЕЗ прив'язки до мережі
                        network =
                            createNetwork 1 [ "123.45" ] [ 1 ]

                        -- Мережа існує для частоти
                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        unit1msb =
                            createUnit 1 "6А" "68 мсд" "122 мсп" "1 мсб" "" "1 мсб 122 мсп 68 мсд 6А"

                        unit2msb =
                            createUnit 2 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб 122 мсп 68 мсд 6А"

                        masterUnits =
                            Dict.fromList [ ( 1, unit1msb ), ( 2, unit2msb ) ]

                        callsignsInfo =
                            Dict.fromList
                                [ ( "зевс", [ createCallsignInfo 1 "ЗЕВС" "Командир 1 мсб" unit1msb.name "" (Just unit1msb.id) [] ] )
                                , ( "альфа", [ createCallsignInfo 2 "АЛЬФА" "Командир 2 мсб" unit2msb.name "" (Just unit2msb.id) [] ] )
                                ]

                        context =
                            { networks = networks, masterUnits = masterUnits, callsignsInfo = callsignsInfo }

                        -- В FrequencyContext: позивні НЕ з мережі частоти мають SystemWide
                        zeusHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "зевс"

                        -- В мережі частоти
                        alfaHints =
                            HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context "альфа"

                        -- НЕ в мережі частоти
                    in
                    Expect.all
                        [ \_ ->
                            -- ЗЕВС (в мережі частоти) → NetworkBased
                            case zeusHints.strategy of
                                HintStrategy.NetworkBased _ ->
                                    Expect.pass

                                _ ->
                                    Expect.fail "ЗЕВС має бути NetworkBased"
                        , \_ ->
                            -- ✅ АЛЬФА (НЕ в мережі частоти) → має бути SystemWide (каталог)
                            case alfaHints.strategy of
                                HintStrategy.SystemWide ->
                                    Expect.pass

                                _ ->
                                    Expect.fail "АЛЬФА має бути SystemWide в FrequencyContext"
                        ]
                        ()
            ]
        ]
