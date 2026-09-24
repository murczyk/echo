module Shared.Components.DateTime exposing (Model, Msg(..), dateFormErrId, init, initAnalysisRanges, initFromDt, initFromPosix, new, setDateModelValue, setDisabled, setTimeModelValue, update, view)

import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Maybe.Extra as MaybeX
import Time exposing (Posix)
import Time.Extra
import Utils.Components exposing (isInvalidCls)
import Utils.Time


type alias Model =
    { dateStr : String
    , datePosix : Maybe Posix
    , timeStr : String
    , formErrors : Dict String String
    , disabled : Bool
    }


type alias DateTime msg =
    { model : Model
    , toMsg : Msg msg -> msg
    }


new :
    { model : Model
    , toMsg : Msg msg -> msg
    }
    -> DateTime msg
new ps =
    { model = ps.model
    , toMsg = ps.toMsg
    }


init : () -> Model
init _ =
    { dateStr = ""
    , datePosix = Nothing
    , timeStr = "00:00"
    , formErrors = Dict.empty
    , disabled = False
    }


initFromDt :
    { dateStr : String, timeStr : String }
    -> Model
initFromDt ps =
    { dateStr = ps.dateStr
    , datePosix = Nothing
    , timeStr =
        if ps.timeStr == "" then
            "00:00"

        else
            ps.timeStr
    , formErrors = Dict.empty
    , disabled = False
    }


initFromDtAndPosix :
    { dateStr : String
    , timeStr : String
    , datePosix : Maybe Posix
    }
    -> Model
initFromDtAndPosix ps =
    { dateStr = ps.dateStr
    , datePosix = ps.datePosix
    , timeStr = ps.timeStr
    , formErrors = Dict.empty
    , disabled = False
    }


initFromPosix :
    { datePosix : Posix
    , zone : Time.Zone
    }
    -> Model
initFromPosix ps =
    let
        ( dateStr, timeStr ) =
            Utils.Time.posixToString ps.datePosix ps.zone
    in
    { dateStr = dateStr
    , datePosix = Just ps.datePosix
    , timeStr = timeStr
    , formErrors = Dict.empty
    , disabled = False
    }


setDisabled : Bool -> DateTime msg -> DateTime msg
setDisabled isDisabled ps =
    let
        model =
            ps.model

        m2 =
            { model
                | disabled = isDisabled
            }
    in
    { ps | model = m2 }


initAnalysisRanges :
    { from : Model
    , radioFeaturesAllowed : Bool
    , to : Model
    , zone : Time.Zone
    , now : Posix
    }
    -> ( Model, Model )
initAnalysisRanges ps =
    let
        tomorrowMidnight =
            Time.Extra.posixToParts ps.zone ps.now
                |> (\parts ->
                        { parts
                            | hour = 0
                            , minute = 0
                            , second = 0
                            , millisecond = 0
                            , day = parts.day + 1
                        }
                   )
                |> Time.Extra.partsToPosix ps.zone

        defaultToPosix =
            tomorrowMidnight

        defaultFromPosix =
            Time.Extra.add
                Time.Extra.Day
                (if ps.radioFeaturesAllowed then
                    -1

                 else
                    -90
                )
                ps.zone
                defaultToPosix

        dateFromStr =
            if ps.from.dateStr /= "" then
                ps.from.dateStr

            else
                Utils.Time.posixToInputValueDate ps.zone defaultFromPosix

        timeFromStr =
            if ps.from.timeStr /= "" then
                ps.from.timeStr

            else
                Utils.Time.posixToInputValueTime ps.zone defaultFromPosix

        dtFromPosix =
            if dateFromStr /= "" && timeFromStr /= "" then
                MaybeX.or
                    (Utils.Time.mParseDatetimeStr ps.zone (dateFromStr ++ "T" ++ timeFromStr))
                    (Just defaultFromPosix)

            else
                Just defaultFromPosix

        dtToPosix =
            if dateToStr /= "" && timeToStr /= "" then
                MaybeX.or
                    (Utils.Time.mParseDatetimeStr ps.zone (dateToStr ++ "T" ++ timeToStr))
                    (Just defaultToPosix)

            else
                Just defaultToPosix

        dateToStr =
            if ps.to.dateStr /= "" then
                ps.to.dateStr

            else
                Utils.Time.posixToInputValueDate ps.zone defaultToPosix

        timeToStr =
            if ps.to.timeStr /= "" then
                ps.to.timeStr

            else
                Utils.Time.posixToInputValueTime ps.zone defaultToPosix

        from =
            initFromDtAndPosix
                { dateStr = dateFromStr
                , timeStr = timeFromStr
                , datePosix = dtFromPosix
                }

        to =
            initFromDtAndPosix
                { dateStr = dateToStr
                , timeStr = timeToStr
                , datePosix = dtToPosix
                }
    in
    ( from, to )


setDateModelValue : Model -> String -> Time.Zone -> Model
setDateModelValue model v zone =
    let
        m2 =
            { model | dateStr = v, formErrors = Dict.empty }
    in
    case Utils.Time.parseDatetimeParts (m2.dateStr ++ "T" ++ m2.timeStr) of
        Err e ->
            { m2 | formErrors = Dict.insert dateFormErrId e m2.formErrors }

        Ok parts ->
            { m2 | datePosix = Just (Time.Extra.partsToPosix zone parts) }


setTimeModelValue : Model -> String -> Time.Zone -> Model
setTimeModelValue model v zone =
    let
        m2 =
            { model | timeStr = v, formErrors = Dict.empty }
    in
    case Utils.Time.parseDatetimeParts (m2.dateStr ++ "T" ++ m2.timeStr) of
        Err e ->
            { m2 | formErrors = Dict.insert dateFormErrId e m2.formErrors }

        Ok parts ->
            let
                posix =
                    Time.Extra.partsToPosix zone parts
            in
            { m2 | datePosix = Just posix }


type Msg msg
    = SetDate String
    | SetTime String


dateFormErrId : String
dateFormErrId =
    "datetime"


update :
    { zone : Time.Zone
    , msg : Msg msg
    , model : Model
    , toModel : Model -> model
    , toMsg : Msg msg -> msg
    }
    -> ( model, Effect msg )
update ps =
    let
        model =
            ps.model

        toParentModel : ( Model, Effect msg ) -> ( model, Effect msg )
        toParentModel ( innerModel, effect ) =
            ( ps.toModel innerModel
            , effect
            )
    in
    toParentModel <|
        case ps.msg of
            SetDate v ->
                let
                    m2 =
                        setDateModelValue model v ps.zone
                in
                ( m2, E.none )

            SetTime v ->
                let
                    m2 =
                        setTimeModelValue model v ps.zone
                in
                ( m2, E.none )


view :
    DateTime msg
    -> List (Html msg)
view ps =
    let
        model =
            ps.model
    in
    [ div [ class "me-2" ] <|
        [ input
            [ type_ "date"
            , class "form-control"
            , style "max-width" "300px"
            , style "width" "130px"
            , onInput <| ps.toMsg << SetDate
            , value model.dateStr
            , isInvalidCls dateFormErrId model.formErrors
            , disabled model.disabled
            ]
            []
        ]
    , div [ class "me-2" ] <|
        [ input
            [ type_ "time"
            , class "form-control"
            , style "max-width" "300px"
            , style "width" "100px"
            , onInput <| ps.toMsg << SetTime
            , value model.timeStr
            , isInvalidCls dateFormErrId model.formErrors
            , disabled model.disabled
            ]
            []
        ]
    ]
