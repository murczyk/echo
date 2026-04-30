module Shared.Components.Badges exposing (badgeNotSelectedHtml, badgeSelectedCloseCounter, badgeSelectedHtml)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)


badgeNotSelectedHtml : List (Html msg) -> msg -> Html msg
badgeNotSelectedHtml lblHtml toMsgSelect =
    span
        [ class "badge bg-light text-bg-light badge-selected"
        , onClick <| toMsgSelect
        ]
        lblHtml


badgeSelectedHtml : List (Html msg) -> Html msg
badgeSelectedHtml inner =
    span
        [ class "badge bg-primary badge-selected"
        ]
        inner


badgeSelectedCloseCounter : List (Html msg) -> msg -> List (Html msg)
badgeSelectedCloseCounter lblHtml toMsgClose =
    [ badgeSelectedHtml lblHtml
    , sup
        [ style "transform" "translateX(-5px)"
        , style "cursor" "pointer"
        , class "d-inline-block text-danger"
        , onClick <| toMsgClose
        ]
        [ i
            [ class "bi bi-x-circle-fill"
            , style "font-size" "1.5em"
            ]
            []
        ]
    ]
