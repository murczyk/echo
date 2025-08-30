module Pages.RerNetworks.Id_ exposing (Model, Msg, page)

import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Components.ModalDialog as ModalDialog
import Components.Pager as Pager
import RerNetworks.Id_.CallsignsTables as CallsignsTables exposing (getRegularCallsigns, getDevelopingCallsigns)
import Components.SegmentedControl as SegmentedControl
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Components.Table.Sorter as TableSorter
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import RerNetworks.Id_.Utils as IdUtils
import File.Download as Download
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Keyed
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import Le.Auth
import Api
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
import RerNetworks.Id_.Model as Types exposing (Mode(..), CallsignTableRow, FreqActivityFilter(..), ShowAllPopupFor(..), CallsignCreateMode(..))
import RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import RerNetworks.Id_.FrequenciesTable as FreqsTable

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






-- Navigation helper function





-- Generate query state for RER analysis with network date range and callsign filter





-- INIT


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
                , E.sendCmd (Api.sigint_list_sources GotSources ())
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
        CallsignsReturnedByApi (Err e) ->
            ( { model | callsigns = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" e
            )

        CallsignsReturnedByApi (Ok res) ->
            let
                -- Обчислюємо загальну кількість позивних для пагінації
                totalCallsigns =
                    res.callsigns
                        |> List.concatMap
                            (\callsign ->
                                case callsign.knownCallsigns of
                                    Just knownCallsigns ->
                                        knownCallsigns

                                    Nothing ->
                                        []
                            )
                        |> List.length

                updatedPager =
                    Pager.updateForNewTotalItems totalCallsigns model.callsignsPager
            in
            ( { model
                | callsigns = Success res.callsigns
                , callsignsPager = updatedPager
              }
            , E.none
            )

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
                [ E.getNetworkCallsigns CallsignsReturnedByApi { networkId = res.id }
                , E.getNetworkCallsignsList NetworkCallsignsReturnedByApi { networkId = res.id, sortBy = Nothing }
                , E.getNetworkPoints MapPointsReturnedByApi
                    { networkId = res.id
                    , sinceDateInclusiveMs = res.activeFrom
                    , tillDateNoninclusiveMs = res.activeTo
                    }
                , E.getSingleNetworkGroupsActivity GroupsActivityReturnedByApi { networkId = res.id, tillDateNoninclusiveMs = Nothing }
                , E.getNetworkFreqsActivity NetworkFreqsActivityReturnedByApi { networkId = res.id }
                , E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = res.id }

                --TODO: do not load if loaded already
                , E.loadPostsFromShared { sortBy = Nothing }
                , E.getSignalsForNetwork SignalsForNetworkLoaded { networkId = res.id }
                ]
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

        NetworkFreqsActivityReturnedByApi (Err e) ->
            ( { model | networkFreqsActivity = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження активності частот мережі" e
            )

        NetworkFreqsActivityReturnedByApi (Ok res) ->
            ( { model | networkFreqsActivity = Success res }, E.none )

        FreqsReturnedByApi (Err e) ->
            ( { model | freqs = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження частот" e
            )

        FreqsReturnedByApi (Ok res) ->
            let
                callsigns =
                    List.filterMap .callsigns res.freqs
                        |> List.concat

                addConfirmationFreqSelect =
                    model.addConfirmationFreqSelect

                acfs2 =
                    { addConfirmationFreqSelect | items = List.map .freq res.freqs |> List.map (\freq -> Select.basicMenuItem { item = freq, label = freq }) }
            in
            ( { model | freqs = Success res.freqs, addConfirmationFreqSelect = acfs2 }, E.getCallsignsInfoShared callsigns )

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

        CallsignsPopupOpenedByUser freq ->
            ( { model | callsignsOpenedPopupId = Just freq }, E.none )

        CallsignsPopupClosedByUser ->
            ( { model | callsignsOpenedPopupId = Nothing }, E.none )

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

        DescriptionAddClickedByUser networkId descType ->
            let
                desc =
                    case ( descType, model.addConfirmationFreqSelect.selected ) of
                        ( B.Confirmation, Just freq ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                []
                            , frequencyDescriptions =
                                [ { descrType = B.Confirmation
                                  , description = model.addConfirmationInp
                                  , freq = freq
                                  }
                                ]
                            }

                        ( B.Confirmation, Nothing ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                [ { descrType = B.Confirmation
                                  , description = model.addConfirmationInp
                                  }
                                ]
                            , frequencyDescriptions =
                                []
                            }

                        ( B.Sign, _ ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                [ { descrType = B.Sign
                                  , description = model.addSignsInp
                                  }
                                ]
                            , frequencyDescriptions =
                                []
                            }
            in
            ( model
            , E.networkAddDescription (NetworkDescriptionAdded descType) desc
            )

        NetworkDescriptionAdded _ (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання опису мережі" e
            )

        NetworkDescriptionAdded descType (Ok network) ->
            let
                m1 =
                    { model
                        | addConfirmationInp =
                            case descType of
                                B.Confirmation ->
                                    ""

                                B.Sign ->
                                    model.addConfirmationInp
                        , addSignsInp =
                            case descType of
                                B.Confirmation ->
                                    model.addSignsInp

                                B.Sign ->
                                    ""
                        , confirmationCreateSidebar = False
                        , signsCreateSidebar = False
                    }
            in
            ( { m1 | network = Success network }, E.none )

        ConfirmationInputChangedByUser inp ->
            ( { model | addConfirmationInp = inp }, E.none )

        SignsInputChangedByUser inp ->
            ( { model | addSignsInp = inp }, E.none )

        SignalsForNetworkLoaded (Err e) ->
            ( { model | signals = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження сигналів" e
            )

        SignalsForNetworkLoaded (Ok res) ->
            ( { model | signals = Success res.signals }, E.none )

        DescriptionDeleteClickedByUser description ->
            ( { model | deleteDescriptionConfirmation = Just description }, E.none )

        DescriptionEditClickedByUser description ->
            let
                freqItems =
                    case model.freqs of
                        Success freqs ->
                            List.map .freq freqs |> List.map (\freq -> Select.basicMenuItem { item = freq, label = freq })

                        _ ->
                            []
            in
            ( { model
                | editDescriptionSidebar = Just ( description.id, description )
                , editDescriptionInp = description.description
                , editDescriptionFreqSelect =
                    { state = model.editDescriptionFreqSelect.state
                    , items = freqItems
                    , selected = Nothing
                    }
              }
            , E.none
            )

        DescriptionEditSave description ->
            let
                -- Use the current input from the sidebar
                updatedDescription =
                    model.editDescriptionInp

                -- Get selected frequency if any
                selectedFreq =
                    model.editDescriptionFreqSelect.selected

                -- Find the frequency ID if a frequency is selected
                networkFreqId =
                    case selectedFreq of
                        Just freq ->
                            case model.freqs of
                                Success freqs ->
                                    ListX.find (\f -> f.freq == freq) freqs
                                        |> Maybe.map .networkFreqId

                                _ ->
                                    Nothing

                        Nothing ->
                            Nothing
            in
            ( { model | editDescriptionSidebar = Nothing }
            , E.networkUpdateDescription (DescriptionEditUpdated description.id)
                { networkId = description.networkId
                , descriptionId = description.id
                , descrType = description.descrType
                , description = updatedDescription
                , networkFreqId = networkFreqId
                }
            )

        DescriptionEditUpdated _ (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення опису мережі" e
            )

        DescriptionEditUpdated descrId (Ok res) ->
            ( { model | network = Success res }, E.none )

        DescriptionDeleted (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення опису мережі" e
            )

        DescriptionDeleted (Ok res) ->
            ( { model | network = Success res }, E.none )

        AddConfirmationFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.addConfirmationFreqSelect.state

                updatedFreq =
                    Le.Block.Select.singleUpd mAct model.addConfirmationFreqSelect.selected

                freqsSelect =
                    model.addConfirmationFreqSelect

                freqsSelect2 =
                    { freqsSelect
                        | state = imodel
                        , selected = updatedFreq
                    }
            in
            ( { model
                | addConfirmationFreqSelect = freqsSelect2
              }
            , E.sendCmd <|
                Cmd.map
                    AddConfirmationFreqSelMsg
                    icmd
            )

        FreqsEditStartedByUser ->
            case ( model.freqs, model.network ) of
                ( Success freqs, Success network ) ->
                    let
                        editFreqsDict =
                            List.map
                                (\f ->
                                    ( f.freq
                                    , { networkId = network.id
                                      , freq = f.freq
                                      , kind = Maybe.withDefault "VHF" f.kind
                                      , modulationId = f.modulationId
                                      , activeFrom = f.activeFrom
                                      , activeTo = f.activeTo
                                      }
                                    )
                                )
                                freqs
                                |> Dict.fromList
                    in
                    ( { model
                        | freqsEditingState =
                            Editing editFreqsDict
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        FreqsEditSavedByUser ->
            let
                compareTwoFreqs : B.UpdateNetworkFreqReq -> B.NetworkFreqsRes -> Bool
                compareTwoFreqs updateReq originalFreq =
                    updateReq.freq
                        == originalFreq.freq
                        && updateReq.activeFrom
                        == originalFreq.activeFrom
                        && updateReq.activeTo
                        == originalFreq.activeTo

                ( m1, eff1 ) =
                    case model.freqsEditingState of
                        Editing editingDict ->
                            let
                                effects =
                                    Dict.toList editingDict
                                        |> List.map Tuple.second
                                        |> List.filterMap
                                            (\updateFreqReq ->
                                                case model.freqs of
                                                    Success freqs ->
                                                        ListX.find (\f -> f.freq == updateFreqReq.freq) freqs
                                                            |> Maybe.andThen
                                                                (\originalFreq ->
                                                                    if compareTwoFreqs updateFreqReq originalFreq then
                                                                        Nothing

                                                                    else
                                                                        Just updateFreqReq
                                                                )

                                                    _ ->
                                                        Nothing
                                            )
                                        |> List.map (\updateFreqReq -> E.updateNetworkFreq FreqUpdatedByApi updateFreqReq)
                            in
                            ( { model
                                | freqsEditingState =
                                    if List.length effects > 0 then
                                        model.freqsEditingState

                                    else
                                        Readonly
                              }
                            , E.batch effects
                            )

                        Readonly ->
                            ( model, E.none )
            in
            ( m1
            , eff1
            )

        FreqsEditCanceledByUser ->
            ( { model | freqsEditingState = Readonly }, E.none )

        FreqsEditingMsg updFreqState ->
            ( { model
                | freqsEditingState =
                    case model.freqsEditingState of
                        Editing editingFreqsDict ->
                            Editing (Dict.insert updFreqState.freq updFreqState editingFreqsDict)

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        FreqUpdatedByApi (Err e) ->
            ( { model | freqEditSaving = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення частоти" e
            )

        FreqUpdatedByApi (Ok network) ->
            ( { model
                | network = Success network
                , freqsEditingState = Readonly
                , freqEditSaving = False
                , freqEditSidebar = Nothing
              }
            , E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = network.id }
            )

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

        FreqsActivityFilterChangedByUser filter ->
            ( { model | freqsActivityFilter = filter }, E.none )

        SetFreqsTableState newState ->
            ( { model | freqsTableState = newState }, E.none )

        SetCallsignsTableState newState ->
            ( { model | callsignsTableState = newState }, E.none )

        NetworkCallsignsReturnedByApi (Err e) ->
            ( { model | networkCallsigns = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних мережі" e
            )

        NetworkCallsignsReturnedByApi (Ok res) ->
            ( { model
                | networkCallsigns = Success res.networkCallsigns
                , networkCallsignsPager = Pager.updateForNewTotalItems (List.length (getRegularCallsigns res.networkCallsigns)) (Pager.initWithPageSize 5)
              }
            , E.none
            )

        SetNetworkCallsignsTableState newState ->
            ( { model | networkCallsignsTableState = newState }, E.none )

        NetworkCallsignsPagerMsg pagerMsg ->
            let
                updatedPager =
                    Pager.update pagerMsg model.networkCallsignsPager

                -- Якщо змінюється розмір сторінки, перевіряємо поточну сторінку
                finalPager =
                    case pagerMsg of
                        Pager.ChangePageSize newPageSize ->
                            Pager.updateForNewTotalItems updatedPager.totalItems { updatedPager | pageSize = newPageSize }

                        _ ->
                            updatedPager
            in
            ( { model | networkCallsignsPager = finalPager }, E.none )

        CallsignsPagerMsg pagerMsg ->
            let
                updatedPager =
                    Pager.update pagerMsg model.callsignsPager

                -- Якщо змінюється розмір сторінки, перевіряємо поточну сторінку
                finalPager =
                    case pagerMsg of
                        Pager.ChangePageSize newPageSize ->
                            Pager.updateForNewTotalItems updatedPager.totalItems { updatedPager | pageSize = newPageSize }

                        _ ->
                            updatedPager
            in
            ( { model | callsignsPager = finalPager }, E.none )

        OpenFreqEditSidebar freqId updateReq ->
            let
                -- Оновлюємо селекти з даними з частоти
                kindSelect =
                    model.freqEditKindSelect

                updatedKindSelect =
                    { kindSelect | selected = NetworksUtils.networkKindFromString updateReq.kind }

                modulationSelect =
                    model.freqEditModulationSelect

                updatedModulationSelect =
                    { modulationSelect | selected = updateReq.modulationId }

                -- Встановлюємо freqEditShowActiveTo на основі того, чи є activeTo
                showActiveTo =
                    updateReq.activeTo /= Nothing
            in
            ( { model
                | freqEditSidebar = Just ( freqId, updateReq )
                , freqEditKindSelect = updatedKindSelect
                , freqEditModulationSelect = updatedModulationSelect
                , freqEditShowActiveTo = showActiveTo
              }
            , E.none
            )

        CloseFreqEditSidebar ->
            ( { model | freqEditSidebar = Nothing, freqEditShowActiveTo = False }, E.none )

        UpdateFreqEditSidebar updateReq ->
            ( { model | freqEditSidebar = Maybe.map (\( freqId, _ ) -> ( freqId, updateReq )) model.freqEditSidebar }, E.none )

        SaveFreqEditSidebar ->
            case model.freqEditSidebar of
                Just ( _, updateReq ) ->
                    ( { model | freqEditSaving = True }
                    , E.updateNetworkFreq FreqUpdatedByApi updateReq
                    )

                Nothing ->
                    ( model, E.none )

        OpenFreqDetailPopup freqId ->
            ( { model | freqDetailPopup = Just freqId }, E.none )

        CloseFreqDetailPopup ->
            ( { model | freqDetailPopup = Nothing }, E.none )

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

        GotSources (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел" err
            )

        GotSources (Ok rsp) ->
            ( { model | callsignCreateSources = rsp.sources }
            , E.none
            )

        FreqKindSelectMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.freqEditKindSelect.state

                updatedNetworkKind =
                    Le.Block.Select.singleUpdWithDefault mAct model.freqEditKindSelect.selected

                kindSelect =
                    model.freqEditKindSelect

                kindSelect2 =
                    { kindSelect
                        | state = imodel
                        , selected = updatedNetworkKind
                    }

                updatedSidebar =
                    case model.freqEditSidebar of
                        Just ( freqId, updateReq ) ->
                            Just ( freqId, { updateReq | kind = NetworksUtils.networkKindToString updatedNetworkKind } )

                        Nothing ->
                            model.freqEditSidebar
            in
            ( { model
                | freqEditKindSelect = kindSelect2
                , freqEditSidebar = updatedSidebar
              }
            , E.sendCmd <|
                Cmd.map
                    FreqKindSelectMsg
                    icmd
            )

        FreqModulationSelectMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.freqEditModulationSelect.state

                updatedModulationId =
                    Le.Block.Select.singleUpd mAct model.freqEditModulationSelect.selected

                modulationSelect =
                    model.freqEditModulationSelect

                modulationSelect2 =
                    { modulationSelect
                        | state = imodel
                        , selected = updatedModulationId
                    }

                updatedSidebar =
                    case model.freqEditSidebar of
                        Just ( freqId, updateReq ) ->
                            Just ( freqId, { updateReq | modulationId = updatedModulationId } )

                        Nothing ->
                            model.freqEditSidebar
            in
            ( { model
                | freqEditModulationSelect = modulationSelect2
                , freqEditSidebar = updatedSidebar
              }
            , E.sendCmd <|
                Cmd.map
                    FreqModulationSelectMsg
                    icmd
            )

        ToggleFreqEditShowActiveTo ->
            let
                newShowActiveTo =
                    not model.freqEditShowActiveTo

                updatedModel =
                    if not newShowActiveTo then
                        -- очистити activeTo при знятті чекбокса
                        case model.freqEditSidebar of
                            Just ( freqId, updateReq ) ->
                                let
                                    newUpdateReq =
                                        { updateReq | activeTo = Nothing }
                                in
                                { model | freqEditSidebar = Just ( freqId, newUpdateReq ) }

                            Nothing ->
                                model

                    else
                        model
            in
            ( { updatedModel | freqEditShowActiveTo = newShowActiveTo }
            , E.none
            )

        DeleteFreqClickedByUser freqId freqStr ->
            ( { model | deleteFreqConfirmation = Just ( freqId, freqStr ) }
            , E.none
            )

        DeleteFreqCanceledByUser ->
            ( { model | deleteFreqConfirmation = Nothing }
            , E.none
            )

        DeleteFreqConfirmedByUser ->
            case ( model.network, model.deleteFreqConfirmation ) of
                ( Success network, Just ( freqId, _ ) ) ->
                    ( { model | deleteFreqLoading = True, deleteFreqConfirmation = Nothing }
                    , E.removeFreqFromNetwork DeleteFreqReturnedByApi { id = Just freqId, networkId = Nothing, freq = Nothing }
                    )

                _ ->
                    ( model, E.none )

        DeleteFreqReturnedByApi (Err e) ->
            ( { model | deleteFreqLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення частоти" e
            )

        DeleteFreqReturnedByApi (Ok network) ->
            ( { model | deleteFreqLoading = False, network = Success network }
            , E.batch
                [ E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = network.id }
                , E.getNetworkFreqsActivity NetworkFreqsActivityReturnedByApi { networkId = network.id }
                ]
            )

        -- Network callsign creation messages
        OpenCallsignCreateSidebar ->
            case model.network of
                Success network ->
                    let
                        updatedState =
                            { networkId = network.id
                            , callsign = ""
                            , position = Nothing
                            , comment = Nothing
                            , sourceId = Nothing -- No default source ID
                            , radioFreq = Nothing
                            , developing = False
                            , unitId =
                                -- Автоматично встановлюємо перший підрозділ мережі
                                case model.editUnitsSelect.selected of
                                    firstUnitId :: _ ->
                                        Just firstUnitId

                                    [] ->
                                        Nothing
                            , unitDeveloping = False
                            , mainRadioStation = False
                            }
                    in
                    ( { model
                        | callsignCreateSidebar = Just CreateFromScratch
                        , callsignCreateState = Just updatedState
                        , callsignCreateErrors = Dict.empty
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        CloseCallsignCreateSidebar ->
            ( { model
                | callsignCreateSidebar = Nothing
                , callsignCreateState = Nothing
                , callsignCreateErrors = Dict.empty
                , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
              }
            , E.none
            )

        UpdateCallsignCreateField updateFunc ->
            ( { model | callsignCreateState = updateFunc model.callsignCreateState }
            , E.none
            )

        CreateCallsignClicked ->
            case model.callsignCreateState of
                Just createReq ->
                    ( { model | callsignCreateSaving = True }
                    , E.createNetworkCallsign CallsignCreated createReq
                    )

                Nothing ->
                    ( model, E.none )

        CallsignCreated (Ok networkCallsign) ->
            let
                -- Отримуємо callsign з створеного позивного
                createdCallsign =
                    networkCallsign.callsign

                -- Оновлюємо список "Приналежність встановлюється" - видаляємо створений позивний
                updatedCallsigns =
                    case model.callsigns of
                        Success existingCallsigns ->
                            existingCallsigns
                                |> List.filter (\callsignGroup -> callsignGroup.callsign /= createdCallsign)
                                |> Success

                        _ ->
                            model.callsigns

                -- Оновлюємо список позивних мережі
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success (networkCallsign :: existingCallsigns)

                        _ ->
                            Success [ networkCallsign ]

                -- Оновлюємо пагінацію
                updatedPager =
                    case updatedNetworkCallsigns of
                        Success callsigns ->
                            Pager.updateForNewTotalItems (List.length callsigns) model.networkCallsignsPager

                        _ ->
                            model.networkCallsignsPager
            in
            ( { model
                | callsignCreateSaving = False
                , callsignCreateSidebar = Nothing
                , callsignCreateState = Nothing
                , callsignCreateErrors = Dict.empty
                , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
                , networkCallsigns = updatedNetworkCallsigns
                , networkCallsignsPager = updatedPager
                , callsigns = updatedCallsigns
              }
            , E.none
            )

        CallsignCreated (Err error) ->
            ( { model
                | callsignCreateSaving = False
                , callsignCreateErrors = Dict.singleton "general" (Le.ErrorHandling.formatErrorForShowError "Помилка створення позивного" error)
              }
            , E.none
            )

        CallsignCreateSourceSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.callsignCreateSourceSelState

                updatedSourceId =
                    Le.Block.Select.singleUpd mAction (Maybe.andThen .sourceId model.callsignCreateState)
            in
            ( { model
                | callsignCreateSourceSelState = imodel2
                , callsignCreateState =
                    Maybe.map (\state -> { state | sourceId = updatedSourceId }) model.callsignCreateState
              }
            , E.sendCmd <| Cmd.map CallsignCreateSourceSelMsg icmd
            )

        CallsignCreateUnitSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.callsignCreateUnitSelState

                updatedUnitId =
                    Le.Block.Select.singleUpd mAction (Maybe.andThen .unitId model.callsignCreateState)

                -- Закриваємо селект тільки коли користувач дійсно вибрав підрозділ
                shouldCloseSelector =
                    case mAction of
                        Just (Select.Select _) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False
            in
            ( { model
                | callsignCreateUnitSelState = imodel2
                , callsignCreateUnitSelectorVisible =
                    if shouldCloseSelector then
                        False

                    else
                        model.callsignCreateUnitSelectorVisible
                , callsignCreateState =
                    Maybe.map (\state -> { state | unitId = updatedUnitId }) model.callsignCreateState
              }
            , E.sendCmd <| Cmd.map CallsignCreateUnitSelMsg icmd
            )

        ToggleCallsignCreateUnitSelector ->
            ( { model | callsignCreateUnitSelectorVisible = not model.callsignCreateUnitSelectorVisible }
            , E.none
            )

        ResetCallsignCreateUnit ->
            ( { model
                | callsignCreateUnitSelectorVisible = False
                , callsignCreateState =
                    Maybe.map
                        (\state ->
                            { state
                                | unitId =
                                    -- Повертаємо до першого підрозділу мережі
                                    case model.editUnitsSelect.selected of
                                        firstUnitId :: _ ->
                                            Just firstUnitId

                                        [] ->
                                            Nothing
                            }
                        )
                        model.callsignCreateState
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

        -- Frequency creation messages
        OpenFreqCreateSidebar ->
            ( { model | freqCreateSidebar = True }, E.none )

        CloseFreqCreateSidebar ->
            ( { model
                | freqCreateSidebar = False
                , freqCreateDescriptionInp = ""
                , freqCreateFormatError = Nothing
                , freqCreateShowActiveTo = False
                , freqCreateState =
                    { freq = ""
                    , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
                    , modulationId = Nothing
                    , description = Nothing
                    , activeFrom = Nothing
                    , activeTo = Nothing
                    }
              }
            , E.none
            )

        UpdateFreqCreateField updateFunc ->
            let
                newFreqState =
                    updateFunc model.freqCreateState

                formatError =
                    if String.trim newFreqState.freq == "" then
                        Nothing

                    else if not (NetworksUtils.validateFrequencyFormat newFreqState.freq) then
                        Just "Невірний формат частоти (наприклад: 146.5000)"

                    else
                        Nothing
            in
            ( { model
                | freqCreateState = newFreqState
                , freqCreateFormatError = formatError
              }
            , E.none
            )

        FreqCreateKindSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.freqCreateKindSelect.state

                updatedKind =
                    Le.Block.Select.singleUpdWithDefault mAct model.freqCreateKindSelect.selected

                newSelect =
                    { state = newState
                    , items = model.freqCreateKindSelect.items
                    , selected = updatedKind
                    }

                oldFreqState =
                    model.freqCreateState

                newFreqState =
                    { oldFreqState | kind = NetworksUtils.networkKindToString updatedKind }
            in
            ( { model | freqCreateKindSelect = newSelect, freqCreateState = newFreqState }
            , E.sendCmd <| Cmd.map FreqCreateKindSelectMsg selectCmd
            )

        FreqCreateModulationSelectMsg selectMsg ->
            let
                ( mAct, newState, selectCmd ) =
                    Select.update selectMsg model.freqCreateModulationSelect.state

                updatedModulation =
                    Le.Block.Select.singleUpd mAct model.freqCreateModulationSelect.selected

                newSelect =
                    { state = newState
                    , items = model.freqCreateModulationSelect.items
                    , selected = updatedModulation
                    }

                oldFreqState =
                    model.freqCreateState

                newFreqState =
                    { oldFreqState | modulationId = updatedModulation }
            in
            ( { model | freqCreateModulationSelect = newSelect, freqCreateState = newFreqState }
            , E.sendCmd <| Cmd.map FreqCreateModulationSelectMsg selectCmd
            )

        FreqCreateDescriptionInputChangedByUser inp ->
            ( { model | freqCreateDescriptionInp = inp }, E.none )

        ToggleFreqCreateShowActiveTo ->
            let
                newShowActiveTo =
                    not model.freqCreateShowActiveTo

                updatedFreqState =
                    if not newShowActiveTo then
                        -- очистити activeTo при знятті чекбокса
                        let
                            freqState =
                                model.freqCreateState
                        in
                        { freqState | activeTo = Nothing }

                    else
                        model.freqCreateState
            in
            ( { model
                | freqCreateShowActiveTo = newShowActiveTo
                , freqCreateState = updatedFreqState
              }
            , E.none
            )

        AddFreqToNetwork ->
            case model.network of
                Success network ->
                    let
                        -- Create description object if input is not empty
                        description =
                            if String.trim model.freqCreateDescriptionInp == "" then
                                Nothing

                            else
                                Just
                                    { descrType = B.Confirmation
                                    , description = model.freqCreateDescriptionInp
                                    , freq = model.freqCreateState.freq
                                    }

                        -- Create the API request payload
                        addFreqReq =
                            { networkId = network.id
                            , freqRec =
                                { freq = model.freqCreateState.freq
                                , kind = model.freqCreateState.kind
                                , modulationId = model.freqCreateState.modulationId
                                , description = description
                                , activeFrom = model.freqCreateState.activeFrom
                                , activeTo = model.freqCreateState.activeTo
                                }
                            }
                    in
                    ( { model | freqEditSaving = True }
                      -- Reuse existing loading state
                    , E.addFreqToNetwork FreqAddedToNetwork addFreqReq
                    )

                _ ->
                    ( model, E.none )

        FreqAddedToNetwork (Err e) ->
            ( { model | freqEditSaving = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання частоти до мережі" e
            )

        FreqAddedToNetwork (Ok network) ->
            ( { model
                | network = Success network
                , freqEditSaving = False
                , freqCreateSidebar = False
                , freqCreateDescriptionInp = ""
                , freqCreateFormatError = Nothing
                , freqCreateShowActiveTo = False
                , freqCreateState =
                    { freq = ""
                    , kind = NetworksUtils.networkKindToString NetworksUtils.VHF
                    , modulationId = Nothing
                    , description = Nothing
                    , activeFrom = Nothing
                    , activeTo = Nothing
                    }
              }
            , E.batch
                [ E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = network.id }
                , E.getNetworkFreqsActivity NetworkFreqsActivityReturnedByApi { networkId = network.id }
                ]
            )

        -- Callsign adding functionality
        AddCallsignToNetwork knownCallsignId ->
            -- Перевіряємо, чи не додається вже цей позивний
            if Set.member knownCallsignId model.callsignAddingInProgress then
                ( model, E.none )

            else
                case model.network of
                    Success network ->
                        let
                            payload =
                                { networkId = network.id
                                , knownCallsignIds = [ knownCallsignId ]
                                }
                        in
                        ( { model | callsignAddingInProgress = Set.insert knownCallsignId model.callsignAddingInProgress }
                        , E.addMultipleCallsignsToNetwork CallsignAddedToNetwork payload
                        )

                    _ ->
                        ( model, E.none )

        CallsignAddedToNetwork (Err e) ->
            ( { model | callsignAddingInProgress = Set.empty }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання позивного до мережі" e
            )

        CallsignAddedToNetwork (Ok networkCallsigns) ->
            let
                -- Оновлюємо networkCallsigns, додаючи нові
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existing ->
                            Success (existing ++ networkCallsigns)

                        _ ->
                            Success networkCallsigns

                -- Оновлюємо пагінацію для таблиці "Мережеві позивні"
                updatedPager =
                    case updatedNetworkCallsigns of
                        Success callsigns ->
                            Pager.updateForNewTotalItems (List.length callsigns) model.networkCallsignsPager

                        _ ->
                            model.networkCallsignsPager

                -- Оновлюємо модель
                updatedModel =
                    { model
                        | networkCallsigns = updatedNetworkCallsigns
                        , networkCallsignsPager = updatedPager
                        , callsignAddingInProgress = Set.empty
                    }

                -- Перезавантажуємо тільки таблицю "Всі позивні" для прибирання доданих позивних
                reloadEffect =
                    case model.network of
                        Success network ->
                            E.getNetworkCallsigns CallsignsReturnedByApi { networkId = network.id }

                        _ ->
                            E.none
            in
            ( updatedModel, reloadEffect )

        DeleteCallsignFromNetwork callsignId ->
            ( { model | deleteCallsignConfirmation = Just callsignId, developingCallsignDropdown = Nothing }, E.none )

        EditCallsignClicked callsignId ->
            case ( model.networkCallsigns, model.network ) of
                ( Success networkCallsigns, Success network ) ->
                    case ListX.find (\c -> c.id == callsignId) networkCallsigns of
                        Just callsign ->
                            let
                                editState =
                                    { id = callsign.id
                                    , networkId =
                                        network.id
                                    , callsign = String.toUpper callsign.callsign
                                    , position = callsign.position
                                    , comment = callsign.comment
                                    , sourceId = callsign.sourceId
                                    , radioFreq = callsign.radioFreq -- Тепер це окреме поле
                                    , developing = callsign.developing
                                    , unitId = callsign.unitId
                                    , unitDeveloping = callsign.unitDeveloping
                                    , mainRadioStation = callsign.mainRadioStation
                                    }
                            in
                            ( { model
                                | editCallsignSidebar = Just callsignId
                                , editCallsignState = Just editState
                                , editCallsignErrors = Dict.empty
                                , editCallsignSourceSelState = Select.initState (Select.selectIdentifier "callsign-edit-source-state")
                                , developingCallsignDropdown = Nothing -- Закриваємо dropdown
                              }
                            , E.none
                            )

                        Nothing ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        ToggleDevelopingCallsignDropdown callsignId ->
            let
                newDropdown =
                    if model.developingCallsignDropdown == Just callsignId then
                        Nothing

                    else
                        Just callsignId
            in
            ( { model | developingCallsignDropdown = newDropdown }, E.none )

        CloseDevelopingCallsignDropdown ->
            ( { model | developingCallsignDropdown = Nothing }, E.none )

        NavigateToCallsignPage callsignId ->
            ( { model | developingCallsignDropdown = Nothing }, E.none )

        ToggleUnknownCallsignDropdown callsign ->
            let
                newDropdown =
                    if model.unknownCallsignDropdown == Just callsign then
                        Nothing

                    else
                        Just callsign
            in
            ( { model | unknownCallsignDropdown = newDropdown }, E.none )

        CloseUnknownCallsignDropdown ->
            ( { model | unknownCallsignDropdown = Nothing }, E.none )

        DeleteCallsignConfirmed callsignId ->
            ( { model | deleteCallsignLoading = True, deleteCallsignConfirmation = Nothing }
            , E.deleteNetworkCallsign CallsignDeletedFromNetwork callsignId
            )

        DeleteCallsignCanceled ->
            ( { model | deleteCallsignConfirmation = Nothing }, E.none )

        CallsignDeletedFromNetwork (Ok deletedCallsign) ->
            let
                -- Видаляємо позивний зі списку networkCallsigns
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success (List.filter (\c -> c.id /= deletedCallsign.id) existingCallsigns)

                        _ ->
                            model.networkCallsigns

                -- Оновлюємо пагінацію та перевіряємо поточну сторінку
                updatedPager =
                    case updatedNetworkCallsigns of
                        Success callsigns ->
                            Pager.updateForNewTotalItems (List.length callsigns) model.networkCallsignsPager

                        _ ->
                            model.networkCallsignsPager

                -- Перезавантажуємо тільки таблицю "Всі позивні" для додавання видаленого позивного назад
                reloadEffect =
                    case model.network of
                        Success network ->
                            E.getNetworkCallsigns CallsignsReturnedByApi { networkId = network.id }

                        _ ->
                            E.none
            in
            ( { model
                | deleteCallsignLoading = False
                , networkCallsigns = updatedNetworkCallsigns
                , networkCallsignsPager = updatedPager
              }
            , reloadEffect
            )

        CallsignDeletedFromNetwork (Err error) ->
            ( { model | deleteCallsignLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення позивного з мережі" error
            )

        -- Edit callsign handlers
        CloseEditCallsignSidebar ->
            ( { model
                | editCallsignSidebar = Nothing
                , editCallsignState = Nothing
                , editCallsignErrors = Dict.empty
                , editCallsignSourceSelState = Select.initState (Select.selectIdentifier "callsign-edit-source-state")
              }
            , E.none
            )

        UpdateEditCallsignField updateFunc ->
            ( { model | editCallsignState = updateFunc model.editCallsignState }
            , E.none
            )

        SaveEditCallsignClicked ->
            case model.editCallsignState of
                Just updateReq ->
                    ( { model | editCallsignSaving = True }
                    , E.updateNetworkCallsign CallsignUpdated updateReq
                    )

                Nothing ->
                    ( model, E.none )

        CallsignUpdated (Ok updatedCallsign) ->
            let
                -- Update the callsign in networkCallsigns list
                updatedNetworkCallsigns =
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success
                                (List.map
                                    (\c ->
                                        if c.id == updatedCallsign.id then
                                            updatedCallsign

                                        else
                                            c
                                    )
                                    existingCallsigns
                                )

                        _ ->
                            model.networkCallsigns
            in
            ( { model
                | editCallsignSaving = False
                , editCallsignSidebar = Nothing
                , editCallsignState = Nothing
                , editCallsignErrors = Dict.empty
                , networkCallsigns = updatedNetworkCallsigns
              }
            , E.none
            )

        CallsignUpdated (Err error) ->
            ( { model
                | editCallsignSaving = False
                , editCallsignErrors = Dict.singleton "general" (Le.ErrorHandling.formatErrorForShowError "Помилка оновлення позивного" error)
              }
            , E.none
            )

        EditCallsignSourceSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.editCallsignSourceSelState

                updatedSourceId =
                    Le.Block.Select.singleUpd mAction (Maybe.andThen .sourceId model.editCallsignState)
            in
            ( { model
                | editCallsignSourceSelState = imodel2
                , editCallsignState =
                    Maybe.map (\state -> { state | sourceId = updatedSourceId }) model.editCallsignState
              }
            , E.sendCmd <| Cmd.map EditCallsignSourceSelMsg icmd
            )

        EditCallsignUnitSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.editCallsignUnitSelState

                updatedUnitId =
                    Le.Block.Select.singleUpd mAction (Maybe.andThen .unitId model.editCallsignState)

                -- Закриваємо селект тільки коли користувач дійсно вибрав підрозділ
                shouldCloseSelector =
                    case mAction of
                        Just (Select.Select _) ->
                            True

                        Just Select.Clear ->
                            True

                        _ ->
                            False
            in
            ( { model
                | editCallsignUnitSelState = imodel2
                , editCallsignUnitSelectorVisible =
                    if shouldCloseSelector then
                        False

                    else
                        model.editCallsignUnitSelectorVisible
                , editCallsignState =
                    Maybe.map (\state -> { state | unitId = updatedUnitId }) model.editCallsignState
              }
            , E.sendCmd <| Cmd.map EditCallsignUnitSelMsg icmd
            )

        ToggleEditCallsignUnitSelector ->
            ( { model | editCallsignUnitSelectorVisible = not model.editCallsignUnitSelectorVisible }
            , E.none
            )

        ResetEditCallsignUnit ->
            ( { model
                | editCallsignUnitSelectorVisible = False
                , editCallsignState =
                    Maybe.map
                        (\state ->
                            { state
                                | unitId =
                                    -- Повертаємо до першого підрозділу мережі
                                    case model.editUnitsSelect.selected of
                                        firstUnitId :: _ ->
                                            Just firstUnitId

                                        [] ->
                                            Nothing
                            }
                        )
                        model.editCallsignState
              }
            , E.none
            )

        OpenAddFromUnknownSidebar callsign ->
            case model.network of
                Success network ->
                    let
                        updatedState =
                            { networkId = network.id
                            , callsign = String.toUpper callsign
                            , position = Nothing
                            , comment = Nothing
                            , sourceId = Nothing -- No default source ID
                            , radioFreq = Nothing
                            , developing = False
                            , unitId =
                                -- Автоматично встановлюємо перший підрозділ мережі
                                case model.editUnitsSelect.selected of
                                    firstUnitId :: _ ->
                                        Just firstUnitId

                                    [] ->
                                        Nothing
                            , unitDeveloping = False
                            , mainRadioStation = False
                            }
                    in
                    ( { model
                        | callsignCreateSidebar = Just (CreateFromUnknown callsign)
                        , callsignCreateState = Just updatedState
                        , callsignCreateErrors = Dict.empty
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        -- Search functionality
        CallsignsSearchChanged query ->
            ( { model | callsignsSearchQuery = query }, E.none )

        NetworkCallsignsSearchChanged query ->
            ( { model | networkCallsignsSearchQuery = query }, E.none )

        RowShowAllPopupChanged popupStatus ->
            ( { model | rowShowAllPopupStatus = popupStatus }
            , E.none
            )

        -- Sidebar management for creating descriptions
        OpenConfirmationCreateSidebar ->
            ( { model | confirmationCreateSidebar = True }, E.none )

        CloseConfirmationCreateSidebar ->
            ( { model | confirmationCreateSidebar = False }, E.none )

        OpenSignsCreateSidebar ->
            ( { model | signsCreateSidebar = True }, E.none )

        CloseSignsCreateSidebar ->
            ( { model | signsCreateSidebar = False }, E.none )

        -- Sidebar management for editing descriptions
        OpenEditDescriptionSidebar description ->
            let
                -- Initialize input fields with current description data
                initialInput =
                    description.description

                -- For network descriptions, we don't have frequency info, so we'll leave it empty
                initialFreq =
                    Nothing

                freqItems =
                    case model.freqs of
                        Success freqs ->
                            List.map .freq freqs |> List.map (\freq -> Select.basicMenuItem { item = freq, label = freq })

                        _ ->
                            []
            in
            ( { model
                | editDescriptionSidebar = Just ( description.id, description )
                , editDescriptionInp = initialInput
                , editDescriptionFreqSelect =
                    { state = model.editDescriptionFreqSelect.state
                    , items = freqItems
                    , selected = initialFreq
                    }
              }
            , E.none
            )

        CloseEditDescriptionSidebar ->
            ( { model
                | editDescriptionSidebar = Nothing
                , editDescriptionInp = ""
                , editDescriptionFreqSelect =
                    { state = model.editDescriptionFreqSelect.state
                    , items = []
                    , selected = Nothing
                    }
              }
            , E.none
            )

        -- Input field management for editing descriptions
        EditDescriptionInputChanged input ->
            ( { model | editDescriptionInp = input }, E.none )

        EditDescriptionFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.editDescriptionFreqSelect.state

                updatedFreq =
                    Le.Block.Select.singleUpd mAct model.editDescriptionFreqSelect.selected

                freqsSelect =
                    model.editDescriptionFreqSelect

                freqsSelect2 =
                    { freqsSelect
                        | state = imodel
                        , selected = updatedFreq
                    }
            in
            ( { model
                | editDescriptionFreqSelect = freqsSelect2
              }
            , E.sendCmd <|
                Cmd.map
                    EditDescriptionFreqSelMsg
                    icmd
            )

        -- Delete confirmation dialog management
        DeleteDescriptionConfirmed description ->
            ( { model | deleteDescriptionConfirmation = Nothing }
            , E.networkDeleteDescription DescriptionDeleted { descriptionId = description.id, networkId = description.networkId }
            )

        DeleteDescriptionCanceled ->
            ( { model | deleteDescriptionConfirmation = Nothing }, E.none )


-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- SIDEBAR CONTENT


freqEditSidebarContent : Shared.Model -> Model -> Auth.User -> String -> B.UpdateNetworkFreqReq -> List (Html Msg)
freqEditSidebarContent shared model user freqId updateReq =
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати частоту" ]
            , p [ class "text-sm text-muted-foreground" ] [ text ("Частота: " ++ freqId) ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Тип" ]
                    , let
                        selectedItem =
                            Just <|
                                Select.basicMenuItem
                                    { item = model.freqEditKindSelect.selected
                                    , label = NetworksUtils.networkKindToLabel model.freqEditKindSelect.selected
                                    }

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map FreqKindSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.freqEditKindSelect.state
                                model.freqEditKindSelect.items
                                "Виберіть тип"
                                defaultOptions
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Модуляція" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\modulationId ->
                                    Select.basicMenuItem
                                        { item = modulationId
                                        , label =
                                            case model.modulations of
                                                Success modulations ->
                                                    modulations
                                                        |> List.filter (\mod -> mod.id == modulationId)
                                                        |> List.head
                                                        |> Maybe.map .name
                                                        |> Maybe.withDefault ""

                                                _ ->
                                                    ""
                                        }
                                )
                                model.freqEditModulationSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map FreqModulationSelectMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.freqEditModulationSelect.state
                                model.freqEditModulationSelect.items
                                "Не вибрано"
                                defaultOptions
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Активна з" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "date"
                        , Time.millisToPosix updateReq.activeFrom
                            |> Le.Time.renderDateF4 shared.timeZone
                            |> value
                        , onInput <|
                            UpdateFreqEditSidebar
                                << (\v ->
                                        { updateReq
                                            | activeFrom =
                                                case Le.Time.parseDateParts v of
                                                    Err _ ->
                                                        updateReq.activeFrom

                                                    Ok parts ->
                                                        Time.Extra.partsToPosix shared.timeZone parts
                                                            |> Time.posixToMillis
                                        }
                                   )
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ Checkbox.new { isChecked = model.freqEditShowActiveTo, onToggle = \_ -> ToggleFreqEditShowActiveTo }
                        |> Checkbox.withContent [ text "Частота вже не активна" ]
                        |> Checkbox.view
                    ]
                , if model.freqEditShowActiveTo then
                    div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Активна по" ]
                        , input
                            [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                            , type_ "date"
                            , Maybe.map Time.millisToPosix updateReq.activeTo
                                |> Maybe.map (Le.Time.renderDateF4 shared.timeZone)
                                |> Maybe.withDefault ""
                                |> value
                            , onInput <|
                                UpdateFreqEditSidebar
                                    << (\v ->
                                            { updateReq
                                                | activeTo = updateActiveToFromInput v shared.timeZone updateReq.activeTo
                                            }
                                       )
                            ]
                            []
                        ]

                  else
                    text ""
                ]
            ]
        , div [ class "p-6 border-t border-border" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseFreqEditSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.freqEditSaving then
                    Button.new { label = "Збереження...", onClick = SaveFreqEditSidebar }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Зберегти", onClick = SaveFreqEditSidebar }
                        |> Button.view
                ]
            ]
        ]
    ]



-- VIEW

missingFieldsBlock : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
missingFieldsBlock user network shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 [] [ text "Загальне" ]
        , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
            i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick MissingFieldsEditStartedByUser ] []

          else
            text ""
        ]
    , div [ class "space-y-3" ]
        [ if Le.Auth.hasRole "UnitsEditor" user then
            div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Смуги:" ]
                , div [ class "col-span-2 h-[40px] flex items-center" ]
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
                            text ""
                    ]
                ]

          else
            text ""
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Назва:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text network.name ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text (Maybe.withDefault "" network.radioStation) ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Підрозділи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.unitIds of
                    Just unitIds ->
                        List.map
                            (\unitId ->
                                Dict.get unitId (RD.withDefault Dict.empty shared.masterUnits)
                                    |> Maybe.map .name
                                    |> Maybe.withDefault (String.fromInt unitId)
                            )
                            unitIds
                            |> String.join ", "
                            |> text

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case shared.posts of
                    Success posts ->
                        List.map (\postId -> Dict.get postId posts) network.postIds
                            |> List.filterMap identity
                            |> List.map .name
                            |> String.join ", "
                            |> text

                    _ ->
                        text ""
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix network.activeFrom) ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.activeTo of
                    Just millis ->
                        Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix millis) |> text

                    Nothing ->
                        text ""
                ]
            ]
        ]
    ]


mainInfoBlock : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
mainInfoBlock user network shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
            i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick NetworkEditStartedByUser ] []

          else
            text ""
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text network.location ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Призначення:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.purpose ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Склад кореспондентів:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Вид передачі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ List.map (\freqObj -> freqObj.kind) network.freqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Режим роботи радіомережі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.operationMode ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Характер роботи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.operationType ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Період функціонування:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.operationPeriod ]
            ]
        ]
    ]


activityBlock : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
activityBlock user network shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 [] [ text "Активність мережі" ]
        ]
    , div [ class "space-y-4" ]
        [ div [ class "mb-4" ]
            [ span [ class "opacity-70 text-sm" ] [ text "Графік активності мережі за місяць" ]
            ]
        , div [ class "h-[300px]" ]
            [ case model.groupsActivity of
                Success data ->
                    let
                        groupsMessageCountByDayJson =
                            data |> Encode.dict identity (Encode.dict identity Encode.int)
                    in
                    Html.node "bar-chart"
                        [ property "data" <| groupsMessageCountByDayJson
                        , property "last-day" <| Encode.int shared.now
                        , class "block"
                        ]
                        []

                _ ->
                    Le.Block.Spinner.loadingSpinnerSm
            ]
        ]
    ]


mainInfoEditBlock : B.UpdateNetworkReq -> B.Network -> List B.NetworkFreq -> Shared.Model -> Model -> List (Html Msg)
mainInfoEditBlock updNetworkReq network networkFreqs shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        , div [ class "flex gap-[8px]" ]
            [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick NetworkEditingCanceledByUser ] []
            , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick NetworkEditingSavedByUser ] []
            ]
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.location
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | location = v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть район функціонування/розгортання"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Призначення:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.purpose
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | purpose = Just v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть призначення"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Склад кореспондентів:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Вид передачі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ List.map (\freqObj -> freqObj.kind) networkFreqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Режим роботи радіомережі:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationMode
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationMode = Just v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть режим роботи радіомережі"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Характер роботи:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationType
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationType = Just v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть характер роботи"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Період функціонування:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationPeriod
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationPeriod = Just v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть період функціонування"
                    ]
                    []
                ]
            ]
        ]
    ]


descriptionItem : B.NetworkDescription -> B.Network -> Auth.User -> Shared.Model -> Html Msg
descriptionItem description network user shared =
    div [ class "border rounded-lg p-2 mb-3 shadow-sm hover:shadow-md transition-shadow duration-200 border-border bg-card" ]
        [ div [ class "flex justify-between items-start mb-1" ]
            [ div [ class "flex flex-col gap-1" ]
                [ div [ class "flex items-center gap-2 text-sm text-muted" ]
                    (List.concat
                        [ [ i [ class "bi bi-person-circle", style "color" "var(--color-primary)" ] []
                          , span [ class "font-medium" ] [ text description.login ]
                          , span [ style "color" "var(--color-text-muted)" ] [ text "•" ]
                          , span [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
                          ]
                        , if description.networkFrequencyId /= Nothing then
                            [ span [ style "color" "var(--color-text-muted)" ] [ text "•" ]
                            , span [ class "font-medium", style "color" "var(--color-primary)" ]
                                [ text <|
                                    Maybe.withDefault ""
                                        (description.networkFrequencyId
                                            |> Maybe.andThen
                                                (\freqId ->
                                                    ListX.find (\freq -> freq.id == freqId) network.freqs
                                                )
                                            |> Maybe.map .freq
                                        )
                                ]
                            ]

                          else
                            []
                        ]
                    )
                ]
            , div [ class "flex gap-2" ]
                (if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user || Le.Auth.hasRole "CallsignsEditor" user then
                    [ button [ class "p-1 rounded-md transition-colors duration-200 description-item-edit-btn", style "color" "var(--color-primary)", style "background-color" "transparent", onClick <| DescriptionEditClickedByUser description, title "Редагувати" ]
                        [ i [ class "bi bi-pencil text-lg" ] [] ]
                    , button [ class "p-1 rounded-md transition-colors duration-200 description-item-delete-btn", style "color" "var(--color-error)", style "background-color" "transparent", onClick <| DescriptionDeleteClickedByUser description, title "Видалити" ]
                        [ i [ class "bi bi-trash text-lg" ] [] ]
                    ]

                 else
                    []
                )
            ]
        , div []
            [ div [ class "leading-relaxed", style "color" "var(--color-text)", style "white-space" "pre-line" ] [ text description.description ]
            ]
        ]


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
        [ div [ class "col-span-7 flex flex-col gap-[16px]" ]
            [ div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
                (case model.missingFieldsMode of
                    Readonly ->
                        missingFieldsBlock user network shared model

                    Editing eNetwork ->
                        missingFieldsEditBlock user network eNetwork shared model
                )
            , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
                (case model.mode of
                    Readonly ->
                        if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                            mainInfoBlock user network shared model

                        else
                            mainInfoBlock user network shared model

                    Editing eNetwork ->
                        if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                            mainInfoEditBlock eNetwork network network.freqs shared model

                        else
                            mainInfoBlock user network shared model
                )
            , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
                <| activityBlock user network shared model

            ]
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
            , let
                ( confirmations, signs ) =
                    List.partition (\description -> description.descrType == B.Confirmation) network.descriptions
              in
              div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
                [ div [ class "mb-[16px]" ]
                    [ div [ class "flex justify-between items-center mb-[8px]" ]
                        [ h5 [ class "" ] [ text "Обґрунтування прив'язки" ]
                        , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user || Le.Auth.hasRole "CallsignsEditor" user then
                            Button.new { label = "Створити", onClick = OpenConfirmationCreateSidebar }
                                |> Button.withStyleSecondary
                                |> Button.view

                          else
                            text ""
                        ]
                    , Html.Keyed.node "div"
                        [ class "h-[350px] overflow-y-auto" ]
                        (List.sortWith
                            (\a b ->
                                if a.createdAt > b.createdAt then
                                    LT

                                else
                                    GT
                            )
                            confirmations
                            |> List.map
                                (\description ->
                                    ( String.fromInt description.id
                                    , descriptionItem description network user shared
                                    )
                                )
                        )
                    ]
                , div []
                    [ div [ class "flex justify-between items-center mb-[8px]" ]
                        [ h5 [ class "" ] [ text "Розвідувальні ознаки" ]
                        , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user || Le.Auth.hasRole "CallsignsEditor" user then
                            Button.new { label = "Створити", onClick = OpenSignsCreateSidebar }
                                |> Button.withStyleSecondary
                                |> Button.view

                          else
                            text ""
                        ]
                    , Html.Keyed.node "div"
                        [ class "h-[350px] overflow-y-auto" ]
                        (List.sortWith
                            (\a b ->
                                if a.createdAt > b.createdAt then
                                    LT

                                else
                                    GT
                            )
                            signs
                            |> List.map
                                (\description ->
                                    ( String.fromInt description.id
                                    , descriptionItem description network user shared
                                    )
                                )
                        )
                    , section [ class "mt-[8px]" ]
                        [ h5 [] [ text "Сигнали" ]
                        , div [ class "h-[100px] overflow-y-auto" ]
                            (List.map
                                (\signalsForUnit ->
                                    if List.length signalsForUnit.signals > 0 then
                                        div []
                                            [ div []
                                                [ span [ class "font-medium" ] [ text signalsForUnit.unitName ]
                                                , div [ class "grid grid-cols-2 gap-[8px]" ] (List.map (\s -> div [ class "" ] [ span [ class "w-[50px] mr-[8px]" ] [ text s.text ], span [] [ text <| Maybe.withDefault "" s.meaning ] ]) signalsForUnit.signals)
                                                ]
                                            ]

                                    else
                                        text "Відсутні прив'язані до підрозділів сигнали"
                                )
                                (RD.withDefault [] model.signals)
                            )
                        ]
                    ]
                ]
            ]
        ]
    , FreqsTable.view model user shared
    , section [ class "bg-w dark:bg-[#1C1C21] w-full mt-[30px] p-[16px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Позивні мережі" ]
            , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                Button.new { label = "Створити", onClick = OpenCallsignCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view

              else
                text ""
            ]
        , case model.networkCallsigns of
            Success networkCallsigns ->
                CallsignsTables.viewNetworkCallsigns networkCallsigns model user shared
            Loading ->
                Le.Block.Spinner.loadingSpinnerSm

            Failure e ->
                div [ class "text-red-500" ] [ text "Помилка завантаження позивних мережі" ]

            NotAsked ->
                text ""

            NeedsReload _ ->
                Le.Block.Spinner.loadingSpinnerSm
        , case model.networkCallsigns of
            Success networkCallsigns ->
                let
                    -- Використовуємо helper функцію для фільтрації позивних що розвиваються
                    developingCallsigns =
                        getDevelopingCallsigns networkCallsigns
                in
                div [ class "p-3 bg-[var(--color-bg-muted)] rounded" ]
                    [ span [ class "font-medium" ] [ text "В дорозвідці: " ]
                    , if List.isEmpty developingCallsigns then
                        div [ class "text-[var(--color-text-muted)] text-sm mt-2" ]
                            [ text "Немає позивних в дорозвідці" ]

                      else
                        div [ class "flex flex-wrap gap-[4px] text-[13px] mt-2" ]
                            (List.map
                                (\callsign ->
                                    DropdownBadge.view
                                        (DropdownBadge.config
                                            (String.toUpper callsign.callsign)
                                            (model.developingCallsignDropdown == Just callsign.id)
                                            (ToggleDevelopingCallsignDropdown callsign.id)
                                            CloseDevelopingCallsignDropdown
                                            [ DropdownBadge.InternalAction
                                                { icon = "bi-pencil"
                                                , label = "Редагувати"
                                                , action = EditCallsignClicked callsign.id
                                                }
                                            , DropdownBadge.ExternalLink
                                                { icon = "bi-arrow-right"
                                                , label = "Проаналізувати"
                                                , url = IdUtils.createAnalysisUrl shared model callsign.callsign
                                                }
                                            , DropdownBadge.InternalAction
                                                { icon = "bi-trash"
                                                , label = "Видалити"
                                                , action = DeleteCallsignFromNetwork callsign.id
                                                }
                                            ]
                                        )
                                )
                                developingCallsigns
                            )
                    ]

            _ ->
                text ""
        , div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Співпадіння з каталогом" ]
            ]
        , case model.callsigns of
            Success callsigns ->
                CallsignsTables.viewCallsigns callsigns model user shared

            _ ->
                Le.Block.Spinner.loadingSpinnerSm
        ]
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
                                ++ (if model.confirmationCreateSidebar then
                                        [ Sidebar.view True CloseConfirmationCreateSidebar [ confirmationCreateSidebarContent shared model user network ] ]

                                    else
                                        []
                                   )
                                ++ (if model.signsCreateSidebar then
                                        [ Sidebar.view True CloseSignsCreateSidebar [ signsCreateSidebarContent shared model user network ] ]

                                    else
                                        []
                                   )
                                ++ (if model.editDescriptionSidebar /= Nothing then
                                        case model.editDescriptionSidebar of
                                            Just ( _, description ) ->
                                                [ Sidebar.view True CloseEditDescriptionSidebar [ editDescriptionSidebarContent shared model user network description ] ]

                                            Nothing ->
                                                []

                                    else
                                        []
                                   )

                        _ ->
                            [ div [ class "h-full" ] [ Le.Block.Spinner.loadingSpinner ] ]
                    )
                , case model.freqEditSidebar of
                    Just ( freqId, updateReq ) ->
                        Sidebar.view True CloseFreqEditSidebar (freqEditSidebarContent shared model user freqId updateReq)

                    Nothing ->
                        text ""
                , if model.freqCreateSidebar then
                    Sidebar.view True CloseFreqCreateSidebar (freqCreateSidebarContent shared model user)

                  else
                    text ""
                , case model.callsignCreateSidebar of
                    Just _ ->
                        Sidebar.view True CloseCallsignCreateSidebar [ callsignCreateSidebarContent shared model user ]

                    Nothing ->
                        text ""
                , if model.editCallsignSidebar /= Nothing then
                    Sidebar.view True CloseEditCallsignSidebar [ editCallsignSidebarContent shared model user ]

                  else
                    text ""
                , case model.freqDetailPopup of
                    Just freqId ->
                        let
                            -- Знаходимо дані активності для цієї частоти
                            freqActivityData =
                                case model.networkFreqsActivity of
                                    Success data ->
                                        case Dict.get freqId data of
                                            Just freqActivity ->
                                                let
                                                    -- Використовуємо новий freq-detail-chart
                                                    freqActivityJson =
                                                        Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freqId freqActivity)
                                                in
                                                div [ style "width" "100%", style "height" "300px", style "border" "1px solid #e5e7eb", style "border-radius" "8px", style "padding" "16px" ]
                                                    [ h4 [ class "text-sm font-medium mb-4", style "color" "#374151" ] [ text ("Активність частоти " ++ freqId) ]
                                                    , div [ style "width" "100%", style "height" "250px", style "min-height" "250px", style "display" "block" ]
                                                        [ Html.node "freq-detail-chart"
                                                            [ property "data" <| freqActivityJson
                                                            , property "lastDay" <| Encode.int shared.now
                                                            , style "width" "100%"
                                                            , style "height" "100%"
                                                            , style "display" "block"
                                                            ]
                                                            []
                                                        ]
                                                    ]

                                            Nothing ->
                                                div [ class "text-center text-gray-500", style "height" "300px", style "display" "flex", style "align-items" "center", style "justify-content" "center" ] [ text "Немає даних активності" ]

                                    _ ->
                                        div [ class "text-center", style "height" "300px", style "display" "flex", style "align-items" "center", style "justify-content" "center" ] [ Le.Block.Spinner.loadingSpinnerSm ]
                        in
                        ModalDialog.modalDialog True
                            CloseFreqDetailPopup
                            []
                            [ div [ class "p-6", style "width" "600px", style "height" "400px" ]
                                [ h3 [ class "text-lg font-semibold mb-4" ] [ text ("Детальний графік активності: " ++ freqId) ]
                                , freqActivityData
                                ]
                            ]

                    Nothing ->
                        text ""
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
                , let
                    ( isOpen, freqStr ) =
                        case model.deleteFreqConfirmation of
                            Just ( _, f ) ->
                                ( True, f )

                            Nothing ->
                                ( False, "" )

                    deleteFreqDialogContent =
                        [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                            [ div [ class "pb-6" ]
                                [ h2 [] [ text "Видалити частоту" ]
                                , p [] [ text ("Ви впевнені, що хочете видалити частоту " ++ freqStr ++ "?") ]
                                ]
                            , div [ class "flex justify-between" ]
                                [ Button.new { label = "Скасувати", onClick = DeleteFreqCanceledByUser } |> Button.withStyleSecondary |> Button.view
                                , Button.new { label = "Видалити", onClick = DeleteFreqConfirmedByUser }
                                    |> Button.withStyleDanger
                                    |> (if model.deleteFreqLoading then
                                            Button.withIcon [ Le.Block.Spinner.loadingSpinner2Sm ]

                                        else
                                            identity
                                       )
                                    |> Button.view
                                ]
                            ]
                        ]
                  in
                  ModalDialog.modalDialog isOpen DeleteFreqCanceledByUser [] deleteFreqDialogContent
                , let
                    deleteCallsignDialogContent =
                        [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                            [ div [ class "pb-6" ]
                                [ h2 [] [ text "Відв'язати позивний" ]
                                , p [] [ text "Ви впевнені, що хочете відв'язати цей позивний від мережі?" ]
                                ]
                            , div [ class "flex justify-between" ]
                                [ Button.new { label = "Скасувати", onClick = DeleteCallsignCanceled } |> Button.withStyleSecondary |> Button.view
                                , Button.new { label = "Відв'язати", onClick = DeleteCallsignConfirmed (Maybe.withDefault 0 model.deleteCallsignConfirmation) }
                                    |> Button.withStyleDanger
                                    |> (if model.deleteCallsignLoading then
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
                  ModalDialog.modalDialog (model.deleteCallsignConfirmation /= Nothing) DeleteCallsignCanceled [] deleteCallsignDialogContent
                , let
                    deleteDescriptionDialogContent =
                        [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                            [ div [ class "pb-6" ]
                                [ h2 [] [ text "Видалити обґрунтування" ]
                                , p [] [ text "Ви впевнені, що хочете видалити це обґрунтування?" ]
                                ]
                            , div [ class "flex justify-between" ]
                                [ Button.new { label = "Скасувати", onClick = DeleteDescriptionCanceled } |> Button.withStyleSecondary |> Button.view
                                , Button.new { label = "Видалити", onClick = DeleteDescriptionConfirmed (Maybe.withDefault (B.NetworkDescription 0 0 Nothing B.Confirmation "" "" 0) model.deleteDescriptionConfirmation) }
                                    |> Button.withStyleDanger
                                    |> Button.view
                                ]
                            ]
                        ]
                  in
                  ModalDialog.modalDialog (model.deleteDescriptionConfirmation /= Nothing) DeleteDescriptionCanceled [] deleteDescriptionDialogContent
                ]
            ]
        ]
    }


missingFieldsEditBlock : Auth.User -> B.Network -> B.UpdateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
missingFieldsEditBlock user network updNetworkReq shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 [] [ text "Загальне" ]
        , div [ class "flex gap-[8px]" ]
            [ if model.missingFieldsEditLoading then
                i [ class "bi bi-x-square text-gray-400 text-[20px]", title "Скасувати" ] []

              else
                i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick MissingFieldsEditCanceledByUser, title "Скасувати" ] []
            , if model.missingFieldsEditLoading then
                i [ class "text-[20px]" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

              else
                i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick MissingFieldsEditSavedByUser, title "Зберегти" ] []
            ]
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Смуги:" ]
            , div [ class "col-span-2" ]
                [ let
                    selectedItems =
                        List.map
                            (\aorId ->
                                let
                                    label =
                                        case model.aorList of
                                            Success aors ->
                                                aors
                                                    |> List.filter (\a -> a.id == aorId)
                                                    |> List.head
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault ""

                                            _ ->
                                                ""
                                in
                                Select.basicMenuItem { item = aorId, label = label }
                            )
                            model.editAorSelect.selected

                    defaultOptions =
                        Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map NetworkEditAorSelMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelect
                            selectedItems
                            model.editAorSelect.state
                            model.editAorSelect.items
                            "виберіть смуги"
                            defaultOptions
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Назва:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.name
                    , onInput <| MissingFieldsEditingMsg << (\v -> { updNetworkReq | name = v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть назву"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value (Maybe.withDefault "" updNetworkReq.radioStation)
                    , onInput <| MissingFieldsEditingMsg << (\v -> { updNetworkReq | radioStation = Just v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть радіостанцію"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Підрозділи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ div [ class "w-full" ]
                    [ let
                        selectedItems =
                            List.map
                                (\unitId ->
                                    Select.basicMenuItem
                                        { item = unitId
                                        , label =
                                            RD.withDefault Dict.empty shared.masterUnits
                                                |> Dict.get unitId
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editUnitsSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditUnitsSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
                                selectedItems
                                model.editUnitsSelect.state
                                model.editUnitsSelect.items
                                "почніть вводити назву підрозділу"
                                defaultOptions
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ div [ class "w-full" ]
                    [ let
                        selectedItems =
                            List.map
                                (\postId ->
                                    Select.basicMenuItem
                                        { item = postId
                                        , label =
                                            RD.withDefault Dict.empty shared.posts
                                                |> Dict.get postId
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editPostsSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditPostsSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
                                selectedItems
                                model.editPostsSelect.state
                                model.editPostsSelect.items
                                "виберіть пости"
                                defaultOptions
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center mt-[24px]" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix network.activeFrom) ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.activeTo of
                    Just millis ->
                        text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix millis)

                    Nothing ->
                        text ""
                ]
            ]
        ]
    ]


updateActiveToFromInput : String -> Time.Zone -> Maybe Int -> Maybe Int
updateActiveToFromInput input timeZone currentValue =
    case ( String.isEmpty input, Le.Time.parseDateParts input ) of
        ( True, _ ) ->
            Nothing

        ( False, Err _ ) ->
            currentValue

        ( False, Ok parts ) ->
            Time.Extra.partsToPosix timeZone parts
                |> Time.posixToMillis
                |> Just


-- VALIDATION
-- Frequency format validation
-- FREQUENCY CREATION SIDEBAR CONTENT


freqCreateSidebarContent : Shared.Model -> Model -> Auth.User -> List (Html Msg)
freqCreateSidebarContent shared model user =
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Додати частоту" ]
            , p [ class "text-sm text-muted-foreground" ] [ text "Заповніть інформацію про нову частоту" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6 space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота*" ]
                , input
                    [ type_ "text"
                    , class <|
                        "w-full p-2 border rounded "
                            ++ (if String.trim model.freqCreateState.freq == "" || model.freqCreateFormatError /= Nothing then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                    , placeholder "наприклад, 146.5000"
                    , value model.freqCreateState.freq
                    , onInput (\freq -> UpdateFreqCreateField (\state -> { state | freq = freq }))
                    ]
                    []
                , div [ class "mt-1 min-h-[20px]" ]
                    [ if String.trim model.freqCreateState.freq == "" then
                        div [ class "text-sm text-red-600" ]
                            [ text "Це поле обов'язкове" ]

                      else
                        case model.freqCreateFormatError of
                            Just error ->
                                div [ class "text-sm text-red-600" ]
                                    [ text error ]

                            Nothing ->
                                text ""
                    ]
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Тип" ]
                , let
                    selectedItem =
                        Select.basicMenuItem
                            { item = model.freqCreateKindSelect.selected
                            , label = NetworksUtils.networkKindToLabel model.freqCreateKindSelect.selected
                            }

                    defaultOptions =
                        Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map FreqCreateKindSelectMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelectSingle
                            (Just selectedItem)
                            model.freqCreateKindSelect.state
                            model.freqCreateKindSelect.items
                            "Виберіть тип"
                            defaultOptions
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Модуляція" ]
                , case model.modulations of
                    Success modulations ->
                        let
                            selectedItem =
                                Maybe.map
                                    (\item ->
                                        Select.basicMenuItem
                                            { item = item
                                            , label =
                                                modulations
                                                    |> List.filter (\mod -> mod.id == item)
                                                    |> List.head
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault ""
                                            }
                                    )
                                    model.freqCreateModulationSelect.selected

                            defaultOptions =
                                Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                        in
                        Html.map FreqCreateModulationSelectMsg <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectSingle
                                    selectedItem
                                    model.freqCreateModulationSelect.state
                                    model.freqCreateModulationSelect.items
                                    "Не вибрано"
                                    defaultOptions

                    _ ->
                        div [ class "text-sm text-muted-foreground" ] [ text "Завантаження модуляцій..." ]
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Обґрунтування прив'язки" ]
                , textarea
                    [ class "w-full p-2 border border-border rounded resize-none"
                    , rows 3
                    , placeholder "Введіть обґрунтування прив'язки"
                    , value model.freqCreateDescriptionInp
                    , onInput FreqCreateDescriptionInputChangedByUser
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Активна з:" ]
                , input
                    [ type_ "date"
                    , class "w-full p-2 border border-border rounded"
                    , case model.freqCreateState.activeFrom of
                        Just millis ->
                            value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                        Nothing ->
                            value ""
                    , onInput <|
                        UpdateFreqCreateField
                            << (\v state ->
                                    { state
                                        | activeFrom =
                                            case Le.Time.parseDateParts v of
                                                Err _ ->
                                                    state.activeFrom

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                                        |> Just
                                    }
                               )
                    ]
                    []
                ]
            , div []
                [ Checkbox.new { isChecked = model.freqCreateShowActiveTo, onToggle = \_ -> ToggleFreqCreateShowActiveTo }
                    |> Checkbox.withContent [ text "Частота вже не активна" ]
                    |> Checkbox.view
                ]
            , if model.freqCreateShowActiveTo then
                div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Активна по:" ]
                    , input
                        [ type_ "date"
                        , class "w-full p-2 border border-border rounded"
                        , case model.freqCreateState.activeTo of
                            Just millis ->
                                value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                            Nothing ->
                                value ""
                        , onInput <|
                            UpdateFreqCreateField
                                << (\v state ->
                                        { state
                                            | activeTo =
                                                case Le.Time.parseDateParts v of
                                                    Err _ ->
                                                        state.activeTo

                                                    Ok parts ->
                                                        Time.Extra.partsToPosix shared.timeZone parts
                                                            |> Time.posixToMillis
                                                            |> Just
                                        }
                                   )
                        ]
                        []
                    ]

              else
                text ""
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseFreqCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.freqEditSaving then
                    Button.new { label = "Додавання...", onClick = AddFreqToNetwork }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Додати", onClick = AddFreqToNetwork }
                        |> Button.withDisabled
                            (String.trim model.freqCreateState.freq == "" || model.freqCreateFormatError /= Nothing)
                        |> Button.view
                ]
            ]
        ]
    ]


callsignCreateSidebarContent : Shared.Model -> Model -> Auth.User -> Html Msg
callsignCreateSidebarContent shared model user =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити позивний мережі" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позивний *" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позивний"
                        , value (Maybe.map .callsign model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just { s | callsign = String.toUpper v }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .mainRadioStation model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | mainRadioStation = not s.mainRadioStation }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Головна радіостанція" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })

                        selectItem =
                            Maybe.andThen .sourceId model.callsignCreateState
                                |> Maybe.andThen
                                    (\sourceId ->
                                        ListX.find (\s -> s.id == sourceId) model.callsignCreateSources
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                    )
                      in
                      Html.map CallsignCreateSourceSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectItem
                                model.callsignCreateSourceSelState
                                sourceMenu
                                "Виберіть джерело (необов'язково)"
                                (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                    |> (\opts ->
                                            { opts
                                                | clearable = True
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Підрозділ" ]
                    , div [ class "flex items-center gap-2 p-2 border border-border rounded bg-gray-50 dark:bg-gray-700" ]
                        [ span [ class "text-sm text-gray-700 dark:text-gray-300" ]
                            [ text
                                (case Maybe.andThen .unitId model.callsignCreateState of
                                    Just unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault "Невідомий підрозділ"

                                            _ ->
                                                "Завантаження..."

                                    Nothing ->
                                        -- Показуємо назву першого підрозділу мережі
                                        case model.editUnitsSelect.selected of
                                            firstUnitId :: _ ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get firstUnitId units
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault "Підрозділ мережі"

                                                    _ ->
                                                        "Підрозділ мережі"

                                            [] ->
                                                "Підрозділ мережі"
                                )
                            ]
                        , button
                            [ type_ "button"
                            , class "text-blue-600 hover:text-blue-800 text-sm"
                            , title "Змінити підрозділ"
                            , onClick ToggleCallsignCreateUnitSelector
                            ]
                            [ text "✏️" ]
                        , button
                            [ type_ "button"
                            , class "text-gray-600 hover:text-gray-800 text-sm"
                            , title "Повернути підрозділ мережі"
                            , onClick ResetCallsignCreateUnit
                            ]
                            [ text "✖️" ]
                        ]
                    , if model.callsignCreateUnitSelectorVisible then
                        -- Показуємо селект підрозділів
                        div [ class "mt-2" ]
                            [ let
                                unitMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            Dict.values units |> List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            []

                                selectedUnit =
                                    Maybe.andThen .unitId model.callsignCreateState
                                        |> Maybe.andThen
                                            (\unitId ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get unitId units
                                                            |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                                    _ ->
                                                        Nothing
                                            )
                              in
                              Html.map CallsignCreateUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectedUnit
                                        model.callsignCreateUnitSelState
                                        unitMenu
                                        "Виберіть підрозділ"
                                        (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                            |> (\opts ->
                                                    { opts
                                                        | clearable = True
                                                    }
                                               )
                                        )
                            ]

                      else
                        text ""
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .unitDeveloping model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | unitDeveloping = not s.unitDeveloping }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Підрозділ в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Посада" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть посаду (необов'язково)"
                        , value (Maybe.andThen .position model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | position =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Коментар" ]
                    , textarea
                        [ class "w-full p-2 border border-border rounded resize-none"
                        , rows 3
                        , placeholder "Введіть коментар (необов'язково)"
                        , value (Maybe.andThen .comment model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | comment =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .developing model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | developing = not s.developing }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Позначити як позивний в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , if Maybe.andThen .sourceId model.callsignCreateState == Just 2 then
                    div []
                        [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота *" ]
                        , input
                            [ type_ "text"
                            , class "w-full p-2 border border-border rounded"
                            , placeholder "Введіть частоту (обов'язково для РО)"
                            , value (Maybe.andThen .radioFreq model.callsignCreateState |> Maybe.withDefault "")
                            , onInput <|
                                UpdateCallsignCreateField
                                    << (\v maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just
                                                        { s
                                                            | radioFreq =
                                                                if String.trim v == "" then
                                                                    Nothing

                                                                else
                                                                    Just v
                                                        }

                                                Nothing ->
                                                    Nothing
                                       )
                            ]
                            []
                        ]

                  else
                    text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCallsignCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.callsignCreateSaving then
                    Button.new { label = "Створення...", onClick = CreateCallsignClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Створити", onClick = CreateCallsignClicked }
                        |> Button.withDisabled
                            (let
                                callsignEmpty =
                                    Maybe.map .callsign model.callsignCreateState
                                        |> Maybe.map (String.trim >> (==) "")
                                        |> Maybe.withDefault True

                                isRO =
                                    Maybe.andThen .sourceId model.callsignCreateState == Just 2

                                roFreqEmpty =
                                    if isRO then
                                        Maybe.andThen .radioFreq model.callsignCreateState
                                            |> Maybe.map (String.trim >> (==) "")
                                            |> Maybe.withDefault True

                                    else
                                        False
                             in
                             callsignEmpty || roFreqEmpty
                            )
                        |> Button.view
                ]
            ]
        ]


editCallsignSidebarContent : Shared.Model -> Model -> B.User -> Html Msg
editCallsignSidebarContent shared model user =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Редагувати позивний мережі" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позивний *" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позивний"
                        , value (Maybe.map .callsign model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just { s | callsign = String.toUpper v }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .mainRadioStation model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | mainRadioStation = not s.mainRadioStation }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Головна радіостанція" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })

                        selectItem =
                            Maybe.andThen .sourceId model.editCallsignState
                                |> Maybe.andThen
                                    (\sourceId ->
                                        ListX.find (\s -> s.id == sourceId) model.callsignCreateSources
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                    )
                      in
                      Html.map EditCallsignSourceSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectItem
                                model.editCallsignSourceSelState
                                sourceMenu
                                "Виберіть джерело (необов'язково)"
                                (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                    |> (\opts ->
                                            { opts
                                                | clearable = True
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Підрозділ" ]
                    , div [ class "flex items-center gap-2 p-2 border border-border rounded bg-gray-50 dark:bg-gray-700" ]
                        [ span [ class "text-sm text-gray-700 dark:text-gray-300" ]
                            [ text
                                (case Maybe.andThen .unitId model.editCallsignState of
                                    Just unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault "Невідомий підрозділ"

                                            _ ->
                                                "Завантаження..."

                                    Nothing ->
                                        -- Показуємо назву першого підрозділу мережі
                                        case model.editUnitsSelect.selected of
                                            firstUnitId :: _ ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get firstUnitId units
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault "Підрозділ мережі"

                                                    _ ->
                                                        "Підрозділ мережі"

                                            [] ->
                                                "Підрозділ мережі"
                                )
                            ]
                        , button
                            [ type_ "button"
                            , class "text-blue-600 hover:text-blue-800 text-sm"
                            , title "Змінити підрозділ"
                            , onClick ToggleEditCallsignUnitSelector
                            ]
                            [ text "✏️" ]
                        , button
                            [ type_ "button"
                            , class "text-gray-600 hover:text-gray-800 text-sm"
                            , title "Повернути підрозділ мережі"
                            , onClick ResetEditCallsignUnit
                            ]
                            [ text "✖️" ]
                        ]
                    , if model.editCallsignUnitSelectorVisible then
                        -- Показуємо селект підрозділів
                        div [ class "mt-2" ]
                            [ let
                                unitMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            Dict.values units |> List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            []

                                selectedUnit =
                                    Maybe.andThen .unitId model.editCallsignState
                                        |> Maybe.andThen
                                            (\unitId ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get unitId units
                                                            |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                                    _ ->
                                                        Nothing
                                            )
                              in
                              Html.map EditCallsignUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectedUnit
                                        model.editCallsignUnitSelState
                                        unitMenu
                                        "Виберіть підрозділ"
                                        (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                            |> (\opts ->
                                                    { opts
                                                        | clearable = True
                                                    }
                                               )
                                        )
                            ]

                      else
                        text ""
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .unitDeveloping model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | unitDeveloping = not s.unitDeveloping }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Підрозділ в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Посада" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть посаду (необов'язково)"
                        , value (Maybe.andThen .position model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | position =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Коментар" ]
                    , textarea
                        [ class "w-full p-2 border border-border rounded resize-none"
                        , rows 3
                        , placeholder "Введіть коментар (необов'язково)"
                        , value (Maybe.andThen .comment model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | comment =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .developing model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | developing = not s.developing }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Позначити як позивний в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , if Maybe.andThen .sourceId model.editCallsignState == Just 2 then
                    div []
                        [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота *" ]
                        , input
                            [ type_ "text"
                            , class "w-full p-2 border border-border rounded"
                            , placeholder "Введіть частоту (обов'язково для РО)"
                            , value (Maybe.andThen .radioFreq model.editCallsignState |> Maybe.withDefault "")
                            , onInput <|
                                UpdateEditCallsignField
                                    << (\v maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just
                                                        { s
                                                            | radioFreq =
                                                                if String.trim v == "" then
                                                                    Nothing

                                                                else
                                                                    Just v
                                                        }

                                                Nothing ->
                                                    Nothing
                                       )
                            ]
                            []
                        ]

                  else
                    text ""

                -- Display errors if any
                , case Dict.get "general" model.editCallsignErrors of
                    Just error ->
                        div [ class "p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm" ]
                            [ text error ]

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseEditCallsignSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.editCallsignSaving then
                    Button.new { label = "Збереження...", onClick = SaveEditCallsignClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Зберегти", onClick = SaveEditCallsignClicked }
                        |> Button.withDisabled
                            (let
                                callsignEmpty =
                                    Maybe.map .callsign model.editCallsignState
                                        |> Maybe.map (String.trim >> (==) "")
                                        |> Maybe.withDefault True

                                isRO =
                                    Maybe.andThen .sourceId model.editCallsignState == Just 2

                                roFreqEmpty =
                                    if isRO then
                                        Maybe.andThen .radioFreq model.editCallsignState
                                            |> Maybe.map (String.trim >> (==) "")
                                            |> Maybe.withDefault True

                                    else
                                        False
                             in
                             callsignEmpty || roFreqEmpty
                            )
                        |> Button.view
                ]
            ]
        ]



-- Sidebar content for creating confirmation descriptions


confirmationCreateSidebarContent : Shared.Model -> Model -> Auth.User -> B.Network -> Html Msg
confirmationCreateSidebarContent shared model user network =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити обґрунтування прив'язки" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота (необов'язково)" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\freq ->
                                    Select.basicMenuItem
                                        { item = freq
                                        , label = freq
                                        }
                                )
                                model.addConfirmationFreqSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map AddConfirmationFreqSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.addConfirmationFreqSelect.state
                                model.addConfirmationFreqSelect.items
                                "виберіть частоту"
                                defaultOptions
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Обґрунтування прив'язки *" ]
                    , textarea
                        [ class "w-full p-3 border border-border rounded min-h-[120px] resize-none"
                        , placeholder "Введіть обґрунтування прив'язки"
                        , value model.addConfirmationInp
                        , onInput ConfirmationInputChangedByUser
                        ]
                        []
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseConfirmationCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Confirmation }
                    |> Button.withDisabled (String.isEmpty model.addConfirmationInp)
                    |> Button.view
                ]
            ]
        ]


-- Sidebar content for creating signs descriptions


signsCreateSidebarContent : Shared.Model -> Model -> Auth.User -> B.Network -> Html Msg
signsCreateSidebarContent shared model user network =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити розвідувальні ознаки" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Розвідувальні ознаки *" ]
                    , textarea
                        [ class "w-full p-3 border border-border rounded min-h-[120px] resize-none"
                        , placeholder "Введіть розвідувальні ознаки"
                        , value model.addSignsInp
                        , onInput SignsInputChangedByUser
                        ]
                        []
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseSignsCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Sign }
                    |> Button.withDisabled (String.isEmpty model.addSignsInp)
                    |> Button.view
                ]
            ]
        ]


-- Sidebar content for editing descriptions

editDescriptionSidebarContent : Shared.Model -> Model -> Auth.User -> B.Network -> B.NetworkDescription -> Html Msg
editDescriptionSidebarContent shared model user network description =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Редагувати опис" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота (необов'язково)" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\freq ->
                                    Select.basicMenuItem
                                        { item = freq
                                        , label = freq
                                        }
                                )
                                model.editDescriptionFreqSelect.selected

                        defaultOptions =
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map EditDescriptionFreqSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectedItem
                                model.editDescriptionFreqSelect.state
                                model.editDescriptionFreqSelect.items
                                "виберіть частоту"
                                defaultOptions
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Текст опису *" ]
                    , textarea
                        [ class "w-full p-3 border border-border rounded min-h-[120px] resize-none"
                        , placeholder "Введіть текст опису"
                        , value model.editDescriptionInp
                        , onInput EditDescriptionInputChanged
                        ]
                        []
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseEditDescriptionSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = DescriptionEditSave description }
                    |> Button.withDisabled (String.isEmpty model.editDescriptionInp)
                    |> Button.view
                ]
            ]
        ]
