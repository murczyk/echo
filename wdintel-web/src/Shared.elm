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
import Char
import Config
import Core.Auth
import Core.EventService
import Core.EventTypes
import Core.Types exposing (ApiError)
import Dict
import Effect as E exposing (Effect)
import Http
import Json.Decode
import PagePorts.SharedPorts as Ports
import Process
import Random
import Route exposing (Route)
import Route.Path
import Set exposing (Set)
import Shared.Components.AdminRoute
import Shared.Components.Toast
import Shared.Model
import Shared.Msg exposing (Msg(..))
import String
import Task
import Time
import TimeZone
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.LoginRedirect
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


loadSharedLookupData : Route.Path.Path -> Effect Msg
loadSharedLookupData path =
    E.batch
        [ E.getUnits MasterUnitsLoadedByApi
            { sortBy = Nothing
            , afterUnitId = Nothing
            , beforeUnitId = Nothing
            , includeInactive = False
            , filterActive = Nothing
            , filterText = Nothing
            , filterName = Nothing
            , filterOther = Nothing
            , filterTeamOrCrew = Nothing
            , filterSection = Nothing
            , filterSquad = Nothing
            , filterPlatoon = Nothing
            , filterCompany = Nothing
            , filterBattalion = Nothing
            , filterRegiment = Nothing
            , filterBrigade = Nothing
            , filterDivision = Nothing
            , filterCorps = Nothing
            , filterArmy = Nothing
            , filterMilitaryDistrict = Nothing
            , filterArmyRegion = Nothing
            , filterCombatType = Nothing
            , filterComment = Nothing
            , filterOrbitNote = Nothing
            , filterIsDeduplicateCandidate = Nothing
            , filterHasOrbit = Nothing
            , filterHasOrbitNote = Nothing
            , searchMode = Nothing
            , limit = Nothing
            , offset = Nothing
            }
        , E.getNetworksList NetworksLoadedByApi
            { sortBy = Nothing
            , filterFreq = Nothing
            , filterUnitId = Nothing
            , filterUnit = Nothing
            , filterUnitArmyRegion = Nothing
            , filterUnitMilitaryDistrict = Nothing
            , filterUnitArmy = Nothing
            , filterUnitCorps = Nothing
            , filterUnitDivision = Nothing
            , filterUnitBrigade = Nothing
            , filterUnitRegiment = Nothing
            , filterUnitBattalion = Nothing
            , filterUnitCompany = Nothing
            , filterUnitPlatoon = Nothing
            , filterUnitSquad = Nothing
            , filterUnitSection = Nothing
            , filterUnitTeamOrCrew = Nothing
            , filterUnitOther = Nothing
            , filterText = Nothing
            , filterName = Nothing
            , filterLocation = Nothing
            , showOnlyFurtherInverstigation = Nothing
            , showInactive = Nothing
            , showOnlyDeleted = Nothing
            , statusFilter = Nothing
            , aorIds = Nothing
            , ids = Nothing
            , limit = Nothing
            , offset = Nothing
            }
        ]


loadReferencedUnitIds : List Int -> Effect Msg
loadReferencedUnitIds unitIds =
    if List.isEmpty unitIds then
        E.none

    else
        E.getUnitsById ReferencedUnitsLoadedByApi
            { ids = Just (unitIds |> Set.fromList |> Set.toList) }


loadReferencedUnits : List B.Network -> Effect Msg
loadReferencedUnits networks =
    networks
        |> List.concatMap (.unitIds >> Maybe.withDefault [])
        |> loadReferencedUnitIds


type alias Model =
    Shared.Model.Model


init : Result Json.Decode.Error Flags -> Route () -> ( Model, Effect Msg )
init flagsResult route =
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
                { id = ""
                , name = "anonymous"
                , displayName = Nothing
                , roles = []
                , sigintZoneId = Nothing
                , organismId = Nothing
                , deltaLogin = Nothing
                , goiConfiguredForOrganism = False
                , goiFullAccessForOrganism = False
                , goiHost = Nothing
                , goiIntegrations = []
                , lastReleaseSeen = Nothing
                , rerReportEligible = False
                }
      , userLoaded = False
      , themeMode =
            if flags.isDark then
                Shared.Model.Dark

            else
                Shared.Model.Light
      , rerNetworkDetailsPreferredView = Shared.Model.Neo
      , location = Nothing
      , serverInfo = Nothing
      , serverInfoLoaded = False
      , changelogPreview = Nothing
      , changelogLastSeenLoaded = False
      , changelogLastSeen = Nothing
      , masterUnits = NotAsked
      , now = flags.now
      , systemSettings = Nothing
      , systemSettingsLoaded = False
      , timeZone = TimeZone.europe__kyiv ()
      , callsignsInfo = Dict.empty
      , posts = NotAsked
      , toasts = Shared.Components.Toast.init
      , eventService = Core.EventService.init
      , deploymentMaintenance = Nothing
      , eventSubscriptions = Dict.empty
      , networks = NotAsked
      }
    , E.batch
        [ E.sendCmd <| Ports.shared_getLocation ()
        , E.sendCmd <| Api.server_info GotServerInfo
        , E.sendCmd <| Api.changelog_index GotChangelogIndex
        , E.sendCmd <| Ports.shared_loadThemeMode ()
        , E.sendCmd <| Ports.shared_loadLastSeenChangelog ()
        , E.sendCmd <| Ports.shared_loadRerNetworkDetailsPreferredView ()
        ]
    )


type alias Msg =
    Shared.Msg.Msg


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update req msg model =
    case msg of
        SignIn user ->
            ( { model
                | user = Just user
                , userLoaded = True
                , systemSettingsLoaded = False
                , changelogLastSeenLoaded = True
                , changelogLastSeen = user.lastReleaseSeen
              }
            , E.batch
                [ E.pushRoute { path = Route.Path.Home_, query = Dict.empty, hash = Nothing }
                , E.sendCmd <| Task.perform (\_ -> EventServiceStartPolling) (Task.succeed ())
                ]
            )

        GotUser (Err e) ->
            if e.httpError == Http.BadStatus 401 then
                let
                    stoppedModel =
                        { model | user = Nothing, userLoaded = False, eventService = Core.EventService.stop model.eventService }
                in
                if req.path == Route.Path.Login then
                    ( stoppedModel, E.none )

                else
                    ( stoppedModel
                    , E.sendCmd <| Ports.shared_requestNavigation { kind = "replace", url = Route.toString { path = Route.Path.Login, query = Utils.LoginRedirect.loginQuery req.url, hash = Nothing }, forced = True }
                    )

            else
                ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження користувача" e )

        GotUser (Ok user) ->
            ( { model
                | user = Just user
                , userLoaded = True
                , changelogLastSeenLoaded = True
                , changelogLastSeen = user.lastReleaseSeen
              }
            , E.batch
                [ if req.path == Route.Path.Login then
                    E.loadExternalUrl (Utils.LoginRedirect.destination req.url req.query)

                  else if shouldRedirectUnauthorizedPage req.path user then
                    E.replaceRoutePath Route.Path.Home_

                  else
                    E.none
                , loadSharedLookupData req.path
                , E.getSystemSettings GotSystemSettings
                , E.sendCmd <| Task.perform (\_ -> EventServiceStartPolling) (Task.succeed ())
                ]
            )

        GotSystemSettings (Ok settings) ->
            ( { model | systemSettings = Just settings, systemSettingsLoaded = True }, E.none )

        GotSystemSettings (Err err) ->
            ( { model | systemSettingsLoaded = True }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження системних налаштувань" err
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

        RerNetworkDetailsPreferredViewLoaded preferredViewStr ->
            if isRerNetworkDetailsPath req.url.path then
                ( { model
                    | rerNetworkDetailsPreferredView =
                        if Dict.get "view" req.query == Just "classic" then
                            Shared.Model.Classic

                        else
                            Shared.Model.Neo
                  }
                , E.none
                )

            else
                ( { model
                    | rerNetworkDetailsPreferredView =
                        Shared.Model.rerNetworkDetailsPreferredViewFromString preferredViewStr
                  }
                , E.none
                )

        SetRerNetworkDetailsPreferredView preferredView ->
            ( { model | rerNetworkDetailsPreferredView = preferredView }
            , E.sendCmd <|
                case preferredView of
                    Shared.Model.Classic ->
                        Ports.shared_saveRerNetworkDetailsPreferredView "classic"

                    Shared.Model.Neo ->
                        Ports.shared_saveRerNetworkDetailsPreferredView "neo"
            )

        LastSeenChangelogLoaded value ->
            if model.userLoaded then
                -- Server value (set by GotUser) takes precedence over localStorage
                ( model, E.none )

            else
                let
                    trimmedValue =
                        String.trim value
                in
                ( { model
                    | changelogLastSeen =
                        if String.isEmpty trimmedValue then
                            Nothing

                        else
                            Just trimmedValue
                    , changelogLastSeenLoaded = True
                  }
                , E.none
                )

        SaveChangelogLastSeen version ->
            ( { model
                | changelogLastSeen = Just version
                , changelogLastSeenLoaded = True
              }
            , E.batch
                [ E.sendCmd <| Ports.shared_saveLastSeenChangelog version
                , E.sendCmd <| Api.api_mark_release_seen version ReleaseSeenApiSaved
                ]
            )

        ReleaseSeenApiSaved (Ok _) ->
            ( model, E.none )

        ReleaseSeenApiSaved (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження прочитаного релізу" err
            )

        TriggerResize ->
            ( model
            , E.sendCmd <| Ports.shared_triggerResize ()
            )

        SignOut ->
            ( { model | user = Nothing, userLoaded = False, eventService = Core.EventService.stop model.eventService }
            , if model.user == Nothing then
                E.none

              else
                E.loadExternalUrlForced
                    (Url.Builder.absolute [ "api", "user", "logout" ]
                        [ Url.Builder.string "redirect"
                            (if req.path == Route.Path.Login then
                                Utils.LoginRedirect.destination req.url req.query

                             else
                                Utils.LoginRedirect.relativeUrl req.url
                            )
                        ]
                    )
            )

        GotLocation loc ->
            ( { model | location = Just loc }
            , E.sendCmd <| Api.api_user GotUser
            )

        GotServerInfo (Err _) ->
            ( { model | serverInfoLoaded = True }, E.none )

        GotServerInfo (Ok v) ->
            ( { model | serverInfo = Just v, serverInfoLoaded = True }, E.none )

        GotChangelogIndex (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження changelog" err
            )

        GotChangelogIndex (Ok releases) ->
            case List.head releases of
                Just latestRelease ->
                    ( model, E.sendCmd <| Api.changelog_latest latestRelease.releaseId GotChangelogLatest )

                Nothing ->
                    ( model, E.none )

        GotChangelogLatest (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження останнього релізу" err
            )

        GotChangelogLatest (Ok releasePage) ->
            let
                preview =
                    { version = releasePage.releaseId
                    , preview = releasePage.headings
                    , fullUrl = "/updates"
                    }
            in
            ( { model | changelogPreview = Just preview }, E.none )

        MasterUnitsLoadedByApi (Err err) ->
            ( { model | masterUnits = Failure err }, E.none )

        MasterUnitsLoadedByApi (Ok rsp) ->
            let
                activeUnits =
                    rsp.units
                        |> List.map (\unit -> ( unit.id, unit ))
                        |> Dict.fromList

                referencedInactiveUnits =
                    model.masterUnits
                        |> Utils.RemoteData.withDefault Dict.empty
                        |> Dict.filter (\_ unit -> not unit.active)

                masterUnits =
                    Dict.union activeUnits referencedInactiveUnits
            in
            ( { model | masterUnits = Success masterUnits }
            , model.networks
                |> Utils.RemoteData.withDefault Dict.empty
                |> Dict.values
                |> loadReferencedUnits
            )

        LoadReferencedUnits unitIds ->
            ( model, loadReferencedUnitIds unitIds )

        ReferencedUnitsLoadedByApi (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження пов’язаних підрозділів" err
            )

        ReferencedUnitsLoadedByApi (Ok rsp) ->
            let
                referencedUnits =
                    rsp.units
                        |> List.map (\unit -> ( unit.id, unit ))
                        |> Dict.fromList

                masterUnits =
                    model.masterUnits
                        |> Utils.RemoteData.withDefault Dict.empty
                        |> Dict.union referencedUnits
            in
            ( { model | masterUnits = Success masterUnits }, E.none )

        NetworksLoadedByApi (Err err) ->
            ( { model | networks = Failure err }, E.none )

        NetworksLoadedByApi (Ok rsp) ->
            ( { model
                | networks =
                    rsp.list
                        |> List.map (\x -> ( x.id, x ))
                        |> Dict.fromList
                        |> Success
              }
            , loadReferencedUnits rsp.list
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

        ShowLoggedResponseDecodeError error ->
            ( model
            , E.sendCmd <| Random.generate (ShowLoggedResponseDecodeErrorWithCode error) responseDecodeErrorCodeGenerator
            )

        ShowLoggedResponseDecodeErrorWithCode error errorId ->
            ( model
            , E.sendCmd <|
                Cmd.batch
                    [ Shared.Components.Toast.addErrorV2 ToastMsg error.title ("Помилка обробки відповіді, код " ++ errorId)
                    , Api.logError ("Response decode error id=" ++ errorId ++ " title=" ++ error.title ++ " details=" ++ error.message) LoggedResponseDecodeError
                    ]
            )

        LoggedResponseDecodeError _ ->
            ( model, E.none )

        EventServiceStartPolling ->
            if (model.eventService.isPolling && model.eventService.flavor == eventServiceFlavor req.path) || not model.userLoaded || model.user == Nothing then
                ( model, E.none )

            else
                let
                    eventService =
                        model.eventService

                    newEventService =
                        { eventService
                            | isPolling = True
                            , flavor = eventServiceFlavor req.path
                            , requestInFlight = False
                            , generation = eventService.generation + 1
                            , error = Nothing
                            , retryCount = 0
                            , retryDelay = 1000
                            , connectionInterrupted = False
                            , persistentErrorReported = False
                        }
                in
                ( { model | eventService = newEventService }
                , E.sendCmd <|
                    Cmd.batch
                        [ Http.cancel Config.eventServicePollTracker
                        , Task.perform (\_ -> EventServicePollEvents newEventService.generation) (Task.succeed ())
                        ]
                )

        EventServiceStopPolling ->
            ( { model | eventService = Core.EventService.stop model.eventService }
            , E.sendCmd <| Http.cancel Config.eventServicePollTracker
            )

        EventServicePollEvents generation ->
            if model.eventService.isPolling && not model.eventService.requestInFlight && generation == model.eventService.generation then
                let
                    eventService =
                        model.eventService

                    newEventService =
                        { eventService | requestInFlight = True, generation = generation + 1 }
                in
                ( { model | eventService = newEventService }
                , E.sendCmd <| Task.perform (EventServicePollReady newEventService.generation) Time.now
                )

            else
                ( model, E.none )

        EventServicePollReady generation now ->
            if not model.eventService.isPolling || generation /= model.eventService.generation then
                ( model, E.none )

            else if model.eventService.flavor /= eventServiceFlavor req.path then
                update req EventServiceStartPolling model

            else
                pollEventsWhenReady generation now model

        EventServiceEventsReceived generation (Ok response) ->
            let
                eventService =
                    model.eventService

                inboxChangedEvents =
                    if eventServiceFlavor req.path == B.LpfGeneric then
                        []

                    else
                        extractInboxChangedEvents response.events

                newEventService =
                    { eventService
                        | lastEventId = response.lastEventId
                        , requestInFlight = False
                        , error = Nothing
                        , connectionInterrupted = False
                        , persistentErrorReported = False
                        , retryCount = 0
                        , retryDelay = 1000
                    }
            in
            if not model.eventService.isPolling || generation /= model.eventService.generation then
                ( model, E.none )

            else
                ( { model
                    | eventService = newEventService
                    , deploymentMaintenance = response.deploymentMaintenance
                  }
                , E.batch
                    [ if List.isEmpty inboxChangedEvents then
                        E.none

                      else
                        E.sendCmd <| Ports.shared_dispatchInboxChanged inboxChangedEvents
                    , E.sendCmd <| Task.perform (\_ -> EventServicePollEvents generation) (Process.sleep (eventServicePollDelay req.path))
                    ]
                )

        EventServiceEventsReceived generation (Err error) ->
            let
                newRetryCount =
                    model.eventService.retryCount + 1

                newRetryDelay =
                    min 30000 (model.eventService.retryDelay * 2)

                eventService =
                    model.eventService

                newEventService =
                    { eventService
                        | error = Just (formatError error)
                        , requestInFlight = False
                        , connectionInterrupted = Utils.Api.ErrorHandling.isTemporaryConnectionError error
                        , persistentErrorReported = eventService.persistentErrorReported || shouldNotifyAboutPersistentFailure
                        , retryCount = newRetryCount
                        , retryDelay = newRetryDelay
                    }

                retryEffect =
                    E.sendCmd <| Task.perform (\_ -> EventServiceRetryPolling generation) (Process.sleep (max (eventServicePollDelay req.path) (toFloat newRetryDelay)))

                shouldNotifyAboutPersistentFailure =
                    newRetryCount >= 6
                        && not eventService.persistentErrorReported
                        && not (Utils.Api.ErrorHandling.isTemporaryConnectionError error)
            in
            if not model.eventService.isPolling || generation /= model.eventService.generation then
                ( model, E.none )

            else if error.httpError == Http.BadStatus 401 then
                update req SignOut model

            else
                ( { model | eventService = newEventService }
                , if shouldNotifyAboutPersistentFailure then
                    E.batch
                        [ retryEffect
                        , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка отримання оновлень" error
                        ]

                  else
                    retryEffect
                )

        EventServiceRetryPolling generation ->
            update req (EventServicePollEvents generation) model

        EventServiceResetRetryCount ->
            let
                eventService =
                    model.eventService

                newEventService =
                    { eventService | retryCount = 0, retryDelay = 1000, persistentErrorReported = False }
            in
            ( { model | eventService = newEventService }, E.none )

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


extractInboxChangedEvents : List B.EventMsg -> List { messageId : Int, origin : Maybe String, intelligenceReport : Bool }
extractInboxChangedEvents events =
    let
        step event ( inboxEvents, seen ) =
            case event.eventType of
                B.EtInboxChanged messageId ->
                    let
                        reportKey =
                            if event.intelligenceReport then
                                1

                            else
                                0

                        key =
                            ( messageId, Maybe.withDefault "" event.origin, reportKey )
                    in
                    if Set.member key seen then
                        ( inboxEvents, seen )

                    else
                        ( { messageId = messageId, origin = event.origin, intelligenceReport = event.intelligenceReport } :: inboxEvents
                        , Set.insert key seen
                        )

                _ ->
                    ( inboxEvents, seen )
    in
    events
        |> List.foldl step ( [], Set.empty )
        |> Tuple.first
        |> List.reverse


isRerNetworkDetailsPath : String -> Bool
isRerNetworkDetailsPath path =
    case String.split "/" path of
        [ "", "rer-networks", id ] ->
            String.toInt id /= Nothing

        [ "", "rer-networks-neo", id ] ->
            String.toInt id /= Nothing

        _ ->
            False


subscriptions : Route () -> Model -> Sub Msg
subscriptions _ _ =
    Sub.batch
        [ Ports.shared_getLocationRes GotLocation
        , Ports.shared_loadThemeModeRes ThemeModeLoaded
        , Ports.shared_loadLastSeenChangelogRes LastSeenChangelogLoaded
        , Ports.shared_loadRerNetworkDetailsPreferredViewRes RerNetworkDetailsPreferredViewLoaded
        ]



-- HTTP REQUESTS


eventServicePollDelay : Route.Path.Path -> Float
eventServicePollDelay path =
    case path of
        Route.Path.RerUnitsNeo ->
            Config.rerUnitsPollingMinIntervalMs

        _ ->
            100


eventServiceFlavor : Route.Path.Path -> B.LongPollFlavor
eventServiceFlavor path =
    case path of
        Route.Path.RerDuty ->
            B.LpfRer

        Route.Path.RerDutyNeo ->
            B.LpfRer

        Route.Path.RerAnalysis ->
            B.LpfRer

        Route.Path.RerAnalysisNeo ->
            B.LpfAnalysisNeo

        _ ->
            B.LpfGeneric


pollEventsWhenReady : Int -> Time.Posix -> Model -> ( Model, Effect Msg )
pollEventsWhenReady generation now model =
    let
        eventService =
            model.eventService

        waitMs =
            eventService.lastPollStartedAt
                |> Maybe.map (\started -> Config.eventServicePollingMinIntervalMs - toFloat (Time.posixToMillis now - Time.posixToMillis started))
                |> Maybe.withDefault 0

        genericFullDue =
            eventService.lastGenericFullAt
                |> Maybe.map (\started -> Time.posixToMillis now - Time.posixToMillis started >= Config.eventServiceGenericFullIntervalMs)
                |> Maybe.withDefault True

        flavor =
            if eventService.flavor == B.LpfGeneric && genericFullDue then
                B.LpfGenericFull

            else
                eventService.flavor

        lastGenericFullAt =
            if flavor == B.LpfGenericFull then
                Just now

            else
                eventService.lastGenericFullAt
    in
    if waitMs > 0 then
        ( model
        , E.sendCmd <|
            Task.perform (EventServicePollReady generation)
                (Process.sleep waitMs |> Task.andThen (\_ -> Time.now))
        )

    else
        ( { model | eventService = { eventService | lastPollStartedAt = Just now, lastGenericFullAt = lastGenericFullAt } }
        , E.sendCmd <| pollEvents generation flavor eventService.lastEventId model.deploymentMaintenance
        )


pollEvents : Int -> B.LongPollFlavor -> Maybe String -> Maybe B.DeploymentMaintenance -> Cmd Msg
pollEvents generation flavor lastEventId deploymentMaintenance =
    let
        request : B.LongPollReq
        request =
            { flavor = flavor
            , sessionId = "current" -- We'll get this from session later
            , lastEventId = lastEventId
            , deploymentMaintenanceProtocol = Just deploymentMaintenanceProtocolVersion
            , knownDeploymentMaintenanceId = Maybe.map .id deploymentMaintenance
            }
    in
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/event-stream/long-poll"
        , body = Http.jsonBody (B.longPollReqEncoder request)
        , expect = leExpectJson (EventServiceEventsReceived generation) B.longPollRspDecoder
        , timeout = Nothing
        , tracker = Just Config.eventServicePollTracker
        }


deploymentMaintenanceProtocolVersion : Int
deploymentMaintenanceProtocolVersion =
    1


-- HELPERS


shouldRedirectUnauthorizedPage : Route.Path.Path -> B.User -> Bool
shouldRedirectUnauthorizedPage path user =
    case path of
        Route.Path.RerPalitraNeo ->
            not (Core.Auth.hasRerOrCyber user)

        Route.Path.Devices ->
            not (Core.Auth.canReadDevices user)

        Route.Path.Devices_Id_ _ ->
            not (Core.Auth.canReadDevices user)

        _ ->
            Shared.Components.AdminRoute.adminRouteIsBlocked path user




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


responseDecodeErrorCodeGenerator : Random.Generator String
responseDecodeErrorCodeGenerator =
    Random.map2
        (\left right -> left ++ "-" ++ right)
        responseDecodeErrorCodePartGenerator
        responseDecodeErrorCodePartGenerator


responseDecodeErrorCodePartGenerator : Random.Generator String
responseDecodeErrorCodePartGenerator =
    Random.list 3 (Random.int 0 35)
        |> Random.map (List.map responseDecodeErrorCodeSymbol >> String.fromList)


responseDecodeErrorCodeSymbol : Int -> Char
responseDecodeErrorCodeSymbol n =
    if n < 10 then
        Char.fromCode (Char.toCode '0' + n)

    else
        Char.fromCode (Char.toCode 'a' + n - 10)
