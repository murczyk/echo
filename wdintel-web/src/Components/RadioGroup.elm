module Components.RadioGroup exposing (RadioGroup, new, view)

import Html exposing (Html, div, input, label, text)
import Html.Attributes exposing (checked, class, name, type_)
import Html.Events exposing (onClick)


type alias RadioGroup option msg =
    { options : List ( option, String )
    , selected : option
    , onSelect : option -> msg
    , name : String
    }


new : String -> List ( option, String ) -> option -> (option -> msg) -> RadioGroup option msg
new name options selected onSelect =
    { options = options
    , selected = selected
    , onSelect = onSelect
    , name = name
    }


view : RadioGroup option msg -> Html msg
view radioGroup =
    div [ class "radio-group" ]
        (List.map (viewRadio radioGroup) radioGroup.options)


viewRadio : RadioGroup option msg -> ( option, String ) -> Html msg
viewRadio radioGroup ( value, labelText ) =
    let
        isSelected =
            value == radioGroup.selected
    in
    label
        [ class "radio-option"
        ]
        [ input
            [ type_ "radio"
            , name radioGroup.name
            , checked isSelected
            , onClick (radioGroup.onSelect value)
            , class "radio-input"
            ]
            []
        , text labelText
        ] 