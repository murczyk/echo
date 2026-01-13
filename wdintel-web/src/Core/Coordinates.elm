module Core.Coordinates exposing (Coordinates(..), DMS, dmsToLatLng, extractCoordinates, parseOneUsk2000, parseXYPart, render, renderWgsFloat)

import List.Extra as ListX
import Parser as P exposing ((|.), (|=), Parser)
import Regex
import Round
import Utils.Utils exposing (..)


type alias DMS =
    { deg : Int, min : Int, sec : Float }


type Coordinates
    = Wgs84LatLng { lat : Float, lng : Float }
    | Wgs84DegMinSec { lat : DMS, lng : DMS }
    | Usk2000 { x : Int, y : Int }
    | MGRS String


renderWgsFloat : Float -> String
renderWgsFloat x =
    Round.round 6 x


render : Coordinates -> String
render c =
    case c of
        Wgs84LatLng cx ->
            renderWgsFloat cx.lat ++ ", " ++ renderWgsFloat cx.lng

        Wgs84DegMinSec cx ->
            renderDMS cx.lat ++ ", " ++ renderDMS cx.lng

        Usk2000 cx ->
            let
                xBig =
                    cx.x // 100000

                xRem =
                    cx.x - xBig * 100000

                yBig =
                    cx.y // 100000

                yRem =
                    cx.y - yBig * 100000
            in
            leadingZeroes 2 (String.fromInt xBig)
                ++ "-"
                ++ leadingZeroes 5 (String.fromInt xRem)
                ++ " "
                ++ leadingZeroes 2 (String.fromInt yBig)
                ++ "-"
                ++ leadingZeroes 5 (String.fromInt yRem)

        MGRS s ->
            s


leadingZeroes : Int -> String -> String
leadingZeroes numChars s =
    if String.length s >= numChars then
        s

    else
        let
            need =
                numChars - String.length s
        in
        String.repeat need "0" ++ s


dmsToLatLng : DMS -> Float
dmsToLatLng c =
    toFloat c.deg
        + (toFloat c.min
            / 60
          )
        + (c.sec
            / 3600
          )


renderDMS : DMS -> String
renderDMS dms =
    String.fromInt dms.deg ++ "°" ++ String.fromInt dms.min ++ "'" ++ String.fromFloat dms.sec


normalizeMgrsInput : String -> String
normalizeMgrsInput s =
    s
        |> String.toUpper
        |> String.map normalizeMgrsChar


normalizeMgrsChar : Char -> Char
normalizeMgrsChar c =
    case c of
        'А' ->
            'A'

        'В' ->
            'B'

        'С' ->
            'C'

        'Е' ->
            'E'

        'Н' ->
            'H'

        'І' ->
            'I'

        'К' ->
            'K'

        'М' ->
            'M'

        'О' ->
            'O'

        'Р' ->
            'P'

        'Т' ->
            'T'

        'Х' ->
            'X'

        'У' ->
            'U'

        'З' ->
            'Z'

        _ ->
            c


extractCoordinates : String -> List Coordinates
extractCoordinates s =
    let
        ress =
            List.map extractCoordinates1AndLeftover (String.lines s)

        coords : List Coordinates
        coords =
            List.concatMap Tuple.first ress

        dropMonkey x =
            if String.startsWith "🙈" x then
                String.dropLeft 2 x

            else
                x

        s2Lines =
            List.map
                (dropMonkey << Tuple.second)
                ress

        usk2000Ress2 : List Coordinates
        usk2000Ress2 =
            List.concatMap linesRes (ListX.tails s2Lines)

        linesRes ls =
            P.run parseOneUsk2000 (String.join "\n" ls)
                |> resToList
    in
    unique <| coords ++ usk2000Ress2


parseXYPart : Parser Int
parseXYPart =
    P.int
        |> P.andThen
            (\i ->
                if i >= 3000000 && i < 9000000 then
                    P.succeed i

                else if i >= 30 && i < 90 then
                    (P.succeed identity
                        |. P.oneOf [ P.symbol "-", P.spaces ]
                        |= P.int
                    )
                        |> P.andThen
                            (\i2 ->
                                if i2 >= 10000 && i < 100000 then
                                    P.succeed (i * 100000 + i2)

                                else
                                    P.problem "Not a coordinate err 2"
                            )

                else
                    P.problem "Not a coordinate"
            )


notNumber : Parser ()
notNumber =
    P.chompWhile (\c -> not (Char.isDigit c))


parseOneUsk2000 : Parser Coordinates
parseOneUsk2000 =
    P.succeed (\x y -> Usk2000 { x = x, y = y })
        |. notNumber
        |= parseXYPart
        |. P.oneOf [ P.symbol "\n", P.spaces ]
        |= P.oneOf
            [ parseXYPart
            , P.symbol "Y=" |> P.andThen (\_ -> parseXYPart)
            ]


extractCoordinates1AndLeftover : String -> ( List Coordinates, String )
extractCoordinates1AndLeftover sOrig =
    let
        -- we're adding this symbol to use [^\\d] in regexes beginning
        s =
            "🙈" ++ sOrig

        ro =
            { caseInsensitive = False, multiline = True }

        regLatLng =
            Maybe.withDefault Regex.never <|
                Regex.fromStringWith ro """[^\\d]([2-5]\\d\\.\\d\\d\\d+)[^\\d]*?([2-5]\\d\\.\\d\\d\\d+)"""

        regLatLng2 =
            Maybe.withDefault Regex.never <|
                Regex.fromStringWith ro """[^\\d]([2-5]\\d[\\.\\,]\\d\\d\\d+)[^\\d]*?([2-5]\\d[\\.\\,]\\d\\d\\d+)"""

        regDMS =
            Maybe.withDefault Regex.never <|
                Regex.fromStringWith ro """[^\\d](\\d+\\°\\d+'\\d+\\.?\\d?\\d?\\d?\\d?\\d?\\d?)[^\\d]*(\\d+\\°\\d+'\\d+\\.?\\d?\\d?\\d?\\d?\\d?\\d?)"""

        regDMSSingle =
            Maybe.withDefault Regex.never <|
                Regex.fromStringWith ro """(\\d+)\\°(\\d+)'(\\d+\\.?\\d?\\d?\\d?\\d?\\d?\\d?)"""

        matchesLatLng =
            Regex.find regLatLng s

        regUsk2000 =
            Maybe.withDefault Regex.never <|
                Regex.fromStringWith ro """[^\\d]([4-6][0-9][-‐–— ]?[0-9][0-9][0-9][0-9][0-9])[^\\\\d]+?([4-7][0-9][-‐–— ]?[0-9][0-9][0-9][0-9][0-9])"""

        -- regUsk2000_2 =
        --     Maybe.withDefault Regex.never <|
        --         Regex.fromStringWith ro """[^\\d]([4-6][0-9][-‐–— ]?[0-9][0-9][0-9][0-9][0-9])[^\\\\d]+?([4-7][0-9][-‐–— ]?[0-9][0-9][0-9][0-9][0-9])"""
        latLngMap m =
            case m.submatches of
                [ Just latS0, Just lngS0 ] ->
                    let
                        latS =
                            String.replace "," "." latS0

                        lngS =
                            String.replace "," "." lngS0
                    in
                    case ( String.toFloat latS, String.toFloat lngS ) of
                        ( Just lat, Just lng ) ->
                            [ Wgs84LatLng { lat = lat, lng = lng } ]

                        _ ->
                            []

                _ ->
                    []

        latLngRess =
            List.concatMap latLngMap matchesLatLng

        matchesLatLng2 =
            Regex.find regLatLng2 s3

        latLng2Ress =
            List.concatMap latLngMap matchesLatLng2

        regMgrs =
            Maybe.withDefault Regex.never <|
                Regex.fromStringWith ro """(\\d\\d[A-Z] ?[A-Z][A-Z] ?\\d\\d\\d\\d\\d? ?\\d? ?\\d? ?\\d? ?\\d\\d\\d\\d\\d? ?\\d? ?\\d? ?\\d?)"""

        sMgrs =
            normalizeMgrsInput s

        matchesMgrs =
            Regex.find regMgrs sMgrs

        mgrsMap m =
            case m.submatches of
                [ Just mgrsS0 ] ->
                    let
                        mgrsS1 =
                            String.replace " " "" mgrsS0
                    in
                    [ MGRS mgrsS1 ]

                _ ->
                    []

        mgrsRess =
            List.concatMap mgrsMap matchesMgrs

        s2 =
            List.foldl (\x acc -> String.replace x.match "" acc) s matchesLatLng

        matchesDMS =
            Regex.find regDMS s2

        s3 =
            List.foldl (\x acc -> String.replace x.match "" acc) s2 matchesDMS

        matchesUsk2000 =
            Regex.find regUsk2000 s3

        dmsMap m =
            case m.submatches of
                [ Just latS, Just lngS ] ->
                    case ( Regex.find regDMSSingle latS, Regex.find regDMSSingle lngS ) of
                        ( [ latDMSm ], [ lngDMSm ] ) ->
                            case ( latDMSm.submatches, lngDMSm.submatches ) of
                                ( [ Just d1s, Just m1s, Just s1s ], [ Just d2s, Just m2s, Just s2s ] ) ->
                                    case ( ( String.toInt d1s, String.toInt m1s, String.toFloat s1s ), ( String.toInt d2s, String.toInt m2s, String.toFloat s2s ) ) of
                                        ( ( Just d1, Just m1, Just s1 ), ( Just d2, Just m2, Just s2_ ) ) ->
                                            [ Wgs84DegMinSec
                                                { lat = { deg = d1, min = m1, sec = s1 }
                                                , lng = { deg = d2, min = m2, sec = s2_ }
                                                }
                                            ]

                                        _ ->
                                            []

                                _ ->
                                    []

                        _ ->
                            []

                _ ->
                    []

        dmsRess =
            List.concatMap dmsMap matchesDMS

        usk2000Map m =
            case m.submatches of
                [ Just xS, Just yS ] ->
                    let
                        x2 =
                            String.filter Char.isDigit xS

                        y2 =
                            String.filter Char.isDigit yS
                    in
                    case ( String.toInt x2, String.toInt y2 ) of
                        ( Just x, Just y ) ->
                            [ Usk2000 { x = x, y = y } ]

                        _ ->
                            []

                _ ->
                    []

        usk2000Ress =
            List.concatMap usk2000Map matchesUsk2000
    in
    ( unique <| latLngRess ++ dmsRess ++ usk2000Ress ++ latLng2Ress ++ mgrsRess
    , s3
    )
