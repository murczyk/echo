module Shared.Components.Navbar exposing (navBar)

import Auth
import Core.Auth exposing (hasRole, serverModeIs)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (on, onClick)
import Json.Decode
import Route.Path
import Shared
import Shared.Components.ThemeSwitcher exposing (themeSwitcher)
import Shared.Model exposing (ThemeMode(..))
import Utils.Utils exposing (..)


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
    , onLogout : msg
    , onThemeChange : ThemeMode -> msg
    , onNavbarVisibilityChange : msg
    , supportsFullscreenToggle : Bool
    , isNavbarVisible : Bool
    , openDropdown : Maybe String
    , onDropdownToggle : Maybe String -> msg
    }


navBar : Auth.User -> Shared.Model -> String -> Props msg -> Html msg
navBar user shared activeName props =
    let
        fullscreenToggleLabel =
            if props.isNavbarVisible then
                "Повноекранний режим"

            else
                "Звичайний режим"

        menu =
            menuItem props activeName

        menuWithSubs =
            menuItemWithSubs props activeName

        adminSubs =
            [ Menu (Internal Route.Path.Admin) "zones" "напрямки"
            , Menu (Internal Route.Path.Admin_UsersNeo) "users-neo" "користувачі"
            , Menu (Internal Route.Path.Admin_OrganismsNeo) "organisms-neo" "організми"
            , Menu (Internal Route.Path.Admin_TagsNeo) "tags-neo" "теги"
            , Menu (Internal Route.Path.Admin_AorNeo) "aor-neo" "смуги"
            , Menu (Internal Route.Path.Admin_KeysNeo) "keys-neo" "ключі"
            , Menu (Internal Route.Path.Admin_MessengerNeo) "messenger-neo" "месенджери"
            , Menu (Internal Route.Path.Admin_ControlPanelNeo) "control-panel-neo" "панель керування"
            , Menu (Internal Route.Path.AdminOld) "zones-old" "напрямки (стара)"
            , Menu (Internal Route.Path.Admin_Users) "users" "користувачі (стара)"
            , Menu (Internal Route.Path.Admin_Organisms) "organisms" "організми (стара)"
            , Menu (Internal Route.Path.Admin_Tags) "tags" "теги (стара)"
            , Menu (Internal Route.Path.AreasOfResponsibility) "areasOfResponsibility" "смуги (стара)"
            , Menu (Internal Route.Path.Admin_Keys) "keys" "ключі (стара)"
            , Menu (Internal Route.Path.Admin_Messenger) "messenger" "месенджери (стара)"
            , Menu (Internal Route.Path.Admin_ControlPanel) "control-panel" "панель (стара)"
            ]

        etalonkaSubs =
            [ Menu (Internal Route.Path.RerFreqs) "freqs" "частоти"
            , Menu (Internal Route.Path.RerCallsignsNeo) "callsigns-neo" "позивні"
            , Menu (Internal Route.Path.RerUnits) "rer-units" "підрозділи"
            , Menu (Internal Route.Path.RerSignals) "signals" "сигнали"
            , Menu (Internal Route.Path.RerNetworks) "networks" "мережі"
            , Menu (Internal Route.Path.RerPalitraNeo) "palitra-neo" "палітри"
            , Menu (Internal Route.Path.RerCallsigns) "callsigns" "позивні (стара)"
            , Menu (Internal Route.Path.RerPalitra) "palitra" "палітри (стара)"
            ]

        importSubs =
            [ Menu (Internal Route.Path.RerDeltaImport) "rer-delta-import" "імпорт delta"
            , Menu (Internal Route.Path.RerCsvImport) "rer-csv-import" "імпорт csv"
            ]

        otherSubs =
            (if serverModeIs "live" shared.serverInfo && hasRole "Rer" user then
                [ Menu (Internal Route.Path.RerDutyNeo) "rer-duty-neo" "оперативний (Alpha)"
                ]

             else
                []
            )
                ++ [ Menu (Internal Route.Path.Importer) "importer" "імпортер"
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
            [ menu Route.Path.Home_ "home" "головна" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menu Route.Path.RerDuty "rer-duty" "оперативний" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menu Route.Path.RerAnalysis "analysis" "аналіз" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "etalonka" "еталонка" etalonkaSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "import" "імпорт" importSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "other" "інше" otherSubs ]
                -- ++ ifOrEmpty (hasRole "Basic" user)
                --     [ menu Route.Path.Settings "settings" "налаштування (стара)" ]
                ++ ifOrEmpty (hasRole "Basic" user)
                    [ menu Route.Path.SettingsNeo "settings-neo" "налаштування" ]
                ++ ifOrEmpty (hasRole "Admin" user)
                    [ menuWithSubs "admin" "адмін" adminSubs ]

        -- Only the new/modern style remains
        navbarStyles =
            [ class "bg-[var(--color-card)] border-b border-[var(--color-border)] py-2 [&_a]:!text-[var(--color-text)] [&_a:hover]:!text-[var(--color-text)]" ]
    in
    header navbarStyles
        [ nav [ class "container mx-auto px-4" ]
            [ div [ class "app-navbar-row flex flex-wrap items-center justify-between gap-x-3 gap-y-2" ]
                [ a
                    [ class "app-navbar-logo flex items-center space-x-2 shrink-0"
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
                        , class "invert brightness-0 contrast-200 h-[16px] shrink-0"
                        ]
                        []
                    ]
                , div [ class "app-navbar-links w-full min-w-0" ]
                    [ ul [ class "app-navbar-links-list flex flex-wrap items-center gap-x-6 gap-y-1 min-w-0" ] menuItems
                    ]
                , div [ class "app-navbar-actions flex gap-2 items-center shrink-0" ]
                    [ if props.supportsFullscreenToggle then
                        button
                            [ class "block py-2 hover:text-[var(--color-text)] hover:bg-[var(--color-column)] px-2 rounded transition-all duration-200 text-[var(--color-text)] border-0 appearance-none flex items-center"
                            , onClick props.onNavbarVisibilityChange
                            , title fullscreenToggleLabel
                            , attribute "aria-label" fullscreenToggleLabel
                            , attribute "aria-pressed"
                                (if props.isNavbarVisible then
                                    "false"

                                 else
                                    "true"
                                )
                            ]
                            [ i
                                [ class "bi bi-arrows-fullscreen text-[var(--color-text)] cursor-pointer hover:text-[var(--color-text)] transition-colors duration-200"
                                ]
                                []
                            ]

                      else
                        text ""
                    , themeSwitcher
                        { currentTheme = shared.themeMode
                        , onThemeChange = props.onThemeChange
                        , triggerClass = "block py-2 hover:text-[var(--color-text)] hover:bg-[var(--color-column)] px-2 rounded transition-all duration-200 text-[var(--color-text)]"
                        }
                    , button
                        [ class "block py-2 hover:text-[var(--color-text)] hover:bg-[var(--color-column)] px-2 rounded transition-all duration-200 text-[var(--color-text)] border-0 appearance-none flex items-center gap-1"
                        , onClick props.onLogout
                        ]
                        [ i [ class "bi bi-box-arrow-right text-lg" ] []
                        , span [ class "hidden sm:inline" ] [ text ("(" ++ user.name ++ ")") ]
                        ]
                    ]
                ]
            ]
        ]


menuItem props activeName hrefLink activeNameExp nameText =
    li []
        [ a
            [ class "block py-2 hover:text-[var(--color-text)] hover:bg-[var(--color-column)] px-2 rounded transition-all duration-200"
            , Route.Path.href hrefLink
            , classList [ ( "text-[var(--color-text)] font-medium", activeName == activeNameExp ) ]
            , onClick (props.onDropdownToggle Nothing)
            ]
            [ text nameText ]
        ]


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
                            [ class "flex items-center justify-between px-4 py-2 hover:bg-[var(--color-column)] hover:text-[var(--color-text)] rounded transition-all duration-200"
                            , classList [ ( "text-[var(--color-text)] font-medium", sub.activeName == activeName ) ]
                            , attribute "role" "menuitem"
                            , Route.Path.href path
                            , onClick (props.onDropdownToggle Nothing)
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
            [ class "inline-flex items-center py-2 px-2 cursor-pointer hover:text-[var(--color-text)] hover:bg-[var(--color-column)] rounded transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-card)]"
            , classList [ ( "text-[var(--color-text)] font-medium", activeName == activeNameExp ) ]
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
        , div [ class "absolute left-0 pt-2 z-[3001]" ]
            [ ul
                [ id dropdownMenuId
                , class "w-56 py-2 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] group-hover:block transition-all duration-200"
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
