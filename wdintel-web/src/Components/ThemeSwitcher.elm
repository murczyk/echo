module Components.ThemeSwitcher exposing (colorThemeSwitcher)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)


colorThemeSwitcher : msg -> Bool -> Html msg
colorThemeSwitcher msg isDark =
    div
        [ style "position" "absolute"
        , style "right" "120px"
        , style "top" "11px"
        , style "z-index" "30"
        , style "color" "white"
        ]
        [ div [ class "d-flex justify-content-center align-items-start" ]
            [ div
                [ class "pointer me-2"
                , onClick msg
                ]
                [ i
                    [ class
                        ("bi "
                            ++ (if isDark then
                                    "bi-sun"

                                else
                                    "bi-moon"
                               )
                        )
                    ]
                    []
                ]
            ]
        ]
