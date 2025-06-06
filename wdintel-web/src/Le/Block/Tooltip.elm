module Le.Block.Tooltip exposing (new, view, withIconName, withTextNoWrap)

import Html exposing (..)
import Html.Attributes exposing (..)


type Config
    = Config { tooltipText : String, iconName : String, wrapTooltipText : Bool }


new : String -> Config
new tooltipText =
    Config { tooltipText = tooltipText, iconName = "bi-info-circle", wrapTooltipText = True }


withTextNoWrap : Config -> Config
withTextNoWrap (Config config) =
    Config { config | wrapTooltipText = False }


withIconName : String -> Config -> Config
withIconName iconName (Config config) =
    Config { config | iconName = iconName }


view : Html msg -> Config -> Html msg
view body (Config config) =
    span [ class "relative" ]
        [ span
            [ classList [ ( "whitespace-nowrap", not config.wrapTooltipText ) ] ]
            [ text config.tooltipText ]
        , node
            "sl-tooltip"
            [ attribute "hoist" "" ]
            [ div
                [ attribute "slot" "content", style "text-transform" "lowercase" ]
                [ body
                ]
            , span
                [ style "margin-left" "-2px", style "cursor" "pointer" ]
                [ sup []
                    [ i
                        [ class ("bi " ++ config.iconName)
                        ]
                        []
                    ]
                ]
            ]
        ]
