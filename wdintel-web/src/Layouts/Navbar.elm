module Layouts.Navbar exposing (Model, Msg, Props, layout)

import Auth
import Browser.Events
import Core.Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (attribute, class, id, property, title)
import Html.Events exposing (onClick, stopPropagationOn, on)
import Json.Decode
import Json.Encode as Encode
import Layout exposing (Layout)
import Process
import Route exposing (Route)
import Shared
import Shared.Msg
import Shared.Components.Toast as Toast
import Shared.Model
import Task
import View exposing (View)


type alias Props =
    { user : Auth.User
    , activeName : String
    }


layout : Props -> Shared.Model -> Route () -> Layout () Model Msg contentMsg
layout props shared route =
    Layout.new
        { init = init
        , update = update route
        , view = view props.user props.activeName shared route
        , subscriptions = subscriptions
        }



-- MODEL


type alias Model =
    { isNavbarVisible : Bool
    , openDropdown : Maybe String
    , mobileNavOpen : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { isNavbarVisible = True
      , openDropdown = Nothing
      , mobileNavOpen = False
      }
    , E.batch
        [ E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep keepAliveInterval)
        ]
    )


keepAliveInterval : number
keepAliveInterval =
    30000



-- UPDATE


type Msg
    = ToggleDarkTheme
    | SignOutClicked
    | SetThemeMode Shared.Model.ThemeMode
    | KeyPressed String
    | NoOp
    | Slept
    | KeepAliveDone (Result ApiError ())
    | ToggleNavbarVisibility
    | ToggleMobileNav
    | SetOpenDropdown (Maybe String)
    | ChangelogSeen String
    | OpenChangelog String
    | CloseDropdownOnly
    | ToastMsg Toast.Msg


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update route msg model =
    case msg of
        ToggleDarkTheme ->
            ( model
            , E.toggleDarkMode
            )

        SignOutClicked ->
            ( model
            , E.logout
            )

        SetThemeMode themeMode ->
            ( model
            , E.setThemeMode themeMode
            )

        KeyPressed key ->
            if key == "Escape" then
                ( { model | openDropdown = Nothing, mobileNavOpen = False }, E.none )

            else
                ( model, E.none )

        NoOp ->
            ( model, E.none )

        Slept ->
            ( model
            , E.batch
                [ E.keepAlive KeepAliveDone { pageId = Just (String.dropLeft 1 route.url.path) }
                , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep keepAliveInterval)
                ]
            )

        KeepAliveDone (Err _) ->
            ( model, E.none )

        KeepAliveDone (Ok _) ->
            ( model, E.none )

        ToggleNavbarVisibility ->
            ( { model
                | isNavbarVisible = not model.isNavbarVisible
                , openDropdown = Nothing
                , mobileNavOpen = False
              }
            , E.triggerResize
            )

        ToggleMobileNav ->
            ( { model
                | mobileNavOpen = not model.mobileNavOpen
                , openDropdown = Nothing
              }
            , E.none
            )

        SetOpenDropdown selection ->
            ( { model
                | openDropdown = selection
                , mobileNavOpen =
                    case selection of
                        Nothing ->
                            False

                        Just _ ->
                            model.mobileNavOpen
              }
            , E.none
            )

        CloseDropdownOnly ->
            ( { model | openDropdown = Nothing }, E.none )

        ChangelogSeen version ->
            ( model
            , E.sendSharedMsg (Shared.Msg.SaveChangelogLastSeen version)
            )

        OpenChangelog version ->
            ( { model | openDropdown = Just "changelog" }
            , E.sendSharedMsg (Shared.Msg.SaveChangelogLastSeen version)
            )

        ToastMsg toastMsg ->
            ( model, E.sendToastMsg toastMsg )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Browser.Events.onKeyDown <|
        Json.Decode.andThen
            (\key ->
                if key == "Escape" then
                    Json.Decode.succeed (KeyPressed key)

                else
                    Json.Decode.fail "Ignore non-Escape keys"
            )
            (Json.Decode.field "key" Json.Decode.string)



-- VIEW


view : Auth.User -> String -> Shared.Model -> Route () -> { toContentMsg : Msg -> contentMsg, content : View contentMsg, model : Model } -> View contentMsg
view user activeName shared route { toContentMsg, model, content } =
    let
        supportsFullscreenToggle =
            route.url.path == "/rer-duty" || route.url.path == "/rer-duty-neo"

        isDevicesPath =
            route.url.path == "/devices" || String.startsWith "/devices/" route.url.path

        isDevicesListPath =
            route.url.path == "/devices"

        usesShellContentGap =
            route.url.path
                == "/rer-palitra-neo"
                || route.url.path
                == "/rer-callsigns-neo"
                || route.url.path == "/rer-networks-neo"
                || isDevicesListPath

        usesFixedViewportLayout =
            usesShellContentGap
                || supportsFullscreenToggle
                || route.url.path
                == "/rer-analysis-neo"

        navbarPropsJson =
            Encode.object
                [ ( "user"
                  , Encode.object
                        [ ( "name", Encode.string user.name )
                        , ( "roles", Encode.list Encode.string user.roles )
                        , ( "goiFullAccessForOrganism", Encode.bool user.goiFullAccessForOrganism )
                        , ( "goiIntegrations"
                          , Encode.list
                                (\integration ->
                                    Encode.object
                                        [ ( "id", Encode.int integration.id )
                                        , ( "ownerOrganismName", Encode.string integration.ownerOrganismName )
                                        , ( "goiUrl"
                                          , case integration.goiUrl of
                                                Just url -> Encode.string url
                                                Nothing -> Encode.null
                                          )
                                        ]
                                )
                                user.goiIntegrations
                          )
                        ]
                  )
                , ( "shared",
                        Encode.object
                            [ ( "serverInfo"
                              , case shared.serverInfo of
                                    Just info -> Encode.object [ ( "mode", Encode.string info.mode ) ]
                                    Nothing -> Encode.null
                              )
                            , ( "themeMode", Encode.string (Shared.Model.themeModeToString shared.themeMode) )
                            , ( "changelogPreview"
                              , case shared.changelogPreview of
                                    Just preview ->
                                        Encode.object
                                            [ ( "version", Encode.string preview.version )
                                            , ( "preview", Encode.list Encode.string preview.preview )
                                            , ( "fullUrl", Encode.string preview.fullUrl )
                                            ]
                                    Nothing ->
                                        Encode.null
                              )
                            , ( "userLoaded", Encode.bool shared.userLoaded )
                            , ( "changelogLastSeenLoaded", Encode.bool shared.changelogLastSeenLoaded )
                            , ( "changelogLastSeen"
                              , case shared.changelogLastSeen of
                                    Just ls -> Encode.string ls
                                    Nothing -> Encode.null
                              )
                            , ( "systemSettings"
                              , case shared.systemSettings of
                                    Just settings ->
                                        Encode.object
                                            [ ( "defaultNeoAnalysis", Encode.bool settings.defaultNeoAnalysis )
                                            , ( "enableAudioTranscription", Encode.bool settings.enableAudioTranscription )
                                            , ( "showClassicDuty", Encode.bool settings.showClassicDuty )
                                            , ( "showClassicAnalysis", Encode.bool settings.showClassicAnalysis )
                                            , ( "supportNonRerInterceptions", Encode.bool settings.supportNonRerInterceptions )
                                            , ( "devicesSectionEnabled", Encode.bool settings.devicesSectionEnabled )
                                            ]
                                    Nothing ->
                                        Encode.null
                              )
                            ]
                  )
                , ( "activeName", Encode.string activeName )
                , ( "isNavbarVisible", Encode.bool model.isNavbarVisible )
                , ( "supportsFullscreenToggle", Encode.bool supportsFullscreenToggle )
                ]

        navbarHtml =
            node "app-navbar"
                [ property "props" navbarPropsJson
                , on "navbar-logout" (Json.Decode.succeed SignOutClicked)
                , on "navbar-theme-toggle" (Json.Decode.map (\t -> SetThemeMode (Shared.Model.themeModeFromString t)) (Json.Decode.at [ "detail" ] Json.Decode.string))
                , on "navbar-visibility-toggle" (Json.Decode.succeed ToggleNavbarVisibility)
                , on "navbar-open-changelog" (Json.Decode.map OpenChangelog (Json.Decode.at [ "detail" ] Json.Decode.string))
                ]
                []
    in
    { title = content.title
    , body =
        [ div [ onClick (SetOpenDropdown Nothing) ]
            [ div
                [ id "app-navbar-shell"
                , class "fixed top-0 left-0 right-0 z-[1200] transition-all duration-300 ease-in-out"
                , class
                    (if model.isNavbarVisible then
                        "translate-y-0"

                     else
                        "-translate-y-full"
                    )
                , stopPropagationOn "click" (Json.Decode.succeed ( NoOp, True ))
                ]
                [ navbarHtml ]
            , if supportsFullscreenToggle && not model.isNavbarVisible then
                div
                    [ class "fixed top-4 right-4 z-[1200] transition-opacity duration-300 ease-in-out opacity-100" ]
                    [ div
                        [ class "cursor-pointer p-2 rounded-full bg-[var(--color-card)] hover:bg-[var(--color-column)] transition-all duration-200"
                        , onClick ToggleNavbarVisibility
                        , title "Звичайний режим"
                        , attribute "aria-label" "Звичайний режим"
                        , attribute "aria-pressed" "true"
                        ]
                        [ i [ class "bi bi-arrows-fullscreen text-xl" ] [] ]
                    ]

              else
                div [] []
            , Toast.overlay ToastMsg shared.toasts
            ]
            |> Html.map toContentMsg
        , div
            ([ class "app-shell"
             , class
                (if model.isNavbarVisible then
                    "app-shell--navbar-visible"

                 else
                    "app-shell--navbar-hidden"
                )
             , class
                (if usesFixedViewportLayout then
                    "app-shell--fixed-viewport"

                 else
                    ""
                )
             , onClick (toContentMsg (SetOpenDropdown Nothing))
             , attribute "data-auth-user-name" user.name
             ]
                ++ (if route.url.path == "/rer-duty-neo" || route.url.path == "/rer-callsigns-neo" || isDevicesPath then
                        [ attribute "data-auth-user-roles" (String.join "," user.roles) ]

                    else
                        []
                   )
                ++ (if usesShellContentGap then
                        [ class "app-shell--with-content-gap" ]

                    else
                        []
                   )
            )
            content.body
        ]
    }
