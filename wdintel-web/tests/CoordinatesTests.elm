module CoordinatesTests exposing (..)

import Core.Coordinates as C
import Expect
import List.Extra
import Pages.Importer
import Parser as P exposing ((|.), (|=), Parser)
import Shared.Components.Console
import Test exposing (..)
import Time
import Utils.Time


suite : Test
suite =
    describe "Coordinates" (testsCoordinates ++ testProgressRegex ++ testParseDateStr)


testsCoordinates : List Test
testsCoordinates =
    [ test "simple wgs84 lat lng" <|
        \_ ->
            let
                res =
                    C.extractCoordinates "bla (47.1305050, 33.7418280) bla"
            in
            Expect.equal
                res
                [ C.Wgs84LatLng { lat = 47.130505, lng = 33.741828 } ]
    , test "simple wgs84 deg min sec" <|
        \_ ->
            let
                res =
                    C.extractCoordinates """bla 47°14'31.4"N 33°35'57.8"E bla"""
            in
            Expect.equal
                res
                [ C.Wgs84DegMinSec
                    { lat = { deg = 47, min = 14, sec = 31.4 }
                    , lng = { deg = 33, min = 35, sec = 57.8 }
                    }
                ]
    , test "simple usk2000" <|
        \_ ->
            let
                res =
                    C.extractCoordinates """bla 52-20714 65-51696 bla"""
            in
            Expect.equal
                res
                [ C.Usk2000
                    { x = 5220714
                    , y = 6551696
                    }
                ]
    , test "exampleContent (example00)" <|
        \_ ->
            Expect.equal
                (C.extractCoordinates Pages.Importer.exampleContent)
                [ C.Wgs84LatLng { lat = 47.130505, lng = 33.741828 }
                , C.Usk2000 { x = 5220714, y = 6551696 }
                ]
    , test "example01" <|
        \_ ->
            let
                content =
                    List.Extra.getAt 1 Pages.Importer.operatyvkaExamples
                        |> Maybe.withDefault "<error content not found>"
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Wgs84LatLng { lat = 47.07227275466425, lng = 33.61823252372279 }
                , C.Usk2000 { x = 5215579, y = 6547075 }
                , C.MGRS "36TWT4693813381"
                ]
    , test "example02" <|
        \_ ->
            let
                content =
                    List.Extra.getAt 2 Pages.Importer.operatyvkaExamples
                        |> Maybe.withDefault "<error content not found>"
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Wgs84LatLng { lat = 47.068996067976, lng = 33.63917305156 }
                , C.Usk2000 { x = 5215227, y = 6548669 }
                , C.MGRS "36TWT4853113030"
                , C.Wgs84LatLng { lat = 47.06899606851839, lng = 33.63917305061088 }
                , C.Usk2000 { x = 5215227, y = 6548668 }
                ]
    , test "example03" <|
        \_ ->
            let
                content =
                    List.Extra.getAt 3 Pages.Importer.operatyvkaExamples
                        |> Maybe.withDefault "<error content not found>"
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Wgs84LatLng { lat = 46.8785549, lng = 33.4183013 }
                , C.Wgs84LatLng { lat = 46.8780489, lng = 33.4189665 }
                ]
    , test "example04" <|
        \_ ->
            let
                content =
                    """х:52‐06934, у:65‐48668 виявлені бліндажи, замаскована ворожа техніка, копанір"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Usk2000 { x = 5206934, y = 6548668 }
                ]
    , test "example05 (obsidian ex01)" <|
        \_ ->
            let
                content =
                    """21.15 Борозенське
В ділянці лісосмуги поблизу траси Борозенське-Суханово (47.1653213, 33.4429954)-(47.1348549, 33.5189210) джерело сьогодні спостерігало значне скупчення ОВТ ров: танки, бтр, бмп, мтлб.
Точну кількість не встановлено."""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Wgs84LatLng { lat = 47.1653213, lng = 33.4429954 }
                , C.Wgs84LatLng { lat = 47.1348549, lng = 33.518921 }
                ]
    , test "dms to lat lng simple" <|
        \_ ->
            Expect.within (Expect.Relative 0.001)
                (C.dmsToLatLng { deg = 47, min = 0, sec = 38.0 })
                47.010556
    , test "two usk2000 coords" <|
        \_ ->
            let
                content =
                    """х:52‐17604, у:65‐55355; х:52‐17670, у:65‐55415, на територіях окремих"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Usk2000 { x = 5217604, y = 6555355 }
                , C.Usk2000 { x = 5217670, y = 6555415 }
                ]
    , test "ex03" <|
        \_ ->
            let
                content =
                    """О 13:00 6.11.2022 зафіксовано перебування військової техніки і БК РОВ на території на північниій околиці смт. Чаплинка Каховського району Херсонської області за координатами: 46.380838,33.544688, 46.379565,33.545197;"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Wgs84LatLng { lat = 46.380838, lng = 33.544688 }
                , C.Wgs84LatLng { lat = 46.379565, lng = 33.545197 }
                ]
    , test "render xy trailing zero" <|
        \_ ->
            let
                xy =
                    C.Usk2000 { x = 5306459, y = 7317274 }
            in
            Expect.equal
                (C.render xy)
                "53-06459 73-17274"
    , test "using comma" <|
        \_ ->
            let
                content =
                    """47.626429/36,660333"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Wgs84LatLng { lat = 47.626429, lng = 36.660333 }
                ]
    , test "newline C.extractCoordinates" <|
        \_ ->
            let
                content =
                    """52 63767
72 79589"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Usk2000 { x = 5263767, y = 7279589 }
                ]
    , test "C.extractCoordinates beginning with number multiline" <|
        \_ ->
            let
                content =
                    """19.00 Качкарівка
В район сьогодні зайшла ОВТ ров.
52-20714
65-51696
Тип не встановлено."""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Usk2000 { x = 5220714, y = 6551696 }
                ]
    , test "C.extractCoordinates Y=..." <|
        \_ ->
            let
                content =
                    """5190950
Y=6678024"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.Usk2000 { x = 5190950, y = 6678024 }
                ]
    , test "C.extractCoordinates MGRS 01" <|
        \_ ->
            let
                content =
                    """37T BN 77303 60895 - пеленги р/с командного рівня (ймовірна точка прибуття)"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.MGRS "37TBN7730360895"
                ]
    , test "C.extractCoordinates MGRS 02" <|
        \_ ->
            let
                content =
                    """37TBN7730360895 - пеленги р/с командного рівня (ймовірна точка прибуття)"""
            in
            Expect.equal
                (C.extractCoordinates content)
                [ C.MGRS "37TBN7730360895"
                ]
    , test "newline parseXYPart 01" <|
        \_ ->
            let
                content =
                    """52 63767"""
            in
            Expect.equal
                (P.run C.parseXYPart content)
                (Ok 5263767)
    , test "newline parseXYPart 02" <|
        \_ ->
            let
                content =
                    """52-63767"""
            in
            Expect.equal
                (P.run C.parseXYPart content)
                (Ok 5263767)
    , test "newline parseXYPart 03" <|
        \_ ->
            let
                content =
                    """52-63767"""
            in
            Expect.equal
                (P.run
                    (P.succeed (\a b -> ( a, b ))
                        |= P.int
                        |. P.oneOf [ P.symbol "-", P.spaces ]
                        |= P.int
                    )
                    content
                )
                (Ok ( 52, 63767 ))
    , test "newline parseOneUsk2000 01" <|
        \_ ->
            let
                content =
                    "5263767\n7279589"
            in
            Expect.equal
                (P.run C.parseOneUsk2000 content)
                (Ok (C.Usk2000 { x = 5263767, y = 7279589 }))
    , test "newline parseOneUsk2000 02" <|
        \_ ->
            let
                content =
                    "52 63767\n72 79589"
            in
            Expect.equal
                (P.run C.parseOneUsk2000 content)
                (Ok (C.Usk2000 { x = 5263767, y = 7279589 }))
    , test "newline parseOneUsk2000 03" <|
        \_ ->
            let
                content =
                    "52-63767\n72-79589"
            in
            Expect.equal
                (P.run C.parseOneUsk2000 content)
                (Ok (C.Usk2000 { x = 5263767, y = 7279589 }))
    ]


testProgressRegex : List Test
testProgressRegex =
    [ test "findLastProgress 01" <|
        \_ ->
            let
                res =
                    Shared.Components.Console.findLastProgress [ "[1/10] hello", "[3/10] world", "junk" ]
            in
            Expect.equal
                res
                (Just
                    { curr = 3, overall = 10 }
                )
    ]


testParseDateStr : List Test
testParseDateStr =
    [ test "testParseDateStr 01" <|
        \_ ->
            let
                res =
                    Utils.Time.parseDatetimeParts "2023-03-29T08:10"
            in
            Expect.equal res
                (Ok
                    { year = 2023
                    , month = Time.Mar
                    , day = 29
                    , hour = 8
                    , minute = 10
                    , second = 0
                    , millisecond = 0
                    }
                )
    , test "testParseDateStr 02" <|
        \_ ->
            let
                res =
                    Utils.Time.parseDatetimeParts "2023-03-29T08:10:32.123"
            in
            Expect.equal res
                (Ok
                    { year = 2023
                    , month = Time.Mar
                    , day = 29
                    , hour = 8
                    , minute = 10
                    , second = 32
                    , millisecond = 123
                    }
                )
    , test "testParseDateStr 03" <|
        \_ ->
            let
                res =
                    Utils.Time.parseDatetimeParts "2023-03-29T08:10:32"
            in
            Expect.equal res
                (Ok
                    { year = 2023
                    , month = Time.Mar
                    , day = 29
                    , hour = 8
                    , minute = 10
                    , second = 32
                    , millisecond = 0
                    }
                )
    , test "testTime 01" <|
        \_ ->
            let
                res =
                    Utils.Time.parseTimeParts "08:10"
            in
            Expect.equal res
                (Ok
                    { year = 1991
                    , month = Time.Jan
                    , day = 1
                    , hour = 8
                    , minute = 10
                    , second = 0
                    , millisecond = 0
                    }
                )
    ]
