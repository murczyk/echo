module Pages_.RerAnalysis.ToggleButton exposing (toggleButton2)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra exposing (viewMaybe)
import Pages_.RerAnalysis.Msg exposing (..)
import Utils.Utils exposing (..)


toggleButton2 :
    { isDark : Bool
    , unfold : Bool
    , toggleMsg : Msg
    , tooltip : String
    , disabled : Bool
    }
    -> Html Msg
    -> Maybe String
    -> Html Msg
toggleButton2 config label mCountLabel =
    let
        countLabel =
            flip viewMaybe mCountLabel <|
                \lbl ->
                    sup []
                        [ span
                            [ class "bg-secondary text-w text-xs px-1 py-0.5 rounded-full"
                            , style "font-size" ".5rem"
                            ]
                            [ text lbl ]
                        ]
    in
    button
        [ type_ "button"
        , class "inline-flex items-center justify-center text-nowrap rounded-none p-1 transition-colors duration-200 ease-in-out"
        , classList
            [ ( "bg-neutral-light text-text hover:bg-neutral-light-hover border border-border dark:bg-neutral-dark dark:text-w dark:hover:bg-neutral-dark-hover", not config.unfold )
            , ( "bg-[var(--color-secondary)] text-w hover:bg-secondary-hover", config.unfold )
            ]
        , style "min-height" "40px"
        , style "min-width" "50px"
        , onClick config.toggleMsg
        , title config.tooltip
        , disabled config.disabled
        ]
        [ span [ style "opacity" "0" ] [ countLabel ]
        , label
        , countLabel
        ]
