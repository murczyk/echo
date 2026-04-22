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
    | MenuSeparator


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

        MenuSeparator ->
            False


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

        operationalSubs =
            [ internalMenu Route.Path.RerDuty "rer-duty" "Класичний"
            , internalMenu Route.Path.RerDutyNeo "rer-duty-neo" "Новий"
            , MenuSeparator
            , internalMenuRoute { path = Route.Path.SettingsNeo, query = Dict.fromList [ ( "section", "duty" ) ], hash = Nothing } "settings-neo-duty" "Налаштування"
            ]

        analysisSubs =
            [ internalMenu Route.Path.RerAnalysis "analysis" "Класичний"
            , internalMenu Route.Path.RerAnalysisNeo "rer-analysis-neo" "Новий"
            , MenuSeparator
            , internalMenuRoute { path = Route.Path.SettingsNeo, query = Dict.fromList [ ( "section", "analysis" ) ], hash = Nothing } "settings-neo-analysis" "Налаштування"
            ]

        adminSubs =
            [ internalMenu Route.Path.Admin_GoiIntegrationsNeo "goi-integrations-neo" "ГОІ"
            , internalMenu Route.Path.Admin_KeysNeo "keys-neo" "Ключі"
            , internalMenu Route.Path.Admin_UsersNeo "users-neo" "Користувачі"
            , internalMenu Route.Path.Admin_Messenger "messenger" "Месенджери"
            , internalMenu Route.Path.Admin_MessengerNeo "messenger-neo" "Месенджери"
            , internalMenu Route.Path.Admin_DirectionsNeo "zones" "Напрямки"
            , internalMenu Route.Path.Admin_OrganismsNeo "organisms-neo" "Організми"
            , internalMenu Route.Path.Admin_ControlPanelNeo "control-panel-neo" "Панель керування"
            , internalMenu Route.Path.Admin_AorNeo "aor-neo" "Смуги"
            , internalMenu Route.Path.Admin_TagsNeo "tags-neo" "Теги"
            , MenuSeparator
            , internalMenu Route.Path.Admin_SystemSettingsNeo "system-settings-neo" "Налаштування системи"
            ]

        databaseSubs =
            [ internalMenu Route.Path.RerNetworks "networks" "Мережі"
            , internalMenu Route.Path.RerPalitra "palitra" "Палітри"
            , internalMenu Route.Path.RerPalitraNeo "palitra-neo" "Палітри"
            , internalMenu Route.Path.RerUnits "rer-units" "Підрозділи"
            , internalMenu Route.Path.RerCallsigns "callsigns" "Позивні"
            , internalMenu Route.Path.RerCallsignsNeo "callsigns-neo" "Позивні"
            , internalMenu Route.Path.RerSignals "signals" "Сигнали"
            , internalMenu Route.Path.RerFreqs "freqs" "Частоти"
            ]

        goiSubs =
            let
                openGoiSubs =
                    user.goiIntegrations
                        |> List.concatMap
                            (\integration ->
                                integration.goiUrl
                                    |> Maybe.andThen goiExternalUrl
                                    |> Maybe.map
                                        (\url ->
                                            [ externalMenu
                                                url
                                                ("goi-external-" ++ String.fromInt integration.id)
                                                ("Сервер " ++ integration.ownerOrganismName)
                                            ]
                                        )
                                    |> Maybe.withDefault []
                            )

                goiAssociations =
                    internalMenu Route.Path.GoiAssociations "goi-associations" "Висновки"

                goiKnowledge =
                    internalMenu Route.Path.GoiKnowledge "goi-knowledge" "Інформованість"

                goiSettings =
                    internalMenu Route.Path.GoiSettings "goi-settings" "Налаштування"
            in
            List.concat
                [ ifOrEmpty user.goiFullAccessForOrganism [ goiAssociations ]
                , ifOrEmpty user.goiFullAccessForOrganism [ goiKnowledge ]
                , openGoiSubs
                , [ MenuSeparator
                  , goiSettings
                  ]
                ]

        importSubs =
            List.concat
                [ ifOrEmpty (hasRole "Basic" user)
                    [ internalMenu Route.Path.Importer "importer" "Імпортер" ]
                , ifOrEmpty (hasRole "Rer" user)
                    [ internalMenu Route.Path.RerCsvImport "rer-csv-import" "Імпорт CSV"
                    , internalMenu Route.Path.RerDeltaImport "rer-delta-import" "Імпорт Delta"
                    ]
                ]

        converterSubs =
            [ internalMenu Route.Path.AlpinequestKmz "alpinequest-kmz" "AlpineQuest в KMZ"
            , internalMenu Route.Path.DeltaCsv2kmz "csv2kmz" "Delta CSV в KMZ"
            , internalMenu Route.Path.Delta "kmz2geojson" "KMZ в GeoJSON"
            , internalMenu Route.Path.CoordsConverter "coords-converter" "Координати"
            ]
                ++ (if hasRole "Admin" user then
                        [ internalMenu Route.Path.RadiosConvert "radios-convert" "Радіо KMZ" ]

                    else
                        []
                   )

        otherSubs =
            [ internalMenu Route.Path.DeltaFixkmz "fixkmz" "Очисник KMZ"
            ]

        menuItems =
            let
                menuWithSubs =
                    menuItemWithSubs props activeName

                menuRoute =
                    menuItemRoute props activeName
            in
            List.concat
                [ ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "operational" "Оперативний" operationalSubs ]
                , ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "analysis" "Аналіз" analysisSubs ]
                , ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user)
                    [ menuWithSubs "database" "База даних" databaseSubs ]
                , ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Rer" user && user.goiConfiguredForOrganism)
                    [ menuWithSubs "goi" "ГОІ" goiSubs ]
                , ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "import" "Імпорт" importSubs ]
                , ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "other" "Конвертери" converterSubs ]
                , ifOrEmpty (serverModeIs "live" shared.serverInfo && hasRole "Basic" user)
                    [ menuWithSubs "other-tools" "Інше" otherSubs ]
                , ifOrEmpty (hasRole "Basic" user)
                    [ menuRoute { path = Route.Path.SettingsNeo, query = Dict.fromList [ ( "section", "general" ) ], hash = Nothing } "settings-neo" "Налаштування" ]
                , ifOrEmpty (hasRole "Admin" user)
                    [ menuWithSubs "admin" "Адмін" adminSubs ]
                ]

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

                MenuSeparator ->
                    li
                        [ class "mx-2 my-2 border-t border-white/10"
                        , attribute "role" "separator"
                        ]
                        []

        menuItemLabel :
            { a
                | activeName : String
                , label : String
            }
            -> Html msg
        menuItemLabel item =
            let
                betaPages =
                    [ "callsigns-neo"
                    , "palitra-neo"
                    , "messenger-neo"
                    ]
            in
            span [ class "inline-flex items-center gap-2" ]
                (text item.label
                    :: (if List.member item.activeName betaPages then
                            [ span
                                [ class "rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-amber-700" ]
                                [ text "Beta" ]
                            ]

                        else if item.activeName == "rer-duty-neo" || item.activeName == "rer-analysis-neo" then
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
