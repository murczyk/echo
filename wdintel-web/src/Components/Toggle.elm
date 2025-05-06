module Components.Toggle exposing (Toggle, new, view)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)



-- Define the opaque Toggle type


type Toggle msg
    = Settings
        { onToggle : msg
        , label : String
        }



-- Create a new Toggle with required properties


new : { onToggle : msg, label : String } -> Toggle msg
new options =
    Settings
        { onToggle = options.onToggle
        , label = options.label
        }



-- View function to render the toggle


view : Bool -> Toggle msg -> Html msg
view isActive (Settings settings) =
    div [ class "switcher flex gap-[4px] items-center" ]
        [ input [ type_ "checkbox", id "toggle", class "w-0 h-0 hidden", onClick settings.onToggle, checked isActive ] []
        , label
            [ for "toggle"
            , class "switcher-label"
            ]
            []
        , span [] [ text settings.label ]
        ]
