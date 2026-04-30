module Utils.Components exposing (addEff, fieldError, googleMapsOutLink, hasError, isInvalidCls)

import Dict
import Effect as E
import Html exposing (..)
import Html.Attributes exposing (..)


hasError : comparable -> Dict.Dict comparable v -> Bool
hasError fld formErrors =
    case Dict.get fld formErrors of
        Just _ ->
            True

        Nothing ->
            False


isInvalidCls : comparable -> Dict.Dict comparable v -> Html.Attribute msg
isInvalidCls fld formErrors =
    if hasError fld formErrors then
        class "is-invalid"

    else
        classList []


fieldError : comparable -> Dict.Dict comparable String -> List (Html msg)
fieldError fld formErrors =
    case Dict.get fld formErrors of
        Just e ->
            [ div [ class "invalid-feedback" ] [ text e ] ]

        Nothing ->
            []


googleMapsOutLink : Float -> Float -> Html msg
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
