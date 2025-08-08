module Pages.RerNetworks exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.ModalDialog as ModalDialog
import Components.RadioGroup as RadioGroup
import Components.SegmentedControl as SegmentedControl
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Keyed
import Html.Styled as Styled
import Http
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import Le.Auth
import Le.Block.Callsign
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.DateTime
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Unit as Unit
import Le.ErrorHandling
import Le.NetworksUtils as EUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import RerFreqs.Model exposing (FurtherInvestigationFilter(..))
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Task
import Time exposing (Posix)
import TimeZone
import UnitHierarchy
import Url.Builder
import View exposing (View)


type NetworksMergeStatus
    = NotCalculatedSuggestionsYet
    | CalculatedSuggestions (List ( B.Network, B.Network ))
    | Merging ( B.Network, B.Network ) B.Network (List ( B.Network, B.Network ))


type alias Model =
    { zone : Maybe Time.Zone
    , now : Maybe Time.Posix
    , from : Le.Block.DateTime.Model
    , to : Le.Block.DateTime.Model
    , networksGroupsActivity : RemoteData ApiError GroupsActivityPerDayRsp
    , networks : RemoteData ApiError (List B.Network)
    , currentRequestTracker : Maybe String
    , requestCounter : Int
    , networksMergeStatus : NetworksMergeStatus
    , networksMergeInProgress : Bool
    , callsignsByNetwork : RemoteData ApiError E.CallsignsByNetwork
    , callsignsOpenedPopupId : Maybe Int
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , callsigns : List String
    , map : MapState
    , filterState : FilterState
    , filterStateDebounce : Debounce FilterState
    , unitStats : RemoteData ApiError (List B.FreqUnitStatRow)
    , reportModalOpened : Bool
    , reportDownloadInProgress : Bool
    , reportGUROnly : Bool
    , reportActiveFreqsOnly : Bool
    , reportIncludePelengsMap : Bool
    , reportIncludeSigintSigns : Bool
    , reportIncludeConfirmation : Bool
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
            { zone = Nothing
            , now = Nothing
            , from = Le.Block.DateTime.init ()
            , to = Le.Block.DateTime.init ()
            , networks = NotAsked
            , currentRequestTracker = Nothing
            , requestCounter = 0
            , networksMergeStatus = NotCalculatedSuggestionsYet
            , networksMergeInProgress = False
            , networksGroupsActivity = NotAsked
            , callsignsByNetwork = NotAsked
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
            , reportGUROnly = False
            , reportActiveFreqsOnly = True
            , reportIncludePelengsMap = True
            , reportIncludeSigintSigns = True
            , reportIncludeConfirmation = True
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
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <| Task.attempt GotZone Le.Time.getZone
        , E.getUnitStatsForNetworks UnitStatsReturnedByApi
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
        , filterFurtherInvestigation =
            if model.showOnlyInvestigating then
                Just True

            else
                Nothing
        , showInactive = Just (not model.showOnlyActive)
        , showOnlyDeleted = Just model.showArchived
        }
    )


loadNetworksWithTracker : Model -> String -> Cmd Msg
loadNetworksWithTracker model tracker =
    Api.get_networks_list_with_tracker NetworksReturnedByApi
        tracker
        { filterFreq = emptySToNothing model.filterState.freq
        , filterUnit = emptySToNothing model.filterState.unit
        , sortBy = Nothing
        , filterFurtherInvestigation =
            if model.showOnlyInvestigating then
                Just True

            else
                Nothing
        , showInactive = Just (not model.showOnlyActive)
        , showOnlyDeleted = Just model.showArchived
        }


type Msg
    = GotZone (Result TimeZone.Error ( String, Time.Zone ))
    | GotTime Time.Zone Posix
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
    | CallsignsByNetworkReturnedByApi (Result ApiError E.CallsignsByNetwork)
    | CallsignsInfoReturnedByApi (Result ApiError (List B.CallsignInfoRes))
    | MapOpenedByUser Int
    | MapClosedByUser
    | FilterStateMsg FilterState
    | FilterStateDebounceMsg Debounce.Msg
    | DateTimeFromMsg (Le.Block.DateTime.Msg Msg)
    | DateTimeToMsg (Le.Block.DateTime.Msg Msg)
    | UnitStatsReturnedByApi (Result ApiError B.NetworkUnitStatsRsp)
    | ReportModalOpenedByUser
    | ReportModalClosedByUser
    | ReportDownloadClickedByUser
    | ReportDownloadReturnedByApi (Result ApiError Bytes)
    | ReportGURCheckedByUser Bool
    | ReportActiveFreqsOnlyCheckedByUser Bool
    | ReportIncludePelengsMapCheckedByUser Bool
    | ReportIncludeConfirmationCheckedByUser Bool
    | ReportIncludeSigintSignsCheckedByUser Bool
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


prepareReportDownloadCmd : Model -> Effect Msg
prepareReportDownloadCmd model =
    case ( model.from.datePosix, model.to.datePosix ) of
        ( Just dtFromPosix, Just dtToPosix ) ->
            let
                payload =
                    { sinceDateInclusiveMs = Just <| Time.posixToMillis dtFromPosix
                    , tillDateNoninclusiveMs = Just <| Time.posixToMillis dtToPosix
                    , filterFreq = emptySToNothing model.filterState.freq
                    , filterUnit = emptySToNothing model.filterState.unit
                    , sortBy = Nothing
                    , settings =
                        { networksOnly = model.reportGUROnly
                        , activeFreqsOnly = model.reportActiveFreqsOnly
                        , includePelengsMap = model.reportIncludePelengsMap
                        , includeSigintSigns = model.reportIncludeSigintSigns
                        , includeConfirmation = model.reportIncludeConfirmation
                        }
                    }
            in
            E.getNetworksReport ReportDownloadReturnedByApi payload

        _ ->
            E.none


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
        GotZone (Err e) ->
            ( model
            , E.showErrorWithDetails "Помилка отримання часового поясу" ("Error getting timezone: " ++ renderZoneError e)
            )

        GotZone (Ok ( _, zone )) ->
            ( { model | zone = Just zone }
            , E.sendCmd <|
                Task.perform (GotTime zone) Time.now
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
            loadNetworks m2

        NetworksReturnedByApi (Err err) ->
            ( { model | networks = Failure err, currentRequestTracker = Nothing }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж" err
            )

        NetworksReturnedByApi (Ok networks) ->
            ( { model
                | networks =
                    Success networks
                , currentRequestTracker = Nothing
                , networksMergeStatus = CalculatedSuggestions (findSuggestedToMergeNetworks networks)
              }
            , case ( model.from.datePosix, model.to.datePosix ) of
                ( Just dtFromPosix, Just dtToPosix ) ->
                    E.batch
                        [ E.getNetworksGroupsActivity NetworksGroupsActivityReturnedByApi
                            { networkIds = networks |> List.map .id
                            , tillDateNoninclusiveMs = Just <| Time.posixToMillis dtToPosix
                            }
                        , E.getNetworksCallsigns CallsignsByNetworkReturnedByApi
                            { networkIds = networks |> List.map .id
                            }
                        ]

                _ ->
                    E.none
            )

        NetworksGroupsActivityReturnedByApi (Err err) ->
            ( { model | networksGroupsActivity = Failure err }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності мереж" err
            )

        NetworksGroupsActivityReturnedByApi (Ok res) ->
            ( { model | networksGroupsActivity = Success res }, E.none )

        CallsignsPopupOpenedByUser networkId ->
            ( { model | callsignsOpenedPopupId = Just networkId }, E.none )

        CallsignsPopupClosedByUser ->
            ( { model | callsignsOpenedPopupId = Nothing }, E.none )

        CallsignsByNetworkReturnedByApi (Ok rsp) ->
            let
                mergedResult =
                    Dict.merge
                        (\key existingCs result -> Dict.insert key existingCs result)
                        (\key _ newCs result -> Dict.insert key newCs result)
                        (\key newCs result -> Dict.insert key newCs result)
                        Dict.empty
                        (RD.withDefault Dict.empty model.callsignsByNetwork)
                        rsp

                newCallsigns =
                    Dict.values rsp
                        |> List.concat
                        |> List.filter (\callsign -> not (List.member callsign model.callsigns))
            in
            ( { model
                | callsignsByNetwork = Success mergedResult
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

        CallsignsByNetworkReturnedByApi (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" err
            )

        CallsignsInfoReturnedByApi (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації про позивні" e
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок мережі" e
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
                    Le.Block.DateTime.update
                        { zone = model.zone
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
                    Le.Block.DateTime.update
                        { zone = model.zone
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
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
            ( { model | reportDownloadInProgress = True }
            , prepareReportDownloadCmd model
            )

        ReportDownloadReturnedByApi (Err e) ->
            let
                m2 =
                    { model | reportDownloadInProgress = False }
            in
            ( m2
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка генерації звіту" e
            )

        ReportDownloadReturnedByApi (Ok bytes) ->
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

        ReportGURCheckedByUser isChecked ->
            let
                m1 =
                    if isChecked then
                        { model | reportIncludeConfirmation = False, reportIncludePelengsMap = False, reportIncludeSigintSigns = False }

                    else
                        model
            in
            ( { m1 | reportGUROnly = isChecked }, E.none )

        ReportActiveFreqsOnlyCheckedByUser isChecked ->
            ( { model | reportActiveFreqsOnly = isChecked }, E.none )

        ReportIncludePelengsMapCheckedByUser isChecked ->
            ( { model | reportIncludePelengsMap = isChecked }, E.none )

        ReportIncludeConfirmationCheckedByUser isChecked ->
            ( { model | reportIncludeConfirmation = isChecked }, E.none )

        ReportIncludeSigintSignsCheckedByUser isChecked ->
            ( { model | reportIncludeSigintSigns = isChecked }, E.none )

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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка об'єднання мереж" e
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


networksTableConfig : Shared.Model -> Model -> Table.Config B.Network Msg
networksTableConfig shared model =
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
            , Table.veryCustomColumn
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
                |> Table.withColumnWidth "11%"
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
                                        , i [ class "bi bi-map text-sm mr-2" ]
                                            []
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
                                            , i [ class "bi bi-map text-sm mr-2" ]
                                                []
                                            ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "18%"
            , Table.veryCustomColumn
                { name = "Позивні"
                , viewData =
                    \network ->
                        { attributes = []
                        , children =
                            [ case model.callsignsByNetwork of
                                Success cbn ->
                                    let
                                        callsigns =
                                            case Dict.get (String.fromInt network.id) cbn of
                                                Nothing ->
                                                    []

                                                Just v ->
                                                    v

                                        isOpen =
                                            case model.callsignsOpenedPopupId of
                                                Just openCallsignsPopup ->
                                                    openCallsignsPopup == network.id

                                                Nothing ->
                                                    False
                                    in
                                    case shared.masterUnits of
                                        Success units ->
                                            CallsignsPopup.view
                                                { isOpened = isOpen
                                                , onClose = CallsignsPopupClosedByUser
                                                , onOpen = CallsignsPopupOpenedByUser network.id
                                                , callsigns = callsigns
                                                , callsignsInfo = model.callsignsInfo
                                                , masterUnits = units
                                                }
                                                (NetworksPage
                                                    network
                                                )

                                        _ ->
                                            Le.Block.Spinner.loadingSpinnerSm

                                _ ->
                                    Le.Block.Spinner.loadingSpinnerSm
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "9%"
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
                                            Dict.get (String.fromInt network.id) data |> Maybe.map (Encode.dict identity (Encode.dict identity Encode.int))
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
                                    Le.Block.Spinner.loadingSpinnerSm
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
                            case ( network.lastUpdatedAt, model.zone ) of
                                ( updatedAt, Just zone ) ->
                                    let
                                        updatedAtString =
                                            Le.Time.renderDateF6 zone
                                                (Time.millisToPosix updatedAt)

                                        updatedByString =
                                            Maybe.withDefault "невідомий" network.lastUpdatedBy

                                        createdAtString =
                                            Le.Time.renderDateF6 zone
                                                (Time.millisToPosix network.createdAt)
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


mainContent : List B.Network -> Shared.Model -> Model -> Html Msg
mainContent networks shared model =
    section []
        [ div [ class "table-responsive-modern" ]
            [ Table.view
                (networksTableConfig shared model)
                model.tableState
                networks
            ]
        ]


filterPanel : Shared.Model -> Model -> Html Msg
filterPanel shared model =
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
            [ { value = False, label = "Не видалені" }
            , { value = True, label = "Архів" }
            ]
    in
    div [ class "flex flex-col gap-3" ]
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
          div [ class "flex gap-2 justify-start items-center" ]
            [ div [ class "me-2" ] [ text "" ] -- Spacer to align with first row
            , SegmentedControl.new model.showArchived ToggleShowArchived archiveOptions
                |> SegmentedControl.view
            ]
        , -- Filter inputs row
          div [ class "flex gap-2 justify-start items-center" ]
            [ div [ class "me-2" ]
                [ if model.networks == Loading then
                    Le.Block.Spinner.loadingSpinner2Sm

                  else
                    i [ class "bi bi-filter" ] []
                ]
            , input
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
        , -- Network status filters row (only show when not in archive mode)
          if not model.showArchived then
            div [ class "flex gap-4 justify-start items-center" ]
                [ div [ class "me-2" ] [ text "" ] -- Spacer to align with first row
                , Checkbox.new { isChecked = model.showOnlyActive, onToggle = ToggleShowOnlyActive }
                    |> Checkbox.withContent [ span [] [ text "Тільки активні" ] ]
                    |> Checkbox.view
                ]

          else
            text ""
        , let
            dialogContent =
                [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                    [ div [ class "pb-12" ]
                        [ h2 [] [ text "Звіт \"еталонка\"" ]
                        , p [] [ text "Еталонка по фільтру дата/частота/підрозділ" ]
                        , div [ class "grid grid-cols-2 gap-[8px] h-[80px]" ]
                            ([ Checkbox.new { isChecked = model.reportGUROnly, onToggle = ReportGURCheckedByUser }
                                |> Checkbox.withContent [ span [] [ text "Згідно форми" ] ]
                                |> Checkbox.view
                             , Checkbox.new { isChecked = model.reportActiveFreqsOnly, onToggle = ReportActiveFreqsOnlyCheckedByUser }
                                |> Checkbox.withContent [ span [] [ text "Лише активні частоти" ] ]
                                |> Checkbox.view
                             ]
                                ++ (if not model.reportGUROnly then
                                        [ Checkbox.new { isChecked = model.reportIncludePelengsMap, onToggle = ReportIncludePelengsMapCheckedByUser }
                                            |> Checkbox.withContent [ span [] [ text "Включити карту пеленгів" ] ]
                                            |> Checkbox.view
                                        , Checkbox.new { isChecked = model.reportIncludeSigintSigns, onToggle = ReportIncludeSigintSignsCheckedByUser }
                                            |> Checkbox.withContent [ span [] [ text "Додати сигнали" ] ]
                                            |> Checkbox.view
                                        , Checkbox.new { isChecked = model.reportIncludeConfirmation, onToggle = ReportIncludeConfirmationCheckedByUser }
                                            |> Checkbox.withContent [ span [] [ text "Додати підтвердження" ] ]
                                            |> Checkbox.view
                                        ]

                                    else
                                        []
                                   )
                            )
                        ]
                    , div [ class "flex justify-between" ]
                        [ Button.new { label = "Назад", onClick = ReportModalClosedByUser } |> Button.withStyleSecondary |> Button.view
                        , Button.new { label = "Згенерувати", onClick = ReportDownloadClickedByUser }
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
          ModalDialog.modalDialog model.reportModalOpened ReportModalClosedByUser [] dialogContent
        ]


contentBlock : Shared.Model -> Model -> Html Msg
contentBlock shared model =
    div []
        [ div
            [ class "border mb-4 p-2"
            ]
            [ filterPanel shared model
            ]
        , case model.networks of
            Success networks ->
                mainContent
                    networks
                    shared
                    model

            _ ->
                div [ class "flex items-center justify-center w-full h-full" ] [ Le.Block.Spinner.loadingSpinner ]
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
                (case shared.masterUnits of
                    Success units ->
                        [ UnitHierarchy.view config (Dict.values units) (RD.withDefault [] model.unitStats) ]

                    _ ->
                        [ Le.Block.Spinner.loadingSpinner ]
                )
            ]


view : Bool -> Shared.Model -> Auth.User -> Model -> View Msg
view dark shared user model =
    { title = "мережі"
    , body =
        [ div [ class "flex rer-networks", style "height" "calc(-50px + 100vh)" ]
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

                        buttons =
                            if Le.Auth.hasRole "UnitsEditor" user then
                                [ Button.new { label = "Створити", onClick = CreateNewNetworkClicked } |> Button.withStyleSecondary |> Button.view
                                , reportButton
                                ]

                            else
                                [ reportButton
                                ]
                      in
                      div [ class "flex gap-[16px]" ] buttons
                    ]
                , case model.networksMergeStatus of
                    CalculatedSuggestions (x :: xs) ->
                        div [ class "w-full bg-[#F5F28A]/[40%] h-[70px] mb-[16px] border-1 border-[#F5F28A] rounded-lg flex justify-between items-center px-[16px] py-[8px] font-medium" ]
                            [ text <| (String.fromInt (List.length xs + 1) ++ " неопрацьованих пропозицій по злиттю мереж")
                            , Button.new { label = "Поєднати мережі", onClick = NetworksMergeStart }
                                |> Button.withStyleSecondary
                                |> Button.view
                            ]

                    _ ->
                        text ""
                , contentBlock shared model
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
                                    [ Le.Block.Spinner.loadingSpinner2Sm
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
