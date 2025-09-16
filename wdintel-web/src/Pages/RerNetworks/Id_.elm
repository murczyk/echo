module Pages.RerNetworks.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Core.Auth
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Keyed
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Pages_.RerNetworks.Id_.CallsignsTables as CallsignsTables exposing (getDevelopingCallsigns, getRegularCallsigns)
import Pages_.RerNetworks.Id_.Descriptions as Descriptions
import Pages_.RerNetworks.Id_.FrequenciesTable as FrequenciesTable
import Pages_.RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), ShowAllPopupFor(..))
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import Pages_.RerNetworks.Id_.NetworkInfo as NetworkInfo
import Pages_.RerNetworks.ReportConfig as ReportConfig exposing (ReportTypeOption(..))
import Pages_.RerNetworks.ReportModal as ReportModal
import Pages_.RerNetworks.ReportUpdate as ReportUpdate
import Pages_.RerNetworks.Utils as IdUtils
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DateTime
import Shared.Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Pager as Pager
import Shared.Components.Popup as Popup
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Table.Sorter as TableSorter
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.NetworksUtils as NetworksUtils
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (networkKindVHFMapping)
import View exposing (View)


type alias Model =
    Types.Model


type alias Msg =
    Msgs.Msg


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user shared route =
    Page.new
        { init = init route shared
        , update = update shared
        , subscriptions = subscriptions
        , view = view user shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }


init : Route { id : String } -> Shared.Model -> () -> ( Model, Effect Msg )
init route shared () =
    ( { network = Loading
      , callsigns = NotAsked
      , mapPoints = NotAsked
      , groupsActivity = NotAsked
      , networkFreqsActivity = NotAsked
      , freqs = NotAsked
      , freqsEditingState = Readonly
      , callsignsEditingState = Readonly
      , callsignsOpenedPopupId = Nothing
      , mode = Readonly
      , missingFieldsMode = Readonly
      , missingFieldsEditLoading = False
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
      , editPostsSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-posts-state")
            , items = []
            , selected = []
            }
      , editUnitsSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-units-state")
            , items = []
            , selected = []
            }
      , editAorSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-aor-state")
            , items = []
            , selected = []
            }
      , aorList = NotAsked
      , addConfirmationInp = ""
      , addConfirmationFreqSelect =
            { state = Select.initState (Select.selectIdentifier "add-confirmation-freq-state")
            , items = []
            , selected = Nothing
            }
      , addSignsInp = ""
      , signals = NotAsked
      , reportModalOpened = False
      , reportDownloadInProgress = False
      , report = ReportConfig.AccordingToForm ReportConfig.defaultCommonSettings
      , reportFromDate = Shared.Components.DateTime.init ()
      , reportToDate = Shared.Components.DateTime.init ()
      , freqsActivityFilter = AllFreqs
      , freqsTableState = Table.initialSort "Частота"
      , callsignsTableState = Table.initialSort "Позивний"
      , freqEditSidebar = Nothing
      , freqDetailPopup = Nothing
      , modulations = NotAsked
      , freqEditKindSelect =
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
      , freqEditModulationSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-modulation-state")
            , items = []
            , selected = Nothing
            }
      , freqEditSaving = False
      , freqEditShowActiveTo = False
      , deleteNetworkConfirmation = Nothing
      , deleteNetworkLoading = False
      , deleteFreqConfirmation = Nothing
      , deleteFreqLoading = False

      -- Frequency creation sidebar
      , freqCreateSidebar = False
      , freqCreateState =
            { freq = ""
            , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
            , modulationId = Nothing
            , description = Nothing
            , activeFrom = Nothing
            , activeTo = Nothing
            }
      , freqCreateKindSelect =
            { state = Select.initState (Select.selectIdentifier "add-freq-kind-state")
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
      , freqCreateModulationSelect =
            { state = Select.initState (Select.selectIdentifier "add-freq-modulation-state")
            , items = []
            , selected = Nothing
            }
      , freqCreateDescriptionInp = ""
      , freqCreateFormatError = Nothing
      , freqCreateShowActiveTo = False

      -- Network callsigns (new table)
      , networkCallsigns = NotAsked
      , networkCallsignsTableState = Table.initialSort "Позивний"
      , networkCallsignsPager = Pager.initWithPageSize 5
      , callsignsPager = Pager.initWithPageSize 5

      -- Callsign adding functionality
      , callsignAddingInProgress = Set.empty
      , callsignsSearchQuery = ""
      , networkCallsignsSearchQuery = ""

      -- Network callsign creation sidebar
      , callsignCreateSidebar = Nothing
      , callsignCreateState = Nothing
      , callsignCreateSaving = False
      , callsignCreateErrors = Dict.empty
      , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
      , callsignCreateUnitSelState = Select.initState (Select.selectIdentifier "callsign-create-unit-state")
      , callsignCreateUnitSelectorVisible = False
      , callsignCreateSources = []

      -- Callsign deletion confirmation dialog initialization
      , deleteCallsignConfirmation = Nothing
      , deleteCallsignLoading = False

      -- Callsign editing functionality initialization
      , editCallsignSidebar = Nothing
      , editCallsignState = Nothing
      , editCallsignSaving = False
      , editCallsignErrors = Dict.empty
      , editCallsignSourceSelState = Select.initState (Select.selectIdentifier "callsign-edit-source-state")
      , editCallsignUnitSelState = Select.initState (Select.selectIdentifier "callsign-edit-unit-state")
      , editCallsignUnitSelectorVisible = False

      -- Developing callsigns dropdown initialization
      , developingCallsignDropdown = Nothing

      -- Unknown callsigns dropdown initialization
      , unknownCallsignDropdown = Nothing

      -- Row show all popup status initialization
      , rowShowAllPopupStatus = Nothing

      -- Sidebar states for creating descriptions initialization
      , confirmationCreateSidebar = False
      , signsCreateSidebar = False

      -- Sidebar state for editing descriptions initialization
      , editDescriptionSidebar = Nothing

      -- Input fields for editing descriptions initialization
      , editDescriptionInp = ""
      , editDescriptionFreqSelect =
            { state = Select.initState (Select.selectIdentifier "edit-description-freq-state")
            , items = []
            , selected = Nothing
            }

      -- Delete confirmation dialog initialization
      , deleteDescriptionConfirmation = Nothing
      }
    , case String.toInt route.params.id of
        Just id ->
            E.batch
                [ E.getSingleNetwork NetworkReturnedByApi id
                , E.getModulations ModulationsReturnedByApi
                , E.sendCmd (Api.aor_list AorListReturnedByApi { sortBy = Nothing })
                , E.map Callsigns CallsignsTables.initLoad
                ]

        Nothing ->
            E.batch
                [ E.getModulations ModulationsReturnedByApi
                , E.sendCmd (Api.aor_list AorListReturnedByApi { sortBy = Nothing })
                ]
    )



-- UPDATE


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        Descriptions descrMsg ->
            let
                ( m1, descrEff ) =
                    Descriptions.update shared descrMsg model
            in
            ( m1, E.map Descriptions descrEff )

        Frequencies freqsMsg ->
            let
                ( m1, freqsEff ) =
                    FrequenciesTable.update shared freqsMsg model

                loadCatalogCallsigns =
                    case ( FrequenciesTable.doNeedReloadCatalogCallsigns freqsMsg, m1.network ) of
                        ( True, Success network ) ->
                            E.map Callsigns <| CallsignsTables.loadCatalogCallsigns network.id

                        _ ->
                            E.none
            in
            ( m1, E.batch [ E.map Frequencies freqsEff, loadCatalogCallsigns ] )

        Callsigns callsMsg ->
            let
                ( m1, callsEff ) =
                    CallsignsTables.update shared callsMsg model
            in
            ( m1, E.map Callsigns callsEff )

        NetworkReturnedByApi (Err e) ->
            ( { model | network = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мережі" e
            )

        NetworkReturnedByApi (Ok res) ->
            let
                kindSelect =
                    model.editKindSelect

                postsSelect =
                    model.editPostsSelect

                unitsSelect =
                    model.editUnitsSelect

                --kindSelect2 =
                --TODO{ kindSelect | selected = EUtils.networkKindFromString res.kind }
                postsSelect2 =
                    { postsSelect | selected = res.postIds }

                unitsSelect2 =
                    { unitsSelect | selected = Maybe.withDefault [] res.unitIds }

                -- set AOR selection items if list is loaded
                editAorSelect2 =
                    case model.aorList of
                        Success aors ->
                            let
                                sel0 =
                                    model.editAorSelect
                            in
                            { state = sel0.state
                            , items = List.map (\a -> Select.basicMenuItem { item = a.id, label = a.name }) aors
                            , selected = res.aorIds
                            }

                        _ ->
                            model.editAorSelect
            in
            ( { model
                | network = Success res
                , editKindSelect = kindSelect
                , editPostsSelect = postsSelect2
                , editUnitsSelect = unitsSelect2
                , editAorSelect = editAorSelect2
              }
            , E.batch
                ([ case res.activeFrom of
                    Just activeFrom ->
                        E.getNetworkPoints MapPointsReturnedByApi
                            { networkId = res.id
                            , sinceDateInclusiveMs = activeFrom
                            , tillDateNoninclusiveMs = res.activeTo
                            }

                    Nothing ->
                        E.none
                 , E.getSingleNetworkGroupsActivity GroupsActivityReturnedByApi { networkId = res.id, tillDateNoninclusiveMs = Nothing }

                 --TODO: do not load if loaded already
                 , E.loadPostsFromShared { sortBy = Nothing }
                 , E.getSignalsForNetwork SignalsForNetworkLoaded { networkId = res.id }
                 ]
                    ++ (FrequenciesTable.loadFreqsInit res.id |> List.map (E.map Frequencies))
                    ++ (CallsignsTables.loadCatalogAndNetworkCallsigns res.id |> List.map (E.map Callsigns))
                )
            )

        MapPointsReturnedByApi (Err e) ->
            ( { model | mapPoints = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок мережі" e
            )

        MapPointsReturnedByApi (Ok res) ->
            ( { model | mapPoints = Success res.points }, E.none )

        GroupsActivityReturnedByApi (Err e) ->
            ( { model | groupsActivity = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності мережі" e
            )

        GroupsActivityReturnedByApi (Ok res) ->
            ( { model | groupsActivity = Success res }, E.none )

        AorListReturnedByApi (Ok aors) ->
            let
                items =
                    aors |> List.map (\a -> Select.basicMenuItem { item = a.id, label = a.name })

                sel =
                    model.editAorSelect
            in
            ( { model | aorList = Success aors, editAorSelect = { sel | items = items } }, E.none )

        AorListReturnedByApi (Err e) ->
            ( { model | aorList = Failure e }, E.none )

        NetworkEditStartedByUser ->
            case model.network of
                Success network ->
                    ( { model
                        | mode =
                            Editing
                                { id = network.id
                                , name = network.name
                                , location = network.location
                                , radioStation = network.radioStation
                                , purpose = network.purpose
                                , operationMode = network.operationMode
                                , operationType = network.operationType
                                , operationPeriod = network.operationPeriod
                                , descriptions = Nothing --TODO
                                , restoreNetwork = Nothing
                                , areaOfResponsibilityIds = Nothing
                                }
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        NetworkEditingSavedByUser ->
            case model.mode of
                Editing edit ->
                    ( model, E.updateNetworkPosts (NetworkPostsUpdatedByApi edit) { networkId = edit.id, postIds = model.editPostsSelect.selected } )

                Readonly ->
                    ( model, E.none )

        NetworkEditingCanceledByUser ->
            ( { model | mode = Readonly }, E.none )

        NetworkEditingMsg updNetworkReq ->
            ( { model
                | mode =
                    case model.mode of
                        Editing _ ->
                            Editing updNetworkReq

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        MissingFieldsEditStartedByUser ->
            case model.network of
                Success network ->
                    ( { model
                        | missingFieldsMode =
                            Editing
                                { id = network.id
                                , name = network.name
                                , location = network.location
                                , radioStation = network.radioStation
                                , purpose = network.purpose
                                , operationMode = network.operationMode
                                , operationType = network.operationType
                                , operationPeriod = network.operationPeriod
                                , descriptions = Nothing
                                , restoreNetwork = Nothing
                                , areaOfResponsibilityIds = Nothing
                                }
                        , editAorSelect =
                            let
                                items =
                                    case model.aorList of
                                        Success aors ->
                                            aors |> List.map (\a -> Select.basicMenuItem { item = a.id, label = a.name })

                                        _ ->
                                            []
                            in
                            let
                                sel0 =
                                    model.editAorSelect
                            in
                            { state = sel0.state
                            , items = items
                            , selected = network.aorIds
                            }
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        MissingFieldsEditSavedByUser ->
            case model.missingFieldsMode of
                Editing edit ->
                    ( { model | missingFieldsEditLoading = True }, E.updateNetworkPosts (NetworkPostsUpdatedByApi edit) { networkId = edit.id, postIds = model.editPostsSelect.selected } )

                Readonly ->
                    ( model, E.none )

        MissingFieldsEditCanceledByUser ->
            ( { model | missingFieldsMode = Readonly }, E.none )

        MissingFieldsEditingMsg updNetworkReq ->
            ( { model
                | missingFieldsMode =
                    case model.missingFieldsMode of
                        Editing _ ->
                            Editing updNetworkReq

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        NetworkPostsUpdatedByApi _ (Err e) ->
            ( { model | missingFieldsEditLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення постів мережі" e
            )

        NetworkPostsUpdatedByApi editState (Ok _) ->
            ( model, E.updateNetworkUnits (NetworkUnitsUpdatedByApi editState) { networkId = editState.id, unitIds = model.editUnitsSelect.selected } )

        NetworkUnitsUpdatedByApi editState (Ok _) ->
            let
                aorIds =
                    if List.isEmpty model.editAorSelect.selected then
                        Nothing

                    else
                        Just model.editAorSelect.selected

                editWithAors =
                    { editState | areaOfResponsibilityIds = aorIds }
            in
            ( model, E.updateNetwork NetworkUpdatedByApi editWithAors )

        NetworkUnitsUpdatedByApi editState (Err e) ->
            ( { model | missingFieldsEditLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення підрозділів мережі" e
            )

        NetworkUpdatedByApi (Err e) ->
            ( { model | missingFieldsEditLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення мережі" e
            )

        NetworkUpdatedByApi (Ok network) ->
            ( { model | network = Success network, mode = Readonly, missingFieldsMode = Readonly, missingFieldsEditLoading = False }, E.none )

        MissingFieldsUpdatedByApi (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення полів мережі" e
            )

        MissingFieldsUpdatedByApi (Ok network) ->
            ( { model | network = Success network, missingFieldsMode = Readonly }, E.none )

        EditNetworkKindSelMsg imsg ->
            case model.mode of
                Editing updNetworkReq ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editKindSelect.state

                        updatedNetworkKind =
                            Utils.Select.singleUpdWithDefault mAct model.editKindSelect.selected

                        kindSelect =
                            model.editKindSelect

                        kindSelect2 =
                            { kindSelect
                                | state = imodel
                                , selected = updatedNetworkKind
                            }
                    in
                    ( { model
                        | editKindSelect = kindSelect2
                        , mode = Editing updNetworkReq --{ updNetworkReq | kind = EUtils.networkKindToString updatedNetworkKind }
                      }
                    , E.sendCmd <|
                        Cmd.map
                            EditNetworkKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
                    )

        NetworkEditPostsSelMsg imsg ->
            case model.missingFieldsMode of
                Editing editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editPostsSelect.state

                        updatedNetworkPosts =
                            Utils.Select.multiUpdI mAct model.editPostsSelect.selected

                        postsSelect =
                            model.editPostsSelect

                        --TODO: remove this hack
                        items =
                            case ( postsSelect.items, shared.posts ) of
                                ( [], Success posts ) ->
                                    if List.length (Dict.toList posts) > 0 then
                                        List.map (\post -> Select.basicMenuItem { item = post.id, label = post.name }) (Dict.values posts)

                                    else
                                        postsSelect.items

                                _ ->
                                    postsSelect.items

                        postsSelect2 =
                            { postsSelect
                                | state = imodel
                                , selected = updatedNetworkPosts
                                , items = items
                            }
                    in
                    ( { model
                        | editPostsSelect = postsSelect2
                        , missingFieldsMode = Editing editNetworkState
                      }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditPostsSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        NetworkEditUnitsSelMsg imsg ->
            case model.missingFieldsMode of
                Editing editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editUnitsSelect.state

                        updatedNetworkUnits =
                            Utils.Select.multiUpdI mAct model.editUnitsSelect.selected

                        unitsSelect =
                            model.editUnitsSelect

                        -- Always use shared.masterUnits for local filtering
                        items =
                            case shared.masterUnits of
                                Success units ->
                                    List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name }) (Dict.values units)

                                _ ->
                                    []

                        unitsSelect2 =
                            { unitsSelect
                                | state = imodel
                                , selected = updatedNetworkUnits
                                , items = items
                            }
                    in
                    ( { model
                        | editUnitsSelect = unitsSelect2
                        , missingFieldsMode = Editing editNetworkState
                      }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditUnitsSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        NetworkEditAorSelMsg imsg ->
            case model.missingFieldsMode of
                Editing editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editAorSelect.state

                        updatedAors =
                            Utils.Select.multiUpdI mAct model.editAorSelect.selected

                        items =
                            case model.aorList of
                                Success aors ->
                                    List.map (\a -> Select.basicMenuItem { item = a.id, label = a.name }) aors

                                _ ->
                                    []

                        aorSelect2 =
                            let
                                sel0 =
                                    model.editAorSelect
                            in
                            { state = imodel
                            , selected = updatedAors
                            , items = items
                            }
                    in
                    ( { model
                        | editAorSelect = aorSelect2
                        , missingFieldsMode = Editing editNetworkState
                      }
                    , E.sendCmd <| Cmd.map NetworkEditAorSelMsg icmd
                    )

                _ ->
                    ( model, E.none )

        SignalsForNetworkLoaded (Err e) ->
            ( { model | signals = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження сигналів" e
            )

        SignalsForNetworkLoaded (Ok res) ->
            ( { model | signals = Success res.signals }, E.none )

        ReportModalOpenedByUser ->
            ( { model | reportModalOpened = True }, E.none )

        ReportModalClosedByUser ->
            ( { model | reportModalOpened = False }, E.none )

        ReportDownloadClickedByUser ->
            case model.network of
                Success network ->
                    let
                        context =
                            { fromDate = model.reportFromDate.datePosix
                            , toDate = model.reportToDate.datePosix
                            , zone = Just shared.timeZone
                            , networkId = Just network.id
                            }

                        apiCall reportType ctx =
                            E.getNetworkReportBatch ReportDownloadReturnedByApi
                                { networkIds = [ network.id ]
                                , sortBy = Nothing
                                , etalonkaType = ReportConfig.toApiEtalonkaType reportType ctx
                                }
                    in
                    ( { model | reportDownloadInProgress = True }
                    , ReportUpdate.createReportDownloadEffect model.report context apiCall
                    )

                _ ->
                    ( model, E.none )

        ReportDownloadReturnedByApi result ->
            let
                context =
                    { fromDate = model.reportFromDate.datePosix
                    , toDate = model.reportToDate.datePosix
                    , zone = Just shared.timeZone
                    , networkId =
                        case model.network of
                            Success network ->
                                Just network.id

                            _ ->
                                Nothing
                    }

                updateDownloading isDownloading m =
                    { m | reportDownloadInProgress = isDownloading }
            in
            ReportUpdate.handleReportDownloadResponse result context updateDownloading model

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
                        { zone = Just shared.timeZone
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
                        { zone = Just shared.timeZone
                        , msg = imsg
                        , model = model.reportToDate
                        , toModel = \reportToDate -> { model | reportToDate = reportToDate }
                        , toMsg = ReportDateTimeToMsg
                        }
            in
            ( m2, eff2 )

        ModulationsReturnedByApi (Err e) ->
            ( { model | modulations = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження модуляцій" e
            )

        ModulationsReturnedByApi (Ok res) ->
            let
                modulationSelect =
                    model.freqEditModulationSelect

                updatedModulationSelect =
                    { modulationSelect
                        | items = List.map (\mod -> Select.basicMenuItem { item = mod.id, label = mod.name }) res
                    }

                freqCreateModulationSelect =
                    model.freqCreateModulationSelect

                updatedFreqCreateModulationSelect =
                    { freqCreateModulationSelect
                        | items = List.map (\mod -> Select.basicMenuItem { item = mod.id, label = mod.name }) res
                    }
            in
            ( { model
                | modulations = Success res
                , freqEditModulationSelect = updatedModulationSelect
                , freqCreateModulationSelect = updatedFreqCreateModulationSelect
              }
            , E.none
            )

        DeleteNetworkClickedByUser ->
            case model.network of
                Success network ->
                    ( { model | deleteNetworkConfirmation = Just network.id }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        DeleteNetworkConfirmedByUser ->
            case model.deleteNetworkConfirmation of
                Just networkId ->
                    ( { model | deleteNetworkLoading = True, deleteNetworkConfirmation = Nothing }
                    , E.deleteNetwork DeleteNetworkReturnedByApi { networkId = networkId }
                    )

                Nothing ->
                    ( model, E.none )

        DeleteNetworkCanceledByUser ->
            ( { model | deleteNetworkConfirmation = Nothing }
            , E.none
            )

        DeleteNetworkReturnedByApi (Err e) ->
            ( { model | deleteNetworkLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення мережі" e
            )

        DeleteNetworkReturnedByApi (Ok _) ->
            ( { model | deleteNetworkLoading = False }
            , E.pushRoute { path = Route.Path.RerNetworks, hash = Nothing, query = Dict.empty }
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


contentBlock : Auth.User -> Shared.Model -> B.Network -> Model -> List (Html Msg)
contentBlock user shared network model =
    [ div [ class "flex justify-between items-center mb-[16px]" ]
        [ h2 []
            [ NetworksUtils.renderNetworkNameWithoutType network (RD.withDefault Dict.empty shared.masterUnits)
            ]
        , div [ class "flex gap-[8px]" ]
            [ Button.new { label = "Звіт \"Еталонка\"", onClick = ReportModalOpenedByUser } |> Button.view
            , if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
                Button.new { label = "Видалити", onClick = DeleteNetworkClickedByUser }
                    |> Button.withStyleDanger
                    |> Button.view

              else
                text ""
            ]
        ]
    , div [ class "grid grid-cols-12 gap-[30px]" ]
        [ div [ class "col-span-7 flex flex-col gap-[16px]" ] <|
            NetworkInfo.view network model user shared
        , div [ class "col-span-5 flex flex-col gap-[16px] h-full" ]
            [ div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col h-[250px]" ]
                [ h4 [] [ text "Пеленги" ]
                , let
                    mapPoints =
                        case model.mapPoints of
                            Success points ->
                                points

                            _ ->
                                []
                  in
                  if List.length mapPoints > 0 then
                    Html.node "small-map"
                        [ property "points" (Encode.list B.networkPointEncoder mapPoints)
                        , class "flex-1"
                        , property "withExitButton" (Encode.bool False)
                        ]
                        []

                  else
                    div [ class "flex-1 flex justify-center items-center" ] [ text "Пеленги відсутні" ]
                ]
            , Html.map Descriptions <| Descriptions.view network model user shared
            ]
        ]
    , Html.map Frequencies <| FrequenciesTable.view model user shared
    , Html.map Callsigns <| CallsignsTables.view model user shared
    ]


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Мережа"
    , body =
        [ div []
            [ div [ class "bg-[#F5F7F9] dark:bg-[#0E0E11] rer-network min-h-sceen" ]
                [ div [ class "w-[85vw] mx-auto py-[16px]" ]
                    (case model.network of
                        Success network ->
                            contentBlock user shared network model
                                --TODO: виглядає тупо, ми в сайдбар ТРУ передаємо завжди
                                ++ (if model.confirmationCreateSidebar then
                                        [ Html.map Descriptions <| Descriptions.confirmationCreateSidebar network model user shared ]

                                    else
                                        []
                                   )
                                ++ (if model.signsCreateSidebar then
                                        [ Html.map Descriptions <| Descriptions.signsCreateSidebar network model user shared ]

                                    else
                                        []
                                   )
                                ++ (if model.editDescriptionSidebar /= Nothing then
                                        case model.editDescriptionSidebar of
                                            Just ( _, description ) ->
                                                [ Html.map Descriptions <|
                                                    Descriptions.descriptionEditCloseSidebar description
                                                        network
                                                        model
                                                        user
                                                        shared
                                                ]

                                            Nothing ->
                                                []

                                    else
                                        []
                                   )

                        _ ->
                            [ div [ class "h-full" ] [ Shared.Components.Spinner.loadingSpinner ] ]
                    )
                , Html.map Callsigns <| CallsignsTables.createCallsignsSidebar model user shared
                , Html.map Callsigns <| CallsignsTables.editCallsignsSidebar model user shared
                , Html.map Callsigns <| CallsignsTables.deleteCallsignModal model
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
                        , showDateRange = True -- Показуємо дати для розширеного звіту
                        }

                    modalConfig =
                        { isOpen = model.reportModalOpened
                        , onClose = ReportModalClosedByUser
                        , onDownload = ReportDownloadClickedByUser
                        , isDownloading = model.reportDownloadInProgress
                        , reportType = model.report
                        , reportFormConfig = reportFormConfig
                        , title = "Звіт \"Еталонка\""
                        , description = "Еталонка для мережі"
                        }
                  in
                  ReportModal.view modalConfig
                , let
                    deleteDialogContent =
                        [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                            [ div [ class "pb-12" ]
                                [ h2 [] [ text "Видалити мережу" ]
                                , p [] [ text "Ви впевнені, що хочете видалити цю мережу?" ]
                                ]
                            , div [ class "flex justify-between" ]
                                [ Button.new { label = "Скасувати", onClick = DeleteNetworkCanceledByUser } |> Button.withStyleSecondary |> Button.view
                                , Button.new { label = "Видалити", onClick = DeleteNetworkConfirmedByUser }
                                    |> Button.withStyleDanger
                                    |> (if model.deleteNetworkLoading then
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
                  in
                  ModalDialog.modalDialog (model.deleteNetworkConfirmation /= Nothing) DeleteNetworkCanceledByUser [] deleteDialogContent
                , Html.map Frequencies <| FrequenciesTable.editSidebar model user shared
                , Html.map Frequencies <| FrequenciesTable.createSidebar model user shared
                , Html.map Frequencies <| FrequenciesTable.deleteFreqConfirmationModal model
                , Html.map Frequencies <| FrequenciesTable.freqActivityChartDetailed model shared
                , Html.map Descriptions <| Descriptions.viewDeleteConfirmation model
                ]
            ]
        ]
    }
