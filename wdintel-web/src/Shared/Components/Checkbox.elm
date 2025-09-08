module Shared.Components.Checkbox exposing (new, view, withContent, withDisabled)

import Html exposing (Html, div, input, label, text)
import Html.Attributes exposing (checked, class, for, type_)
import Html.Events exposing (onCheck)


type Config msg
    = Config
        { isChecked : Bool
        , onToggle : Bool -> msg
        , isDisabled : Bool
        , content : List (Html msg)
        }


new : { isChecked : Bool, onToggle : Bool -> msg } -> Config msg
new options =
    Config
        { content = []
        , isChecked = options.isChecked
        , isDisabled = False
        , onToggle = options.onToggle
        }


withContent : List (Html msg) -> Config msg -> Config msg
withContent content (Config config) =
    Config { config | content = content }


withDisabled : Bool -> Config msg -> Config msg
withDisabled disabled (Config config) =
    Config { config | isDisabled = disabled }


view : Config msg -> Html msg
view (Config config) =
    label
        []
        (input
            [ type_ "checkbox"
            , checked config.isChecked
            , onCheck config.onToggle
            , class "accent-toggle-selected mr-[4px]!"
            ]
            []
            :: config.content
        )
