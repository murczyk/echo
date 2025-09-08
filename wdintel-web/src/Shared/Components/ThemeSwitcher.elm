module Shared.Components.ThemeSwitcher exposing (themeSwitcher)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Shared.Model exposing (ThemeMode(..))


type alias Props msg =
    { currentTheme : ThemeMode
    , onThemeChange : ThemeMode -> msg
    }


themeSwitcher : Props msg -> Html msg
themeSwitcher props =
    div [ class "relative group" ]
        [ div
            [ class "cursor-pointer p-2 rounded-lg hover:bg-[var(--color-column)] transition-all duration-200"
            , onClick (props.onThemeChange (getNextTheme props.currentTheme))
            ]
            [ i
                [ class
                    ("bi text-lg text-white "
                        ++ (case props.currentTheme of
                                Light ->
                                    "bi-sun"
                                Dark ->
                                    "bi-moon"
                                System ->
                                    "bi-laptop"
                           )
                    )
                ]
                []
            ]
        , div [ class "absolute right-0 pt-2 z-500" ]
            [ div [ class "w-48 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] hidden group-hover:block transition-all duration-200" ]
                [ div [ class "py-2" ]
                    [ themeOption props Light "bi-sun" "Світла тема"
                    , themeOption props Dark "bi-moon" "Темна тема"
                    , themeOption props System "bi-laptop" "Авто (система)"
                    ]
                ]
            ]
        ]


themeOption : Props msg -> ThemeMode -> String -> String -> Html msg
themeOption props theme iconClass label =
    div
        [ class "flex items-center px-4 py-2 hover:bg-[var(--color-column)] cursor-pointer transition-colors duration-150"
        , onClick (props.onThemeChange theme)
        ]
        [ i [ class ("bi " ++ iconClass ++ " mr-3 text-lg") ] []
        , span [ class "text-[var(--color-text)]" ] [ text label ]
        , if props.currentTheme == theme then
            i [ class "bi bi-check ml-auto text-[var(--color-primary)]" ] []
          else
            text ""
        ]


getNextTheme : ThemeMode -> ThemeMode
getNextTheme current =
    case current of
        Light ->
            Dark
        Dark ->
            System
        System ->
            Light


-- Backward compatibility function
colorThemeSwitcher : msg -> Bool -> Html msg
colorThemeSwitcher msg isDark =
    themeSwitcher
        { currentTheme = if isDark then Dark else Light
        , onThemeChange = \_ -> msg
        }
