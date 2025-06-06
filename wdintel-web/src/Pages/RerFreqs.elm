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
import Layouts
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.DateTime
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Toast
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types as Types exposing (ApiError, GroupsActivityPerDayRsp)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import PagePorts.RerFreqsPorts as Ports
import RerFreqs.FilterPanel as FilterPanel
import RerFreqs.Model exposing (FilterName(..), NetworkAddStatus(..), ReportCreation(..), TextLocation(..))
import RerFreqs.Msg exposing (Msg(..))
import RerFreqs.NetworkConnection as NetworkConnection
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
            { formErrors = Dict.empty
            , toasts = Le.Block.Toast.init
            , zone = Nothing
            , now = Nothing
            , loading = False
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
            , reportDownloadInProgress = False
            , reportModalOpen = False
            , reportStatus = ReportBasic
            , adjacentFreqsRangeSelect =
                { state = Select.initState (Select.selectIdentifier "selectAdjacentFreqsRange")
                , items = [ Select.basicMenuItem { item = B.ShortRange, label = Utils.adjacentRangeToLabel B.ShortRange }, Select.basicMenuItem { item = B.LongRange, label = Utils.adjacentRangeToLabel B.LongRange } ]
                , selected = B.ShortRange
                }
            , networkAddStatus = NotStarted
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
    { strategy = Debounce.later 50
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
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        GotZone (Err e) ->
            ( model
            , E.sendCmd <|
                Le.Block.Toast.addError
                    ToastMsg
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
            Api.handleHttpError ToastMsg err { model | loading = False }

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
            Api.handleHttpError ToastMsg err model

        GotFreqNetworks _ (Err err) ->
            Api.handleHttpError ToastMsg err model

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
            Api.handleHttpError ToastMsg err model

        UnitsReturnedByApi (Ok rsp) ->
            let
                m1 =
                    { model
                        | masterUnits =
                            rsp.units
                                |> List.map (\x -> ( x.id, x ))
                                |> Dict.fromList
                    }

                items =
                    Dict.toList m1.masterUnits
                        |> List.map
                            (\( unitId, unit ) ->
                                Select.basicMenuItem
                                    { item = unitId
                                    , label = unit.name
                                    }
                            )

                addUnitsSelect =
                    m1.networkDialogUnitSelect

                au2 =
                    { addUnitsSelect | items = items }
            in
            ( { m1 | networkDialogUnitSelect = au2 }
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

                networkAddStatus =
                    case ( model.networkAddStatus, mAct ) of
                        ( SelectFromExistingNetwork freq _, Just (Select.Select i) ) ->
                            let
                                a =
                                    Utils.findConnectedNetworks (Just i) model.networks model.masterUnits
                            in
                            case a of
                                x :: xs ->
                                    SelectFromExistingNetwork freq (Just x.id)

                                _ ->
                                    SelectFromExistingNetwork freq Nothing

                        ( SelectFromExistingNetwork freq _, Just Select.Clear ) ->
                            SelectFromExistingNetwork freq Nothing

                        _ ->
                            model.networkAddStatus

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
                , networkAddStatus = networkAddStatus
              }
            , E.sendCmd <|
                Cmd.map
                    NetworkAddUnitSelMsg
                    icmd
            )

        NetworkAddModulationSelMsg imsg ->
            case model.networkAddStatus of
                CreateNewNetwork freq addNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.addModulationSelect.state

                        updatedNetworkModulation =
                            Le.Block.Select.singleUpd mAct model.addModulationSelect.selected

                        modulationSelect =
                            model.addModulationSelect

                        modulationSelect2 =
                            { modulationSelect
                                | state = imodel
                                , selected = updatedNetworkModulation
                            }

                        f2 =
                            case addNetworkState.freqs |> Maybe.andThen List.head of
                                Just freqObj ->
                                    Just [ { freqObj | modulationId = updatedNetworkModulation } ]

                                Nothing ->
                                    Nothing

                        ns2 =
                            { addNetworkState | freqs = f2 }
                    in
                    ( { model | addModulationSelect = modulationSelect2, networkAddStatus = CreateNewNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkAddModulationSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

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
                    NetworkAddModulationSelMsg
                    icmd
            )

        NetworkAddPostsSelMsg imsg ->
            case model.networkAddStatus of
                CreateNewNetwork freq addNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.addPostsSelect.state

                        updatedNetworkPosts =
                            Le.Block.Select.multiUpdI mAct model.addPostsSelect.selected

                        postsSelect =
                            model.addPostsSelect

                        postsSelect2 =
                            { postsSelect
                                | state = imodel
                                , selected = updatedNetworkPosts
                            }

                        ns2 =
                            { addNetworkState | postIds = updatedNetworkPosts }
                    in
                    ( { model | addPostsSelect = postsSelect2, networkAddStatus = CreateNewNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkAddPostsSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        NetworkEditPostsSelMsg imsg ->
            case model.networkAddStatus of
                EditConnectedNetwork freq editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editPostsSelect.state

                        updatedNetworkPosts =
                            Le.Block.Select.multiUpdI mAct model.editPostsSelect.selected

                        postsSelect =
                            model.editPostsSelect

                        postsSelect2 =
                            { postsSelect
                                | state = imodel
                                , selected = updatedNetworkPosts
                            }
                    in
                    ( { model | editPostsSelect = postsSelect2, networkAddStatus = EditConnectedNetwork freq editNetworkState }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditPostsSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        NetworkAddKindSelMsg imsg ->
            case model.networkAddStatus of
                CreateNewNetwork freq addNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.addKindSelect.state

                        updatedNetworkKind =
                            Le.Block.Select.singleUpdWithDefault mAct model.addKindSelect.selected

                        kindSelect =
                            model.addKindSelect

                        kindSelect2 =
                            { kindSelect
                                | state = imodel
                                , selected = updatedNetworkKind
                            }

                        f2 =
                            case addNetworkState.freqs |> Maybe.andThen List.head of
                                Just freqObj ->
                                    Just [ { freqObj | kind = NetworksUtils.networkKindToString updatedNetworkKind } ]

                                Nothing ->
                                    Nothing

                        ns2 =
                            { addNetworkState | freqs = f2 }
                    in
                    ( { model | addKindSelect = kindSelect2, networkAddStatus = CreateNewNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkAddKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
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

        NetworkEditModulationSelMsg imsg ->
            case model.networkAddStatus of
                EditConnectedNetwork freq editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editModulationSelect.state

                        updatedNetworkModulation =
                            Le.Block.Select.singleUpd mAct model.editModulationSelect.selected

                        modulationSelect =
                            model.editModulationSelect

                        modulationSelect2 =
                            { modulationSelect
                                | state = imodel
                                , selected = updatedNetworkModulation
                            }
                    in
                    ( { model | editModulationSelect = modulationSelect2 }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditModulationSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        NetworkEditKindSelMsg imsg ->
            case model.networkAddStatus of
                EditConnectedNetwork freq editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editKindSelect.state

                        updatedNetworkKind =
                            Le.Block.Select.singleUpdWithDefault mAct model.editKindSelect.selected

                        kindSelect =
                            model.editKindSelect

                        kindSelect2 =
                            { kindSelect
                                | state = imodel
                                , selected = updatedNetworkKind
                            }
                    in
                    ( { model | editKindSelect = kindSelect2 }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
                    )

        NetworkAddMsg addNetworkState ->
            ( { model
                | networkAddStatus =
                    case model.networkAddStatus of
                        CreateNewNetwork freq _ ->
                            CreateNewNetwork freq addNetworkState

                        _ ->
                            model.networkAddStatus
              }
            , E.none
            )

        NetworkEditMsg editNetworkState ->
            ( { model
                | networkAddStatus =
                    case model.networkAddStatus of
                        EditConnectedNetwork freq _ ->
                            EditConnectedNetwork freq editNetworkState

                        _ ->
                            model.networkAddStatus
              }
            , E.none
            )

        NetworksReturnedByApi (Err err) ->
            Api.handleHttpError ToastMsg err model

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
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterStateDebounceConfig
                        (Debounce.takeLast (\_ -> loadFreqs model False))
                        imsg
                        model.filterStateDebounce
            in
            ( { model
                | filterStateDebounce = debounce
                , loading = True
                , callsignsForFilter = NeedsReload (RD.withDefault [] model.callsignsForFilter)
              }
            , E.sendCmd debounceCmd
            )

        UnitStatsReturnedByApi (Err err) ->
            Api.handleHttpError ToastMsg err { model | loadingUnitStats = False }

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
            Api.handleHttpError ToastMsg err model

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
            Api.handleHttpError ToastMsg err model

        AltUnitsByFreqReturnedByApi (Ok rsp) ->
            ( { model | altUnitsByFreq = rsp }
            , E.none
            )

        AltUnitsByFreqReturnedByApi (Err err) ->
            Api.handleHttpError ToastMsg err model

        CallsignsInfoReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e model

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
            Api.handleHttpError ToastMsg e model

        GotFilterCallsigns (Ok rsp) ->
            ( { model
                | callsignsForFilter = Success rsp.callsigns
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

        ReportEtalonkaDownload isFullEtalonka ->
            ( { model | reportDownloadInProgress = True }
            , E.sendCmd <| prepareReportDownloadCmd model isFullEtalonka
            )

        ReportEtalonkaDownloadDone (Err e) ->
            let
                m2 =
                    { model | reportDownloadInProgress = False }
            in
            Api.handleHttpError ToastMsg e m2

        ReportEtalonkaDownloadDone (Ok bytes) ->
            let
                m2 =
                    { model | reportDownloadInProgress = False }

                extension =
                    "docx"

                -- filename like "etalonka_2023-07-17-12-00_2023-07-18-12-00"
                fname =
                    case model.zone of
                        Nothing ->
                            "etalonka." ++ extension

                        Just zone ->
                            "etalonka_"
                                ++ (model.from.datePosix
                                        |> mmap (Le.Time.renderDateTimeF6 zone)
                                        |> def ""
                                   )
                                ++ "_"
                                ++ (model.to.datePosix
                                        |> mmap (Le.Time.renderDateTimeF6 zone)
                                        |> def ""
                                   )
                                ++ "."
                                ++ extension
            in
            ( m2
            , E.sendCmd <|
                Download.bytes fname
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    bytes
            )

        OpenReportModal ->
            ( { model | reportModalOpen = True }, E.none )

        CloseReportModal ->
            ( { model | reportModalOpen = False }, E.none )

        ChangeReportStatus _ ->
            ( { model
                | reportStatus =
                    case model.reportStatus of
                        ReportBasic ->
                            ReportWithAdjacentFreqs B.ShortRange

                        ReportWithAdjacentFreqs _ ->
                            ReportBasic
              }
            , E.none
            )

        SelectReportAdjacentFreqsRange imsg ->
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
            in
            ( { model
                | adjacentFreqsRangeSelect = a2
                , reportStatus = ReportWithAdjacentFreqs a2.selected
              }
            , E.sendCmd <|
                Cmd.map SelectReportAdjacentFreqsRange icmd
            )

        OpenAddNetworkSidebar freq ->
            ( { model
                | networkAddStatus = SelectFromExistingNetwork freq Nothing

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
            ( { model | networkAddStatus = NotStarted, networkDialogUnitSelect = unitSelect2 }, E.none )

        NetworkCreate ->
            case model.networkAddStatus of
                CreateNewNetwork freq state ->
                    let
                        freqs =
                            ListX.updateIf (\f -> f.freq == freq)
                                (\oldFreq ->
                                    let
                                        desc =
                                            { descrType = B.Confirmation
                                            , description = Maybe.withDefault "" model.addConfirmationInp
                                            , freq = freq
                                            }
                                    in
                                    { oldFreq | description = Just desc }
                                )
                                (Maybe.withDefault [] state.freqs)
                    in
                    ( model
                    , E.createNetwork (NetworkCreated freq) { state | freqs = Just freqs }
                    )

                _ ->
                    ( model, E.none )

        NetworkCreated _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkCreated freq (Ok network) ->
            let
                fre =
                    ListX.find (\freq_ -> freq_.freq == freq) model.freqs

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
                , networkAddStatus = NotStarted
                , freqs = freqs2
              }
            , E.none
            )

        NetworkConfirmationAdded (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkConfirmationAdded (Ok network) ->
            let
                m1 =
                    { model
                        | addConfirmationInp = Nothing
                        , networks = Dict.insert network.id network model.networks
                    }
            in
            ( m1, E.none )

        NetworkStartCreatingFlow ->
            ( { model
                | networkAddStatus =
                    case ( model.networkDialogUnitSelect.selected, model.networkAddStatus ) of
                        ( Just unitId, SelectFromExistingNetwork freq _ ) ->
                            CreateNewNetwork freq
                                { name = "управління"
                                , location = ""
                                , comment = ""
                                , radioStation = Nothing
                                , operationType = Just "дуплексний"
                                , operationMode = Just "цілодобово, за потреби"
                                , purpose = Just "для управління підлеглим особовим складом"

                                --, kind =
                                , unitIds = [ unitId ]
                                , freqs =
                                    Just
                                        [ { freq = freq
                                          , kind = NetworksUtils.networkKindToString model.addKindSelect.selected
                                          , modulationId = model.addModulationSelect.selected
                                          , description = Nothing
                                          }
                                        ]
                                , operationPeriod = Nothing
                                , activeTo = Nothing
                                , activeFrom = Nothing

                                --, modulationId = model.addmodulationselect.selected
                                , postIds = []
                                , descriptions = []
                                }

                        _ ->
                            model.networkAddStatus
              }
            , E.none
            )

        NetworkStartEditingFlow network ->
            let
                m1 =
                    case model.networkAddStatus of
                        SelectFromExistingNetwork freq _ ->
                            let
                                mFreqObj =
                                    ListX.find (\x -> x.freq == freq) network.freqs

                                ems =
                                    model.editModulationSelect

                                ems2 =
                                    { ems | selected = Maybe.andThen .modulationId mFreqObj }

                                eks =
                                    model.editKindSelect

                                eks2 =
                                    { eks
                                        | selected =
                                            Maybe.map .kind mFreqObj
                                                |> Maybe.andThen (\a -> Just (NetworksUtils.networkKindFromString a))
                                                |> Maybe.withDefault NetworksUtils.VHF
                                    }
                            in
                            { model
                                | networkAddStatus =
                                    EditConnectedNetwork freq
                                        { id = network.id
                                        , name = network.name
                                        , location = network.location
                                        , comment = network.comment
                                        , radioStation = network.radioStation
                                        , operationType = network.operationType
                                        , operationMode = network.operationMode
                                        , purpose = network.purpose
                                        , operationPeriod = network.operationPeriod
                                        , activeTo = network.activeTo
                                        , activeFrom = network.activeFrom
                                        , descriptions = Nothing
                                        }
                                , editModulationSelect = ems2
                                , editKindSelect = eks2
                            }

                        _ ->
                            model
            in
            ( { m1
                | editPostsSelect =
                    Le.Block.Select.updateSelectSelected
                        (\_ -> network.postIds)
                        model.editPostsSelect
              }
            , E.none
            )

        NetworkAddToggleExistingId id ->
            ( { model
                | networkAddStatus =
                    case model.networkAddStatus of
                        SelectFromExistingNetwork freq (Just prevId) ->
                            if prevId == id then
                                SelectFromExistingNetwork freq Nothing

                            else
                                SelectFromExistingNetwork freq (Just id)

                        SelectFromExistingNetwork freq Nothing ->
                            SelectFromExistingNetwork freq (Just id)

                        _ ->
                            model.networkAddStatus
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
            Api.handleHttpError ToastMsg e { model | networkAddLoading = False }

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
                , networkAddStatus = SelectFromExistingNetwork freq Nothing
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
            Api.handleHttpError ToastMsg e { model | networkAddLoading = False }

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
                , networkAddStatus = SelectFromExistingNetwork freq Nothing
                , networkAddLoading = False
              }
            , E.none
            )

        NetworkUpdate ->
            case model.networkAddStatus of
                EditConnectedNetwork freq state ->
                    ( model
                    , E.batch
                        [ E.updateNetworkPosts (NetworkPostsUpdated freq state) { networkId = state.id, postIds = model.editPostsSelect.selected } ]
                    )

                _ ->
                    ( model, E.none )

        NetworkUpdated _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkUpdated freq (Ok network) ->
            ( { model
                | networks = Dict.insert network.id network model.networks
                , networkAddStatus = SelectFromExistingNetwork freq Nothing
              }
            , E.none
            )

        ModulationsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e model

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
            Api.handleHttpError ToastMsg err { model | freqGroupsActivityForNetworkAdd = Failure err }

        NetworkPostsUpdated freq editState (Ok r) ->
            ( model
            , E.updateNetworkFreq (NetworkFreqUpdated freq editState)
                { networkId = editState.id
                , freq = freq
                , kind = NetworksUtils.networkKindToString model.editKindSelect.selected
                , modulationId = model.editModulationSelect.selected
                }
            )

        NetworkPostsUpdated _ _ (Err err) ->
            Api.handleHttpError ToastMsg err model

        NetworkFreqUpdated freq editState (Ok r) ->
            ( model, E.updateNetwork (NetworkUpdated freq) editState )

        NetworkFreqUpdated _ _ (Err err) ->
            Api.handleHttpError ToastMsg err model

        ConfirmationInputChangedByUser val ->
            ( { model | addExistingConfirmationInp = Just val }, E.none )

        Confirmation2InputChangedByUser val ->
            ( { model | addConfirmationInp = Just val }, E.none )

        UnitsReloadClickedByUser ->
            ( model, loadUnits )


prepareReportDownloadCmd : Model -> Bool -> Cmd Msg
prepareReportDownloadCmd model fullEtalonka =
    case ( model.from.datePosix, model.to.datePosix ) of
        ( Just dtFromPosix, Just dtToPosix ) ->
            let
                listFreqReq =
                    { sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
                    , tillDateNoninclusiveMs = Time.posixToMillis dtToPosix
                    , newOnly = model.newOnly
                    , includeNonActive = model.includeNonActive
                    , filterFreq = emptySToNothing model.filterState.freq
                    , sortBy = Just [ model.sortingOrder ]
                    , filterUnit = emptySToNothing model.filterState.unit
                    , filterCallsigns = emptyToNothing model.filterState.callsigns
                    , afterFreqNonincl = Nothing
                    , filterGroupMasterKeys = Nothing
                    , filterSenderProfileIds = Nothing
                    }

                etalonkaReq =
                    { fullEtalonkaReport = fullEtalonka
                    , listFreqReq = listFreqReq
                    , adjacentFreqsDistance =
                        case model.reportStatus of
                            ReportBasic ->
                                Nothing

                            ReportWithAdjacentFreqs x ->
                                Just x
                    }
            in
            Api.rer_freq_report_etalonka ReportEtalonkaDownloadDone etalonkaReq

        _ ->
            Cmd.none


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


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "частоти"
    , body =
        [ Le.Block.Toast.view ToastMsg model.toasts <|
            div [ class "d-flex justify-content-start align-items-start page-rer-freqs" ]
                [ RerFreqs.UnitsFilterSidebar.view shared model
                , div
                    [ class "border-start flex-grow-1"
                    , style "height" "calc(-50px + 100vh)"
                    , style "overflow-y" "auto"
                    ]
                    [ h1 [ class "py-2 ps-4" ]
                        [ div [ class "d-flex justify-content-between align-items-center" ]
                            [ -- Left-side content
                              div [ class "d-flex align-items-center me-auto" ]
                                [ span [ class "me-2" ] [ text "частоти" ]
                                , button
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
                                case model.networkAddStatus of
                                    NotStarted ->
                                        False

                                    _ ->
                                        True
                          in
                          div []
                            [ Sidebar.view networkAddSidebarOpen CloseAddNetworkSidebar (NetworkConnection.view model shared)
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
