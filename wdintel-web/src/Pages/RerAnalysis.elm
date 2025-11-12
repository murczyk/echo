module Pages.RerAnalysis exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Config
import Core.Types exposing (..)
import Dict
import Dict.Extra as DE
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onInput)
import Html.Styled
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Pages_.RerAnalysis.Constants exposing (..)
import Pages_.RerAnalysis.FiltersReloading as FiltersReloading exposing (FilterDataState(..), FilterInteraction(..), invalidateFiltersState)
import Pages_.RerAnalysis.MainBody
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Pages_.RerAnalysis.Query as Query
import Pages_.RerDuty.Waterfall.Filters
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Shared.Components.Button as Button
import Shared.Components.DateRangePicker
import Shared.Components.DateTime
import Shared.Components.RerMessage
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Toast
import Shared.Model exposing (isDarkMode)
import String exposing (fromInt)
import Time exposing (Posix)
import Utils.Api.ErrorHandling
import Utils.Components exposing (..)
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils as Utils exposing (..)
import View exposing (View)


type alias Model =
    Pages_.RerAnalysis.Model.Model


type alias Msg =
    Pages_.RerAnalysis.Msg.Msg


init : Route () -> () -> ( Model, Effect Msg )
init route _ =
    let
        ms : Maybe B.RerAnalysisQueryState
        ms =
            Dict.get "state" route.query
                |> andThen
                    (Decode.decodeString B.rerAnalysisQueryStateDecoder
                        >> Result.toMaybe
                    )

        model : Model
        model =
            { formErrors = Dict.empty
            , toasts = Shared.Components.Toast.init
            , from = Shared.Components.DateTime.init ()
            , to = Shared.Components.DateTime.init ()
            , dateRangePicker = Shared.Components.DateRangePicker.init
            , loadingInboxMessages = True
            , messages = []
            , profiles = Dict.empty
            , aorsSelected = []
            , groupsSelected = []
            , sendersSelected = []
            , freqsSelected = []
            , callsignsSelected = []
            , unitsSelected = []
            , locationsSelected = []
            , tagsSelected = []
            , includePelengLocations = True
            , includeOnlyNewFreqs = False
            , groupInfos = Dict.empty
            , rowsModel = Shared.Components.RerMessage.model0
            , senderInput = ""
            , callsignInput = ""
            , sendersSortBy = "count"
            , freqsSortBy = "count"
            , callsignsSortBy = "count"
            , unitsSortBy = "count"
            , locationsSortBy = "count"
            , orWithExtendedForm = False
            , orBookmarked = False
            , orImportant = False
            , orWithCoords = False
            , unfoldAorsFilter = False
            , unfoldGroupsFilter = False
            , unfoldSendersFilter = False
            , unfoldFreqsFilter = False
            , unfoldCallsignsFilter = False
            , unfoldUnitsFilter = False
            , unfoldLocationsFilter = False
            , unfoldTagsFilter = False
            , unfoldNetworksFilter = False
            , unfoldPostsFilter = False
            , unfoldSumTable = False
            , unfoldCallsignGraph = False
            , unfoldGraphs = False
            , unfoldCorrelationBlock = False
            , unfoldNewCallsignsBlock = False
            , unfoldMapBlock = False
            , loadingCallsignGraph = False
            , callsignGraph = Nothing
            , callsignGraphNolimit = False
            , sumTable = NotAsked
            , correlatedFreqs = NotAsked
            , newestFirst = True
            , editUnitMap = Dict.empty
            , saveFilterExpanded = False
            , saveFilterInp = ""
            , saveFilterInProgress = False
            , savedFilters = []
            , savedFiltersLoading = True
            , savedFilterEditInp = Dict.empty
            , savedFilterMenuOpen = Nothing
            , searchInput = ""
            , nolimitShown = False
            , menuTab = TabFilters
            , selAorState = Select.initState (Select.selectIdentifier "selAorState")
            , selAorMenu = []
            , selGroupState = Select.initState (Select.selectIdentifier "selGroupState")
            , selGroupMenu = []
            , selSenderState = Select.initState (Select.selectIdentifier "selSenderState")
            , selSenderMenu = []
            , selFreqState = Select.initState (Select.selectIdentifier "selFreqState")
            , selFreqMenu = []
            , selCallsignState = Select.initState (Select.selectIdentifier "selCallsignState")
            , selCallsignMenu = []
            , selLocationState = Select.initState (Select.selectIdentifier "selLocationState")
            , selLocationMenu = []
            , selPostState = Select.initState (Select.selectIdentifier "selPostState")
            , selPostMenu = []
            , selUnitState = Select.initState (Select.selectIdentifier "selUnitState")
            , selUnitMenu = []
            , selNetworkState = Select.initState (Select.selectIdentifier "selNetworkState")
            , selNetworkMenu = []
            , filterUnits = ""
            , now = Nothing
            , tags = []
            , showReportConstructor = False
            , reportTemplate = RTTags
            , reportTagsOnlyThisUnit = False
            , reportAdjacentFreqsRangeSelect =
                { state = Select.initState (Select.selectIdentifier "selectReportAdjacentFreqsRange")
                , items = Config.adjacentFreqsRangeOptions |> List.map (\x -> Select.basicMenuItem { item = x, label = String.fromFloat (x * 1000) ++ " кГц" })
                , selected = 0
                }            

            -- , reportIframeUrl = Nothing
            , reportDownloadInProgress = False
            , bookmarks = Set.empty
            , importants = Set.empty
            , noMoreToLoad = False
            , newCallsignsLoading = False
            , newCallsignsRsp = Nothing
            , callsignsInfo = Dict.empty
            , callsignsInfoSumTable = Dict.empty
            , messageComments = Dict.empty
            , users = Dict.empty
            , sendersSelectedNames = []
            , postsSelected = []
            , deleteMessageModalId = Nothing
            , groupsMessageCountByDay = NotAsked

            --
            , aors = NotAsked
            , aorNames = []
            , groups = NotAsked
            , senders = NotAsked
            , freqs = NotAsked
            , callsigns = NotAsked
            , locations = NotAsked
            , units = NotAsked
            , counts = NotAsked
            , networksStats = NotAsked
            , networkNames = []
            , networksSelected = []
            , posts = NotAsked
            , statsTags = NotAsked
            , focusedFilterItemsBeforeChange = Nothing
            , mapPoints = NotAsked
            , mapNetworkUnits = []
            , mapOpenMessages = NotAsked
            , adjacentFreqsRangeSelect =
                { state = Select.initState (Select.selectIdentifier "selectAdjacentFreqsRange")
                , items = Config.adjacentFreqsRangeOptions |> List.map (\x -> Select.basicMenuItem { item = x, label = String.fromFloat (x * 1000) ++ " кГц" })
                , selected = 0
                }
            , filterSelectedAdjacentFreqs = []
            , groupsActivityPeriod = FilterSelectedRange
            , filterTagsOption = B.OneOfTags
            , unitsExactMatchOnly = True
            , editSidebar = Nothing
            }

        m2 =
            case ms of
                Just state ->
                    Query.updModelFromQueryState model state

                Nothing ->
                    model

        m3 =
            case Dict.get "showMap" route.query of
                Just c ->
                    if c == "true" then
                        { m2 | unfoldMapBlock = True, unfoldSumTable = False }

                    else
                        m2

                Nothing ->
                    m2
    in
    ( m3
    , E.batch
        [ E.getCurrentTime InitGotTime
        , E.getAnalysisSavedFilters SavedFiltersGot
        , E.getTags GotTags
        , E.map RowsMsg Shared.Components.RerMessage.init
        ]
    )


getInboxReq : Model -> B.InboxMessagesReq
getInboxReq model =
    { sinceIdNoninclusive = Nothing
    , beforeIdNoninclusive = Nothing
    , sinceDateInclusiveMs = Maybe.map Time.posixToMillis model.from.datePosix
    , tillDateInclusiveMs = Maybe.map Time.posixToMillis model.to.datePosix
    , onlyShowUnprocessed = Nothing
    , checkedOnly = Just False
    , selectedGroups = emptyToNothing model.groupsSelected
    , selectedSenders = emptyToNothing model.sendersSelected
    , deniedSenders = Nothing
    , selectedFreqs = emptyToNothing (model.freqsSelected ++ model.filterSelectedAdjacentFreqs)
    , deniedFreqs = Nothing
    , selectedPosts = emptyToNothing model.postsSelected
    , deniedPosts = Nothing
    , selectedAors =
        model.aorsSelected
            |> List.filterMap String.toInt
            |> emptyToNothing
    , selectedCallsigns = emptyToNothing model.callsignsSelected
    , selectedUnits = emptyToNothing model.unitsSelected
    , selectedLocations = emptyToNothing model.locationsSelected
    , includePelengLocations = Just model.includePelengLocations
    , selectedTags = emptyToNothing model.tagsSelected
    , nolimit = Nothing
    , orWithExtendedForm = Just model.orWithExtendedForm
    , loadLatest = Nothing
    , returnDuplicates = Nothing
    , orBookmarked = Just model.orBookmarked
    , orImportant = Just model.orImportant
    , orWithCoords = Just model.orWithCoords
    , newestFirst = Just model.newestFirst
    , search = emptySToNothing model.searchInput
    , highlightCallsigns = Nothing
    , highlightKeywords = Nothing
    , highlightSignals = Nothing
    , highlightSearchres = Just True
    , sortBy = Nothing
    , reportTagsOnlyThisUnit = Just model.reportTagsOnlyThisUnit
    , ignoreImportedCoords = Nothing
    , calculateFreqPelengsSummary = Nothing
    , skipGroupStats = Nothing
    , filterTagsOption = Just model.filterTagsOption
    , pageId = Just "rer-analysis"
    , unitsExactMatchOnly = Just model.unitsExactMatchOnly
    , selectedNetworks =
        model.networksSelected
            |> List.filterMap String.toInt
            |> emptyToNothing
    }


cmdLoadCallsignGraph : Model -> { dtFromPosix : Posix, dtToPosix : Posix } -> Effect Msg
cmdLoadCallsignGraph model { dtFromPosix, dtToPosix } =
    if model.unfoldCallsignGraph then
        E.getCallsignsGraph GotCallsignGraph
            { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
            , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
            , selectedGroups = emptyToNothing model.groupsSelected
            , selectedSenders = emptyToNothing model.sendersSelected
            , selectedFreqs = emptyToNothing (model.freqsSelected ++ model.filterSelectedAdjacentFreqs)
            , selectedCallsigns = emptyToNothing model.callsignsSelected
            , selectedPosts = emptyToNothing model.postsSelected
            , selectedAors =
                model.aorsSelected
                    |> List.filterMap String.toInt
                    |> emptyToNothing
            , selectedUnits = emptyToNothing model.unitsSelected
            , selectedLocations = emptyToNothing model.locationsSelected
            , includePelengLocations = Just model.includePelengLocations
            , orWithExtendedForm = Just model.orWithExtendedForm
            , orBookmarked = Just model.orBookmarked
            , orImportant = Just model.orImportant
            , orWithCoords = Just model.orWithCoords
            , nolimit = Just model.callsignGraphNolimit
            , search = Just model.searchInput
            , selectedTags = emptyToNothing model.tagsSelected
            , filterTagsOption = Just model.filterTagsOption
            , unitsExactMatchOnly = Just model.unitsExactMatchOnly
            , selectedNetworks =
                model.networksSelected
                    |> List.filterMap String.toInt
                    |> emptyToNothing
            }

    else
        E.none


loadSumTableOnly : Model -> ( Model, Effect Msg )
loadSumTableOnly model =
    case ( model.from.datePosix, model.to.datePosix ) of
        ( Just dtFromPosix, Just dtToPosix ) ->
            let
                analysisPs =
                    Query.analysisStatsParams dtFromPosix dtToPosix model

                loadingSumTable =
                    not (Utils.Time.isMoreThanThresholdApart dtFromPosix dtToPosix)

                sumTable =
                    if loadingSumTable then
                        Loading

                    else
                        NotAsked
            in
            ( { model | sumTable = sumTable }
            , if loadingSumTable then
                E.getFreqsSummaryTable GotSumTable analysisPs

              else
                E.none
            )

        _ ->
            ( model, E.none )


loadCoreStats : Model -> ( Model, Effect Msg )
loadCoreStats model =
    case ( model.from.datePosix, model.to.datePosix ) of
        ( Just dtFromPosix, Just dtToPosix ) ->
            let
                analysisPs =
                    Query.analysisStatsParams dtFromPosix dtToPosix model

                loadingCounts =
                    not (Utils.Time.isMoreThanThresholdApart dtFromPosix dtToPosix)

                loadingSumTable =
                    model.unfoldSumTable && not (Utils.Time.isMoreThanThresholdApart dtFromPosix dtToPosix)

                cmdLoadSummaryTable isLoading =
                    if isLoading then
                        E.getFreqsSummaryTable GotSumTable analysisPs

                    else
                        E.none

                sumTable =
                    if loadingSumTable then
                        Loading

                    else if model.unfoldSumTable then
                        model.sumTable

                    else
                        NotAsked

                counts =
                    if loadingCounts then
                        case model.counts of
                            Success data ->
                                NeedsReload data

                            NeedsReload data ->
                                NeedsReload data

                            _ ->
                                Loading

                    else
                        model.counts

                ( m2, eff2 ) =
                    case model.mapPoints of
                        NotAsked ->
                            if model.unfoldMapBlock then
                                ( { model | mapPoints = Loading }
                                , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = getInboxReq model, mapFilter = Nothing, pageId = Just "rer-analysis" }
                                )

                            else
                                ( model, E.none )

                        NeedsReload _ ->
                            if model.unfoldMapBlock then
                                ( { model | mapPoints = Loading }
                                , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = getInboxReq model, mapFilter = Nothing, pageId = Just "rer-analysis" }
                                )

                            else
                                ( model, E.none )

                        Loading ->
                            ( model, E.none )

                        Failure _ ->
                            ( { model | mapPoints = Loading }
                            , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = getInboxReq model, mapFilter = Nothing, pageId = Just "rer-analysis" }
                            )

                        Success data ->
                            if model.unfoldMapBlock then
                                ( { model | mapPoints = Loading }
                                , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = getInboxReq model, mapFilter = Nothing, pageId = Just "rer-analysis" }
                                )

                            else
                                ( { model | mapPoints = NeedsReload data }, E.none )

                ( m3, eff3 ) =
                    case ( m2.groupsMessageCountByDay, List.head m2.freqsSelected ) of
                        ( NotAsked, Just freq ) ->
                            if m2.unfoldGraphs then
                                ( m2
                                , E.getFreqActivityDaily GotFreqActivityDaily
                                    { freq = freq
                                    , sinceDateInclusiveMs = Time.posixToMillis <| getSinceDateForGroupsActivity m2.groupsActivityPeriod dtFromPosix dtToPosix
                                    , tillDateInclusiveMs = Just (Time.posixToMillis dtToPosix)
                                    }
                                )

                            else
                                ( m2, E.none )

                        ( NeedsReload data, Just freq ) ->
                            if m2.unfoldGraphs then
                                ( m2
                                , E.getFreqActivityDaily GotFreqActivityDaily
                                    { freq = freq
                                    , sinceDateInclusiveMs = Time.posixToMillis <| getSinceDateForGroupsActivity m2.groupsActivityPeriod dtFromPosix dtToPosix
                                    , tillDateInclusiveMs = Just (Time.posixToMillis dtToPosix)
                                    }
                                )

                            else
                                ( m2, E.none )

                        ( Success data, Just freq ) ->
                            if m2.unfoldGraphs then
                                ( { m2 | groupsMessageCountByDay = NeedsReload data }
                                , E.getFreqActivityDaily GotFreqActivityDaily
                                    { freq = freq
                                    , sinceDateInclusiveMs = Time.posixToMillis <| getSinceDateForGroupsActivity m2.groupsActivityPeriod dtFromPosix dtToPosix
                                    , tillDateInclusiveMs = Just (Time.posixToMillis dtToPosix)
                                    }
                                )

                            else
                                ( { m2 | groupsMessageCountByDay = NeedsReload data }, E.none )

                        _ ->
                            ( m2, E.none )
            in
            ( { m3
                | loadingInboxMessages = True
                , loadingCallsignGraph =
                    if model.unfoldCallsignGraph then
                        True

                    else
                        model.loadingCallsignGraph
                , sumTable = sumTable
                , nolimitShown = False
                , correlatedFreqs = NotAsked
                , counts = counts
              }
            , E.batch
                [ if loadingCounts then
                    E.getStatsCount GotStatsCount analysisPs

                  else
                    E.none
                , E.getTags2 GotStatsTags analysisPs
                , E.getInboxMessages Nothing
                    GotInbox
                    (getInboxReq model)
                , cmdLoadSummaryTable loadingSumTable
                , cmdLoadCallsignGraph model { dtFromPosix = dtFromPosix, dtToPosix = dtToPosix }
                , E.getBookmarks GotBookmarks
                    { sinceTsMillis = Just (Time.posixToMillis dtFromPosix) }
                , E.getImportantMessagesIds GotImportants
                    { sinceTsMillis = Just (Time.posixToMillis dtFromPosix) }
                , eff2
                , eff3
                ]
            )

        _ ->
            ( model, E.none )


loadCoreStatsAndPushUrl : Model -> ( Model, Effect Msg )
loadCoreStatsAndPushUrl model =
    let
        stateS =
            Encode.encode 0 (B.rerAnalysisQueryStateEncoder (Query.modelQueryState model))

        ( m2, eff2 ) =
            loadCoreStats model

        cmd3 =
            E.batch
                [ eff2
                , E.pushRoute { path = Route.Path.RerAnalysis, hash = Nothing, query = Dict.fromList [ ( "state", stateS ) ] }
                ]
    in
    ( m2, cmd3 )


menuItemWithCount : String -> Int -> Html msg
menuItemWithCount itemName count =
    div
        [ class "list-group-item list-group-item-action pointer"
        ]
        [ div
            [ class "d-flex justify-content-between align-items-center"
            ]
            [ div [] [ text (getLabelOrDefault itemName) ]
            , div []
                [ span [ class "badge rounded-pill text-bg-light" ]
                    [ text <| String.fromInt count ]
                ]
            ]
        ]


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init req
        , update = update user shared req
        , view = view shared user req
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user

        --TODO: тимчасовий костиль
        , activeName =
            if model.unfoldMapBlock then
                "analysis-map"

            else
                "analysis"
        }


loadNewComments : Model -> Effect Msg
loadNewComments model =
    let
        allMessageIds =
            model.messages
                |> List.map Tuple.first
                |> Set.fromList

        knownMessageIds =
            model.messageComments
                |> Dict.keys
                |> Set.fromList

        newIds =
            Set.diff allMessageIds knownMessageIds
                |> Set.toList
    in
    E.getMessagesComments GotMessagesComments { messages = newIds |> List.map (\id -> { messageId = id }) }


loadNewUsers : Model -> Effect Msg
loadNewUsers model =
    let
        allLogins =
            model.messageComments
                |> Dict.toList
                |> List.concatMap (Tuple.second >> List.map .login)
                |> Set.fromList

        knownLogins =
            model.users
                |> Dict.keys
                |> Set.fromList

        newLogins =
            Set.diff allLogins knownLogins
                |> Set.toList
    in
    E.batch <|
        List.map
            (\login ->
                E.getUserInfo (GotUserInfo login)
                    { login = login }
            )
            newLogins


extractMetaInfo : B.InboxMessagesRsp -> Model -> Model
extractMetaInfo inboxRsp model =
    let
        m2 =
            { model
                | profiles = Dict.union inboxRsp.signalProfiles model.profiles
                , groupInfos = inboxRsp.signalGroups |> List.foldl (\group acc -> Dict.insert group.masterKey group acc) model.groupInfos
            }

        m3 =
            { m2
                | sendersSelectedNames = Pages_.RerDuty.Waterfall.Filters.ensureAllSendersNamed m2.profiles m2.sendersSelected m2.sendersSelectedNames
            }
    in
    { m3
        | callsignsInfo =
            inboxRsp.callsigns
                |> List.foldl (\{ callsign, res } dict -> Dict.insert callsign res dict) model.callsignsInfo
    }


update : B.User -> Shared.Model -> Route () -> Msg -> Model -> ( Model, Effect Msg )
update user shared route msg model =
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

        InitGotTime now_ ->
            let
                ( from, to ) =
                    Shared.Components.DateTime.initAnalysisRanges
                        { from = model.from
                        , to = model.to
                        , zone = shared.timeZone
                        , now = now_
                        }

                m2 =
                    { model
                        | from = from
                        , to = to
                        , dateRangePicker = Shared.Components.DateRangePicker.initFromData from to
                        , now = Just now_
                    }

                ( m3, cmd3 ) =
                    loadCoreStats m2

                loadInitialFiltersStats =
                    let
                        filterNameToListLength : FilterName -> Bool
                        filterNameToListLength name =
                            case name of
                                AorsFilter ->
                                    List.length model.aorsSelected > 0

                                LocationsFilter ->
                                    List.length model.locationsSelected > 0

                                PostsFilter ->
                                    List.length model.postsSelected > 0

                                UnitsFilter ->
                                    List.length model.unitsSelected > 0

                                CallsignsFilter ->
                                    List.length model.callsignsSelected > 0

                                FreqsFilter ->
                                    List.length model.freqsSelected > 0

                                SendersFilter ->
                                    List.length model.sendersSelectedNames > 0

                                GroupsFilter ->
                                    List.length model.groupsSelected > 0

                                NetworksFilter ->
                                    List.length model.networksSelected > 0

                        all =
                            [ AorsFilter, LocationsFilter, PostsFilter, UnitsFilter, FreqsFilter, CallsignsFilter, SendersFilter, GroupsFilter, NetworksFilter ]

                        preselectedFilters =
                            List.filter (\filterName -> filterNameToListLength filterName) all
                    in
                    preselectedFilters
                        |> List.filterMap (\name_ -> ListX.find (\( n, _ ) -> n == name_) FiltersReloading.endpoints)
                        |> List.map Tuple.second
                        |> List.map
                            (\endpoint_ ->
                                case ( m2.from.datePosix, m2.to.datePosix ) of
                                    ( Just dtFromPosix, Just dtToPosix ) ->
                                        endpoint_ (Query.analysisStatsParams dtFromPosix dtToPosix model)

                                    _ ->
                                        E.none
                            )
            in
            ( m3, E.batch (cmd3 :: loadInitialFiltersStats) )

        DateRangePickerMsg imsg ->
            let
                m2 =
                    { model | dateRangePicker = Shared.Components.DateRangePicker.update { zone = shared.timeZone, from = model.from, to = model.to } imsg model.dateRangePicker }
            in
            case imsg of
                Shared.Components.DateRangePicker.Submit ->
                    let
                        m3 =
                            { m2 | from = model.dateRangePicker.from, to = model.dateRangePicker.to }
                    in
                    mapSnd (addEff E.none)
                        (loadCoreStatsAndPushUrl
                            { m3
                                | locations = NeedsReload (RD.withDefault [] model.locations)
                                , units = NeedsReload (RD.withDefault [] model.units)
                                , posts = NeedsReload (RD.withDefault [] model.posts)
                                , senders = NeedsReload (RD.withDefault [] model.senders)
                                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                                , groups = NeedsReload (RD.withDefault [] model.groups)
                                , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                                , aors = NeedsReload (RD.withDefault [] model.aors)
                                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                            }
                        )

                _ ->
                    ( m2, E.none )

        GotInbox (Err e) ->
            ( { model | loadingInboxMessages = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження повідомлень" e
            )

        GotInbox (Ok rsp) ->
            let
                messages =
                    rsp.inboxItems

                m2 =
                    { model
                        | messages = messages
                        , loadingInboxMessages = False
                        , noMoreToLoad = False
                    }

                eff3 =
                    loadNewComments m2

                m3 =
                    extractMetaInfo rsp m2
            in
            ( m3
            , eff3
            )

        GotInboxMore (Err e) ->
            ( { model | loadingInboxMessages = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження додаткових повідомлень" e
            )

        GotInboxMore (Ok rsp) ->
            let
                messages =
                    rsp.inboxItems

                m2 =
                    { model
                        | messages = model.messages ++ messages
                        , loadingInboxMessages = False
                        , noMoreToLoad =
                            if List.isEmpty messages then
                                True

                            else
                                model.noMoreToLoad
                    }

                eff3 =
                    loadNewComments m2

                m3 =
                    extractMetaInfo rsp m2
            in
            ( m3
            , eff3
            )

        GotStatsCount (Err e) ->
            ( { model | counts = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики" e
            )

        GotStatsCount (Ok counts) ->
            ( { model
                | counts = Success counts
              }
            , E.none
            )

        GotStatsFreqs (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження частот" e
            )

        GotStatsFreqs (Ok rsp) ->
            let
                ( m1, eff1 ) =
                    if model.includeOnlyNewFreqs then
                        let
                            onlyNewFreqs =
                                rsp.freqs |> List.filter (\freq -> freq.isNew) |> List.map .freq
                        in
                        --TODO: подумати як зробити з pushUrl зараз воно просто заб'є урл
                        loadCoreStats { model | freqsSelected = onlyNewFreqs }

                    else
                        ( model, E.none )
            in
            ( { m1
                | freqs = Success rsp.freqs
                , selFreqMenu =
                    List.map
                        (\freq ->
                            Select.customMenuItem
                                { item = freq.freq
                                , label = getLabelOrDefault freq.freq
                                , view = Html.Styled.fromUnstyled (menuItemWithCount freq.freq freq.count)
                                }
                        )
                        rsp.freqs
              }
            , eff1
            )

        GotStatsCallsigns (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позывних" e
            )

        GotStatsCallsigns (Ok rsp) ->
            ( { model
                | callsigns = Success rsp.callsigns
                , selCallsignMenu =
                    List.map
                        (\callsign ->
                            Select.basicMenuItem
                                { item = callsign.callsign
                                , label = callsign.callsign
                                }
                        )
                        rsp.callsigns
              }
            , E.none
            )

        GotStatsLocations (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження локацій" e
            )

        GotStatsLocations (Ok rsp) ->
            ( { model
                | locations = Success rsp.locations
                , selLocationMenu =
                    List.map
                        (\location ->
                            Select.basicMenuItem
                                { item = location.location
                                , label = location.location
                                }
                        )
                        rsp.locations
              }
            , E.none
            )

        GotStatsPosts (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження постів" e
            )

        GotStatsPosts (Ok rsp) ->
            ( { model
                | posts = Success rsp.posts
                , selPostMenu =
                    List.map
                        (\post ->
                            Select.customMenuItem
                                { item = post.post
                                , label = getLabelOrDefault post.post
                                , view = Html.Styled.fromUnstyled (menuItemWithCount post.post post.count)
                                }
                        )
                        rsp.posts
              }
            , E.none
            )

        GotStatsTags (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження тегів" e
            )

        GotStatsTags (Ok rsp) ->
            ( { model
                | statsTags = Success rsp.tags
              }
            , E.none
            )

        GotStatsUnits (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підрозділів" e
            )

        GotStatsUnits (Ok rsp) ->
            ( { model
                | units = Success rsp.units
                , selUnitMenu =
                    List.map
                        (\unit ->
                            Select.customMenuItem
                                { item = unit.unit
                                , label = unit.unit
                                , view = Html.Styled.fromUnstyled (menuItemWithCount unit.unit unit.count)
                                }
                        )
                        rsp.units
              }
            , E.none
            )

        GotStatsSenders (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження відправників" e
            )

        GotStatsSenders (Ok rsp) ->
            let
                m1 =
                    { model | profiles = Dict.union rsp.senderNames model.profiles }
            in
            ( { m1
                | senders = Success rsp.senders
                , selSenderMenu =
                    rsp.senders
                        |> List.map (\sender -> ( Shared.Components.RerMessage.getProfileName m1.profiles sender.uuid, sender.count ))
                        |> List.foldl
                            (\( name, count ) ( acc, seen ) ->
                                if Set.member name seen then
                                    let
                                        updatedAcc =
                                            acc
                                                |> List.map
                                                    (\( name_, count_ ) ->
                                                        if name == name_ then
                                                            ( name_, count_ + count )

                                                        else
                                                            ( name_, count_ )
                                                    )
                                    in
                                    ( updatedAcc, seen )

                                else
                                    ( ( name, count ) :: acc, Set.insert name seen )
                            )
                            ( [], Set.empty )
                        |> Tuple.first
                        |> List.map
                            (\( name, count ) ->
                                Select.basicMenuItem
                                    { item = name
                                    , label =
                                        name
                                            ++ " ("
                                            ++ fromInt count
                                            ++ ")"
                                    }
                            )
              }
            , E.none
            )

        GotStatsAors (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження смуг" e
            )

        GotStatsAors (Ok rsp) ->
            let
                findAorName aorId =
                    rsp.aorNames
                        |> ListX.find (\entry -> entry.id == aorId)
                        |> Maybe.map .name
                        |> Maybe.withDefault ("AOR " ++ String.fromInt aorId)

                menuItems =
                    rsp.aors
                        |> List.map
                            (\aor ->
                                Select.basicMenuItem
                                    { item = String.fromInt aor.aorId
                                    , label = findAorName aor.aorId ++ " (" ++ String.fromInt aor.count ++ ")"
                                    }
                            )
            in
            ( { model
                | aors = Success rsp.aors
                , selAorMenu = menuItems
                , aorNames = rsp.aorNames
              }
            , E.none
            )

        GotStatsNetworks (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж" e
            )

        GotStatsNetworks (Ok rsp) ->
            ( { model
                | networksStats = Success rsp.networks
                , networkNames = rsp.networkNames
                , selNetworkMenu =
                    List.map
                        (\network ->
                            let
                                networkName =
                                    rsp.networkNames
                                        |> List.filter (\name -> name.id == network.networkId)
                                        |> List.head
                                        |> Maybe.map .name
                                        |> Maybe.withDefault ("Network " ++ String.fromInt network.networkId)
                            in
                            Select.customMenuItem
                                { item = String.fromInt network.networkId
                                , label = networkName
                                , view = Html.Styled.fromUnstyled (menuItemWithCount networkName network.count)
                                }
                        )
                        rsp.networks
              }
            , E.none
            )

        GotStatsGroups (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження груп" e
            )

        GotStatsGroups (Ok rsp) ->
            let
                m1 =
                    { model
                        | groupInfos = rsp.groupNames |> List.foldl (\group acc -> Dict.insert group.masterKey group acc) model.groupInfos
                    }
            in
            ( { m1
                | groups = Success rsp.groups

                --, groupInfos = Dict.union rsp.groupNames model.groupInfos
                , selGroupMenu =
                    List.map
                        (\x ->
                            Select.basicMenuItem
                                { item = x.masterKey
                                , label = Shared.Components.RerMessage.groupName x.masterKey m1.groupInfos
                                }
                        )
                        rsp.groups
              }
            , E.none
            )

        SelectFreq freqS ->
            if List.member freqS model.freqsSelected then
                ( model, E.none )

            else
                let
                    newSelectedFreqs =
                        model.freqsSelected ++ [ freqS ]

                    filterSelectedAdjacentFreqs =
                        Utils.findAllAdjacentFreqs (RD.withDefault [] model.freqs |> List.map .freq) newSelectedFreqs model.adjacentFreqsRangeSelect.selected
                in
                loadCoreStatsAndPushUrl
                    { model
                        | freqsSelected = newSelectedFreqs
                        , filterSelectedAdjacentFreqs = filterSelectedAdjacentFreqs
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }

        SelectOneFreq freqS ->
            if List.member freqS model.freqsSelected && List.length model.freqsSelected == 1 then
                ( model, E.none )

            else
                loadCoreStatsAndPushUrl
                    { model
                        | freqsSelected = [ freqS ]
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }

        ToggleTagSelection tagId ->
            let
                m2 =
                    { model
                        | tagsSelected =
                            if List.member tagId model.tagsSelected then
                                List.filter (\x -> x /= tagId) model.tagsSelected

                            else
                                model.tagsSelected ++ [ tagId ]
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , freqs = NeedsReload (RD.withDefault [] model.freqs)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }
            in
            loadCoreStatsAndPushUrl m2

        UnselectFreq freqStr ->
            let
                m2 =
                    { model
                        | freqsSelected = List.filter (\x -> x /= freqStr) model.freqsSelected
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , freqs = NeedsReload (RD.withDefault [] model.freqs)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }
            in
            loadCoreStatsAndPushUrl m2

        RowsMsg imsg ->
            let
                masterUnitsDict =
                    case shared.masterUnits of
                        Success units ->
                            units

                        _ ->
                            Dict.empty

                vps : Shared.Components.RerMessage.ViewParams
                vps =
                    { profiles = model.profiles
                    , groupInfos = model.groupInfos
                    , zone = shared.timeZone
                    , messages = model.messages
                    , tags = model.tags
                    , bookmarks = model.bookmarks
                    , importants = model.importants
                    , callsignsInfo = model.callsignsInfo
                    , messageComments = model.messageComments
                    , user = user
                    , users = model.users
                    , serverInfo = shared.serverInfo
                    , networks =
                        case shared.networks of
                            Success networks ->
                                networks

                            _ ->
                                Dict.empty
                    , masterUnits = masterUnitsDict
                    , currentRoute = Just route
                    }

                res =
                    Shared.Components.RerMessage.update vps imsg model.rowsModel

                m2 =
                    { model | rowsModel = res.model, messages = res.messages }

                mAndCmds : ( Model, List (Effect Msg) )
                mAndCmds =
                    List.foldl
                        (\sig ( accM, accCmds ) ->
                            case sig of
                                Shared.Components.RerMessage.OutFocus { elemId } ->
                                    ( accM
                                    , accCmds ++ [ E.focusHtmlElement { elemId = elemId } ]
                                    )

                                Shared.Components.RerMessage.OutFormErrors es ->
                                    ( { accM | formErrors = Dict.union es accM.formErrors }
                                    , accCmds
                                    )

                                Shared.Components.RerMessage.OutBookmarkAdd msgId ->
                                    ( { accM | bookmarks = Set.insert msgId accM.bookmarks }
                                    , accCmds
                                    )

                                Shared.Components.RerMessage.OutBookmarkRm msgId ->
                                    ( { accM | bookmarks = Set.remove msgId accM.bookmarks }
                                    , accCmds
                                    )

                                Shared.Components.RerMessage.OutImportantAdd msgId ->
                                    ( { accM | importants = Set.insert msgId accM.importants }
                                    , accCmds
                                    )

                                Shared.Components.RerMessage.OutImportantRm msgId ->
                                    ( { accM | importants = Set.remove msgId accM.importants }
                                    , accCmds
                                    )

                                Shared.Components.RerMessage.OutDeleteMessage msgId ->
                                    ( { accM | deleteMessageModalId = Just msgId }, accCmds )

                                Shared.Components.RerMessage.OutSelectFreqAndShowMap freq ->
                                    let
                                        ( accM2, accCmds2 ) =
                                            loadCoreStatsAndPushUrl { accM | freqsSelected = [ freq ], unfoldMapBlock = True }
                                    in
                                    ( accM2, accCmds2 :: accCmds )

                                Shared.Components.RerMessage.OutOpenSidebarEdit msgId ->
                                    ( { accM | editSidebar = Just msgId }, accCmds )
                        )
                        ( m2, [] )
                        res.sigs

                ( m3, cmds3 ) =
                    mAndCmds

                cmds =
                    E.batch <| E.map RowsMsg res.cmds :: cmds3
            in
            ( m3
            , cmds
            )

        LoadMessagesNolimit ->
            ( { model
                | loadingInboxMessages = True
                , nolimitShown = True
              }
            , E.getInboxMessages Nothing
                GotInbox
                { sinceIdNoninclusive = Nothing
                , beforeIdNoninclusive = Nothing
                , sinceDateInclusiveMs = Maybe.map Time.posixToMillis model.from.datePosix
                , tillDateInclusiveMs = Maybe.map Time.posixToMillis model.to.datePosix
                , onlyShowUnprocessed = Nothing
                , checkedOnly = Just False
                , selectedGroups = emptyToNothing model.groupsSelected
                , selectedSenders = emptyToNothing model.sendersSelected
                , deniedSenders = Nothing
                , selectedFreqs = emptyToNothing (model.freqsSelected ++ model.filterSelectedAdjacentFreqs)
                , deniedFreqs = Nothing
                , selectedPosts = emptyToNothing model.postsSelected
                , deniedPosts = Nothing
                , selectedAors =
                    model.aorsSelected
                        |> List.filterMap String.toInt
                        |> emptyToNothing
                , selectedCallsigns = emptyToNothing model.callsignsSelected
                , selectedUnits = emptyToNothing model.unitsSelected
                , selectedLocations = emptyToNothing model.locationsSelected
                , includePelengLocations = Just model.includePelengLocations
                , selectedTags = emptyToNothing model.tagsSelected
                , nolimit = Just True
                , orWithExtendedForm = Just model.orWithExtendedForm
                , loadLatest = Nothing
                , returnDuplicates = Nothing
                , orBookmarked = Just model.orBookmarked
                , orImportant = Just model.orImportant
                , orWithCoords = Just model.orWithCoords
                , newestFirst = Just model.newestFirst
                , search = emptySToNothing model.searchInput
                , highlightCallsigns = Nothing
                , highlightSignals = Nothing
                , highlightKeywords = Nothing
                , highlightSearchres = Just True
                , sortBy = Nothing
                , reportTagsOnlyThisUnit = Just model.reportTagsOnlyThisUnit
                , ignoreImportedCoords = Nothing
                , calculateFreqPelengsSummary = Nothing
                , skipGroupStats = Nothing
                , filterTagsOption = Just model.filterTagsOption
                , pageId = Just "rer-analysis"
                , unitsExactMatchOnly = Just model.unitsExactMatchOnly
                , selectedNetworks =
                    model.networksSelected
                        |> List.filterMap String.toInt
                        |> emptyToNothing
                }
            )

        ToggleSortBySenders ->
            let
                next x =
                    if x == "name" then
                        "count"

                    else if x == "count" then
                        "name"

                    else
                        "count"
            in
            ( { model | sendersSortBy = next model.sendersSortBy }
            , E.none
            )

        ToggleSortByFreqs ->
            let
                next x =
                    if x == "name" then
                        "count"

                    else if x == "count" then
                        "name"

                    else
                        "count"
            in
            ( { model | freqsSortBy = next model.freqsSortBy }
            , E.none
            )

        ToggleSortByCallsigns ->
            let
                next x =
                    if x == "name" then
                        "count"

                    else if x == "count" then
                        "name"

                    else
                        "count"
            in
            ( { model | callsignsSortBy = next model.callsignsSortBy }
            , E.none
            )

        ToggleSortByUnits ->
            let
                next x =
                    if x == "name" then
                        "count"

                    else if x == "count" then
                        "name"

                    else
                        "count"
            in
            ( { model | unitsSortBy = next model.unitsSortBy }
            , E.none
            )

        ToggleSortByLocations ->
            let
                next x =
                    if x == "name" then
                        "count"

                    else if x == "count" then
                        "name"

                    else
                        "count"
            in
            ( { model | locationsSortBy = next model.locationsSortBy }
            , E.none
            )

        Refresh ->
            let
                m2 =
                    { model
                        | loadingInboxMessages = True
                    }
            in
            loadCoreStats m2

        ToggleOnlyWithExtendedForm ->
            let
                m2 =
                    { model
                        | orWithExtendedForm = not model.orWithExtendedForm
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , freqs = NeedsReload (RD.withDefault [] model.freqs)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }
            in
            loadCoreStatsAndPushUrl m2

        SetIncludePelengLocations value ->
            let
                m2 =
                    { model | includePelengLocations = not value }
            in
            loadCoreStatsAndPushUrl m2

        SetIncludeOnlyNewFreqs includeOnlyNewFreqs ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    if includeOnlyNewFreqs then
                        ( { model | includeOnlyNewFreqs = True }
                        , E.getFreqs GotStatsFreqs (Query.analysisStatsParams dtFromPosix dtToPosix model)
                        )

                    else
                        loadCoreStatsAndPushUrl { model | includeOnlyNewFreqs = False, freqsSelected = [] }

                _ ->
                    ( model, E.none )

        ToggleOnlyBookmarked ->
            let
                m2 =
                    { model
                        | orBookmarked = not model.orBookmarked
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , freqs = NeedsReload (RD.withDefault [] model.freqs)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }
            in
            loadCoreStatsAndPushUrl m2

        ToggleOnlyImportant ->
            let
                m2 =
                    { model
                        | orImportant = not model.orImportant
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , freqs = NeedsReload (RD.withDefault [] model.freqs)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }
            in
            loadCoreStatsAndPushUrl m2

        ToggleOrWithCoords ->
            let
                m2 =
                    { model
                        | orWithCoords = not model.orWithCoords
                        , locations = NeedsReload (RD.withDefault [] model.locations)
                        , senders = NeedsReload (RD.withDefault [] model.senders)
                        , units = NeedsReload (RD.withDefault [] model.units)
                        , posts = NeedsReload (RD.withDefault [] model.posts)
                        , freqs = NeedsReload (RD.withDefault [] model.freqs)
                        , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                        , groups = NeedsReload (RD.withDefault [] model.groups)
                        , aors = NeedsReload (RD.withDefault [] model.aors)
                        , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                    }
            in
            loadCoreStatsAndPushUrl m2

        ToggleUnfoldAorsFilter ->
            ( { model | unfoldAorsFilter = not model.unfoldAorsFilter }
            , E.none
            )

        ToggleUnfoldGroupsFilter ->
            ( { model | unfoldGroupsFilter = not model.unfoldGroupsFilter }
            , E.none
            )

        ToggleUnfoldSendersFilter ->
            ( { model | unfoldSendersFilter = not model.unfoldSendersFilter }
            , E.none
            )

        ToggleUnfoldFreqsFilter ->
            ( { model | unfoldFreqsFilter = not model.unfoldFreqsFilter }
            , E.none
            )

        ToggleUnfoldCallsignsFilter ->
            ( { model | unfoldCallsignsFilter = not model.unfoldCallsignsFilter }
            , E.none
            )

        ToggleUnfoldUnitsFilter ->
            ( { model | unfoldUnitsFilter = not model.unfoldUnitsFilter }
            , E.none
            )

        UnitsExactMatchOnlyChanged val ->
            let
                m2 =
                    { model | unitsExactMatchOnly = val }
            in
            loadCoreStatsAndPushUrl m2

        CloseEditSidebar ->
            ( { model | editSidebar = Nothing }
            , E.none
            )

        SaveEditSidebar ->
            case model.editSidebar of
                Just msgId ->
                    case List.filter (\( id, _ ) -> id == msgId) model.messages |> List.head of
                        Just ( _, message ) ->
                            ( model
                            , Api.rer_importer_inbox_submit (EditSidebarSaveDone msgId) { messages = [ ( msgId, message ) ] }
                            )

                        Nothing ->
                            ( model, E.none )

                Nothing ->
                    ( model, E.none )

        EditSidebarUpdate msgId updateFn ->
            let
                messages2 =
                    updateMessageField msgId updateFn model.messages
            in
            ( { model | messages = messages2 }, E.none )

        EditSidebarSaveDone _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження повідомлення" e
            )

        EditSidebarSaveDone _ (Ok ()) ->
            ( { model | editSidebar = Nothing }
            , E.none
            )

        ToggleUnfoldLocationsFilter ->
            ( { model | unfoldLocationsFilter = not model.unfoldLocationsFilter }
            , E.none
            )

        ToggleUnfoldTagsFilter ->
            ( { model | unfoldTagsFilter = not model.unfoldTagsFilter }
            , E.none
            )

        ToggleUnfoldNetworksFilter ->
            ( { model | unfoldNetworksFilter = not model.unfoldNetworksFilter }
            , E.none
            )

        ToggleUnfoldPostsFilter ->
            ( { model | unfoldPostsFilter = not model.unfoldPostsFilter }
            , E.none
            )

        ToggleUnfoldSumTable ->
            let
                unfoldSumTable2 =
                    not model.unfoldSumTable

                needsToLoad =
                    case model.sumTable of
                        NotAsked ->
                            True

                        NeedsReload _ ->
                            True

                        _ ->
                            False

                ( m2, eff2 ) =
                    if needsToLoad then
                        loadSumTableOnly { model | unfoldSumTable = unfoldSumTable2 }

                    else
                        ( { model | unfoldSumTable = unfoldSumTable2 }, E.none )
            in
            ( m2, eff2 )

        ToggleUnfoldGraphs ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        m2 =
                            { model | unfoldGraphs = not model.unfoldGraphs }
                    in
                    case ( m2.groupsMessageCountByDay, List.head m2.freqsSelected ) of
                        ( NotAsked, Just freq ) ->
                            if m2.unfoldGraphs then
                                ( { m2 | groupsMessageCountByDay = Loading }
                                , E.getFreqActivityDaily GotFreqActivityDaily
                                    { freq = freq
                                    , sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
                                    , tillDateInclusiveMs = Just (Time.posixToMillis dtToPosix)
                                    }
                                )

                            else
                                ( m2, E.none )

                        ( NeedsReload data, Just freq ) ->
                            if m2.unfoldGraphs then
                                ( m2
                                , E.getFreqActivityDaily GotFreqActivityDaily
                                    { freq = freq
                                    , sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
                                    , tillDateInclusiveMs = Just (Time.posixToMillis dtToPosix)
                                    }
                                )

                            else
                                ( m2, E.none )

                        _ ->
                            ( m2, E.none )

                _ ->
                    ( model, E.none )

        ToggleUnfoldCallsignGraph ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        m2 =
                            { model | unfoldCallsignGraph = not model.unfoldCallsignGraph }
                    in
                    ( m2
                    , cmdLoadCallsignGraph m2 { dtFromPosix = dtFromPosix, dtToPosix = dtToPosix }
                    )

                _ ->
                    ( model, E.none )

        ToggleUnfoldNewCallsignsBlock ->
            let
                unfoldNewCallsignsBlock2 =
                    not model.unfoldNewCallsignsBlock
            in
            ( { model | unfoldNewCallsignsBlock = unfoldNewCallsignsBlock2 }
            , E.none
            )

        ToggleUnfoldMapBlock ->
            let
                inboxReq =
                    getInboxReq model

                unfoldMapBlock =
                    not model.unfoldMapBlock

                ( m2, eff2 ) =
                    case ( model.mapPoints, unfoldMapBlock ) of
                        ( NotAsked, True ) ->
                            ( { model | mapPoints = Loading }
                            , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = inboxReq, mapFilter = Nothing, pageId = Just "rer-analysis" }
                            )

                        ( NeedsReload _, True ) ->
                            ( { model | mapPoints = Loading }
                            , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = inboxReq, mapFilter = Nothing, pageId = Just "rer-analysis" }
                            )

                        _ ->
                            ( model, E.none )
            in
            ( { m2
                | unfoldMapBlock = unfoldMapBlock
              }
            , eff2
            )

        GotCallsignGraph (Err e) ->
            ( { model | loadingCallsignGraph = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження графу позивних" e
            )

        GotCallsignGraph (Ok graphDataAndMeta) ->
            ( { model
                | loadingCallsignGraph = False
                , callsignGraph = Just graphDataAndMeta
              }
            , E.initNetjsonGraph
                { graphDataAndMeta = graphDataAndMeta
                , elemId = "callsign-graph-div"
                }
            )

        ToggleCallsignGraphNolimit ->
            let
                m2 =
                    { model | callsignGraphNolimit = not model.callsignGraphNolimit }
            in
            loadCoreStats m2

        GotSumTable (Err e) ->
            ( { model | sumTable = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження зведеної таблиці" e
            )

        GotSumTable (Ok sumTable) ->
            let
                m2 =
                    { model
                        | sumTable = Success sumTable
                    }
            in
            ( m2
            , E.getCallsignsInfo GotGdocCallsignsForSumTable { callsigns = sumTable.rows |> List.concatMap (\row -> row.callsigns) }
            )

        DownloadXlsx ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        analysisPs =
                            Query.analysisStatsParams dtFromPosix dtToPosix model
                    in
                    ( model
                    , E.getFreqsSummaryTableXlsx DownloadXlsxDone
                        analysisPs
                    )

                _ ->
                    ( model, E.none )

        DownloadXlsxDone (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження Excel файлу" e
            )

        DownloadXlsxDone (Ok bs) ->
            ( model
            , E.downloadFile
                ("summary-table-"
                    ++ model.from.dateStr
                    ++ "T"
                    ++ model.from.timeStr
                    ++ "-"
                    ++ model.to.dateStr
                    ++ "T"
                    ++ model.to.timeStr
                    ++ ".xlsx"
                )
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                bs
            )

        DownloadKmz ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        analysisPs =
                            Query.analysisStatsParams dtFromPosix dtToPosix model
                    in
                    ( model
                    , E.downloadKmz DownloadKmzDone
                        analysisPs
                    )

                _ ->
                    ( model, E.none )

        DownloadKmzDone (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження KMZ файлу" e
            )

        DownloadKmzDone (Ok bs) ->
            ( model
            , E.downloadFile
                ("signals-"
                    ++ model.from.dateStr
                    ++ "T"
                    ++ model.from.timeStr
                    ++ "-"
                    ++ model.to.dateStr
                    ++ "T"
                    ++ model.to.timeStr
                    ++ ".kmz"
                )
                "application/vnd.google-earth.kmz"
                bs
            )

        DownloadGeojson ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        analysisPs =
                            Query.analysisStatsParams dtFromPosix dtToPosix model
                    in
                    ( model
                    , E.downloadGeojson DownloadGeojsonDone analysisPs
                    )

                _ ->
                    ( model, E.none )

        DownloadGeojsonDone (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження GeoJSON файлу" e
            )

        DownloadGeojsonDone (Ok bs) ->
            ( model
            , E.downloadFile
                ("signals-"
                    ++ model.from.dateStr
                    ++ "T"
                    ++ model.from.timeStr
                    ++ "-"
                    ++ model.to.dateStr
                    ++ "T"
                    ++ model.to.timeStr
                    ++ ".geojson"
                )
                "application/geo+json"
                bs
            )

        GetCorrelatedFreqs ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    ( { model | correlatedFreqs = Loading }
                    , if List.length model.freqsSelected == 0 then
                        E.none

                      else
                        let
                            analysisPs =
                                Query.analysisStatsParams dtFromPosix dtToPosix model
                        in
                        E.getCorrelatedFreqs GotCorrelatedFreqs analysisPs
                    )

                _ ->
                    ( model, E.none )

        GotCorrelatedFreqs (Ok rsp) ->
            ( { model | correlatedFreqs = Success rsp.freqs }
            , E.none
            )

        GotCorrelatedFreqs (Err e) ->
            ( { model | correlatedFreqs = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження суміжних частот" e
            )

        ClearAllFilters ->
            case model.now of
                Just now ->
                    let
                        m2 =
                            Query.updModelFromQueryState model Query.emptyQueryState

                        ( from, to ) =
                            Shared.Components.DateTime.initAnalysisRanges
                                { from = m2.from
                                , to = m2.to
                                , zone = shared.timeZone
                                , now = now
                                }

                        m3 =
                            { m2
                                | from = from
                                , to = to
                                , dateRangePicker = Shared.Components.DateRangePicker.initFromData from to
                            }
                    in
                    loadCoreStatsAndPushUrl m3

                _ ->
                    ( model, E.none )

        ToggleNewestFirst ->
            let
                m2 =
                    { model | newestFirst = not model.newestFirst }
            in
            loadCoreStats m2

        EditUnitName freq unit ->
            ( { model | editUnitMap = Dict.insert ( freq, unit ) (Just unit) model.editUnitMap }
            , E.none
            )

        EditUnitCancel freq unit ->
            ( { model | editUnitMap = Dict.remove ( freq, unit ) model.editUnitMap }
            , E.none
            )

        EditUnitFormChanged freq unit str ->
            ( { model | editUnitMap = Dict.insert ( freq, unit ) (Just str) model.editUnitMap }
            , E.none
            )

        EditUnitSave freq unit ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    case Dict.get ( freq, unit ) model.editUnitMap of
                        Just (Just unitNew) ->
                            let
                                analysisPs =
                                    Query.analysisStatsParams dtFromPosix dtToPosix model

                                req : B.EditFreqUnitNameReq
                                req =
                                    { analysisStatsReq = analysisPs
                                    , freq = freq
                                    , unit = unit
                                    , unitNew = unitNew
                                    , search = Just model.searchInput
                                    , filterTagsOption = Just model.filterTagsOption
                                    }
                            in
                            ( { model | editUnitMap = Dict.remove ( freq, unit ) model.editUnitMap }
                            , E.editFreqUnitName (EditUnitSaveDone freq unit unitNew) req
                            )

                        _ ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        EditUnitSaveDone _ _ _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження назви підрозділу" e
            )

        EditUnitSaveDone freq unit_ unitNew (Ok ()) ->
            --  loadStats model
            -- be optimistic!
            let
                m2 =
                    case model.sumTable of
                        Success sumTable ->
                            { model | sumTable = Success (updSt sumTable) }

                        _ ->
                            model

                updSt st =
                    { st | rows = List.map updRow st.rows }

                updRow row =
                    if row.freq == freq then
                        let
                            units2 =
                                unique (List.map updUnit row.units)
                        in
                        { row | units = units2 }

                    else
                        row

                updUnit unit =
                    if unit == unit_ then
                        unitNew

                    else
                        unit
            in
            ( m2, E.none )

        SaveFilterExpandToggle ->
            ( { model | saveFilterExpanded = not model.saveFilterExpanded }
            , E.none
            )

        SaveFilterInp val ->
            ( { model | saveFilterInp = val }
            , E.none
            )

        SaveFilterDo ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        analysisPs =
                            Query.analysisStatsParams dtFromPosix dtToPosix model

                        req : B.SavedFilterUpsertReq
                        req =
                            { req = analysisPs
                            , name = model.saveFilterInp
                            }
                    in
                    ( { model | saveFilterInProgress = True }
                    , E.saveAnalysisFilter SaveFilterDone req
                    )

                _ ->
                    ( model, E.none )

        SaveFilterDone (Err e) ->
            ( { model | saveFilterInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження фільтра" e
            )

        SaveFilterDone (Ok filters) ->
            ( { model
                | saveFilterInProgress = False
                , savedFilters = List.map (\x -> ( x.id, x )) filters
                , saveFilterExpanded = False
                , saveFilterInp = ""
              }
            , E.none
            )

        SavedFiltersGot (Err e) ->
            ( { model | savedFiltersLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження збережених фільтрів" e
            )

        SavedFiltersGot (Ok filters) ->
            ( { model
                | savedFiltersLoading = False
                , savedFilters = List.map (\x -> ( x.id, x )) filters
              }
            , E.none
            )

        SavedFilterMenuToggle id ->
            ( { model
                | savedFilterMenuOpen =
                    if model.savedFilterMenuOpen == Just id then
                        Nothing

                    else
                        Just id
              }
            , E.none
            )

        SavedFilterMenuClose ->
            ( { model | savedFilterMenuOpen = Nothing }
            , E.none
            )

        SavedFilterEdit id ->
            case findK id model.savedFilters of
                Nothing ->
                    ( model, E.none )

                Just savedFilter ->
                    ( { model
                        | savedFilterEditInp =
                            Dict.insert id savedFilter.name model.savedFilterEditInp
                        , savedFilterMenuOpen = Nothing
                      }
                    , E.none
                    )

        SavedFilterEditCancel id ->
            ( { model | savedFilterEditInp = Dict.remove id model.savedFilterEditInp }
            , E.none
            )

        SavedFilterEditInp id str ->
            ( { model | savedFilterEditInp = Dict.insert id str model.savedFilterEditInp }
            , E.none
            )

        SavedFilterUpdate id ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    case findK id model.savedFilters of
                        Nothing ->
                            ( model, E.none )

                        Just savedFilter ->
                            let
                                analysisPs =
                                    Query.analysisStatsParams dtFromPosix dtToPosix model

                                req : B.SavedFilterUpsertReq
                                req =
                                    { req = analysisPs
                                    , name = savedFilter.name
                                    }
                            in
                            ( { model
                                | saveFilterInProgress = True
                              }
                            , E.saveAnalysisFilter SaveFilterDone req
                            )

                _ ->
                    ( model, E.none )

        SavedFilterRename id ->
            case Dict.get id model.savedFilterEditInp of
                Nothing ->
                    ( model, E.none )

                Just name ->
                    ( { model
                        | savedFilterEditInp = Dict.remove id model.savedFilterEditInp
                        , savedFilters = updateV id (\x -> { x | name = name }) model.savedFilters
                      }
                    , E.renameSavedAnalysisFilter SavedFilterRenameDone
                        { id = id, name = name }
                    )

        SavedFilterRenameDone (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка перейменування фільтра" e
            )

        SavedFilterRenameDone (Ok ()) ->
            ( model, E.none )

        SavedFilterDelete id ->
            ( { model
                | savedFilterEditInp = Dict.remove id model.savedFilterEditInp
                , savedFilterMenuOpen = Nothing
                , savedFilters = List.filter (\( k, _ ) -> k /= id) model.savedFilters
              }
            , E.deleteSavedAnalysisFilter SavedFilterDeleteDone id
            )

        SavedFilterDeleteDone (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення фільтра" e
            )

        SavedFilterDeleteDone (Ok ()) ->
            ( model, E.none )

        SavedFilterSelect id ->
            case findK id model.savedFilters of
                Nothing ->
                    ( model, E.none )

                Just savedFilter ->
                    let
                        m2 =
                            Query.updModelFromSavedFilter model savedFilter
                    in
                    loadCoreStats m2

        SearchInput str ->
            ( { model | searchInput = str }
            , E.none
            )

        SearchDo ->
            loadCoreStatsAndPushUrl
                { model
                    | locations = NeedsReload (RD.withDefault [] model.locations)
                    , senders = NeedsReload (RD.withDefault [] model.senders)
                    , units = NeedsReload (RD.withDefault [] model.units)
                    , freqs = NeedsReload (RD.withDefault [] model.freqs)
                    , posts = NeedsReload (RD.withDefault [] model.posts)
                    , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                    , groups = NeedsReload (RD.withDefault [] model.groups)
                    , aors = NeedsReload (RD.withDefault [] model.aors)
                    , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                }

        SearchInputKeyDown key ->
            if key == 13 then
                loadCoreStatsAndPushUrl model

            else
                ( model, E.none )

        SearchReset ->
            let
                m2 =
                    { model | searchInput = "" }
            in
            loadCoreStatsAndPushUrl
                { m2
                    | locations = NeedsReload (RD.withDefault [] model.locations)
                    , senders = NeedsReload (RD.withDefault [] model.senders)
                    , units = NeedsReload (RD.withDefault [] model.units)
                    , freqs = NeedsReload (RD.withDefault [] model.freqs)
                    , posts = NeedsReload (RD.withDefault [] model.posts)
                    , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                    , groups = NeedsReload (RD.withDefault [] model.groups)
                    , aors = NeedsReload (RD.withDefault [] model.aors)
                    , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
                }

        SelectTab tab ->
            ( { model | menuTab = tab }
            , E.none
            )

        SelAorMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selAorState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.aorsSelected imodel2

                        m2 =
                            { model
                                | aorsSelected = updatedSelectedItems
                                , selAorState = state
                            }

                        filterInteraction =
                            FiltersReloading.handleFilterState model.focusedFilterItemsBeforeChange mAction updatedSelectedItems model.aors

                        ( m3, eff3 ) =
                            case filterInteraction of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.aorsSelected, aors = Loading }
                                    , E.getAors GotStatsAors (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.aorsSelected }
                                    , E.none
                                    )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState AorsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelAorMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelGroupMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selGroupState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.groupsSelected imodel2

                        m2 =
                            { model
                                | selGroupState = state
                                , groupsSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.groupsSelected m2.groups

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.groupsSelected, groups = Loading }
                                    , E.getGroups GotStatsGroups (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.groupsSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState GroupsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelGroupMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelSenderMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selSenderState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.sendersSelectedNames imodel2

                        m2 =
                            { model
                                | selSenderState = state
                                , sendersSelectedNames = updatedSelectedItems
                            }

                        m3 =
                            { m2
                                | sendersSelected = Pages_.RerDuty.Waterfall.Filters.extractSendersIds model.sendersSelectedNames m2.sendersSelectedNames m2.profiles m2.sendersSelected
                            }

                        result =
                            FiltersReloading.handleFilterState m3.focusedFilterItemsBeforeChange mAction m3.sendersSelected m3.senders

                        ( m4, eff4 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m3 | focusedFilterItemsBeforeChange = Just model.sendersSelectedNames, senders = Loading }
                                    , E.getSenders GotStatsSenders (Query.analysisStatsParams dtFromPosix dtToPosix m3)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m3 | focusedFilterItemsBeforeChange = Just model.sendersSelectedNames }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m3

                                        m1_ =
                                            invalidateFiltersState SendersFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m3 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m3, E.none )
                    in
                    ( m4
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelSenderMsg icmd
                        , eff4
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelFreqMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selFreqState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.freqsSelected imodel2

                        m2 =
                            { model
                                | selFreqState = state
                                , freqsSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.freqsSelected m2.freqs

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.freqsSelected, freqs = Loading }
                                    , E.getFreqs GotStatsFreqs (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.freqsSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState FreqsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )

                        filterSelectedAdjacentFreqs =
                            Utils.findAllAdjacentFreqs (RD.withDefault [] m3.freqs |> List.map .freq) m3.freqsSelected model.adjacentFreqsRangeSelect.selected
                    in
                    ( { m3 | filterSelectedAdjacentFreqs = filterSelectedAdjacentFreqs }
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelFreqMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelCallsignMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selCallsignState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.callsignsSelected imodel2

                        m2 =
                            { model
                                | selCallsignState = state
                                , callsignsSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.callsignsSelected m2.callsigns

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.callsignsSelected, callsigns = Loading }
                                    , E.getCallsigns GotStatsCallsigns (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.callsignsSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState CallsignsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelCallsignMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelLocationMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selLocationState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.locationsSelected imodel2

                        m2 =
                            { model
                                | selLocationState = state
                                , locationsSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.locationsSelected m2.locations

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.locationsSelected, locations = Loading }
                                    , E.getLocations GotStatsLocations (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.locationsSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState LocationsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelLocationMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelPostMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selPostState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.postsSelected imodel2

                        m2 =
                            { model
                                | selPostState = state
                                , postsSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.postsSelected m2.posts

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.postsSelected, posts = Loading }
                                    , E.getPosts GotStatsPosts (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.postsSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState PostsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelPostMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelUnitMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selUnitState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.unitsSelected imodel2

                        m2 =
                            { model
                                | selUnitState = state
                                , unitsSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.unitsSelected m2.units

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.unitsSelected, units = Loading }
                                    , E.getUnits2 GotStatsUnits (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.unitsSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState UnitsFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelUnitMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        SelNetworkMsg imsg ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        ( mAction, imodel2, icmd ) =
                            Select.update imsg model.selNetworkState

                        ( updatedSelectedItems, state ) =
                            Utils.Select.multiUpdMenuOpen mAction model.networksSelected imodel2

                        m2 =
                            { model
                                | selNetworkState = state
                                , networksSelected = updatedSelectedItems
                            }

                        result =
                            FiltersReloading.handleFilterState m2.focusedFilterItemsBeforeChange mAction m2.networksSelected m2.networksStats

                        ( m3, eff3 ) =
                            case result of
                                BeforeInteraction Outdated ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.networksSelected, networksStats = Loading }
                                    , E.getNetworks GotStatsNetworks (Query.analysisStatsParams dtFromPosix dtToPosix m2)
                                    )

                                BeforeInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Just model.networksSelected }, E.none )

                                AfterInteraction Outdated ->
                                    let
                                        ( m_, eff_ ) =
                                            loadCoreStatsAndPushUrl m2

                                        m1_ =
                                            invalidateFiltersState NetworksFilter m_
                                    in
                                    ( { m1_ | focusedFilterItemsBeforeChange = Nothing }, eff_ )

                                AfterInteraction UpToDate ->
                                    ( { m2 | focusedFilterItemsBeforeChange = Nothing }, E.none )

                                _ ->
                                    ( m2, E.none )
                    in
                    ( m3
                    , E.batch <|
                        [ E.sendCmd <| Cmd.map SelNetworkMsg icmd
                        , eff3
                        ]
                    )

                _ ->
                    ( model, E.none )

        FilterUnitsInp s ->
            ( { model | filterUnits = s }, E.none )

        GotTags (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження тегів" e
            )

        GotTags (Ok vs) ->
            ( { model | tags = vs }
            , E.none
            )

        ReportTemplateSelect template ->
            ( { model | reportTemplate = template }
            , E.none
            )

        ToggleReportConstructor ->
            ( { model | showReportConstructor = not model.showReportConstructor }
            , E.none
            )

        CloseReportConstructor ->
            ( { model | showReportConstructor = False }
            , E.none
            )

        ReportTagsOnlyThisUnitToggle ->
            ( { model | reportTagsOnlyThisUnit = not model.reportTagsOnlyThisUnit }
            , E.none
            )

        ReportDownloadDocx ->
            ( { model | reportDownloadInProgress = True }
            , E.getDocxReportForDownload ReportDownloadDocxDone
                { kind = reportTemplateToString model.reportTemplate
                , reportType = reportTemplateToApiType model model.reportTemplate
                , req = getInboxReq model
                }
            )

        ReportDownloadDocxDone (Err e) ->
            ( { model | reportDownloadInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження звіту" e
            )

        ReportDownloadDocxDone (Ok bytes) ->
            let
                m2 =
                    { model | reportDownloadInProgress = False }

                extension =
                    case model.reportTemplate of
                        RTTags ->
                            "docx"

                        RTMouse ->
                            "docx"

                        RTPelengs ->
                            "xlsx"

                        RTBabak ->
                            "docx"

                        RTInterception ->
                            "xlsx"

                        RTPostsDocx ->
                            "docx"

                        RTSenders _ ->
                            "xlsx"

                        RTNaUshnom ->
                            "docx"

                        RTReo ->
                            "docx"

                        RTDigest ->
                            "docx"

                -- filename like "report_2023-07-17-12-00_2023-07-18-12-00"
                fname =
                    "report_"
                        ++ (model.from.datePosix
                                |> mmap (Utils.Time.renderDateTimeF6 shared.timeZone)
                                |> def ""
                           )
                        ++ "_"
                        ++ (model.to.datePosix
                                |> mmap (Utils.Time.renderDateTimeF6 shared.timeZone)
                                |> def ""
                           )
                        ++ "."
                        ++ extension
            in
            ( m2
            , E.downloadFile fname "application/vnd.openxmlformats-officedocument.wordprocessingml.document" bytes
            )

        ScrollMessagesToTop ->
            ( model
            , E.scrollToElement
                { elemId = "messages-div"
                , x = 0
                , y = 0
                }
            )

        GotBookmarks (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження закладок" e
            )

        GotBookmarks (Ok vs) ->
            ( { model | bookmarks = (List.map .messageId >> Set.fromList) vs }, E.none )

        GotImportants (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження важливих повідомлень" e
            )

        GotImportants (Ok vs) ->
            ( { model | importants = (List.map .messageId >> Set.fromList) vs }, E.none )

        LoadMoreMessages ->
            let
                mLastMsgId =
                    model.messages |> ListX.last |> mmap Tuple.first

                mLastDate =
                    model.messages |> ListX.last |> mmap (Tuple.second >> .timestamp)
            in
            case ( mLastMsgId, mLastDate ) of
                ( Just lastMsgId, Just lastDate ) ->
                    let
                        req =
                            getInboxReq model

                        req2 =
                            if model.newestFirst then
                                { req
                                    | beforeIdNoninclusive = Just lastMsgId
                                    , tillDateInclusiveMs = lastDate
                                }

                            else
                                { req
                                    | sinceIdNoninclusive = Just lastMsgId
                                    , sinceDateInclusiveMs = lastDate
                                }
                    in
                    ( { model | loadingInboxMessages = True }
                    , E.getInboxMessages Nothing GotInboxMore req2
                    )

                _ ->
                    ( model, E.none )

        LoadNewCallsignStats ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        analysisPs =
                            Query.analysisStatsParams dtFromPosix dtToPosix model
                    in
                    ( { model | newCallsignsLoading = True }
                    , E.getNewCallsigns GotNewCallsignStats analysisPs
                    )

                _ ->
                    ( model, E.none )

        GotNewCallsignStats (Err e) ->
            ( { model | newCallsignsLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження нових позивних" e
            )

        GotNewCallsignStats (Ok vs) ->
            ( { model
                | newCallsignsRsp = Just vs
                , newCallsignsLoading = False
              }
            , E.none
            )

        GotMessagesComments (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження коментарів" e
            )

        GotMessagesComments (Ok comments) ->
            let
                m2 =
                    { model | messageComments = comments.data |> List.foldl (\comment acc -> Dict.insert comment.messageId comment.comments acc) model.messageComments }

                eff3 =
                    loadNewUsers m2
            in
            ( m2, E.batch [ eff3 ] )

        GotUserInfo _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації користувача" e
            )

        GotUserInfo login (Ok user_) ->
            let
                m2 =
                    { model | users = Dict.insert login (Just user_) model.users }
            in
            ( m2, E.none )

        GetSumTable ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    let
                        analysisPs =
                            Query.analysisStatsParams dtFromPosix dtToPosix model

                        m2 =
                            { model | sumTable = Loading }
                    in
                    ( m2, E.getFreqsSummaryTable GotSumTable analysisPs )

                _ ->
                    ( model, E.none )

        DeleteMessageConfirm ->
            case model.deleteMessageModalId of
                Just id_ ->
                    ( model, E.deleteMessage (DeleteMessageDone id_) { id = id_ } )

                Nothing ->
                    ( model, E.none )

        DeleteMessageCancel ->
            ( { model | deleteMessageModalId = Nothing }, E.none )

        DeleteMessageDone id (Ok ()) ->
            ( { model | messages = model.messages |> List.filter (\( id_, _ ) -> id_ /= id), deleteMessageModalId = Nothing }, E.none )

        DeleteMessageDone _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення повідомлення" err
            )

        GotGdocCallsignsForSumTable (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації позивних" e
            )

        GotGdocCallsignsForSumTable (Ok callsigns) ->
            let
                m2 =
                    List.foldl
                        (\callsign m ->
                            { m
                                | callsignsInfoSumTable =
                                    Dict.insert callsign.callsign
                                        callsign.res
                                        m.callsignsInfoSumTable
                            }
                        )
                        model
                        callsigns
            in
            ( m2, E.none )

        GotMapPoints (Ok res) ->
            ( { model | mapPoints = Success res.points, mapNetworkUnits = res.networkUnits }
            , E.none
            )

        GotMapPoints (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок карти" err
            )

        MapClosed ->
            ( { model | unfoldMapBlock = False }, E.none )

        MapPeriodChanged { startDate, endDate } ->
            let
                m2 =
                    { model | mapPoints = Loading }

                inboxReq =
                    getInboxReq model

                inboxReq2 =
                    { inboxReq | sinceDateInclusiveMs = Just startDate, tillDateInclusiveMs = Just endDate }
            in
            ( m2
            , E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = inboxReq2, mapFilter = Nothing, pageId = Just "rer-analysis" }
            )

        LoadMessagesForMap ids ->
            let
                m2 =
                    { model | mapOpenMessages = Loading }
            in
            ( m2, E.getMessagesByIds GotMessagesForMap { messageIds = ids } )

        GotMessagesForMap (Ok rsp) ->
            ( { model | mapOpenMessages = Success rsp.messages }, E.none )

        GotMessagesForMap (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження повідомлень для карти" err
            )

        GotFreqActivityDaily (Ok r) ->
            ( { model | groupsMessageCountByDay = Success r }, E.none )

        GotFreqActivityDaily (Err err) ->
            ( { model | groupsMessageCountByDay = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності частот" err
            )

        SetUnitFilterFromMap unitName ->
            if List.member unitName model.unitsSelected then
                let
                    m1 =
                        { model | unitsSelected = List.filter (\x -> x /= unitName) model.unitsSelected }

                    inboxReq =
                        getInboxReq m1

                    ( m2, eff2 ) =
                        loadCoreStatsAndPushUrl m1
                in
                ( m2
                , E.batch
                    [ E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = { inboxReq | returnDuplicates = Just False }, mapFilter = Nothing, pageId = Just "rer-analysis" }
                    , eff2
                    ]
                )

            else
                let
                    m1 =
                        { model | unitsSelected = [ unitName ], mapPoints = Loading }

                    inboxReq =
                        getInboxReq m1

                    ( m2, eff2 ) =
                        loadCoreStatsAndPushUrl m1
                in
                ( m2
                , E.batch
                    [ E.getMessagesMapPoints GotMapPoints { inboxItemsFilter = { inboxReq | returnDuplicates = Just False }, mapFilter = Nothing, pageId = Just "rer-analysis" }
                    , eff2
                    ]
                )

        SelectFilterAdjacentFreqsRange imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.adjacentFreqsRangeSelect.state

                adjacentFreqsRangeSelect =
                    model.adjacentFreqsRangeSelect

                a2 =
                    { adjacentFreqsRangeSelect
                        | state = imodel2
                        , selected =
                            case mAction of
                                Just (Select.Select i) ->
                                    i

                                _ ->
                                    adjacentFreqsRangeSelect.selected
                    }

                m2 =
                    { model | adjacentFreqsRangeSelect = a2 }

                ( m4, eff4 ) =
                    case mAction of
                        Just (Select.Select _) ->
                            let
                                m3 =
                                    { m2
                                        | filterSelectedAdjacentFreqs =
                                            Utils.findAllAdjacentFreqs (RD.withDefault [] model.freqs |> List.map .freq) model.freqsSelected a2.selected
                                    }
                            in
                            loadCoreStatsAndPushUrl m3

                        _ ->
                            ( m2, E.none )
            in
            ( m4
            , E.batch
                [ E.sendCmd <|
                    Cmd.map SelectFilterAdjacentFreqsRange icmd
                , eff4
                ]
            )

        SelectReportAdjacentFreqsRange imsg ->
            let
                ( mAction, imodel2, _ ) =
                    Select.update imsg model.reportAdjacentFreqsRangeSelect.state

                reportAdjacentFreqsRangeSelect =
                    model.reportAdjacentFreqsRangeSelect

                a2 =
                    { reportAdjacentFreqsRangeSelect
                        | state = imodel2
                        , selected =
                            case mAction of
                                Just (Select.Select i) ->
                                    i

                                _ ->
                                    reportAdjacentFreqsRangeSelect.selected
                    }

            in
            ( { model | reportAdjacentFreqsRangeSelect = a2 }, E.none )

        GroupsActivityPeriodChanged period ->
            case ( model.from.datePosix, model.to.datePosix, List.head model.freqsSelected ) of
                ( Just dtFromPosix, Just dtToPosix, Just freq ) ->
                    let
                        sinceDate =
                            getSinceDateForGroupsActivity period dtFromPosix dtToPosix
                    in
                    ( { model | groupsMessageCountByDay = RD.markOutdated model.groupsMessageCountByDay, groupsActivityPeriod = period }
                    , E.getFreqActivityDaily GotFreqActivityDaily
                        { freq = freq
                        , sinceDateInclusiveMs = Time.posixToMillis sinceDate
                        , tillDateInclusiveMs = Just (Time.posixToMillis dtToPosix)
                        }
                    )

                _ ->
                    ( model, E.none )

        FilterTagsOptionChanged checked ->
            let
                m1 =
                    { model
                        | filterTagsOption =
                            if checked then
                                B.AllTags

                            else
                                B.OneOfTags
                    }
            in
            loadCoreStats m1


updateMessageField : Int -> (B.InboxMessage -> B.InboxMessage) -> List ( Int, B.InboxMessage ) -> List ( Int, B.InboxMessage )
updateMessageField msgId updateFn messages =
    List.map
        (\( id, message ) ->
            if id == msgId then
                ( id, updateFn message )

            else
                ( id, message )
        )
        messages


getSinceDateForGroupsActivity period dtFromPosix dtToPosix =
    case period of
        FilterSelectedRange ->
            dtFromPosix

        Month ->
            Utils.Time.xDaysAgo 30 dtToPosix

        Quarter ->
            Utils.Time.xDaysAgo 90 dtToPosix

        Year ->
            Utils.Time.xDaysAgo 365 dtToPosix


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none

reportTemplateToApiType : Model -> ReportTemplate -> Maybe B.ReportType
reportTemplateToApiType model template =
    case template of
        RTTags ->
            Just B.Tags

        RTMouse ->
            Just B.Mouse

        RTPelengs ->
            Just B.Pelengs

        RTBabak ->
            Just B.Babak

        RTInterception ->
            Just B.Interception

        RTPostsDocx ->
            Nothing

        RTSenders y ->
            if y == Senders then
                Just (B.Senders { aggregation = B.ByProfile })

            else
                Just (B.Senders { aggregation = B.ByPost })

        RTNaUshnom ->
            Just B.Naushnom

        RTReo ->
            Just (B.Reo { adjacentFreqsDistance = model.reportAdjacentFreqsRangeSelect.selected })

        RTDigest ->
            Just B.Digest


--VIEW


view : Shared.Model -> B.User -> Route () -> Model -> View Msg
view shared user route model =
    { title = "РЕР-аналіз"
    , body =
        [ div []
            [ Pages_.RerAnalysis.MainBody.view user model shared route
            ]
        , Sidebar.view (model.editSidebar /= Nothing) CloseEditSidebar (editSidebarContent model)
        ]
    }



-- SIDEBARS


editSidebarContent : Model -> List (Html Msg)
editSidebarContent model =
    case model.editSidebar of
        Just msgId ->
            case List.filter (\( id, _ ) -> id == msgId) model.messages |> List.head of
                Just ( _, message ) ->
                    [ div [ class "flex flex-col h-full" ]
                        [ div [ class "p-4 border-b border-b-border" ]
                            [ h3 [ class "text-lg font-semibold" ] [ text "Редагування додаткових полів" ]
                            ]
                        , div [ class "flex-1 overflow-y-auto p-4 space-y-4" ]
                            [ div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Дата" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.date
                                    , placeholder "YYYY-MM-DD"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | date = Just v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Час" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.time
                                    , placeholder "HH:MM"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | time = Just v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Частота" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.freq
                                    , placeholder "Частота"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | freq = Just v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Координати" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.coords
                                    , placeholder "Координати"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | coords = Just v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Пост" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.post
                                    , placeholder "Пост"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | post = Just v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Підрозділ" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.unit
                                    , placeholder "Підрозділ"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | unit = Just v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium mb-2" ] [ text "Локація" ]
                                , input
                                    [ type_ "text"
                                    , class "w-full px-3 py-2 border rounded"
                                    , value <| Maybe.withDefault "" message.location
                                    , placeholder "Локація"
                                    , onInput <| \v -> EditSidebarUpdate msgId (\m -> { m | location = Just v })
                                    ]
                                    []
                                ]
                            ]
                        , div [ class "p-4 border-t border-t-border flex gap-2 justify-end" ]
                            [ Button.new { label = "Скасувати", onClick = CloseEditSidebar }
                                |> Button.withSecondary
                                |> Button.view
                            , Button.new { label = "Зберегти", onClick = SaveEditSidebar }
                                |> Button.view
                            ]
                        ]
                    ]

                Nothing ->
                    [ div [ class "p-4" ] [ text "Повідомлення не знайдено" ] ]

        Nothing ->
            []
