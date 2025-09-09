module Shared.Components.Sidebar exposing (..)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)


view : Bool -> msg -> List (Html msg) -> Html msg
view isOpen onCloseMsg children =
    div []
        [         div
            [ class "fixed inset-0 bg-[var(--neutral-600)]/30 transition-opacity duration-300 ease-in-out z-[550]"
            , classList [ ( "opacity-100", isOpen ), ( "opacity-0 pointer-events-none", not isOpen ) ]
            , onClick onCloseMsg
            ]
            []
        , div
            [ class "bg-bw fixed h-full right-0 bottom-0 w-[40%] transform transition-transform duration-300 ease-in-out shadow-xl z-[600]"
            , classList [ ( "translate-x-0", isOpen ), ( "translate-x-full", not isOpen ) ]
            ]
            children
        ]
