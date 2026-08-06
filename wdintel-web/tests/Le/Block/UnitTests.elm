module Le.Block.UnitTests exposing (suite)

import Bindings as B
import Core.Unit as Unit
import Expect
import Test exposing (Test, describe, test)


createUnit : Int -> String -> String -> String -> String -> String -> String -> B.Unit
createUnit id army division regiment battalion company name =
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


suite : Test
suite =
    describe "Логіка зв'язків між військовими підрозділами"
        [ describe "Функція isSameOrChildUnit - визначає чи пов'язані два підрозділи"
            [ describe "Однакові підрозділи (точний збіг за ID)"
                [ test "Підрозділи з однаковим ID завжди пов'язані, навіть якщо назви різні" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 1 "1-ша армія" "2-га дивізія" "3-й полк" "" "" "Unit 1"

                            unit2 =
                                createUnit 1 "інша армія" "інша дивізія" "інший полк" "" "" "Unit 2"
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal True
                ]
            , describe "Ієрархія підрозділів - батьківські та дитячі підрозділи"
                [ test "Дивізія входить до складу армії" <|
                    \_ ->
                        let
                            parentUnit =
                                createUnit 3 "1-ша армія" "" "" "" "" "1-ша армія"

                            childUnit =
                                createUnit 4 "1-ша армія" "2-га дивізія" "" "" "" "2-га дивізія 1-ї армії"
                        in
                        Unit.isSameOrChildUnit parentUnit childUnit
                            |> Expect.equal True
                , test "Полк входить до складу армії (через дивізію)" <|
                    \_ ->
                        let
                            grandparentUnit =
                                createUnit 5 "1-ша армія" "" "" "" "" "1-ша армія"

                            grandchildUnit =
                                createUnit 6 "1-ша армія" "2-га дивізія" "3-й полк" "" "" "3-й полк 2-ї дивізії 1-ї армії"
                        in
                        Unit.isSameOrChildUnit grandparentUnit grandchildUnit
                            |> Expect.equal True
                , test "Рота входить до складу полку" <|
                    \_ ->
                        let
                            regimentUnit =
                                createUnit 7 "" "69 мсд" "82 мсп" "" "" "82 мсп 69 мсд"

                            companyUnit =
                                createUnit 8 "" "69 мсд" "82 мсп" "" "6 рота" "6 рота 82 мсп 69 мсд"
                        in
                        Unit.isSameOrChildUnit regimentUnit companyUnit
                            |> Expect.equal True
                , test "Військовий округ входить до складу армійського регіону" <|
                    \_ ->
                        let
                            regionUnitBase =
                                createUnit 30 "" "" "" "" "" "ЗС РФ"

                            regionUnit =
                                { regionUnitBase | armyRegion = "ЗС РФ" }

                            districtUnitBase =
                                createUnit 31 "" "" "" "" "" "Західний ВО ЗС РФ"

                            districtUnit =
                                { districtUnitBase
                                    | armyRegion = "ЗС РФ"
                                    , militaryDistrict = "Західний ВО"
                                }
                        in
                        Unit.isSameOrChildUnit regionUnit districtUnit
                            |> Expect.equal True
                , test "Legacy parent without region remains related to regional child" <|
                    \_ ->
                        let
                            parentBase =
                                createUnit 34 "20 ЗВА" "" "" "" "" "20 ЗВА Західний ВО"

                            parentUnit =
                                { parentBase | militaryDistrict = "Західний ВО" }

                            childBase =
                                createUnit 35 "20 ЗВА" "45 див" "" "" "" "45 див 20 ЗВА Західний ВО ЗС РФ"

                            childUnit =
                                { childBase
                                    | armyRegion = "ЗС РФ"
                                    , militaryDistrict = "Західний ВО"
                                }
                        in
                        Unit.isSameOrChildUnit parentUnit childUnit
                            |> Expect.equal True
                ]
            , describe "Різні підрозділи НЕ повинні бути пов'язані"
                [ test "Різні дивізії однієї армії НЕ пов'язані між собою" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 9 "1-ша армія" "2-га дивізія" "" "" "" "2-га дивізія 1-ї армії"

                            unit2 =
                                createUnit 10 "1-ша армія" "3-тя дивізія" "" "" "" "3-тя дивізія 1-ї армії"
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal False
                , test "Різні полки однієї дивізії НЕ пов'язані між собою" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 11 "" "69 мсд" "82 мсп" "" "" "82 мсп 69 мсд"

                            unit2 =
                                createUnit 12 "" "69 мсд" "121 мсп" "" "" "121 мсп 69 мсд"
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal False
                , test "Різні армії НЕ пов'язані між собою" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 13 "1-ша армія" "" "" "" "" "1-ша армія"

                            unit2 =
                                createUnit 14 "2-га армія" "" "" "" "" "2-га армія"
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal False
                , test "Округи різних армійських регіонів НЕ пов'язані" <|
                    \_ ->
                        let
                            unit1Base =
                                createUnit 32 "" "" "" "" "" "Західний ВО"

                            unit1 =
                                { unit1Base
                                    | armyRegion = "ЗС РФ"
                                    , militaryDistrict = "Західний ВО"
                                }

                            unit2Base =
                                createUnit 33 "" "" "" "" "" "Західний ВО"

                            unit2 =
                                { unit2Base
                                    | armyRegion = "Інший регіон"
                                    , militaryDistrict = "Західний ВО"
                                }
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal False
                , test "Заповнений інший регіон батька не відповідає дитині" <|
                    \_ ->
                        let
                            parentBase =
                                createUnit 36 "20 ЗВА" "" "" "" "" "20 ЗВА Західний ВО"

                            parentUnit =
                                { parentBase
                                    | armyRegion = "Регіон 1"
                                    , militaryDistrict = "Західний ВО"
                                }

                            childBase =
                                createUnit 37 "20 ЗВА" "45 див" "" "" "" "45 див 20 ЗВА Західний ВО"

                            childUnit =
                                { childBase
                                    | armyRegion = "Регіон 2"
                                    , militaryDistrict = "Західний ВО"
                                }
                        in
                        Unit.isSameOrChildUnit parentUnit childUnit
                            |> Expect.equal False
                ]
            , describe "ВИПРАВЛЕННЯ БАГУ - проблема з порожніми рівнями ієрархії"
                [ test "82 мсп 69 мсд НЕ повинен показувати підказки для 121 мсп 68 мсд" <|
                    \_ ->
                        let
                            -- Мережа: "82 мсп 69 мсд 6 А"
                            networkUnit =
                                createUnit 15 "" "69 мсд" "82 мсп" "" "6 А" "82 мсп 69 мсд 6 А"

                            -- Підказка: "5 мсб 121 мсп 68 мсд 6а"
                            callsignUnit =
                                createUnit 16 "" "68 мсд" "121 мсп" "5 мсб" "6а" "5 мсб 121 мсп 68 мсд 6а"
                        in
                        Unit.isSameOrChildUnit networkUnit callsignUnit
                            |> Expect.equal False
                , test "мінбат 2 мсб 122 мсп 68 мсд 6 А повинен показуватися в підказках для 2 мсб 122 мсп 68 мсд 6 А" <|
                    \_ ->
                        let
                            networkUnit =
                                createUnit 15 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб 122 мсп 68 мсд 6 А"

                            childUnit =
                                createUnit 16 "6А" "68 мсд" "122 мсп" "2 мсб" "мінбат" "мінбат 2 мсб 122 мсп 68 мсд 6 А"
                        in
                        Unit.isSameOrChildUnit networkUnit childUnit
                            |> Expect.equal True
                , test "Різні полки навіть в одній дивізії НЕ повинні показувати підказки" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 17 "" "69 мсд" "82 мсп" "" "" "82 мсп 69 мсд"

                            unit2 =
                                createUnit 18 "" "69 мсд" "121 мсп" "" "" "121 мсп 69 мсд"
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal False
                , test "Підрозділ з порожньою армією НЕ може бути батьком для підрозділу з заповненою армією" <|
                    \_ ->
                        let
                            -- Порожня армія у батька, заповнена у дитини
                            parentUnit =
                                createUnit 19 "" "2-га дивізія" "" "" "" "2-га дивізія"

                            childUnit =
                                createUnit 20 "1-ша армія" "2-га дивізія" "" "" "" "2-га дивізія 1-ї армії"
                        in
                        Unit.isSameOrChildUnit parentUnit childUnit
                            |> Expect.equal False
                ]
            , describe "Граничні випадки"
                [ test "Повністю порожні підрозділи НЕ пов'язані між собою" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 21 "" "" "" "" "" "Empty Unit 1"

                            unit2 =
                                createUnit 22 "" "" "" "" "" "Empty Unit 2"
                        in
                        Unit.isSameOrChildUnit unit1 unit2
                            |> Expect.equal False
                , test "Підрозділ завжди пов'язаний з самим собою" <|
                    \_ ->
                        let
                            unit =
                                createUnit 23 "1-ша армія" "2-га дивізія" "3-й полк" "" "" "Test unit"
                        in
                        Unit.isSameOrChildUnit unit unit
                            |> Expect.equal True
                ]
            , describe "Симетричність зв'язків"
                [ test "Зв'язок батько-дитина працює в обох напрямках" <|
                    \_ ->
                        let
                            parentUnit =
                                createUnit 24 "1-ша армія" "" "" "" "" "1-ша армія"

                            childUnit =
                                createUnit 25 "1-ша армія" "2-га дивізія" "" "" "" "2-га дивізія 1-ї армії"
                        in
                        Expect.all
                            [ \_ -> Unit.isSameOrChildUnit parentUnit childUnit |> Expect.equal True
                            , \_ -> Unit.isSameOrChildUnit childUnit parentUnit |> Expect.equal True
                            ]
                            ()
                , test "Відсутність зв'язку також симетрична" <|
                    \_ ->
                        let
                            unit1 =
                                createUnit 26 "" "69 мсд" "82 мсп" "" "" "82 мсп 69 мсд"

                            unit2 =
                                createUnit 27 "" "68 мсд" "121 мсп" "" "" "121 мсп 68 мсд"
                        in
                        Expect.all
                            [ \_ -> Unit.isSameOrChildUnit unit1 unit2 |> Expect.equal False
                            , \_ -> Unit.isSameOrChildUnit unit2 unit1 |> Expect.equal False
                            ]
                            ()
                , test "🐛 КРИТИЧНО: Різні батальйони НЕ повинні вважатися пов'язаними" <|
                    \_ ->
                        let
                            battalion1 =
                                createUnit 28 "6А" "68 мсд" "122 мсп" "1 мсб" "" "1 мсб 122 мсп 68 мсд 6А"

                            battalion2 =
                                createUnit 29 "6А" "68 мсд" "122 мсп" "2 мсб" "" "2 мсб 122 мсп 68 мсд 6А"
                        in
                        Expect.all
                            [ \_ -> Unit.isSameOrChildUnit battalion1 battalion2 |> Expect.equal False
                            , \_ -> Unit.isSameOrChildUnit battalion2 battalion1 |> Expect.equal False
                            ]
                            ()
                ]
            ]
        ]
