module Pages.Home_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Layouts
import Le.Auth
import Le.Block.Spinner
import Le.Block.Toast
import Le.Components exposing (googleMapsOutLink)
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Types
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
import Task
import Time
import View exposing (View)
import Le.ErrorHandling


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , inboxGroupsActivityStats : RemoteData Le.Types.ApiError B.InboxByGroupDigestRsp
    }


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | GotInboxGroupsActivityStats (Result Le.Types.ApiError B.InboxByGroupDigestRsp)
    | Slept


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "home"
        }


loadInboxGroupsActivityInterval =
    10000


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , inboxGroupsActivityStats = Loading
      }
    , E.batch
        [ E.getInboxGroupsActivityStats GotInboxGroupsActivityStats

        --, E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep loadInboxGroupsActivityInterval)
        ]
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        GotInboxGroupsActivityStats (Err err) ->
            ( { model | inboxGroupsActivityStats = Failure err }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики активності груп" err
            )

        GotInboxGroupsActivityStats (Ok resp) ->
            ( { model | inboxGroupsActivityStats = Success resp }, E.none )

        Slept ->
            ( { model | inboxGroupsActivityStats = RD.markOutdated model.inboxGroupsActivityStats }
            , E.batch
                [ E.getInboxGroupsActivityStats GotInboxGroupsActivityStats
                , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep loadInboxGroupsActivityInterval)
                ]
            )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


view : Shared.Model -> B.User -> Model -> View Msg
view shared user model =
    { title = "головна"
    , body =
        [ div [ class "my-4 w-4/5 mx-auto" ]
            [ section [class "mb-2"]
                [ h1 [ class "" ] [ text "Головна" ]
                ]
            , section [ class "flex gap-4 h-[50vh]" ]
                [ a [ target "_blank", href "/docs", class "basis-[35%] bg-card border border-border rounded-lg p-6 flex flex-col items-center justify-center gap-3 hover:shadow-lg hover:shadow-[var(--ochre-normal)]/30 transition-all duration-300 group" ]
                    [ div [ class "w-16 h-16 bg-gradient-to-br from-[var(--ochre-normal)] to-[var(--ochre-normal-hover)] rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition-transform duration-300" ]
                        [ i [ class "bi bi-book text-white text-2xl" ] []
                        ]
                    , div [ class "text-center" ]
                        [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1" ] [ text "Алгоритм Роботи" ]
                        , p [ class "text-sm text-gray-700 dark:text-gray-300" ] [ text "Документація та інструкції" ]
                        ]
                    , div [ class "flex items-center gap-2 text-[var(--action-color)] group-hover:text-[var(--action-hovered-color)] transition-colors duration-300" ]
                        [ span [ class "text-sm font-medium" ] [ text "Переглянути" ]
                        , i [ class "bi bi-arrow-up-right text-lg group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-300" ] []
                        ]
                    ]
                , HtmlX.viewIf (Le.Auth.hasRole "Rer" user) <|
                    div [ class "flex-1 bg-card border border-border rounded-sm relative" ]
                        [ h4 [ class "pl-2 pt-2" ] [ text "Активність груп" ]
                        , div [ class "h-[45vh]" ]
                            [ Html.node "bar-chart-2"
                                [ Attr.property "data" <|
                                    B.inboxByGroupDigestRspEncoder (RD.withDefault2 { statsPerMinute = [] } model.inboxGroupsActivityStats)
                                ]
                                []
                            ]
                        , HtmlX.viewIf (RD.isLoading model.inboxGroupsActivityStats) <|
                            span [ class "absolute top-[50%] left-[50%] transform -translate-x-1/2 -translate-y-1/2" ] [ Le.Block.Spinner.loadingSpinner ]
                        ]
                ]
            ]
        ]
    }
