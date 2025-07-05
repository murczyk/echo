module Components.Navbar exposing (navBar)

import Auth
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Le.Auth exposing (hasRole, serverModeIs)
import Le.Utils exposing (..)
import Route
import Route.Path
import Shared


type Link
    = Internal Route.Path.Path
    | External String


type alias Menu =
    { link : Link
    , activeName : String
    , label : String
    }


navBar : Auth.User -> Shared.Model -> String -> Html msg
navBar user shared activeName =
    let
        menu =
            menuItem activeName

        menuWithSubs =
            menuItemWithSubs activeName

        adminSubs =
            [ Menu (Internal Route.Path.Admin) "zones" "напрямки"
            , Menu (Internal Route.Path.Admin_Users) "users" "користувачі"
            , Menu (Internal Route.Path.Admin_Organisms) "organisms" "організми"
            ]

        etalonkaSubs =
            [ Menu (Internal Route.Path.RerFreqs) "freqs" "частоти"
            , Menu (Internal Route.Path.RerCallsigns) "callsigns" "позивні"
            , Menu (Internal Route.Path.RerUnits) "rer-units" "підрозділи"
            , Menu (Internal Route.Path.RerSignals) "signals" "сигнали"
            , Menu (Internal Route.Path.RerNetworks) "networks" "мережі"
            ]

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
    in
    header
        [ class "navbar navbar-expand-lg navbar-dark bd-navbar"
        ]
        [ nav [ class "container-xxl bd-gutter flex-wrap flex-lg-nowrap" ]
            [ div [ class "d-lg-none" ] []
            , a
                [ class "navbar-brand p-0 me-0 me-lg-2"
                , class "logo-animated d-flex align-items-center justify-content-center"
                , href "/"
                , style "position" "relative"
                ]
                [ div
                    [ class "d-flex align-items-center justify-content-center"
                    , style "width" "34px"
                    , style "height" "28px"
                    ]
                    [ div
                        [ class "main-image"
                        , style "height" "28px"
                        , style "width" "28px"
                        ]
                        [ img
                            [ src "/img/SIGINT_190_kraken_transparent.png"
                            , style "width" "28px"
                            , style "height" "28px"
                            , alt "SIGINT 190 Kraken"
                            ]
                            []
                        ]
                    , div
                        [ class "hover-image"
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
                    [ src "/img/echo-logo-white.svg"
                    , class "h-[16px]"
                    ]
                    []
                ]
            , div [ class "d-flex" ]
                [ button
                    [ class "navbar-toggler d-flex d-lg-none order-3 p-2"
                    , type_ "button"
                    , attribute "data-bs-toggle" "offcanvas"
                    , attribute "data-bs-target" "#bdNavbar"
                    , attribute "aria-controls" "bdNavbar"
                    , attribute "aria-label" "Toggle navigation"
                    ]
                    [ i [ class "bi bi-three-dots" ] []
                    ]
                ]
            , div
                [ id "bdNavbar"
                , class "offcanvas-lg offcanvas-end flex-grow-1"
                , attribute "tabindex" "-1"
                , attribute "aria-labelledby" "bdNavbarOffcanvasLabel"
                , attribute "data-bs-scroll" "true"
                ]
                [ div [ class "offcanvas-header px-4 pb-0" ]
                    [ h5 [ id "bdNavbarOffcanvasLabel", class "offcanvas-title text-white" ]
                        [ text "🦆" ]
                    , button
                        [ class "btn-close btn-close-white"
                        , type_ "button"
                        , attribute "data-bs-dismiss" "offcanvas"
                        , attribute "aria-label" "close"
                        , attribute "data-bs-target" "#bdNavbar"
                        ]
                        []
                    ]
                , div [ class "offcanvas-body p-4 pt-0 p-lg-0" ]
                    [ hr [ class "d-lg-none text-white-50" ] []
                    , ul [ class "navbar-nav flex-row flex-wrap bd-navbar-nav" ] menuItems
                    ]
                ]
            ]
        ]


menuItem activeName hrefLink activeNameExp nameText =
    li [ class "nav-item col-6 col-lg-auto" ]
        [ a
            [ class "nav-link py-2 px-0 px-lg-2"
            , Route.Path.href hrefLink
            , classList [ ( "active", activeName == activeNameExp ) ]
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
                            [ class "dropdown-item"
                            , classList [ ( "active", sub.activeName == activeName ) ]
                            , Route.Path.href path
                            ]
                            [ text sub.label ]

                    External link ->
                        a
                            [ class "dropdown-item"
                            , classList [ ( "active", sub.activeName == activeName ) ]
                            , href link
                            , target "_blank"
                            ]
                            [ text <| sub.label ++ " "
                            , sup []
                                [ i
                                    [ class "bi bi-box-arrow-up-right"
                                    ]
                                    []
                                ]
                            ]
                ]
    in
    li [ class "nav-item dropdown col-6 col-lg-auto" ]
        [ button
            [ class "nav-link dropdown-toggle py-2 px-0 px-lg-2"
            , attribute "data-bs-toggle" "dropdown"
            , attribute "aria-expanded" "false"
            , classList [ ( "active", activeName == activeNameExp ) ]
            ]
            [ text nameText ]
        , ul [ class "dropdown-menu" ]
            (List.map dropdownItem subs)
        ]
