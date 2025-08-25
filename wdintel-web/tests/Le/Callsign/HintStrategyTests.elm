module Le.Callsign.HintStrategyTests exposing (suite)

import Bindings as B
import Dict exposing (Dict)
import Expect
import Le.Callsign.HintStrategy as HintStrategy
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
    , createdAt = 0
    , createdBy = ""
    }


{-| Створює тестову мережу
-}
createNetwork : Int -> List String -> List Int -> B.Network
createNetwork id freqs unitIds =
    { id = id
    , name = "Test Network " ++ String.fromInt id
    , freqs = List.map (\freq -> { id = 0, networkId = id, freq = freq, deleted = False, activeFrom = 0, activeTo = Nothing, createdAt = 0, kind = "test", modulationId = Nothing }) freqs
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
    , activeFrom = 0
    , activeTo = Nothing
    , postIds = []
    , descriptions = []
    , deleted = False
    }


{-| Створює тестову інформацію про позивний
-}
createCallsignInfo : Int -> String -> String -> String -> String -> Maybe Int -> B.CallsignInfo
createCallsignInfo id callsign position unit1 unit2 unitId =
    { id = id
    , callsign = callsign
    , position = position
    , comment = ""
    , unit1 = unit1
    , unit2 = unit2
    , unitId = unitId
    , networkIdsReportedIn = []
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
                            createNetwork 1 [ "123.45" ] [ 1, 2 ]

                        networks =
                            Dict.fromList [ ( 1, network ) ]

                        masterUnits =
                            Dict.fromList [ ( 1, createUnit 1 "1-ша армія" "" "" "" "" "Test" ) ]

                        context =
                            createContext networks masterUnits Dict.empty
                    in
                    HintStrategy.getCallsignHints message context "test"
                        |> .strategy
                        |> Expect.equal
                            (HintStrategy.NetworkBased
                                { networks = [ network ]
                                , units = [ createUnit 1 "1-ша армія" "" "" "" "" "Test" ]
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
                    HintStrategy.getCallsignHints message context "test"
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
                    HintStrategy.getCallsignHints message context "test"
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
                    HintStrategy.getCallsignHints message context "test"
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
                    HintStrategy.getCallsignHints message context "test"
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
                                [ ( "test", [ createCallsignInfo 1 "TEST" "Підказка" "1-ша армія" "" (Just 1) ] ) ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        result =
                            HintStrategy.getCallsignHints message context "test"
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
            , test "Коли є мережа з батьківським юнітом, система показує підказки для дитячих юнітів" <|
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
                                [ ( "parent", [ createCallsignInfo 1 "PARENT" "Батьківський" "2 мсб" "" (Just 1) ] )
                                , ( "child", [ createCallsignInfo 2 "CHILD" "Дитячий" "мінбат" "" (Just 2) ] )
                                ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        -- Перевіряємо що дитячий юніт знаходиться в підказках
                        parentHints =
                            HintStrategy.getCallsignHints message context "parent"
                    in
                    Expect.all
                        [ \_ ->
                            -- Підказки мають містити обидва юніти (батьківський та дитячий)
                            List.length parentHints.prioritizedCallsigns |> Expect.equal 2
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
                                [ ( "apple", [ createCallsignInfo 1 "APPLE" "Позиція 1" "1-ша армія" "" (Just 1) ] )
                                , ( "banana", [ createCallsignInfo 2 "BANANA" "Позиція 2" "2-га армія" "" (Just 2) ] )
                                ]

                        context =
                            createContext networks masterUnits callsignsInfo

                        -- Перевіряємо позивний "apple"
                        appleHints =
                            HintStrategy.getCallsignHints message context "apple"

                        -- Перевіряємо позивний "banana"
                        bananaHints =
                            HintStrategy.getCallsignHints message context "banana"

                        -- Перевіряємо неіснуючий позивний
                        unknownHints =
                            HintStrategy.getCallsignHints message context "unknown"
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
            ]
        ]
