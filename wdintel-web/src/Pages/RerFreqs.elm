module Pages.RerFreqs exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Components.Sidebar as Sidebar
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Http
import Layouts
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.DateTime
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types as Types exposing (ApiError, GroupsActivityPerDayRsp)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import PagePorts.RerFreqsPorts as Ports
import Process
import RerFreqs.FilterPanel as FilterPanel
import RerFreqs.Model exposing (FilterName(..), NetworkWorkflowStatus(..), NetworkWorkflowTab(..), TextLocation(..))
import RerFreqs.Msg exposing (Msg(..))
import RerFreqs.NetworkWorkflow as NetworkWorkflow
import RerFreqs.Table as Table
import RerFreqs.UnitsFilterSidebar
import RerFreqs.Utils as Utils
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Task
import Time exposing (Posix)
import Time.Extra
import UnitHierarchy
import View exposing (View)


type alias Model =
    RerFreqs.Model.Model


type alias Msg =
    RerFreqs.Msg.Msg


init : () -> ( Model, Effect Msg )
init _ =
    let
        m2 : Model
        m2 =
            { zone = Nothing
            , now = Nothing
            , loading = False
            , currentRequestTracker = Nothing
            , requestCounter = 0
            , newOnly = False
            , includeNonActive = False
            , freqs = []
            , from = Le.Block.DateTime.init ()
            , to = Le.Block.DateTime.init ()
            , masterUnits = Dict.empty
            , networks = Dict.empty
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
            , callsigns = []
            , sortingOrder = B.MessageCountDesc
            , altUnitsByFreq = Dict.empty
            , groupsMessageCountByDay = Dict.empty
            , noMoreToLoad = True
            , rowShowAllPopupStatus = Nothing
            , selCallsignState = Select.initState (Select.selectIdentifier "selCallsignState")
            , selCallsignMenu = []
            , callsignsForFilter = NotAsked
            , focusedFilterItemsBeforeChange = Nothing
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
            , furtherInvestigationFilter = RerFreqs.Model.All
            , showSidebar = True
            , expandedArmies = Set.empty
            , expandedDivisions = Set.empty
            , expandedRegiments = Set.empty
            , expandedBattalions = Set.empty
            , showOnlyInvestigating = False
            , networkWorkflowTab = RerFreqs.Model.Search
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <| Task.attempt GotZone Le.Time.getZone
        , initLoad m2
        , E.getModulations ModulationsReturnedByApi
        , E.loadPostsFromShared { sortBy = Nothing }
        ]
    )


loadUnits : Effect Msg
loadUnits =
    E.getUnits UnitsReturnedByApi
        { sortBy = Nothing
        , afterUnitId = Nothing
        , beforeUnitId = Nothing
        }


filterStateDebounceConfig : Debounce.Config Msg
filterStateDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterStateDebounceMsg
    }


initLoad : Model -> Effect Msg
initLoad model =
    E.batch <|
        [ loadUnits
        , E.sendCmd <| loadFreqs model False
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


focusAndReloadDataIfNeeded :
    Maybe (Select.Action String)
    -> List String
    -> RemoteData ApiError a
    -> FilterName
    -> Model
    ->
        ( { focusedFilterItemsBeforeChange : Maybe (List String)
          , items : RemoteData ApiError a
          }
        , Effect Msg
        )
focusAndReloadDataIfNeeded mAction selectedItems items filter model =
    case mAction of
        Just Select.Focus ->
            if model.focusedFilterItemsBeforeChange == Nothing then
                case items of
                    NeedsReload _ ->
                        case ( model.from.datePosix, model.to.datePosix ) of
                            ( Just dtFromPosix, Just dtToPosix ) ->
                                let
                                    callsignsPs =
                                        callsignsForFilterParams dtFromPosix dtToPosix model
                                in
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = Loading
                                  }
                                , E.sendCmd <| filterNameToCmd filter callsignsPs
                                )

                            _ ->
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = items
                                  }
                                , E.none
                                )

                    NotAsked ->
                        case ( model.from.datePosix, model.to.datePosix ) of
                            ( Just dtFromPosix, Just dtToPosix ) ->
                                let
                                    callsignsPs =
                                        callsignsForFilterParams dtFromPosix dtToPosix model
                                in
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = Loading
                                  }
                                , E.sendCmd <| filterNameToCmd filter callsignsPs
                                )

                            _ ->
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = items
                                  }
                                , E.none
                                )

                    _ ->
                        ( { focusedFilterItemsBeforeChange = Just selectedItems
                          , items = items
                          }
                        , E.none
                        )

            else
                ( { focusedFilterItemsBeforeChange = model.focusedFilterItemsBeforeChange
                  , items = items
                  }
                , E.none
                )

        Just (Select.Deselect _) ->
            if model.focusedFilterItemsBeforeChange == Nothing then
                case items of
                    NeedsReload _ ->
                        case ( model.from.datePosix, model.to.datePosix ) of
                            ( Just dtFromPosix, Just dtToPosix ) ->
                                let
                                    callsignsPs =
                                        callsignsForFilterParams dtFromPosix dtToPosix model
                                in
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = Loading
                                  }
                                , E.sendCmd <| filterNameToCmd filter callsignsPs
                                )

                            _ ->
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = items
                                  }
                                , E.none
                                )

                    NotAsked ->
                        case ( model.from.datePosix, model.to.datePosix ) of
                            ( Just dtFromPosix, Just dtToPosix ) ->
                                let
                                    callsignsPs =
                                        callsignsForFilterParams dtFromPosix dtToPosix model
                                in
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = Loading
                                  }
                                , E.sendCmd <| filterNameToCmd filter callsignsPs
                                )

                            _ ->
                                ( { focusedFilterItemsBeforeChange = Just selectedItems
                                  , items = items
                                  }
                                , E.none
                                )

                    _ ->
                        ( { focusedFilterItemsBeforeChange = Just selectedItems
                          , items = items
                          }
                        , E.none
                        )

            else
                ( { focusedFilterItemsBeforeChange = model.focusedFilterItemsBeforeChange
                  , items = items
                  }
                , E.none
                )

        _ ->
            ( { focusedFilterItemsBeforeChange = model.focusedFilterItemsBeforeChange
              , items = items
              }
            , E.none
            )


callsignsForFilterParams : Posix -> Posix -> Model -> B.CallsignsForFreqReq
callsignsForFilterParams dtFromPosix dtToPosix model =
    let
        filterState =
            model.filterState
    in
    { freq = emptySToNothing filterState.freq
    , unit = emptySToNothing filterState.unit
    , sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
    , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
    }


reloadFreqsIfSelectedChanged : Maybe (Select.Action String) -> List String -> Model -> ( Model, Effect Msg, Bool )
reloadFreqsIfSelectedChanged mAction selectedItems model =
    let
        upd =
            case model.focusedFilterItemsBeforeChange of
                Just items_ ->
                    let
                        ( m_, cmd_ ) =
                            if items_ == selectedItems then
                                ( model, E.none )

                            else
                                ( model
                                , E.sendCmd <|
                                    loadFreqs model False
                                )
                    in
                    ( { m_ | focusedFilterItemsBeforeChange = Nothing }, cmd_, True )

                Nothing ->
                    ( model, E.none, False )
    in
    case mAction of
        Just Select.Blur ->
            upd

        Just (Select.MenuToggle Select.MenuClose) ->
            upd

        Just Select.Clear ->
            let
                ( m_, cmd_ ) =
                    ( model
                    , E.sendCmd <|
                        loadFreqs model False
                    )
            in
            ( { m_ | focusedFilterItemsBeforeChange = Nothing }, cmd_, True )

        _ ->
            ( model, E.none, False )


filterNameToCmd : FilterName -> B.CallsignsForFreqReq -> Cmd Msg
filterNameToCmd filterName =
    case filterName of
        CallsignsFilter ->
            Api.rer_freqs_callsigns GotFilterCallsigns


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        GotZone (Err e) ->
            ( model
            , E.showError
                ("Error getting timezone: " ++ renderZoneError e)
            )

        GotZone (Ok ( _, zone )) ->
            ( { model | zone = Just zone }
            , E.sendCmd <|
                Task.perform (GotTime zone) Time.now
            )

        Refresh ->
            ( { model | loading = True }
            , initLoad model
            )

        GotFreqs _ (Err err) ->
            ( { model | loading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження частот" err
            )

        GotFreqs paginating (Ok rsp) ->
            let
                networkIds =
                    rsp.freqs |> List.concatMap .networkIds
            in
            ( { model
                | freqs =
                    if paginating then
                        model.freqs ++ rsp.freqs

                    else
                        rsp.freqs
                , loading = False
                , currentRequestTracker = Nothing
                , noMoreToLoad = not rsp.showLoadMore
              }
            , E.batch
                (E.getNetworksInfoByIds NetworksReturnedByApi networkIds
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
            ( { model | groupsMessageCountByDay = r }, E.none )

        GroupsMessageCountByDayReturnedByApi (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики активності" err
            )

        GotFreqNetworks _ (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж частот" err
            )

        GotFreqNetworks freqS (Ok networks) ->
            let
                newNetworkIds =
                    networks |> List.map .id
            in
            ( { model
                | freqs =
                    model.freqs
                        |> ListX.updateIf (\f -> f.freq == freqS)
                            (\f -> { f | networkIds = networks |> List.map .id })
              }
            , E.getNetworksInfoByIds NetworksReturnedByApi newNetworkIds
            )

        DateTimeFromMsg imsg ->
            let
                ( m2, eff2 ) =
                    Le.Block.DateTime.update
                        { zone = model.zone
                        , msg = imsg
                        , model = model.from
                        , toModel = \from -> { model | from = from }
                        , toMsg = DateTimeFromMsg
                        }
            in
            ( { m2
                | locationTexts = Dict.empty
                , callsignsForFilter = NeedsReload (RD.withDefault [] model.callsignsForFilter)
              }
            , E.batch [ eff2, initLoad m2 ]
            )

        DateTimeToMsg imsg ->
            let
                ( m2, eff2 ) =
                    Le.Block.DateTime.update
                        { zone = model.zone
                        , msg = imsg
                        , model = model.to
                        , toModel = \to -> { model | to = to }
                        , toMsg = DateTimeToMsg
                        }
            in
            ( { m2 | callsignsForFilter = NeedsReload (RD.withDefault [] model.callsignsForFilter) }
            , E.batch [ eff2, initLoad m2 ]
            )

        GotTime zone now_ ->
            let
                from =
                    Le.Block.DateTime.initFromPosix { datePosix = Le.Time.xDaysAgo 7 now_, zone = zone }

                to =
                    Le.Block.DateTime.initFromPosix { datePosix = now_, zone = zone }

                m2 =
                    { model
                        | from = from
                        , to = to
                        , now = Just now_
                    }
            in
            ( m2, initLoad m2 )

        UnitsReturnedByApi (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підрозділів" err
            )

        UnitsReturnedByApi (Ok rsp) ->
            ( { model
                | masterUnits =
                    rsp.units
                        |> List.map (\x -> ( x.id, x ))
                        |> Dict.fromList
              }
            , E.none
            )

        UnitsReload ->
            ( model, loadUnits )

        NetworkAddUnitSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.networkDialogUnitSelect.state

                updatedUnitId =
                    Le.Block.Select.singleUpd mAct model.networkDialogUnitSelect.selected

                networkWorkflowStatus =
                    case ( model.networkWorkflowStatus, mAct ) of
                        ( SelectingNetwork freq _, Just (Select.Select i) ) ->
                            let
                                a =
                                    Utils.findConnectedNetworks (Just i) model.networks model.masterUnits

                                -- Filter out networks already connected to this frequency
                                alreadyConnectedNetworkIds =
                                    ListX.find (\freq_ -> freq_.freq == freq) model.freqs
                                        |> Maybe.map .networkIds
                                        |> Maybe.withDefault []

                                availableNetworks =
                                    List.filter (\n -> not (List.member n.id alreadyConnectedNetworkIds)) a
                            in
                            case availableNetworks of
                                x :: xs ->
                                    SelectingNetwork freq (Just x.id)

                                _ ->
                                    SelectingNetwork freq Nothing

                        ( SelectingNetwork freq _, Just Select.Clear ) ->
                            SelectingNetwork freq Nothing

                        _ ->
                            model.networkWorkflowStatus

                inputChangeCmd =
                    case mAct of
                        Just (Select.InputChange query) ->
                            if String.length query > 2 then
                                Task.perform (\_ -> UnitsSearchDebounceTimerExpired query)
                                    (Process.sleep 300)

                            else
                                Cmd.none

                        _ ->
                            Cmd.none

                unitsSelect =
                    model.networkDialogUnitSelect

                unitsSelect2 =
                    { unitsSelect
                        | state = imodel
                        , selected = updatedUnitId
                    }
            in
            ( { model
                | networkDialogUnitSelect = unitsSelect2
                , networkWorkflowStatus = networkWorkflowStatus
              }
            , E.batch
                [ E.sendCmd <|
                    Cmd.map
                        NetworkAddUnitSelMsg
                        icmd
                , E.sendCmd inputChangeCmd
                ]
            )

        UnitsSearchDebounceTimerExpired query ->
            ( model, E.sendCmd <| Api.units_search UnitsSearchReturned "units-search" { search = query } )

        UnitsSearchReturned (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка пошуку підрозділів" e
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
                    Le.Block.Select.singleUpd mAct model.addExistingModulationSelect.selected

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
                    Le.Block.Select.singleUpdWithDefault mAct model.addExistingKindSelect.selected

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

        NetworksReturnedByApi (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж" err
            )

        NetworksReturnedByApi (Ok networks) ->
            ( { model
                | networks =
                    networks
                        |> List.map (\x -> ( x.id, x ))
                        |> Dict.fromList
                        |> (\v -> Dict.union v model.networks)
              }
            , E.none
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
                        , callsignsForFilter = NeedsReload (RD.withDefault [] model.callsignsForFilter)
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок карти" err
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" err
            )

        AltUnitsByFreqReturnedByApi (Ok rsp) ->
            ( { model | altUnitsByFreq = rsp }
            , E.none
            )

        AltUnitsByFreqReturnedByApi (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження альтернативних підрозділів" err
            )

        CallsignsInfoReturnedByApi (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації позивних" e
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
                        Dict.empty
                        callsignsRes
            in
            ( { model | callsignsInfo = updatedCallsignsInfo }, E.none )

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
            ( model
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
                    Le.Block.Select.multiUpdMenuOpen mAction model.filterState.callsigns imodel2

                currentFilterState =
                    model.filterState

                updatedFilterState =
                    { currentFilterState | callsigns = updatedSelectedItems }

                m2 =
                    { model
                        | selCallsignState = state
                        , filterState = updatedFilterState
                    }

                ( x, eff3 ) =
                    focusAndReloadDataIfNeeded mAction model.filterState.callsigns m2.callsignsForFilter CallsignsFilter m2

                m3 =
                    { m2
                        | focusedFilterItemsBeforeChange = x.focusedFilterItemsBeforeChange
                        , callsignsForFilter = x.items
                    }

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

        GotFilterCallsigns (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження фільтру позивних" e
            )

        GotFilterCallsigns (Ok rsp) ->
            ( { model
                | callsignsForFilter = Success rsp.callsigns
                , callsigns =
                    List.map
                        (\callsign ->
                            callsign.callsign
                        )
                        rsp.callsigns
              }
            , E.none
            )

        OpenAddNetworkSidebar freq ->
            ( { model
                | networkWorkflowStatus = SelectingNetwork freq Nothing

                --TODO: remove workaround related to loading from Shared
                , addPostsSelect =
                    Le.Block.Select.updateSelectItems
                        (\_ ->
                            List.map
                                (\post -> Select.basicMenuItem { item = post.id, label = post.name })
                                (RD.withDefault Dict.empty shared.posts |> Dict.values)
                        )
                        model.addPostsSelect
                , editPostsSelect =
                    Le.Block.Select.updateSelectItems
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
                    , sinceDateInclusiveMs = Time.posixToMillis (Le.Time.xDaysAgo 30 (Time.millisToPosix shared.now))
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання підтвердження мережі" e
            )

        NetworkConfirmationAdded (Ok network) ->
            let
                m1 =
                    { model
                        | addConfirmationInp = Nothing
                        , networks = Dict.insert network.id network model.networks
                    }
            in
            ( m1, E.none )

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
            case Dict.get id model.networks of
                Just network ->
                    ( { model | networkAddLoading = True }
                    , E.addFreqToNetwork (FreqAddedToNetwork freq)
                        { networkId = network.id
                        , freqRec =
                            { freq = freq
                            , kind = NetworksUtils.networkKindToString model.addExistingKindSelect.selected
                            , modulationId = model.addExistingModulationSelect.selected
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

                _ ->
                    ( model, E.none )

        FreqAddedToNetwork _ (Err e) ->
            ( { model | networkAddLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання частоти до мережі" e
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
                | networks = Dict.insert network.id network model.networks
                , freqs = freqs2
                , networkWorkflowStatus = SelectingNetwork freq Nothing
                , networkDialogUnitSelect = aus2
                , networkAddLoading = False
              }
            , E.none
            )

        FreqRemoveFromExistingNetwork freq network ->
            ( { model | networkAddLoading = True }
            , E.removeFreqFromNetwork (FreqRemovedFromNetwork freq)
                { networkId = network.id
                , freq = freq
                }
            )

        FreqRemovedFromNetwork _ (Err e) ->
            ( { model | networkAddLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення частоти з мережі" e
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
                | networks = Dict.insert network.id network model.networks
                , freqs = freqs2
                , networkWorkflowStatus = SelectingNetwork freq Nothing
                , networkAddLoading = False
              }
            , E.none
            )

        NetworkUpdated _ (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення мережі" e
            )

        NetworkUpdated freq (Ok network) ->
            ( { model
                | networks = Dict.insert network.id network model.networks
                , networkWorkflowStatus = SelectingNetwork freq Nothing
              }
            , E.none
            )

        ModulationsReturnedByApi (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження модуляцій" e
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
                                |> List.map (\modulation -> Select.basicMenuItem { item = modulation.id, label = modulation.name })
                    }

                aems =
                    { addExistingModulationSelect
                        | items =
                            modulations
                                |> List.map (\modulation -> Select.basicMenuItem { item = modulation.id, label = modulation.name })
                    }

                ems =
                    { editModulationSelect
                        | items =
                            modulations
                                |> List.map (\modulation -> Select.basicMenuItem { item = modulation.id, label = modulation.name })
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності груп частот" err
            )

        NetworkPostsUpdated freq editState (Ok r) ->
            ( model
            , E.updateNetworkFreq (NetworkFreqUpdated freq editState)
                { networkId = editState.id
                , freq = freq
                , kind = NetworksUtils.networkKindToString model.editKindSelect.selected
                , modulationId = model.editModulationSelect.selected
                , activeFrom = 0
                , activeTo = Nothing
                }
            )

        NetworkPostsUpdated _ _ (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення постів мережі" err
            )

        NetworkFreqUpdated freq editState (Ok r) ->
            ( model, E.updateNetwork (NetworkUpdated freq) editState )

        NetworkFreqUpdated _ _ (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення частоти мережі" err
            )

        ConfirmationInputChangedByUser val ->
            ( { model | addExistingConfirmationInp = Just val }, E.none )

        Confirmation2InputChangedByUser val ->
            ( { model | addConfirmationInp = Just val }, E.none )

        UnitsReloadClickedByUser ->
            ( model, loadUnits )

        NetworkAddExistingActiveFromChanged x ->
            ( { model
                | addExistingActiveFrom =
                    case Le.Time.parseDateParts x of
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
                    case Le.Time.parseDateParts x of
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
                :: (Le.Block.DateTime.new
                        { model = model.from
                        , toMsg = DateTimeFromMsg
                        }
                        |> Le.Block.DateTime.view
                   )
                ++ [ div
                        [ class "me-2"
                        , style "font-size" "1rem"
                        ]
                        [ text "по" ]
                   ]
                ++ (Le.Block.DateTime.new
                        { model = model.to
                        , toMsg = DateTimeToMsg
                        }
                        |> Le.Block.DateTime.view
                   )
        ]


leftPanel : Shared.Model -> Model -> Html Msg
leftPanel shared model =
    div
        [ class "self-stretch max-h-full min-w-[300px]  w-[22vw] overflow-y-auto border-r border-border bg-card relative transition-all duration-300"
        ]
        [ button
            [ class "absolute top-2 right-2 z-10 px-2 py-1 rounded border border-border bg-card hover:bg-gray-100 transition"
            , onClick ToggleSidebar
            , attribute "title" "Сховати підрозділи"
            ]
            [ i [ class "bi bi-chevron-left" ] [] ]
        , unitsBlock shared model
        , div [ class "flex-grow-1" ] []
        ]


unitsBlock : Shared.Model -> Model -> Html Msg
unitsBlock shared model =
    let
        config : UnitHierarchy.Config Msg
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
        Le.Block.Spinner.loadingSpinner

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
                [ UnitHierarchy.view config (Dict.toList model.masterUnits |> List.map Tuple.second) model.unitStats ]
            ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "частоти"
    , body =
        [ div [ class "flex justify-start items-start page-rer-freqs", style "height" "calc(-50px + 100vh)" ]
            [ if model.showSidebar then
                leftPanel shared model

              else
                text ""
            , div
                [ class "grow-1 overflow-y-auto"
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
                                    [ Le.Block.Spinner.loadingSpinner2Sm ]

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
                            (NetworkWorkflow.view model shared)
                        , div
                            [ class "border mb-4 p-2"
                            ]
                            [ FilterPanel.view shared model
                            ]
                        , Table.view shared model user
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
        , view = view shared.isDarkMode shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }
