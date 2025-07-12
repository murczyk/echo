module Components.ThemeSwitcher exposing (colorThemeSwitcher)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)


colorThemeSwitcher : msg -> Bool -> Html msg
colorThemeSwitcher msg isDark =
    div
        [ 
        ]
        [ div [ class "flex justify-center items-start" ]
            [ div
                [ class "cursor-pointer me-2"
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
