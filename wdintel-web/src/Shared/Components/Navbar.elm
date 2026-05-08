module Shared.Components.Navbar exposing (navBar)

import Auth
import Char
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
    , onChangelogSeen : String -> msg
    , onCloseDropdownOnly : msg
    , mobileNavOpen : Bool
    , onToggleMobileNav : msg
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
    itemActiveName
        == activeName
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
            , internalMenu Route.Path.RerPalitraNeo "palitra-neo" "Палітри"
            , internalMenu Route.Path.RerUnits "rer-units" "Підрозділи"
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
                    [ internalMenu Route.Path.Importer "importer" "Імпортер"
                    ]
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

        changelogData =
            case shared.changelogPreview of
                Just preview ->
                    if List.isEmpty preview.preview then
                        Nothing

                    else
                        let
                            unseen =
                                case shared.changelogLastSeen of
                                    Just lastSeen ->
                                        lastSeen /= preview.version

                                    Nothing ->
                                        True
                        in
                        Just
                            { preview = preview.preview
                            , version = preview.version
                            , fullUrl = preview.fullUrl
                            , unseen = unseen
                            }

                Nothing ->
                    Nothing

        navbarStyles =
            [ style "background" "linear-gradient(to bottom, rgba(var(--bd-coyote-rgb), 1), rgba(var(--bd-coyote-rgb), .95))"
            , class "border-b border-black/15 py-2"
            ]
    in
    header navbarStyles
        [ nav [ class "container mx-auto px-4" ]
            [ div [ class "app-navbar-row flex w-full flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap lg:justify-between" ]
                [ div [ class "app-navbar-brand flex shrink-0 flex-row flex-nowrap items-center gap-2" ]
                    [ a
                        [ class "app-navbar-logo flex shrink-0 items-center space-x-2"
                        , href "/"
                        ]
                        [ div
                            [ class "relative h-7 w-8" ]
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
                            , class "h-[16px] shrink-0 invert contrast-200 brightness-0"
                            ]
                            []
                        ]
                    , button
                        [ class "flex appearance-none items-center justify-center rounded border-0 px-2 py-2 text-[1.625rem] leading-none text-white transition-all duration-200 hover:bg-black/10 lg:hidden"
                        , type_ "button"
                        , onClick props.onToggleMobileNav
                        , attribute "aria-controls" "app-navbar-links-panel"
                        , attribute "aria-expanded"
                            (if props.mobileNavOpen then
                                "true"

                             else
                                "false"
                            )
                        , attribute "aria-label"
                            (if props.mobileNavOpen then
                                "Закрити меню"

                             else
                                "Відкрити меню"
                            )
                        ]
                        [ i
                            [ class <|
                                String.join " "
                                    [ "app-navbar-mobile-menu-icon"
                                    , if props.mobileNavOpen then
                                        "bi bi-x-lg"

                                      else
                                        "bi bi-list"
                                    ]
                            ]
                            []
                        ]
                    ]
                , div
                    [ id "app-navbar-links-panel"
                    , class <|
                        String.join " "
                            [ "app-navbar-links w-full min-w-0 basis-full border-t border-[var(--color-border)]"
                            , "lg:mt-0 lg:flex lg:w-auto lg:min-w-0 lg:flex-1 lg:basis-0 lg:border-t-0 lg:pt-0"
                            , if props.mobileNavOpen then
                                "flex"

                              else
                                "hidden lg:flex"
                            ]
                    ]
                    [ ul
                        [ class "app-navbar-links-list flex min-w-0 w-full flex-col gap-y-1 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-4 lg:gap-y-1" ]
                        menuItems
                    ]
                , div
                    [ class "app-navbar-toolbar ml-auto flex shrink-0 items-center gap-2" ]
                    [ changelogDropdown props changelogData
                    , if props.supportsFullscreenToggle then
                        button
                            [ class "flex appearance-none items-center border-0 px-2 py-2 text-white transition-all duration-200 hover:bg-black/10"
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
                                [ class "bi bi-arrows-fullscreen cursor-pointer text-white transition-colors duration-200 hover:text-white"
                                ]
                                []
                            ]

                      else
                        text ""
                    , themeSwitcher
                        { currentTheme = shared.themeMode
                        , onThemeChange = props.onThemeChange
                        , triggerClass = "block rounded px-2 py-2 text-white transition-all duration-200 hover:bg-black/10"
                        }
                    , button
                        [ class "flex appearance-none items-center gap-1 border-0 px-2 py-2 text-white transition-all duration-200 hover:bg-black/10"
                        , onClick props.onLogout
                        ]
                        [ i [ class "bi bi-box-arrow-right text-lg" ] []
                        , span [ class "hidden sm:inline" ] [ text ("(" ++ user.name ++ ")") ]
                        ]
                    ]
                ]

            ]
        ]



changelogDropdown : Props msg -> Maybe { preview : List String, version : String, fullUrl : String, unseen : Bool } -> Html msg
changelogDropdown props maybeData =
    case maybeData of
        Nothing ->
            text ""

        Just data ->
            let
                dropdownKey =
                    "changelog"

                isOpen =
                    props.openDropdown == Just dropdownKey

                toggleMsg =
                    if isOpen then
                        props.onDropdownToggle Nothing

                    else
                        props.onDropdownToggle (Just dropdownKey)

                badge =
                    if data.unseen then
                        span
                            [ class "ml-1 inline-flex items-center rounded-full bg-amber-300 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-amber-900" ]
                            [ text "нове" ]

                    else
                        text ""
            in
            div [ class "relative" ]
                [ button
                    [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200 border-0 appearance-none flex items-center gap-1"
                    , onClick toggleMsg
                    , onDropdownTriggerKey toggleMsg
                    , attribute "aria-haspopup" "true"
                    , attribute "aria-expanded" (if isOpen then "true" else "false")
                    , type_ "button"
                    ]
                    [ i [ class "bi bi-stars text-lg" ] []
                    , span [ class "hidden md:inline" ] [ text "що нового" ]
                    , badge
                    ]
                , div [ class "absolute right-0 pt-2 z-[3001]" ]
                    [ ul
                        [ class "w-72 p-3 bg-[var(--color-card)] rounded-lg shadow-lg border border-[var(--color-border)] transition-all duration-200"
                        , classList
                            [ ( "hidden", not isOpen )
                            , ( "block", isOpen )
                            ]
                        ]
                        ([ div [ class "text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2" ] [ text "Останні зміни" ]
                         , ul [ class "space-y-2 text-sm text-[var(--color-text)]" ]
                            (List.map (\line -> li [ class "leading-snug" ] [ renderChangelogLine line ]) data.preview)
                         , div [ class "mt-3 flex items-center justify-between" ]
                            [ a
                                [ href data.fullUrl
                                , target "_blank"
                                , rel "noopener noreferrer"
                                , class "text-sm font-semibold text-amber-600 hover:text-amber-500"
                                , onClick (props.onChangelogSeen data.version)
                                ]
                                [ text "Читати повністю" ]
                            , button
                                [ class "text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                                , onClick (props.onChangelogSeen data.version)
                                , type_ "button"
                                ]
                                [ text "Позначити прочитаним" ]
                            ]
                         ]
                        )
                    ]
                ]



--renderChangelogLine : String -> Html msg
--renderChangelogLine line =
--    if isDateHeading line then
--        span [ class "block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]" ]
--            [ text (String.dropLeft 3 line) ]
--
--    else
--        case parseMarkdownLink line of
--            Just parsed ->
--                span []
--                    ([ a
--                        [ href parsed.url
--                        , target "_blank"
--                        , rel "noopener noreferrer"
--                        , class "font-semibold text-amber-600 hover:text-amber-500"
--                        ]
--                        [ text parsed.label ]
--                     ]
--                        ++ (if String.isEmpty parsed.rest then
--                                []
--
--                            else
--                                [ text (" " ++ parsed.rest) ]
--                           )
--                    )
--
--            Nothing ->
--                text line
--
--
--isDateHeading : String -> Bool
--isDateHeading line =
--    if String.startsWith "## " line then
--        case String.split " " (String.dropLeft 3 line) of
--            date :: _ ->
--                isDateString date
--
--            [] ->
--                False
--
--    else
--        False
--
--
--isDateString : String -> Bool
--isDateString date =
--    String.length date == 10
--        && isDateChar 0 date
--        && isDateChar 1 date
--        && isDateChar 2 date
--        && isDateChar 3 date
--        && String.slice 4 5 date == "-"
--        && isDateChar 5 date
--        && isDateChar 6 date
--        && String.slice 7 8 date == "-"
--        && isDateChar 8 date
--        && isDateChar 9 date
--
--
--isDateChar : Int -> String -> Bool
--isDateChar index value =
--    case String.slice index (index + 1) value |> String.toList of
--        char :: _ ->
--            Char.isDigit char
--
--        [] ->
--            False


--parseMarkdownLink : String -> Maybe { label : String, url : String, rest : String }
--parseMarkdownLink line =
--    if String.startsWith "[" line then
--        case String.split "](" line of
--            before :: after :: [] ->
--                let
--                    label =
--                        String.dropLeft 1 before
--
--                    urlAndRest =
--                        String.split ")" after
--                in
--                case urlAndRest of
--                    url :: restParts ->
--                        Just
--                            { label = label
--                            , url = url
--                            , rest = String.join ")" restParts |> String.trim
--                            }
--
--                    [] ->
--                        Nothing
--
--            _ ->
--                Nothing
--
--    else
--        Nothing

-- Main navbar links: always white text


renderChangelogLine : String -> Html msg
renderChangelogLine line =
    if isDateHeading line then
        span [ class "block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]" ]
            [ text (String.dropLeft 3 line) ]

    else
        case parseMarkdownLink line of
            Just parsed ->
                span []
                    ([ a
                        [ href parsed.url
                        , target "_blank"
                        , rel "noopener noreferrer"
                        , class "font-semibold text-amber-600 hover:text-amber-500"
                        ]
                        [ text parsed.label ]
                     ]
                        ++ (if String.isEmpty parsed.rest then
                                []

                            else
                                [ text (" " ++ parsed.rest) ]
                           )
                    )

            Nothing ->
                text line


isDateHeading : String -> Bool
isDateHeading line =
    if String.startsWith "## " line then
        case String.split " " (String.dropLeft 3 line) of
            date :: _ ->
                isDateString date

            [] ->
                False

    else
        False


isDateString : String -> Bool
isDateString date =
    String.length date == 10
        && isDateChar 0 date
        && isDateChar 1 date
        && isDateChar 2 date
        && isDateChar 3 date
        && String.slice 4 5 date == "-"
        && isDateChar 5 date
        && isDateChar 6 date
        && String.slice 7 8 date == "-"
        && isDateChar 8 date
        && isDateChar 9 date


isDateChar : Int -> String -> Bool
isDateChar index value =
    case String.slice index (index + 1) value |> String.toList of
        char :: _ ->
            Char.isDigit char

        [] ->
            False


parseMarkdownLink : String -> Maybe { label : String, url : String, rest : String }
parseMarkdownLink line =
    if String.startsWith "[" line then
        case String.split "](" line of
            before :: after :: [] ->
                let
                    label =
                        String.dropLeft 1 before

                    urlAndRest =
                        String.split ")" after
                in
                case urlAndRest of
                    url :: restParts ->
                        Just
                            { label = label
                            , url = url
                            , rest = String.join ")" restParts |> String.trim
                            }

                    [] ->
                        Nothing

            _ ->
                Nothing

    else
        Nothing


menuItemRoute : { a | onDropdownToggle : Maybe b -> msg } -> String -> { path : Route.Path.Path, query : Dict.Dict String String, hash : Maybe String } -> String -> String -> Html msg
menuItemRoute props activeName route activeNameExp nameText =
    li [ class "w-full lg:w-auto" ]
        [ a
            [ class "block py-2 text-white hover:bg-black/10 px-2 rounded transition-all duration-200"
            , classList
                [ ( "font-medium", isActiveName activeNameExp activeName ) ]
            , Route.href { path = route.path, query = route.query, hash = route.hash }
            , onClick (props.onDropdownToggle Nothing)
            ]
            [ text nameText ]
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
                props.onCloseDropdownOnly

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
                        [ class "mx-2 my-2 border-t border-[var(--color-border)]"
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
            span [ class "inline-flex items-center gap-2" ]
                (text item.label
                    :: (if item.activeName == "rer-duty-neo" || item.activeName == "rer-analysis-neo" || item.activeName == "importer" then
                            [ span
                                [ class "rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-amber-700" ]
                                [ text
                                    (if item.activeName == "importer" then
                                        "Beta"

                                     else
                                        "Alpha"
                                    )
                                ]
                            ]

                        else
                            []
                       )
                )
    in
    li [ class "group relative w-full lg:w-auto" ]
        [ button
            [ class "inline-flex w-full cursor-pointer items-center rounded px-2 py-2 text-white transition-all duration-200 hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-1 lg:w-auto"
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
        , div [ class "app-navbar-submenu-wrap" ]
            [ ul
                [ id dropdownMenuId
                , class "app-navbar-submenu-list min-w-0 w-full max-w-[min(100vw-2rem,16rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-2 shadow-lg transition-all duration-200 lg:w-64 lg:max-w-none"
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

