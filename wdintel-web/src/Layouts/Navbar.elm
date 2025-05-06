module Layouts.Navbar exposing (Model, Msg, Props, layout)

import Auth
import Components.Navbar exposing (navBar)
import Components.ThemeSwitcher exposing (colorThemeSwitcher)
import Effect as E exposing (Effect)
import Html exposing (..)
import Layout exposing (Layout)
import Route exposing (Route)
import Shared
import View exposing (View)
import Task
import Process 
import Le.Types exposing (ApiError)


type alias Props =
    { user : Auth.User
    , activeName : String
    }


layout : Props -> Shared.Model -> Route () -> Layout () Model Msg contentMsg
layout props shared route =
    Layout.new
        { init = init
        , update = update route
        , view = view props.user props.activeName shared
        , subscriptions = subscriptions
        }



-- MODEL


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init _ =
    ( {}
    , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep keepAliveInterval)
    )

keepAliveInterval: number
keepAliveInterval = 30000 

-- UPDATE


type Msg
    = ToggleDarkTheme
    | Slept
    | KeepAliveDone (Result ApiError ())


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update route  msg model =
    case msg of
        ToggleDarkTheme ->
            ( model
            , E.toggleDarkMode
            )

        Slept ->
            ( model
            , E.batch
                [ E.keepAlive KeepAliveDone {pageId =  Just (String.dropLeft 1 route.url.path)}
                , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep keepAliveInterval)
                ]
            )
        KeepAliveDone (Err e) ->
            (model, E.none)
        KeepAliveDone (Ok _) ->
            (model, E.none)


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Auth.User -> String -> Shared.Model -> { toContentMsg : Msg -> contentMsg, content : View contentMsg, model : Model } -> View contentMsg
view user activeName shared { toContentMsg, model, content } =
    { title = content.title
    , body =
        [ div []
            [ colorThemeSwitcher ToggleDarkTheme shared.isDarkMode
            , navBar user shared activeName
            ]
            |> Html.map toContentMsg
        , div [] content.body
        ]
    }
