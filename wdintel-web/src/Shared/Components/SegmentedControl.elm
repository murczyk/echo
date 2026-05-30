module Shared.Components.SegmentedControl exposing (SegmentedControl, new, view)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)


type alias SegmentedControl a msg =
    { value : a
    , onChange : a -> msg
    , options : List (SegmentedOption a)
    , className : Maybe String
    , ariaLabel : Maybe String
    }


type alias SegmentedOption a =
    { value : a
    , label : String
    }


new : a -> (a -> msg) -> List (SegmentedOption a) -> SegmentedControl a msg
new value onChange options =
    { value = value
    , onChange = onChange
    , options = options
    , className = Nothing
    , ariaLabel = Nothing
    }


view : SegmentedControl a msg -> Html msg
view control =
    let
        containerClasses =
            case control.className of
                Just className ->
                    "inline-flex p-1 rounded-lg shadow-sm transition-all duration-200 " ++ className

                Nothing ->
                    "inline-flex p-1 rounded-lg shadow-sm transition-all duration-200"
    in
    div
        [ class containerClasses
        , style "background-color" "var(--card-color)"
        , style "border" "1px solid var(--border-color)"
        , attribute "role" "radiogroup"
        , attribute "aria-label" (Maybe.withDefault "Фільтр статусу" control.ariaLabel)
        ]
        (List.map (renderOption control) control.options)


renderOption : SegmentedControl a msg -> SegmentedOption a -> Html msg
renderOption control option =
    let
        isSelected =
            control.value == option.value

        baseClasses =
            "relative px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 focus:outline-none min-w-[80px]"

        buttonStyles =
            if isSelected then
                [ style "background-color" "var(--action-color)"
                , style "color" "var(--button-text-color)"
                , style "box-shadow" "0 1px 2px 0 rgba(0, 0, 0, 0.05)"
                ]

            else
                [ style "background-color" "transparent"
                , style "color" "var(--text-color)"
                , style "opacity" "0.7"
                ]
    in
    button
        ([ type_ "button"
         , attribute "role" "radio"
         , attribute "aria-checked"
            (if isSelected then
                "true"

             else
                "false"
            )
         , class baseClasses
         , style "min-width" "80px"
         , style "border" "none"
         , style "cursor" "pointer"
         , style "font-family" "inherit"
         , style "font-size" "0.875rem"
         , style "line-height" "1.25rem"
         , style "font-weight" "500"
         , style "border-radius" "0.375rem"
         , style "transition" "all 0.2s ease-in-out"
         , style "outline" "none"
         , onClick (control.onChange option.value)
         ]
            ++ buttonStyles
        )
        [ text option.label ]
