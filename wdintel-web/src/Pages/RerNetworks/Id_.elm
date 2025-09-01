module Pages.RerNetworks.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Components.ModalDialog as ModalDialog
import Components.Pager as Pager
import Components.SegmentedControl as SegmentedControl
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Components.Table.Sorter as TableSorter
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
import Le.Auth
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Popup as Popup
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Le.Utils exposing (networkKindVHFMapping)
import List.Extra as ListX
import Page exposing (Page)
import RerNetworks.Id_.CallsignsTables as CallsignsTables exposing (getDevelopingCallsigns, getRegularCallsigns)
import RerNetworks.Id_.Descriptions as Descriptions
import RerNetworks.Id_.FrequenciesTable as FrequenciesTable
import RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), ShowAllPopupFor(..))
import RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import RerNetworks.Id_.NetworkInfo as NetworkInfo
import RerNetworks.Utils as IdUtils
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import Url.Builder
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
      , reportNetworksOnly = False
      , reportActiveFreqsOnly = True
      , reportIncludePelengsMap = True
      , reportIncludeSigintSigns = True
      , reportIncludeConfirmation = True
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
            in
            ( m1, E.map Frequencies freqsEff )

        Callsigns callsMsg ->
            let
                ( m1, callsEff ) =
                    CallsignsTables.update shared callsMsg model
            in
            ( m1, E.map Callsigns callsEff )

        NetworkReturnedByApi (Err e) ->
            ( { model | network = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мережі" e
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
                    ++ (CallsignsTables.getCatalogAndNetworkCallsigns res.id |> List.map (E.map Callsigns))
                )
            )

        MapPointsReturnedByApi (Err e) ->
            ( { model | mapPoints = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження точок мережі" e
            )

        MapPointsReturnedByApi (Ok res) ->
            ( { model | mapPoints = Success res.points }, E.none )

        GroupsActivityReturnedByApi (Err e) ->
            ( { model | groupsActivity = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності мережі" e
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення постів мережі" e
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення підрозділів мережі" e
            )

        NetworkUpdatedByApi (Err e) ->
            ( { model | missingFieldsEditLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення мережі" e
            )

        NetworkUpdatedByApi (Ok network) ->
            ( { model | network = Success network, mode = Readonly, missingFieldsMode = Readonly, missingFieldsEditLoading = False }, E.none )

        MissingFieldsUpdatedByApi (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення полів мережі" e
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
                            Le.Block.Select.singleUpdWithDefault mAct model.editKindSelect.selected

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
                            Le.Block.Select.multiUpdI mAct model.editPostsSelect.selected

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
                            Le.Block.Select.multiUpdI mAct model.editUnitsSelect.selected

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
                            Le.Block.Select.multiUpdI mAct model.editAorSelect.selected

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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження сигналів" e
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
                    ( { model | reportDownloadInProgress = True }
                    , E.getNetworkReportBatch ReportDownloadReturnedByApi
                        { networkIds = [ network.id ]
                        , sortBy = Nothing
                        , settings =
                            { networksOnly = model.reportNetworksOnly
                            , activeFreqsOnly = model.reportActiveFreqsOnly
                            , includePelengsMap = model.reportIncludePelengsMap
                            , includeSigintSigns = model.reportIncludeSigintSigns
                            , includeConfirmation = model.reportIncludeConfirmation
                            }
                        }
                    )

                _ ->
                    ( model, E.none )

        ReportDownloadReturnedByApi (Err e) ->
            ( { model | reportDownloadInProgress = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка генерації звіту" e
            )

        ReportDownloadReturnedByApi (Ok bytes) ->
            let
                m2 =
                    { model | reportDownloadInProgress = False }

                extension =
                    "docx"

                fname =
                    "etalonka_network_"
                        ++ (case model.network of
                                Success network ->
                                    String.fromInt network.id

                                _ ->
                                    "unknown"
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

        ReportNetworksOnlyCheckedByUser isChecked ->
            let
                -- When "Згідно форми" is selected, automatically disable pelengs map
                -- since backend doesn't support networks_only + include_pelengs_map
                -- When unchecked, restore default values for better UX
                updatedModel =
                    if isChecked then
                        { model | reportIncludePelengsMap = False }

                    else
                        { model
                            | reportIncludePelengsMap = True
                            , reportIncludeSigintSigns = True
                            , reportIncludeConfirmation = True
                        }
            in
            ( { updatedModel | reportNetworksOnly = isChecked }, E.none )

        ReportActiveFreqsOnlyCheckedByUser isChecked ->
            ( { model | reportActiveFreqsOnly = isChecked }, E.none )

        ReportIncludePelengsMapCheckedByUser isChecked ->
            let
                -- If user tries to enable pelengs map, automatically disable "Згідно форми"
                -- since backend doesn't support this combination
                -- If user disables pelengs map, automatically enable "Згідно форми" for better UX
                updatedModel =
                    if isChecked && model.reportNetworksOnly then
                        { model | reportNetworksOnly = False }

                    else if not isChecked && not model.reportNetworksOnly then
                        { model | reportNetworksOnly = True }

                    else
                        model
            in
            ( { updatedModel | reportIncludePelengsMap = isChecked }, E.none )

        ReportIncludeConfirmationCheckedByUser isChecked ->
            ( { model | reportIncludeConfirmation = isChecked }, E.none )

        ReportIncludeSigintSignsCheckedByUser isChecked ->
            ( { model | reportIncludeSigintSigns = isChecked }, E.none )

        ModulationsReturnedByApi (Err e) ->
            ( { model | modulations = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження модуляцій" e
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення мережі" e
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
            , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
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
                            [ div [ class "h-full" ] [ Le.Block.Spinner.loadingSpinner ] ]
                    )
                , Html.map Callsigns <| CallsignsTables.createCallsignsSidebar model user shared
                , Html.map Callsigns <| CallsignsTables.editCallsignsSidebar model user shared
                , Html.map Callsigns <| CallsignsTables.deleteCallsignModal model
                , let
                    dialogContent =
                        [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                            [ div [ class "pb-12" ]
                                [ h2 [] [ text "Звіт \"еталонка\"" ]
                                , p [] [ text "Еталонка для мережі" ]
                                , div [ class "grid grid-cols-2 gap-[8px] h-[80px]" ]
                                    [ Checkbox.new { isChecked = model.reportNetworksOnly, onToggle = ReportNetworksOnlyCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Згідно форми" ] ]
                                        |> Checkbox.view
                                    , Checkbox.new { isChecked = model.reportActiveFreqsOnly, onToggle = ReportActiveFreqsOnlyCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Лише активні частоти" ] ]
                                        |> Checkbox.view
                                    , Checkbox.new { isChecked = model.reportIncludePelengsMap, onToggle = ReportIncludePelengsMapCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Включити карту пеленгів" ] ]
                                        |> Checkbox.withDisabled model.reportNetworksOnly
                                        |> Checkbox.view
                                    , Checkbox.new { isChecked = model.reportIncludeSigintSigns, onToggle = ReportIncludeSigintSignsCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Додати сигнали" ] ]
                                        |> Checkbox.view
                                    , Checkbox.new { isChecked = model.reportIncludeConfirmation, onToggle = ReportIncludeConfirmationCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Додати підтвердження" ] ]
                                        |> Checkbox.view
                                    ]
                                , div [ class "text-xs text-gray-600 dark:text-gray-400 mt-2" ]
                                    [ text "Якщо вибрано \"Згідно форми\", то карта пеленгів недоступна." ]
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
