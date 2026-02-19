module Pages.RerFreqs exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Auth
import Core.Types as Types exposing (ApiError, GroupsActivityPerDayRsp)
import Core.UnitHierarchy
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Http
import Json.Encode as Encode
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import PagePorts.RerFreqsPorts as Ports
import Pages_.RerFreqs.FilterPanel as FilterPanel
import Pages_.RerFreqs.Model exposing (NetworkWorkflowStatus(..), NetworkWorkflowTab(..), ShowAllPopupFor(..), TextLocation(..))
import Pages_.RerFreqs.Msg exposing (Msg(..))
import Pages_.RerFreqs.NetworkWorkflow as NetworkWorkflow
import Pages_.RerFreqs.UnitsFilterSidebar
import Pages_.RerFreqs.Utils as Utils
import Process
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.ActionMenu
import Shared.Components.Button as Button
import Shared.Components.DateTime
import Shared.Components.Popup
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Watermark as Watermark exposing (Watermark)
import Shared.Model exposing (isDarkMode)
import Task
import Time exposing (Posix)
import Time.Extra
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.NetworksUtils as NetworksUtils
import Utils.Modulations as Modulations
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)
import View exposing (View)


type alias Model =
    Pages_.RerFreqs.Model.Model


type alias Msg =
    Pages_.RerFreqs.Msg.Msg


init : () -> ( Model, Effect Msg )
init _ =
    let
        m2 : Model
        m2 =
            { now = Nothing
            , loading = False
            , loadingMore = False
            , currentRequestTracker = Nothing
            , requestCounter = 0
            , newOnly = False
            , includeNonActive = False
            , freqs = []
            , from = Shared.Components.DateTime.init ()
            , to = Shared.Components.DateTime.init ()
            , filterState =
                { freq = ""
                , unit = ""
                , callsigns = []
                }
            , filterStateDebounce = Debounce.init
            , loadingUnitStats = False
            , unitStats = []
            , locationTexts = Dict.empty
            , openMapRowId = Nothing
            , callsignsByFreq = Dict.empty
            , callsignsInfo = Dict.empty
            , networksExtra = Dict.empty
            , callsigns = []
            , sortingOrder = B.MessageCountDesc
            , altUnitsByFreq = Dict.empty
            , groupsMessageCountByDay = Dict.empty
            , noMoreToLoad = True
            , rowShowAllPopupStatus = Nothing
            , selCallsignState = Select.initState (Select.selectIdentifier "selCallsignState")
            , callsignSearchQuery = ""
            , callsignSearchDebounce = Debounce.init
            , callsignSearchResults = NotAsked
            , networkWorkflowStatus = NotStarted
            , networkAddLoading = False
            , addKindSelect =
                { state = Select.initState (Select.selectIdentifier "add-network-kind-state")
                , items =
                    NetworksUtils.networkKinds
                        |> List.map
                            (\kind ->
                                Select.basicMenuItem
                                    { item = kind
                                    , label = NetworksUtils.networkKindToLabel kind
                                    }
                            )
                , selected = NetworksUtils.VHF
                }
            , networkDialogUnitSelect =
                { state =
                    Select.initState
                        (Select.selectIdentifier "add-network-unit-state")
                , items =
                    []
                , selected = Nothing
                }
            , addModulationSelect =
                { state = Select.initState (Select.selectIdentifier "add-network-transtype-state")
                , items = []
                , selected = Nothing
                }
            , addExistingModulationSelect =
                { state = Select.initState (Select.selectIdentifier "add-existing-network-transtype-state")
                , items = []
                , selected = Nothing
                }
            , addExistingKindSelect =
                { state = Select.initState (Select.selectIdentifier "add-existing-network-kind-state")
                , items =
                    NetworksUtils.networkKinds
                        |> List.map
                            (\kind ->
                                Select.basicMenuItem
                                    { item = kind
                                    , label = NetworksUtils.networkKindToLabel kind
                                    }
                            )
                , selected = NetworksUtils.VHF
                }
            , addExistingActiveFrom = Nothing
            , addExistingActiveTo = Nothing
            , editKindSelect =
                { state = Select.initState (Select.selectIdentifier "edit-network-kind-state")
                , items =
                    NetworksUtils.networkKinds
                        |> List.map
                            (\kind ->
                                Select.basicMenuItem
                                    { item = kind
                                    , label = NetworksUtils.networkKindToLabel kind
                                    }
                            )
                , selected = NetworksUtils.VHF
                }
            , editModulationSelect =
                { state = Select.initState (Select.selectIdentifier "edit-network-transtype-state")
                , items = []
                , selected = Nothing
                }
            , modulations = NotAsked
            , freqGroupsActivityForNetworkAdd = NotAsked
            , addPostsSelect =
                { state = Select.initState (Select.selectIdentifier "add-network-posts-state")
                , selected = []
                , items = []
                }
            , editPostsSelect =
                { state = Select.initState (Select.selectIdentifier "edit-network-posts-state")
                , selected = []
                , items = []
                }
            , addExistingConfirmationInp = Nothing
            , addConfirmationInp = Nothing
            , showNetworksWithoutUnit = False
            , furtherInvestigationFilter = Pages_.RerFreqs.Model.All
            , showSidebar = True
            , expandedArmies = Set.empty
            , expandedDivisions = Set.empty
            , expandedRegiments = Set.empty
            , expandedBattalions = Set.empty
            , showOnlyInvestigating = False
            , networkWorkflowTab = Pages_.RerFreqs.Model.Search
            , tableState = Table.sortBy "Частота" True
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <|
            Task.perform GotTime Time.now
        , initLoad m2
        , E.getModulations ModulationsReturnedByApi
        , E.loadPostsFromShared { sortBy = Nothing }
        ]
    )


filterStateDebounceConfig : Debounce.Config Msg
filterStateDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterStateDebounceMsg
    }


callsignSearchDebounceConfig : Debounce.Config Msg
callsignSearchDebounceConfig =
    { strategy = Debounce.later 300
    , transform = CallsignSearchDebounceMsg
    }


initLoad : Model -> Effect Msg
initLoad model =
    E.batch <|
        [ E.sendCmd <| loadFreqs model False
        , E.sendCmd <|
            Api.sigint_freq_unit_stats UnitStatsReturnedByApi
        ]


loadFreqs : Model -> Bool -> Cmd Msg
loadFreqs model paginating =
    case ( model.from.datePosix, model.to.datePosix ) of
        ( Just dtFromPosix, Just dtToPosix ) ->
            Api.sigint_list_freqs (GotFreqs paginating)
                { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
                , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
                , newOnly = model.newOnly
                , includeNonActive = model.includeNonActive
                , filterFreq = emptySToNothing model.filterState.freq
                , sortBy = Just [ model.sortingOrder ]
                , filterUnit = emptySToNothing model.filterState.unit
                , filterCallsigns = emptyToNothing model.filterState.callsigns
                , afterFreqNonincl =
                    if paginating then
                        model.freqs |> ListX.last |> Maybe.map .freq

                    else
                        Nothing
                , filterGroupMasterKeys = Nothing
                , filterSenderProfileIds = Nothing
                , filterFurtherInvestigation =
                    if model.showOnlyInvestigating then
                        Just True

                    else
                        Nothing
                }

        _ ->
            Cmd.none


loadFreqsWithTracker : Model -> Bool -> String -> Cmd Msg
loadFreqsWithTracker model paginating tracker =
    case ( model.from.datePosix, model.to.datePosix ) of
        ( Just dtFromPosix, Just dtToPosix ) ->
            Api.sigint_list_freqs_with_tracker (GotFreqs paginating)
                tracker
                { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
                , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
                , newOnly = model.newOnly
                , includeNonActive = model.includeNonActive
                , filterFreq = emptySToNothing model.filterState.freq
                , sortBy = Just [ model.sortingOrder ]
                , filterUnit = emptySToNothing model.filterState.unit
                , filterCallsigns = emptyToNothing model.filterState.callsigns
                , afterFreqNonincl =
                    if paginating then
                        model.freqs |> ListX.last |> Maybe.map .freq

                    else
                        Nothing
                , filterGroupMasterKeys = Nothing
                , filterSenderProfileIds = Nothing
                , filterFurtherInvestigation =
                    if model.showOnlyInvestigating then
                        Just True

                    else
                        Nothing
                }

        _ ->
            Cmd.none


selFreqUnitId : String -> Maybe Int -> String
selFreqUnitId freqS mNetworkId =
    "sel-freq-units-" ++ freqS ++ "-" ++ (mmap String.fromInt mNetworkId |> def "add")


callsignsForFilterParams : Posix -> Posix -> Model -> B.CallsignsForFreqReq
callsignsForFilterParams dtFromPosix dtToPosix model =
    let
        filterState =
            model.filterState
    in
    { freq = emptySToNothing filterState.freq
    , unit = emptySToNothing filterState.unit
    , callsign = emptySToNothing model.callsignSearchQuery
    , sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
    , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
    }


networksForView : Shared.Model -> Model -> Dict Int B.Network
networksForView shared model =
    Dict.union model.networksExtra (RD.withDefault Dict.empty shared.networks)


missingNetworkIdsForFreqs : Shared.Model -> Model -> List B.Freq -> List Int
missingNetworkIdsForFreqs shared model freqs =
    let
        knownNetworks =
            networksForView shared model
    in
    freqs
        |> List.concatMap .networkIds
        |> List.filter (\networkId -> not (Dict.member networkId knownNetworks))
        |> ListX.unique


loadNetworksForFreqs : Shared.Model -> Model -> List B.Freq -> Effect Msg
loadNetworksForFreqs shared model freqs =
    let
        missingIds =
            missingNetworkIdsForFreqs shared model freqs
    in
    if List.isEmpty missingIds then
        E.none

    else
        E.getNetworksInfoByIds NetworksInfoLoaded missingIds


reloadFreqsIfSelectedChanged : Maybe (Select.Action String) -> List String -> Model -> ( Model, Effect Msg, Bool )
reloadFreqsIfSelectedChanged mAction selectedItems model =
    case mAction of
        Just Select.Blur ->
            ( model, E.none, False )

        Just (Select.MenuToggle Select.MenuClose) ->
            ( model, E.none, False )

        Just Select.Clear ->
            let
                ( m_, cmd_ ) =
                    ( model
                    , E.sendCmd <|
                        loadFreqs model False
                    )
            in
            ( m_, cmd_, True )

        Just (Select.Select _) ->
            let
                ( m_, cmd_ ) =
                    ( model
                    , E.sendCmd <|
                        loadFreqs model False
                    )
            in
            ( m_, cmd_, True )

        Just (Select.Deselect _) ->
            let
                ( m_, cmd_ ) =
                    ( model
                    , E.sendCmd <|
                        loadFreqs model False
                    )
            in
            ( m_, cmd_, True )

        _ ->
            ( model, E.none, False )


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        Refresh ->
            ( { model | loading = True }
            , initLoad model
            )

        GotFreqs _ (Err err) ->
            ( { model | loading = False, loadingMore = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження частот" err
            )

        GotFreqs paginating (Ok rsp) ->
            ( { model
                | freqs =
                    if paginating then
                        model.freqs ++ rsp.freqs

                    else
                        rsp.freqs
                , loading = False
                , loadingMore = False
                , currentRequestTracker = Nothing
                , noMoreToLoad = not rsp.showLoadMore
              }
            , E.batch
                (loadNetworksForFreqs shared model rsp.freqs
                    :: (case ( model.from.datePosix, model.to.datePosix ) of
                            ( Just dtFromPosix, Just dtToPosix ) ->
                                let
                                    freqsAsString =
                                        rsp.freqs |> List.map .freq

                                    timeFrom =
                                        Time.posixToMillis dtFromPosix

                                    timeTo =
                                        Time.posixToMillis dtToPosix
                                in
                                [ E.getGroupsActivityStats GroupsMessageCountByDayReturnedByApi
                                    { freqs = freqsAsString
                                    , sinceDateInclusiveMs = timeFrom
                                    , tillDateNoninclusiveMs = timeTo
                                    }
                                , E.sendCmd <|
                                    Api.list_callsigns_by_freq CallsignsByFreqsReturnedByApi
                                        { freqs = freqsAsString
                                        , sinceDateInclusiveMs = timeFrom
                                        , tillDateNoninclusiveMs = timeTo
                                        }
                                , E.sendCmd <|
                                    Api.list_alt_units_by_freqs AltUnitsByFreqReturnedByApi
                                        { freqs = freqsAsString
                                        , sinceDateInclusiveMs = timeFrom
                                        , tillDateNoninclusiveMs = timeTo
                                        , filterGroupMasterKeys = Nothing
                                        , filterSenderProfileIds = Nothing
                                        }
                                ]

                            _ ->
                                []
                       )
                    )
            )

        GroupsMessageCountByDayReturnedByApi (Ok r) ->
            ( { model | groupsMessageCountByDay = Dict.union model.groupsMessageCountByDay r }, E.none )

        GroupsMessageCountByDayReturnedByApi (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики активності" err
            )

        GotFreqNetworks _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж частот" err
            )

        GotFreqNetworks freqS (Ok networks) ->
            ( { model
                | freqs =
                    model.freqs
                        |> ListX.updateIf (\f -> f.freq == freqS)
                            (\f -> { f | networkIds = networks |> List.map .id })
              }
            , E.none
            )

        DateTimeFromMsg imsg ->
            let
                ( m2, eff2 ) =
                    Shared.Components.DateTime.update
                        { zone = shared.timeZone
                        , msg = imsg
                        , model = model.from
                        , toModel = \from -> { model | from = from }
                        , toMsg = DateTimeFromMsg
                        }
            in
            ( { m2
                | locationTexts = Dict.empty
                , callsignSearchResults = NotAsked
              }
            , E.batch [ eff2, initLoad m2 ]
            )

        DateTimeToMsg imsg ->
            let
                ( m2, eff2 ) =
                    Shared.Components.DateTime.update
                        { zone = shared.timeZone
                        , msg = imsg
                        , model = model.to
                        , toModel = \to -> { model | to = to }
                        , toMsg = DateTimeToMsg
                        }
            in
            ( { m2 | callsignSearchResults = NotAsked }
            , E.batch [ eff2, initLoad m2 ]
            )

        GotTime now_ ->
            let
                from =
                    Shared.Components.DateTime.initFromPosix { datePosix = Utils.Time.xDaysAgo 7 now_, zone = shared.timeZone }

                to =
                    Shared.Components.DateTime.initFromPosix { datePosix = now_, zone = shared.timeZone }

                m2 =
                    { model
                        | from = from
                        , to = to
                        , now = Just now_
                    }
            in
            ( m2, initLoad m2 )

        NetworkAddUnitSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.networkDialogUnitSelect.state

                updatedUnitId =
                    Utils.Select.singleUpd mAct model.networkDialogUnitSelect.selected

                -- Single pattern match handling all cases
                ( m1, cmd1, networkWorkflowStatus ) =
                    case mAct of
                        Just (Select.InputChange query) ->
                            if String.length query > 2 then
                                ( model
                                , Task.perform (\_ -> UnitsSearchDebounceTimerExpired query)
                                    (Process.sleep 300)
                                , model.networkWorkflowStatus
                                )

                            else
                                let
                                    us =
                                        model.networkDialogUnitSelect

                                    us2 =
                                        { us | items = [] }
                                in
                                ( { model | networkDialogUnitSelect = us2 }
                                , Cmd.none
                                , model.networkWorkflowStatus
                                )

                        Just (Select.Select i) ->
                            let
                                networksDict =
                                    networksForView shared model

                                a =
                                    case shared.masterUnits of
                                        Success units ->
                                            Utils.findConnectedNetworks (Just i) networksDict units

                                        _ ->
                                            []

                                -- Filter out networks already connected to this frequency
                                alreadyConnectedNetworkIds =
                                    case model.networkWorkflowStatus of
                                        SelectingNetwork freq _ ->
                                            ListX.find (\freq_ -> freq_.freq == freq) model.freqs
                                                |> Maybe.map .networkIds
                                                |> Maybe.withDefault []

                                        _ ->
                                            []

                                availableNetworks =
                                    List.filter (\n -> not (List.member n.id alreadyConnectedNetworkIds)) a

                                newWorkflowStatus =
                                    case model.networkWorkflowStatus of
                                        SelectingNetwork freq _ ->
                                            case availableNetworks of
                                                x :: xs ->
                                                    SelectingNetwork freq (Just x.id)

                                                _ ->
                                                    SelectingNetwork freq Nothing

                                        _ ->
                                            model.networkWorkflowStatus
                            in
                            ( model, Cmd.none, newWorkflowStatus )

                        Just Select.Clear ->
                            let
                                us =
                                    model.networkDialogUnitSelect

                                us2 =
                                    { us | items = [] }

                                newWorkflowStatus =
                                    case model.networkWorkflowStatus of
                                        SelectingNetwork freq _ ->
                                            SelectingNetwork freq Nothing

                                        _ ->
                                            model.networkWorkflowStatus
                            in
                            ( { model | networkDialogUnitSelect = us2 }
                            , Cmd.none
                            , newWorkflowStatus
                            )

                        _ ->
                            ( model, Cmd.none, model.networkWorkflowStatus )

                unitsSelect =
                    m1.networkDialogUnitSelect

                unitsSelect2 =
                    { unitsSelect
                        | state = imodel
                        , selected = updatedUnitId
                    }
            in
            ( { m1
                | networkDialogUnitSelect = unitsSelect2
                , networkWorkflowStatus = networkWorkflowStatus
              }
            , E.batch
                [ E.sendCmd <|
                    Cmd.map
                        NetworkAddUnitSelMsg
                        icmd
                , E.sendCmd cmd1
                ]
            )

        UnitsSearchDebounceTimerExpired query ->
            ( model, E.sendCmd <| Api.units_search UnitsSearchReturned "units-search" { search = query } )

        UnitsSearchReturned (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка пошуку підрозділів" e
            )

        UnitsSearchReturned (Ok rsp) ->
            let
                unitsSelect =
                    model.networkDialogUnitSelect

                unitsSelect2 =
                    { unitsSelect | items = List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name }) rsp.units }
            in
            ( { model | networkDialogUnitSelect = unitsSelect2 }, E.none )

        NetworkSearchWithoutUnitToggled showWithoutUnit ->
            let
                -- Clear unit selection when checkbox is checked
                unitsSelect =
                    if showWithoutUnit then
                        let
                            currentSelect =
                                model.networkDialogUnitSelect
                        in
                        { currentSelect | selected = Nothing }

                    else
                        model.networkDialogUnitSelect
            in
            ( { model
                | showNetworksWithoutUnit = showWithoutUnit
                , networkDialogUnitSelect = unitsSelect
              }
            , E.none
            )

        NetworkSearchWithoutUnitToggle ->
            let
                newShowWithoutUnit =
                    not model.showNetworksWithoutUnit

                -- Clear unit selection when checkbox is checked
                unitsSelect =
                    if newShowWithoutUnit then
                        let
                            currentSelect =
                                model.networkDialogUnitSelect
                        in
                        { currentSelect | selected = Nothing }

                    else
                        model.networkDialogUnitSelect
            in
            ( { model
                | showNetworksWithoutUnit = newShowWithoutUnit
                , networkDialogUnitSelect = unitsSelect
              }
            , E.none
            )

        FurtherInvestigationFilterChanged filter ->
            let
                m1 =
                    { model | furtherInvestigationFilter = filter, loading = True }
            in
            ( m1
            , E.sendCmd <| loadFreqs m1 False
            )

        NetworkAddExistingModulationSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.addExistingModulationSelect.state

                updatedNetworkModulation =
                    Utils.Select.singleUpd mAct model.addExistingModulationSelect.selected

                modulationSelect =
                    model.addExistingModulationSelect

                modulationSelect2 =
                    { modulationSelect
                        | state = imodel
                        , selected = updatedNetworkModulation
                    }
            in
            ( { model | addExistingModulationSelect = modulationSelect2 }
            , E.sendCmd <|
                Cmd.map
                    NetworkAddExistingModulationSelMsg
                    icmd
            )

        NetworkAddExistingKindSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.addExistingKindSelect.state

                updatedNetworkKind =
                    Utils.Select.singleUpdWithDefault mAct model.addExistingKindSelect.selected

                kindSelect =
                    model.addExistingKindSelect

                kindSelect2 =
                    { kindSelect
                        | state = imodel
                        , selected = updatedNetworkKind
                    }
            in
            ( { model | addExistingKindSelect = kindSelect2 }
            , E.sendCmd <|
                Cmd.map
                    NetworkAddExistingKindSelMsg
                    icmd
            )

        FilterStateMsg filterState ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterStateDebounceConfig filterState model.filterStateDebounce

                m2 =
                    { model
                        | filterState = filterState
                        , filterStateDebounce = debounce
                    }
            in
            ( m2
            , E.sendCmd cmd
            )

        FilterStateDebounceMsg imsg ->
            let
                tracker =
                    "freqs-" ++ String.fromInt (model.requestCounter + 1)

                cancelPrevious =
                    case model.currentRequestTracker of
                        Just prevTracker ->
                            Http.cancel prevTracker

                        Nothing ->
                            Cmd.none

                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterStateDebounceConfig
                        (Debounce.takeLast (\_ -> loadFreqsWithTracker model False tracker))
                        imsg
                        model.filterStateDebounce

                model2 =
                    { model
                        | filterStateDebounce = debounce
                        , loading = True
                        , callsignSearchResults = NotAsked
                        , currentRequestTracker = Just tracker
                        , requestCounter = model.requestCounter + 1
                    }
            in
            ( model2
            , E.batch
                [ E.sendCmd cancelPrevious
                , E.sendCmd debounceCmd
                ]
            )

        UnitStatsReturnedByApi (Err err) ->
            ( { model | loadingUnitStats = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
            )

        UnitStatsReturnedByApi (Ok rsp) ->
            ( { model
                | unitStats = rsp.units
                , loadingUnitStats = False
              }
            , E.none
            )

        SwitchFromTextToMap containerId ->
            let
                ( from, to ) =
                    case ( model.from.datePosix, model.to.datePosix ) of
                        ( Just fromPosix, Just toPosix ) ->
                            ( Time.posixToMillis fromPosix, Time.posixToMillis toPosix )

                        _ ->
                            ( 0, 0 )
            in
            ( model
            , E.sendCmd <|
                Api.list_points_by_freq (PointsByFreqReturnedByApi containerId)
                    { freq = containerId
                    , sinceDateInclusiveMs = from
                    , tillDateNoninclusiveMs = to
                    }
            )

        MapClose _ ->
            ( { model | openMapRowId = Nothing }, E.none )

        PointsByFreqReturnedByApi containerId (Ok rsp) ->
            case rsp.points of
                [] ->
                    ( { model | locationTexts = Dict.update containerId (\_ -> Just NoCoords) model.locationTexts }, E.none )

                _ ->
                    ( { model | openMapRowId = Just containerId, locationTexts = Dict.insert containerId LocationText model.locationTexts }, E.sendCmd <| Ports.rer_freqs_openMap { points = rsp.points, containerId = containerId } )

        PointsByFreqReturnedByApi _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок карти" err
            )

        CallsignsByFreqsReturnedByApi (Ok rsp) ->
            let
                mergedResult =
                    Dict.merge
                        (\key existingCs result -> Dict.insert key existingCs result)
                        (\key _ newCs result -> Dict.insert key newCs result)
                        (\key newCs result -> Dict.insert key newCs result)
                        Dict.empty
                        model.callsignsByFreq
                        rsp

                newCallsigns =
                    Dict.values rsp
                        |> List.concat
                        |> List.filter (\callsign -> not (List.member callsign model.callsigns))
            in
            ( { model
                | callsignsByFreq = mergedResult
                , callsigns =
                    newCallsigns
                        ++ model.callsigns
                        |> Set.fromList
                        |> Set.toList
              }
            , if List.length newCallsigns > 0 then
                E.getCallsignsInfo CallsignsInfoReturnedByApi { callsigns = newCallsigns }

              else
                E.none
            )

        CallsignsByFreqsReturnedByApi (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" err
            )

        AltUnitsByFreqReturnedByApi (Ok rsp) ->
            ( { model | altUnitsByFreq = Dict.union model.altUnitsByFreq rsp }
            , E.none
            )

        AltUnitsByFreqReturnedByApi (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження альтернативних підрозділів" err
            )

        CallsignsInfoReturnedByApi (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації позивних" e
            )

        CallsignsInfoReturnedByApi (Ok callsignsRes) ->
            let
                updatedCallsignsInfo =
                    List.foldl
                        (\callsignRes acc ->
                            Dict.insert callsignRes.callsign
                                callsignRes.res
                                acc
                        )
                        model.callsignsInfo
                        callsignsRes
            in
            ( { model | callsignsInfo = updatedCallsignsInfo }, E.none )

        NetworksInfoLoaded (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка дозавантаження мереж" err
            )

        NetworksInfoLoaded (Ok networks) ->
            let
                newNetworks =
                    networks
                        |> List.map (\network -> ( network.id, network ))
                        |> Dict.fromList
            in
            ( { model | networksExtra = Dict.union newNetworks model.networksExtra }, E.none )

        SortByMessageNumber ->
            let
                newSortOrder =
                    changeSortOrder model.sortingOrder

                m2 =
                    { model | sortingOrder = newSortOrder }
            in
            ( m2
            , E.sendCmd <|
                loadFreqs m2 False
            )

        FreqsLoadMore ->
            ( { model | loadingMore = True }
            , E.sendCmd <| loadFreqs model True
            )

        RowShowAllPopupChanged freqToShowAllItemsPopup ->
            ( { model | rowShowAllPopupStatus = freqToShowAllItemsPopup }
            , E.none
            )

        SelCallsignMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.selCallsignState

                ( updatedSelectedItems, state ) =
                    Utils.Select.multiUpdMenuOpen mAction model.filterState.callsigns imodel2

                currentFilterState =
                    model.filterState

                updatedFilterState =
                    { currentFilterState | callsigns = updatedSelectedItems }

                m2 =
                    { model
                        | selCallsignState = state
                        , filterState = updatedFilterState
                    }

                -- Handle input change for callsign search
                ( m3, eff3 ) =
                    case mAction of
                        Just (Select.InputChange query) ->
                            let
                                ( debounce, cmd ) =
                                    Debounce.push callsignSearchDebounceConfig query m2.callsignSearchDebounce

                                m3_ =
                                    { m2
                                        | callsignSearchQuery = query
                                        , callsignSearchDebounce = debounce
                                        , callsignSearchResults =
                                            if String.isEmpty query then
                                                NotAsked

                                            else
                                                m2.callsignSearchResults
                                    }
                            in
                            ( m3_, E.sendCmd cmd )

                        Just (Select.Select _) ->
                            -- Clear search after selection
                            ( { m2
                                | callsignSearchQuery = ""
                                , callsignSearchResults = NotAsked
                              }
                            , E.none
                            )

                        _ ->
                            ( m2, E.none )

                ( m4, eff4, _ ) =
                    reloadFreqsIfSelectedChanged mAction m3.filterState.callsigns m3
            in
            ( m4
            , E.batch <|
                [ E.sendCmd <| Cmd.map SelCallsignMsg icmd
                , eff3
                , eff4
                ]
            )

        CallsignSearchDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        callsignSearchDebounceConfig
                        (Debounce.takeLast
                            (\query ->
                                if String.length query >= 2 then
                                    case ( model.from.datePosix, model.to.datePosix ) of
                                        ( Just dtFromPosix, Just dtToPosix ) ->
                                            let
                                                searchParams =
                                                    callsignsForFilterParams dtFromPosix dtToPosix { model | callsignSearchQuery = query }
                                            in
                                            Api.rer_freqs_callsigns CallsignSearchResultsReturned searchParams

                                        _ ->
                                            Cmd.none

                                else
                                    Cmd.none
                            )
                        )
                        imsg
                        model.callsignSearchDebounce

                model2 =
                    { model
                        | callsignSearchDebounce = debounce
                        , callsignSearchResults =
                            if String.length model.callsignSearchQuery >= 2 then
                                Loading

                            else
                                model.callsignSearchResults
                    }
            in
            ( model2
            , E.sendCmd debounceCmd
            )

        CallsignSearchResultsReturned (Err e) ->
            ( { model | callsignSearchResults = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка пошуку позивних" e
            )

        CallsignSearchResultsReturned (Ok rsp) ->
            ( { model | callsignSearchResults = Success rsp.callsigns }
            , E.none
            )

        OpenAddNetworkSidebar freq ->
            ( { model
                | networkWorkflowStatus = SelectingNetwork freq Nothing

                --TODO: remove workaround related to loading from Shared
                , addPostsSelect =
                    Utils.Select.updateSelectItems
                        (\_ ->
                            List.map
                                (\post -> Select.basicMenuItem { item = post.id, label = post.name })
                                (RD.withDefault Dict.empty shared.posts |> Dict.values)
                        )
                        model.addPostsSelect
                , editPostsSelect =
                    Utils.Select.updateSelectItems
                        (\_ ->
                            List.map
                                (\post -> Select.basicMenuItem { item = post.id, label = post.name })
                                (RD.withDefault Dict.empty shared.posts |> Dict.values)
                        )
                        model.editPostsSelect
              }
            , E.batch
                [ E.getFreqActivityDaily FreqGroupsActivityReturnedByApi
                    { freq = freq
                    , sinceDateInclusiveMs = Time.posixToMillis (Utils.Time.xDaysAgo 30 (Time.millisToPosix shared.now))
                    , tillDateInclusiveMs = Nothing
                    }
                ]
            )

        CloseAddNetworkSidebar ->
            let
                unitSelect =
                    model.networkDialogUnitSelect

                unitSelect2 =
                    { unitSelect | selected = Nothing }
            in
            ( { model | networkWorkflowStatus = NotStarted, networkDialogUnitSelect = unitSelect2 }, E.none )

        NetworkConfirmationAdded (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання підтвердження мережі" e
            )

        NetworkConfirmationAdded (Ok network) ->
            ( { model | addConfirmationInp = Nothing }
            , E.none
            )

        NetworkAddToggleExistingId id ->
            ( { model
                | networkWorkflowStatus =
                    case model.networkWorkflowStatus of
                        SelectingNetwork freq (Just prevId) ->
                            if prevId == id then
                                SelectingNetwork freq Nothing

                            else
                                SelectingNetwork freq (Just id)

                        SelectingNetwork freq Nothing ->
                            SelectingNetwork freq (Just id)

                        _ ->
                            model.networkWorkflowStatus
              }
            , E.none
            )

        FreqAddToExistingNetwork freq id ->
            case Dict.get id (networksForView shared model) of
                Just network ->
                    ( { model | networkAddLoading = True }
                    , E.addFreqToNetwork (FreqAddedToNetwork freq)
                        { networkId = network.id
                        , freqRec =
                            { freq = freq
                            , kind = NetworksUtils.networkKindToString model.addExistingKindSelect.selected
                            , modulationId = model.addExistingModulationSelect.selected
                            , encryptionKeyIds = []
                            , activeFrom = model.addExistingActiveFrom
                            , activeTo = model.addExistingActiveTo
                            , description =
                                case model.addExistingConfirmationInp of
                                    Just inp ->
                                        Just
                                            { descrType = B.Confirmation
                                            , description = inp
                                            , freq = freq
                                            }

                                    Nothing ->
                                        Nothing
                            }
                        }
                    )

                Nothing ->
                    ( model, E.none )

        FreqAddedToNetwork _ (Err e) ->
            ( { model | networkAddLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання частоти до мережі" e
            )

        FreqAddedToNetwork freq (Ok network) ->
            let
                fre =
                    ListX.find (\freq_ -> freq_.freq == freq) model.freqs

                addUnitSelect =
                    model.networkDialogUnitSelect

                aus2 =
                    { addUnitSelect | selected = Nothing }

                freqs2 =
                    case fre of
                        Just v ->
                            let
                                fre2 =
                                    { v | networkIds = v.networkIds ++ [ network.id ] }
                            in
                            ListX.updateIf (\freq_ -> freq_.freq == freq) (\_ -> fre2) model.freqs

                        Nothing ->
                            model.freqs
            in
            ( { model
                | freqs = freqs2
                , networkWorkflowStatus = SelectingNetwork freq Nothing
                , networkDialogUnitSelect = aus2
                , networkAddLoading = False
              }
            , E.none
            )

        FreqRemoveFromExistingNetwork freq network ->
            ( { model | networkAddLoading = True }
            , E.removeFreqFromNetwork (FreqRemovedFromNetwork freq)
                { id = Nothing
                , networkId = Just network.id
                , freq = Just freq
                }
            )

        FreqRemovedFromNetwork _ (Err e) ->
            ( { model | networkAddLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення частоти з мережі" e
            )

        FreqRemovedFromNetwork freq (Ok network) ->
            let
                fre =
                    ListX.find (\freq_ -> freq_.freq == freq) model.freqs

                freqs2 =
                    case fre of
                        Just v ->
                            let
                                fre2 =
                                    { v | networkIds = List.filter (\id -> id /= network.id) v.networkIds }
                            in
                            ListX.updateIf (\freq_ -> freq_.freq == freq) (\_ -> fre2) model.freqs

                        Nothing ->
                            model.freqs
            in
            ( { model
                | freqs = freqs2
                , networkWorkflowStatus = SelectingNetwork freq Nothing
                , networkAddLoading = False
              }
            , E.none
            )

        NetworkUpdated _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення мережі" e
            )

        NetworkUpdated freq (Ok network) ->
            ( { model
                | networkWorkflowStatus = SelectingNetwork freq Nothing
              }
            , E.none
            )

        ModulationsReturnedByApi (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження модуляцій" e
            )

        ModulationsReturnedByApi (Ok modulations) ->
            let
                addModulationSelect =
                    model.addModulationSelect

                addExistingModulationSelect =
                    model.addExistingModulationSelect

                editModulationSelect =
                    model.editModulationSelect

                ams =
                    { addModulationSelect
                        | items =
                            modulations
                                |> List.map
                                    (\modulation ->
                                        Select.basicMenuItem
                                            { item = modulation.id
                                            , label = Modulations.displayModulationName modulation.name
                                            }
                                    )
                    }

                aems =
                    { addExistingModulationSelect
                        | items =
                            modulations
                                |> List.map
                                    (\modulation ->
                                        Select.basicMenuItem
                                            { item = modulation.id
                                            , label = Modulations.displayModulationName modulation.name
                                            }
                                    )
                    }

                ems =
                    { editModulationSelect
                        | items =
                            modulations
                                |> List.map
                                    (\modulation ->
                                        Select.basicMenuItem
                                            { item = modulation.id
                                            , label = Modulations.displayModulationName modulation.name
                                            }
                                    )
                    }
            in
            ( { model
                | modulations = Success modulations
                , addModulationSelect = ams
                , editModulationSelect = ems
                , addExistingModulationSelect = aems
              }
            , E.none
            )

        FreqGroupsActivityReturnedByApi (Ok r) ->
            ( { model | freqGroupsActivityForNetworkAdd = Success r }, E.none )

        FreqGroupsActivityReturnedByApi (Err err) ->
            ( { model | freqGroupsActivityForNetworkAdd = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності груп частот" err
            )

        NetworkPostsUpdated freq editState (Ok r) ->
            ( model
            , E.updateNetworkFreq (NetworkFreqUpdated freq editState)
                { networkId = editState.id
                , freq = freq
                , kind = NetworksUtils.networkKindToString model.editKindSelect.selected
                , modulationId = model.editModulationSelect.selected
                , encryptionKeyIds = []
                , activeFrom = 0
                , activeTo = Nothing
                }
            )

        NetworkPostsUpdated _ _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення постів мережі" err
            )

        NetworkFreqUpdated freq editState (Ok r) ->
            ( model, E.updateNetwork (NetworkUpdated freq) editState )

        NetworkFreqUpdated _ _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення частоти мережі" err
            )

        ConfirmationInputChangedByUser val ->
            ( { model | addExistingConfirmationInp = Just val }, E.none )

        Confirmation2InputChangedByUser val ->
            ( { model | addConfirmationInp = Just val }, E.none )

        NetworkAddExistingActiveFromChanged x ->
            ( { model
                | addExistingActiveFrom =
                    case Utils.Time.parseDateParts x of
                        Err _ ->
                            model.addExistingActiveFrom

                        Ok parts ->
                            Time.Extra.partsToPosix shared.timeZone parts
                                |> Time.posixToMillis
                                |> Just
              }
            , E.none
            )

        NetworkAddExistingActiveToChanged x ->
            ( { model
                | addExistingActiveTo =
                    case Utils.Time.parseDateParts x of
                        Err _ ->
                            model.addExistingActiveFrom

                        Ok parts ->
                            Time.Extra.partsToPosix shared.timeZone parts
                                |> Time.posixToMillis
                                |> Just
              }
            , E.none
            )

        ToggleSidebar ->
            ( { model | showSidebar = not model.showSidebar }, E.none )

        ToggleShowOnlyInvestigating val ->
            let
                newFilterState =
                    { freq = model.filterState.freq
                    , unit = ""
                    , callsigns = model.filterState.callsigns
                    }

                m2 =
                    { model | showOnlyInvestigating = val, filterState = newFilterState, loading = True }
            in
            ( m2, E.sendCmd <| loadFreqs m2 False )

        ToggleArmyExpanded army ->
            ( { model
                | expandedArmies =
                    if Set.member army model.expandedArmies then
                        Set.remove army model.expandedArmies

                    else
                        Set.insert army model.expandedArmies
              }
            , E.none
            )

        ToggleDivisionExpanded army division ->
            let
                key =
                    army ++ ":" ++ division
            in
            ( { model
                | expandedDivisions =
                    if Set.member key model.expandedDivisions then
                        Set.remove key model.expandedDivisions

                    else
                        Set.insert key model.expandedDivisions
              }
            , E.none
            )

        ToggleRegimentExpanded army division regiment ->
            let
                key =
                    army ++ ":" ++ division ++ ":" ++ regiment
            in
            ( { model
                | expandedRegiments =
                    if Set.member key model.expandedRegiments then
                        Set.remove key model.expandedRegiments

                    else
                        Set.insert key model.expandedRegiments
              }
            , E.none
            )

        ToggleBattalionExpanded army division regiment battalion ->
            let
                key =
                    army ++ ":" ++ division ++ ":" ++ regiment ++ ":" ++ battalion
            in
            ( { model
                | expandedBattalions =
                    if Set.member key model.expandedBattalions then
                        Set.remove key model.expandedBattalions

                    else
                        Set.insert key model.expandedBattalions
              }
            , E.none
            )

        FilterUnitMsg unitName ->
            let
                -- Toggle behavior: if clicking the same unit, clear it; otherwise set new unit
                newUnitFilter =
                    if model.filterState.unit == unitName then
                        ""
                        -- Clear filter if same unit clicked

                    else
                        unitName

                -- Set new unit if different
                newFilterState =
                    { freq = model.filterState.freq
                    , unit = newUnitFilter
                    , callsigns = model.filterState.callsigns
                    }

                m2 =
                    { model | filterState = newFilterState, showOnlyInvestigating = False, loading = True }
            in
            ( m2, E.sendCmd <| loadFreqs m2 False )

        ClearAllFilters ->
            let
                clearedFilterState =
                    { freq = ""
                    , unit = ""
                    , callsigns = []
                    }

                m2 =
                    { model
                        | filterState = clearedFilterState
                        , showOnlyInvestigating = False
                        , loading = True
                    }
            in
            ( m2, E.sendCmd <| loadFreqs m2 False )

        NetworkWorkflowTabClicked tab ->
            ( { model | networkWorkflowTab = tab }, E.none )

        SetTableState newState ->
            ( { model | tableState = newState }, E.none )


freqsTableConfig : Shared.Model -> Model -> B.User -> Table.Config B.Freq Msg
freqsTableConfig shared model user =
    let
        tableAttrs =
            [ class "base-table" ]

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute Msg ) -> Html Msg
        customTheadHelp ( name, status, click ) =
            let
                sortIcon =
                    case status of
                        TableConfig.Unsortable ->
                            text ""

                        TableConfig.Sortable selected ->
                            span
                                [ style "color"
                                    (if selected then
                                        "var(--ochre-normal)"

                                     else
                                        "var(--color-text-muted)"
                                    )
                                ]
                                [ text " ↓" ]

                        TableConfig.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ↓" ]

                        TableConfig.Reversible (Just True) ->
                            span [ style "color" "var(--ochre-normal)" ] [ text " ↓" ]

                        TableConfig.Reversible (Just False) ->
                            span [ style "color" "var(--ochre-normal)" ] [ text " ↑" ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click, style "padding" "1rem 1.5rem" ] [ headerContent ]

        actionMenuBody : B.Freq -> List (Html Msg)
        actionMenuBody freq =
            let
                analysisHref withMap =
                    let
                        dateFromStr =
                            case model.now of
                                Just time ->
                                    Utils.Time.renderDateF4 shared.timeZone (Utils.Time.xDaysAgo 15 time)

                                _ ->
                                    ""

                        dateToStr =
                            case model.now of
                                Just time ->
                                    Utils.Time.renderDateF4 shared.timeZone (Utils.Time.xDaysAgo -1 time)

                                _ ->
                                    ""

                        stateS =
                            Encode.encode 0
                                (B.rerAnalysisQueryStateEncoder
                                    { dateFromStr = dateFromStr
                                    , timeFromStr = ""
                                    , dateToStr = dateToStr
                                    , timeToStr = "00:00"
                                    , groupsSelected = []
                                    , sendersSelected = []
                                    , freqsSelected = [ freq.freq ]
                                    , callsignsSelected = []
                                    , unitsSelected = []
                                    , locationsSelected = []
                                    , includePelengLocations = False
                                    , orWithExtendedForm = False
                                    , orBookmarked = False
                                    , orImportant = False
                                    , orWithCoords = False
                                    , search = ""
                                    , tags = []
                                    , unitsExactMatchOnly = True
                                    , adjacentFreqsRange = 0
                                    , withoutModelTags = False
                                    }
                                )

                        query =
                            if withMap then
                                [ Url.Builder.string "state" stateS, Url.Builder.string "showMap" "true" ]

                            else
                                [ Url.Builder.string "state" stateS ]
                    in
                    Url.Builder.relative [ "rer-analysis" ] query
            in
            [ span []
                [ i [ class "bi me-1 bi-bar-chart" ] []
                , a [ href <| analysisHref False, target "_blank" ]
                    [ text "аналіз "
                    , sup []
                        [ i
                            [ class "bi bi-box-arrow-up-right"
                            ]
                            []
                        ]
                    ]
                ]
            , span []
                [ i [ class "bi me-1 bi-pin-map" ] []
                , a [ href <| analysisHref True, target "_blank" ]
                    [ text "на мапі "
                    , sup []
                        [ i
                            [ class "bi bi-box-arrow-up-right"
                            ]
                            []
                        ]
                    ]
                ]
            ]
    in
    Table.customConfig
        { toId = \freq -> freq.freq
        , toMsg = SetTableState
        , columns =
            [ Table.veryCustomColumn
                { name = "Частота"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children =
                            [ div [ class "relative" ]
                                [ div [] [ text freq.freq ]
                                , div [ class "" ]
                                    [ span
                                        [ class "badge badge-sm rounded-pill text-bg-secondary"
                                        , style "font-size" "0.6rem"
                                        ]
                                        [ text <| String.fromInt freq.messageCount
                                        ]
                                    , Shared.Components.ActionMenu.actionMenu (actionMenuBody freq) "bi-three-dots-vertical"
                                    ]
                                , Watermark.new user.name
                                    |> Watermark.withPositioning ( 30, 10 )
                                    |> Watermark.withFontSize "1.5rem"
                                    |> Watermark.view
                                    |> HtmlX.viewIf (Basics.remainderBy 2 (ListX.elemIndex freq model.freqs |> Maybe.withDefault 0) == 0)
                                ]
                            ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\freq -> freq.messageCount)
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Позивні"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children =
                            [ let
                                callsigns =
                                    case Dict.get freq.freq model.callsignsByFreq of
                                        Nothing ->
                                            []

                                        Just v ->
                                            v

                                isOpen =
                                    case model.rowShowAllPopupStatus of
                                        Just ( freq_, ShowAllCallsigns ) ->
                                            freq_ == freq.freq

                                        _ ->
                                            False
                              in
                              case shared.masterUnits of
                                Success units ->
                                    CallsignsPopup.view
                                        { isOpened = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( freq.freq, ShowAllCallsigns )
                                        , callsigns = callsigns
                                        , callsignsInfo = model.callsignsInfo
                                        , masterUnits = units
                                        }
                                        (FreqsPage
                                            freq.freq
                                            (networksForView shared model)
                                        )

                                _ ->
                                    div [] [ text "Завантаження..." ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Пеленги"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children =
                            [ div []
                                [ case ( Dict.get freq.freq model.locationTexts, model.openMapRowId == Just freq.freq ) of
                                    ( Just LocationText, True ) ->
                                        div [ id ("map-container-" ++ freq.freq) ]
                                            []

                                    ( Just NoCoords, _ ) ->
                                        p []
                                            [ text "Немає координат" ]

                                    _ ->
                                        p [ class "flex gap-[4px] flex-col" ]
                                            (if List.isEmpty freq.locations then
                                                [ span [] [ text "" ] ]

                                             else
                                                (List.map (\location -> span [ class "cursor-pointer underline ", onClick <| SwitchFromTextToMap freq.freq ] [ text location ]) freq.locations
                                                    |> List.take 3
                                                )
                                                    ++ (if List.length freq.locations > 3 then
                                                            let
                                                                body =
                                                                    span
                                                                        [ style "font-size" "12px"
                                                                        , style "font-weight" "300"
                                                                        , style "cursor" "pointer"
                                                                        , style "display" "block"
                                                                        , style "padding-right" "6px"
                                                                        , style "text-decoration" "underline"
                                                                        ]
                                                                        [ text ("Показати всі " ++ (freq.locations |> List.length |> String.fromInt)) ]

                                                                popupBody =
                                                                    div [ class "d-flex flex-column", style "gap" "20px" ]
                                                                        (List.map (\location -> span [] [ text location ]) freq.locations)

                                                                isOpen =
                                                                    case model.rowShowAllPopupStatus of
                                                                        Just ( freq_, ShowAllLocations ) ->
                                                                            freq_ == freq.freq

                                                                        _ ->
                                                                            False
                                                            in
                                                            [ Shared.Components.Popup.new
                                                                { body = body
                                                                , popupBody = popupBody
                                                                , isOpen = isOpen
                                                                , onClose = RowShowAllPopupChanged Nothing
                                                                , onOpen = RowShowAllPopupChanged <| Just ( freq.freq, ShowAllLocations )
                                                                , disabled = False
                                                                }
                                                                |> Shared.Components.Popup.withFakeAnchor
                                                                |> Shared.Components.Popup.withCloseButton
                                                                |> Shared.Components.Popup.view
                                                            ]

                                                        else
                                                            [ text "" ]
                                                       )
                                            )
                                ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "Привʼязки"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = viewFreqBlock shared.user shared model freq
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "26%"
            , Table.veryCustomColumn
                { name = "Альтернативні Привʼязки"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children =
                            [ div [ class "flex flex-col gap-[4px]" ]
                                (case Dict.get freq.freq model.altUnitsByFreq of
                                    Just units ->
                                        (List.map (\u -> span [] [ text u.unit ]) units
                                            |> List.take 3
                                        )
                                            ++ (if List.length units > 3 then
                                                    let
                                                        body =
                                                            span
                                                                [ style "font-size" "12px"
                                                                , style "font-weight" "300"
                                                                , style "cursor" "pointer"
                                                                , style "display" "block"
                                                                , style "padding-right" "6px"
                                                                , style "text-decoration" "underline"
                                                                ]
                                                                [ text ("Показати всі " ++ (units |> List.length |> String.fromInt)) ]

                                                        popupBody =
                                                            div [ class "d-flex flex-column", style "gap" "20px" ]
                                                                (List.map (\unit -> span [] [ text unit.unit ]) units)

                                                        isOpen =
                                                            case model.rowShowAllPopupStatus of
                                                                Just ( freq_, ShowAllAltUnits ) ->
                                                                    freq_ == freq.freq

                                                                _ ->
                                                                    False
                                                    in
                                                    [ Shared.Components.Popup.new
                                                        { body = body
                                                        , popupBody = popupBody
                                                        , isOpen = isOpen
                                                        , onClose = RowShowAllPopupChanged Nothing
                                                        , onOpen = RowShowAllPopupChanged <| Just ( freq.freq, ShowAllAltUnits )
                                                        , disabled = False
                                                        }
                                                        |> Shared.Components.Popup.withFakeAnchor
                                                        |> Shared.Components.Popup.withCloseButton
                                                        |> Shared.Components.Popup.view
                                                    ]

                                                else
                                                    [ text "" ]
                                               )

                                    Nothing ->
                                        [ text "" ]
                                )
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Активність р/м"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children =
                            [ case Dict.get freq.freq model.groupsMessageCountByDay |> Maybe.map (Encode.dict identity (Encode.dict identity Encode.int)) of
                                Just g ->
                                    div [ class "w-full", style "height" "90px" ]
                                        [ Html.node "bar-chart"
                                            [ Attr.property "data" <| g
                                            , Attr.property "lastDay" <| Encode.string model.to.dateStr
                                            ]
                                            []
                                        ]

                                Nothing ->
                                    text "Не активні останні 10 днів"
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Останнє оновлення"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children =
                            case freq.lastUpdatedAt of
                                Just updatedAt ->
                                    let
                                        updatedAtString =
                                            Utils.Time.renderDateF6 shared.timeZone
                                                (Time.millisToPosix updatedAt)

                                        updatedByString =
                                            Maybe.withDefault "невідомий" freq.lastUpdatedBy

                                        createdAtString =
                                            case freq.createdAt of
                                                Just createdAt ->
                                                    Utils.Time.renderDateF6 shared.timeZone
                                                        (Time.millisToPosix createdAt)

                                                Nothing ->
                                                    "невідомо"
                                    in
                                    [ div [ style "padding-left" "4px", title ("Прив'язку створено " ++ createdAtString) ]
                                        [ i [ class "bi bi-calendar-date" ]
                                            []
                                        , text <|
                                            " "
                                                ++ createdAtString
                                        ]
                                    , div [ style "padding-left" "4px", title ("Востаннє прив'язка редагована " ++ updatedAtString ++ " користувачем " ++ updatedByString) ]
                                        [ i [ class "bi bi-pencil-square" ] []
                                        , text (" " ++ updatedAtString ++ " (" ++ updatedByString ++ ")")
                                        ]
                                    ]

                                _ ->
                                    [ text "" ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.lastUpdatedAt)
                }
                |> Table.withColumnWidth "9%"
            ]
        , customizations =
            { tableAttrs = tableAttrs
            , caption = Nothing
            , thead = customThead
            , tfoot = Nothing
            , tbodyAttrs = []
            , rowAttrs = \_ -> []
            }
        }


viewFreqBlock : Maybe B.User -> Shared.Model -> Model -> B.Freq -> List (Html Msg)
viewFreqBlock mUser shared model freq =
    let
        editBlock =
            case mUser of
                Just user ->
                    if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
                        div []
                            [ div [ style "font-size" ".8rem" ]
                                [ button
                                    [ title "Редагувати прив'язки"
                                    , class "outline-0! px-[4px] border-1! border-border rounded-sm! bg-transparent text-action text-[16px]! transition-colors duration-350 hover:bg-action! hover:text-bw"
                                    , onClick <| OpenAddNetworkSidebar freq.freq
                                    ]
                                    [ i [ class "bi bi-pencil" ] []
                                    ]
                                ]
                            ]

                    else
                        text ""

                Nothing ->
                    text ""
    in
    [ div [ class "d-flex justify-content-between" ]
        [ div [ class "d-flex" ]
            [ div [] <|
                for_ freq.networkIds <|
                    \networkId ->
                        case Dict.get networkId (networksForView shared model) of
                            Just network ->
                                span [ class "inline-flex items-center gap-1" ]
                                    [ case shared.masterUnits of
                                        Success units ->
                                            NetworksUtils.renderNetwork network units

                                        _ ->
                                            text "Завантаження..."
                                    , case network.unitIds of
                                        Nothing ->
                                            span [ class "badge badge-no-unit" ] [ text "в дорозвідці" ]

                                        Just ids ->
                                            if List.isEmpty ids then
                                                span [ class "badge badge-no-unit" ] [ text "в дорозвідці" ]

                                            else
                                                text ""
                                    ]

                            _ ->
                                text "Невідома мережа"
            ]
        , editBlock
        ]
    ]


changeSortOrder : B.ListFreqsSortBy -> B.ListFreqsSortBy
changeSortOrder order =
    case order of
        B.MessageCountAsc ->
            B.MessageCountDesc

        B.MessageCountDesc ->
            B.MessageCountAsc

        _ ->
            B.MessageCountDesc


subscriptions : Model -> Sub Msg
subscriptions _ =
    Ports.rer_freqs_closeMapRes MapClose


dateAndPanelsBlock : Bool -> Model -> Html Msg
dateAndPanelsBlock _ model =
    div
        [ class "d-inline-block ms-2"
        ]
        [ div [ class "d-flex justify-content-start align-items-center" ] <|
            div
                [ class "me-2"
                , style "font-size" "1rem"
                ]
                [ text "з" ]
                :: (Shared.Components.DateTime.new
                        { model = model.from
                        , toMsg = DateTimeFromMsg
                        }
                        |> Shared.Components.DateTime.view
                   )
                ++ [ div
                        [ class "me-2"
                        , style "font-size" "1rem"
                        ]
                        [ text "по" ]
                   ]
                ++ (Shared.Components.DateTime.new
                        { model = model.to
                        , toMsg = DateTimeToMsg
                        }
                        |> Shared.Components.DateTime.view
                   )
        ]


leftPanel : Shared.Model -> Model -> Html Msg
leftPanel shared model =
    div
        [ class "self-stretch max-h-full min-w-[260px] max-w-[340px] w-[22vw] overflow-y-auto border-r border-border bg-card relative transition-all duration-300"
        ]
        [ button
            [ class "absolute top-2 right-2 z-10 px-2 py-1 rounded border border-border bg-card hover:bg-gray-100 transition"
            , onClick ToggleSidebar
            , attribute "title" "Сховати підрозділи"
            ]
            [ i [ class "bi bi-chevron-left" ] [] ]
        , unitsBlock shared model
        ]


unitsBlock : Shared.Model -> Model -> Html Msg
unitsBlock shared model =
    let
        config : Core.UnitHierarchy.Config Msg
        config =
            { onUnitClick = FilterUnitMsg
            , onArmyToggle = ToggleArmyExpanded
            , onDivisionToggle = ToggleDivisionExpanded
            , onRegimentToggle = ToggleRegimentExpanded
            , onBattalionToggle = ToggleBattalionExpanded
            , isArmyExpanded = \armyName -> Set.member armyName model.expandedArmies
            , isDivisionExpanded = \armyName divisionName -> Set.member (armyName ++ ":" ++ divisionName) model.expandedDivisions
            , isRegimentExpanded = \armyName divisionName regimentName -> Set.member (armyName ++ ":" ++ divisionName ++ ":" ++ regimentName) model.expandedRegiments
            , isBattalionExpanded = \armyName divisionName regimentName battalionName -> Set.member (armyName ++ ":" ++ divisionName ++ ":" ++ regimentName ++ ":" ++ battalionName) model.expandedBattalions
            , selectedUnit =
                if model.showOnlyInvestigating then
                    ""

                else
                    model.filterState.unit
            , autoExpandArmies = False
            , autoExpandDivisions = True
            , autoExpandRegiments = True
            , autoExpandBattalions = True
            }

        investigatingFilter =
            div
                [ class
                    ("px-3 py-2 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors border-b border-border "
                        ++ (if model.showOnlyInvestigating then
                                "bg-blue-100 dark:bg-blue-900/30"

                            else
                                ""
                           )
                    )
                , onClick <| ToggleShowOnlyInvestigating (not model.showOnlyInvestigating)
                ]
                [ div [ class "flex items-center gap-2" ]
                    [ span [ class "text-sm font-medium" ] [ text "В ДОРОЗВІДЦІ" ]
                    ]
                ]
    in
    if model.loadingUnitStats then
        Shared.Components.Spinner.loadingSpinner

    else
        div [ class "flex flex-col h-full" ]
            [ div [ class "p-4 border-b border-border" ]
                [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2" ]
                    [ Html.text "Підрозділи" ]
                , p [ class "text-sm text-gray-600 dark:text-gray-400" ]
                    [ Html.text "Оберіть підрозділ для фільтрації" ]
                ]
            , investigatingFilter
            , div [ class "overflow-y-auto grow-1" ]
                [ case shared.masterUnits of
                    Success units ->
                        Core.UnitHierarchy.view config (Dict.toList units |> List.map Tuple.second) model.unitStats

                    _ ->
                        div [] [ text "Завантаження підрозділів..." ]
                ]
            ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "частоти"
    , body =
        [ div [ class "flex page-rer-freqs app-shell-fill-height" ]
            [ if model.showSidebar then
                leftPanel shared model

              else
                text ""
            , div
                [ class "grow px-[32px] py-[16px] overflow-auto"
                ]
                [ div [ class "flex gap-[8px]" ]
                    [ h1 [ class "py-2 ps-4" ]
                        [ text "частоти"
                        ]
                    , div [ class "flex justify-between items-center" ]
                        [ -- Left-side content
                          div [ class "flex items-center me-auto" ]
                            [ button
                                [ type_ "button"
                                , class "btn btn-outline-secondary me-2"
                                , onClick Refresh
                                , attribute "data-tooltip" "оновити"
                                , attribute "data-position" "bottom"
                                ]
                                (if model.loading then
                                    [ Shared.Components.Spinner.loadingSpinner2Sm ]

                                 else
                                    [ i [ class "bi bi-arrow-repeat" ] [] ]
                                )
                            , dateAndPanelsBlock dark model
                            ]
                        ]
                    ]
                , div [ class "px-2" ]
                    [ let
                        networkAddSidebarOpen =
                            case model.networkWorkflowStatus of
                                NotStarted ->
                                    False

                                _ ->
                                    True
                      in
                      div []
                        [ Sidebar.view networkAddSidebarOpen
                            CloseAddNetworkSidebar
                            (NetworkWorkflow.view model shared (networksForView shared model))
                        , div
                            [ class "border mb-4 p-2"
                            ]
                            [ FilterPanel.view shared model
                            ]
                        , Table.view (freqsTableConfig shared model user) model.tableState model.freqs
                        , div [ class "flex justify-center mt-3 mb-3" ] <|
                            if not model.noMoreToLoad then
                                [ Button.new { label = "Завантажити ще", onClick = FreqsLoadMore }
                                    |> Button.withStyleSecondary
                                    |> Button.withDisabled model.loadingMore
                                    |> Button.withIcon
                                        (if model.loadingMore then
                                            [ Shared.Components.Spinner.loadingSpinner2Sm ]

                                         else
                                            []
                                        )
                                    |> Button.view
                                ]

                            else
                                []
                        ]
                    ]
                ]
            ]
        ]
    }


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update shared
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }
