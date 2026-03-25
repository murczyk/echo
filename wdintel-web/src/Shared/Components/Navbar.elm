module Shared.Components.Navbar exposing (navBar)

import Auth
import Core.Auth exposing (hasRole, serverModeIs)
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (on, onClick)
import Json.Decode
import Route
import Route.Path
import Shared
import Shared.Components.ThemeSwitcher exposing (themeSwitcher)
import Shared.Model exposing (ThemeMode)
import String
import Utils.Utils exposing (..)

type Link
    = Internal Route.Path.Path
    | InternalRoute { path : Route.Path.Path, query : Dict.Dict String String, hash : Maybe String }
    | External String


type Menu
    = MenuItem
        { link : Link
        , activeName : String
        , label : String
        }
    | MenuGroup
        { label : String
        , subs : List Menu
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


goiExternalUrl : String -> Maybe String
goiExternalUrl rawHost =
    let
        host =
            String.trim rawHost
    in
    if String.isEmpty host then
        Nothing

    else if String.startsWith "http://" host || String.startsWith "https://" host then
        Just host

    else
        Just ("https://" ++ host)


internalMenu : Route.Path.Path -> String -> String -> Menu
internalMenu path activeName label =
    MenuItem
        { link = Internal path
        , activeName = activeName
        , label = label
        }


externalMenu : String -> String -> String -> Menu
externalMenu link activeName label =
    MenuItem
        { link = External link
        , activeName = activeName
        , label = label
        }


internalMenuRoute : { path : Route.Path.Path, query : Dict.Dict String String, hash : Maybe String } -> String -> String -> Menu
internalMenuRoute route activeName label =
    MenuItem
        { link = InternalRoute route
        , activeName = activeName
        , label = label
        }


menuGroup : String -> List Menu -> Menu
menuGroup label subs =
    MenuGroup
        { label = label
        , subs = subs
        }


menuIsActive : String -> Menu -> Bool
menuIsActive activeName menu =
    case menu of
        MenuItem item ->
            isActiveName item.activeName activeName

        MenuGroup group ->
            List.any (menuIsActive activeName) group.subs


isActiveName : String -> String -> Bool
isActiveName itemActiveName activeName =
    itemActiveName == activeName
        || (itemActiveName == "settings-neo" && String.startsWith "settings-neo" activeName)


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

        menuRoute =
            menuItemRoute props activeName

        operationalSubs =
            [ internalMenu Route.Path.RerDuty "rer-duty" "класичний"
            , internalMenu Route.Path.RerDutyNeo "rer-duty-neo" "новий"
            , internalMenuRoute { path = Route.Path.SettingsNeo, query = Dict.fromList [ ( "section", "duty" ) ], hash = Nothing } "settings-neo-duty" "налаштування"
            ]

        adminSubs =
            [ internalMenu Route.Path.Admin_DirectionsNeo "zones" "напрямки"
            , internalMenu Route.Path.Admin_UsersNeo "users-neo" "користувачі"
            , internalMenu Route.Path.Admin_OrganismsNeo "organisms-neo" "організми"
            , internalMenu Route.Path.Admin_TagsNeo "tags-neo" "теги"
            , internalMenu Route.Path.Admin_AorNeo "aor-neo" "смуги"
            , internalMenu Route.Path.Admin_KeysNeo "keys-neo" "ключі"
            , internalMenu Route.Path.Admin_MessengerNeo "messenger-neo" "месенджери"
            , internalMenu Route.Path.Admin_ControlPanelNeo "control-panel-neo" "панель керування"
            , internalMenu Route.Path.Admin_SystemSettingsNeo "system-settings-neo" "налаштування системи"
            , internalMenu Route.Path.Admin_Messenger "messenger" "месенджери (стара)"
            ]

        etalonkaSubs =
            [ internalMenu Route.Path.RerFreqs "freqs" "частоти"
            , internalMenu Route.Path.RerCallsignsNeo "callsigns-neo" "позивні"
            , internalMenu Route.Path.RerUnits "rer-units" "підрозділи"
            , internalMenu Route.Path.RerSignals "signals" "сигнали"
            , internalMenu Route.Path.RerNetworks "networks" "мережі"
            , internalMenu Route.Path.RerPalitraNeo "palitra-neo" "палітри"
            , internalMenu Route.Path.RerCallsigns "callsigns" "позивні (стара)"
            , internalMenu Route.Path.RerPalitra "palitra" "палітри (стара)"
            ]

        goiSubs =
            (user.goiHost
                |> Maybe.andThen goiExternalUrl
                |> Maybe.map
                    (\url ->
                        [ externalMenu url "goi-external" "відкрити ГОІ"
                        ]
                    )
                |> Maybe.withDefault []
            )
                ++ (if user.goiFullAccessForOrganism then
                        [ internalMenu Route.Path.GoiSettings "goi-settings" "налаштування"
                        , internalMenu Route.Path.GoiAssociations "goi-associations" "висновки"
                        , internalMenu Route.Path.GoiKnowledge "goi-knowledge" "інформованість"
                        ]

                    else
                        [ internalMenu Route.Path.GoiSettings "goi-settings" "налаштування"
                        ]
                   )

        importSubs =
            [ internalMenu Route.Path.RerDeltaImport "rer-delta-import" "імпорт delta"
            , internalMenu Route.Path.RerCsvImport "rer-csv-import" "імпорт csv"
            ]

        otherSubs =
            [ internalMenu Route.Path.Importer "importer" "імпортер"
                   , internalMenu Route.Path.Delta "kmz2geojson" "kmz в geojson"
                   , internalMenu Route.Path.AlpinequestKmz "alpinequest-kmz" "alpinequest в kmz"
                   , internalMenu Route.Path.DeltaCsv2kmz "csv2kmz" "delta csv в kmz"
                   , internalMenu Route.Path.DeltaFixkmz "fixkmz" "очисник kmz"
                   , internalMenu Route.Path.CoordsConverter "coords-converter" "конвертер координат"
                   ]
                ++ (if hasRole "Admin" user then
                        [ internalMenu Route.Path.RadiosConvert "radios-convert" "радіо kmz конвертер" ]

                    else
                        []
                   )

        menuItems =
            menu Route.Path.Home_ "home" "головна"
                :: ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "operational" "оперативний" operationalSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menu Route.Path.RerAnalysis "analysis" "аналіз" ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "etalonka" "еталонка" etalonkaSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user && user.goiConfiguredForOrganism)
                    [ menuWithSubs "goi" "гоі" goiSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "import" "імпорт" importSubs ]
                ++ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "other" "інше" otherSubs ]
                -- ++ ifOrEmpty (hasRole "Basic" user)
                --     [ menu Route.Path.Settings "settings" "налаштування (стара)" ]
                ++ ifOrEmpty (hasRole "Basic" user)
                    [ menuRoute { path = Route.Path.SettingsNeo, query = Dict.fromList [ ( "section", "general" ) ], hash = Nothing } "settings-neo" "налаштування" ]
                ++ ifOrEmpty (hasRole "Admin" user)
                    [ menuWithSubs "admin" "адмін" adminSubs ]

        navbarStyles =
            [ style "background" "linear-gradient(to bottom, rgba(var(--bd-coyote-rgb), 1), rgba(var(--bd-coyote-rgb), .95))"
            , class "border-b border-black/15 py-2"
            ]
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
                    [ ul [ class "app-navbar-links-list flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0" ] menuItems
                    ]
                , div [ class "app-navbar-actions flex gap-2 items-center shrink-0" ]
                    [ if props.supportsFullscreenToggle then
                        button
                            [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200 border-0 appearance-none flex items-center"
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
                                [ class "bi bi-arrows-fullscreen text-white cursor-pointer hover:text-white transition-colors duration-200"
                                ]
                                []
                            ]

                      else
                        text ""
                    , themeSwitcher
                        { currentTheme = shared.themeMode
                        , onThemeChange = props.onThemeChange
                        , triggerClass = "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200"
                        }
                    , button
                        [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200 border-0 appearance-none flex items-center gap-1"
                        , onClick props.onLogout
                        ]
                        [ i [ class "bi bi-box-arrow-right text-lg" ] []
                        , span [ class "hidden sm:inline" ] [ text ("(" ++ user.name ++ ")") ]
                        ]
                    ]
                ]
            ]
        ]



-- Main navbar links: always white text


menuItemRoute : { a | onDropdownToggle : Maybe b -> msg } -> String -> { path : Route.Path.Path, query : Dict.Dict String String, hash : Maybe String } -> String -> String -> Html msg
menuItemRoute props activeName route activeNameExp nameText =
    li []
        [ a
            [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200"
            , classList
                [ ( "font-medium", isActiveName activeNameExp activeName ) ]
            , Route.href { path = route.path, query = route.query, hash = route.hash }
            , onClick (props.onDropdownToggle Nothing)
            ]
            [ text nameText ]
        ]


menuItem : { a | onDropdownToggle : Maybe b -> msg } -> String -> Route.Path.Path -> String -> String -> Html msg
menuItem props activeName hrefLink activeNameExp nameText =
    let
        neoAlphaBadge =
            span
                [ class "pointer-events-none absolute -top-[1px] -right-[18px] z-10 rounded-full border !border-rose-300 bg-rose-300 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-rose-900" ]
                [ text "Alpha" ]

        linkContents =
            if activeNameExp == "rer-duty-neo" then
                [ text nameText
                , neoAlphaBadge
                ]

            else
                [ text nameText ]
    in
    li []
        [ a
            [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200"
            , classList
                [ ( "relative", activeNameExp == "rer-duty-neo" )
                , ( "font-medium", isActiveName activeNameExp activeName )
                ]
            , Route.Path.href hrefLink
            , onClick (props.onDropdownToggle Nothing)
            ]
            linkContents
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

        dropdownLeaf :
            { a
                | activeName : String
                , label : String
                , link : Link
            }
            -> Html msg
        dropdownLeaf item =
            case item.link of
                Internal path ->
                    a
                        [ class "flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-all duration-200"
                        , classList [ ( "font-medium", isActiveName item.activeName activeName ) ]
                        , attribute "role" "menuitem"
                        , Route.Path.href path
                        , onClick (props.onDropdownToggle Nothing)
                        ]
                        [ menuItemLabel item
                        , if isActiveName item.activeName activeName then
                            i [ class "bi bi-check ml-2" ] []

                          else
                            text ""
                        ]

                InternalRoute route ->
                    a
                        [ class "flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-all duration-200"
                        , classList [ ( "font-medium", isActiveName item.activeName activeName ) ]
                        , attribute "role" "menuitem"
                        , Route.href { path = route.path, query = route.query, hash = route.hash }
                        , onClick (props.onDropdownToggle Nothing)
                        ]
                        [ menuItemLabel item
                        , if isActiveName item.activeName activeName then
                            i [ class "bi bi-check ml-2" ] []

                          else
                            text ""
                        ]

                External link ->
                    a
                        [ class "flex items-center justify-between px-4 py-2 text-[var(--color-text)] hover:bg-black/10 dark:hover:bg-white/10 rounded transition-all duration-200"
                        , classList [ ( "font-medium", isActiveName item.activeName activeName ) ]
                        , attribute "role" "menuitem"
                        , href link
                        , target "_blank"
                        , rel "noopener noreferrer"
                        , onClick (props.onDropdownToggle Nothing)
                        ]
                        [ menuItemLabel item
                        , i [ class "bi bi-box-arrow-up-right text-[var(--color-icons)] ml-2 group-hover:text-[var(--color-text)]" ] []
                        ]

        dropdownItem : Menu -> Html msg
        dropdownItem sub =
            case sub of
                MenuItem item ->
                    li [] [ dropdownLeaf item ]

                MenuGroup group ->
                    li [ class "px-2 py-1" ]
                        [ div
                            [ class "px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                            , classList [ ( "text-[var(--color-text)]", menuIsActive activeName sub ) ]
                            ]
                            [ text group.label ]
                        , ul
                            [ class "ml-3 border-l border-[var(--color-border)] pl-2" ]
                            (List.map dropdownItem group.subs)
                        ]

        menuItemLabel :
            { a
                | activeName : String
                , label : String
            }
            -> Html msg
        menuItemLabel item =
            let
                oldSuffix =
                    " (стара)"

                hasOldBadge =
                    String.endsWith oldSuffix item.label

                baseLabel =
                    if hasOldBadge then
                        String.dropRight (String.length oldSuffix) item.label

                    else
                        item.label
            in
            span [ class "inline-flex items-center gap-2" ]
                ([ text baseLabel ]
                    ++ (if hasOldBadge then
                            [ span
                                [ class "rounded-full border border-slate-500/40 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-slate-600"
                                ]
                                [ text "стара" ]
                            ]

                        else
                            []
                       )
                    ++ (if item.activeName == "callsigns-neo" then
                            [ span
                                [ class "rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-amber-700" ]
                                [ text "Beta" ]
                            ]

                        else if item.activeName == "rer-duty-neo" then
                            [ span
                                [ class "rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-amber-700" ]
                                [ text "Alpha" ]
                            ]

                        else
                            []
                       )
                )
    in
    li [ class "relative group" ]
        [ button
            [ class "inline-flex items-center py-2 px-2 cursor-pointer text-white hover:bg-black/10 rounded transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-1"
            , classList [ ( "font-medium", menuIsActive activeName (MenuGroup { label = nameText, subs = subs }) ) ]
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
                , class "w-64 p-2 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] transition-all duration-200"
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
