module Pages.Home_ exposing (Model, Msg, page)

import Auth
import Bindings as B
import Core.Auth
import Core.Types
import Effect as E exposing (Effect)
import Dict
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (on)
import Html.Extra as HtmlX
import Json.Decode as Decode
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Components.Spinner
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD exposing (RemoteData(..))
import View exposing (View)


type alias Model =
    { aiChatState : AiChatState
    , inboxGroupsActivityStats : RD.RemoteData Core.Types.ApiError B.InboxByGroupDigestRsp
    }


type AiChatState
    = Checking
    | Enabled
    | Disabled
    | Unavailable


type Msg
    = AiChatAvailabilityChanged AiChatState
    | GotInboxGroupsActivityStats (Result Core.Types.ApiError B.InboxByGroupDigestRsp)


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


init : () -> ( Model, Effect Msg )
init _ =
    ( { aiChatState = Checking
      , inboxGroupsActivityStats = RD.Loading
      }
    , E.getInboxGroupsActivityStats GotInboxGroupsActivityStats
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        AiChatAvailabilityChanged state ->
            ( { model | aiChatState = state }, E.none )

        GotInboxGroupsActivityStats (Err err) ->
            ( { model | inboxGroupsActivityStats = RD.Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails
                "Помилка завантаження статистики активності груп"
                err
            )

        GotInboxGroupsActivityStats (Ok resp) ->
            ( { model | inboxGroupsActivityStats = RD.Success resp }, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Shared.Model -> Auth.User -> Model -> View Msg
view shared user model =
    { title = "ЕХО"
    , body =
        [ div
            [ class <|
                if shouldShowAiChat shared user model then
                    "app-shell-fill-height box-border min-h-0 w-full flex flex-col overflow-hidden"

                else
                    "box-border container mx-auto px-4 py-6"
            ]
            [ if shouldShowAiChat shared user model then
                viewAiHome model

              else
                viewClassicHome user model
            ]
        ]

    }


shouldShowAiChat : Shared.Model -> Auth.User -> Model -> Bool
shouldShowAiChat shared user model =
    not shared.userLoaded || (canShowAiChat user && model.aiChatState /= Disabled)


aiChatStateDecoder : Decode.Decoder AiChatState
aiChatStateDecoder =
    Decode.string
        |> Decode.andThen
            (\state ->
                case state of
                    "enabled" ->
                        Decode.succeed Enabled

                    "disabled" ->
                        Decode.succeed Disabled

                    "unavailable" ->
                        Decode.succeed Unavailable

                    _ ->
                        Decode.fail "Unknown AI chat availability state"
            )


canShowAiChat : Auth.User -> Bool
canShowAiChat user =
    Core.Auth.hasRole "Rer" user && not (Core.Auth.hasRole "ApiAgent" user)


viewClassicHome : Auth.User -> Model -> Html Msg
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


hasInboxGroupsActivityData : Model -> Bool
hasInboxGroupsActivityData model =
    case model.inboxGroupsActivityStats of
        RD.Success resp ->
            hasRenderableInboxGroupsActivityData resp

        RD.NeedsReload resp ->
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
        RD.Success resp ->
            not (hasRenderableInboxGroupsActivityData resp)

        RD.NeedsReload resp ->
            not (hasRenderableInboxGroupsActivityData resp)

        _ ->
            False


viewAiHome : Model -> Html Msg
viewAiHome model =
    div [ class "w-full flex flex-col flex-1 min-h-0" ]
        [ Html.node "ai-agent-chat"
            [ class <|
                if model.aiChatState == Disabled then
                    "hidden"

                else
                    "react-fill-host flex-1"
            , on "ai-agent-availability" <|
                Decode.map AiChatAvailabilityChanged <|
                    Decode.at [ "detail", "state" ] aiChatStateDecoder
            ]
            []
        ]
