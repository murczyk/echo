module Pages.RerNetworks exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Auth
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp)
import Core.UnitHierarchy
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Http
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Pages_.RerFreqs.Model exposing (FurtherInvestigationFilter(..))
import Pages_.RerNetworks.ReportConfig as ReportConfig exposing (ReportTypeOption(..))
import Pages_.RerNetworks.ReportModal as ReportModal
import Pages_.RerNetworks.ReportUpdate as ReportUpdate
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Shared.CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DateTime
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Model exposing (isDarkMode)
import Task
import Time exposing (Posix)
import Utils.Api.ErrorHandling
import Utils.NetworksUtils as EUtils
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)
import View exposing (View)


type NetworksMergeStatus
    = NotCalculatedSuggestionsYet
    | CalculatedSuggestions (List ( B.Network, B.Network ))
    | Merging ( B.Network, B.Network ) B.Network (List ( B.Network, B.Network ))


type alias Model =
    { now : Maybe Time.Posix
    , from : Shared.Components.DateTime.Model
    , to : Shared.Components.DateTime.Model
    , networksGroupsActivity : RemoteData ApiError GroupsActivityPerDayRsp
    , networks : RemoteData ApiError (List B.Network)
    , currentRequestTracker : Maybe String
    , requestCounter : Int
    , networksMergeStatus : NetworksMergeStatus
    , networksMergeInProgress : Bool
    , callsignsOpenedPopupId : Maybe Int
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , callsigns : List String
    , map : MapState
    , filterState : FilterState
    , filterStateDebounce : Debounce FilterState
    , unitStats : RemoteData ApiError (List B.FreqUnitStatRow)
    , reportModalOpened : Bool
    , reportDownloadInProgress : Bool
    , goiReportDownloadInProgress : Bool
    , report : ReportConfig.ReportType
    , reportFromDate : Shared.Components.DateTime.Model
    , reportToDate : Shared.Components.DateTime.Model
    , showSidebar : Bool
    , expandedArmies : Set.Set String
    , expandedDivisions : Set.Set String
    , expandedRegiments : Set.Set String
    , expandedBattalions : Set.Set String
    , showOnlyInvestigating : Bool
    , showOnlyActive : Bool
    , showArchived : Bool
    , loadingUnitStats : Bool
    , tableState : Table.State
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    , aorFilterSelect : Utils.Select.SelectType Int
    , aorFilterFocusedBefore : Maybe (List Int)
    }


type MapState
    = Closed
    | Opened Int (List B.NetworkPoint)


type alias FilterState =
    { freq : String
    , unit : String
    , callsigns : List String
    , showArchived : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    let
        m2 : Model
        m2 =
            { now = Nothing
            , from = Shared.Components.DateTime.init ()
            , to = Shared.Components.DateTime.init ()
            , networks = NotAsked
            , currentRequestTracker = Nothing
            , requestCounter = 0
            , networksMergeStatus = NotCalculatedSuggestionsYet
            , networksMergeInProgress = False
            , networksGroupsActivity = NotAsked
            , callsignsOpenedPopupId = Nothing
            , callsignsInfo = Dict.empty
            , callsigns = []
            , map = Closed
            , filterState =
                { freq = ""
                , unit = ""
                , callsigns = []
                , showArchived = False
                }
            , filterStateDebounce = Debounce.init
            , unitStats = Loading
            , reportModalOpened = False
            , reportDownloadInProgress = False
            , goiReportDownloadInProgress = False
            , report = ReportConfig.AccordingToForm ReportConfig.defaultCommonSettings
            , reportFromDate = Shared.Components.DateTime.init ()
            , reportToDate = Shared.Components.DateTime.init ()
            , showSidebar = False
            , expandedArmies = Set.empty
            , expandedDivisions = Set.empty
            , expandedRegiments = Set.empty
            , expandedBattalions = Set.empty
            , showOnlyInvestigating = False
            , showOnlyActive = False
            , showArchived = False
            , loadingUnitStats = True
            , tableState = Table.initialSort "Мережа"
            , aorList = NotAsked
            , aorFilterSelect =
                { state = Select.initState (Select.selectIdentifier "aor-filter-select")
                , items = []
                , selected = []
                }
            , aorFilterFocusedBefore = Nothing
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <|
            Task.perform GotTime Time.now
        , E.getUnitStatsForNetworks UnitStatsReturnedByApi
        , E.sendCmd (Api.aor_list AorListReturnedByApi { sortBy = Nothing })
        ]
    )


filterStateDebounceConfig : Debounce.Config Msg
filterStateDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterStateDebounceMsg
    }


loadNetworks : Model -> ( Model, Effect Msg )
loadNetworks model =
    ( { model | networks = Loading }
    , E.getNetworksList NetworksReturnedByApi
        { filterFreq = emptySToNothing model.filterState.freq
        , filterUnit = emptySToNothing model.filterState.unit
        , sortBy = Nothing
        , showOnlyFurtherInverstigation =
            if model.showOnlyInvestigating then
                Just True

            else
                Nothing
        , showInactive = Just (not model.showOnlyActive)
        , showOnlyDeleted = Just model.showArchived
        , aorIds =
            if List.isEmpty model.aorFilterSelect.selected then
                Nothing

            else
                Just model.aorFilterSelect.selected
        , ids = Nothing
        , limit = Nothing
        }
    )


loadNetworksWithTracker : Model -> String -> Cmd Msg
loadNetworksWithTracker model tracker =
    Api.get_networks_list_with_tracker NetworksReturnedByApi
        tracker
        { filterFreq = emptySToNothing model.filterState.freq
        , filterUnit = emptySToNothing model.filterState.unit
        , sortBy = Nothing
        , showOnlyFurtherInverstigation =
            if model.showOnlyInvestigating then
                Just True

            else
                Nothing
        , showInactive = Just (not model.showOnlyActive)
        , showOnlyDeleted = Just model.showArchived
        , aorIds =
            if List.isEmpty model.aorFilterSelect.selected then
                Nothing

            else
                Just model.aorFilterSelect.selected
        , ids = Nothing
        , limit = Nothing
        }


type Msg
    = GotTime Posix
    | NetworksReturnedByApi (Result ApiError (List B.Network))
    | NetworksGroupsActivityReturnedByApi (Result ApiError GroupsActivityPerDayRsp)
    | NetworkPointsReturnedByApi Int (Result ApiError B.ListNetworkPointsRsp)
    | NetworksMergeStart
    | NetworksMergeFinish
    | NetworksMergeTryNext
    | NetworksMergeDoIt Int Int
    | NetworksMergedByApi Int (Result ApiError B.Network)
    | NetworksMergeSwapOrder
    | CallsignsPopupOpenedByUser Int
    | CallsignsPopupClosedByUser
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | MapOpenedByUser Int
    | MapClosedByUser
    | FilterStateMsg FilterState
    | FilterStateDebounceMsg Debounce.Msg
    | DateTimeFromMsg (Shared.Components.DateTime.Msg Msg)
    | DateTimeToMsg (Shared.Components.DateTime.Msg Msg)
    | UnitStatsReturnedByApi (Result ApiError B.NetworkUnitStatsRsp)
    | ReportModalOpenedByUser
    | ReportModalClosedByUser
    | ReportDownloadClickedByUser
    | ReportDownloadReturnedByApi (Result ApiError Bytes)
    | GoiReportDownloadClickedByUser
    | GoiReportDownloadReturnedByApi (Result ApiError Bytes)
    | ReportTypeChanged ReportConfig.ReportTypeOption
    | ReportActiveFreqsOnlyChanged Bool
    | ReportIncludeSigintSignsChanged Bool
    | ReportIncludeConfirmationChanged Bool
    | ReportIncludeUnitCallsignsChanged Bool
    | ReportIncludePelengsMapChanged Bool
    | ReportDateTimeFromMsg (Shared.Components.DateTime.Msg Msg)
    | ReportDateTimeToMsg (Shared.Components.DateTime.Msg Msg)
    | ToggleShowOnlyInvestigating Bool
    | ToggleArmyExpanded String
    | ToggleDivisionExpanded String String
    | ToggleRegimentExpanded String String String
    | ToggleBattalionExpanded String String String String
    | FilterUnitMsg String
    | ToggleSidebar
    | ClearAllFilters
    | CreateNewNetworkClicked
    | SetTableState Table.State
    | ToggleShowOnlyActive Bool
    | ToggleShowArchived Bool
    | AorListReturnedByApi (Result ApiError (List B.AreaOfResponsibility))
    | AorFilterSelMsg (Select.Msg Int)


generatePreview : ( B.Network, B.Network ) -> B.Network
generatePreview x =
    let
        ( networkTo, networkFrom ) =
            x

        concatUniqueMaybe : Maybe String -> Maybe String -> Maybe String
        concatUniqueMaybe to from =
            case ( to, from ) of
                ( Just toVal, Just fromVal ) ->
                    let
                        parts =
                            String.split "|" toVal
                    in
                    if List.member fromVal parts then
                        Just toVal
                        -- Already present, return as is

                    else
                        Just (toVal ++ "|" ++ fromVal)

                -- Append uniquely
                ( Just toVal, Nothing ) ->
                    Just toVal

                ( Nothing, Just fromVal ) ->
                    Just fromVal

                ( Nothing, Nothing ) ->
                    Nothing

        concatUnique : String -> String -> String
        concatUnique to from =
            if String.isEmpty to then
                from

            else if String.isEmpty from then
                to

            else
                let
                    parts =
                        String.split "|" to
                in
                if List.member from parts then
                    to
                    -- Already present, return as is

                else
                    to ++ "|" ++ from

        -- Append uniquely
    in
    { networkTo
        | location = concatUnique networkTo.location networkFrom.location

        --, confirmation = concatUniqueMaybe networkTo.confirmation networkFrom.confirmation
        , radioStation = concatUniqueMaybe networkTo.radioStation networkFrom.radioStation
        , freqs =
            networkTo.freqs
                ++ networkFrom.freqs
                |> List.foldl
                    (\curr acc ->
                        if List.member curr acc then
                            acc

                        else
                            acc ++ [ curr ]
                    )
                    []
    }


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        GotTime now_ ->
            let
                from =
                    Shared.Components.DateTime.initFromPosix { datePosix = Utils.Time.xDaysAgo 7 now_, zone = shared.timeZone }

                to =
                    Shared.Components.DateTime.initFromPosix { datePosix = now_, zone = shared.timeZone }

                -- Ініціалізуємо дати звіту тими ж значеннями
                reportFromDate =
                    Shared.Components.DateTime.initFromPosix { datePosix = Utils.Time.xDaysAgo 7 now_, zone = shared.timeZone }

                reportToDate =
                    Shared.Components.DateTime.initFromPosix { datePosix = now_, zone = shared.timeZone }

                m2 =
                    { model
                        | from = from
                        , to = to
                        , now = Just now_
                        , reportFromDate = reportFromDate
                        , reportToDate = reportToDate
                    }
            in
            loadNetworks m2

        NetworksReturnedByApi (Err err) ->
            ( { model | networks = Failure err, currentRequestTracker = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж" err
            )

        NetworksReturnedByApi (Ok networks) ->
            ( { model
                | networks =
                    Success networks
                , currentRequestTracker = Nothing
                , networksMergeStatus = CalculatedSuggestions (findSuggestedToMergeNetworks networks)
              }
            , case ( model.from.datePosix, model.to.datePosix ) of
                ( Just _, Just dtToPosix ) ->
                    E.batch
                        [ E.getNetworksGroupsActivity NetworksGroupsActivityReturnedByApi
                            { networkIds = networks |> List.map .id
                            , tillDateNoninclusiveMs = Just <| Time.posixToMillis dtToPosix
                            }
                        ]

                _ ->
                    E.none
            )

        NetworksGroupsActivityReturnedByApi (Err err) ->
            ( { model | networksGroupsActivity = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності мереж" err
            )

        NetworksGroupsActivityReturnedByApi (Ok res) ->
            ( { model | networksGroupsActivity = Success res }, E.none )

        CallsignsPopupOpenedByUser networkId ->
            ( { model | callsignsOpenedPopupId = Just networkId }, E.none )

        CallsignsPopupClosedByUser ->
            ( { model | callsignsOpenedPopupId = Nothing }, E.none )

        CallsignsInfoReturnedByApi (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації про позивні" e
            )

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

        MapOpenedByUser networkId ->
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    ( model
                    , E.getNetworkPoints (NetworkPointsReturnedByApi networkId)
                        { networkId = networkId
                        , sinceDateInclusiveMs = Time.posixToMillis dtFromPosix
                        , tillDateNoninclusiveMs = Just <| Time.posixToMillis dtToPosix
                        }
                    )

                _ ->
                    ( model, E.none )

        MapClosedByUser ->
            ( { model | map = Closed }, E.none )

        NetworkPointsReturnedByApi _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок мережі" e
            )

        NetworkPointsReturnedByApi networkId (Ok res) ->
            ( { model | map = Opened networkId res.points }, E.none )

        FilterStateMsg filterState ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterStateDebounceConfig filterState model.filterStateDebounce

                m2 =
                    { model
                        | filterState = filterState
                        , filterStateDebounce = debounce
                        , showOnlyInvestigating = False
                    }
            in
            ( m2
            , E.sendCmd cmd
            )

        FilterStateDebounceMsg imsg ->
            let
                tracker =
                    "networks-" ++ String.fromInt (model.requestCounter + 1)

                cancelPrevious =
                    case model.currentRequestTracker of
                        Just prevTracker ->
                            Http.cancel prevTracker

                        Nothing ->
                            Cmd.none

                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterStateDebounceConfig
                        (Debounce.takeLast (\_ -> loadNetworksWithTracker model tracker))
                        imsg
                        model.filterStateDebounce

                model2 =
                    { model
                        | filterStateDebounce = debounce
                        , networks = Loading
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

                ( m3, eff3 ) =
                    loadNetworks m2
            in
            ( m3
            , E.batch
                [ eff2
                , eff3
                ]
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

                ( m3, eff3 ) =
                    loadNetworks m2
            in
            ( m3
            , E.batch
                [ eff2
                , eff3
                ]
            )

        UnitStatsReturnedByApi (Err err) ->
            ( { model | unitStats = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
            )

        UnitStatsReturnedByApi (Ok rsp) ->
            ( { model
                | unitStats = Success rsp.units
                , loadingUnitStats = False
              }
            , E.none
            )

        ReportModalOpenedByUser ->
            ( { model | reportModalOpened = True }, E.none )

        ReportModalClosedByUser ->
            ( { model | reportModalOpened = False }, E.none )

        ReportDownloadClickedByUser ->
            let
                context =
                    { fromDate = model.reportFromDate.datePosix
                    , toDate = model.reportToDate.datePosix
                    , zone = shared.timeZone
                    , networkId = Nothing
                    }

                req =
                    { filterFreq = emptySToNothing model.filterState.freq
                    , filterUnit = emptySToNothing model.filterState.unit
                    , sortBy = Nothing
                    , showOnlyFurtherInverstigation =
                        if model.showOnlyInvestigating then
                            Just True

                        else
                            Nothing
                    , showInactive = Just (not model.showOnlyActive)
                    , showOnlyDeleted = Just model.showArchived
                    , aorIds =
                        if List.isEmpty model.aorFilterSelect.selected then
                            Nothing

                        else
                            Just model.aorFilterSelect.selected
                    , ids = Nothing
                    , limit = Nothing
                    }

                apiCall reportType ctx =
                    E.getNetworksReport ReportDownloadReturnedByApi
                        { req = req
                        , etalonkaType = ReportConfig.toApiEtalonkaType reportType ctx
                        }
            in
            ( { model | reportDownloadInProgress = True }
            , ReportUpdate.createReportDownloadEffect model.report context apiCall
            )

        ReportDownloadReturnedByApi result ->
            let
                context =
                    { fromDate = model.from.datePosix
                    , toDate = model.to.datePosix
                    , zone = shared.timeZone
                    , networkId = Nothing
                    }

                updateDownloading isDownloading m =
                    { m | reportDownloadInProgress = isDownloading }
            in
            ReportUpdate.handleReportDownloadResponse result context updateDownloading model

        GoiReportDownloadClickedByUser ->
            ( { model | goiReportDownloadInProgress = True }
            , E.getNetworkGoiReport GoiReportDownloadReturnedByApi
            )

        GoiReportDownloadReturnedByApi (Ok bytes) ->
            let
                filename = "goi_report.xlsx"
            in
            ( { model | goiReportDownloadInProgress = False }
            , E.downloadFile filename "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" bytes
            )

        GoiReportDownloadReturnedByApi (Err e) ->
            ( { model | goiReportDownloadInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження звіту ГОІ" e
            )

        ReportTypeChanged option ->
            let
                newReport =
                    ReportUpdate.updateReportFromForm option
            in
            ( { model | report = newReport }, E.none )

        ReportActiveFreqsOnlyChanged checked ->
            let
                newReport =
                    ReportUpdate.updateCommonSetting "activeFreqsOnly" checked model.report
            in
            ( { model | report = newReport }, E.none )

        ReportIncludeSigintSignsChanged checked ->
            let
                newReport =
                    ReportUpdate.updateCommonSetting "includeSigintSigns" checked model.report
            in
            ( { model | report = newReport }, E.none )

        ReportIncludeConfirmationChanged checked ->
            let
                newReport =
                    ReportUpdate.updateCommonSetting "includeConfirmation" checked model.report
            in
            ( { model | report = newReport }, E.none )

        ReportIncludeUnitCallsignsChanged checked ->
            let
                newReport =
                    ReportUpdate.updateExtendedSetting "includeUnitCallsigns" checked model.report
            in
            ( { model | report = newReport }, E.none )

        ReportIncludePelengsMapChanged checked ->
            let
                newReport =
                    ReportUpdate.updateExtendedSetting "includePelengsMap" checked model.report
            in
            ( { model | report = newReport }, E.none )

        ReportDateTimeFromMsg imsg ->
            let
                ( m2, eff2 ) =
                    Shared.Components.DateTime.update
                        { zone = shared.timeZone
                        , msg = imsg
                        , model = model.reportFromDate
                        , toModel = \reportFromDate -> { model | reportFromDate = reportFromDate }
                        , toMsg = ReportDateTimeFromMsg
                        }
            in
            ( m2, eff2 )

        ReportDateTimeToMsg imsg ->
            let
                ( m2, eff2 ) =
                    Shared.Components.DateTime.update
                        { zone = shared.timeZone
                        , msg = imsg
                        , model = model.reportToDate
                        , toModel = \reportToDate -> { model | reportToDate = reportToDate }
                        , toMsg = ReportDateTimeToMsg
                        }
            in
            ( m2, eff2 )

        ToggleShowOnlyInvestigating val ->
            let
                newFilterState =
                    { freq = model.filterState.freq
                    , unit = ""
                    , callsigns = model.filterState.callsigns
                    , showArchived = model.filterState.showArchived
                    }

                m2 =
                    { model | showOnlyInvestigating = val, filterState = newFilterState }

                ( m3, eff ) =
                    loadNetworks m2
            in
            ( m3, eff )

        ToggleShowOnlyActive val ->
            let
                m2 =
                    { model | showOnlyActive = val }

                ( m3, eff ) =
                    loadNetworks m2
            in
            ( m3, eff )

        ToggleShowArchived val ->
            let
                m2 =
                    { model | showArchived = val }

                ( m3, eff ) =
                    loadNetworks m2
            in
            ( m3, eff )

        NetworksMergeStart ->
            ( { model
                | networksMergeStatus =
                    case model.networksMergeStatus of
                        CalculatedSuggestions (x :: xs) ->
                            let
                                preview =
                                    generatePreview x
                            in
                            Merging x preview xs

                        _ ->
                            NotCalculatedSuggestionsYet
              }
            , E.none
            )

        NetworksMergeFinish ->
            ( { model
                | networksMergeStatus =
                    case ( model.networksMergeStatus, model.networks ) of
                        ( Merging _ _ _, Success networks ) ->
                            CalculatedSuggestions (findSuggestedToMergeNetworks networks)

                        _ ->
                            NotCalculatedSuggestionsYet
              }
            , E.none
            )

        NetworksMergeTryNext ->
            ( { model
                | networksMergeStatus =
                    case ( model.networksMergeStatus, model.networks ) of
                        ( Merging _ _ (next :: xs), _ ) ->
                            Merging next (generatePreview next) xs

                        ( _, Success networks ) ->
                            CalculatedSuggestions (findSuggestedToMergeNetworks networks)

                        _ ->
                            NotCalculatedSuggestionsYet
              }
            , E.none
            )

        NetworksMergeDoIt mergeFrom mergeInto ->
            ( { model | networksMergeInProgress = True }
            , E.mergeNetworks (NetworksMergedByApi mergeFrom) { networkIdFrom = mergeFrom, networkIdTo = mergeInto }
            )

        NetworksMergedByApi _ (Err e) ->
            ( { model | networksMergeInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка об'єднання мереж" e
            )

        NetworksMergedByApi idToRemove (Ok res) ->
            let
                networks =
                    List.filter (\network -> network.id /= idToRemove) (RD.withDefault [] model.networks)

                networks2 =
                    ListX.updateIf (\network -> network.id == res.id) (\_ -> res) networks
            in
            ( { model
                | networks = Success networks2
                , networksMergeInProgress = False
                , networksMergeStatus =
                    case ( model.networksMergeStatus, findSuggestedToMergeNetworks networks2 ) of
                        ( Merging _ _ _, x :: xs ) ->
                            Merging x (generatePreview x) xs

                        _ ->
                            CalculatedSuggestions (findSuggestedToMergeNetworks networks2)
              }
            , E.none
            )

        NetworksMergeSwapOrder ->
            ( { model
                | networksMergeStatus =
                    case model.networksMergeStatus of
                        Merging ( networkA, networkB ) _ remaining ->
                            Merging ( networkB, networkA ) (generatePreview ( networkB, networkA )) remaining

                        _ ->
                            model.networksMergeStatus
              }
            , E.none
            )

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
                    , showArchived = model.filterState.showArchived
                    }

                m2 =
                    { model | filterState = newFilterState, showOnlyInvestigating = False }

                ( m3, eff ) =
                    loadNetworks m2
            in
            ( m3, eff )

        ToggleSidebar ->
            ( { model | showSidebar = not model.showSidebar }, E.none )

        ClearAllFilters ->
            let
                clearedFilterState =
                    { freq = ""
                    , unit = ""
                    , callsigns = []
                    , showArchived = False
                    }

                m2 =
                    { model
                        | filterState = clearedFilterState
                        , showOnlyInvestigating = False
                        , showOnlyActive = False
                    }

                ( m3, eff ) =
                    loadNetworks m2
            in
            ( m3, eff )

        CreateNewNetworkClicked ->
            ( model, E.pushRoutePath Route.Path.RerNetworks_Create )

        SetTableState newState ->
            ( { model | tableState = newState }, E.none )

        AorListReturnedByApi (Ok aors) ->
            let
                topLevelAors =
                    aors |> List.filter .isTopLevel

                items =
                    topLevelAors |> List.map (\a -> Select.basicMenuItem { item = a.id, label = a.name })

                oldAorSelect =
                    model.aorFilterSelect

                -- keep only selected AORs that are top-level
                selectedFiltered =
                    oldAorSelect.selected
                        |> List.filter (\id -> List.any (\a -> a.id == id) topLevelAors)

                newAorSelect =
                    { oldAorSelect | items = items, selected = selectedFiltered }
            in
            ( { model | aorList = Success aors, aorFilterSelect = newAorSelect }, E.none )

        AorListReturnedByApi (Err e) ->
            ( { model | aorList = Failure e }, E.none )

        AorFilterSelMsg selMsg ->
            let
                ( mAction, iState, icmd ) =
                    Select.update selMsg model.aorFilterSelect.state

                ( newSelected, newState ) =
                    Utils.Select.multiUpdMenuOpen mAction model.aorFilterSelect.selected iState

                focusedBefore =
                    case mAction of
                        Just Select.Focus ->
                            Just model.aorFilterSelect.selected

                        Just (Select.MenuToggle Select.MenuOpen) ->
                            Just model.aorFilterSelect.selected

                        _ ->
                            model.aorFilterFocusedBefore

                newSel =
                    { state = newState
                    , items = model.aorFilterSelect.items
                    , selected = newSelected
                    }

                m2 =
                    { model | aorFilterSelect = newSel, aorFilterFocusedBefore = focusedBefore }

                shouldReload =
                    case mAction of
                        Just Select.Blur ->
                            True

                        Just (Select.MenuToggle Select.MenuClose) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False

                valueChanged =
                    case mAction of
                        Just Select.Clear ->
                            True

                        _ ->
                            case m2.aorFilterFocusedBefore of
                                Just xs ->
                                    xs /= newSelected

                                Nothing ->
                                    False

                ( m3, eff ) =
                    if shouldReload && valueChanged then
                        loadNetworks { m2 | aorFilterFocusedBefore = Nothing }

                    else if shouldReload then
                        ( { m2 | aorFilterFocusedBefore = Nothing }, E.none )

                    else
                        ( m2, E.none )
            in
            ( m3
            , E.batch [ E.sendCmd <| Cmd.map AorFilterSelMsg icmd, eff ]
            )


networksTableConfig : Auth.User -> Shared.Model -> Model -> Table.Config B.Network Msg
networksTableConfig user shared model =
    let
        defaultCustomizations =
            Table.defaultCustomizations

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
                            span [ style "color" "var(--color-text-muted)" ] [ text " ↕" ]

                        TableConfig.Reversible (Just isReversed) ->
                            span [ style "color" "var(--ochre-normal)" ]
                                [ text
                                    (if isReversed then
                                        " ↑"

                                     else
                                        " ↓"
                                    )
                                ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click, style "padding" "1rem 1.5rem" ] [ headerContent ]

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    Table.customConfig
        { toId = \network -> String.fromInt network.id
        , toMsg = SetTableState
        , columns =
            [ Table.veryCustomColumn
                { name = "Мережа"
                , viewData =
                    \network ->
                        { attributes = []
                        , children =
                            [ div [ class "flex items-center gap-2" ]
                                [ -- Status circle
                                  div
                                    [ class "w-2 h-2 rounded-full flex-shrink-0 self-center"
                                    , style "background-color"
                                        (if isNetworkActive network then
                                            "#10b981"
                                            -- green for active

                                         else
                                            "#6b7280"
                                         -- gray for inactive
                                        )
                                    , attribute "title"
                                        (if isNetworkActive network then
                                            "Активна мережа"

                                         else
                                            "Неактивна мережа"
                                        )
                                    ]
                                    []
                                , a
                                    [ class "cursor-pointer"
                                    , Route.href { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network.id }, hash = Nothing, query = Dict.empty }
                                    , target "_blank"
                                    ]
                                    (case shared.masterUnits of
                                        Success units ->
                                            [ EUtils.renderNetworkNameWithoutType network units ]

                                        _ ->
                                            [ text "Завантаження..." ]
                                    )
                                ]
                            ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\network -> network.location)
                }
                |> Table.withColumnWidth "27%"
            , Table.veryCustomColumn
                { name = "Частоти"
                , viewData =
                    \network ->
                        { attributes = []
                        , children =
                            [ div [ class "flex flex-col" ] (List.map (\freq -> span [] [ text freq.freq ]) network.freqs)
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "8%"
            ]
                ++ (if Core.Auth.hasRole "UnitsEditor" user then
                        [ Table.veryCustomColumn
                            { name = "Смуги"
                            , viewData =
                                \network ->
                                    { attributes = []
                                    , children =
                                        [ case model.aorList of
                                            Success aors ->
                                                let
                                                    aorNames =
                                                        network.aorIds
                                                            |> List.filterMap (\aid -> aors |> List.filter (\a -> a.id == aid) |> List.head |> Maybe.map .name)
                                                            |> String.join ", "
                                                in
                                                text aorNames

                                            _ ->
                                                Shared.Components.Spinner.loadingSpinnerSm
                                        ]
                                    }
                            , sorter = Table.unsortable
                            }
                            |> Table.withColumnWidth "10%"
                        ]

                    else
                        []
                   )
                ++ [ Table.veryCustomColumn
                        { name = "Локації"
                        , viewData =
                            \network ->
                                { attributes = []
                                , children =
                                    [ div [ style "overflow-wrap" "anywhere" ] [ text network.location ]
                                    ]
                                }
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "20%"
                   , Table.veryCustomColumn
                        { name = "Пеленги"
                        , viewData =
                            \network ->
                                { attributes = []
                                , children =
                                    [ case model.map of
                                        Closed ->
                                            span [ class " cursor-pointer text-action", onClick <| MapOpenedByUser network.id ]
                                                [ text "відкрити мапу "
                                                , i [ class "bi bi-map text-sm mr-2" ] []
                                                ]

                                        Opened networkId points ->
                                            if networkId == network.id then
                                                Html.node "small-map"
                                                    [ property "points" (Encode.list B.networkPointEncoder points)
                                                    , Html.Events.on "close-map" (Decode.succeed MapClosedByUser)
                                                    , class "block w-full h-[90px]"
                                                    ]
                                                    []

                                            else
                                                span [ class "cursor-pointer text-action", onClick <| MapOpenedByUser network.id ]
                                                    [ text "відкрити мапу "
                                                    , i [ class "bi bi-map text-sm mr-2" ] []
                                                    ]
                                    ]
                                }
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "18%"
                   , Table.veryCustomColumn
                        { name = "Активність"
                        , viewData =
                            \network ->
                                { attributes = []
                                , children =
                                    [ case model.networksGroupsActivity of
                                        Success data ->
                                            let
                                                groupsMessageCountByDayJson =
                                                    Dict.get (String.fromInt network.id) data
                                                        |> Maybe.map (Encode.dict identity (Encode.dict identity Encode.int))
                                            in
                                            case groupsMessageCountByDayJson of
                                                Just g ->
                                                    div [ style "width" "200px", style "height" "90px" ]
                                                        [ Html.node "bar-chart"
                                                            [ Attr.property "data" <| g
                                                            , Attr.property "last-day" <| Encode.string model.to.dateStr
                                                            , style "display" "block"
                                                            ]
                                                            []
                                                        ]

                                                Nothing ->
                                                    text "Не активні останні 10 днів"

                                        _ ->
                                            Shared.Components.Spinner.loadingSpinnerSm
                                    ]
                                }
                        , sorter = Table.unsortable
                        }
                        |> Table.withColumnWidth "18%"
                   , Table.veryCustomColumn
                        { name = "Останнє оновлення"
                        , viewData =
                            \network ->
                                { attributes = []
                                , children =
                                    let
                                        updatedAtString =
                                            Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix network.lastUpdatedAt)

                                        updatedByString =
                                            Maybe.withDefault "невідомий" network.lastUpdatedBy

                                        createdAtString =
                                            Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix network.createdAt)
                                    in
                                    [ div [ style "padding-left" "4px", title ("Прив'язку створено " ++ createdAtString) ]
                                        [ i [ class "bi bi-calendar-date" ] []
                                        , text (" " ++ createdAtString)
                                        ]
                                    , div [ style "padding-left" "4px", title ("Востаннє прив'язка редагована " ++ updatedAtString ++ " користувачем " ++ updatedByString) ]
                                        [ i [ class "bi bi-pencil-square" ] []
                                        , text (" " ++ updatedAtString ++ " (" ++ updatedByString ++ ")")
                                        ]
                                    ]
                                }
                        , sorter = Table.increasingOrDecreasingBy (\network -> String.fromInt network.lastUpdatedAt)
                        }
                        |> Table.withColumnWidth "9%"
                   ]
        , customizations = customizations
        }


findSuggestedToMergeNetworks : List B.Network -> List ( B.Network, B.Network )
findSuggestedToMergeNetworks networks_ =
    let
        shouldBeMerged : B.Network -> B.Network -> Bool
        shouldBeMerged network1 network2 =
            network1.purpose == network2.purpose && List.sort (Maybe.withDefault [] network1.unitIds) == List.sort (Maybe.withDefault [] network2.unitIds)

        findPairs : List ( B.Network, B.Network ) -> List B.Network -> List ( B.Network, B.Network )
        findPairs acc remaining =
            case remaining of
                [] ->
                    acc

                x :: xs ->
                    let
                        suggestedItems =
                            List.filter (shouldBeMerged x) xs

                        newPairs =
                            List.map (Tuple.pair x) suggestedItems
                    in
                    findPairs (List.append acc newPairs) xs
    in
    findPairs [] networks_



-- Helper function to determine if a network is active


isNetworkActive : B.Network -> Bool
isNetworkActive network =
    case network.activeTo of
        Nothing ->
            True

        -- activeTo is empty, so network is active
        Just _ ->
            False



-- activeTo has a value, so network is inactive


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


mainContent : Auth.User -> List B.Network -> Shared.Model -> Model -> Html Msg
mainContent user networks shared model =
    section []
        [ div [ class "table-responsive-modern" ]
            [ Table.view
                (networksTableConfig user shared model)
                model.tableState
                networks
            ]
        ]


filterPanel : Auth.User -> Shared.Model -> Model -> Html Msg
filterPanel user shared model =
    let
        filterState =
            model.filterState

        -- Check if any filters are active
        hasActiveFilters =
            (filterState.freq /= "")
                || (filterState.unit /= "")
                || not (List.isEmpty filterState.callsigns)
                || model.showOnlyInvestigating
                || model.showOnlyActive
                || model.showArchived

        -- Count active filters
        activeFilterCount =
            [ filterState.freq /= ""
            , filterState.unit /= ""
            , not (List.isEmpty filterState.callsigns)
            , model.showOnlyInvestigating
            , model.showOnlyActive
            , model.showArchived
            ]
                |> List.filter identity
                |> List.length

        -- SegmentedControl options for archive filter
        archiveOptions =
            [ { value = False, label = "Доступні" }
            , { value = True, label = "Архів" }
            ]
    in
    div [ class "flex flex-col gap-3 px-1" ]
        [ -- Title row with filter count and clear button
          div [ class "flex justify-content-between align-items-center" ]
            [ div [ class "flex items-center" ]
                [ span [ class "text-lg font-medium text-gray-900 dark:text-gray-100" ] [ text "Фільтри" ]
                , if activeFilterCount > 0 then
                    span
                        [ class "ml-1 inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200" ]
                        [ text (String.fromInt activeFilterCount) ]

                  else
                    text ""
                ]
            , div
                [ class "d-flex align-items-center"
                , style "cursor" "pointer"
                , onClick ClearAllFilters
                , attribute "title"
                    (if hasActiveFilters then
                        "Скинути всі фільтри (" ++ String.fromInt activeFilterCount ++ ")"

                     else
                        "Немає активних фільтрів"
                    )
                ]
                [ span [ class "me-1 text-secondary" ] [ text "Очистити" ]
                , i [ class "bi bi-x text-secondary", style "font-size" "1.2rem" ] []
                ]
            ]
        , -- Archive filter row
          div [ class "flex gap-4 justify-start items-center" ]
            [ SegmentedControl.new model.showArchived ToggleShowArchived archiveOptions
                |> SegmentedControl.view
            , if not model.showArchived then
                Checkbox.new { isChecked = model.showOnlyActive, onToggle = ToggleShowOnlyActive }
                    |> Checkbox.withContent [ span [] [ text "Тільки активні" ] ]
                    |> Checkbox.view

              else
                text ""
            , if Core.Auth.hasRole "UnitsEditor" user then
                let
                    selectedItems =
                        model.aorFilterSelect.selected
                            |> List.filterMap
                                (\aid ->
                                    case model.aorList of
                                        Success aors ->
                                            aors
                                                |> List.filter (\a -> a.id == aid)
                                                |> List.head
                                                |> Maybe.map (\a -> Select.basicMenuItem { item = a.id, label = a.name })

                                        _ ->
                                            Nothing
                                )
                in
                div [ style "min-width" "210px", style "width" "210px" ]
                    [ Html.map AorFilterSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.aorFilterSelect.state
                                model.aorFilterSelect.items
                                "смуги"
                                (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                    ]

              else
                text ""
            ]
        , -- Filter inputs row
          div [ class "flex gap-2 justify-start items-center" ]
            [ input
                [ class "form-input"
                , style "width" "200px"
                , type_ "text"
                , placeholder "частота"
                , value model.filterState.freq
                , onInput <| \v -> FilterStateMsg { filterState | freq = v }
                ]
                []
            , input
                [ class "form-input"
                , style "width" "200px"
                , type_ "text"
                , placeholder "підрозділ"
                , value model.filterState.unit
                , onInput <| \v -> FilterStateMsg { filterState | unit = v }
                ]
                []
            , button
                [ class "px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
                , onClick ToggleSidebar
                , attribute "title"
                    (if model.showSidebar then
                        "Сховати підрозділи"

                     else
                        "Показати підрозділи"
                    )
                ]
                [ text "Підрозділи" ]
            , span [ class "grow-1" ] []
            ]
        , let
            reportFormConfig =
                { onReportTypeChanged = ReportTypeChanged
                , onActiveFreqsOnlyChanged = ReportActiveFreqsOnlyChanged
                , onIncludeSigintSignsChanged = ReportIncludeSigintSignsChanged
                , onIncludeConfirmationChanged = ReportIncludeConfirmationChanged
                , onIncludeUnitCallsignsChanged = ReportIncludeUnitCallsignsChanged
                , onIncludePelengsMapChanged = ReportIncludePelengsMapChanged
                , reportFromDate = Just model.reportFromDate
                , reportToDate = Just model.reportToDate
                , onReportFromDateMsg = Just ReportDateTimeFromMsg
                , onReportToDateMsg = Just ReportDateTimeToMsg
                , showDateRange = True
                }

            modalConfig =
                { isOpen = model.reportModalOpened
                , onClose = ReportModalClosedByUser
                , onDownload = ReportDownloadClickedByUser
                , isDownloading = model.reportDownloadInProgress
                , reportType = model.report
                , reportFormConfig = reportFormConfig
                , title = "Звіт \"Еталонка\""
                , description = "Еталонка по фільтру частота/підрозділ/смуга"
                }
          in
          ReportModal.view modalConfig
        ]


contentBlock : Auth.User -> Shared.Model -> Model -> Html Msg
contentBlock user shared model =
    div []
        [ div
            [ class "border mb-4 p-2"
            ]
            [ filterPanel user shared model
            ]
        , case model.networks of
            Success networks ->
                mainContent
                    user
                    networks
                    shared
                    model

            _ ->
                div [ class "flex items-center justify-center w-full h-full" ] [ Shared.Components.Spinner.loadingSpinner ]
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
                                "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500"

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
                (case shared.masterUnits of
                    Success units ->
                        [ Core.UnitHierarchy.view config (Dict.values units) (RD.withDefault [] model.unitStats) ]

                    _ ->
                        [ Shared.Components.Spinner.loadingSpinner ]
                )
            ]


view : Bool -> Shared.Model -> Auth.User -> Model -> View Msg
view _ shared user model =
    { title = "мережі"
    , body =
        [ div [ class "flex rer-networks app-shell-fill-height" ]
            [ if model.showSidebar then
                leftPanel shared model

              else
                text ""
            , div [ class "grow  px-[32px] py-[16px] overflow-auto" ]
                [ div [ class "flex justify-between mb-[16px] w-full" ]
                    [ div [ class "flex gap-[16px]" ]
                        [ h1 []
                            [ text "мережі" ]
                        ]
                    , let
                        reportButton =
                            Button.new { label = "Звіт \"Еталонка\"", onClick = ReportModalOpenedByUser } |> Button.view

                        goiButton =
                            Button.new { label = "Звіт \"ГОІ\"", onClick = GoiReportDownloadClickedByUser }
                                |> (if model.goiReportDownloadInProgress then
                                        Button.withIcon [ Shared.Components.Spinner.loadingSpinner2Sm ]
                                    else
                                        identity
                                   )
                                |> Button.view

                        buttons =
                            if Core.Auth.hasRole "UnitsEditor" user then
                                [ Button.new { label = "Створити", onClick = CreateNewNetworkClicked } |> Button.withStyleSecondary |> Button.view
                                , reportButton
                                , goiButton
                                ]

                            else
                                [ reportButton
                                , goiButton
                                ]
                      in
                      div [ class "flex gap-[16px]" ] buttons
                    ]
                , case model.networksMergeStatus of
                    CalculatedSuggestions (_ :: _) ->
                        -- div [ class "w-full bg-[#F5F28A]/[40%] h-[70px] mb-[16px] border-1 border-[#F5F28A] rounded-lg flex justify-between items-center px-[16px] py-[8px] font-medium" ]
                        --     [ text <| (String.fromInt (List.length xs + 1) ++ " неопрацьованих пропозицій по злиттю мереж")
                        --     , Button.new { label = "Поєднати мережі", onClick = NetworksMergeStart }
                        --         |> Button.withStyleSecondary
                        --         |> Button.view
                        --     ]
                        text ""

                    _ ->
                        text ""
                , contentBlock user shared model
                ]
            , let
                isOpen =
                    case model.networksMergeStatus of
                        Merging _ _ _ ->
                            True

                        _ ->
                            False
              in
              Sidebar.view
                isOpen
                NetworksMergeFinish
                (networksMergeSidebarContent shared model)
            ]
        ]
    }


networksMergeSidebarContent : Shared.Model -> Model -> List (Html Msg)
networksMergeSidebarContent shared model =
    case model.networksMergeStatus of
        Merging ( networkA, networkB ) preview remaining ->
            [ div [ class "p-[24px] flex flex-col gap-[24px]" ]
                [ div []
                    [ span [] [ text <| String.fromInt (List.length remaining) ++ " рекомендацій по об'єданню мереж залишилося" ]
                    , h3 [] [ text "Поєднання двох мереж" ]
                    , span [] [ text "При поєднанні мереж інформація з другої мережі переноситься в першу. Після чого друга мережа видаляється." ]
                    ]

                -- , div []
                --     [ h4 []
                --         [ text "Що співпадає" ]
                --     , table
                --         []
                --         [ thead []
                --             [ tr []
                --                 [ th [] []
                --                 , th []
                --                     [ EUtils.renderNetworkNameWithoutType networkA model.masterUnits
                --                     ]
                --                 , th []
                --                     [ EUtils.renderNetworkNameWithoutType networkB model.masterUnits
                --                     ]
                --                 ]
                --             ]
                --         , tbody [] [ tr [] [ th [] [ text "Частоти" ], td [] [ text "225.2200, 113.3200" ], td [] [ text "225.2200, 113.3200" ] ] ]
                --         ]
                --     ]
                , div []
                    [ h4 [ class "mb-[8px]" ] [ text "Напрямок поєднання" ]
                    , div []
                        [ div [ class "flex gap-[8px] items-center mb-[8px]" ]
                            [ span [ class "basis-[80px]" ] [ text "залишаємо" ]
                            , span [ class "border-1 border-border p-[8px] rounded-lg font-medium" ]
                                (case shared.masterUnits of
                                    Success units ->
                                        [ EUtils.renderNetworkNameWithoutType networkA units ]

                                    _ ->
                                        [ text "Loading..." ]
                                )
                            ]
                        , span [ onClick NetworksMergeSwapOrder, class "text-action cursor-pointer font-medium" ] [ text "змінити місцями" ]
                        , div [ class "flex gap-[8px] items-center mt-[8px]" ]
                            [ span [ class "basis-[80px]" ] [ text "вливаємо" ]
                            , span [ class "border-1 border-border p-[8px] rounded-lg font-medium" ]
                                (case shared.masterUnits of
                                    Success units ->
                                        [ EUtils.renderNetworkNameWithoutType networkB units ]

                                    _ ->
                                        [ text "Loading..." ]
                                )
                            ]
                        ]
                    ]
                , div []
                    [ h4 [ class "mb-[8px]" ] [ text "Попередній перегляд" ]
                    , ul []
                        [ li [ class "flex gap-[4px] border-b-1 border-border py-[8px]" ]
                            [ span [ class "text-sm font-medium  basis-1/3 shrink-0" ] [ text "Назва мережі" ]
                            , span []
                                (case shared.masterUnits of
                                    Success units ->
                                        [ EUtils.renderNetworkNameWithoutType preview units ]

                                    _ ->
                                        [ text "Loading..." ]
                                )
                            ]
                        , li [ class "flex gap-[4px] border-b-1 border-border py-[8px]" ]
                            [ span [ class "text-sm font-medium basis-1/3 shrink-0" ] [ text "Район функціонування/розгортання:" ]
                            , span [] [ text preview.location ]
                            ]
                        , li [ class "flex gap-[4px] border-b-1 border-border py-[8px]" ]
                            [ span [ class "text-sm font-medium shrink-0 basis-1/3 sh" ] [ text "Призначення:" ]
                            , span [] [ text <| Maybe.withDefault "" preview.purpose ]
                            ]
                        , li [ class "flex gap-[4px] border-b-1 border-border py-[8px]" ]
                            [ span [ class "text-sm font-medium basis-1/3 shrink-0" ] [ text "Частоти:" ]
                            , span [] [ preview.freqs |> List.map .freq |> String.join ", " |> text ]
                            ]
                        , li [ class "flex gap-[4px] py-[8px]" ]
                            [ span [ class "text-sm font-medium basis-1/3 shrink-0" ] [ text "Радіостанція:" ]
                            , span [] [ text <| Maybe.withDefault "" preview.radioStation ]
                            ]
                        ]
                    ]
                , div [ class "flex justify-end gap-[8px]" ]
                    [ div [ class "grow-1" ] [ Button.new { label = "Назад", onClick = NetworksMergeFinish } |> Button.withStyleSecondary |> Button.view ]
                    , Button.new { label = "Пропустити", onClick = NetworksMergeTryNext } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Поєднати", onClick = NetworksMergeDoIt networkA.id networkB.id }
                        |> (if model.networksMergeInProgress then
                                Button.withIcon
                                    [ Shared.Components.Spinner.loadingSpinner2Sm
                                    ]

                            else
                                identity
                           )
                        |> Button.view
                    ]
                ]
            ]

        _ ->
            [ text "" ]


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
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "networks"
        }
