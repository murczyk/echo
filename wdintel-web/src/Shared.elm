module Shared exposing
    ( Flags
    , Model
    , Msg
    , decoder
    , init
    , subscriptions
    , update
    )

import Api
import Bindings as B
import Shared.Components.Toast
import Core.EventService
import Core.EventTypes
import Core.Types exposing (ApiError)
import Dict
import Effect as E exposing (Effect)
import Http
import Json.Decode
import PagePorts.SharedPorts as Ports
import Process
import Route exposing (Route)
import Route.Path
import Shared.Model
import Shared.Msg exposing (Msg(..))
import Task
import TimeZone
import Url
import Utils.Api.Temp exposing (leExpectJson)
import Utils.RemoteData exposing (RemoteData(..))


type alias Flags =
    { isDark : Bool
    , now : Int
    }


decoder : Json.Decode.Decoder Flags
decoder =
    Json.Decode.map2 Flags
        (Json.Decode.field "isDark" Json.Decode.bool)
        (Json.Decode.field "now" Json.Decode.int)


type alias Model =
    Shared.Model.Model


init : Result Json.Decode.Error Flags -> Route () -> ( Model, Effect Msg )
init flagsResult _ =
    let
        flags =
            case flagsResult of
                Ok flags_ ->
                    flags_

                Err _ ->
                    { isDark = False
                    , now = 0
                    }
    in
    ( { user =
            Just
                { name = "anonymous"
                , roles = []
                , sigintZoneId = Nothing
                , organismId = Nothing
                , deltaLogin = Nothing
                , goiConfiguredForOrganism = False
                , goiFullAccessForOrganism = False
                , goiHost = Nothing
                }
      , themeMode =
            if flags.isDark then
                Shared.Model.Dark

            else
                Shared.Model.Light
      , location = Nothing
      , serverInfo = Nothing
      , masterUnits = NotAsked
      , now = flags.now
      , timeZone = TimeZone.europe__kyiv ()
      , callsignsInfo = Dict.empty
      , posts = NotAsked
      , toasts = Shared.Components.Toast.init
      , eventService = Core.EventService.init
      , pendingEvents = []
      , eventSubscriptions = Dict.empty
      , networks = NotAsked
      }
    , E.batch
        [ E.sendCmd <| Ports.shared_getLocation ()
        , E.sendCmd <| Api.server_info GotServerInfo
        , E.getUnits MasterUnitsLoadedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            }
        , E.sendCmd <| Task.perform (\_ -> EventServiceStartPolling) (Task.succeed ())
        , E.sendCmd <| Ports.shared_loadThemeMode ()
        ]
    )


type alias Msg =
    Shared.Msg.Msg


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update req msg model =
    case msg of
        SignIn user ->
            ( { model | user = Just user }
            , E.pushRoute { path = Route.Path.Home_, query = Dict.empty, hash = Nothing }
            )

        GotUser (Err e) ->
            if e.httpError == Http.BadStatus 401 then
                if req.path == Route.Path.Login then
                    ( model, E.none )

                else
                    ( model
                    , E.replaceRoute { path = Route.Path.Login, query = Dict.fromList [ ( "redirect", Url.toString req.url ) ], hash = Nothing }
                    )

            else
                ( model, E.none )

        GotUser (Ok user) ->
            ( { model | user = Just user }
            , E.batch
                [ if req.path == Route.Path.Login then
                    E.replaceRoutePath Route.Path.Home_

                  else
                    E.none
                , E.getNetworksList NetworksLoadedByApi
                    { sortBy = Nothing
                    , filterFreq = Nothing
                    , filterUnit = Nothing
                    , showOnlyFurtherInverstigation = Nothing
                    , showInactive = Nothing
                    , showOnlyDeleted = Nothing
                    , aorIds = Nothing
                    , ids = Nothing
                    , limit = Nothing
                    , offset = Nothing
                    }
                ]
            )

        ToggleDarkMode ->
            ( { model
                | themeMode =
                    case model.themeMode of
                        Shared.Model.Light ->
                            Shared.Model.Dark

                        Shared.Model.Dark ->
                            Shared.Model.Light

                        Shared.Model.System ->
                            Shared.Model.Light
              }
            , E.sendCmd <| Ports.shared_toggleDarkMode ()
            )

        SetThemeMode themeMode ->
            ( { model | themeMode = themeMode }
            , E.sendCmd <| Ports.shared_saveThemeMode (Shared.Model.themeModeToString themeMode)
            )

        ThemeModeLoaded themeModeStr ->
            ( { model | themeMode = Shared.Model.themeModeFromString themeModeStr }
            , E.none
            )

        TriggerResize ->
            ( model
            , E.sendCmd <| Ports.shared_triggerResize ()
            )

        SignOut ->
            ( { model | user = Nothing }
            , E.sendCmd <| Api.logout SignOutDone
            )

        SignOutDone _ ->
            ( model, E.replaceRoutePath Route.Path.Login )

        GotLocation loc ->
            ( { model | location = Just loc }
            , E.sendCmd <| Api.api_user GotUser
            )

        GotServerInfo (Err _) ->
            ( model, E.none )

        GotServerInfo (Ok v) ->
            ( { model | serverInfo = Just v }, E.none )

        MasterUnitsLoadedByApi (Err err) ->
            ( { model | masterUnits = Failure err }, E.none )

        MasterUnitsLoadedByApi (Ok rsp) ->
            ( { model
                | masterUnits =
                    rsp.units
                        |> List.map (\x -> ( x.id, x ))
                        |> Dict.fromList
                        |> Success
              }
            , E.none
            )

        NetworksLoadedByApi (Err err) ->
            ( { model | networks = Failure err }, E.none )

        NetworksLoadedByApi (Ok rsp) ->
            ( { model
                | networks =
                    rsp
                        |> List.map (\x -> ( x.id, x ))
                        |> Dict.fromList
                        |> Success
              }
            , E.none
            )

        CallsignsInfoReturnedByApi (Err _) ->
            ( model, E.none )

        CallsignsInfoReturnedByApi (Ok callsigns) ->
            let
                m2 =
                    List.foldl
                        (\callsign m ->
                            { m
                                | callsignsInfo =
                                    Dict.insert callsign.callsign
                                        callsign.res
                                        m.callsignsInfo
                            }
                        )
                        model
                        callsigns
            in
            ( m2, E.none )

        CallsignsInfoAskedByPage callsigns ->
            let
                callsignsWithoutLoadedInfo =
                    List.filter (\callsign -> not (Dict.member callsign model.callsignsInfo)) callsigns
            in
            ( model
            , if List.length callsignsWithoutLoadedInfo > 0 then
                E.getCallsignsInfo CallsignsInfoReturnedByApi { callsigns = callsignsWithoutLoadedInfo }

              else
                E.none
            )

        PostLoadAll payload ->
            ( model
            , E.sendCmd <| Api.get_posts PostsReturnedByApi payload
            )

        PostsReturnedByApi (Ok res) ->
            ( { model
                | posts =
                    List.map (\post -> ( post.id, post )) res
                        |> Dict.fromList
                        |> Success
              }
            , E.none
            )

        PostsReturnedByApi (Err _) ->
            ( model, E.none )

        ToastMsg toastMsg ->
            let
                ( toastModel, toastCmd ) =
                    Shared.Components.Toast.update toastMsg model.toasts
            in
            ( { model | toasts = toastModel }
            , E.sendCmd <| Cmd.map ToastMsg toastCmd
            )

        ShowToast error ->
            ( model
            , E.sendCmd <| Shared.Components.Toast.addError ToastMsg error
            )

        ShowToastWithDetails title content ->
            ( model
            , E.sendCmd <| Shared.Components.Toast.addErrorV2 ToastMsg title content
            )

        EventServiceStartPolling ->
            let
                eventService =
                    model.eventService

                newEventService =
                    { eventService | isPolling = True, error = Nothing, retryCount = 0, retryDelay = 1000 }
            in
            ( { model | eventService = newEventService }
            , E.sendCmd <| Task.perform (\_ -> EventServicePollEvents) (Task.succeed ())
            )

        EventServiceStopPolling ->
            let
                eventService =
                    model.eventService

                newEventService =
                    { eventService | isPolling = False, error = Nothing }
            in
            ( { model | eventService = newEventService }, E.none )

        EventServicePollEvents ->
            if model.eventService.isPolling then
                ( model, E.sendCmd <| pollEvents model.eventService.lastEventId )

            else
                ( model, E.none )

        EventServiceEventsReceived (Ok response) ->
            let
                eventService =
                    model.eventService

                newEventService =
                    { eventService
                        | lastEventId = response.lastEventId
                        , error = Nothing
                        , retryCount = 0
                        , retryDelay = 1000
                    }

                -- Process each event received
                processEventsEffect =
                    List.map EventReceived response.events
                        |> List.map (\eventMsg -> E.sendCmd <| Task.perform (\_ -> eventMsg) (Task.succeed ()))
                        |> E.batch
            in
            ( { model | eventService = newEventService }
            , E.batch
                [ processEventsEffect
                , E.sendCmd <| Task.perform (\_ -> EventServicePollEvents) (Process.sleep 100.0)
                ]
            )

        EventServiceEventsReceived (Err error) ->
            let
                newRetryCount =
                    model.eventService.retryCount + 1

                newRetryDelay =
                    min 30000 (model.eventService.retryDelay * 2)

                shouldRetry =
                    newRetryCount <= 5 && model.eventService.isPolling

                eventService =
                    model.eventService

                newEventService =
                    { eventService
                        | error = Just (formatError error)
                        , retryCount = newRetryCount
                        , retryDelay = newRetryDelay
                    }
            in
            if shouldRetry then
                ( { model | eventService = newEventService }
                , E.sendCmd <| Task.perform (\_ -> EventServiceRetryPolling) (Process.sleep (toFloat newRetryDelay))
                )

            else
                ( { model | eventService = { newEventService | isPolling = False } }, E.none )

        EventServiceRetryPolling ->
            if model.eventService.isPolling then
                ( model, E.sendCmd <| pollEvents model.eventService.lastEventId )

            else
                ( model, E.none )

        EventServiceResetRetryCount ->
            let
                eventService =
                    model.eventService

                newEventService =
                    { eventService | retryCount = 0, retryDelay = 1000 }
            in
            ( { model | eventService = newEventService }, E.none )

        EventReceived event ->
            case event.eventType of
                B.EtUnitChanged ->
                    ( { model | pendingEvents = event :: model.pendingEvents }
                    , E.getUnits MasterUnitsLoadedByApi
                        { sortBy = Nothing
                        , afterUnitId = Nothing
                        , beforeUnitId = Nothing
                        }
                    )

                B.EtNetworkChanged ->
                    ( { model | pendingEvents = event :: model.pendingEvents }
                    , E.getNetworksList NetworksLoadedByApi
                        { sortBy = Nothing
                        , filterFreq = Nothing
                        , filterUnit = Nothing
                        , showOnlyFurtherInverstigation = Nothing
                        , showInactive = Nothing
                        , showOnlyDeleted = Nothing
                        , aorIds = Nothing
                        , ids = Nothing
                        , limit = Nothing
                        , offset = Nothing
                        }
                    )

                _ ->
                    -- Add event to pending events for distribution
                    ( { model | pendingEvents = event :: model.pendingEvents }
                    , E.none
                    )

        SubscribeToEvents pageId eventTypes ->
            -- Add page subscription to event types
            ( { model | eventSubscriptions = Core.EventTypes.subscribeToEvents pageId eventTypes model.eventSubscriptions }
            , E.none
            )

        UnsubscribeFromEvents pageId ->
            -- Remove page subscription
            ( { model | eventSubscriptions = Core.EventTypes.unsubscribeFromEvents pageId model.eventSubscriptions }
            , E.none
            )


subscriptions : Route () -> Model -> Sub Msg
subscriptions _ _ =
    Sub.batch
        [ Ports.shared_getLocationRes GotLocation
        , Ports.shared_loadThemeModeRes ThemeModeLoaded
        ]



-- HTTP REQUESTS


pollEvents : Maybe String -> Cmd Msg
pollEvents lastEventId =
    let
        request : B.LongPollReq
        request =
            { sessionId = "current" -- We'll get this from session later
            , lastEventId = lastEventId
            }
    in
    Http.post
        { url = "/api/event-stream/long-poll"
        , body = Http.jsonBody (B.longPollReqEncoder request)
        , expect = leExpectJson EventServiceEventsReceived B.longPollRspDecoder
        }



-- HELPERS


formatError : ApiError -> String
formatError error =
    case error.httpError of
        Http.BadStatus code ->
            "HTTP Error: " ++ String.fromInt code

        Http.BadBody message ->
            "Invalid response: " ++ message

        Http.NetworkError ->
            "Network error - please check your connection"

        Http.Timeout ->
            "Request timed out"

        Http.BadUrl url ->
            "Invalid URL: " ++ url
