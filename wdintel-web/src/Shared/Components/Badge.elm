module Shared.Components.Badge exposing (view)

import Html exposing (Html, div, text)
import Html.Attributes exposing (class)


view : String -> Html msg
view value =
    div
        [ class "bg-card rounded-full px-[4px] py-[2px] text-xs inline-block" ]
        [ text value]
