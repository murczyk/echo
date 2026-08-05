module Pages.Home_ exposing (Model, Msg, page)

import Auth
import Bindings as B
import Core.Auth
import Core.Types
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (on, onClick)
import Html.Extra as HtmlX
import Json.Decode as Decode
import Layouts
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
import Shared.Components.Spinner
import Shared.Components.Toast
import Task
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD exposing (RemoteData(..))
import View exposing (View)


type alias Model =
    { formErrors : Dict String String
    , toasts : Shared.Components.Toast.Model
    , inboxGroupsActivityStats : RemoteData Core.Types.ApiError B.InboxByGroupDigestRsp
    , activeTab : HomeTab
    , aiChatEnabled : Maybe Bool
    }


type HomeTab
    = AiTab
    | GuideTab
    | ActivityTab


type Msg
    = ToastMsg Shared.Components.Toast.Msg
    | GotInboxGroupsActivityStats (Result Core.Types.ApiError B.InboxByGroupDigestRsp)
    | AiChatAvailabilityChanged Bool
    | SetTab HomeTab
    | Slept


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "home"
        }


loadInboxGroupsActivityInterval : Float
loadInboxGroupsActivityInterval =
    10000


hasInboxGroupsActivityData : Model -> Bool
hasInboxGroupsActivityData model =
    case model.inboxGroupsActivityStats of
        Success resp ->
            hasRenderableInboxGroupsActivityData resp

        NeedsReload resp ->
            hasRenderableInboxGroupsActivityData resp

        _ ->
            False


hasRenderableInboxGroupsActivityData : B.InboxByGroupDigestRsp -> Bool
hasRenderableInboxGroupsActivityData resp =
    List.any
        (\minute ->
            Dict.values minute.stats
                |> List.any (\groupStats -> groupStats.count > 0)
        )
        resp.statsPerMinute


hasEmptyInboxGroupsActivityData : Model -> Bool
hasEmptyInboxGroupsActivityData model =
    case model.inboxGroupsActivityStats of
        Success resp ->
            not (hasRenderableInboxGroupsActivityData resp)

        NeedsReload resp ->
            not (hasRenderableInboxGroupsActivityData resp)

        _ ->
            False


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Shared.Components.Toast.init
      , inboxGroupsActivityStats = Loading
      , activeTab = AiTab
      , aiChatEnabled = Nothing
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
                    Shared.Components.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        GotInboxGroupsActivityStats (Err err) ->
            ( { model | inboxGroupsActivityStats = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики активності груп" err
            )

        GotInboxGroupsActivityStats (Ok resp) ->
            ( { model | inboxGroupsActivityStats = Success resp }, E.none )

        AiChatAvailabilityChanged enabled ->
            ( { model | aiChatEnabled = Just enabled }, E.none )

        SetTab activeTab ->
            ( { model | activeTab = activeTab }, E.none )

        Slept ->
            ( { model | inboxGroupsActivityStats = RD.markOutdated model.inboxGroupsActivityStats }
            , E.batch
                [ E.getInboxGroupsActivityStats GotInboxGroupsActivityStats
                , E.sendCmd <| Task.perform (\_ -> Slept) (Process.sleep loadInboxGroupsActivityInterval)
                ]
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Shared.Model -> B.User -> Model -> View Msg
view shared user model =
    { title = "ЕХО"
    , body =
        [ div [ class "box-border container mx-auto px-4 py-6" ]
            [ if not shared.userLoaded then
                viewHomeLoading

              else if canShowAiChat user then
                viewAiHome user model

              else
                viewClassicHome user model
            ]
        ]
    }


viewHomeLoading : Html Msg
viewHomeLoading =
    Html.node "home-loading-card"
        [ class "block w-full"
        , Attr.attribute "aria-label" "Завантаження головної сторінки"
        ]
        []


canShowAiChat : B.User -> Bool
canShowAiChat user =
    Core.Auth.hasRole "Rer" user && not (Core.Auth.hasRole "ApiAgent" user)


viewClassicHome : B.User -> Model -> Html Msg
viewClassicHome user model =
    div [ class "w-full" ]
        [ section [ class "flex flex-col lg:flex-row gap-4 min-w-0 min-h-[50vh] lg:h-[50vh]" ]
            [ a [ target "_blank", href "/docs", class "w-full lg:basis-[clamp(280px,32%,360px)] xl:basis-[420px] lg:shrink min-h-[240px] lg:min-h-0 bg-card border border-border rounded-lg p-6 flex flex-col items-center justify-center gap-3 hover:shadow-lg hover:shadow-[var(--ochre-normal)]/30 transition-all duration-300 group" ]
                [ div [ class "w-16 h-16 bg-gradient-to-br from-[var(--ochre-normal)] to-[var(--ochre-normal-hover)] rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition-transform duration-300" ]
                    [ i [ class "bi bi-book text-white text-2xl" ] []
                    ]
                , div [ class "text-center" ]
                    [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1" ] [ text "Алгоритм роботи" ]
                    , p [ class "text-sm text-gray-700 dark:text-gray-300" ] [ text "Документація та інструкції" ]
                    ]
                , div [ class "flex items-center gap-2 text-[var(--action-color)] group-hover:text-[var(--action-hovered-color)] transition-colors duration-300" ]
                    [ span [ class "text-sm font-medium" ] [ text "Переглянути" ]
                    , i [ class "bi bi-arrow-up-right text-lg group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-300" ] []
                    ]
                ]
            , HtmlX.viewIf (Core.Auth.hasRole "Rer" user) (viewActivity model)
            ]
        ]


viewAiHome : B.User -> Model -> Html Msg
viewAiHome user model =
    div [ class "w-full" ]
        [ HtmlX.viewIf (model.aiChatEnabled == Just True) <|
            nav [ class "flex gap-1 border-b border-border mb-4", Attr.attribute "aria-label" "Розділи головної сторінки" ]
                [ viewTab model.activeTab AiTab "ШІ"
                , viewTab model.activeTab GuideTab "Алгоритм роботи"
                , viewTab model.activeTab ActivityTab "Активність груп"
                ]
        , Html.node "ai-agent-chat"
            [ class <|
                if model.aiChatEnabled == Just True && model.activeTab == AiTab then
                    "block w-full"

                else
                    "hidden"
            , on "ai-agent-availability" <|
                Decode.map AiChatAvailabilityChanged <|
                    Decode.at [ "detail", "enabled" ] Decode.bool
            ]
            []
        , case model.aiChatEnabled of
            Nothing ->
                viewHomeLoading

            Just False ->
                viewClassicHome user model

            Just True ->
                case model.activeTab of
                    AiTab ->
                        text ""

                    GuideTab ->
                        section [ class "bg-card border border-border rounded-sm p-6" ]
                            [ h3 [ class "mt-0 mb-2 text-lg font-semibold" ] [ text "Алгоритм роботи" ]
                            , p [ class "mt-0 mb-4 text-sm text-gray-600 dark:text-gray-300" ] [ text "Документація та інструкції з роботи в ECHO." ]
                            , a [ target "_blank", href "/docs", class "text-[var(--action-color)] hover:text-[var(--action-hovered-color)]" ] [ text "Відкрити документацію" ]
                            ]

                    ActivityTab ->
                        viewActivity model
        ]


viewTab : HomeTab -> HomeTab -> String -> Html Msg
viewTab activeTab tab label =
    button
        [ type_ "button"
        , onClick (SetTab tab)
        , class <|
            "px-4 py-3 text-sm border-b-2 -mb-px transition-opacity "
                ++ (if activeTab == tab then
                        "border-current font-semibold"

                    else
                        "border-transparent opacity-60 hover:opacity-100"
                   )
        ]
        [ text label ]


viewActivity : Model -> Html Msg
viewActivity model =
    div [ class "w-full min-w-0 overflow-hidden bg-card border border-border rounded-sm relative flex flex-col h-[50vh] lg:flex-1" ]
        [ h4
            [ class "m-0 font-semibold"
            , Attr.style "padding-top" "24px"
            , Attr.style "padding-left" "24px"
            ]
            [ text "Активність груп" ]
        , div [ class "flex-1 min-h-0 min-w-0 overflow-hidden", Attr.style "margin-top" "20px" ]
            [ if hasInboxGroupsActivityData model then
                Html.node "dashboard-chart"
                    [ class "min-w-0"
                    , Attr.property "data" <|
                        B.inboxByGroupDigestRspEncoder (RD.withDefault2 { statsPerMinute = [] } model.inboxGroupsActivityStats)
                    , Attr.attribute "margin-left" "30"
                    , Attr.attribute "margin-bottom" "30"
                    ]
                    []

              else if hasEmptyInboxGroupsActivityData model then
                div
                    [ class "h-full w-full flex items-center justify-center px-6" ]
                    [ div
                        [ class "max-w-sm w-full px-6 py-8 text-center" ]
                        [ div
                            [ class "mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ochre-normal)]/15 text-[var(--ochre-normal)]" ]
                            [ i [ class "bi bi-activity text-xl" ] []
                            ]
                        , p
                            [ class "m-0 text-base font-semibold text-gray-700 dark:text-gray-200" ]
                            [ text "Відсутня активність по групам" ]
                        , p
                            [ class "m-0 mt-2 text-sm text-gray-600 dark:text-gray-400" ]
                            [ text "Зараз тут немає помітної активності" ]
                        ]
                    ]

              else
                text ""
            ]
        , HtmlX.viewIf (RD.isLoading model.inboxGroupsActivityStats) <|
            span [ class "absolute top-[50%] left-[50%] transform -translate-x-1/2 -translate-y-1/2" ] [ Shared.Components.Spinner.loadingSpinner ]
        ]
