module Shared.Components.ActionMenu exposing (actionMenu)

import Html exposing (..)
import Html.Attributes exposing (..)


actionMenu : List (Html msg) -> String -> Html msg
actionMenu body iconName =
    div [ class "d-inline-block" ]
        [ div
            [ class "me-2 pointer d-inline-block"
            , attribute "role" "button"
            , attribute "data-bs-toggle" "dropdown"
            , attribute "aria-expanded" "false"
            ]
            [ i [ class ("bi " ++ iconName) ] [] ]
        , ul
            [ class "dropdown-menu pt-1 pb-1"
            , style "border-radius" "none"
            ]
            (List.map
                (\child ->
                    li [ style "font-size" ".8rem" ]
                        [ span
                            [ class "dropdown-item pointer"
                            ]
                            [ child
                            ]
                        ]
                )
                body
            )
        ]
