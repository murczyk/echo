module Shared.Components.NavbarOld exposing (navBar)

import Auth
import Core.Auth exposing (hasRole, serverModeIs)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (on, onClick)
import Json.Decode
import Route.Path
import Shared
import Shared.Components.ThemeSwitcher exposing (themeSwitcher)
import Shared.Model exposing (isDarkMode)
import Utils.Utils exposing (..)



-- Types and Props (copied from Navbar.elm)


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
    , onThemeChange : Shared.Model.ThemeMode -> msg
    , onNavbarVisibilityChange : msg
    , isRerDuty : Bool
    , openDropdown : Maybe String
    , onDropdownToggle : Maybe String -> msg
    }


navBar : Auth.User -> Shared.Model -> String -> Props msg -> Html msg
navBar user shared activeName props =
    let
        menu =
            menuItem props activeName

        menuWithBadge =
            menuItemWithBadge props activeName

        menuWithSubs =
            menuItemWithSubs props activeName

        adminSubs =
            [ Menu (Internal Route.Path.Admin) "zones" "напрямки"
            , Menu (Internal Route.Path.Admin_UsersNeo) "users-neo" "користувачі"
            , Menu (Internal Route.Path.Admin_OrganismsNeo) "organisms-neo" "організми"
            , Menu (Internal Route.Path.Admin_TagsNeo) "tags-neo" "теги"
            , Menu (Internal Route.Path.Admin_AorNeo) "aor-neo" "смуги"
            , Menu (Internal Route.Path.Admin_KeysNeo) "keys-neo" "ключі"
            , Menu (Internal Route.Path.Admin_MessangerNeo) "messanger-neo" "месенджери"
            , Menu (Internal Route.Path.Admin_ControlPanelNeo) "control-panel-neo" "панель керування"
            , Menu (Internal Route.Path.AdminOld) "zones-old" "напрямки (старі)"
            , Menu (Internal Route.Path.Admin_Users) "users" "користувачі (стара)"
            , Menu (Internal Route.Path.Admin_Organisms) "organisms" "організми (стара)"
            , Menu (Internal Route.Path.Admin_Tags) "tags" "теги (стара)"
            , Menu (Internal Route.Path.AreasOfResponsibility) "areasOfResponsibility" "смуги (стара)"
            , Menu (Internal Route.Path.Admin_Keys) "keys" "ключі (стара)"
            , Menu (Internal Route.Path.Admin_Messanger) "messanger" "месенджери (стара)"
            , Menu (Internal Route.Path.Admin_ControlPanel) "control-panel" "панель керування (стара)"
            ]

        etalonkaSubs =
            [ Menu (Internal Route.Path.RerFreqs) "freqs" "частоти"
            , Menu (Internal Route.Path.RerCallsigns) "callsigns" "позивні"
            , Menu (Internal Route.Path.RerUnits) "rer-units" "підрозділи"
            , Menu (Internal Route.Path.RerSignals) "signals" "сигнали"
            , Menu (Internal Route.Path.RerNetworks) "networks" "мережі"
            , Menu (Internal Route.Path.RerPalitraNeo) "palitra" "палітра"
            , Menu (Internal Route.Path.RerPalitra) "palitra" "палітра (стара)"
            ]

        importSubs =
            [ Menu (Internal Route.Path.RerDeltaImport) "rer-delta-import" "імпорт delta"
            , Menu (Internal Route.Path.RerCsvImport) "rer-csv-import" "імпорт csv"
            ]

        otherSubs =
            [ Menu (Internal Route.Path.Importer) "importer" "імпортер"
            , Menu (Internal Route.Path.Delta) "kmz2geojson" "kmz в geojson"
            , Menu (Internal Route.Path.AlpinequestKmz) "alpinequest-kmz" "alpinequest в kmz"
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
                    [ menu Route.Path.RerDuty "duty" "оперативний"
                    , menuWithBadge Route.Path.RerDutyNeo "rer-duty-neo" "оперативний" "Alpha" "Сторінка в розробці, потребує допрацювання"
                    ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menu Route.Path.RerAnalysis "analysis" "аналіз" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "etalonka" "еталонка" etalonkaSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "import" "імпорт" importSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "other" "інше" otherSubs ]
                -- ++ ifOrEmpty (hasRole "Basic" user)
                --     [ menu Route.Path.Settings "settings" "налаштування (старі)" ]
                ++ ifOrEmpty (hasRole "Basic" user)
                    [ menu Route.Path.SettingsNeo "settings-neo" "налаштування" ]
                ++ ifOrEmpty (hasRole "Admin" user)
                    [ menuWithSubs "admin" "адмін" adminSubs ]

        navbarStyles =
            [ style "background" "linear-gradient(to bottom, rgba(var(--bd-coyote-rgb), 1), rgba(var(--bd-coyote-rgb), .95))"
            , class "border-b border-black/15 py-2"
            ]

        exoLogoClass =
            if not (isDarkMode shared.themeMode) then
                "invert brightness-0"

            else
                ""
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
                        , class (exoLogoClass ++ " dark:invert dark:brightness-0 dark:contrast-200 h-[16px]")
                        ]
                        []
                    ]
                , div [ class "flex items-center space-x-4" ]
                    [ ul [ class "flex items-center space-x-4" ] menuItems
                    ]
                , div [ class "flex gap-1 items-center" ]
                    [ span [ class "text-white" ]
                        [ themeSwitcher
                            { currentTheme = shared.themeMode
                            , onThemeChange = props.onThemeChange
                            }
                        ]
                    , div
                        [ class "w-6 h-6 flex items-center justify-center"
                        , onClick props.onNavbarVisibilityChange
                        ]
                        [ i
                            [ class "bi bi-arrows-fullscreen text-white cursor-pointer hover:text-white transition-colors duration-200"
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



-- Main navbar links: always white text


menuItem : { a | onDropdownToggle : Maybe b -> msg } -> d -> Route.Path.Path -> d -> String -> Html msg
menuItem props activeName hrefLink activeNameExp nameText =
    li []
        [ a
            [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200"
            , Route.Path.href hrefLink
            , classList [ ( "font-medium", activeName == activeNameExp ) ]
            , onClick (props.onDropdownToggle Nothing)
            ]
            [ text nameText ]
        ]


menuItemWithBadge props activeName hrefLink activeNameExp nameText badgeText badgeTitle =
    li [ class "relative" ]
        [ a
            [ class "block py-2 pr-10 text-white hover:bg-black/10 px-2 rounded transition-all duration-200"
            , Route.Path.href hrefLink
            , classList [ ( "font-medium", activeName == activeNameExp ) ]
            , onClick (props.onDropdownToggle Nothing)
            ]
            [ text nameText
            , span
                [ class "absolute -top-[5px] -right-[10px] text-[10px] font-normal px-1.5 py-0.5 rounded border border-amber-400 bg-amber-500/25 text-amber-200 z-[1]"
                , attribute "title" badgeTitle
                ]
                [ text badgeText ]
            ]
        ]


-- Dropdowns: black text in light mode, white in dark mode


menuItemWithSubs : Props msg -> String -> String -> String -> List Menu -> Html msg
menuItemWithSubs props activeName activeNameExp nameText subs =
    let
        isOpen =
            props.openDropdown == Just activeNameExp

        dropdownMenuId =
            "navbar-dropdown-menu-" ++ activeNameExp

        toggleMsg =
            if isOpen then
                props.onDropdownToggle Nothing

            else
                props.onDropdownToggle (Just activeNameExp)

        dropdownItem : Menu -> Html msg
        dropdownItem sub =
            li []
                [ case sub.link of
                    Internal path ->
                        a
                            [ class "flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-[var(--color-column)] rounded transition-all duration-200"
                            , classList [ ( "font-medium", sub.activeName == activeName ) ]
                            , attribute "role" "menuitem"
                            , Route.Path.href path
                            , onClick (props.onDropdownToggle Nothing)
                            ]
                            [ span [] [ text sub.label ]
                            , if sub.activeName == activeName then
                                i [ class "bi bi-check ml-2" ] []

                              else
                                text ""
                            ]

                    External link ->
                        a
                            [ class "flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-[var(--color-column)] rounded transition-all duration-200"
                            , classList [ ( "font-medium", sub.activeName == activeName ) ]
                            , attribute "role" "menuitem"
                            , href link
                            , target "_blank"
                            , onClick (props.onDropdownToggle Nothing)
                            ]
                            [ span [] [ text sub.label ]
                            , i [ class "bi bi-box-arrow-up-right text-[var(--color-icons)] ml-2 group-hover:text-[var(--color-text)]" ] []
                            ]
                ]
    in
    li [ class "relative group" ]
        [ button
            [ class "inline-flex items-center py-2 px-2 cursor-pointer text-white hover:bg-black/10 rounded transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-1"
            , classList [ ( "font-medium", activeName == activeNameExp ) ]
            , onClick toggleMsg
            , onDropdownTriggerKey toggleMsg
            , attribute "aria-haspopup" "true"
            , attribute "aria-controls" dropdownMenuId
            , attribute "aria-expanded"
                (if isOpen then
                    "true"

                 else
                    "false"
                )
            , type_ "button"
            ]
            [ span [] [ text nameText ]
            , i
                [ class "bi bi-chevron-down ml-1 text-xs transition-transform"
                , classList [ ( "rotate-180", isOpen ) ]
                ]
                []
            ]
        , div [ class "absolute left-0 pt-2 z-500" ]
            [ ul
                [ id dropdownMenuId
                , class "w-56 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] transition-all duration-200"
                , attribute "role" "menu"
                , classList
                    [ ( "hidden", not isOpen )
                    , ( "block", isOpen )
                    ]
                ]
                (List.map dropdownItem subs)
            ]
        ]


onDropdownTriggerKey : msg -> Attribute msg
onDropdownTriggerKey msg =
    on "keydown"
        (Json.Decode.andThen
            (\key ->
                if key == "ArrowDown" then
                    Json.Decode.succeed msg

                else
                    Json.Decode.fail "ignored-key"
            )
            (Json.Decode.field "key" Json.Decode.string)
        )
