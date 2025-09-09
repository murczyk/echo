module Shared.Components.Spinner exposing (loadingSpinner, loadingSpinner2Sm, loadingSpinnerSm)

import Html exposing (..)
import Html.Attributes exposing (..)


loadingSpinner : Html msg
loadingSpinner =
    div [ class "text-center" ]
        [ div
            [ class "inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"
            , attribute "role" "status"
            ]
            [ span [ class "sr-only" ] [ text "Loading..." ] ]
        ]


loadingSpinnerSm : Html msg
loadingSpinnerSm =
    div [ class "text-center" ]
        [ div
            [ class "inline-block w-4 h-4 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin"
            , attribute "role" "status"
            ]
            [ span [ class "sr-only" ] [ text "Loading..." ] ]
        ]


loadingSpinner2Sm : Html msg
loadingSpinner2Sm =
    div
        [ class "inline-block w-4 h-4 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin"
        , attribute "role" "status"
        ]
        [ span [ class "sr-only" ] [ text "Loading..." ] ]
