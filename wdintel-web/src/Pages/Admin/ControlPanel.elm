module Pages.Admin.ControlPanel exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.Spinner
import Shared.Model exposing (isDarkMode)
import Utils.Api.ErrorHandling
import View exposing (View)


type alias RestartEchoForm =
    { restartPostgres : Bool
    , restartOutdatedSources : Bool
    , isRestarting : Bool
    }


type alias Model =
    { restartEchoForm : RestartEchoForm
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { restartEchoForm =
            { restartPostgres = False
            , restartOutdatedSources = False
            , isRestarting = False
            }
      }
    , E.none
    )


type Msg
    = ToggleRestartPostgres Bool
    | ToggleRestartOutdatedSources Bool
    | RestartEcho
    | RestartEchoDone (Result ApiError Bool)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        ToggleRestartPostgres isChecked ->
            let
                restartEchoForm =
                    model.restartEchoForm
            in
            ( { model | restartEchoForm = { restartEchoForm | restartPostgres = isChecked } }
            , E.none
            )

        ToggleRestartOutdatedSources isChecked ->
            let
                restartEchoForm =
                    model.restartEchoForm
            in
            ( { model | restartEchoForm = { restartEchoForm | restartOutdatedSources = isChecked } }
            , E.none
            )

        RestartEcho ->
            let
                restartEchoForm =
                    model.restartEchoForm

                req : B.RestartEchoRequest
                req =
                    { restartPostgres = Just restartEchoForm.restartPostgres
                    , restartOutdatedSources = Just restartEchoForm.restartOutdatedSources
                    }
            in
            ( { model | restartEchoForm = { restartEchoForm | isRestarting = True } }
            , E.sendCmd <| Api.admin_restart_echo RestartEchoDone req
            )

        RestartEchoDone (Ok _) ->
            let
                restartEchoForm =
                    model.restartEchoForm
            in
            ( { model | restartEchoForm = { restartEchoForm | isRestarting = False } }
            , E.none
            )

        RestartEchoDone (Err err) ->
            let
                restartEchoForm =
                    model.restartEchoForm
            in
            ( { model | restartEchoForm = { restartEchoForm | isRestarting = False } }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка перезапуску" err
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


renderControlPanel : Bool -> Model -> Html Msg
renderControlPanel isDark model =
    let
        restartEchoForm =
            model.restartEchoForm

        descriptionClass =
            if isDark then
                "text-gray-300"

            else
                "text-gray-600"
    in
    div [ class "bg-[var(--bs-body-bg)] rounded-lg border p-6 space-y-4" ]
        [ div [ class "space-y-4" ]
            [ h3 [ class "text-lg font-semibold" ] [ text "Натисність щоби перезапустити Ехо Сервер" ]
            , div [ class "space-y-2" ]
                [ Checkbox.new { isChecked = restartEchoForm.restartPostgres, onToggle = ToggleRestartPostgres }
                    |> Checkbox.withContent
                        [ span [ class descriptionClass ] [ text "Перезапустити PostgreSQL (база даних)" ]
                        ]
                    |> Checkbox.view
                , Checkbox.new { isChecked = restartEchoForm.restartOutdatedSources, onToggle = ToggleRestartOutdatedSources }
                    |> Checkbox.withContent
                        [ span [ class descriptionClass ] [ text "Перезапустити месенджери що відстали" ]
                        ]
                    |> Checkbox.view
                ]
            , div [ class "flex items-center gap-2" ]
                [ Button.new { label = "Перезапустити", onClick = RestartEcho }
                    |> Button.withStyleDanger
                    |> Button.withDisabled restartEchoForm.isRestarting
                    |> Button.view
                , if restartEchoForm.isRestarting then
                    span [ class "ml-1" ] [ Shared.Components.Spinner.loadingSpinner2Sm ]

                  else
                    text ""
                ]
            ]
        ]


view : Shared.Model -> Model -> View Msg
view shared model =
    let
        isDark =
            isDarkMode shared.themeMode
    in
    { title = "Адмін: панель керування"
    , body =
        [ div [ class "mt-2 w-5/6 mx-auto" ]
            [ renderControlPanel isDark model ]
        ]
    }
