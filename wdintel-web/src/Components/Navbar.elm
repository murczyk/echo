module Components.Navbar exposing (navBar)

import Auth
import Components.ThemeSwitcher exposing (themeSwitcher)
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Le.Auth exposing (hasRole, serverModeIs)
import Le.Utils exposing (..)
import Route
import Route.Path
import Shared
import Shared.Model exposing (isDarkMode, ThemeMode(..))


type Link
    = Internal Route.Path.Path
    | External String


type alias Menu =
    { link : Link
    , activeName : String
    , label : String
    }


type alias Props msg =
    { onToggleTheme : msg
    , onThemeChange : ThemeMode -> msg
    , onNavbarVisibilityChange : msg
    , isRerDuty : Bool
    }


navBar : Auth.User -> Shared.Model -> String -> Props msg -> Html msg
navBar user shared activeName props =
    let
        menu =
            menuItem activeName

        menuWithSubs =
            menuItemWithSubs activeName

        adminSubs =
            [ Menu (Internal Route.Path.Admin) "zones" "напрямки"
            , Menu (Internal Route.Path.Admin_Users) "users" "користувачі"
            , Menu (Internal Route.Path.Admin_Organisms) "organisms" "організми"
            , Menu (Internal Route.Path.Admin_Messanger) "messanger" "месенджери"
            ]

        etalonkaSubs =
            [ Menu (Internal Route.Path.RerFreqs) "freqs" "частоти"
            , Menu (Internal Route.Path.RerCallsigns) "callsigns" "позивні"
            , Menu (Internal Route.Path.RerUnits) "rer-units" "підрозділи"
            , Menu (Internal Route.Path.RerSignals) "signals" "сигнали"
            , Menu (Internal Route.Path.RerNetworks) "networks" "мережі"
            ]
                ++ (if hasRole "Admin" user then
                        [ Menu (Internal Route.Path.AreasOfResponsibility) "areasOfResponsibility" "смуги" ]

                    else
                        []
                   )

        importSubs =
            [ Menu (Internal Route.Path.RerDeltaImport) "rer-delta-import" "імпорт delta"
            , Menu (Internal Route.Path.RerCsvImport) "rer-csv-import" "імпорт csv"
            ]

        otherSubs =
            [ Menu (Internal Route.Path.Importer) "importer" "імпортер"
            , Menu (Internal Route.Path.Delta) "kmz2geojson" "kmz в geojson"
            , Menu (Internal Route.Path.DeltaCsv2kmz) "csv2kmz" "delta csv в kmz"
            , Menu (Internal Route.Path.DeltaFixkmz) "fixkmz" "очисник kmz"
            , Menu (Internal Route.Path.CoordsConverter) "coords-converter" "конвертер координат"
            ]
                ++ (if hasRole "Admin" user then
                        [ Menu (Internal Route.Path.RadiosConvert) "radios-convert" "радіо kmz конвертер" ]

                    else
                        []
                   )

        menuItems =
            menu Route.Path.Home_ "home" "головна"
                :: ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menu Route.Path.RerDuty "duty" "оперативний" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menu Route.Path.RerAnalysis "analysis" "аналіз" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "etalonka" "еталонка" etalonkaSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "import" "імпорт" importSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "other" "інше" otherSubs ]
                ++ ifOrEmpty (hasRole "Basic" user)
                    [ menu Route.Path.Settings "settings" "налаштування" ]
                ++ ifOrEmpty (hasRole "Admin" user)
                    [ menuWithSubs "admin" "адмін" adminSubs ]

        -- Only the new/modern style remains
        navbarStyles =
            [ class "bg-[var(--color-card)] border-b border-[var(--color-border)] py-2 [&_a]:!text-[var(--color-text)] [&_a:hover]:!text-[var(--color-text)]" ]
    in
    header navbarStyles
        [ nav [ class "container mx-auto px-4" ]
            [ div [ class "flex items-center justify-between" ]
                [ a
                    [ class "flex items-center space-x-2"
                    , href "/"
                    ]
                    [ div
                        [ class "relative w-8 h-7" ]
                        [ div
                            [ class "main-image absolute"
                            , style "height" "28px"
                            , style "width" "28px"
                            ]
                            [ img
                                [ src "/img/SIGINT_190_kraken_transparent.png"
                                , style "width" "28px"
                                , style "height" "28px"
                                ]
                                []
                            ]
                        , div
                            [ class "hover-image absolute"
                            , style "width" "28px"
                            , style "height" "28px"
                            , style "background-color" "#000"
                            , style "border-radius" "50%"
                            ]
                            [ img
                                [ src "/img/flying_skull_logo_transparent.png"
                                , style "width" "28px"
                                , style "z-index" "1"
                                , alt "Flying Skull"
                                ]
                                []
                            ]
                        ]
                    , img
                        [ src "/img/echo-logo.svg"
                        , class "dark:invert dark:brightness-0 dark:contrast-200 h-[16px]"
                        ]
                        []
                    ]
                , div [ class "flex items-center space-x-6" ]
                    [ ul [ class "flex items-center space-x-6" ] menuItems
                    ]
                , div [ class "flex gap-1 items-center" ]
                    [ themeSwitcher 
                        { currentTheme = shared.themeMode
                        , onThemeChange = props.onThemeChange
                        }
                    , div
                        [ class "w-6 h-6 flex items-center justify-center"
                        , onClick props.onNavbarVisibilityChange
                        ]
                        [ i
                            [ class "bi bi-arrows-fullscreen text-[var(--color-text)] cursor-pointer hover:text-[var(--color-text)] transition-colors duration-200"
                            , style "opacity"
                                (if props.isRerDuty then
                                    "1"

                                 else
                                    "0"
                                )
                            , style "pointer-events"
                                (if props.isRerDuty then
                                    "auto"

                                 else
                                    "none"
                                )
                            ]
                            []
                        ]
                    ]
                ]
            ]
        ]


menuItem activeName hrefLink activeNameExp nameText =
    li []
        [ a
            [ class "block py-2 hover:text-[var(--color-text)] hover:bg-[var(--color-column)] px-2 rounded transition-all duration-200"
            , Route.Path.href hrefLink
            , classList [ ( "text-[var(--color-text)] font-medium", activeName == activeNameExp ) ]
            ]
            [ text nameText ]
        ]


menuItemWithSubs : String -> String -> String -> List Menu -> Html msg
menuItemWithSubs activeName activeNameExp nameText subs =
    let
        dropdownItem : Menu -> Html msg
        dropdownItem sub =
            li []
                [ case sub.link of
                    Internal path ->
                        a
                            [ class "flex items-center justify-between px-4 py-2 hover:bg-[var(--color-column)] hover:text-[var(--color-text)] rounded transition-all duration-200"
                            , classList [ ( "text-[var(--color-text)] font-medium", sub.activeName == activeName ) ]
                            , Route.Path.href path
                            ]
                            [ span [] [ text sub.label ]
                            , if sub.activeName == activeName then
                                i [ class "bi bi-check text-[var(--color-text)] ml-2" ] []

                              else
                                text ""
                            ]

                    External link ->
                        a
                            [ class "flex items-center justify-between px-4 py-2 hover:bg-[var(--color-column)] hover:text-[var(--color-text)] rounded transition-all duration-200"
                            , classList [ ( "text-[var(--color-text)] font-medium", sub.activeName == activeName ) ]
                            , href link
                            , target "_blank"
                            ]
                            [ span [] [ text sub.label ]
                            , i [ class "bi bi-box-arrow-up-right text-[var(--color-icons)] ml-2 group-hover:text-[var(--color-text)]" ] []
                            ]
                ]
    in
    li [ class "relative group" ]
        [ a
            [ class "inline-flex items-center py-2 px-2 cursor-pointer hover:text-[var(--color-text)] hover:bg-[var(--color-column)] rounded transition-all duration-200"
            , classList [ ( "text-[var(--color-text)] font-medium", activeName == activeNameExp ) ]
            , href "#"
            ]
            [ span [] [ text nameText ]
            , i
                [ class "bi bi-chevron-down ml-1 text-xs transition-transform group-hover:rotate-180" ]
                []
            ]
        , div [ class "absolute left-0 pt-2 z-500" ]
            [ ul
                [ class "w-56 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] hidden group-hover:block transition-all duration-200"
                ]
                (List.map dropdownItem subs)
            ]
        ]
