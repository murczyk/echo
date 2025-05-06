module Le.Components exposing (addEff, fieldError, googleMapsOutLink, hasError, isInvalidCls)

import Dict
import Effect as E
import Html exposing (..)
import Html.Attributes exposing (..)


hasError fld formErrors =
    case Dict.get fld formErrors of
        Just _ ->
            True

        Nothing ->
            False


isInvalidCls fld formErrors =
    if hasError fld formErrors then
        class "is-invalid"

    else
        classList []


fieldError fld formErrors =
    case Dict.get fld formErrors of
        Just e ->
            [ div [ class "invalid-feedback" ] [ text e ] ]

        Nothing ->
            []


googleMapsOutLink lat lng =
    a
        [ href <|
            "http://www.google.com/maps/place/"
                ++ String.fromFloat lat
                ++ ","
                ++ String.fromFloat lng
        , target "_blank"
        ]
        [ i [ class "bi bi-box-arrow-up-right" ] [] ]


addEff : E.Effect msg -> E.Effect msg -> E.Effect msg
addEff eff1 eff2 =
    E.batch [ eff1, eff2 ]
