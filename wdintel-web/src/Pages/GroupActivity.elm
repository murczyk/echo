module Pages.GroupActivity exposing (Model, Msg, page)

import Auth
import Bindings as B
import Core.Types
import Dict
import Effect as E exposing (Effect)
import Html exposing (div, h1, i, p, span, text)
import Html.Attributes as Attr exposing (class)
import Html.Extra as HtmlX
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Components.Spinner
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD exposing (RemoteData(..))
import View exposing (View)


type alias Model =
    { stats : RemoteData Core.Types.ApiError B.InboxByGroupDigestRsp
    }


type Msg
    = GotStats (Result Core.Types.ApiError B.InboxByGroupDigestRsp)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user _ _ =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "group-activity"
        }


init : () -> ( Model, Effect Msg )
init _ =
    ( { stats = Loading }, E.getInboxGroupsActivityStats GotStats )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotStats (Err err) ->
            ( { model | stats = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики активності груп" err
            )

        GotStats (Ok stats) ->
            ( { model | stats = Success stats }, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Model -> View Msg
view model =
    { title = "Статистика"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 w-full bg-[var(--background-color)] px-6 py-4 flex flex-col overflow-hidden" ]
            [ div [ class "relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden" ]
                [ h1 [ class "m-0 px-2 pt-2 text-lg font-semibold" ] [ text "Статистика" ]
                , div [ class "flex-1 min-h-0 min-w-0 overflow-hidden mt-5" ]
                    [ if hasActivityData model.stats then
                        Html.node "dashboard-chart"
                            [ class "min-w-0"
                            , Attr.property "data" <|
                                B.inboxByGroupDigestRspEncoder (RD.withDefault2 { statsPerMinute = [] } model.stats)
                            , Attr.attribute "margin-left" "30"
                            , Attr.attribute "margin-bottom" "30"
                            ]
                            []

                      else if hasEmptyActivityData model.stats then
                        emptyActivity

                      else
                        text ""
                    ]
                , HtmlX.viewIf (RD.isLoading model.stats) <|
                    span [ class "absolute top-[50%] left-[50%] transform -translate-x-1/2 -translate-y-1/2" ] [ Shared.Components.Spinner.loadingSpinner ]
                ]
            ]
        ]
    }


hasActivityData : RemoteData Core.Types.ApiError B.InboxByGroupDigestRsp -> Bool
hasActivityData stats =
    RD.withDefault2 { statsPerMinute = [] } stats
        |> .statsPerMinute
        |> List.any
            (\minute ->
                minute.stats
                    |> Dict.values
                    |> List.any (\groupStats -> groupStats.count > 0)
            )


hasEmptyActivityData : RemoteData Core.Types.ApiError B.InboxByGroupDigestRsp -> Bool
hasEmptyActivityData stats =
    case stats of
        Success _ ->
            not (hasActivityData stats)

        NeedsReload _ ->
            not (hasActivityData stats)

        _ ->
            False


emptyActivity : Html.Html Msg
emptyActivity =
    div [ class "h-full w-full flex items-center justify-center px-6" ]
        [ div [ class "max-w-sm w-full px-6 py-8 text-center" ]
            [ div [ class "mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ochre-normal)]/15 text-[var(--ochre-normal)]" ]
                [ i [ class "bi bi-activity text-xl" ] []
                ]
            , p [ class "m-0 text-base font-semibold text-gray-700 dark:text-gray-200" ] [ text "Відсутня активність по групам" ]
            , p [ class "m-0 mt-2 text-sm text-gray-600 dark:text-gray-400" ] [ text "Зараз тут немає помітної активності" ]
            ]
        ]
