module Le.Callsign.TabDelimitedParserTests exposing (suite)

import Debug
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
                        result =
                            RerCallsigns.mkAddState "МАМАЙ" "розрахунок РЄБ" "Коментар"
                    in
                    Expect.all
                        [ \_ -> result.inpCallsign |> Expect.equal "МАМАЙ"
                        , \_ -> result.inpPosition |> Expect.equal "розрахунок РЄБ"
                        , \_ -> result.inpComment |> Expect.equal "Коментар"
                        ] ()

            , test "mkAddState обрізає пробіли" <|
                \_ ->
                    let
                        result =
                            RerCallsigns.mkAddState "  МАМАЙ  " "  розрахунок РЄБ  " "  Коментар  "
                    in
                    Expect.all
                        [ \_ -> result.inpCallsign |> Expect.equal "МАМАЙ"
                        , \_ -> result.inpPosition |> Expect.equal "розрахунок РЄБ"
                        , \_ -> result.inpComment |> Expect.equal "Коментар"
                        ] ()
            ]

        , describe "processTabDelimitedInput (строго 3 або 4 колонки на рядок)"
            [ test "порожній рядок -> Err (очікується TSV з 3 або 4 колонками)" <|
                \_ ->
                    case RerCallsigns.processTabDelimitedInput "" of
                        Ok _ ->
                            Expect.fail "Очікувався Err для порожнього рядка"

                        Err _ ->
                            Expect.pass

            , test "один рядок з трьома полями" <|
                \_ ->
                    let
                        input =
                            "МАМАЙ\tрозрахунок РЄБ\tКоментар"
                    in
                    case RerCallsigns.processTabDelimitedInput input of
                        Ok [ first ] ->
                            Expect.all
                                [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                , \_ -> first.inpPosition |> Expect.equal "розрахунок РЄБ"
                                , \_ -> first.inpComment |> Expect.equal "Коментар"
                                ] ()

                        other ->
                            Expect.fail ("Очікувався Ok з одним рядком, отримано: " ++ Debug.toString other)

            , test "один рядок з чотирма полями (повна назва)" <|
                \_ ->
                    let
                        input =
                            "A\tB\tFullName\tComment"
                    in
                    case RerCallsigns.processTabDelimitedInput input of
                        Ok [ first ] ->
                            Expect.all
                                [ \_ -> first.inpCallsign |> Expect.equal "A"
                                , \_ -> first.inpPosition |> Expect.equal "B"
                                , \_ -> first.inpFullName |> Expect.equal "FullName"
                                , \_ -> first.inpComment |> Expect.equal "Comment"
                                ] ()

                        other ->
                            Expect.fail ("Очікувався Ok з одним рядком, отримано: " ++ Debug.toString other)

            , test "кілька рядків" <|
                \_ ->
                    let
                        input =
                            "МАМАЙ\tрозрахунок РЄБ\tКоментар1\nАЛЬФА\tЗаступник\tКоментар2"
                    in
                    case RerCallsigns.processTabDelimitedInput input of
                        Ok [ first, second ] ->
                            Expect.all
                                [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                , \_ -> second.inpCallsign |> Expect.equal "АЛЬФА"
                                ] ()

                        other ->
                            Expect.fail ("Очікувалося 2 рядки, отримано: " ++ Debug.toString other)

            , test "шість колонок в одному рядку -> Err" <|
                \_ ->
                    case RerCallsigns.processTabDelimitedInput "A\tB\tC\tD\tE\tF" of
                        Ok _ ->
                            Expect.fail "Очікувався Err для непідтриманого формату"

                        Err _ ->
                            Expect.pass

            , test "лише дві колонки -> Err" <|
                \_ ->
                    case RerCallsigns.processTabDelimitedInput "МАМАЙ\tрозрахунок РЄБ" of
                        Ok _ ->
                            Expect.fail "Очікувався Err для непідтриманого формату"

                        Err _ ->
                            Expect.pass

            , test "обрізання пробілів (3 колонки)" <|
                \_ ->
                    let
                        input =
                            "  МАМАЙ  \t  розрахунок РЄБ  \t  Коментар  "
                    in
                    case RerCallsigns.processTabDelimitedInput input of
                        Ok [ first ] ->
                            Expect.all
                                [ \_ -> first.inpCallsign |> Expect.equal "МАМАЙ"
                                , \_ -> first.inpPosition |> Expect.equal "розрахунок РЄБ"
                                , \_ -> first.inpComment |> Expect.equal "Коментар"
                                ] ()

                        other ->
                            Expect.fail ("Очікувався Ok, отримано: " ++ Debug.toString other)
            ]
        ]
