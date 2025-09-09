module Shared.Components.Tabs exposing (view)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)


view : List { id : Int, label : String } -> Int -> (Int -> msg) -> Html msg
view tabs activeTabId onTabClick =
    div [ class "tabs-container" ]
        [ div [ class "tabs-nav" ]
            (List.map (renderTab activeTabId onTabClick) tabs)
        ]


renderTab : Int -> (Int -> msg) -> { id : Int, label : String } -> Html msg
renderTab activeTabId onTabClick tab =
    let
        isActive =
            tab.id == activeTabId
    in
    button
        [ classList
            [ ( "tab-button active", isActive )
            , ( "tab-button", not isActive )
            ]
        , onClick (onTabClick tab.id)
        ]
        [ text tab.label
        , if isActive then
            div [ class "tab-indicator" ] []

          else
            text ""
        ]
