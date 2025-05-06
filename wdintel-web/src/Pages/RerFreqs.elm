module Pages.RerFreqs exposing (FilterState, Model, Msg, TextLocation, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Components.Button as Button
import Components.ModalDialog as ModalDialog
import Components.Sidebar as Sidebar
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import Le.Auth
import Le.Block.ActionMenu
import Le.Block.Callsign
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.DateTime
import Le.Block.Popup
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Toast
import Le.Block.Unit as Unit
import Le.Callsign
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types as Types exposing (ApiError, GroupsActivityPerDayRsp)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import PagePorts.RerFreqsPorts as Ports
import Route exposing (Route)
import Select
import Set
import Shared
import Task
import Time exposing (Posix)
import Time.Extra
import TimeZone
import Url.Builder
import View exposing (View)


type ReportCreation
    = ReportBasic
    | ReportWithAdjacentFreqs B.AdjacentFreqDistance


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , zone : Maybe Time.Zone
    , now : Maybe Time.Posix
    , loading : Bool
    , newOnly : Bool
    , includeNonActive : Bool
    , freqs : List B.Freq
    , from : Le.Block.DateTime.Model
    , to : Le.Block.DateTime.Model
    , masterUnits : Dict Int B.Unit
    , networks : Dict Int B.Network
    , filterState : FilterState
    , filterStateDebounce : Debounce FilterState
    , loadingUnitStats : Bool
    , unitStats : List B.FreqUnitStatRow
    , locationTexts : Dict String TextLocation
    , openMapRowId : Maybe String
    , callsignsByFreq : Api.ListCallsignsByFreqsRsp
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , showAllCallsignsForFreq : Maybe String
    , selCallsignState : Select.State
    , selCallsignMenu : List (Select.MenuItem String)
    , callsignsForFilter : RemoteData ApiError (List B.FreqCallsign)
    , focusedFilterItemsBeforeChange : Maybe (List String)

    --TODO Remove when back returns proper list of data for table
    , callsigns : List String
    , altUnitsByFreq : Api.ListAltUnitsByFreqsRsp
    , sortingOrder : B.ListFreqsSortBy
    , groupsMessageCountByDay : GroupsActivityPerDayRsp
    , noMoreToLoad : Bool
    , reportDownloadInProgress : Bool
    , reportModalOpen : Bool
    , reportStatus : ReportCreation
    , adjacentFreqsRangeSelect :
        { state : Select.State
        , items : List (Select.MenuItem B.AdjacentFreqDistance)
        , selected : B.AdjacentFreqDistance
        }
    , networkAddStatus : NetworkAddStatus
    , networkAddLoading : Bool
    , networkDialogUnitSelect : Le.Block.Select.SelectTypeSingle Int
    , addKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , addModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqGroupsActivityForNetworkAdd : RemoteData ApiError B.FreqDailyActivityCount
    }


type NetworkAddStatus
    = NotStarted
    | SelectFromExistingNetwork String (Maybe Int)
    | EditExistingNetwork String B.UpdateNetworkReq
    | CreateNewNetwork String B.CreateNetworkReq


type alias FilterState =
    { freq : String
    , unit : String
    , callsigns : List String
    }


type TextLocation
    = NoCoords
    | LocationText


type FilterName
    = CallsignsFilter


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
            , showAllCallsignsForFreq = Nothing
            , selCallsignState = Select.initState (Select.selectIdentifier "selCallsignState")
            , selCallsignMenu = []
            , callsignsForFilter = NotAsked
            , focusedFilterItemsBeforeChange = Nothing
            , reportDownloadInProgress = False
            , reportModalOpen = False
            , reportStatus = ReportBasic
            , adjacentFreqsRangeSelect =
                { state = Select.initState (Select.selectIdentifier "selectAdjacentFreqsRange")
                , items = [ Select.basicMenuItem { item = B.ShortRange, label = adjacentRangeToLabel B.ShortRange }, Select.basicMenuItem { item = B.LongRange, label = adjacentRangeToLabel B.LongRange } ]
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
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <| Task.attempt GotZone Le.Time.getZone
        , initLoad m2
        , E.getModulations ModulationsReturnedByApi
        ]
    )


adjacentRangeToLabel value =
    case value of
        B.ShortRange ->
            "5 кГц"

        B.LongRange ->
            "7.5 кГц"


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | Refresh
    | GotFreqs Bool (Result ApiError B.ListFreqsRsp)
    | GotFreqNetworks String (Result ApiError (List B.Network))
    | DateTimeFromMsg (Le.Block.DateTime.Msg Msg)
    | DateTimeToMsg (Le.Block.DateTime.Msg Msg)
    | GotZone (Result TimeZone.Error ( String, Time.Zone ))
    | GotTime Time.Zone Posix
    | GotUnits (Result ApiError B.ListUnitsRsp)
      -- if Nothing -- adding a new network, if Just -- editing an existing network
    | AddNetworkUnitSelMsg (Select.Msg Int)
    | AddNetworkKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | AddNetworkModulationSelMsg (Select.Msg Int)
    | EditNetworkKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | EditNetworkModulationSelMsg (Select.Msg Int)
    | AddNetworkMsg B.CreateNetworkReq
    | EditNetworkMsg B.UpdateNetworkReq
    | GotNetworks (Result ApiError (List B.Network))
    | FilterStateMsg FilterState
    | FilterStateDebounceMsg Debounce.Msg
    | GotUnitStats (Result ApiError B.FreqUnitStatsRsp)
    | ReloadUnits
    | SwitchFromTextToMap String
    | CloseMap String
    | GotPointsByFreq String (Result ApiError B.ListPointsByFreqRsp)
    | GotCallsignsByFreqs (Result ApiError Api.ListCallsignsByFreqsRsp)
    | GotGroupsMessageCountByDay (Result ApiError GroupsActivityPerDayRsp)
    | GotCallsignsInfo (Result ApiError (List B.CallsignInfoRes))
    | GotAltUnitsByFreq (Result ApiError Api.ListAltUnitsByFreqsRsp)
    | SortByMessageNumber
    | LoadMoreFreqs
    | SetFreqToShowAllCallsignsPopup (Maybe String)
    | SelCallsignMsg (Select.Msg String)
    | GotFilterCallsigns (Result ApiError B.CallsignsForFreqRsp)
    | ReportEtalonkaDownload Bool
    | ReportEtalonkaDownloadDone (Result ApiError Bytes)
    | OpenReportModal
    | CloseReportModal
    | ChangeReportStatus Bool
    | SelectReportAdjacentFreqsRange (Select.Msg B.AdjacentFreqDistance)
    | OpenAddNetworkSidebar String
    | CloseAddNetworkSidebar
    | CreateNetwork
    | CreateNetworkDone String (Result ApiError B.Network)
    | UpdateNetwork
    | UpdateNetworkDone String (Result ApiError B.Network)
    | StartCreatingNewNetwork
    | AddFreqToExistingNetwork String Int
    | RemoveFreqFromExistingNetwork String B.Network
    | NetworkAddSelectExistingId Int
    | AddFreqToNetworkDone String (Result ApiError B.Network)
    | RemoveFreqFromNetworkDone String (Result ApiError B.Network)
    | StartEditingExistingNetwork B.Network
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | FreqGroupsActivityReturnedByApi (Result ApiError B.FreqDailyActivityCount)


loadUnits : Effect Msg
loadUnits =
    E.getUnits GotUnits
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
            Api.sigint_freq_unit_stats GotUnitStats
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
                (E.getNetworksInfoByIds GotNetworks networkIds
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
                                [ E.getGroupsActivityStats GotGroupsMessageCountByDay
                                    { freqs = freqsAsString
                                    , sinceDateInclusiveMs = timeFrom
                                    , tillDateNoninclusiveMs = timeTo
                                    }
                                , E.sendCmd <|
                                    Api.list_callsigns_by_freq GotCallsignsByFreqs
                                        { freqs = freqsAsString
                                        , sinceDateInclusiveMs = timeFrom
                                        , tillDateNoninclusiveMs = timeTo
                                        }
                                , E.sendCmd <|
                                    Api.list_alt_units_by_freqs GotAltUnitsByFreq
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

        GotGroupsMessageCountByDay (Ok r) ->
            ( { model | groupsMessageCountByDay = r }, E.none )

        GotGroupsMessageCountByDay (Err err) ->
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
            , E.getNetworksInfoByIds GotNetworks newNetworkIds
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

        GotUnits (Err err) ->
            Api.handleHttpError ToastMsg err model

        GotUnits (Ok rsp) ->
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

        ReloadUnits ->
            ( model, loadUnits )

        AddNetworkUnitSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.networkDialogUnitSelect.state

                updatedUnitIds =
                    Le.Block.Select.singleUpd mAct model.networkDialogUnitSelect.selected

                unitsSelect =
                    model.networkDialogUnitSelect

                unitsSelect2 =
                    { unitsSelect
                        | state = imodel
                        , selected = updatedUnitIds
                    }
            in
            ( { model | networkDialogUnitSelect = unitsSelect2 }
            , E.sendCmd <|
                Cmd.map
                    AddNetworkUnitSelMsg
                    icmd
            )

        AddNetworkModulationSelMsg imsg ->
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

                        ns2 =
                            { addNetworkState | modulationId = updatedNetworkModulation }
                    in
                    ( { model | addModulationSelect = modulationSelect2, networkAddStatus = CreateNewNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            AddNetworkModulationSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        AddNetworkKindSelMsg imsg ->
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

                        ns2 =
                            { addNetworkState | kind = NetworksUtils.networkKindToString updatedNetworkKind }
                    in
                    ( { model | addKindSelect = kindSelect2, networkAddStatus = CreateNewNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            AddNetworkKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
                    )

        EditNetworkModulationSelMsg imsg ->
            case model.networkAddStatus of
                EditExistingNetwork freq editNetworkState ->
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

                        ns2 =
                            { editNetworkState | modulationId = updatedNetworkModulation }
                    in
                    ( { model | editModulationSelect = modulationSelect2, networkAddStatus = EditExistingNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            AddNetworkModulationSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        EditNetworkKindSelMsg imsg ->
            case model.networkAddStatus of
                EditExistingNetwork freq editNetworkState ->
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

                        ns2 =
                            { editNetworkState | kind = NetworksUtils.networkKindToString updatedNetworkKind }
                    in
                    ( { model | editKindSelect = kindSelect2, networkAddStatus = EditExistingNetwork freq ns2 }
                    , E.sendCmd <|
                        Cmd.map
                            EditNetworkKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
                    )

        AddNetworkMsg addNetworkState ->
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

        EditNetworkMsg editNetworkState ->
            ( { model
                | networkAddStatus =
                    case model.networkAddStatus of
                        EditExistingNetwork freq _ ->
                            EditExistingNetwork freq editNetworkState

                        _ ->
                            model.networkAddStatus
              }
            , E.none
            )

        GotNetworks (Err err) ->
            Api.handleHttpError ToastMsg err model

        GotNetworks (Ok networks) ->
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

        GotUnitStats (Err err) ->
            Api.handleHttpError ToastMsg err { model | loadingUnitStats = False }

        GotUnitStats (Ok rsp) ->
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
                Api.list_points_by_freq (GotPointsByFreq containerId)
                    { freq = containerId
                    , sinceDateInclusiveMs = from
                    , tillDateNoninclusiveMs = to
                    }
            )

        CloseMap _ ->
            ( { model | openMapRowId = Nothing }, E.none )

        GotPointsByFreq containerId (Ok rsp) ->
            case rsp.points of
                [] ->
                    ( { model | locationTexts = Dict.update containerId (\_ -> Just NoCoords) model.locationTexts }, E.none )

                _ ->
                    ( { model | openMapRowId = Just containerId, locationTexts = Dict.insert containerId LocationText model.locationTexts }, E.sendCmd <| Ports.rer_freqs_openMap { points = rsp.points, containerId = containerId } )

        GotPointsByFreq _ (Err err) ->
            Api.handleHttpError ToastMsg err model

        GotCallsignsByFreqs (Ok rsp) ->
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
                E.getCallsignsInfo GotCallsignsInfo { callsigns = newCallsigns }

              else
                E.none
            )

        GotCallsignsByFreqs (Err err) ->
            Api.handleHttpError ToastMsg err model

        GotAltUnitsByFreq (Ok rsp) ->
            ( { model | altUnitsByFreq = rsp }
            , E.none
            )

        GotAltUnitsByFreq (Err err) ->
            Api.handleHttpError ToastMsg err model

        GotCallsignsInfo (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotCallsignsInfo (Ok callsignsRes) ->
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

        LoadMoreFreqs ->
            ( model
            , E.sendCmd <| loadFreqs model True
            )

        SetFreqToShowAllCallsignsPopup freqToShowAllCallsignsPopup ->
            ( { model | showAllCallsignsForFreq = freqToShowAllCallsignsPopup }
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
              }
            , E.getFreqActivityDaily FreqGroupsActivityReturnedByApi
                { freq = freq
                , sinceDateInclusiveMs = Time.posixToMillis (Le.Time.xDaysAgo 30 (Time.millisToPosix shared.now))
                , tillDateInclusiveMs = Nothing
                }
            )

        CloseAddNetworkSidebar ->
            let
                unitSelect =
                    model.networkDialogUnitSelect

                unitSelect2 =
                    { unitSelect | selected = Nothing }
            in
            ( { model | networkAddStatus = NotStarted, networkDialogUnitSelect = unitSelect2 }, E.none )

        CreateNetwork ->
            case model.networkAddStatus of
                CreateNewNetwork freq state ->
                    ( model, E.createNetwork (CreateNetworkDone freq) state )

                _ ->
                    ( model, E.none )

        CreateNetworkDone _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        CreateNetworkDone freq (Ok network) ->
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

        StartCreatingNewNetwork ->
            ( { model
                | networkAddStatus =
                    case ( model.networkDialogUnitSelect.selected, model.networkAddStatus ) of
                        ( Just unitId, SelectFromExistingNetwork freq _ ) ->
                            CreateNewNetwork freq
                                { name = "управління"
                                , location = ""
                                , comment = ""
                                , radioStation = Nothing
                                , confirmation = Nothing
                                , operationType = Just "дуплексний"
                                , operationMode = Just "цілодобово, за потреби"
                                , signs = Nothing
                                , purpose = Just "для управління підлеглим особовим складом"
                                , kind = NetworksUtils.networkKindToString model.addKindSelect.selected
                                , unitIds = [ unitId ]
                                , freqs = Just [ freq ]
                                , operationPeriod = Nothing
                                , activeTo = Nothing
                                , activeFrom = Nothing
                                , modulationId = model.addModulationSelect.selected
                                }

                        _ ->
                            model.networkAddStatus
              }
            , E.none
            )

        StartEditingExistingNetwork network ->
            let
                ( networkAddStatus, modulationSelected ) =
                    case model.networkAddStatus of
                        SelectFromExistingNetwork freq _ ->
                            ( EditExistingNetwork freq
                                { id = network.id
                                , name = network.name
                                , location = network.location
                                , comment = network.comment
                                , radioStation = network.radioStation
                                , confirmation = network.confirmation
                                , operationType = network.operationType
                                , operationMode = network.operationMode
                                , signs = network.signs
                                , purpose = network.purpose
                                , kind = network.kind
                                , modulationId = network.modulationId
                                , operationPeriod = network.operationPeriod
                                , activeTo = network.activeTo
                                , activeFrom = network.activeFrom
                                }
                            , network.modulationId
                            )

                        _ ->
                            ( model.networkAddStatus, Nothing )

                ems =
                    model.editModulationSelect

                ems2 =
                    { ems | selected = modulationSelected }
            in
            ( { model
                | networkAddStatus = networkAddStatus
                , editModulationSelect = ems2
              }
            , E.none
            )

        NetworkAddSelectExistingId id ->
            ( { model
                | networkAddStatus =
                    case model.networkAddStatus of
                        SelectFromExistingNetwork freq _ ->
                            SelectFromExistingNetwork freq (Just id)

                        _ ->
                            model.networkAddStatus
              }
            , E.none
            )

        AddFreqToExistingNetwork freq id ->
            case Dict.get id model.networks of
                Just network ->
                    ( { model | networkAddLoading = True }
                    , E.addFreqToNetwork (AddFreqToNetworkDone freq)
                        { networkId = network.id
                        , freq = freq
                        }
                    )

                _ ->
                    ( model, E.none )

        AddFreqToNetworkDone _ (Err e) ->
            Api.handleHttpError ToastMsg e { model | networkAddLoading = False }

        AddFreqToNetworkDone freq (Ok network) ->
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

        RemoveFreqFromExistingNetwork freq network ->
            ( { model | networkAddLoading = True }
            , E.removeFreqFromNetwork (RemoveFreqFromNetworkDone freq)
                { networkId = network.id
                , freq = freq
                }
            )

        RemoveFreqFromNetworkDone _ (Err e) ->
            Api.handleHttpError ToastMsg e { model | networkAddLoading = False }

        RemoveFreqFromNetworkDone freq (Ok network) ->
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

        UpdateNetwork ->
            case model.networkAddStatus of
                EditExistingNetwork freq state ->
                    ( model, E.updateNetwork (UpdateNetworkDone freq) state )

                _ ->
                    ( model, E.none )

        UpdateNetworkDone _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        UpdateNetworkDone freq (Ok network) ->
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

                editModulationSelect =
                    model.editModulationSelect

                ams =
                    { addModulationSelect
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
              }
            , E.none
            )

        FreqGroupsActivityReturnedByApi (Ok r) ->
            ( { model | freqGroupsActivityForNetworkAdd = Success r }, E.none )

        FreqGroupsActivityReturnedByApi (Err err) ->
            Api.handleHttpError ToastMsg err { model | freqGroupsActivityForNetworkAdd = Failure err }


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
    Ports.rer_freqs_closeMapRes CloseMap


mainContent : Shared.Model -> Model -> B.User -> Html Msg
mainContent shared model user =
    let
        freqsHeader =
            span []
                [ text "Частота"
                , i
                    [ class
                        (if model.sortingOrder == B.MessageCountDesc then
                            "bi bi-sort-numeric-down-alt"

                         else
                            "bi bi-sort-numeric-up-alt"
                        )
                    , style "cursor" "pointer"
                    , style "font-size" "16px"
                    , onClick SortByMessageNumber
                    ]
                    []
                ]

        loadMoreBtn =
            div [ class "d-flex justify-content-center align-items-center mb-4" ]
                [ button
                    [ class "btn btn-outline-secondary btn-sm"
                    , onClick LoadMoreFreqs
                    ]
                    [ if model.loading then
                        Le.Block.Spinner.loadingSpinner2Sm

                      else
                        i [ class "bi bi-arrow-down-circle me-2" ] []
                    , text "завантажити ще"
                    ]
                ]
    in
    section []
        [ table
            [ class "table table-bordered table-sm"
            , style "font-size" ".85rem"
            ]
            [ thead []
                [ tr []
                    [ th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "120px"
                        ]
                        [ freqsHeader ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "190px"
                        ]
                        [ text "Позивні" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "190px"
                        ]
                        [ text "Пеленги" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "min-width" "400px"
                        ]
                        [ text "Привʼязки" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "min-width" "200px"
                        ]
                        [ text "Альтернативні Привʼязки" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "200px"
                        ]
                        [ text "Активність р/м" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "150px"
                        ]
                        [ text "Останнє оновлення" ]
                    ]
                ]
            , tbody [] <|
                List.indexedMap (renderFreqTr shared model user) model.freqs
            , HtmlX.viewIf (not model.noMoreToLoad) <|
                tfoot []
                    [ td [ colspan 7, style "border-bottom" "none" ] [ loadMoreBtn ]
                    ]
            ]
        ]


viewFreqBlock : Maybe B.User -> Model -> B.Freq -> List (Html Msg)
viewFreqBlock mUser model freq =
    let
        editBlock =
            case mUser of
                Just user ->
                    if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                        div []
                            [ div [ style "font-size" ".8rem" ]
                                [ button
                                    [ class "btn btn-outline-primary btn-sm me-2 ms-2 py-0 px-1"
                                    , type_ "button"
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
                        case Dict.get networkId model.networks of
                            Just network ->
                                NetworksUtils.renderNetwork network model.masterUnits

                            _ ->
                                text "Невідома мережа"
            ]
        , editBlock
        ]
    ]


renderFreqTr : Shared.Model -> Model -> B.User -> Int -> B.Freq -> Html Msg
renderFreqTr shared model user rowIndex freq =
    let
        analysisHref withMap =
            let
                dateFromStr =
                    case ( model.zone, model.now ) of
                        ( Just zone, Just time ) ->
                            Le.Time.renderDateF4 zone (Le.Time.xDaysAgo 15 time)

                        _ ->
                            ""

                stateS =
                    Encode.encode 0
                        (B.rerAnalysisQueryStateEncoder
                            { dateFromStr = dateFromStr
                            , timeFromStr = ""
                            , dateToStr = ""
                            , timeToStr = ""
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
                            }
                        )

                query =
                    if withMap then
                        [ Url.Builder.string "state" stateS, Url.Builder.string "showMap" "true" ]

                    else
                        [ Url.Builder.string "state" stateS ]
            in
            Url.Builder.relative [ "rer-analysis" ] query

        actionMenuBody =
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

        mMap =
            model.locationTexts |> Dict.get freq.freq

        createTextElement textLocation clickable =
            let
                styles =
                    if clickable then
                        [ style "cursor" "pointer", style "text-decoration" "underline" ]

                    else
                        []

                events =
                    if clickable then
                        [ onClick <| SwitchFromTextToMap freq.freq ]

                    else
                        []
            in
            p
                (styles ++ events)
                [ text textLocation ]

        alternativeUnits =
            model.altUnitsByFreq |> Dict.get freq.freq

        groupsMessageCountByDayJson =
            model.groupsMessageCountByDay |> Dict.get freq.freq |> Maybe.map (Encode.dict identity (Encode.dict identity Encode.int))

        locations =
            if List.isEmpty freq.locations then
                "Текстова локація"

            else
                String.join ", " freq.locations
    in
    tr []
        [ td [ class "flex relative", style "gap" "2px", style "align-items" "baseline" ]
            [ span [] [ text freq.freq ]
            , div [ class "flex-grow-1" ]
                [ span
                    [ class "badge badge-sm rounded-pill text-bg-secondary"
                    , style "font-size" "0.6rem"
                    ]
                    [ text <| String.fromInt freq.messageCount
                    ]
                ]
            , Le.Block.ActionMenu.actionMenu actionMenuBody "bi-three-dots-vertical"
            , Watermark.new user.name
                |> Watermark.withPositioning ( 30, 10 )
                |> Watermark.withFontSize "1.5rem"
                |> Watermark.view
                |> HtmlX.viewIf (Basics.remainderBy 2 rowIndex == 0)
            ]
        , let
            callsigns =
                case Dict.get freq.freq model.callsignsByFreq of
                    Nothing ->
                        []

                    Just v ->
                        v

            isOpen =
                case model.showAllCallsignsForFreq of
                    Just showAllCallsignsForFreq ->
                        showAllCallsignsForFreq == freq.freq

                    Nothing ->
                        False
          in
          CallsignsPopup.view
            { isOpened = isOpen
            , onClose = SetFreqToShowAllCallsignsPopup Nothing
            , onOpen = SetFreqToShowAllCallsignsPopup (Just freq.freq)
            , callsigns = callsigns
            , callsignsInfo = model.callsignsInfo
            , masterUnits = model.masterUnits
            }
            (FreqsPage
                freq.freq
                model.networks
            )
        , td []
            [ div []
                [ case ( mMap, model.openMapRowId == Just freq.freq ) of
                    ( Just LocationText, True ) ->
                        div [ id ("map-container-" ++ freq.freq) ]
                            []

                    ( Just LocationText, False ) ->
                        createTextElement locations True

                    ( Just NoCoords, _ ) ->
                        createTextElement "Немає координат" False

                    ( Nothing, _ ) ->
                        p
                            [ style "cursor" "pointer"
                            , style "text-decoration" "underline"
                            , onClick <| SwitchFromTextToMap freq.freq
                            ]
                            [ text locations ]
                ]
            ]
        , td [] <|
            viewFreqBlock shared.user model freq
        , td []
            [ div []
                (case alternativeUnits of
                    Just units ->
                        List.map (\u -> span [ style "display" "block" ] [ text u.unit ]) units

                    Nothing ->
                        [ text "" ]
                )
            ]
        , td []
            [ case groupsMessageCountByDayJson of
                Just g ->
                    div [ style "width" "200px", style "height" "90px" ]
                        [ Html.node "bar-chart"
                            [ Attr.property "data" <| g
                            , Attr.property "lastDay" <| Encode.string model.to.dateStr
                            ]
                            []
                        ]

                Nothing ->
                    text "Не активні останні 10 днів"
            ]
        , td []
            (case ( freq.lastUpdatedAt, model.zone ) of
                ( Just updatedAt, Just zone ) ->
                    let
                        updatedAtString =
                            Le.Time.renderDateF6 zone
                                (Time.millisToPosix updatedAt)

                        updatedByString =
                            Maybe.withDefault "невідомий" freq.lastUpdatedBy

                        createdAtString =
                            case freq.createdAt of
                                Just createdAt ->
                                    Le.Time.renderDateF6 zone
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
            )
        ]


contentBlock : Shared.Model -> Model -> B.User -> Html Msg
contentBlock shared model user =
    let
        editNetworkSidebarForm : B.UpdateNetworkReq -> List (Html Msg)
        editNetworkSidebarForm editState =
            [ h3 [] [ text "Редагування існуючої мережі" ]
            , div [ class "grid grid-cols-4  gap-y-2 gap-x-4" ]
                [ div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Назва:*" ]
                    , input
                        [ class "form-control "
                        , type_ "text"
                        , value editState.name
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | name = v }
                        ]
                        []
                    ]
                , div [ class "flex flex-col gap-1 col-span-1" ]
                    [ label [] [ text "Тип" ]
                    , let
                        selectedItem =
                            (\item ->
                                Select.basicMenuItem
                                    { item = item
                                    , label =
                                        NetworksUtils.networkKindToLabel item
                                    }
                            )
                                model.editKindSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions shared.isDarkMode

                        do2 =
                            { defaultOptions | clearable = False }
                      in
                      Html.map EditNetworkKindSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                (Just selectedItem)
                                model.editKindSelect.state
                                model.editKindSelect.items
                                "жоден"
                                do2
                    ]
                , div [ class "col-span-1" ]
                    [ label [ class "mb-1" ] [ text "Вид передачі" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\item ->
                                    Select.basicMenuItem
                                        { item = item
                                        , label =
                                            RD.withDefault [] model.modulations
                                                |> List.filter (\mod -> mod.id == item)
                                                |> List.head
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editModulationSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions shared.isDarkMode

                        do2 =
                            { defaultOptions | clearable = False }
                      in
                      Html.map EditNetworkModulationSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.editModulationSelect.state
                                model.editModulationSelect.items
                                "жоден"
                                do2
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Локація" ]
                    , input
                        [ class "form-control"
                        , type_ "text"
                        , value <| editState.location
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | location = v }
                        ]
                        []
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Коментар" ]
                    , input
                        [ class "form-control"
                        , value <| editState.comment
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | comment = v }
                        ]
                        []
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Радіостанція" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" editState.radioStation)
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | radioStation = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "типи радіостанцій, що використовуються підрозділом" ]
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Підтвердження" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" editState.confirmation)
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | confirmation = Just v }
                        ]
                        []
                    , span [ class "text-sm  mt-1 text-[var(--neutral-600)]" ] [ text "р/о, сленг, сигнали управління або інші підтвердження приналежності р/м до підрозділу" ]
                    ]
                , div [ class " col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Призначення" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" editState.purpose)
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | purpose = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
                    ]
                , div [ class " col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Режим роботи" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" editState.operationType)
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | operationType = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
                    ]
                , div [ class " col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Період функціонування" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" editState.operationMode)
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | operationMode = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
                    ]
                , div [ class "col-span-4" ]
                    [ label [ class "mb-1" ] [ text "Ознаки" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" editState.signs)
                        , onInput <|
                            \v ->
                                EditNetworkMsg
                                    { editState | signs = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "розвід. ознаки підрозділу: сленг, сигнали управління, р/с, кодування місцевості, тощо" ]
                    ]
                , div [ class "flex gap-2 justify-end col-span-4 mb-2" ]
                    [ Button.new { label = "Відмінити", onClick = CloseAddNetworkSidebar } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Зберегти", onClick = UpdateNetwork } |> Button.view
                    ]
                ]
            ]

        createNetworkSidebarForm : B.CreateNetworkReq -> List (Html Msg)
        createNetworkSidebarForm addState =
            [ h3 [] [ text "Створення нової мережі" ]
            , div [ class "grid grid-cols-4  gap-y-2 gap-x-4" ]
                [ div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Назва:*" ]
                    , input
                        [ class "form-control "
                        , type_ "text"
                        , value addState.name
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | name = v }
                        ]
                        []
                    ]
                , div [ class "flex flex-col gap-1 col-span-1" ]
                    [ label [] [ text "Тип" ]
                    , let
                        selectedItem =
                            (\item ->
                                Select.basicMenuItem
                                    { item = item
                                    , label = NetworksUtils.networkKindToLabel item
                                    }
                            )
                                model.addKindSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions shared.isDarkMode

                        do2 =
                            { defaultOptions | clearable = False }
                      in
                      Html.map AddNetworkKindSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                (Just selectedItem)
                                model.addKindSelect.state
                                model.addKindSelect.items
                                "жоден"
                                do2
                    ]
                , div [ class "col-span-1" ]
                    [ label [ class "mb-1" ] [ text "Вид передачі" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\item ->
                                    Select.basicMenuItem
                                        { item = item
                                        , label =
                                            RD.withDefault [] model.modulations
                                                |> List.filter (\mod -> mod.id == item)
                                                |> List.head
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.addModulationSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions shared.isDarkMode

                        do2 =
                            { defaultOptions | clearable = False }
                      in
                      Html.map AddNetworkModulationSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.addModulationSelect.state
                                model.addModulationSelect.items
                                "жоден"
                                do2
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Локація" ]
                    , input
                        [ class "form-control"
                        , type_ "text"
                        , value <| addState.location
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | location = v }
                        ]
                        []
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Коментар" ]
                    , input
                        [ class "form-control"
                        , value <| addState.comment
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | comment = v }
                        ]
                        []
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Радіостанція" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" addState.radioStation)
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | radioStation = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "типи радіостанцій, що використовуються підрозділом" ]
                    ]
                , div [ class "col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Підтвердження" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" addState.confirmation)
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | confirmation = Just v }
                        ]
                        []
                    , span [ class "text-sm  mt-1 text-[var(--neutral-600)]" ] [ text "р/о, сленг, сигнали управління або інші підтвердження приналежності р/м до підрозділу" ]
                    ]
                , div [ class " col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Призначення" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" addState.purpose)
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | purpose = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
                    ]
                , div [ class " col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Режим роботи" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" addState.operationType)
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | operationType = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
                    ]
                , div [ class " col-span-2" ]
                    [ label [ class "mb-1" ] [ text "Період функціонування" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" addState.operationMode)
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | operationMode = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
                    ]
                , div [ class "col-span-4" ]
                    [ label [ class "mb-1" ] [ text "Ознаки" ]
                    , input
                        [ class "form-control"
                        , value (Maybe.withDefault "" addState.signs)
                        , onInput <|
                            \v ->
                                AddNetworkMsg
                                    { addState | signs = Just v }
                        ]
                        []
                    , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "розвід. ознаки підрозділу: сленг, сигнали управління, р/с, кодування місцевості, тощо" ]
                    ]
                , section [ class "col-span-4 h-[200px]" ]
                    [ h4 []
                        [ text "Активність мережі" ]
                    , div [ class "flex gap-[16px] h-full" ]
                        [ div
                            []
                            [ label [ class "mb-1" ] [ text "Активна з" ]
                            , input
                                [ type_ "date"
                                , class "form-control w-[150px]!"
                                , required True
                                , Maybe.map (\activeFrom -> Time.millisToPosix activeFrom) addState.activeFrom
                                    |> (\mActiveFrom ->
                                            case mActiveFrom of
                                                Just activeFrom ->
                                                    Le.Time.renderDateF4 shared.timeZone activeFrom

                                                Nothing ->
                                                    ""
                                       )
                                    |> value
                                , onInput <|
                                    AddNetworkMsg
                                        << (\v ->
                                                { addState
                                                    | activeFrom =
                                                        case Le.Time.parseDateParts v of
                                                            Err _ ->
                                                                addState.activeFrom

                                                            Ok parts ->
                                                                Time.Extra.partsToPosix shared.timeZone parts
                                                                    |> Time.posixToMillis
                                                                    |> Just
                                                }
                                           )
                                ]
                                []
                            ]
                        , let
                            groupsMessageCountByDayJson =
                                B.freqDailyActivityCountEncoder (RD.withDefault { dataPerDate = Dict.empty } model.freqGroupsActivityForNetworkAdd)
                          in
                          div []
                            [ span [] [ text "Активність частоти за місяць" ]
                            , Html.node "bar-chart-2"
                                [ Attr.property "data" <| groupsMessageCountByDayJson
                                , class "w-[300px]"
                                ]
                                []
                            ]
                        ]
                    ]
                , div [ class "flex gap-2 justify-end col-span-4 my-2" ]
                    [ Button.new { label = "Відмінити", onClick = CloseAddNetworkSidebar } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Зберегти", onClick = CreateNetwork } |> Button.view
                    ]
                ]
            ]

        createNetworkSidebarStart : String -> Maybe Int -> List (Html Msg)
        createNetworkSidebarStart freq mSelectedNetworkId =
            [ div [ class "flex flex-col grow relative" ]
                [ HtmlX.viewIf model.networkAddLoading <|
                    span [ class "absolute top-[50%] left-[50%] -translate-1/2" ] [ Le.Block.Spinner.loadingSpinner ]
                , let
                    networksWithThisFreq =
                        ListX.find (\freq_ -> freq_.freq == freq) model.freqs
                            |> (\mFreq ->
                                    case mFreq of
                                        Just freq_ ->
                                            Just freq_.networkIds

                                        Nothing ->
                                            Nothing
                               )
                            |> (\mNetworkIds ->
                                    case mNetworkIds of
                                        Just ids_ ->
                                            List.filterMap (\id_ -> Dict.get id_ model.networks) ids_

                                        Nothing ->
                                            []
                               )

                    networksWithThisFreqBlock =
                        networksWithThisFreq
                            |> List.map
                                (\network_ ->
                                    div
                                        [ class "w-full p-2  border-1 border-border rounded-sm text-text flex justify-between"
                                        ]
                                        [ NetworksUtils.renderNetwork network_ model.masterUnits
                                        , div [ class "flex gap-2" ]
                                            [ i [ class "bi bi-pencil cursor-pointer", onClick <| StartEditingExistingNetwork network_ ] []
                                            , i [ class "bi bi-trash cursor-pointer", onClick <| RemoveFreqFromExistingNetwork freq network_ ] []
                                            ]
                                        ]
                                )
                  in
                  HtmlX.viewIf (List.length networksWithThisFreq > 0) <|
                    div [ class "mb-2" ]
                        [ span [] [ text "Уже прив'язані до цієї частоти:" ]
                        , div [] networksWithThisFreqBlock
                        ]
                , div [ class "min-h-[200px] flex flex-col" ]
                    [ let
                        selectItem =
                            model.networkDialogUnitSelect.selected
                                |> Maybe.map
                                    (\unitId ->
                                        Select.basicMenuItem
                                            { item = unitId
                                            , label = Unit.unitName model.masterUnits unitId
                                            }
                                    )
                      in
                      div [ class "" ]
                        [ label [] [ text "Пошук існуючих по підрозділу:" ]
                        , Html.map AddNetworkUnitSelMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectSingle
                                    selectItem
                                    model.networkDialogUnitSelect.state
                                    model.networkDialogUnitSelect.items
                                    "жоден"
                                    (Le.Block.Select.defaultOptions shared.isDarkMode)
                        ]
                    , div [ class "grow-1 mt-4" ]
                        (let
                            mSelUnit =
                                model.networkDialogUnitSelect.selected
                                    |> Maybe.andThen (\unitId -> Dict.get unitId model.masterUnits)

                            sameRegimentUnits =
                                case mSelUnit of
                                    Just unit ->
                                        List.filter (\( id_, unit_ ) -> Unit.sameRegiment unit unit_) (Dict.toList model.masterUnits)

                                    Nothing ->
                                        []

                            sameRegimentUnitIds =
                                sameRegimentUnits |> List.map Tuple.first

                            d =
                                Dict.toList model.networks
                                    |> List.map Tuple.second
                                    |> List.filter (\network -> List.any (\unitId -> List.member unitId sameRegimentUnitIds) network.unitIds)
                         in
                         if List.length d > 0 then
                            [ span [ class "text-[var(--neutral-600)]" ] [ text <| String.fromInt (List.length d) ++ " співпадінь знайдено" ] ]
                                ++ List.map
                                    (\network ->
                                        let
                                            isActive =
                                                case mSelectedNetworkId of
                                                    Just id ->
                                                        id == network.id

                                                    Nothing ->
                                                        False
                                        in
                                        div
                                            [ class "w-full p-2  border-1 border-border rounded-sm text-text  pointer "
                                            , classList
                                                [ ( "bg-tag-selected border-1 border-border-selected", isActive )
                                                , ( "hover-unmuted bg-tag", not isActive )
                                                ]
                                            , onClick <| NetworkAddSelectExistingId network.id
                                            ]
                                            [ NetworksUtils.renderNetwork network model.masterUnits
                                            ]
                                    )
                                    d

                         else
                            [ div [ class "w-full h-full flex justify-center items-center" ]
                                [ span [] [ text "Співпадінь не виявлено" ]
                                ]
                            ]
                        )
                    , div [ class "flex justify-end mb-2" ]
                        [ case mSelectedNetworkId of
                            Just id ->
                                button [ class "btn btn-primary", onClick <| AddFreqToExistingNetwork freq id, disabled <| model.networkDialogUnitSelect.selected == Nothing ] [ text "Використати цю мережу" ]

                            Nothing ->
                                text ""
                        ]
                    ]
                , div [ class "flex gap-2 justify-end border-t-1 pt-2 border-[var(--neutral-400)]" ]
                    [ Button.new { label = "Назад", onClick = CloseAddNetworkSidebar } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Створити нову мережу", onClick = StartCreatingNewNetwork }
                        |> Button.withDisabled (model.networkDialogUnitSelect.selected == Nothing)
                        |> Button.view
                    ]
                ]
            ]

        createNetworkSidebarContent : List (Html Msg)
        createNetworkSidebarContent =
            [ div [ class "p-4 w-full flex flex-col" ]
                ([ h2 [] [ text "Прив'язка мережі до частоти" ]
                 ]
                    ++ (case model.networkAddStatus of
                            CreateNewNetwork freq addState ->
                                createNetworkSidebarForm addState

                            SelectFromExistingNetwork freq mSelectedNetworkId ->
                                createNetworkSidebarStart freq mSelectedNetworkId

                            EditExistingNetwork freq editState ->
                                editNetworkSidebarForm editState

                            NotStarted ->
                                []
                       )
                )
            ]

        sidebarContent =
            case model.networkAddStatus of
                NotStarted ->
                    []

                _ ->
                    createNetworkSidebarContent

        networkAddSidebarOpen =
            case model.networkAddStatus of
                NotStarted ->
                    False

                _ ->
                    True
    in
    div []
        [ Sidebar.view networkAddSidebarOpen CloseAddNetworkSidebar sidebarContent
        , div
            [ class "border mb-4 p-2"
            ]
            [ filterPanel shared model
            ]
        , mainContent shared model user
        ]


leftPanel : Shared.Model -> Model -> Html Msg
leftPanel shared model =
    div
        [ class "align-self-stretch"
        , style "width" "220px"
        , style "min-width" "220px"
        , style "height" "calc(-50px + 100vh)"
        , style "overflow-y" "scroll"
        ]
        [ div
            [ class "filter-col d-flex flex-column pt-1 left-panel"
            , style "height" "100%"
            ]
            [ unitStatsBlock shared model
            , div [ class "flex-grow-1" ] []
            ]
        ]


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


unitStatsBlock : Shared.Model -> Model -> Html Msg
unitStatsBlock _ model =
    let
        filterState =
            model.filterState

        renderUnitStat : B.FreqUnitStatRow -> List (Html Msg)
        renderUnitStat stat =
            [ div
                [ class "d-flex justify-content-between align-items-between p-2 pointer"
                , onClick <| FilterStateMsg { filterState | unit = Unit.unitName model.masterUnits stat.unitId }
                ]
                [ div [ class "flex-grow-1 text-end me-2" ] [ text <| Unit.unitName model.masterUnits stat.unitId ]
                , div [ class "me-2" ]
                    [ div
                        [ style "min-width" "30px"
                        , class "text-center"
                        ]
                        [ span
                            [ class "badge badge-sm rounded-pill text-bg-secondary"
                            , style "font-size" "0.6rem"
                            ]
                            [ text <| String.fromInt stat.count
                            ]
                        ]
                    ]
                ]
            , div [ class "border-bottom" ] []
            ]
    in
    if model.loadingUnitStats then
        Le.Block.Spinner.loadingSpinner

    else
        div [ style "font-size" ".8rem" ] <|
            List.concatMap renderUnitStat model.unitStats


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "частоти"
    , body =
        [ Le.Block.Toast.view ToastMsg model.toasts <|
            div [ class "d-flex justify-content-start align-items-start page-rer-freqs" ]
                [ leftPanel shared model
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
                    , div [] <|
                        [ div []
                            [ div [ class "mx-2" ]
                                [ contentBlock shared model user ]
                            ]
                        ]
                    ]
                ]
        ]
    }


filterPanel : Shared.Model -> Model -> Html Msg
filterPanel shared model =
    let
        filterState =
            model.filterState

        tabFiltersCallsigns =
            let
                items =
                    List.map
                        (\callsign ->
                            Select.basicMenuItem
                                { item = callsign
                                , label = callsign
                                }
                        )
                        filterState.callsigns
            in
            div
                [ style "font-size" ".8rem"
                , style "min-width" "330px"
                ]
                [ Html.map SelCallsignMsg
                    (Styled.toUnstyled <|
                        Le.Block.Select.renderSelectVirtual
                            items
                            model.selCallsignState
                            model.selCallsignMenu
                            "всі"
                            { loading = RD.isLoading model.callsignsForFilter, disabled = False, isDark = shared.isDarkMode }
                    )
                ]
    in
    div
        [ class "flex justify-start items-center"
        ]
        [ div [ class "me-2" ]
            [ if model.loading then
                Le.Block.Spinner.loadingSpinner2Sm

              else
                i [ class "bi bi-filter" ] []
            ]
        , input
            [ class "form-control me-2"
            , style "width" "200px"
            , type_ "text"
            , placeholder "частота"
            , value model.filterState.freq
            , onInput <| \v -> FilterStateMsg { filterState | freq = v }
            ]
            []
        , input
            [ class "form-control me-2"
            , style "width" "200px"
            , type_ "text"
            , placeholder "підрозділ"
            , value model.filterState.unit
            , onInput <| \v -> FilterStateMsg { filterState | unit = v }
            ]
            []
        , span [ class "me-2" ] [ text "позивні" ]
        , tabFiltersCallsigns
        , span [ class "grow-1" ] []
        , Button.new { label = "Звіт \"Еталонка\"", onClick = OpenReportModal } |> Button.view
        , let
            dialogContent =
                [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                    [ div [ class "pb-12" ]
                        [ h2 [] [ text "Звіт \"еталонка\"" ]
                        , p [] [ text "Еталонка по фільтру дата/частота/підрозділ" ]
                        , div
                            [ class "form-check mb-2" ]
                            [ input
                                [ class "form-check-input"
                                , type_ "checkbox"
                                , id "include-adjacent-freqs"
                                , onCheck <| ChangeReportStatus
                                , checked (model.reportStatus == ReportWithAdjacentFreqs B.ShortRange || model.reportStatus == ReportWithAdjacentFreqs B.LongRange)
                                ]
                                []
                            , label
                                [ class "form-check-label"
                                , for "include-adjacent-freqs"
                                ]
                                [ text "Включати суміжні частоти" ]
                            ]
                        , div
                            [ style "width" "100%"
                            , style "font-size" ".8rem"
                            ]
                            [ let
                                selItem =
                                    Just
                                        (Select.basicMenuItem
                                            { item = model.adjacentFreqsRangeSelect.selected
                                            , label = adjacentRangeToLabel model.adjacentFreqsRangeSelect.selected
                                            }
                                        )

                                options =
                                    Le.Block.Select.defaultOptions shared.isDarkMode

                                options2 =
                                    { options | clearable = False, disabled = model.reportStatus == ReportBasic }
                              in
                              Html.map SelectReportAdjacentFreqsRange
                                (Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selItem
                                        model.adjacentFreqsRangeSelect.state
                                        model.adjacentFreqsRangeSelect.items
                                        "не обрано"
                                        options2
                                )
                            ]
                        ]
                    , div [ class "flex justify-between" ]
                        [ Button.new { label = "Назад", onClick = CloseReportModal } |> Button.withStyleSecondary |> Button.view
                        , Button.new { label = "Згенерувати", onClick = ReportEtalonkaDownload False }
                            |> (if model.reportDownloadInProgress then
                                    Button.withIcon
                                        [ Le.Block.Spinner.loadingSpinner2Sm
                                        ]

                                else
                                    identity
                               )
                            |> Button.view
                        ]
                    ]
                ]
          in
          ModalDialog.modalDialog model.reportModalOpen CloseReportModal [] dialogContent
        ]


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
