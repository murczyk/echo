module Pages.Login exposing (Model, Msg, page)

import Api
import Bindings as B
import Browser.Dom
import Browser.Navigation
import Shared.Components.Toast
import Core.Types exposing (..)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Maybe
import Page exposing (Page)
import Regex
import Route exposing (Route)
import Route.Path
import Shared
import Shared.Model exposing (isDarkMode)
import Task
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.Components exposing (fieldError, isInvalidCls)
import Utils.Utils exposing (..)
import View exposing (View)


type alias Model =
    { formErrors : Dict String String
    , toasts : Shared.Components.Toast.Model
    , loginInp : String
    , passwordInp : String
    , redirect : Maybe String
    , serverInfo : Maybe B.ServerInfo
    }


init :
    Route ()
    -> Shared.Model
    -> ()
    -> ( Model, Effect Msg )
init route shared _ =
    let
        mDeltaRedirectError =
            Dict.get "api_error" route.query
                |> Maybe.map
                    (\deltaError ->
                        case deltaError of
                            "err_delta_login_7639" ->
                                "Ваш обліковий запис в ЕХО не знайдено. Будь ласка, зверніться до адміністратора."

                            "err_delta_login_3278" ->
                                "Ваш обліковий запис в ЕХО було призупинено через неактивність. Будь ласка, зверніться до адміністратора"

                            "err_delta_login_4536" ->
                                "Помилка на стороні Delta. Будь ласка, зверніться до адміністратора."

                            _ ->
                                "Щось пішло не так. Будь ласка, зверніться до адміністратора."
                    )
    in
    ( { formErrors = Dict.empty
      , toasts = Shared.Components.Toast.init
      , loginInp = ""
      , passwordInp = ""
      , redirect = Dict.get "redirect" route.query
      , serverInfo = shared.serverInfo
      }
    , E.batch
        ((E.sendCmd <| focusLoginInput)
            :: (case mDeltaRedirectError of
                    Just deltaError ->
                        [ E.sendCmd <| Shared.Components.Toast.addError ToastMsg deltaError
                        , E.replaceRoute { path = Route.Path.Login, hash = Nothing, query = Dict.remove "api_error" route.query }
                        ]

                    Nothing ->
                        [ E.none ]
               )
        )
    )


type Msg
    = NoOp
    | ToastMsg Shared.Components.Toast.Msg
    | SharedToastMsg Shared.Components.Toast.Msg
    | SetLoginInp String
    | SetPasswordInp String
    | Login
    | LoginDone (Result ApiError ())
    | GotLocation LocationRes
    | GetDeltaRedirectUrl
    | GotDeltaRedirectUrl (Result ApiError B.DeltaLoginUrl)


focusLoginInput : Cmd Msg
focusLoginInput =
    Task.attempt (\_ -> NoOp) (Browser.Dom.focus "login")


page : Shared.Model -> Route () -> Page Model Msg
page shared req =
    Page.new
        { init = init req shared
        , update = update shared
        , view = view shared
        , subscriptions = subscriptions
        }


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Shared.Components.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        SharedToastMsg toastMsg ->
            ( model, E.sendToastMsg toastMsg )

        SetLoginInp s ->
            ( { model | loginInp = s }, E.none )

        SetPasswordInp s ->
            ( { model | passwordInp = s }, E.none )

        Login ->
            ( model
            , E.sendCmd <|
                Api.users_login LoginDone
                    { user = model.loginInp
                    , password = model.passwordInp
                    }
            )

        LoginDone (Err e) ->
            Api.handleLoginHttpError ToastMsg e model

        LoginDone (Ok ()) ->
            case shared.location of
                Nothing ->
                    ( model, E.none )

                Just loc ->
                    ( model
                    , E.sendCmd <|
                        Browser.Navigation.load
                            (model.redirect
                                |> mmap
                                    (\x ->
                                        if
                                            String.contains "localhost" x
                                                || String.contains "127.0.0.1" x
                                        then
                                            x

                                        else
                                            String.replace "http://" "https://" x
                                    )
                                |> def
                                    (loc.origin
                                        ++ Url.Builder.absolute [] []
                                    )
                            )
                    )

        GotLocation loc ->
            let
                isIpAddress : String -> Bool
                isIpAddress hostname =
                    let
                        ipPattern =
                            "^(1\\d{2}|[1-9]?\\d)(\\.(1\\d{2}|[1-9]?\\d)){3}$"

                        mRegex =
                            Regex.fromString ipPattern
                    in
                    case mRegex of
                        Just regex ->
                            String.contains "." hostname && Regex.contains regex hostname

                        Nothing ->
                            False

                cmd =
                    if
                        String.contains "localhost" loc.hostname
                            || String.contains "127.0.0.1" loc.hostname
                    then
                        Cmd.none

                    else if loc.protocol == "http:" then
                        Browser.Navigation.load
                            ("https://"
                                ++ loc.host
                                ++ loc.pathname
                                ++ loc.search
                                ++ loc.hash
                            )

                    else if isIpAddress loc.hostname then
                        Shared.Components.Toast.addWarning ToastMsg ("Ви використовуєте ЕХО через IP-адресу: " ++ loc.hostname ++ ". Відділ безпеки Дельти може звернутись щодо підтвердження користування ЕХО.")

                    else
                        Cmd.none
            in
            ( model
            , E.sendCmd <| cmd
            )

        GetDeltaRedirectUrl ->
            ( model, E.sendCmd <| Api.get_delta_redirect_url GotDeltaRedirectUrl )

        GotDeltaRedirectUrl (Ok url) ->
            ( model
            , E.sendCmd <|
                case url.url of
                    Just url_ ->
                        Browser.Navigation.load url_

                    Nothing ->
                        Cmd.none
            )

        GotDeltaRedirectUrl (Err e) ->
            ( { model | formErrors = Dict.empty }
            , E.batch
                [ Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails
                    "Сталася помилка. Спробуйте ще раз або зверніться до адміністратора"
                    e
                ]
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


body : Bool -> Bool -> Shared.Components.Toast.Model -> Model -> List (Html Msg)
body _ deltaLoginFlag sharedToasts model =
    [ Shared.Components.Toast.overlay SharedToastMsg sharedToasts
    , Shared.Components.Toast.view ToastMsg model.toasts <|
        div
            [ class "d-flex flex-column justify-content-center align-items-center"
            , style "height" "100vh"
            , style "background-image" "linear-gradient(to bottom, rgba(var(--bd-coyote-rgb), 1), var(--bd-oak-barrel)"
            ]
            [ Html.form
                [ class "d-flex flex-column justify-content-center align-items-center"
                , class "border shadow-lg p-4"
                , style "background-image" "linear-gradient(to bottom, rgba(var(--bs-body-bg-rgb), .7), rgba(var(--bs-body-bg-rgb), .9))"
                , onSubmit Login

                -- , style "background-color" "var(--bs-body-bg)"
                ]
                [ div [ class "mb-4 pt-2" ]
                    [ div
                        [ class "logo-animated d-flex justify-content-center align-items-center"
                        , style "gap" "5px"
                        ]
                        [ div
                            [ class "d-flex align-items-center justify-content-center"
                            , style "width" "65px"
                            , style "height" "60px"
                            , style "position" "relative"
                            ]
                            [ div
                                [ class "main-image"
                                , style "width" "60px"
                                , style "height" "60px"
                                ]
                                [ img
                                    [ src "/img/SIGINT_190_kraken_transparent.png"
                                    , style "width" "60px"
                                    , style "height" "60px"
                                    , alt "SIGINT 190 Kraken"
                                    ]
                                    []
                                ]
                            , div
                                [ class "hover-image"
                                , style "width" "60px"
                                , style "height" "60px"
                                , style "background-color" "#000"
                                , style "border-radius" "50%"
                                ]
                                [ img
                                    [ src "/img/flying_skull_logo_transparent.png"
                                    , style "width" "60px"
                                    , style "height" "42px"
                                    , style "z-index" "1"
                                    , alt "Flying Skull"
                                    ]
                                    []
                                ]
                            ]
                        , div []
                            [ img
                                [ src "/img/echo-logo-white.svg"
                                , class "h-[50px]"
                                ]
                                []
                            ]

                        -- , div
                        --     [ class "display-3"
                        --     ]
                        --     [ text "Е Х О"
                        --     ]
                        ]
                    ]
                , div [ class "mb-2 w-[240px]" ] <|
                    input
                        [ type_ "text"
                        , class "form-control"
                        , id "login"
                        , placeholder "логін"
                        , value model.loginInp
                        , onInput SetLoginInp
                        , isInvalidCls "login" model.formErrors
                        ]
                        []
                        :: fieldError "login" model.formErrors
                , div [ class "mb-2 w-[240px]" ] <|
                    input
                        [ type_ "password"
                        , class "form-control"
                        , placeholder "пароль"
                        , value model.passwordInp
                        , onInput SetPasswordInp
                        , isInvalidCls "password" model.formErrors
                        ]
                        []
                        :: fieldError "password" model.formErrors
                , div
                    [ class "mb-2"
                    , style "width" "100%"
                    , class "d-flex justify-content-center"
                    ]
                    [ button
                        [ type_ "submit"
                        , class "btn btn-primary btn-dark"
                        , style "width" "50%"
                        , style "min-width" "160px"
                        ]
                        [ text "увійти" ]
                    ]
                , if deltaLoginFlag then
                    div
                        [ style "border-top" "1px solid var(--bs-border-color)"
                        , style "width" "100%"
                        , class "d-flex justify-content-center"
                        ]
                        [ button
                            [ type_ "button"
                            , class "btn btn-primary btn-dark"
                            , class "text-nowrap"
                            , onClick GetDeltaRedirectUrl
                            , style "min-width" "160px"
                            ]
                            [ img
                                [ src "/img/delta-icon.webp"
                                , class "me-2 inline-block"
                                , style "height" "18px"
                                ]
                                []
                            , span
                                [ style "margin-right" "4px"
                                ]
                                [ text "увійти з delta" ]
                            ]
                        ]

                  else
                    text ""
                ]
            ]
    ]


view : Shared.Model -> Model -> View Msg
view shared model =
    let
        featureDelta =
            case shared.serverInfo of
                Just info ->
                    info.featureDelta

                Nothing ->
                    False
    in
    { title = "логін"
    , body = body (isDarkMode shared.themeMode) featureDelta shared.toasts model
    }
