module Shared.Components.DateRangePicker exposing (Model, Msg(..), ViewParams, init, initFromData, update, view)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Shared.Components.DateTime exposing (..)
import Shared.Components.Popup
import Time exposing (Posix, Zone)
import Utils.Components exposing (hasError, isInvalidCls)
import Utils.Time


type alias ViewParams =
    { zone : Time.Zone
    , from : Shared.Components.DateTime.Model
    , to : Shared.Components.DateTime.Model
    }


type Msg
    = OpenPopup
    | ClosePopup
    | SetFromDate String
    | SetFromTime String
    | SetToDate String
    | SetToTime String
    | Submit


type alias Model =
    { isOpen : Bool
    , isDirty : Bool
    , from : Shared.Components.DateTime.Model
    , to : Shared.Components.DateTime.Model
    }


init : Model
init =
    { isOpen = False
    , isDirty = False
    , from = Shared.Components.DateTime.init ()
    , to = Shared.Components.DateTime.init ()
    }


initFromData : Shared.Components.DateTime.Model -> Shared.Components.DateTime.Model -> Model
initFromData from to =
    { isOpen = False
    , isDirty = False
    , from = from
    , to = to
    }


update : ViewParams -> Msg -> Model -> Model
update vps msg model =
    case msg of
        OpenPopup ->
            { model | isOpen = True, isDirty = False, from = vps.from, to = vps.to }

        ClosePopup ->
            { model | isOpen = False }

        SetFromDate dateStr ->
            let
                from =
                    model.from

                newFrom =
                    Shared.Components.DateTime.setDateModelValue from dateStr vps.zone
            in
            { model | from = newFrom, isDirty = True }

        SetFromTime timeStr ->
            let
                from =
                    model.from

                newFrom =
                    Shared.Components.DateTime.setTimeModelValue from timeStr vps.zone
            in
            { model | from = newFrom, isDirty = True }

        SetToDate dateStr ->
            let
                to =
                    model.to

                newTo =
                    Shared.Components.DateTime.setDateModelValue to dateStr vps.zone
            in
            { model | to = newTo, isDirty = True }

        SetToTime timeStr ->
            let
                to =
                    model.to

                newTo =
                    Shared.Components.DateTime.setTimeModelValue to timeStr vps.zone
            in
            { model | to = newTo, isDirty = True }

        Submit ->
            { model | isOpen = False }


renderSelectedDate : Zone -> Maybe Posix -> String
renderSelectedDate zone mPosix =
    case mPosix of
        Just posix ->
            Utils.Time.renderDateTimeF7 zone posix

        _ ->
            ""


view : ViewParams -> Model -> Html Msg
view vps model =
    let
        body =
            div
                ([ onClick OpenPopup
                 , class "date-range-picker d-flex form-control"
                 , style "gap" "7px"
                 , style "padding-left" "10px"
                 , style "padding-right" "10px"
                 ]
                    ++ (if model.isOpen then
                            [ class "focused" ]

                        else
                            []
                       )
                )
                [ div [] [ text (renderSelectedDate vps.zone vps.from.datePosix) ]
                , div [] [ text "-" ]
                , div [] [ text (renderSelectedDate vps.zone vps.to.datePosix) ]
                , i
                    [ class "bi bi-calendar" ]
                    []
                ]

        popupBody =
            div []
                [ div [ class "d-flex gap-2" ]
                    [ div
                        [ style "font-size" "1rem"
                        , style "width" "20px"
                        , style "text-align" "center"
                        , style "margin-top" "8px"
                        ]
                        [ text "з" ]
                    , input
                        [ type_ "date"
                        , class "form-control"
                        , style "max-width" "300px"
                        , style "width" "140px"
                        , onInput SetFromDate
                        , value model.from.dateStr
                        , isInvalidCls dateFormErrId model.from.formErrors
                        , disabled model.from.disabled
                        ]
                        []
                    , input
                        [ type_ "time"
                        , class "form-control"
                        , style "max-width" "300px"
                        , style "width" "105px"
                        , onInput SetFromTime
                        , value model.from.timeStr
                        , isInvalidCls dateFormErrId model.from.formErrors
                        , disabled model.from.disabled
                        ]
                        []
                    ]
                , div [ class "d-flex gap-2 mt-2" ]
                    [ div
                        [ style "font-size" "1rem"
                        , style "width" "20px"
                        , style "text-align" "center"
                        , style "margin-top" "8px"
                        ]
                        [ text "по" ]
                    , input
                        [ type_ "date"
                        , class "form-control"
                        , style "max-width" "300px"
                        , style "width" "140px"
                        , onInput SetToDate
                        , value model.to.dateStr
                        , isInvalidCls dateFormErrId model.to.formErrors
                        , disabled model.to.disabled
                        ]
                        []
                    , input
                        [ type_ "time"
                        , class "form-control"
                        , style "max-width" "300px"
                        , style "width" "105px"
                        , onInput SetToTime
                        , value model.to.timeStr
                        , isInvalidCls dateFormErrId model.to.formErrors
                        , disabled model.to.disabled
                        ]
                        []
                    ]
                , div [ class "d-flex justify-content-end gap-2", style "margin-top" "10px" ]
                    [ button
                        [ type_ "button"
                        , class "btn btn-outline btn-secondary btn-sm text-nowrap"
                        , style "font-size" ".75rem"
                        , onClick ClosePopup
                        ]
                        [ text "Відмінити"
                        ]
                    , button
                        ([ type_ "button"
                         , class "btn btn-outline btn-primary btn-sm text-nowrap"
                         , style "font-size" ".75rem"
                         , onClick Submit
                         ]
                            ++ (if not model.isDirty || (hasError dateFormErrId model.from.formErrors || hasError dateFormErrId model.to.formErrors) then
                                    [ attribute "disabled" "" ]

                                else
                                    []
                               )
                        )
                        [ text "Підтвердити"
                        ]
                    ]
                ]
    in
    div []
        [ Shared.Components.Popup.new
            { body = body
            , popupBody = popupBody
            , isOpen = model.isOpen
            , onOpen = OpenPopup
            , onClose = ClosePopup
            , disabled = False
            }
            |> Shared.Components.Popup.withPlacementBottom
            |> Shared.Components.Popup.view
        ]
