module Le.Block.Spinner exposing (loadingSpinner, loadingSpinner2Sm, loadingSpinnerSm)

import Html exposing (..)
import Html.Attributes exposing (..)


loadingSpinner : Html msg
loadingSpinner =
    div [ class "text-center" ]
        [ div
            [ class "spinner-border"
            , attribute "role" "status"
            ]
            [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
        ]


loadingSpinnerSm : Html msg
loadingSpinnerSm =
    div [ class "text-center" ]
        [ div
            [ class "spinner-border spinner-border-sm"
            , attribute "role" "status"
            ]
            [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
        ]


loadingSpinner2Sm : Html msg
loadingSpinner2Sm =
    div
        [ class "spinner-border spinner-border-sm"
        , attribute "role" "status"
        ]
        [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
