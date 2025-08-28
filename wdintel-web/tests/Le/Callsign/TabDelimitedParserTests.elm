module Le.Callsign.TabDelimitedParserTests exposing (suite)

import Expect
import Pages.RerCallsigns as RerCallsigns
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "Парсер табульованих даних для позивних"
        [ describe "Створення структур AddState"
            [ test "mkAddState з трьома полями" <|
                \_ ->
                    let
                        result = RerCallsigns.mkAddState "МАМАЙ" "розрахунок РЄБ" "Коментар"
                    in
                    Expect.all
                        [ \_ -> result.inpCallsign |> Expect.equal "МАМАЙ"
                        , \_ -> result.inpPosition |> Expect.equal "розрахунок РЄБ"
                        , \_ -> result.inpComment |> Expect.equal "Коментар"
                        ] ()

            , test "mkAddState обрізає пробіли" <|
                \_ ->
                    let
                        result = RerCallsigns.mkAddState "  МАМАЙ  " "  розрахунок РЄБ  " "  Коментар  "
                    in
                    Expect.all
                        [ \_ -> result.inpCallsign |> Expect.equal "МАМАЙ"
                        , \_ -> result.inpPosition |> Expect.equal "розрахунок РЄБ"
                        , \_ -> result.inpComment |> Expect.equal "Коментар"
                        ] ()
            ]

        , describe "Групування елементів у трійки"
            [ test "cellsToTriples: 6 елементів -> 2 трійки" <|
                \_ ->
                    let
                        cells = ["A", "B", "C", "D", "E", "F"]
                        result = RerCallsigns.cellsToTriples cells
                    in
                    Expect.all
                        [ \_ -> List.length result |> Expect.equal 2
                        , \_ ->
                            case result of
                                [first, second] ->
                                    Expect.all
                                        [ \_ -> first.inpCallsign |> Expect.equal "A"
                                        , \_ -> second.inpCallsign |> Expect.equal "D"
                                        ] ()
                                _ ->
                                    Expect.fail "Очікувалося 2 результати"
                        ] ()

            , test "cellsToTriples: 5 елементів -> 2 трійки (остання неповна)" <|
                \_ ->
                    let
                        cells = ["A", "B", "C", "D", "E"]
                        result = RerCallsigns.cellsToTriples cells
                    in
                    Expect.all
                        [ \_ -> List.length result |> Expect.equal 2
                        , \_ ->
                            case result of
                                [_, second] ->
                                    Expect.all
                                        [ \_ -> second.inpCallsign |> Expect.equal "D"
                                        , \_ -> second.inpPosition |> Expect.equal "E"
                                        , \_ -> second.inpComment |> Expect.equal ""
                                        ] ()
                                _ ->
                                    Expect.fail "Очікувалося 2 результати"
                        ] ()

            , test "cellsToTriples: порожній список" <|
                \_ ->
                    RerCallsigns.cellsToTriples [] |> List.length |> Expect.equal 0
            ]

        , describe "Парсинг табульованого тексту"
            [ test "processTabDelimitedInput: один рядок з трьома полями" <|
                \_ ->
                    let
                        input = "МАМАЙ\tрозрахунок РЄБ\tКоментар"
                        result = RerCallsigns.processTabDelimitedInput input
                    in
                    Expect.all
                        [ \_ -> List.length result |> Expect.equal 1
                        , \_ ->
                            case List.head result of
                                Just first ->
                                    Expect.all
                                        [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                        , \_ -> first.inpPosition |> Expect.equal "розрахунок РЄБ"
                                        , \_ -> first.inpComment |> Expect.equal "Коментар"
                                        ] ()
                                Nothing ->
                                    Expect.fail "Очікувався результат"
                        ] ()

            , test "processTabDelimitedInput: кілька рядків" <|
                \_ ->
                    let
                        input = "МАМАЙ\tрозрахунок РЄБ\tКоментар1\nАЛЬФА\tЗаступник\tКоментар2"
                        result = RerCallsigns.processTabDelimitedInput input
                    in
                    Expect.all
                        [ \_ -> List.length result |> Expect.equal 2
                        , \_ ->
                            case result of
                                [first, second] ->
                                    Expect.all
                                        [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                        , \_ -> second.inpCallsign |> Expect.equal "АЛЬФА"
                                        ] ()
                                _ ->
                                    Expect.fail "Очікувалося 2 результати"
                        ] ()

            , test "processTabDelimitedInput: плоский список" <|
                \_ ->
                    let
                        input = "A\tB\tC\tD\tE\tF"
                        result = RerCallsigns.processTabDelimitedInput input
                    in
                    Expect.all
                        [ \_ -> List.length result |> Expect.equal 2
                        , \_ ->
                            case result of
                                [first, second] ->
                                    Expect.all
                                        [ \_ -> first.inpCallsign |> Expect.equal "A"
                                        , \_ -> second.inpCallsign |> Expect.equal "D"
                                        ] ()
                                _ ->
                                    Expect.fail "Очікувалося 2 результати"
                        ] ()

            , test "processTabDelimitedInput: неповні дані" <|
                \_ ->
                    let
                        input = "МАМАЙ\tрозрахунок РЄБ"
                        result = RerCallsigns.processTabDelimitedInput input
                    in
                    case List.head result of
                        Just first ->
                            Expect.all
                                [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                , \_ -> first.inpPosition |> Expect.equal "розрахунок РЄБ"
                                , \_ -> first.inpComment |> Expect.equal ""
                                ] ()
                        Nothing ->
                            Expect.fail "Очікувався результат"

            , test "processTabDelimitedInput: обрізання пробілів" <|
                \_ ->
                    let
                        input = "  МАМАЙ  \t  розрахунок РЄБ  \t  Коментар  "
                        result = RerCallsigns.processTabDelimitedInput input
                    in
                    case List.head result of
                        Just first ->
                            Expect.all
                                [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                , \_ -> first.inpPosition |> Expect.equal "розрахунок РЄБ"
                                , \_ -> first.inpComment |> Expect.equal "Коментар"
                                ] ()
                        Nothing ->
                            Expect.fail "Очікувався результат"
            ]
        ]