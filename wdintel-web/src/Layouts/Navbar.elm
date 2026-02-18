module Layouts.Navbar exposing (Model, Msg, Props, layout)

import Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (class, classList)
import Html.Events exposing (onClick)
import Layout exposing (Layout)
import Process
import Route exposing (Route)
import Shared
import Shared.Components.Navbar
import Shared.Components.NavbarOld
import Shared.Components.Toast as Toast
import Shared.Model exposing (ThemeMode(..))
import Shared.Msg
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
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { isNavbarVisible = True
      , openDropdown = Nothing
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
    | SetThemeMode Shared.Model.ThemeMode
    | Slept
    | KeepAliveDone (Result ApiError ())
    | ToggleNavbarVisibility
    | SetOpenDropdown (Maybe String)
    | ToastMsg Toast.Msg


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update route msg model =
    case msg of
        ToggleDarkTheme ->
            ( model
            , E.toggleDarkMode
            )

        SetThemeMode themeMode ->
            ( model
            , E.setThemeMode themeMode
            )

        Slept ->
            ( model
            , E.batch
                [ E.keepAlive KeepAliveDone { pageId = Just (String.dropLeft 1 route.url.path) }
                , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep keepAliveInterval)
                ]
            )

        KeepAliveDone (Err e) ->
            ( model, E.none )

        KeepAliveDone (Ok _) ->
            ( model, E.none )

        ToggleNavbarVisibility ->
            ( { model
                | isNavbarVisible = not model.isNavbarVisible
                , openDropdown = Nothing
              }
            , E.triggerResize
            )

        SetOpenDropdown selection ->
            ( { model | openDropdown = selection }, E.none )

        ToastMsg toastMsg ->
            ( model, E.sendToastMsg toastMsg )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Auth.User -> String -> Shared.Model -> Route () -> { toContentMsg : Msg -> contentMsg, content : View contentMsg, model : Model } -> View contentMsg
view user activeName shared route { toContentMsg, model, content } =
    let
        navbarProps =
            { onToggleTheme = ToggleDarkTheme
            , onThemeChange = SetThemeMode
            , onNavbarVisibilityChange = ToggleNavbarVisibility
            , isRerDuty = route.url.path == "/rer-duty" || route.url.path == "/rer-duty-neo"
            , openDropdown = model.openDropdown
            , onDropdownToggle = SetOpenDropdown
            }

        navbarHtml =
            if shared.featureNavbarFrontOnly then
                Shared.Components.Navbar.navBar user shared activeName navbarProps

            else
                Shared.Components.NavbarOld.navBar user shared activeName navbarProps
    in
    { title = content.title
    , body =
        [ div []
            [ div
                [ class "fixed top-0 left-0 right-0 z-500 transition-all duration-300 ease-in-out"
                , class
                    (if model.isNavbarVisible then
                        "translate-y-0"

                     else
                        "-translate-y-full"
                    )
                ]
                [ navbarHtml ]
            , if (route.url.path == "/rer-duty" || route.url.path == "/rer-duty-neo") && not model.isNavbarVisible then
                div
                    [ class "fixed top-4 right-4 z-500 transition-opacity duration-300 ease-in-out opacity-100" ]
                    [ div
                        [ class "cursor-pointer p-2 rounded-full bg-[var(--color-card)] hover:bg-[var(--color-column)] transition-all duration-200"
                        , onClick ToggleNavbarVisibility
                        ]
                        [ i [ class "bi bi-arrows-fullscreen text-xl" ] [] ]
                    ]

              else
                div [] []
            , Toast.overlay ToastMsg shared.toasts
            ]
            |> Html.map toContentMsg
        , div
            [ class "transition-all duration-300 ease-in-out"
            , class
                (if model.isNavbarVisible then
                    "pt-[50px] min-h-[calc(100vh-50px)]"

                 else
                    "pt-0 min-h-screen"
                )
            ]
            content.body
        ]
    }
