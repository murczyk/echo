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
import Process
import Regex
import Route exposing (Route)
import Route.Path
import Shared
import Shared.Model exposing (isDarkMode)
import Task
import Utils.Api.ErrorHandling
import Utils.LoginRedirect
import Utils.Components exposing (fieldError, isInvalidCls)
import Utils.Utils exposing (..)
import View exposing (View)


type Pending2fa
    = Setup
        { challengeId : String
        , qrBase64 : String
        , manualKey : String
        }
    | Verify { challengeId : String }


type alias Model =
    { formErrors : Dict String String
    , toasts : Shared.Components.Toast.Model
    , loginInp : String
    , passwordInp : String
    , totpTokenInp : String
    , pending2fa : Maybe Pending2fa
    , authInFlight : Bool
    , redirect : Maybe String
    , serverInfo : Maybe B.ServerInfo
    , showCredsLogin : Bool
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
      , totpTokenInp = ""
      , pending2fa = Nothing
      , authInFlight = False
      , redirect = Dict.get "redirect" route.query |> Maybe.andThen (Utils.LoginRedirect.normalize route.url)
      , serverInfo = shared.serverInfo
      , showCredsLogin = False
      }
    , E.batch
        ((if isFeatureDeltaEnabled shared.serverInfo then
            E.none

          else
            E.sendCmd <| focusLoginInput
         )
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
    | SetTotpTokenInp String
    | ToggleCredsLogin
    | Login
    | LoginDone (Result ApiError B.LoginRsp)
    | Confirm2fa
    | Confirm2faDone (Result ApiError ())
    | Cancel2fa
    | GotLocation LocationRes
    | GetDeltaRedirectUrl
    | GotDeltaRedirectUrl (Result ApiError B.DeltaLoginUrl)


isFeatureDeltaEnabled : Maybe B.ServerInfo -> Bool
isFeatureDeltaEnabled maybeServerInfo =
    case maybeServerInfo of
        Just info ->
            info.featureDelta

        Nothing ->
            False


focusLoginInput : Cmd Msg
focusLoginInput =
    Task.attempt (\_ -> NoOp) (Browser.Dom.focus "login")


focusTotpInput : Cmd Msg
focusTotpInput =
    Task.attempt (\_ -> NoOp) (Browser.Dom.focus "totp-token")


focusTotpSetupHeading : Cmd Msg
focusTotpSetupHeading =
    Task.attempt (\_ -> NoOp) (Browser.Dom.focus "totp-setup-heading")


pendingFromLoginRsp : B.LoginRsp -> Maybe Pending2fa
pendingFromLoginRsp rsp =
    case rsp of
        B.Authenticated ->
            Nothing

        B.Needs2faSetup payload ->
            Just (Setup payload)

        B.Needs2fa payload ->
            Just (Verify payload)


challengeIdFromPending : Pending2fa -> String
challengeIdFromPending pending =
    case pending of
        Setup { challengeId } ->
            challengeId

        Verify { challengeId } ->
            challengeId


{-| OTP panel only renders `token` errors. Account/organism failures from confirm
arrive as `login` (or other) form keys / 401→login; surface them on `token`.
-}
remapConfirm2faFormErrors : Dict String String -> Dict String String
remapConfirm2faFormErrors errors =
    case Dict.get "token" errors of
        Just _ ->
            errors

        Nothing ->
            case Dict.get "login" errors of
                Just msg ->
                    Dict.insert "token" msg errors

                Nothing ->
                    case Dict.toList errors of
                        ( _, msg ) :: _ ->
                            Dict.insert "token" msg errors

                        [] ->
                            errors


navigateAfterLogin : Model -> Effect Msg
navigateAfterLogin model =
    E.loadExternalUrl (Maybe.withDefault "/" model.redirect)


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

        SetTotpTokenInp s ->
            ( { model | totpTokenInp = s }, E.none )

        ToggleCredsLogin ->
            let
                showCredsLogin =
                    not model.showCredsLogin
            in
            ( { model | showCredsLogin = showCredsLogin }
            , if showCredsLogin then
                E.sendCmd <|
                    (Process.sleep 320
                        |> Task.andThen (\_ -> Browser.Dom.focus "login")
                        |> Task.attempt (\_ -> NoOp)
                    )

              else
                E.none
            )

        Login ->
            if model.authInFlight then
                ( model, E.none )

            else if isFeatureDeltaEnabled shared.serverInfo && not model.showCredsLogin then
                ( model, E.none )

            else
                ( { model | formErrors = Dict.empty, authInFlight = True }
                , E.sendCmd <|
                    Api.users_login LoginDone
                        { user = model.loginInp
                        , password = model.passwordInp
                        }
                )

        LoginDone (Err e) ->
            Api.handleLoginHttpError ToastMsg e { model | authInFlight = False }

        LoginDone (Ok rsp) ->
            case pendingFromLoginRsp rsp of
                Nothing ->
                    ( { model | authInFlight = False }
                    , navigateAfterLogin model
                    )

                Just pending ->
                    ( { model
                        | pending2fa = Just pending
                        , totpTokenInp = ""
                        , formErrors = Dict.empty
                        , authInFlight = False
                      }
                    , E.sendCmd <|
                        case pending of
                            Setup _ ->
                                focusTotpSetupHeading

                            Verify _ ->
                                focusTotpInput
                    )

        Confirm2fa ->
            case ( model.authInFlight, model.pending2fa ) of
                ( True, _ ) ->
                    ( model, E.none )

                ( False, Nothing ) ->
                    ( model, E.none )

                ( False, Just pending ) ->
                    ( { model | formErrors = Dict.empty, authInFlight = True }
                    , E.sendCmd <|
                        Api.users_confirm_2fa Confirm2faDone
                            { challengeId = challengeIdFromPending pending
                            , token = model.totpTokenInp
                            }
                    )

        Confirm2faDone (Err e) ->
            case model.pending2fa of
                Nothing ->
                    ( { model | authInFlight = False }, E.none )

                Just _ ->
                    let
                        ( modelWithError, effect ) =
                            Api.handleLoginHttpError ToastMsg e { model | authInFlight = False }
                    in
                    ( { modelWithError
                        | formErrors =
                            remapConfirm2faFormErrors modelWithError.formErrors
                      }
                    , effect
                    )

        Confirm2faDone (Ok ()) ->
            ( { model | authInFlight = False }
            , navigateAfterLogin model
            )

        Cancel2fa ->
            ( { model
                | pending2fa = Nothing
                , totpTokenInp = ""
                , formErrors = Dict.empty
                , authInFlight = False
              }
            , E.sendCmd focusLoginInput
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
            ( model, E.sendCmd <| Api.get_delta_redirect_url GotDeltaRedirectUrl model.redirect )

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


loginBrand : Bool -> Html Msg
loginBrand isDark =
    div [ class "login-brand logo-coin-trigger" ]
        [ node "echo-logo-coin"
            [ class "logo-coin logo-coin--auto" ]
            [ div
                [ class "logo-coin__idle" ]
                [ div
                    [ class "logo-coin__disc" ]
                    [ div
                        [ class "main-image logo-coin__face logo-coin__face--front" ]
                        [ img
                            [ src "/img/login-echo-mark.svg"
                            , alt "Echo"
                            ]
                            []
                        ]
                    , div
                        [ class "hover-image logo-coin__face logo-coin__face--back" ]
                        [ img
                            [ src "/img/riskdept.svg"
                            , alt "Risk Department"
                            ]
                            []
                        ]
                    ]
                ]
            ]
        , img
            [ src "/img/login-echo-wordmark.svg"
            , class "login-wordmark"
            , alt "ECHO"
            ]
            []
        ]


loginAttribution : Bool -> Html Msg
loginAttribution isDark =
    div [ class "login-attribution" ]
        [ img
            [ src
                (if isDark then
                    "/img/login-attribution-dark.svg"

                 else
                    "/img/login-attribution-light.svg"
                )
            , alt ""
            ]
            []
        , div [ class "login-attribution__copy" ]
            [ span [] [ text "Проєкт розробляється і підтримується" ]
            , span [] [ text "Департаментом Активних Дій" ]
            , span [] [ text "ГУР МО" ]
            ]
        ]


totpPanel : Model -> Pending2fa -> List (Html Msg)
totpPanel model pending =
    let
        panelClass =
            case pending of
                Setup _ ->
                    "login-panel--2fa-setup"

                Verify _ ->
                    "login-panel--2fa-verify"

        setupBits =
            case pending of
                Setup { qrBase64, manualKey } ->
                    [ div [ class "login-2fa-copy" ]
                        [ h2 [ id "totp-setup-heading", attribute "tabindex" "-1", class "login-heading" ]
                            [ text "Налаштуйте двофакторну автентифікацію" ]
                        , ol [ class "login-2fa-steps" ]
                            [ li [] [ text "Встановіть на телефон застосунок-автентифікатор з офіційного магазину, наприклад Microsoft Authenticator, Google Authenticator, Authy або Duo Mobile." ]
                            , li [] [ text "У застосунку виберіть додавання облікового запису та відскануйте QR-код." ]
                            , li [] [ text "Введіть нижче 6-значний код, який з’явиться в застосунку." ]
                            ]
                        ]
                    , div [ class "login-qr-wrap" ]
                        [ img
                            [ src ("data:image/png;base64," ++ qrBase64)
                            , alt "QR-код для налаштування двофакторної автентифікації"
                            , class "login-qr"
                            ]
                            []
                        ]
                    , div [ class "login-helper-text" ]
                        [ text "Не вдається відсканувати QR-код? Введіть цей ключ вручну:" ]
                    , div
                        [ class "login-manual-key" ]
                        [ text manualKey ]
                    , div [ class "login-helper-text login-helper-text--warning" ]
                        [ text "Не надсилайте QR-код або ключ іншим людям." ]
                    ]

                Verify _ ->
                    [ div [ class "login-2fa-copy" ]
                        [ h2 [ class "login-heading" ] [ text "Підтвердіть вхід" ]
                        , p [ class "login-description" ] [ text "Введіть 6-значний код із застосунку-автентифікатора." ]
                        ]
                    ]
    in
    [ div [ class ("login-panel login-panel--2fa " ++ panelClass) ]
        (setupBits
            ++ [ div [ class "login-field" ]
                    ([ label [ for "totp-token", class "login-label" ] [ text "6-значний код" ]
                     , input
                        [ type_ "text"
                        , class "form-control login-input"
                        , id "totp-token"
                        , placeholder "000000"
                        , value model.totpTokenInp
                        , onInput SetTotpTokenInp
                        , disabled model.authInFlight
                        , attribute "autocomplete" "one-time-code"
                        , attribute "inputmode" "numeric"
                        , isInvalidCls "token" model.formErrors
                        ]
                        []
                     ]
                        ++ fieldError "token" model.formErrors
                    )
               , div [ class "login-submit" ]
                    [ button
                        [ type_ "submit"
                        , class "login-primary-action"
                        , disabled model.authInFlight
                        ]
                        [ text "підтвердити" ]
                    ]
               , div [ class "login-back-action" ]
                    [ button
                        [ type_ "button"
                        , class "login-secondary-action"
                        , onClick Cancel2fa
                        , disabled model.authInFlight
                        ]
                        [ text "назад" ]
                    ]
               ]
        )
    ]


body : Bool -> Bool -> Shared.Components.Toast.Model -> Model -> List (Html Msg)
body isDark deltaLoginFlag sharedToasts model =
    let
        isTotpSetup =
            case model.pending2fa of
                Just (Setup _) ->
                    True

                _ ->
                    False

        credsFields interactive =
            let
                fieldsEnabled =
                    interactive && not model.authInFlight
            in
            [ div [ class "login-field" ] <|
                input
                    [ type_ "text"
                    , class "form-control login-input"
                    , id "login"
                    , placeholder "логін"
                    , value model.loginInp
                    , onInput SetLoginInp
                    , disabled (not fieldsEnabled)
                    , isInvalidCls "login" model.formErrors
                    ]
                    []
                    :: fieldError "login" model.formErrors
            , div [ class "login-field" ] <|
                input
                    [ type_ "password"
                    , class "form-control login-input"
                    , placeholder "пароль"
                    , value model.passwordInp
                    , onInput SetPasswordInp
                    , disabled (not fieldsEnabled)
                    , isInvalidCls "password" model.formErrors
                    ]
                    []
                    :: fieldError "password" model.formErrors
            , div
                [ class "login-submit"
                ]
                [ button
                    [ type_ "submit"
                    , class "login-primary-action"
                    , disabled (not fieldsEnabled)
                    ]
                    [ text "увійти" ]
                ]
            ]

        deltaButton =
            button
                [ type_ "button"
                , class "login-primary-action"
                , onClick GetDeltaRedirectUrl
                ]
                [ img
                    [ src "/img/delta-icon.webp"
                    , alt ""
                    ]
                    []
                , span [] [ text "увійти з delta" ]
                ]

        credsOpenLink =
            button
                [ type_ "button"
                , class "login-secondary-action"
                , onClick ToggleCredsLogin
                ]
                [ text "або увійти з логіном" ]

        deltaFormChildren =
            [ div [ class "login-action-slot" ] [ deltaButton ]
            , div
                [ classList
                    [ ( "login-creds-link-wrap", True )
                    , ( "is-hidden", model.showCredsLogin )
                    ]
                ]
                [ div [ class "login-creds-link-wrap__inner w-100 text-center" ]
                    [ credsOpenLink ]
                ]
            , div
                ([ classList
                    [ ( "login-creds-panel", True )
                    , ( "login-panel", True )
                    , ( "login-panel--credentials", True )
                    , ( "is-open", model.showCredsLogin )
                    ]
                 ]
                    ++ (if model.showCredsLogin then
                            []

                        else
                            [ attribute "inert" "" ]
                       )
                )
                [ div
                    [ class "login-creds-panel__inner" ]
                    (credsFields model.showCredsLogin)
                ]
            ]

        formChildren =
            case model.pending2fa of
                Just pending ->
                    totpPanel model pending

                Nothing ->
                    if deltaLoginFlag then
                        deltaFormChildren

                    else
                        credsFields True

        formSubmitMsg =
            case model.pending2fa of
                Just _ ->
                    Confirm2fa

                Nothing ->
                    Login
    in
    [ Shared.Components.Toast.overlay SharedToastMsg sharedToasts
    , Shared.Components.Toast.view ToastMsg model.toasts <|
        div
            [ class "login-page"
            , attribute "data-login-theme"
                (if isDark then
                    "dark"

                 else
                    "light"
                )
            ]
            [ div
                [ classList
                    [ ( "login-main", True )
                    , ( "login-main--expanded", isTotpSetup )
                    ]
                ]
                [ Html.form
                    [ classList
                        [ ( "login-form", True )
                        , ( "login-form--setup", isTotpSetup )
                        ]
                    , onSubmit formSubmitMsg
                    ]
                    [ loginBrand isDark
                    , div [ class "login-actions" ] formChildren
                    ]
                ]
            , loginAttribution isDark
            ]
    ]


view : Shared.Model -> Model -> View Msg
view shared model =
    let
        featureDelta =
            isFeatureDeltaEnabled shared.serverInfo
    in
    { title = "логін"
    , body = body (isDarkMode shared.themeMode) featureDelta shared.toasts model
    }
