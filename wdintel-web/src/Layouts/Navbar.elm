module Layouts.Navbar exposing (Model, Msg, Props, layout)

import Auth
import Components.Navbar
import Components.NavbarOld
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (class, classList)
import Html.Events exposing (onClick)
import Layout exposing (Layout)
import Le.Block.Toast as Toast
import Le.Types exposing (ApiError)
import Process
import Route exposing (Route)
import Shared
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
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { isNavbarVisible = True
      }
    , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep keepAliveInterval)
    )


keepAliveInterval : number
keepAliveInterval =
    30000



-- UPDATE


type Msg
    = ToggleDarkTheme
    | Slept
    | KeepAliveDone (Result ApiError ())
    | ToggleNavbarVisibility
    | ToastMsg Toast.Msg


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update route msg model =
    case msg of
        ToggleDarkTheme ->
            ( model
            , E.toggleDarkMode
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
            ( { model | isNavbarVisible = not model.isNavbarVisible }, E.triggerResize )

        ToastMsg toastMsg ->
            ( model, E.sendToastMsg toastMsg )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Auth.User -> String -> Shared.Model -> Route () -> { toContentMsg : Msg -> contentMsg, content : View contentMsg, model : Model } -> View contentMsg
view user activeName shared route { toContentMsg, model, content } =
    let
        navbarComponent =
            if shared.featureNavbarFrontOnly then
                Components.Navbar.navBar
            else
                Components.NavbarOld.navBar
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
                [ navbarComponent user shared activeName { onToggleTheme = ToggleDarkTheme, onNavbarVisibilityChange = ToggleNavbarVisibility, isRerDuty = route.url.path == "/rer-duty" } ]
            , if route.url.path == "/rer-duty" && not model.isNavbarVisible then
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
