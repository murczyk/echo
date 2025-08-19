module Pages.RerNetworks.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.ModalDialog as ModalDialog
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
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Time
import Time.Extra
import Url.Builder
import View exposing (View)


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


createAnalysisUrl : Shared.Model -> Model -> String -> String
createAnalysisUrl shared model callsign =
    let
        -- Generate query state with network date range and callsign filter
        queryState =
            createAnalysisQueryState shared model callsign

        -- Encode the query state
        encodedState =
            Encode.encode 0 (B.rerAnalysisQueryStateEncoder queryState)

        -- Create query parameters using Url.Builder
        query =
            [ Url.Builder.string "state" encodedState ]
    in
    Url.Builder.absolute [ "rer-analysis" ] query



-- Generate query state for RER analysis with network date range and callsign filter


createAnalysisQueryState : Shared.Model -> Model -> String -> B.RerAnalysisQueryState
createAnalysisQueryState shared model callsign =
    let
        -- Get date range from network
        ( dateFromStr, dateToStr ) =
            case model.network of
                Success network ->
                    let
                        fromDate =
                            Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix network.activeFrom)

                        toDate =
                            case network.activeTo of
                                Just activeTo ->
                                    Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix activeTo)

                                Nothing ->
                                    -- If no end date, use current date
                                    Le.Time.renderDateF4 shared.timeZone (Time.millisToPosix shared.now)
                    in
                    ( fromDate, toDate )

                _ ->
                    -- Fallback to empty strings if network not loaded
                    ( "", "" )

        -- Get frequencies from network for pre-selection
        freqsSelected =
            case model.network of
                Success network ->
                    List.map .freq network.freqs

                _ ->
                    []
    in
    { dateFromStr = dateFromStr
    , timeFromStr = ""
    , dateToStr = dateToStr
    , timeToStr = "00:00"
    , groupsSelected = []
    , sendersSelected = []
    , freqsSelected = freqsSelected
    , callsignsSelected = [ callsign ]
    , unitsSelected = []
    , locationsSelected = []
    , includePelengLocations = True
    , orWithExtendedForm = False
    , orBookmarked = False
    , orImportant = False
    , orWithCoords = False
    , search = ""
    , tags = []
    , unitsExactMatchOnly = True
    , adjacentFreqsRange = 0
    }



-- INIT


type Mode updateReq
    = Readonly
    | Editing updateReq


type alias CallsignResModified =
    { callsign : String
    , knownCallsigns : List B.KnownCallsignShortRes
    , messageCount : Int
    , lastDatetime : Maybe Int
    , freqs : Maybe (List String)
    , networkNames : Maybe (List String)
    , isOld : Bool
    , isReported : Bool
    }





-- Нова структура для рядка таблиці позивних


type alias CallsignTableRow =
    { id : Int
    , callsign : String
    , messageCount : Int
    , lastDatetime : Maybe Int
    , position : String
    , unitName : String
    , comment : String
    , createdAt : Int
    , sourceName : String
    }


type FreqActivityFilter
    = AllFreqs
    | ActiveFreqs
    | InactiveFreqs


type alias Model =
    { network : RemoteData ApiError B.Network
    , callsigns : RemoteData ApiError (List B.NetworkCallsignRes)
    , mapPoints : RemoteData ApiError (List B.NetworkPoint)
    , groupsActivity : RemoteData ApiError GroupsByDate
    , networkFreqsActivity : RemoteData ApiError (Dict String (Dict String Int))
    , freqs : RemoteData ApiError (List B.NetworkFreqsRes)
    , freqsEditingState : Mode (Dict String B.UpdateNetworkFreqReq)
    , callsignsEditingState : Mode (Dict String Bool)
    , callsignsOpenedPopupId : Maybe String
    , mode : Mode B.UpdateNetworkReq
    , missingFieldsMode : Mode B.UpdateNetworkReq
    , missingFieldsEditLoading : Bool
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editPostsSelect : Le.Block.Select.SelectType Int
    , editUnitsSelect : Le.Block.Select.SelectType Int
    , editAorSelect : Le.Block.Select.SelectType Int
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    , addConfirmationInp : String
    , addConfirmationFreqSelect : Le.Block.Select.SelectTypeSingle String
    , addSignsInp : String
    , signals : RemoteData ApiError (List B.NetworkSignalsRes)
    , descriptionsEditDict : Dict Int B.NetworkDescription
    , reportModalOpened : Bool
    , reportDownloadInProgress : Bool
    , reportNetworksOnly : Bool
    , reportActiveFreqsOnly : Bool
    , reportIncludePelengsMap : Bool
    , reportIncludeSigintSigns : Bool
    , reportIncludeConfirmation : Bool
    , freqsActivityFilter : FreqActivityFilter
    , freqsTableState : Table.State
    , callsignsTableState : Table.State
    , freqEditSidebar : Maybe ( String, B.UpdateNetworkFreqReq )
    , freqDetailPopup : Maybe String
    , modulations : RemoteData ApiError (List B.ModulationRec)
    , freqEditKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqEditModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , freqEditSaving : Bool
    , freqEditShowActiveTo : Bool
    , deleteNetworkConfirmation : Maybe Int
    , deleteNetworkLoading : Bool
    , deleteFreqConfirmation : Maybe ( Int, String )
    , deleteFreqLoading : Bool
    -- Frequency creation sidebar
    , freqCreateSidebar : Bool
    , freqCreateState : B.AddNetworkFreq
    , freqCreateKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , freqCreateModulationSelect : Le.Block.Select.SelectTypeSingle Int
    , freqCreateDescriptionInp : String
    , freqCreateFormatError : Maybe String
    , freqCreateShowActiveTo : Bool

    -- Network callsigns (new table)
    , networkCallsigns : RemoteData ApiError (List B.NetworkCallsign)
    , networkCallsignsTableState : Table.State
    
    -- Callsign selection and adding functionality
    , callsignsSelected : Set Int    -- Виділені позивні (known_callsign_id)
    , callsignsAddLoading : Bool     -- Стан завантаження при додаванні позивних
    
    -- Network callsign creation sidebar
            , callsignCreateSidebar : Bool
        , callsignCreateState : Maybe B.CreateNetworkCallsignReq
        , callsignCreateSaving : Bool
        , callsignCreateErrors : Dict String String
        , callsignCreateSourceSelState : Select.State
        , callsignCreateSources : List B.Source
        
        -- Callsign deletion confirmation dialog
        , deleteCallsignConfirmation : Maybe Int  -- ID позивного для видалення
        , deleteCallsignLoading : Bool           -- Стан завантаження видалення
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
      , descriptionsEditDict = Dict.empty
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
      
      -- Callsign selection and adding functionality
      , callsignsSelected = Set.empty
      , callsignsAddLoading = False
      
      -- Network callsign creation sidebar
              , callsignCreateSidebar = False
        , callsignCreateState = Nothing
        , callsignCreateSaving = False
        , callsignCreateErrors = Dict.empty
        , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
        , callsignCreateSources = []
        
        -- Callsign deletion confirmation dialog initialization
        , deleteCallsignConfirmation = Nothing
        , deleteCallsignLoading = False
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


type Msg
    = CallsignsReturnedByApi (Result ApiError B.SingleNetworkCallsignsListRsp)
    | NetworkReturnedByApi (Result ApiError B.Network)
    | MapPointsReturnedByApi (Result ApiError B.ListNetworkPointsRsp)
    | GroupsActivityReturnedByApi (Result ApiError GroupsByDate)
    | NetworkFreqsActivityReturnedByApi (Result ApiError (Dict String (Dict String Int)))
    | FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | CallsignsPopupOpenedByUser String
    | CallsignsPopupClosedByUser
    | NetworkEditStartedByUser
    | NetworkEditingSavedByUser
    | NetworkEditingCanceledByUser
    | NetworkEditingMsg B.UpdateNetworkReq
    | MissingFieldsEditStartedByUser
    | MissingFieldsEditSavedByUser
    | MissingFieldsEditCanceledByUser
    | MissingFieldsEditingMsg B.UpdateNetworkReq
    | MissingFieldsUpdatedByApi (Result ApiError B.Network)
    | FreqsEditingMsg B.UpdateNetworkFreqReq
    | FreqsEditStartedByUser
    | FreqsEditSavedByUser
    | FreqsEditCanceledByUser
    | FreqUpdatedByApi (Result ApiError B.Network)
    | NetworkUpdatedByApi (Result ApiError B.Network)
    | NetworkPostsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | NetworkUnitsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | EditNetworkKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkEditPostsSelMsg (Select.Msg Int)
    | NetworkEditUnitsSelMsg (Select.Msg Int)
    | NetworkEditAorSelMsg (Select.Msg Int)
    | AorListReturnedByApi (Result ApiError (List B.AreaOfResponsibility))
    | DescriptionAddClickedByUser Int B.NetworkDescrType
    | NetworkDescriptionAdded B.NetworkDescrType (Result ApiError B.Network)
    | ConfirmationInputChangedByUser String
    | SignsInputChangedByUser String
    | SignalsForNetworkLoaded (Result ApiError B.NetworkSignalsListRes)
    | DescriptionDeleteClickedByUser B.NetworkDescription
    | DescriptionEditClickedByUser B.NetworkDescription
    | DescriptionEditSave B.NetworkDescription
    | DescriptionEditUpdated Int (Result ApiError B.Network)
    | DescriptionEditedByUser Int String
    | DescriptionDeleted (Result ApiError B.Network)
    | AddConfirmationFreqSelMsg (Select.Msg String)
    | ReportModalOpenedByUser
    | ReportModalClosedByUser
    | ReportDownloadClickedByUser
    | ReportDownloadReturnedByApi (Result ApiError Bytes)
    | ReportNetworksOnlyCheckedByUser Bool
    | ReportActiveFreqsOnlyCheckedByUser Bool
    | ReportIncludePelengsMapCheckedByUser Bool
    | ReportIncludeConfirmationCheckedByUser Bool
    | ReportIncludeSigintSignsCheckedByUser Bool
    | FreqsActivityFilterChangedByUser FreqActivityFilter
    | SetFreqsTableState Table.State
    | SetCallsignsTableState Table.State
    | NetworkCallsignsReturnedByApi (Result ApiError B.ListNetworkCallsignsRes)
    | SetNetworkCallsignsTableState Table.State
    | OpenFreqEditSidebar String B.UpdateNetworkFreqReq
    | CloseFreqEditSidebar
    | UpdateFreqEditSidebar B.UpdateNetworkFreqReq
    | SaveFreqEditSidebar
    | OpenFreqDetailPopup String
    | CloseFreqDetailPopup
    | ModulationsReturnedByApi (Result ApiError (List B.ModulationRec))
    | GotSources (Result ApiError B.ListSourcesRsp)
    | FreqKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqModulationSelectMsg (Select.Msg Int)
    | ToggleFreqEditShowActiveTo
    | DeleteNetworkClickedByUser
    | DeleteNetworkConfirmedByUser
    | DeleteNetworkCanceledByUser
    | DeleteNetworkReturnedByApi (Result ApiError B.Network)
      -- Frequency creation messages
    | OpenFreqCreateSidebar
    | CloseFreqCreateSidebar
    | UpdateFreqCreateField (B.AddNetworkFreq -> B.AddNetworkFreq)
    | FreqCreateKindSelectMsg (Select.Msg NetworksUtils.NetworkKind)
    | FreqCreateModulationSelectMsg (Select.Msg Int)
    | FreqCreateDescriptionInputChangedByUser String
    | ToggleFreqCreateShowActiveTo
    | AddFreqToNetwork
    | FreqAddedToNetwork (Result ApiError B.Network)
    | DeleteFreqClickedByUser Int String
    | DeleteFreqConfirmedByUser
    | DeleteFreqCanceledByUser
    | DeleteFreqReturnedByApi (Result ApiError B.Network)
    
    -- Network callsign creation messages
    | OpenCallsignCreateSidebar
    | CloseCallsignCreateSidebar
    | UpdateCallsignCreateField (Maybe B.CreateNetworkCallsignReq -> Maybe B.CreateNetworkCallsignReq)
            | CreateCallsignClicked
        | CallsignCreated (Result ApiError B.NetworkCallsign)
        | CallsignCreateSourceSelMsg (Select.Msg Int)
    
    -- Callsign selection and adding functionality
    | ToggleCallsignSelection Int                    -- Перемикання виділення позивного
    | AddSelectedCallsignsToNetwork                     -- Додавання виділених позивних до мережі
    | CallsignsAddedToNetwork (Result ApiError (List B.NetworkCallsign))  -- Результат додавання (тепер список)
    
    -- Callsign deletion functionality
    | DeleteCallsignFromNetwork Int                    -- Клік по кнопці видалення позивного з мережі
    | DeleteCallsignConfirmed Int                      -- Підтвердження видалення позивного
    | DeleteCallsignCanceled                           -- Скасування видалення позивного
    | CallsignDeletedFromNetwork (Result ApiError B.NetworkCallsign) -- Результат видалення позивного


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        CallsignsReturnedByApi (Err e) ->
            ( { model | callsigns = Failure e }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" e
            )

        CallsignsReturnedByApi (Ok res) ->
            ( { model | callsigns = Success res.callsigns }, E.none )

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
            ( model, E.networkDeleteDescription DescriptionDeleted { descriptionId = description.id, networkId = description.networkId } )

        DescriptionEditClickedByUser description ->
            ( { model | descriptionsEditDict = Dict.insert description.id description model.descriptionsEditDict }, E.none )

        DescriptionEditedByUser descId newDescription ->
            let
                descEditDict =
                    case Dict.get descId model.descriptionsEditDict of
                        Just d ->
                            Dict.update descId (\_ -> Just { d | description = newDescription }) model.descriptionsEditDict

                        Nothing ->
                            model.descriptionsEditDict
            in
            ( { model | descriptionsEditDict = descEditDict }, E.none )

        DescriptionEditSave description ->
            ( model
            , E.networkUpdateDescription (DescriptionEditUpdated description.id)
                { networkId = description.networkId
                , descriptionId = description.id
                , descrType = description.descrType
                , description = description.description
                , networkFreqId = Nothing --TOOD
                }
            )

        DescriptionEditUpdated _ (Err e) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення опису мережі" e
            )

        DescriptionEditUpdated descrId (Ok res) ->
            ( { model | network = Success res, descriptionsEditDict = Dict.remove descrId model.descriptionsEditDict }, E.none )

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
            ( { model | reportNetworksOnly = isChecked }, E.none )

        ReportActiveFreqsOnlyCheckedByUser isChecked ->
            ( { model | reportActiveFreqsOnly = isChecked }, E.none )

        ReportIncludePelengsMapCheckedByUser isChecked ->
            ( { model | reportIncludePelengsMap = isChecked }, E.none )

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
            ( { model | networkCallsigns = Success res.networkCallsigns }, E.none )

        SetNetworkCallsignsTableState newState ->
            ( { model | networkCallsignsTableState = newState }, E.none )

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
                            , sourceId = 1  -- Default source ID
                            , radioFreq = Nothing
                            }
                        
                    in
                    ( { model 
                        | callsignCreateSidebar = True
                        , callsignCreateState = Just updatedState
                        , callsignCreateErrors = Dict.empty
                      }
                    , E.none )
                
                _ ->
                    ( model, E.none )
        
        CloseCallsignCreateSidebar ->
            ( { model
                | callsignCreateSidebar = False
                , callsignCreateState = Nothing
                , callsignCreateErrors = Dict.empty
                , callsignCreateSourceSelState = Select.initState (Select.selectIdentifier "callsign-create-source-state")
                , callsignCreateSources = []
              }
            , E.none )
        
        UpdateCallsignCreateField updateFunc ->
            ( { model | callsignCreateState = updateFunc model.callsignCreateState }
            , E.none )
        
        CreateCallsignClicked ->
            case model.callsignCreateState of
                Just createReq ->
                    ( { model | callsignCreateSaving = True }
                    , E.createNetworkCallsign CallsignCreated createReq
                    )
                
                Nothing ->
                    ( model, E.none )
        
        CallsignCreated (Ok networkCallsign) ->
            ( { model 
                | callsignCreateSaving = False
                , callsignCreateSidebar = False
                , callsignCreateState = Nothing
                , callsignCreateErrors = Dict.empty
                , networkCallsigns = 
                    case model.networkCallsigns of
                        Success existingCallsigns ->
                            Success (networkCallsign :: existingCallsigns)
                        
                        _ ->
                            Success [ networkCallsign ]
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
                    Le.Block.Select.singleUpd mAction (Maybe.map .sourceId model.callsignCreateState)
            in
            ( { model
                | callsignCreateSourceSelState = imodel2
                , callsignCreateState = 
                    Maybe.map (\state -> { state | sourceId = Maybe.withDefault 1 updatedSourceId }) model.callsignCreateState
              }
            , E.sendCmd <| Cmd.map CallsignCreateSourceSelMsg icmd
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

        -- Callsign selection and adding functionality
        ToggleCallsignSelection knownCallsignId ->
            let
                newSelected = 
                    if Set.member knownCallsignId model.callsignsSelected then
                        Set.remove knownCallsignId model.callsignsSelected
                    else
                        Set.insert knownCallsignId model.callsignsSelected
            in
            ( { model | callsignsSelected = newSelected }, E.none )

        AddSelectedCallsignsToNetwork ->
            let
                networkId = 
                    case model.network of
                        Success network -> network.id
                        _ -> 0
                
                payload = 
                    { networkId = networkId
                    , knownCallsignIds = Set.toList model.callsignsSelected
                    }
            in
            ( { model | callsignsAddLoading = True }
            , E.addMultipleCallsignsToNetwork CallsignsAddedToNetwork payload
            )

        CallsignsAddedToNetwork (Err e) ->
            ( { model | callsignsAddLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання позивних до мережі" e
            )

        CallsignsAddedToNetwork (Ok networkCallsigns) ->
            let
                -- Оновлюємо networkCallsigns, додаючи нові
                updatedNetworkCallsigns = 
                    case model.networkCallsigns of
                        Success existing ->
                            Success (existing ++ networkCallsigns)
                        _ ->
                            Success networkCallsigns
                
                -- Очищаємо виділення та стан завантаження
                updatedModel = 
                    { model 
                    | networkCallsigns = updatedNetworkCallsigns
                    , callsignsAddLoading = False
                    , callsignsSelected = Set.empty
                    }
            in
            ( updatedModel, E.none )
            
        DeleteCallsignFromNetwork callsignId ->
            ( { model | deleteCallsignConfirmation = Just callsignId }, E.none )
            
        DeleteCallsignConfirmed callsignId ->
            ( { model | deleteCallsignLoading = True, deleteCallsignConfirmation = Nothing }
            , E.none ) -- TODO: Add API call
            
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
            in
            ( { model 
                | deleteCallsignLoading = False
                , networkCallsigns = updatedNetworkCallsigns
              }
            , E.none )
            
        CallsignDeletedFromNetwork (Err error) ->
            ( { model | deleteCallsignLoading = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення позивного з мережі" error
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- TABLE CONFIGURATION


freqsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.NetworkFreqsRes Msg
freqsTableConfig shared model user =
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

        customRowAttrs : B.NetworkFreqsRes -> List (Html.Attribute Msg)
        customRowAttrs freq =
            if not freq.isActive then
                [ class "bg-[#f8f9fa] dark:bg-[#2C2C2E]" ]

            else
                []

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
                , rowAttrs = customRowAttrs
            }
    in
    Table.customConfig
        { toId = .freq
        , toMsg = SetFreqsTableState
        , columns =
            [ Table.stringColumn "Частота" .freq |> Table.withColumnWidth "9%"
            , Table.customColumn
                { name = "Модуляція"
                , viewData = \freq -> Maybe.withDefault "" freq.modulation
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault "" freq.modulation)
                }
                |> Table.withColumnWidth "10%"
            , Table.customColumn
                { name = "Тип"
                , viewData =
                    \freq ->
                        Maybe.withDefault "" freq.kind
                            |> NetworksUtils.networkKindFromString
                            |> NetworksUtils.networkKindToLabel
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault "" freq.kind)
                }
                |> Table.withColumnWidth "8%"
            , Table.intColumn "Кількість перехоплень" .messageCount |> Table.withColumnWidth "6%"
            , Table.veryCustomColumn
                { name = "Позивні"
                , viewData =
                    \freq ->
                        case freq.callsigns of
                            Just callsigns ->
                                let
                                    isOpen =
                                        case model.callsignsOpenedPopupId of
                                            Just openCallsignsPopup ->
                                                openCallsignsPopup == freq.freq

                                            Nothing ->
                                                False
                                in
                                { attributes = []
                                , children =
                                    [ CallsignsPopup.view
                                        { isOpened = isOpen
                                        , onClose = CallsignsPopupClosedByUser
                                        , onOpen = CallsignsPopupOpenedByUser freq.freq
                                        , callsigns = callsigns
                                        , callsignsInfo = shared.callsignsInfo
                                        , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                                        }
                                        (FreqsPage
                                            freq.freq
                                            (RD.withDefault Dict.empty shared.networks)
                                        )
                                    ]
                                }

                            _ ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Останній раз в етері"
                , viewData =
                    \freq ->
                        case freq.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дата прив'язки"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix freq.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Активність"
                , viewData =
                    \freq ->
                        case model.networkFreqsActivity of
                            Success data ->
                                case Dict.get freq.freq data of
                                    Just freqActivity ->
                                        let
                                            freqActivityJson =
                                                Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freq.freq freqActivity)
                                        in
                                        { attributes = []
                                        , children =
                                            [ div [ style "width" "150px", style "height" "60px", style "cursor" "pointer", style "position" "relative", style "border-radius" "4px", style "transition" "all 0.2s ease", onClick (OpenFreqDetailPopup freq.freq) ]
                                                [ Html.node "freq-activity-chart"
                                                    [ property "data" <| freqActivityJson
                                                    , property "lastDay" <| Encode.int shared.now
                                                    ]
                                                    []
                                                , i [ class "bi bi-zoom-in", style "position" "absolute", style "top" "0", style "right" "4px", style "font-size" "12px", style "color" "#6b7280", style "opacity" "0.7", style "pointer-events" "none", style "z-index" "10", style "transition" "all 0.2s ease" ] []
                                                ]
                                            ]
                                        }

                                    Nothing ->
                                        { attributes = []
                                        , children = [ text "Немає активності" ]
                                        }

                            _ ->
                                { attributes = []
                                , children = [ Le.Block.Spinner.loadingSpinnerSm ]
                                }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "З"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix freq.activeFrom) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .activeFrom
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "По"
                , viewData =
                    \freq ->
                        case freq.activeTo of
                            Just x ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.activeTo)
                }
                |> Table.withColumnWidth "8%"
            ]
                ++ (if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                        [ Table.veryCustomColumn
                            { name = "Дії"
                            , viewData =
                                \freq ->
                                    { attributes = []
                                    , children =
                                        [ case model.network of
                                            Success network ->
                                                div [ class "flex items-center gap-2" ]
                                                    [ button
                                                    [ class "table-action-btn"
                                                    , type_ "button"
                                                    , onClick <|
                                                        OpenFreqEditSidebar freq.freq
                                                            { networkId = network.id
                                                            , freq = freq.freq
                                                            , kind = Maybe.withDefault "VHF" freq.kind
                                                            , modulationId = freq.modulationId
                                                            , activeFrom = freq.activeFrom
                                                            , activeTo = freq.activeTo
                                                            }
                                                    ]
                                                        [ i [ class "bi bi-pencil-square" ] [] ]
                                                    , button
                                                        [ class "table-action-btn text-red-600 hover:text-red-700"
                                                        , type_ "button"
                                                        , title "Видалити частоту"
                                                        , onClick (DeleteFreqClickedByUser freq.networkFreqId freq.freq)
                                                        ]
                                                        [ i [ class "bi bi-trash" ] [] ]
                                                    ]

                                            _ ->
                                                text ""
                                        ]
                                    }
                            , sorter = TableSorter.unsortable
                            }
                            |> Table.withColumnWidth "8%"
                        ]

                    else
                        []
                   )
        , customizations = customizations
        }


callsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config CallsignTableRow Msg
callsignsTableConfig shared model user =
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
        { toId = .callsign
        , toMsg = SetCallsignsTableState
        , columns =
            [ Table.veryCustomColumn
                { name = ""
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ Checkbox.new 
                                { isChecked = Set.member row.id model.callsignsSelected
                                , onToggle = \_ -> ToggleCallsignSelection row.id
                                }
                                |> Checkbox.view
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "5%"
            , Table.veryCustomColumn
                { name = "Позивний"
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ div [ class "flex items-center flex-wrap" ]
                                [ text <| String.toUpper row.callsign
                                , a
                                    [ href (createAnalysisUrl shared model row.callsign)
                                    , target "_blank"
                                    , title "Відкрити позивний в аналізі"
                                    , class "ml-2"
                                    ]
                                    [ i [ class "bi bi-box-arrow-up-right text-action text-sm" ] [] ]
                                ]
                            ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .callsign
                }
                |> Table.withColumnWidth "12%"
            , Table.intColumn "К-сть" .messageCount |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Останній раз в етері"
                , viewData =
                    \row ->
                        case row.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\row -> Maybe.withDefault 0 row.lastDatetime)
                }
                |> Table.withColumnWidth "12%"
            , Table.stringColumn "Посада" .position |> Table.withColumnWidth "25%"
            , Table.stringColumn "Підрозділ" .unitName |> Table.withColumnWidth "16%"
            , Table.stringColumn "Коментар" .comment |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Дата прив'язки"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix row.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "12%"
            , Table.stringColumn "Джерело" .sourceName |> Table.withColumnWidth "10%"
            ]
        , customizations = customizations
        }


networkCallsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.NetworkCallsign Msg
networkCallsignsTableConfig shared model user =
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
        { toId = String.fromInt << .id
        , toMsg = SetNetworkCallsignsTableState
        , columns =
            [ Table.stringColumn "Позивний" .callsign |> Table.withColumnWidth "18%"
            , Table.stringColumn "Посада" (.position >> Maybe.withDefault "-") |> Table.withColumnWidth "20%"
            , Table.stringColumn "Коментар" (.comment >> Maybe.withDefault "-") |> Table.withColumnWidth "25%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = 
                            [ case row.sourceId of
                                Just sourceId ->
                                    case ListX.find (\s -> s.id == sourceId) model.callsignCreateSources of
                                        Just source ->
                                            text source.name
                                        Nothing ->
                                            text (String.fromInt sourceId)
                                Nothing ->
                                    text "-"
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Дата створення"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix row.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "12%"
            , Table.intColumn "К-сть повідомлень" .messageCount |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дії"
                , viewData =
                    \row ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ div [ class "flex gap-[4px] text-sm" ]
                                [ button
                                    [ title "Видалити"
                                    , class "icon-btn icon-btn-danger"
                                    , onClick (DeleteCallsignFromNetwork row.id)
                                    ]
                                    [ i [ class "bi bi-trash" ] [] ]
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "5%"
            ]
        , customizations = customizations
        }



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
                            Le.Block.Select.defaultOptions shared.isDarkMode
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
                            Le.Block.Select.defaultOptions shared.isDarkMode
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


filterFreqsByActivity : FreqActivityFilter -> List B.NetworkFreqsRes -> List B.NetworkFreqsRes
filterFreqsByActivity filter freqs =
    case filter of
        AllFreqs ->
            freqs

        ActiveFreqs ->
            List.filter .isActive freqs

        InactiveFreqs ->
            List.filter (\freq -> not freq.isActive) freqs


emptyFreqsPlaceholder : FreqActivityFilter -> Html msg
emptyFreqsPlaceholder filter =
    let
        message =
            case filter of
                AllFreqs ->
                    "Немає частот в мережі"

                ActiveFreqs ->
                    "Немає активних частот"

                InactiveFreqs ->
                    "Немає неактивних частот"
    in
    div
        [ class "flex flex-col items-center justify-center py-12 text-center" ]
        [ i [ class "bi bi-radio-tower text-4xl text-gray-400 mb-4" ] []
        , p [ class "text-gray-600 dark:text-gray-400 text-lg font-medium" ] [ text message ]
        , p [ class "text-gray-500 dark:text-gray-500 text-sm mt-2" ]
            [ text "Спробуйте змінити фільтр або перевірте налаштування мережі" ]
        ]


freqsActivityFilterView : Model -> Html Msg
freqsActivityFilterView model =
    let
        options =
            [ { value = AllFreqs, label = "Всі" }
            , { value = ActiveFreqs, label = "Активні" }
            , { value = InactiveFreqs, label = "Неактивні" }
            ]
    in
    div [ class "flex gap-2 items-center mb-4" ]
        [ SegmentedControl.new model.freqsActivityFilter FreqsActivityFilterChangedByUser options
            |> SegmentedControl.view
        ]


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


activityEditBlock : Auth.User -> B.Network -> B.UpdateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
activityEditBlock user network updNetworkReq shared model =
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


freqsTable : B.NetworkFreqsRes -> Model -> Shared.Model -> Html Msg
freqsTable freq model shared =
    let
        rowAttrs =
            if not freq.isActive then
                [ style "background-color" "var(--color-bg-inactive)" ]

            else
                []
    in
    tr rowAttrs
        [ td [] [ text freq.freq ]
        , td [] [ text <| Maybe.withDefault "" freq.modulation ]
        , td [] [ text <| String.fromInt freq.messageCount ]
        , td []
            [ case freq.callsigns of
                Just callsigns ->
                    let
                        isOpen =
                            case model.callsignsOpenedPopupId of
                                Just openCallsignsPopup ->
                                    openCallsignsPopup == freq.freq

                                Nothing ->
                                    False
                    in
                    CallsignsPopup.view
                        { isOpened = isOpen
                        , onClose = CallsignsPopupClosedByUser
                        , onOpen = CallsignsPopupOpenedByUser freq.freq
                        , callsigns = callsigns
                        , callsignsInfo = shared.callsignsInfo
                        , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                        }
                        (FreqsPage
                            freq.freq
                            (RD.withDefault Dict.empty shared.networks)
                        )

                _ ->
                    text ""
            ]
        , td []
            [ case model.networkFreqsActivity of
                Success data ->
                    case Dict.get freq.freq data of
                        Just freqActivity ->
                            let
                                freqActivityJson =
                                    Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freq.freq freqActivity)
                            in
                            div [ style "width" "150px", style "height" "60px" ]
                                [ Html.node "freq-activity-chart"
                                    [ property "data" <| freqActivityJson
                                    , property "lastDay" <| Encode.int shared.now
                                    ]
                                    []
                                ]

                        Nothing ->
                            text "Немає активності"

                _ ->
                    Le.Block.Spinner.loadingSpinnerSm
            ]
        , td []
            [ case freq.lastDatetime of
                Just lastDatetime ->
                    text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix lastDatetime)

                Nothing ->
                    text ""
            ]
        , td []
            [ text <|
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix freq.createdAt)
            ]
        , td []
            [ text <|
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix freq.activeFrom)
            ]
        , td []
            [ case freq.activeTo of
                Just x ->
                    text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix x)

                Nothing ->
                    text ""
            ]
        ]


freqsTableEditing : B.UpdateNetworkFreqReq -> B.NetworkFreqsRes -> Model -> Shared.Model -> Html Msg
freqsTableEditing updateFreqReq freq model shared =
    let
        rowAttrs =
            if not freq.isActive then
                [ style "background-color" "var(--color-bg-inactive)" ]

            else
                []
    in
    tr rowAttrs
        [ td [] [ text freq.freq ]
        , td [] [ text <| Maybe.withDefault "" freq.modulation ]
        , td [] [ text <| String.fromInt freq.messageCount ]
        , case freq.callsigns of
            Just callsigns ->
                let
                    isOpen =
                        case model.callsignsOpenedPopupId of
                            Just openCallsignsPopup ->
                                openCallsignsPopup == freq.freq

                            Nothing ->
                                False
                in
                CallsignsPopup.view
                    { isOpened = isOpen
                    , onClose = CallsignsPopupClosedByUser
                    , onOpen = CallsignsPopupOpenedByUser freq.freq
                    , callsigns = callsigns
                    , callsignsInfo = shared.callsignsInfo
                    , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                    }
                    (FreqsPage
                        freq.freq
                        (RD.withDefault Dict.empty shared.networks)
                    )

            _ ->
                text ""
        , td []
            [ case model.networkFreqsActivity of
                Success data ->
                    case Dict.get freq.freq data of
                        Just freqActivity ->
                            let
                                freqActivityJson =
                                    Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freq.freq freqActivity)
                            in
                            div [ style "width" "150px", style "height" "60px" ]
                                [ Html.node "freq-activity-chart"
                                    [ property "data" <| freqActivityJson
                                    , property "lastDay" <| Encode.int shared.now
                                    ]
                                    []
                                ]

                        Nothing ->
                            text "Немає активності"

                _ ->
                    Le.Block.Spinner.loadingSpinnerSm
            ]
        , td []
            [ case freq.lastDatetime of
                Just lastDatetime ->
                    text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix lastDatetime)

                Nothing ->
                    text "—"
            ]
        , td []
            [ text <|
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix freq.createdAt)
            ]
        , td []
            [ input
                [ type_ "date"
                , Time.millisToPosix updateFreqReq.activeFrom
                    |> Le.Time.renderDateF4 shared.timeZone
                    |> value
                , onInput <|
                    FreqsEditingMsg
                        << (\v ->
                                { updateFreqReq
                                    | activeFrom =
                                        case Le.Time.parseDateParts v of
                                            Err _ ->
                                                updateFreqReq.activeFrom

                                            Ok parts ->
                                                Time.Extra.partsToPosix shared.timeZone parts
                                                    |> Time.posixToMillis
                                }
                           )
                , class "form-control"
                ]
                []
            ]
        , td []
            [ input
                [ type_ "date"
                , Maybe.map Time.millisToPosix updateFreqReq.activeTo
                    |> Maybe.map (Le.Time.renderDateF4 shared.timeZone)
                    |> Maybe.withDefault ""
                    |> value
                , onInput <|
                    FreqsEditingMsg
                        << (\v ->
                                { updateFreqReq
                                    | activeTo = updateActiveToFromInput v shared.timeZone updateFreqReq.activeTo
                                }
                           )
                , class "form-control"
                ]
                []
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
                (case model.mode of
                    Readonly ->
                        activityBlock user network shared model

                    Editing eNetwork ->
                        activityEditBlock user network eNetwork shared model
                )
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
              div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col flex-1" ]
                [ div [ class "mb-[16px]" ]
                    [ h5 [ class "" ] [ text "Обґрунтування прив'язки" ]
                    , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
                        [ textarea [ class "textarea__field", placeholder "Введіть обґрунтування прив'язки", value model.addConfirmationInp, onInput ConfirmationInputChangedByUser ] []
                        , div [ class "flex justify-between w-full" ]
                            [ div [ class "w-[200px]" ]
                                [ let
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
                                        Le.Block.Select.defaultOptions shared.isDarkMode
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
                            , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Confirmation }
                                |> Button.withStyleSecondary
                                |> Button.withDisabled (String.isEmpty model.addConfirmationInp)
                                |> Button.view
                            ]
                        ]
                    , div [ class "max-h-[200px] overflow-y-auto" ]
                        (List.map
                            (\description ->
                                div [ class "min-h-[50px] border-b-1 border-border py-[4px]" ]
                                    [ div [ class "flex justify-between items-center " ]
                                        [ div [ class "opacity-70 flex gap-[4px] items-center" ]
                                            [ span [] [ text description.login ]
                                            , span [] [ text "|" ]
                                            , span [ class "text-[13px]" ] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
                                            , span [ class "text-[13px]" ]
                                                [ description.networkFrequencyId
                                                    |> Maybe.andThen
                                                        (\freqId ->
                                                            ListX.find (\freq -> freq.id == freqId) network.freqs
                                                        )
                                                    |> Maybe.map .freq
                                                    |> (\mFreq ->
                                                            case mFreq of
                                                                Just f ->
                                                                    text ("| " ++ f)

                                                                Nothing ->
                                                                    text ""
                                                       )
                                                ]
                                            ]
                                        , div [ class "flex gap-[8px]" ]
                                            [ case Dict.get description.id model.descriptionsEditDict of
                                                Just desc ->
                                                    i [ class "bi bi-check2 cursor-pointer", onClick <| DescriptionEditSave desc ] []

                                                Nothing ->
                                                    i [ class "bi bi-pencil cursor-pointer", onClick <| DescriptionEditClickedByUser description ] []
                                            , i [ class "bi bi-trash cursor-pointer", onClick <| DescriptionDeleteClickedByUser description ] []
                                            ]
                                        ]
                                    , div []
                                        [ case Dict.get description.id model.descriptionsEditDict of
                                            Just desc ->
                                                textarea
                                                    [ class "textarea__field"
                                                    , placeholder "Введіть обґрунтування прив'язки"
                                                    , value desc.description
                                                    , onInput <| DescriptionEditedByUser desc.id
                                                    ]
                                                    []

                                            Nothing ->
                                                div [ style "white-space" "pre-line" ] [ text description.description ]
                                        ]
                                    ]
                            )
                            (List.sortWith
                                (\a b ->
                                    if a.createdAt > b.createdAt then
                                        LT

                                    else
                                        GT
                                )
                                confirmations
                            )
                        )
                    ]
                , div []
                    [ h5 [ class "" ] [ text "Розвідувальні ознаки" ]
                    , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
                        [ textarea [ class "textarea__field", placeholder "Введіть розвідувальні ознаки", value model.addSignsInp, onInput SignsInputChangedByUser ] []
                        , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Sign }
                            |> Button.withStyleSecondary
                            |> Button.withDisabled (String.isEmpty model.addSignsInp)
                            |> Button.view
                        ]
                    , div [ class "max-h-[200px] overflow-y-auto" ]
                        (List.map
                            (\description ->
                                div [ class "min-h-[50px] border-b-1 border-border py-[4px]" ]
                                    [ div [ class "flex justify-between items-center " ]
                                        [ div [ class "opacity-70 flex gap-[4px] items-center" ]
                                            [ span [] [ text description.login ]
                                            , span [] [ text "|" ]
                                            , span [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
                                            ]
                                        , div [ class "flex gap-[8px]" ]
                                            [ case Dict.get description.id model.descriptionsEditDict of
                                                Just desc ->
                                                    i [ class "bi bi-check2 cursor-pointer", onClick <| DescriptionEditSave desc ] []

                                                Nothing ->
                                                    i [ class "bi bi-pencil cursor-pointer", onClick <| DescriptionEditClickedByUser description ] []
                                            , i [ class "bi bi-trash cursor-pointer", onClick <| DescriptionDeleteClickedByUser description ] []
                                            ]
                                        ]
                                    , div []
                                        [ case Dict.get description.id model.descriptionsEditDict of
                                            Just desc ->
                                                textarea
                                                    [ class "textarea__field"
                                                    , placeholder "Введіть розвідувальні ознаки"
                                                    , value desc.description
                                                    , onInput <| DescriptionEditedByUser desc.id
                                                    ]
                                                    []

                                            Nothing ->
                                                div [ style "white-space" "pre-line" ] [ text description.description ]
                                        ]
                                    ]
                            )
                            (List.sortWith
                                (\a b ->
                                    if a.createdAt > b.createdAt then
                                        LT

                                    else
                                        GT
                                )
                                signs
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
    , section [ class "bg-w dark:bg-[#1C1C21] p-[16px] mt-[30px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Частоти" ]
            , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                button
                    [ title "Додати частоту"
                    , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw! py-[1px] px-[6px]"
                    , onClick OpenFreqCreateSidebar
                    ]
                    [ i [ class "bi bi-plus-lg" ] [] ]

              else
                text ""
            ]
        , freqsActivityFilterView model
        , case model.freqs of
            Success freqs ->
                let
                    filteredFreqs =
                        filterFreqsByActivity model.freqsActivityFilter freqs
                in
                div [ class "table-responsive-modern" ]
                    [ if List.isEmpty filteredFreqs then
                        emptyFreqsPlaceholder model.freqsActivityFilter

                      else
                        Table.view (freqsTableConfig shared model user) model.freqsTableState filteredFreqs
                    ]

            _ ->
                Le.Block.Spinner.loadingSpinnerSm
        ]
    , section [ class "bg-w dark:bg-[#1C1C21] w-full h-[500px] mt-[30px] p-[16px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Позивні мережі" ]
            , Button.new 
                { label = "+"
                , onClick = OpenCallsignCreateSidebar
                }
                |> Button.withStyleSecondary
                |> Button.view
            ]
        , case model.networkCallsigns of
            Success networkCallsigns ->
                div [ class "overflow-y-auto grow-1 mb-4" ]
                    [ Table.view (networkCallsignsTableConfig shared model user) model.networkCallsignsTableState networkCallsigns
                    ]

            Loading ->
                Le.Block.Spinner.loadingSpinnerSm

            Failure e ->
                div [ class "text-red-500" ] [ text "Помилка завантаження позивних мережі" ]

            NotAsked ->
                text ""

            NeedsReload _ ->
                Le.Block.Spinner.loadingSpinnerSm
        , div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Всі позивні" ]
            , div [ class "flex items-center gap-3" ]
                [ div [ class "flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400" ]
                    [ i [ class "bi bi-check-square" ] []
                    , span [] 
                        [ text (if Set.isEmpty model.callsignsSelected then 
                                  "Виберіть позивні"
                                else 
                                  "Виділено: " ++ String.fromInt (Set.size model.callsignsSelected)
                              )
                        ]
                    ]
                , Button.new 
                    { label = "Додати"
                    , onClick = AddSelectedCallsignsToNetwork
                    }
                    |> (if Set.isEmpty model.callsignsSelected then
                            Button.withStyleSecondary
                        else
                            Button.withPrimary
                       )
                    |> (if model.callsignsAddLoading then
                            Button.withIcon [ Le.Block.Spinner.loadingSpinner2Sm ]
                        else
                            identity
                       )
                    |> (if Set.isEmpty model.callsignsSelected then
                            Button.withDisabled True
                        else
                            identity
                       )
                    |> Button.view
                ]
            ]
        , case model.callsigns of
            Success callsigns ->
                div [ class "overflow-y-auto grow-1" ]
                    [ let
                        -- Перетворюємо дані у плоску структуру для таблиці
                        callsignsTableRows =
                            callsigns
                                |> List.concatMap
                                    (\callsign ->
                                        case callsign.knownCallsigns of
                                            Just knownCallsigns ->
                                                List.map
                                                    (\knownCallsign ->
                                                        { id = knownCallsign.id
                                                        , callsign = callsign.callsign
                                                        , messageCount = callsign.messageCount
                                                        , lastDatetime = callsign.lastDatetime
                                                        , position = knownCallsign.position
                                                        , unitName = knownCallsign.unitName
                                                        , comment = knownCallsign.comment
                                                        , createdAt = knownCallsign.createdAt
                                                        , sourceName = knownCallsign.sourceName
                                                        }
                                                    )
                                                    knownCallsigns

                                            Nothing ->
                                                []
                                    )

                        callsignsUnknown =
                            callsigns
                                |> List.filterMap
                                    (\callsign ->
                                        case callsign.knownCallsigns of
                                            Just knownCallsigns ->
                                                if List.isEmpty knownCallsigns then
                                                    Just callsign.callsign

                                                else
                                                    Nothing

                                            Nothing ->
                                                Just callsign.callsign
                                    )
                      in
                      div [ class "table-responsive-modern" ]
                        [ Table.view (callsignsTableConfig shared model user) model.callsignsTableState callsignsTableRows
                        , div [ class "mt-4 p-3 bg-gray-50 dark:bg-gray-800 rounded" ]
                            [ span [ class "font-medium" ] [ text "Приналежність встановлюється: " ]
                            , div [ class "flex flex-wrap gap-[4px] text-[13px] mt-2" ] (List.map (\c -> span [] [ text <| String.toUpper c ]) callsignsUnknown)
                            ]
                        ]
                    ]

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
                , if model.callsignCreateSidebar then
                    Sidebar.view True CloseCallsignCreateSidebar [ callsignCreateSidebarContent shared model user ]

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
                                    ([ Checkbox.new { isChecked = model.reportNetworksOnly, onToggle = ReportNetworksOnlyCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Згідно форми" ] ]
                                        |> Checkbox.view
                                     , Checkbox.new { isChecked = model.reportActiveFreqsOnly, onToggle = ReportActiveFreqsOnlyCheckedByUser }
                                        |> Checkbox.withContent [ span [] [ text "Лише активні частоти" ] ]
                                        |> Checkbox.view
                                     ]
                                        ++ (if not model.reportNetworksOnly then
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
                        Le.Block.Select.defaultOptions shared.isDarkMode
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
                            Le.Block.Select.defaultOptions shared.isDarkMode
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
                            Le.Block.Select.defaultOptions shared.isDarkMode
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
                        Le.Block.Select.defaultOptions shared.isDarkMode
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
                                Le.Block.Select.defaultOptions shared.isDarkMode
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
                                                Just { s | callsign = v }
                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело *" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                        
                        selectItem =
                            Maybe.map .sourceId model.callsignCreateState
                                |> Maybe.andThen (\sourceId -> 
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
                                "Виберіть джерело"
                                (Le.Block.Select.defaultOptions shared.isDarkMode
                                    |> (\opts ->
                                            { opts
                                                | clearable = False
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позиція" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позицію (необов'язково)"
                        , value (Maybe.andThen .position model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just { s | position = if String.trim v == "" then Nothing else Just v }
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
                                                Just { s | comment = if String.trim v == "" then Nothing else Just v }
                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , if (Maybe.map .sourceId model.callsignCreateState |> Maybe.withDefault 1) == 2 then
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
                                                    Just { s | radioFreq = if String.trim v == "" then Nothing else Just v }
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
                                    (Maybe.map .sourceId model.callsignCreateState |> Maybe.withDefault 1) == 2
                                
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
