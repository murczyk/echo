module RerAnalysis.ToggleButton exposing (toggleButton2)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra exposing (viewMaybe)
import Le.Utils exposing (..)
import RerAnalysis.Msg exposing (..)


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
                            [ class "badge badge-sm rounded-pill text-bg-secondary"
                            , style "font-size" ".5rem"
                            ]
                            [ text lbl ]
                        ]
    in
    button
        ([ type_ "button"
         , class "btn text-nowrap rounded-0 p-1"
         , classList [ ( "btn-light", not config.isDark ), ( "btn-secondary", config.isDark ) ]
         , style "min-height" "40px"
         , style "min-width" "50px"
         , onClick config.toggleMsg
         , attribute "data-tooltip" config.tooltip
         , attribute "data-position" "bottom"
         , disabled config.disabled
         ]
            ++ (if config.unfold then
                    [ class "active"
                    , attribute "aria-pressed" "true"
                    ]

                else
                    []
               )
        )
        [ span [ style "opacity" "0" ] [ countLabel ]
        , label
        , countLabel
        ]
