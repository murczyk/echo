module Utils.Time exposing (getZone, isMoreThanAWeekApart, mParseDatetimeStr, parseDateParts, parseDatetimeParts, parseTimeParts, partsAreSameDay, posixToInputValueDate, posixToInputValueTime, posixToString, renderDateF4, renderDateF5FromMillis, renderDateF6, renderDateTimeF1, renderDateTimeF2, renderDateTimeF3, renderDateTimeF6, renderDateTimeF7, renderDateTimeF9, renderDistanceF1, renderPartsAsInputValue, renderPartsF1, renderTimeF4, xDaysAgo, xDaysInMillis)

import Date
import Dict
import Task
import Time exposing (Posix, Zone)
import Time.Extra exposing (Parts)
import TimeZone
import Utils.Utils exposing (twoSign)


{-| Like "26.03.2023 18:35:08"
-}
renderDateTimeF1 : Zone -> Posix -> String
renderDateTimeF1 z t =
    twoSign (Time.toDay z t)
        ++ "."
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ "."
        ++ String.fromInt (Time.toYear z t)
        ++ " "
        ++ twoSign (Time.toHour z t)
        ++ ":"
        ++ twoSign (Time.toMinute z t)
        ++ ":"
        ++ twoSign (Time.toSecond z t)


{-| Like "18:35:08"
-}
renderDateTimeF2 : Zone -> Posix -> String
renderDateTimeF2 z t =
    twoSign (Time.toHour z t)
        ++ ":"
        ++ twoSign (Time.toMinute z t)
        ++ ":"
        ++ twoSign (Time.toSecond z t)


{-| Like "26.03"
-}
renderDateTimeF3 : Zone -> Posix -> String
renderDateTimeF3 z t =
    twoSign (Time.toDay z t)
        ++ "."
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))


{-| Like "2023-03-26"
-}
renderDateF4 : Zone -> Posix -> String
renderDateF4 z t =
    String.fromInt (Time.toYear z t)
        ++ "-"
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ "-"
        ++ twoSign (Time.toDay z t)


{-| Like "26-03-2024"
-}
renderDateF5 : Zone -> Posix -> String
renderDateF5 z t =
    twoSign (Time.toDay z t)
        ++ "-"
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ "-"
        ++ String.fromInt (Time.toYear z t)


{-| Like "26.03.24"
-}
renderDateF6 : Zone -> Posix -> String
renderDateF6 z t =
    twoSign (Time.toDay z t)
        ++ "."
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ "."
        ++ (Time.toYear z t |> String.fromInt |> String.right 2)


{-| Like "11:24"
-}
renderTimeF4 : Zone -> Posix -> String
renderTimeF4 z t =
    twoSign (Time.toHour z t)
        ++ ":"
        ++ twoSign (Time.toMinute z t)


{-| Like "2023-04-01T22-01"
-}
renderDateTimeF6 : Zone -> Posix -> String
renderDateTimeF6 z t =
    String.fromInt (Time.toYear z t)
        ++ "-"
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ "-"
        ++ twoSign (Time.toDay z t)
        ++ "T"
        ++ twoSign (Time.toHour z t)
        ++ "-"
        ++ twoSign (Time.toMinute z t)


{-| Like "26.03.2023 18:35"
-}
renderDateTimeF7 : Zone -> Posix -> String
renderDateTimeF7 z t =
    twoSign (Time.toDay z t)
        ++ "."
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ "."
        ++ String.slice 2 4 (String.fromInt (Time.toYear z t))
        ++ " "
        ++ twoSign (Time.toHour z t)
        ++ ":"
        ++ twoSign (Time.toMinute z t)


{-| Like "26.03 18:35"
-}
renderDateTimeF9 : Zone -> Posix -> String
renderDateTimeF9 z t =
    twoSign (Time.toDay z t)
        ++ "."
        ++ twoSign (Date.monthToNumber (Time.toMonth z t))
        ++ " "
        ++ twoSign (Time.toHour z t)
        ++ ":"
        ++ twoSign (Time.toMinute z t)



-- {-| parse date str like "2023-03-29" to be a valid value for input type="date"
-- -}
-- renderPartsAsDateInputValue : Parts -> String
-- renderPartsAsDateInputValue ps =
--     String.fromInt ps.year
--         ++ "-"
--         ++ twoSign (Date.monthToNumber ps.month)
--         ++ "-"
--         ++ twoSign ps.day


{-| parse date str like "2023-03-29T08:00" to be a valid value for input type="datetime-local"
-}
renderPartsAsInputValue : Parts -> String
renderPartsAsInputValue ps =
    String.fromInt ps.year
        ++ "-"
        ++ twoSign (Date.monthToNumber ps.month)
        ++ "-"
        ++ twoSign ps.day
        ++ "T"
        ++ twoSign ps.hour
        ++ ":"
        ++ twoSign ps.minute


renderPartsAsInputValueDate : Parts -> String
renderPartsAsInputValueDate ps =
    String.fromInt ps.year
        ++ "-"
        ++ twoSign (Date.monthToNumber ps.month)
        ++ "-"
        ++ twoSign ps.day


renderPartsAsInputValueTime : Parts -> String
renderPartsAsInputValueTime ps =
    twoSign ps.hour
        ++ ":"
        ++ twoSign ps.minute


{-| parse date str like "2023-03-29" coming from input type="date"
-}
parseDateParts : String -> Result String Parts
parseDateParts yearPt =
    let
        goStrings year mon day =
            case ( String.toInt year, String.toInt mon, String.toInt day ) of
                ( Just yearI, Just monI, Just dayI ) ->
                    goInts yearI monI dayI

                _ ->
                    Err ("Error parsing ints for ymd: " ++ yearPt)

        goInts : Int -> Int -> Int -> Result String Parts
        goInts yearI monI dayI =
            let
                parts : Parts
                parts =
                    { year = yearI
                    , month = Date.numberToMonth monI
                    , day = dayI
                    , hour = 0
                    , minute = 0
                    , second = 0
                    , millisecond = 0
                    }
            in
            Ok parts
    in
    case String.split "-" yearPt of
        year :: mon :: day :: [] ->
            goStrings year mon day

        _ ->
            Err ("Error splitting into yyyy-mm-dd: " ++ yearPt ++ " in string " ++ yearPt)


{-| parse time str like "11:24" coming from input type="time"
-}
parseTimeParts : String -> Result String Parts
parseTimeParts str =
    let
        goStrings hours minutes =
            case ( String.toInt hours, String.toInt minutes ) of
                ( Just hoursI, Just minutesI ) ->
                    goInts hoursI minutesI

                _ ->
                    Err ("Error parsing ints for hhmm: " ++ str)

        goInts : Int -> Int -> Result String Parts
        goInts hoursI minutesI =
            let
                parts : Parts
                parts =
                    { year = 1991
                    , month = Date.numberToMonth 1
                    , day = 1
                    , hour = hoursI
                    , minute = minutesI
                    , second = 0
                    , millisecond = 0
                    }
            in
            Ok parts
    in
    case String.split ":" str of
        hours :: minutes :: _ ->
            goStrings hours minutes

        _ ->
            Err ("Error splitting into hh:mm: in string " ++ str)


{-| parse date str like "2023-03-29T08:00" coming from input type="datetime-local"
-}
parseDatetimeParts : String -> Result String Parts
parseDatetimeParts str =
    let
        goStrings year mon day hours minutes seconds milliseconds =
            case ( String.toInt year, String.toInt mon, String.toInt day ) of
                ( Just yearI, Just monI, Just dayI ) ->
                    case ( String.toInt hours, String.toInt minutes ) of
                        ( Just hoursI, Just minutesI ) ->
                            case ( String.toInt seconds, String.toInt milliseconds ) of
                                ( Just secondsI, Just millisecondsI ) ->
                                    goInts yearI monI dayI hoursI minutesI secondsI millisecondsI

                                _ ->
                                    Err ("Error parsing ints for seconds: " ++ str)

                        _ ->
                            Err ("Error parsing ints for hms: " ++ str)

                _ ->
                    Err ("Error parsing ints for ymd: " ++ str)

        goInts : Int -> Int -> Int -> Int -> Int -> Int -> Int -> Result String Parts
        goInts yearI monI dayI hoursI minutesI secondsI millisecondsI =
            let
                parts : Parts
                parts =
                    { year = yearI
                    , month = Date.numberToMonth monI
                    , day = dayI
                    , hour = hoursI
                    , minute = minutesI
                    , second = secondsI
                    , millisecond = millisecondsI
                    }
            in
            Ok parts
    in
    case String.split "T" str of
        yearPt :: timePt :: [] ->
            case String.split "-" yearPt of
                year :: mon :: day :: [] ->
                    case String.split ":" timePt of
                        hours :: minutes :: [] ->
                            goStrings year mon day hours minutes "0" "0"

                        hours :: minutes :: seconds :: [] ->
                            case String.split "." seconds of
                                secs :: millisecs :: [] ->
                                    goStrings year mon day hours minutes secs millisecs

                                secs :: [] ->
                                    goStrings year mon day hours minutes secs "0"

                                _ ->
                                    Err ("Error splitting seconds in string " ++ str)

                        _ ->
                            Err ("Error splitting into HH:MM " ++ timePt ++ " in string " ++ str)

                _ ->
                    Err ("Error splitting into yyyy-mm-dd: " ++ yearPt ++ " in string " ++ str)

        _ ->
            Err ("Error splitting value to year and time: " ++ str)



-- Function to parse a date string in the format "YYYY-MM-DD"


posixToInputValueDate zone dt =
    renderPartsAsInputValueDate (Time.Extra.posixToParts zone dt)


posixToInputValueTime : Zone -> Posix -> String
posixToInputValueTime zone dt =
    renderPartsAsInputValueTime (Time.Extra.posixToParts zone dt)


partsAreSameDay : Parts -> Parts -> Bool
partsAreSameDay pts1 pts2 =
    pts1.year == pts2.year && pts1.month == pts2.month && pts1.day == pts2.day


{-| Like "26.03"
-}
renderPartsF1 : Parts -> String
renderPartsF1 ps =
    twoSign ps.day
        ++ "."
        ++ twoSign (Date.monthToNumber ps.month)


renderDistanceF1 : Zone -> Posix -> Posix -> String
renderDistanceF1 zone event now =
    let
        eventM =
            Time.posixToMillis event

        nowM =
            Time.posixToMillis now

        secsAgo =
            (nowM - eventM) // 1000
    in
    if secsAgo < 5 then
        "щойно"

    else if secsAgo < 60 then
        String.fromInt secsAgo ++ " сек"

    else
        let
            minsAgo =
                secsAgo // 60
        in
        if minsAgo < 60 then
            String.fromInt minsAgo ++ " хв"

        else
            let
                eventPts =
                    Time.Extra.posixToParts zone event

                nowPts =
                    Time.Extra.posixToParts zone now

                hoursAgo =
                    minsAgo // 60
            in
            if partsAreSameDay eventPts nowPts || hoursAgo < 24 then
                String.fromInt hoursAgo ++ " год"

            else
                String.fromInt (Time.Extra.diff Time.Extra.Day zone event now) ++ " дн"


xDaysAgo : Int -> Posix -> Posix
xDaysAgo days currentTime =
    let
        millisecondsNow =
            Time.posixToMillis currentTime

        millisecondsXDaysAgo =
            millisecondsNow - (days * 24 * 60 * 60 * 1000)
    in
    Time.millisToPosix millisecondsXDaysAgo


xDaysInMillis : Int -> Int
xDaysInMillis days =
    1000 * 60 * 60 * 24 * days


oneWeekInMillis : Int
oneWeekInMillis =
    xDaysInMillis 7


isMoreThanAWeekApart : Posix -> Posix -> Bool
isMoreThanAWeekApart time1 time2 =
    abs (Time.posixToMillis time1 - Time.posixToMillis time2) > oneWeekInMillis


mParseDatetimeStr : Zone -> String -> Maybe Posix
mParseDatetimeStr zone dtStr =
    Maybe.map
        (Time.Extra.partsToPosix zone)
        (Result.toMaybe (parseDatetimeParts dtStr))


{-| Calls TimeZone.getZone but first converts "Etc/GMT-2", "Etc/GMT-3", "Europe/Kiev", "Europe/Zaporozhye" to "Europe/Kyiv"
-}
getZone : Task.Task TimeZone.Error ( String, Zone )
getZone =
    TimeZone.getZoneOverriding
        (Dict.fromList
            [ ( "Etc/GMT-2", "Europe/Kyiv" )
            , ( "Etc/GMT-3", "Europe/Kyiv" )
            , ( "Europe/Kiev", "Europe/Kyiv" )
            , ( "Europe/Zaporozhye", "Europe/Kyiv" )
            ]
        )


monthToInt : Time.Month -> Int
monthToInt month =
    case month of
        Time.Jan ->
            1

        Time.Feb ->
            2

        Time.Mar ->
            3

        Time.Apr ->
            4

        Time.May ->
            5

        Time.Jun ->
            6

        Time.Jul ->
            7

        Time.Aug ->
            8

        Time.Sep ->
            9

        Time.Oct ->
            10

        Time.Nov ->
            11

        Time.Dec ->
            12


posixToString : Posix -> Zone -> ( String, String )
posixToString posix zone =
    let
        { year, month, day, hour, minute } =
            Time.Extra.posixToParts zone posix

        monthAsInt =
            monthToInt month

        date =
            String.fromInt year
                ++ "-"
                ++ (String.fromInt monthAsInt |> String.padLeft 2 '0')
                ++ "-"
                ++ (String.fromInt day |> String.padLeft 2 '0')

        time =
            (String.fromInt hour |> String.padLeft 2 '0')
                ++ ":"
                ++ (String.fromInt minute |> String.padLeft 2 '0')
    in
    ( date, time )


renderDateF5FromMillis : Int -> Zone -> String
renderDateF5FromMillis createdAt zone =
    createdAt |> Time.millisToPosix |> renderDateF5 zone
