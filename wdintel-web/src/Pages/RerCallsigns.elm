module Pages.RerCallsigns exposing (AddState, EditCallsignState, Model, Msg, mkAddState, page, processTabDelimitedInput)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Auth
import Core.Types exposing (ApiError)
import Core.UnitHierarchy
import Debounce exposing (Debounce)
import Dict
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DateTime
import Shared.Components.FloatingPopup
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Tag as Tag
import Shared.Components.Watermark as Watermark
import Shared.Model exposing (isDarkMode)
import Task
import Time
import Utils.Api.ErrorHandling
import Utils.EnumeratedList as EL exposing (EnumeratedList)
import Utils.RemoteData exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init req
        , update = update req shared
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "callsigns"
        }


type alias Model =
    { callsigns : List B.Callsign
    , addState : EnumeratedList AddState
    , addParseError : Maybe String
    , addValidationError : Maybe String
    , inpUnitSelState : Select.State
    , inpUnit : Maybe Int
    , editState : Maybe EditCallsignState
    , deleteCallsignConfirmation : Maybe Int
    , deleteDialogOpen : Bool
    , inpSource : Maybe Int
    , sources : List B.Source
    , filterCallsign : String
    , filterPosition : String
    , filterComment : String
    , filterUnit : String
    , filterDeveloping : B.DevelopingFilter
    , filterCallsignDebounce : Debounce String
    , filterPositionDebounce : Debounce String
    , filterCommentDebounce : Debounce String
    , filterUnitDebounce : Debounce String
    , loading : Bool
    , loadingUnitStats : Bool
    , unitStats : List B.CallsignUnitStatRow
    , from : Shared.Components.DateTime.Model
    , to : Shared.Components.DateTime.Model
    , now : Maybe Time.Posix
    , isIgnoringDateFilter : Bool
    , sortingOrder : SortingOrder
    , showLoadMore : Bool
    , loadingMore : Bool
    , downloadCsvInProgress : Bool
    , downloadXlsxInProgress : Bool
    , inpSourceSelState : Select.State
    , inpSourceSelMenu : List (Select.MenuItem Int)
    , expandedArmies : Set.Set String
    , expandedDivisions : Set.Set String
    , expandedRegiments : Set.Set String
    , expandedBattalions : Set.Set String
    , showSidebar : Bool
    , tableState : Table.State
    , sidebarEditing : Bool
    , editingCallsign : Maybe B.Callsign
    , validationError : Maybe String
    , rowShowAllPopupStatus : Maybe ( Int, ShowAllPopupFor )
    }


type ShowAllPopupFor
    = ShowAllComment


type SortingOrder
    = CallsignAsc
    | CallsignDesc
    | CreatedAtAsc
    | CreatedAtDesc
    | UnitAsc
    | UnitDesc
    | Default


init : Route () -> () -> ( Model, Effect Msg )
init req _ =
    let
        mCallsignName =
            Dict.get "callsign" req.query

        m2 : Model
        m2 =
            { callsigns = []
            , addState = EL.fromList [ initAddState mCallsignName ]
            , addParseError = Nothing
            , addValidationError = Nothing
            , inpUnitSelState = Select.initState (Select.selectIdentifier "sel-unit-add")
            , inpUnit = Nothing
            , editState = Nothing
            , deleteCallsignConfirmation = Nothing
            , deleteDialogOpen = False
            , inpSource = Nothing
            , sources = []
            , filterCallsign = Maybe.withDefault "" mCallsignName
            , filterPosition = ""
            , filterComment = ""
            , filterUnit = ""
            , filterDeveloping = B.OnlyNonDeveloping
            , filterCallsignDebounce = Debounce.init
            , filterPositionDebounce = Debounce.init
            , filterCommentDebounce = Debounce.init
            , filterUnitDebounce = Debounce.init
            , loading = True
            , loadingUnitStats = True
            , unitStats = []
            , from = Shared.Components.DateTime.init ()
            , to = Shared.Components.DateTime.init ()
            , now = Nothing
            , isIgnoringDateFilter = True
            , sortingOrder = UnitAsc
            , showLoadMore = False
            , loadingMore = False
            , downloadCsvInProgress = False
            , downloadXlsxInProgress = False
            , inpSourceSelState = Select.initState (Select.selectIdentifier "inpSourceSelState")
            , inpSourceSelMenu = []
            , expandedArmies = Set.empty
            , expandedDivisions = Set.empty
            , expandedRegiments = Set.empty
            , expandedBattalions = Set.empty
            , showSidebar = True
            , tableState = Table.initialSort "Позивний"
            , sidebarEditing = False
            , editingCallsign = Nothing
            , validationError = Nothing
            , rowShowAllPopupStatus = Nothing
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <| Task.perform InitGotTime Time.now
        , E.replaceRoute { path = Route.Path.RerCallsigns, hash = Nothing, query = Dict.remove "callsign" req.query }
        ]
    )


type Msg
    = GotCallsigns (Result ApiError B.ListCallsignsRsp)
    | AddStateMsg Int AddState
    | InpSource String
    | AddUnitSelMsg (Select.Msg Int)
    | EditUnitSelMsg (Select.Msg Int)
    | AddCallsign
    | AddCallsignDone (Result ApiError B.Callsign)
    | EditCallsign Int
    | EditCallsignMsg EditCallsignState
    | EditCallsignSave Int
    | EditCallsignDone Int (Result ApiError B.Callsign)
    | EditCallsignCancel Int
    | DeleteCallsign Int
    | DeleteCallsignConfirm
    | DeleteCallsignCancel
    | DeleteCallsignDone (Result ApiError B.Callsign)
    | ClearInputs
    | GotSources (Result ApiError B.ListSourcesRsp)
    | FilterCallsignMsg String
    | FilterPositionMsg String
    | FilterCommentMsg String
    | FilterUnitMsg String
    | FilterDevelopingMsg B.DevelopingFilter
    | FilterCallsignDebounceMsg Debounce.Msg
    | FilterPositionDebounceMsg Debounce.Msg
    | FilterCommentDebounceMsg Debounce.Msg
    | FilterUnitDebounceMsg Debounce.Msg
    | Refresh
    | DownloadCsv Bool
    | DownloadCsvDone (Result ApiError Bytes)
    | DownloadXlsx Bool
    | DownloadXlsxDone (Result ApiError Bytes)
    | GotUnitStats (Result ApiError B.CallsignUnitStatsRsp)
    | DateTimeFromMsg (Shared.Components.DateTime.Msg Msg)
    | DateTimeToMsg (Shared.Components.DateTime.Msg Msg)
    | InitGotTime Time.Posix
    | ToggleIsIgnoringDateFilter Bool
    | SortByCallsignName
    | SortByCreatedAt
    | SortByUnit
    | LoadMore
    | InpSourceSelMsg (Select.Msg Int)
    | ToggleArmyExpanded String
    | ToggleDivisionExpanded String String
    | ToggleRegimentExpanded String String String
    | ToggleBattalionExpanded String String String String
    | ClearFilters
    | ToggleSidebar
    | SetTableState Table.State
    | OpenEditSidebar B.Callsign
    | CloseEditSidebar
    | SaveEditSidebar
    | CancelEditSidebar
    | RowShowAllPopupChanged (Maybe ( Int, ShowAllPopupFor ))


type alias AddState =
    { inpCallsign : String
    , inpPosition : String
    , inpFullName : String
    , inpComment : String
    , inpDeveloping : Bool
    , inpRadioFreq : String
    }


type alias EditCallsignState =
    { inpCallsign : String
    , inpPosition : String
    , inpFullName : String
    , inpComment : String
    , inpUnitId : Int
    , inpUnitSelState : Select.State
    , inpUnitSelMenu : List (Select.MenuItem Int)
    , inpSourceId : Maybe Int
    , inpDeveloping : Bool
    , inpRadioFreq : String
    }


initAddState : Maybe String -> AddState
initAddState mCallsignName =
    { inpCallsign = Maybe.withDefault "" mCallsignName, inpPosition = "", inpFullName = "", inpComment = "", inpDeveloping = False, inpRadioFreq = "" }


quickPasteTsvFormatError : String
quickPasteTsvFormatError =
    "Швидка вставка підтримує лише TSV-формат: позивний, посада, коментар або позивний, посада, ПІП, коментар"


roSourceId : Int
roSourceId =
    2


roSourceRadioFreqRequiredError : String
roSourceRadioFreqRequiredError =
    "При виборі джерела 'РО' необхідно вказати частоту"


isRoSource : Maybe Int -> Bool
isRoSource sourceId =
    sourceId == Just roSourceId


hasAnyAddStateInput : AddState -> Bool
hasAnyAddStateInput addState =
    List.any (\value -> not (String.isEmpty (String.trim value)))
        [ addState.inpCallsign
        , addState.inpPosition
        , addState.inpFullName
        , addState.inpComment
        , addState.inpRadioFreq
        ]
        || addState.inpDeveloping


getAddValidationError : Maybe Int -> EnumeratedList AddState -> Maybe String -> Maybe String
getAddValidationError sourceId addState parseError =
    case parseError of
        Just err ->
            Just err

        Nothing ->
            if isRoSource sourceId
                && (addState
                        |> EL.toList
                        |> List.any
                            (\state ->
                                hasAnyAddStateInput state
                                    && String.isEmpty (String.trim state.inpRadioFreq)
                            )
                   )
            then
                Just roSourceRadioFreqRequiredError

            else
                Nothing



-- Helper function to convert frontend sorting to backend sorting


sortingOrderToBackendSort : SortingOrder -> List B.ListCallsignsSortBy
sortingOrderToBackendSort order =
    case order of
        CallsignAsc ->
            [ B.CallsignAsc ]

        CallsignDesc ->
            [ B.CallsignDesc ]

        CreatedAtAsc ->
            [ B.CallsignCreatedAtAsc ]

        CreatedAtDesc ->
            [ B.CallsignCreatedAtDesc ]

        UnitAsc ->
            [ B.CallsignUnitAsc ]

        UnitDesc ->
            [ B.CallsignUnitDesc ]

        Default ->
            []


developingFilterToValue : B.DevelopingFilter -> String
developingFilterToValue developingFilter =
    case developingFilter of
        B.OnlyDeveloping ->
            "only-developing"

        B.OnlyNonDeveloping ->
            "only-non-developing"

        B.All ->
            "all"


parseDevelopingFilter : String -> B.DevelopingFilter
parseDevelopingFilter value =
    case value of
        "only-developing" ->
            B.OnlyDeveloping

        "only-non-developing" ->
            B.OnlyNonDeveloping

        "all" ->
            B.All

        _ ->
            B.OnlyDeveloping



-- Use backend default


initLoad : Model -> Effect Msg
initLoad model =
    E.batch
        [ loadCallsigns model
        , loadSources
        , loadUnitStats
        ]



-- Helper function to populate unit menu from shared masterUnits


populateUnitMenu : Shared.Model -> List (Select.MenuItem Int)
populateUnitMenu shared =
    case shared.masterUnits of
        Success units ->
            List.map (\u -> Select.basicMenuItem { item = u.id, label = u.name }) (Dict.values units)

        _ ->
            []


buildListCallsignsReq : Model -> { afterId : Maybe Int, limit : Maybe Int } -> B.ListCallsignsReq
buildListCallsignsReq model params =
    { afterId = params.afterId
    , beforeId = Nothing
    , filterText = Nothing
    , filterCallsign = Just model.filterCallsign
    , filterPosition = Just model.filterPosition
    , filterFullName = Nothing
    , filterComment = Just model.filterComment
    , filterUnit = Just model.filterUnit
    , filterUnitArmy = Nothing
    , filterUnitDivision = Nothing
    , filterUnitRegiment = Nothing
    , filterUnitBattalion = Nothing
    , filterDeveloping = Just model.filterDeveloping
    , sinceDateInclusiveMs =
        if model.isIgnoringDateFilter then
            Nothing

        else
            Maybe.map Time.posixToMillis model.from.datePosix
    , tillDateInclusiveMs =
        if model.isIgnoringDateFilter then
            Nothing

        else
            Maybe.map Time.posixToMillis model.to.datePosix
    , limit = params.limit
    , sortBy = Just (sortingOrderToBackendSort model.sortingOrder)
    }


loadCallsignsCmd : Model -> Cmd Msg
loadCallsignsCmd model =
    Api.sigint_list_callsigns GotCallsigns
        (buildListCallsignsReq model { afterId = Nothing, limit = Just 100 })


loadMoreCallsignsCmd : Model -> Cmd Msg
loadMoreCallsignsCmd model =
    case List.reverse model.callsigns |> List.head of
        Nothing ->
            Cmd.none

        Just lastCallsign ->
            Api.sigint_list_callsigns GotCallsigns
                (buildListCallsignsReq model { afterId = Just lastCallsign.id, limit = Just 100 })


loadCallsigns : Model -> Effect Msg
loadCallsigns model =
    E.sendCmd (loadCallsignsCmd model)


potentialDuplicates : Model -> List B.Callsign
potentialDuplicates model =
    let
        callsignInput =
            String.toLower (String.trim (EL.toList model.addState |> List.head |> Maybe.map .inpCallsign |> Maybe.withDefault ""))

        positionInput =
            String.toLower (String.trim (EL.toList model.addState |> List.head |> Maybe.map .inpPosition |> Maybe.withDefault ""))

        unitIdInput =
            model.inpUnit

        anyInput =
            not (String.isEmpty callsignInput) || not (String.isEmpty positionInput) || unitIdInput /= Nothing

        matchesCallsign userInput callsignField =
            String.isEmpty userInput
                || (not (String.isEmpty callsignField) && String.contains userInput (String.toLower callsignField))

        matchesPosition userInput positionField =
            String.isEmpty userInput
                || (not (String.isEmpty positionField) && String.contains userInput (String.toLower positionField))

        matchesUnit userUnitId callsignUnitId =
            userUnitId == Nothing || userUnitId == Just callsignUnitId
    in
    if anyInput then
        model.callsigns
            |> List.filter
                (\callsign ->
                    matchesCallsign callsignInput callsign.callsign
                        && matchesPosition positionInput callsign.position
                        && matchesUnit unitIdInput callsign.unitId
                )

    else
        []


loadSources : Effect Msg
loadSources =
    E.sendCmd <|
        Api.sigint_list_sources GotSources
            ()


loadUnitStats : Effect Msg
loadUnitStats =
    E.sendCmd <| Api.sigint_callsign_unit_stats GotUnitStats ()


filterCallsignDebounceConfig : Debounce.Config Msg
filterCallsignDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterCallsignDebounceMsg
    }


filterPositionDebounceConfig : Debounce.Config Msg
filterPositionDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterPositionDebounceMsg
    }


filterCommentDebounceConfig : Debounce.Config Msg
filterCommentDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterCommentDebounceMsg
    }


filterUnitDebounceConfig : Debounce.Config Msg
filterUnitDebounceConfig =
    { strategy = Debounce.later 300
    , transform = FilterUnitDebounceMsg
    }


update : Route () -> Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update _ shared msg model =
    case msg of
        InitGotTime now_ ->
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
            ( m2
            , initLoad m2
            )

        GotCallsigns (Err err) ->
            ( { model | loading = False, loadingMore = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" err
            )

        GotCallsigns (Ok rsp) ->
            let
                m2 =
                    { model
                        | callsigns =
                            if model.loadingMore then
                                model.callsigns ++ rsp.callsigns

                            else
                                rsp.callsigns
                        , loading = False
                        , loadingMore = False
                        , showLoadMore = rsp.showLoadMore
                    }
            in
            ( m2, E.none )

        AddStateMsg pos state ->
            let
                isTabDelimitedInput =
                    pos == 0 && (String.contains "\t" state.inpCallsign || String.contains "\n" state.inpCallsign)

                parseResult : Result String (List AddState)
                parseResult =
                    if isTabDelimitedInput then
                        processTabDelimitedInput state.inpCallsign
                    else
                        Ok []

                addState =
                    case parseResult of
                        Ok parsedRows ->
                            if pos > 0 || parsedRows == [] then
                                EL.setAtPos pos state model.addState

                            else
                                parsedRows |> EL.fromList

                        Err _ ->
                            EL.setAtPos pos state model.addState

                parseError =
                    case parseResult of
                        Err err ->
                            Just err

                        Ok _ ->
                            Nothing
            in
            ( { model
                | addState = addState
                , addParseError = parseError
                , addValidationError =
                    getAddValidationError model.inpSource addState parseError
              }
            , E.none
            )

        InpSource v ->
            let
                updatedSourceId =
                    String.toInt v
            in
            ( { model
                | inpSource = updatedSourceId
                , addParseError = model.addParseError
                , addValidationError =
                    getAddValidationError updatedSourceId model.addState model.addParseError
              }
            , E.none
            )

        AddUnitSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpUnitSelState

                mUnitId =
                    Utils.Select.singleUpd mAction model.inpUnit

                mUnit =
                    mUnitId
                        |> andThen
                            (\unitId ->
                                case shared.masterUnits of
                                    Success units ->
                                        ListX.find (\y -> y.id == unitId) (Dict.values units)

                                    _ ->
                                        Nothing
                            )

                -- Only update filterUnit if there's an actual selection change
                shouldUpdateFilter =
                    case mAction of
                        Just (Select.Select item) ->
                            case model.inpUnit of
                                Just currentId ->
                                    item /= currentId

                                Nothing ->
                                    True

                        _ ->
                            False

                m2 =
                    { model
                        | inpUnitSelState = iState
                        , inpUnit = mUnitId
                        , filterUnit =
                            if shouldUpdateFilter then
                                mUnit |> mmap .name |> def ""

                            else
                                model.filterUnit
                    }
            in
            ( m2
            , E.batch
                [ E.sendCmd <| Cmd.map AddUnitSelMsg iCmd
                , if shouldUpdateFilter then
                    E.sendCmd <| loadCallsignsCmd m2

                  else
                    E.none
                ]
            )

        EditUnitSelMsg selMsg ->
            case model.editState of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editState.inpUnitSelState
                    in
                        ( { model
                            | editState =
                                Utils.Select.singleUpd mAction (Just editState.inpUnitId)
                                    |> Maybe.map
                                        (\unitId ->
                                            { editState
                                                | inpUnitSelState = iState
                                                , inpUnitId = unitId
                                            }
                                        )
                      }
                    , E.sendCmd <| Cmd.map EditUnitSelMsg iCmd
                    )

        -- adds many
        AddCallsign ->
            if model.addValidationError /= Nothing then
                ( model, E.none )

            else
                case model.inpUnit of
                    Nothing ->
                        ( model, E.none )

                    Just unitId ->
                        case model.inpSource of
                            Nothing ->
                                ( model, E.none )

                            Just sourceId ->
                                let
                                    effs =
                                        model.addState
                                            |> EL.toList
                                            |> List.map
                                                (\addState ->
                                                    E.sendCmd <|
                                                        Api.sigint_callsign_create AddCallsignDone
                                                            { callsign = addState.inpCallsign
                                                            , position = addState.inpPosition
                                                            , comment = addState.inpComment
                                                            , fullName = addState.inpFullName
                                                            , unitId = unitId
                                                            , sourceId = Just sourceId
                                                            , callsignAdditionalSources = []
                                                            , developing = addState.inpDeveloping
                                                            , radioFreq = Just addState.inpRadioFreq
                                                            }
                                                )
                                in
                                ( model
                                , E.batch effs
                                )

        AddCallsignDone (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення позивного" err
            )

        AddCallsignDone (Ok newCallsign) ->
            ( { model
                | callsigns = newCallsign :: model.callsigns
                , addState = EL.fromList [ initAddState Nothing ]
                , addParseError = Nothing
                , addValidationError = Nothing
                , loading = False
              }
            , E.none
            )

        EditCallsign id ->
            case ListX.find (\c -> c.id == id) model.callsigns of
                Nothing ->
                    ( model, E.none )

                Just callsign ->
                    ( { model
                        | editState =
                            Just
                                { inpCallsign = callsign.callsign
                                , inpPosition = callsign.position
                                , inpFullName = callsign.fullName
                                , inpComment = callsign.comment
                                , inpUnitId = callsign.unitId
                                , inpSourceId = callsign.sourceId
                                , inpUnitSelState =
                                    Select.initState
                                        (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt id)
                                , inpUnitSelMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            List.map
                                                (\u -> Select.basicMenuItem { item = u.id, label = u.name })
                                                (Dict.values units)

                                        _ ->
                                            []
                                , inpDeveloping = callsign.developing
                                , inpRadioFreq = callsign.radioFreq |> def ""
                                }
                        , sidebarEditing = True
                        , editingCallsign = Just callsign
                      }
                    , E.none
                    )

        EditCallsignMsg editState ->
            ( { model | editState = Just editState, validationError = Nothing }
            , E.none
            )

        EditCallsignSave id ->
            case model.editState of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    case ListX.find (\c -> c.id == id) model.callsigns of
                        Nothing ->
                            ( model, E.none )

                        Just callsign ->
                            let
                                -- Validate that if РО (source ID 2) is selected, frequency must be provided
                                isValid =
                                    if isRoSource editState.inpSourceId then
                                        not (String.isEmpty (String.trim editState.inpRadioFreq))

                                    else
                                        True
                            in
                            if isValid then
                                ( { model | validationError = Nothing }
                                , E.sendCmd <|
                                    Api.sigint_callsign_update
                                        (EditCallsignDone id)
                                        { id = id
                                        , callsign = editState.inpCallsign
                                        , position = editState.inpPosition
                                        , comment = editState.inpComment
                                        , fullName = editState.inpFullName
                                        , unitId = editState.inpUnitId
                                        , sourceId = editState.inpSourceId
                                        , callsignAdditionalSources = []
                                        , createdAt = callsign.createdAt
                                        , developing = editState.inpDeveloping
                                        , radioFreq = Just editState.inpRadioFreq
                                        , active = True
                                        }
                                )

                            else
                                ( { model | validationError = Just roSourceRadioFreqRequiredError }
                                , E.none
                                )

        EditCallsignDone _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення позивного" err
            )

        EditCallsignDone id (Ok updatedCallsign) ->
            ( { model
                | callsigns =
                    List.map
                        (\c ->
                            if c.id == id then
                                updatedCallsign

                            else
                                c
                        )
                        model.callsigns
                , editState = Nothing
                , sidebarEditing = False
                , editingCallsign = Nothing
                , loading = False
              }
            , E.none
            )

        EditCallsignCancel _ ->
            ( { model | editState = Nothing }, E.none )

        DeleteCallsign id ->
            ( { model | deleteCallsignConfirmation = Just id, deleteDialogOpen = True }, E.none )

        DeleteCallsignConfirm ->
            let
                m2 =
                    { model | deleteCallsignConfirmation = Nothing, deleteDialogOpen = False }
            in
            case model.deleteCallsignConfirmation of
                Just id ->
                    ( m2, E.sendCmd <| Api.sigint_callsign_delete DeleteCallsignDone id )

                Nothing ->
                    ( m2, E.none )

        DeleteCallsignCancel ->
            ( { model | deleteCallsignConfirmation = Nothing, deleteDialogOpen = False }, E.none )

        DeleteCallsignDone (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення позивного" err
            )

        DeleteCallsignDone (Ok deletedCallsign) ->
            ( { model
                | callsigns = List.filter (\c -> c.id /= deletedCallsign.id) model.callsigns
                , editState = Nothing
                , sidebarEditing = False
                , editingCallsign = Nothing
                , deleteCallsignConfirmation = Nothing
                , deleteDialogOpen = False
                , loading = False
              }
            , E.none
            )

        ClearInputs ->
            ( { model
                | addState = EL.fromList [ initAddState Nothing ]
                , addParseError = Nothing
                , addValidationError = Nothing
                , inpUnit = Nothing
              }
            , E.none
            )

        GotSources (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел" err
            )

        GotSources (Ok rsp) ->
            let
                updatedSourceId =
                    case model.inpSource of
                        Nothing ->
                            rsp.sources |> List.head |> Maybe.map .id

                        Just v ->
                            Just v
            in
            ( { model
                | sources = rsp.sources
                , inpSource = updatedSourceId
                , addValidationError =
                    getAddValidationError updatedSourceId model.addState model.addParseError
              }
            , E.none
            )

        FilterCallsignMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterCallsignDebounceConfig v model.filterCallsignDebounce
            in
            ( { model
                | filterCallsign = v
                , filterCallsignDebounce = debounce
              }
            , E.sendCmd cmd
            )

        FilterPositionMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterPositionDebounceConfig v model.filterPositionDebounce
            in
            ( { model
                | filterPosition = v
                , filterPositionDebounce = debounce
              }
            , E.sendCmd cmd
            )

        FilterCommentMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterCommentDebounceConfig v model.filterCommentDebounce
            in
            ( { model
                | filterComment = v
                , filterCommentDebounce = debounce
              }
            , E.sendCmd cmd
            )

        FilterUnitMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterUnitDebounceConfig v model.filterUnitDebounce
            in
            ( { model
                | filterUnit = v
                , filterUnitDebounce = debounce
              }
            , E.sendCmd cmd
            )

        FilterDevelopingMsg developingFilter ->
            let
                m2 =
                    { model | filterDeveloping = developingFilter, loading = True }
            in
            ( m2, loadCallsigns m2 )

        FilterCallsignDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterCallsignDebounceConfig
                        (Debounce.takeLast (\_ -> loadCallsignsCmd model))
                        imsg
                        model.filterCallsignDebounce
            in
            ( { model
                | filterCallsignDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        FilterPositionDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterPositionDebounceConfig
                        (Debounce.takeLast (\_ -> loadCallsignsCmd model))
                        imsg
                        model.filterPositionDebounce
            in
            ( { model
                | filterPositionDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        FilterCommentDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterCommentDebounceConfig
                        (Debounce.takeLast (\_ -> loadCallsignsCmd model))
                        imsg
                        model.filterCommentDebounce
            in
            ( { model
                | filterCommentDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        FilterUnitDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterUnitDebounceConfig
                        (Debounce.takeLast (\_ -> loadCallsignsCmd model))
                        imsg
                        model.filterUnitDebounce
            in
            ( { model
                | filterUnitDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        Refresh ->
            ( { model | loading = True, loadingUnitStats = True }
            , initLoad model
            )

        DownloadCsv allowed ->
            if allowed then
                ( { model | downloadCsvInProgress = True }
                , E.sendCmd <|
                    Api.sigint_list_callsigns_csv
                        DownloadCsvDone
                        (buildListCallsignsReq model { afterId = Nothing, limit = Nothing })
                )

            else
                ( model, E.none )

        DownloadCsvDone (Err err) ->
            ( { model | downloadCsvInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження CSV" err
            )

        DownloadCsvDone (Ok bytes) ->
            ( { model | downloadCsvInProgress = False }
            , E.sendCmd <| Download.bytes "callsigns.csv" "text/csv" bytes
            )

        DownloadXlsx allowed ->
            if allowed then
                ( { model | downloadXlsxInProgress = True }
                , E.sendCmd <|
                    Api.sigint_list_callsigns_xlsx
                        DownloadXlsxDone
                        (buildListCallsignsReq model { afterId = Nothing, limit = Nothing })
                )

            else
                ( model, E.none )

        DownloadXlsxDone (Err err) ->
            ( { model | downloadXlsxInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження XLSX" err
            )

        DownloadXlsxDone (Ok bytes) ->
            ( { model | downloadXlsxInProgress = False }
            , E.sendCmd <|
                Download.bytes
                    "callsigns.xlsx"
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    bytes
            )

        GotUnitStats (Err err) ->
            ( { model | loadingUnitStats = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
            )

        GotUnitStats (Ok rsp) ->
            ( { model | unitStats = rsp.units, loadingUnitStats = False }
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
            case m2.from.datePosix of
                Nothing ->
                    ( m2, eff2 )

                Just _ ->
                    ( m2, loadCallsigns m2 )

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
            case m2.to.datePosix of
                Nothing ->
                    ( m2, eff2 )

                Just _ ->
                    ( m2, loadCallsigns m2 )

        ToggleIsIgnoringDateFilter isChecked ->
            let
                m2 =
                    { model
                        | isIgnoringDateFilter = isChecked
                        , loading = True
                    }
            in
            ( m2, loadCallsigns m2 )

        SortByCallsignName ->
            let
                newSortingOrder =
                    case model.sortingOrder of
                        CallsignAsc ->
                            CallsignDesc

                        CallsignDesc ->
                            UnitAsc

                        _ ->
                            CallsignAsc

                updatedModel =
                    { model
                        | sortingOrder = newSortingOrder
                        , loading = True
                    }
            in
            ( updatedModel
            , loadCallsigns updatedModel
            )

        LoadMore ->
            ( { model | loadingMore = True }
            , E.sendCmd (loadMoreCallsignsCmd model)
            )

        InpSourceSelMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.inpSourceSelState

                updatedSourceId =
                    Utils.Select.singleUpd mAction model.inpSource
            in
            ( { model
                | inpSourceSelState = imodel2
                , inpSource = updatedSourceId
                , addParseError = model.addParseError
                , addValidationError =
                    getAddValidationError updatedSourceId model.addState model.addParseError
              }
            , E.sendCmd <| Cmd.map InpSourceSelMsg icmd
            )

        ToggleArmyExpanded armyName ->
            ( { model
                | expandedArmies =
                    if Set.member armyName model.expandedArmies then
                        Set.remove armyName model.expandedArmies

                    else
                        Set.insert armyName model.expandedArmies
              }
            , E.none
            )

        ToggleDivisionExpanded armyName divisionName ->
            let
                key =
                    armyName ++ ":" ++ divisionName
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

        ToggleRegimentExpanded armyName divisionName regimentName ->
            let
                key =
                    armyName ++ ":" ++ divisionName ++ ":" ++ regimentName
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

        ToggleBattalionExpanded armyName divisionName regimentName battalionName ->
            let
                key =
                    armyName ++ ":" ++ divisionName ++ ":" ++ regimentName ++ ":" ++ battalionName
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

        ClearFilters ->
            let
                m2 =
                    { model
                        | filterCallsign = ""
                        , filterPosition = ""
                        , filterComment = ""
                        , filterUnit = ""
                        , filterDeveloping = B.OnlyNonDeveloping
                    }
            in
            ( m2, loadCallsigns m2 )

        ToggleSidebar ->
            ( { model | showSidebar = not model.showSidebar }, E.none )

        SetTableState newState ->
            ( { model | tableState = newState }, E.none )

        OpenEditSidebar callsign ->
            ( { model
                | sidebarEditing = True
                , editingCallsign = Just callsign
                , editState =
                    Just
                        { inpCallsign = callsign.callsign
                        , inpPosition = callsign.position
                        , inpFullName = callsign.fullName
                        , inpComment = callsign.comment
                        , inpUnitId = callsign.unitId
                        , inpSourceId = callsign.sourceId
                        , inpUnitSelState = Select.initState (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt callsign.id)
                        , inpUnitSelMenu =
                            case shared.masterUnits of
                                Success units ->
                                    List.map (\u -> Select.basicMenuItem { item = u.id, label = u.name }) (Dict.values units)

                                _ ->
                                    []
                        , inpDeveloping = callsign.developing
                        , inpRadioFreq = callsign.radioFreq |> def ""
                        }
              }
            , E.none
            )

        CloseEditSidebar ->
            ( { model | sidebarEditing = False, editingCallsign = Nothing }, E.none )

        SaveEditSidebar ->
            case model.editingCallsign of
                Just callsign ->
                    case model.editState of
                        Just editState ->
                            let
                                -- Validate that if РО (source ID 2) is selected, frequency must be provided
                                isValid =
                                    if isRoSource editState.inpSourceId then
                                        not (String.isEmpty (String.trim editState.inpRadioFreq))

                                    else
                                        True
                            in
                            if isValid then
                                ( { model | validationError = Nothing }
                                , E.sendCmd <|
                                    Api.sigint_callsign_update
                                        (EditCallsignDone callsign.id)
                                        { id = callsign.id
                                        , callsign = editState.inpCallsign
                                        , position = editState.inpPosition
                                        , comment = editState.inpComment
                                        , fullName = editState.inpFullName
                                        , unitId = editState.inpUnitId
                                        , sourceId = editState.inpSourceId
                                        , callsignAdditionalSources = []
                                        , createdAt = callsign.createdAt
                                        , developing = editState.inpDeveloping
                                        , radioFreq = Just editState.inpRadioFreq
                                        , active = True
                                        }
                                )

                            else
                                ( { model | validationError = Just roSourceRadioFreqRequiredError }
                                , E.none
                                )

                        Nothing ->
                            ( model, E.none )

                Nothing ->
                    ( model, E.none )

        CancelEditSidebar ->
            ( { model | sidebarEditing = False, editingCallsign = Nothing, editState = Nothing }, E.none )

        SortByCreatedAt ->
            let
                newSortingOrder =
                    case model.sortingOrder of
                        CreatedAtAsc ->
                            CreatedAtDesc

                        CreatedAtDesc ->
                            CallsignAsc

                        _ ->
                            CreatedAtDesc

                updatedModel =
                    { model
                        | sortingOrder = newSortingOrder
                        , loading = True
                    }
            in
            ( updatedModel
            , loadCallsigns updatedModel
            )

        SortByUnit ->
            let
                newSortingOrder =
                    case model.sortingOrder of
                        UnitAsc ->
                            UnitDesc

                        UnitDesc ->
                            CallsignAsc

                        _ ->
                            UnitAsc

                updatedModel =
                    { model
                        | sortingOrder = newSortingOrder
                        , loading = True
                    }
            in
            ( updatedModel
            , loadCallsigns updatedModel
            )

        RowShowAllPopupChanged popupStatus ->
            ( { model | rowShowAllPopupStatus = popupStatus }
            , E.none
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


callsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.Callsign Msg
callsignsTableConfig shared model user =
    let
        hasEditorRole =
            Core.Auth.hasRole "CallsignsEditor" user || Core.Auth.hasRole "UnitsEditor" user

        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute Msg ) -> Html Msg
        customTheadHelp ( name, status, click ) =
            let
                -- Custom sorting logic for our backend sorting
                ( sortIcon, sortClick ) =
                    case name of
                        "Позивний" ->
                            let
                                icon =
                                    case model.sortingOrder of
                                        CallsignAsc ->
                                            span [ style "color" "var(--ochre-normal)" ] [ text " ↓" ]

                                        CallsignDesc ->
                                            span [ style "color" "var(--ochre-normal)" ] [ text " ↑" ]

                                        _ ->
                                            span [ style "color" "var(--color-text-muted)" ] [ text " ↕" ]
                            in
                            ( icon, onClick SortByCallsignName )

                        "Створено" ->
                            let
                                icon =
                                    case model.sortingOrder of
                                        CreatedAtAsc ->
                                            span [ style "color" "var(--ochre-normal)" ] [ text " ↓" ]

                                        CreatedAtDesc ->
                                            span [ style "color" "var(--ochre-normal)" ] [ text " ↑" ]

                                        _ ->
                                            span [ style "color" "var(--color-text-muted)" ] [ text " ↕" ]
                            in
                            ( icon, onClick SortByCreatedAt )

                        "Підрозділ" ->
                            let
                                icon =
                                    case model.sortingOrder of
                                        UnitAsc ->
                                            span [ style "color" "var(--ochre-normal)" ] [ text " ↓" ]

                                        UnitDesc ->
                                            span [ style "color" "var(--ochre-normal)" ] [ text " ↑" ]

                                        _ ->
                                            span [ style "color" "var(--color-text-muted)" ] [ text " ↕" ]
                            in
                            ( icon, onClick SortByUnit )

                        _ ->
                            ( text "", onClick SortByCallsignName )

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ sortClick, style "padding" "1rem 1.5rem" ] [ headerContent ]

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
        { toId = \callsign -> String.fromInt callsign.id
        , toMsg = SetTableState
        , columns =
            [ Table.veryCustomColumn
                { name = "Позивний"
                , viewData =
                    \callsign ->
                        { attributes = []
                        , children =
                            [ div []
                                [ div [ class "text-uppercase" ]
                                    [ text callsign.callsign ]
                                , HtmlX.viewIf callsign.developing
                                    (div [ class "badge rounded-pill text-bg-warning" ]
                                        [ text "в дорозвідці" ]
                                    )
                                ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Посада"
                , viewData =
                    \callsign ->
                        { attributes = []
                        , children = [ text callsign.position ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Підрозділ"
                , viewData =
                    \callsign ->
                        { attributes = []
                        , children =
                            [ case
                                case shared.masterUnits of
                                    Success units ->
                                        ListX.find (\u -> u.id == callsign.unitId) (Dict.values units)

                                    _ ->
                                        Nothing
                              of
                                Nothing ->
                                    text "<Виберіть підрозділ>"

                                Just unit ->
                                    text unit.name
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "16%"
            , Table.veryCustomColumn
                { name = "Коментар"
                , viewData =
                    \callsign ->
                        { attributes = [ class "relative" ]
                        , children =
                            [ div [ class "flex flex-col gap-2" ]
                                [ div
                                    [ class "comment-preview"
                                    , style "max-height" "4.5rem" -- ~3 рядки
                                    , style "overflow" "hidden"
                                    , style "white-space" "pre-line"
                                    ]
                                    [ text callsign.comment ]
                                , if String.length callsign.comment > 100 then
                                    let
                                        isOpen =
                                            case model.rowShowAllPopupStatus of
                                                Just ( callsignId, ShowAllComment ) ->
                                                    callsignId == callsign.id

                                                _ ->
                                                    False
                                    in
                                    Shared.Components.FloatingPopup.new
                                        { anchorContent =
                                            span
                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                ]
                                                [ text "Показати повний коментар"
                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                ]
                                        , popupContent =
                                            div [ class "comment-popup-content p-1" ]
                                                [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                    [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                        [ text "Повний коментар" ]
                                                    ]
                                                , div [ class "whitespace-pre-line text-sm" ]
                                                    [ text callsign.comment ]
                                                ]
                                        , isOpen = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( callsign.id, ShowAllComment )
                                        }
                                        |> Shared.Components.FloatingPopup.withPlacement Shared.Components.FloatingPopup.Top
                                        |> Shared.Components.FloatingPopup.view

                                  else
                                    text ""
                                ]
                            , Watermark.new user.name
                                |> Watermark.withPositioning ( 5, 5 )
                                |> Watermark.withRotate -10
                                |> Watermark.withFontSize "1.3rem"
                                |> Watermark.withOpacity 0.3
                                |> Watermark.view
                                |> HtmlX.viewIf (Basics.remainderBy 3 callsign.id == 0)
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "21%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData =
                    \callsign ->
                        { attributes = [ class "text-sm" ]
                        , children =
                            [ case callsign.sourceId of
                                Nothing ->
                                    text "Не вказано"

                                Just sourceId ->
                                    case ListX.find (\s -> s.id == sourceId) model.sources of
                                        Nothing ->
                                            text "Loading..."

                                        Just source ->
                                            if isRoSource (Just source.id) && not (String.isEmpty (callsign.radioFreq |> def "")) then
                                                text (source.name ++ " (" ++ def "" callsign.radioFreq ++ ")")

                                            else
                                                text source.name
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "9%"
            , Table.veryCustomColumn
                { name = "Створено"
                , viewData =
                    \callsign ->
                        { attributes = []
                        , children =
                            [ text <|
                                Utils.Time.renderDateF6 shared.timeZone
                                    (Time.millisToPosix callsign.createdAt)
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дії"
                , viewData =
                    \callsign ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            if hasEditorRole then
                                [ div [ class "flex gap-[4px] text-sm" ]
                                    [ button
                                        [ title "Редагувати"
                                        , class "icon-btn icon-btn-primary"
                                        , onClick (OpenEditSidebar callsign)
                                        ]
                                        [ i [ class "bi bi-pencil-square" ] [] ]
                                    , button
                                        [ title "Видалити"
                                        , class "icon-btn icon-btn-danger"
                                        , onClick (DeleteCallsign callsign.id)
                                        ]
                                        [ i [ class "bi bi-trash" ] [] ]
                                    ]
                                ]

                            else
                                []
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "7%"
            ]
        , customizations = customizations
        }


editSidebarContent : Model -> Shared.Model -> Auth.User -> List (Html Msg)
editSidebarContent model shared _ =
    case model.editingCallsign of
        Just _ ->
            case model.editState of
                Just editState ->
                    [ div [ class "p-6 flex flex-col gap-6 h-full" ]
                        [ div [ class "flex justify-between items-center" ]
                            [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100" ]
                                [ text "Редагування позивного" ]
                            , button
                                [ class "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                , onClick CloseEditSidebar
                                ]
                                [ i [ class "bi bi-x-lg text-xl" ] [] ]
                            ]
                        , div [ class "flex-1 space-y-4" ]
                            [ div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "Позивний" ]
                                , input
                                    [ class "form-input uppercase w-full"
                                    , type_ "text"
                                    , placeholder "Позивний"
                                    , value editState.inpCallsign
                                    , onInput <|
                                        EditCallsignMsg
                                            << (\v -> { editState | inpCallsign = v })
                                    ]
                                    []
                                , div [ class "flex items-center gap-2 mt-2" ]
                                    [ Checkbox.new
                                        { isChecked = editState.inpDeveloping
                                        , onToggle = \v -> EditCallsignMsg { editState | inpDeveloping = v }
                                        }
                                        |> Checkbox.withContent [ text "в дорозвідці" ]
                                        |> Checkbox.view
                                    ]
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "Посада" ]
                                , input
                                    [ class "form-input w-full"
                                    , type_ "text"
                                    , placeholder "Посада"
                                    , value editState.inpPosition
                                    , onInput <| EditCallsignMsg << (\v -> { editState | inpPosition = v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "ПІП" ]
                                , input
                                    [ class "form-input w-full"
                                    , type_ "text"
                                    , placeholder "ПІП"
                                    , value editState.inpFullName
                                    , onInput <| EditCallsignMsg << (\v -> { editState | inpFullName = v })
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "Коментар" ]
                                , textarea
                                    [ class "form-input w-full"
                                    , rows 3
                                    , placeholder "Коментар"
                                    , onInput <|
                                        EditCallsignMsg
                                            << (\v -> { editState | inpComment = v })
                                    , value editState.inpComment
                                    ]
                                    []
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "Підрозділ" ]
                                , let
                                    selectItem : Maybe (Select.MenuItem Int)
                                    selectItem =
                                        (case shared.masterUnits of
                                            Success units ->
                                                ListX.find (\unit -> unit.id == editState.inpUnitId) (Dict.values units)

                                            _ ->
                                                Nothing
                                        )
                                            |> Maybe.map
                                                (\unit ->
                                                    Select.basicMenuItem
                                                        { item = unit.id, label = unit.name }
                                                )
                                  in
                                  Html.map EditUnitSelMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelectSingle
                                            selectItem
                                            editState.inpUnitSelState
                                            editState.inpUnitSelMenu
                                            "жоден"
                                            (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "Джерело" ]
                                , div [ class "flex flex-wrap gap-2" ]
                                    (List.map
                                        (\source ->
                                            Tag.new
                                                { isActive = editState.inpSourceId == Just source.id
                                                , onToggle = EditCallsignMsg { editState | inpSourceId = Just source.id }
                                                }
                                                |> Tag.view source.name
                                        )
                                        model.sources
                                    )
                                , if isRoSource editState.inpSourceId then
                                    input
                                        [ class "form-input w-full mt-2"
                                        , type_ "text"
                                        , placeholder "Частота"
                                        , value editState.inpRadioFreq
                                        , onInput <| EditCallsignMsg << (\v -> { editState | inpRadioFreq = v })
                                        ]
                                        []

                                  else
                                    text ""
                                ]
                            ]
                        , if model.validationError /= Nothing then
                            div [ class "p-3 bg-red-50 border border-red-200 rounded-md" ]
                                [ div [ class "flex items-center gap-2" ]
                                    [ i [ class "bi bi-exclamation-triangle text-red-500" ] []
                                    , span [ class "text-sm text-red-700" ]
                                        [ text (Maybe.withDefault "" model.validationError) ]
                                    ]
                                ]

                          else
                            text ""
                        , div [ class "w-full flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700" ]
                            [ Button.new { label = "Скасувати", onClick = CancelEditSidebar }
                                |> Button.withStyleSecondary
                                |> Button.view
                            , Button.new { label = "Зберегти", onClick = SaveEditSidebar }
                                |> Button.withPrimary
                                |> Button.view
                            ]
                        ]
                    ]

                Nothing ->
                    [ div [ class "p-6" ]
                        [ text "Помилка: не знайдено дані для редагування" ]
                    ]

        Nothing ->
            [ div [ class "p-6" ]
                [ text "Помилка: не вибрано позивний для редагування" ]
            ]


contentBlock : Shared.Model -> Model -> Auth.User -> Html Msg
contentBlock shared model user =
    let
        hasEditorRole =
            Core.Auth.hasRole "CallsignsEditor" user || Core.Auth.hasRole "UnitsEditor" user
        hasUnitEditorRole =
            Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user

        deleteConfirmationModal =
            let
                callsignName =
                    model.deleteCallsignConfirmation
                        |> Maybe.andThen (\id -> ListX.find (\c -> c.id == id) model.callsigns)
                        |> Maybe.map .callsign
                        |> Maybe.withDefault ""

                dialogContent =
                    [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                        [ div [ class "pb-12" ]
                            [ h2 [] [ text "Видалення позивного" ]
                            , p []
                                [ text "Ви впевнені, що хочете видалити позивний "
                                , strong [] [ text callsignName ]
                                , text "?"
                                ]
                            ]
                        , div [ class "flex justify-between" ]
                            [ Button.new { label = "Відміна", onClick = DeleteCallsignCancel }
                                |> Button.withStyleSecondary
                                |> Button.view
                            , button
                                [ class "btn btn-danger"
                                , type_ "button"
                                , onClick DeleteCallsignConfirm
                                ]
                                [ text "Видалити" ]
                            ]
                        ]
                    ]
            in
            ModalDialog.modalDialog model.deleteDialogOpen DeleteCallsignCancel [] dialogContent

        addCallsignPanel : ( Int, AddState ) -> Html Msg
        addCallsignPanel ( pos, addState ) =
            div
                [ class "grid grid-cols-12 gap-2 p-2"
                ]
                [ div [ class "col-span-2" ]
                    [ div [ class "flex flex-col" ]
                        [ textarea
                            [ class "form-input uppercase w-full"
                            , id "callsign-input"
                            , name "callsign"
                            , rows 1
                            , style "resize" "none"
                            , style "overflow" "hidden"
                            , wrap "off"
                            , Attr.disabled (not hasEditorRole)
                            , placeholder "Позивний"
                            , onInput <|
                                AddStateMsg pos
                                    << (\v -> { addState | inpCallsign = v })
                            , value addState.inpCallsign
                            ]
                            []
                        , div
                            [ class "mt-1 flex items-center gap-2 text-sm"
                            ]
                            [ Checkbox.new
                                { isChecked = addState.inpDeveloping
                                , onToggle = \v -> AddStateMsg pos { addState | inpDeveloping = v }
                                }
                                |> Checkbox.withDisabled (not hasEditorRole)
                                |> Checkbox.withContent [ text "в дорозвідці" ]
                                |> Checkbox.view
                            ]
                        ]
                    ]
                , div [ class "col-span-2" ]
                    [ input
                        [ class "form-input w-full"
                        , Attr.disabled (not hasEditorRole)
                        , type_ "text"
                        , placeholder "Посада"
                        , onInput <| AddStateMsg pos << (\v -> { addState | inpPosition = v })
                        , value addState.inpPosition
                        ]
                        []
                    ]
                , div [ class "col-span-3" ]
                    [ input
                        [ class "form-input w-full"
                        , Attr.disabled (not hasEditorRole)
                        , type_ "text"
                        , placeholder "ПІП"
                        , onInput <| AddStateMsg pos << (\v -> { addState | inpFullName = v })
                        , value addState.inpFullName
                        ]
                        []
                    ]
                , div [ class "col-span-3" ]
                    [ textarea
                        [ class "form-input w-full"
                        , rows 1
                        , Attr.disabled (not hasEditorRole)
                        , placeholder "Коментар"
                        , onInput <| AddStateMsg pos << (\v -> { addState | inpComment = v })
                        , value addState.inpComment
                        ]
                        []
                    ]
                , div [ class "col-span-3" ]
                    [ HtmlX.viewIf (pos == 0) <|
                        let
                            selectItem =
                                model.inpUnit
                                    |> Maybe.andThen
                                        (\unitId ->
                                            case shared.masterUnits of
                                                Success units ->
                                                    ListX.find (\u -> u.id == unitId) (Dict.values units)

                                                _ ->
                                                    Nothing
                                        )
                                    |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })
                        in
                        div [ class "flex items-center gap-2" ]
                            [ div [ class "flex-grow" ]
                                [ let
                                    options =
                                        Utils.Select.defaultOptions (isDarkMode shared.themeMode)

                                    options2 =
                                        { options | disabled = not hasEditorRole }
                                  in
                                  Html.map AddUnitSelMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelectSingle
                                            selectItem
                                            model.inpUnitSelState
                                            (populateUnitMenu shared)
                                            "жоден"
                                            options2
                                ]
                            ]
                    ]
                , div [ class "col-span-2" ]
                    [ HtmlX.viewIf (pos == 0) <|
                        let
                            selectItem =
                                model.inpSource
                                    |> Maybe.andThen (\sourceId -> ListX.find (\s -> s.id == sourceId) model.sources)
                                    |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                        in
                        div [ class "flex items-center gap-2" ]
                            [ div [ class "w-32" ]
                                [ Html.map InpSourceSelMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelectSingle
                                            selectItem
                                            model.inpSourceSelState
                                            (model.sources
                                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                            )
                                            "жоден"
                                            (Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                                                |> (\opts ->
                                                        { opts
                                                            | disabled =
                                                                not hasEditorRole
                                                            , clearable = False
                                                        }
                                                   )
                                            )
                                ]
                            , button
                                [ title "Зберегти"
                                , class "icon-btn icon-btn-primary"
                                , onClick AddCallsign
                                , Attr.disabled (not hasEditorRole || model.addValidationError /= Nothing)
                                ]
                                [ i [ class "bi bi-check-lg" ] [] ]
                            , button
                                [ title "Очистити"
                                , class "icon-btn icon-btn-secondary"
                                , onClick ClearInputs
                                , Attr.disabled (not hasEditorRole)
                                ]
                                [ i [ class "bi bi-x-lg" ] [] ]
                            ]
                    , if isRoSource model.inpSource then
                        input
                            [ class "form-input w-full mt-2"
                            , type_ "text"
                            , placeholder "Частота"
                            , onInput <| AddStateMsg pos << (\v -> { addState | inpRadioFreq = v })
                            , value addState.inpRadioFreq
                            ]
                            []

                      else
                        text ""
                    , HtmlX.viewIf (pos == 0 && model.addValidationError /= Nothing) <|
                        div [ class "mt-2 p-3 bg-red-50 border border-red-200 rounded-md" ]
                            [ div [ class "flex items-center gap-2" ]
                                [ i [ class "bi bi-exclamation-triangle text-red-500" ] []
                                , span [ class "text-sm text-red-700" ]
                                    [ text (Maybe.withDefault "" model.addValidationError) ]
                                ]
                            ]
                    ]
                ]

        -- Check if any filters are active
        hasActiveFilters =
            (model.filterCallsign /= "")
                || (model.filterPosition /= "")
                || (model.filterComment /= "")
                || (model.filterUnit /= "")

        -- Count active filters
        activeFilterCount =
            [ model.filterCallsign /= ""
            , model.filterPosition /= ""
            , model.filterComment /= ""
            , model.filterUnit /= ""
            , model.filterDeveloping /= B.OnlyNonDeveloping
            ]
                |> List.filter identity
                |> List.length

        filterPanel =
            div [ class "flex flex-col gap-3" ]
                [ -- Title and Clear button row
                  div [ class "d-flex justify-content-between align-items-center" ]
                    [ div [ class "flex items-center gap-2" ]
                        [ if model.loading then
                            Shared.Components.Spinner.loadingSpinner2Sm

                          else
                            i [ class "bi bi-filter text-lg" ] []
                        , h5 [ class "fw-bold mb-0 text-gray-900 dark:text-gray-100" ] [ text "Фільтри" ]
                        , if activeFilterCount > 0 then
                            span
                                [ class "ml-1 inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200" ]
                                [ text (String.fromInt activeFilterCount) ]

                          else
                            text ""
                        ]
                    , div
                        [ class "d-flex align-items-center cursor-pointer text-secondary hover:text-gray-700"
                        , onClick ClearFilters
                        , attribute "title"
                            (if hasActiveFilters then
                                "Скинути всі фільтри (" ++ String.fromInt activeFilterCount ++ ")"

                             else
                                "Немає активних фільтрів"
                            )
                        ]
                        [ span [ class "me-1" ] [ text "Очистити" ]
                        , i [ class "bi bi-x", style "font-size" "1.2rem" ] []
                        ]
                    ]
                , div [ class "flex items-center gap-3" ]
                    [ div [ class "flex-grow" ]
                        [ div [ class "flex flex-wrap gap-2 mb-2" ] <|
                            [ input
                                [ class "form-input uppercase min-w-[180px]"
                                , type_ "text"
                                , placeholder "Позивний"
                                , value model.filterCallsign
                                , onInput FilterCallsignMsg
                                ]
                                []
                            , input
                                [ class "form-input min-w-[180px]"
                                , type_ "text"
                                , placeholder "Посада"
                                , value model.filterPosition
                                , onInput FilterPositionMsg
                                ]
                                []
                            , input
                                [ class "form-input min-w-[180px]"
                                , type_ "text"
                                , placeholder "Коментар"
                                , value model.filterComment
                                , onInput FilterCommentMsg
                                ]
                                []
                            , input
                                [ class "form-input min-w-[180px]"
                                , type_ "text"
                                , placeholder "Підрозділ"
                                , value model.filterUnit
                                , onInput FilterUnitMsg
                                ]
                                []
                            , select
                                [ class "form-input min-w-[200px]"
                                , value (developingFilterToValue model.filterDeveloping)
                                , onInput (parseDevelopingFilter >> FilterDevelopingMsg)
                                ]
                                [ option [ value "only-non-developing" ] [ text "Відомі" ]
                                , option [ value "only-developing" ] [ text "В дорозвідці" ]
                                , option [ value "all" ] [ text "Усі" ]
                                ]
                            ]
                                ++ (button
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
                                   )
                                    :: (if hasUnitEditorRole then
                                        [ button
                                            [ class "px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 flex items-center gap-2 ml-4"
                                            , onClick (DownloadCsv hasUnitEditorRole)
                                            , Attr.disabled model.downloadCsvInProgress
                                            , attribute "title" "Завантажити CSV з обраними фільтрами"
                                            , style "margin-left" "12px"
                                            ]
                                            ((text "Завантажити csv")
                                                :: (if model.downloadCsvInProgress then
                                                        [ Shared.Components.Spinner.loadingSpinner2Sm ]

                                                    else
                                                        []
                                                   )
                                            )
                                        ]

                                    else
                                        []
                                       )
                                ++ (if hasUnitEditorRole then
                                        [ button
                                            [ class "px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700 flex items-center gap-2"
                                            , onClick (DownloadXlsx hasUnitEditorRole)
                                            , Attr.disabled model.downloadXlsxInProgress
                                            , attribute "title" "Завантажити XLSX з обраними фільтрами"
                                            ]
                                            ((text "Завантажити XLSX")
                                                :: (if model.downloadXlsxInProgress then
                                                        [ Shared.Components.Spinner.loadingSpinner2Sm ]

                                                    else
                                                        []
                                                   )
                                            )
                                        ]

                                    else
                                        []
                                   )
                        , div [ class "flex items-center gap-4" ]
                            [ div [ class "flex items-center gap-2" ]
                                [ div [ class "flex items-center gap-1" ]
                                    [ input
                                        [ type_ "radio"
                                        , class "h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                                        , id "btnradio1"
                                        , autocomplete False
                                        , checked model.isIgnoringDateFilter
                                        , onClick <| ToggleIsIgnoringDateFilter True
                                        ]
                                        []
                                    , label
                                        [ class "text-sm text-gray-700 dark:text-gray-300"
                                        , for "btnradio1"
                                        ]
                                        [ text "Весь час" ]
                                    ]
                                , div [ class "flex items-center gap-1" ]
                                    [ input
                                        [ type_ "radio"
                                        , class "h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                                        , id "btnradio2"
                                        , autocomplete False
                                        , checked (not model.isIgnoringDateFilter)
                                        , onClick <| ToggleIsIgnoringDateFilter False
                                        ]
                                        []
                                    , label
                                        [ class "text-sm text-gray-700 dark:text-gray-300"
                                        , for "btnradio2"
                                        ]
                                        [ text "Період" ]
                                    ]
                                ]
                            , div [ class "flex items-center gap-2" ]
                                [ span [ class "text-sm text-gray-700 dark:text-gray-300" ] [ text "з" ]
                                , div [ class "inline-flex" ]
                                    (Shared.Components.DateTime.new
                                        { model =
                                            if not model.isIgnoringDateFilter then
                                                model.from

                                            else
                                                Shared.Components.DateTime.init ()
                                        , toMsg = DateTimeFromMsg
                                        }
                                        |> Shared.Components.DateTime.setDisabled model.isIgnoringDateFilter
                                        |> Shared.Components.DateTime.view
                                    )
                                , span [ class "text-sm text-gray-700 dark:text-gray-300" ] [ text "по" ]
                                , div [ class "inline-flex" ]
                                    (Shared.Components.DateTime.new
                                        { model =
                                            if not model.isIgnoringDateFilter then
                                                model.to

                                            else
                                                Shared.Components.DateTime.init ()
                                        , toMsg = DateTimeToMsg
                                        }
                                        |> Shared.Components.DateTime.setDisabled model.isIgnoringDateFilter
                                        |> Shared.Components.DateTime.view
                                    )
                                ]
                            ]
                        ]
                    ]
                ]

        -- Remove frontend sorting since we're now doing it on the backend
        -- sortByName model_ callsigns_ = callsigns_
        mainContent =
            div []
                [ div
                    [ class "border mb-2 p-2"
                    ]
                    (EL.mapPair
                        addCallsignPanel
                        model.addState
                    )
                , let
                    duplicates =
                        potentialDuplicates model

                    hasInput =
                        let
                            addStateList =
                                EL.toList model.addState

                            firstAddState =
                                List.head addStateList
                        in
                        case firstAddState of
                            Just addState ->
                                not (String.isEmpty (String.trim addState.inpCallsign))
                                    || not (String.isEmpty (String.trim addState.inpPosition))
                                    || model.inpUnit
                                    /= Nothing

                            Nothing ->
                                False
                  in
                  if hasInput && not (List.isEmpty duplicates) then
                    div [ class "alert alert-warning mt-2 mb-4" ]
                        [ text "Можливо, такий позивний вже існує:"
                        , table [ class "table table-sm mt-2" ]
                            [ thead []
                                [ tr []
                                    [ th [] [ text "Позивний" ]
                                    , th [] [ text "Посада" ]
                                    , th [] [ text "Підрозділ" ]
                                    , th [] [ text "Коментар" ]
                                    ]
                                ]
                            , tbody []
                                (List.map
                                    (\callsign ->
                                        let
                                            unitName =
                                                case
                                                    case shared.masterUnits of
                                                        Success units ->
                                                            ListX.find (\u -> u.id == callsign.unitId) (Dict.values units)

                                                        _ ->
                                                            Nothing
                                                of
                                                    Nothing ->
                                                        "<Виберіть підрозділ>"

                                                    Just unit ->
                                                        unit.name
                                        in
                                        tr []
                                            [ td [] [ text (String.toUpper callsign.callsign) ]
                                            , td [] [ text callsign.position ]
                                            , td [] [ text unitName ]
                                            , td [] [ div [ style "white-space" "pre-line" ] [ text callsign.comment ] ]
                                            ]
                                    )
                                    duplicates
                                )
                            ]
                        ]

                  else
                    text ""
                , div
                    [ class "border mb-4 p-2"
                    ]
                    [ filterPanel
                    ]
                , div [ class "relative" ]
                    [ Table.view (callsignsTableConfig shared model user) model.tableState model.callsigns
                    , if model.loading then
                        div
                            [ class "absolute inset-0 bg-white/80 dark:bg-gray-900/80 flex items-center justify-center"
                            , style "backdrop-filter" "blur(1px)"
                            ]
                            [ div [ class "flex flex-col items-center gap-2" ]
                                [ Shared.Components.Spinner.loadingSpinner
                                , div [ class "text-sm text-gray-600 dark:text-gray-300" ]
                                    [ text "Завантаження даних..." ]
                                ]
                            ]

                      else
                        text ""
                    ]
                , div [ class "flex justify-center mt-3 mb-3" ] <|
                    if model.showLoadMore then
                        [ Button.new { label = "Завантажити ще", onClick = LoadMore }
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
    in
    div []
        [ deleteConfirmationModal
        , mainContent
        , Sidebar.view model.sidebarEditing CloseEditSidebar (editSidebarContent model shared user)
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
            , selectedUnit = model.filterUnit
            , autoExpandArmies = False
            , autoExpandDivisions = True
            , autoExpandRegiments = True
            , autoExpandBattalions = True
            }
    in
    if model.loadingUnitStats then
        Shared.Components.Spinner.loadingSpinner

    else
        section []
            [ div [ class "p-4 border-b border-border" ]
                [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2" ]
                    [ Html.text "Підрозділи" ]
                , p [ class "text-sm text-gray-600 dark:text-gray-400" ]
                    [ Html.text "Оберіть підрозділ для фільтрації" ]
                ]
            , Core.UnitHierarchy.view config
                (case shared.masterUnits of
                    Success units ->
                        Dict.values units

                    _ ->
                        []
                )
                model.unitStats
            ]


mkAddState : String -> String -> String -> AddState
mkAddState a b c =
    { inpCallsign = String.trim a
    , inpPosition = String.trim b
    , inpFullName = ""
    , inpComment = String.trim c
    , inpDeveloping = False
    , inpRadioFreq = ""
    }


mkAddStateWithFullName : String -> String -> String -> String -> AddState
mkAddStateWithFullName callsign position fullName comment =
    { inpCallsign = String.trim callsign
    , inpPosition = String.trim position
    , inpFullName = String.trim fullName
    , inpComment = String.trim comment
    , inpDeveloping = False
    , inpRadioFreq = ""
    }

processTabDelimitedInput : String -> Result String (List AddState)
processTabDelimitedInput input =
    let
        stripTrailingLineBreaks value =
            if String.endsWith "\r\n" value then
                stripTrailingLineBreaks (String.dropRight 2 value)

            else if String.endsWith "\n" value || String.endsWith "\r" value then
                stripTrailingLineBreaks (String.dropRight 1 value)

            else
                value

        parseLine line =
            let
                cells =
                    String.split "\t" line
            in
            case cells of
                [ a, b, c ] ->
                    Ok [ mkAddState a b c ]

                [ a, b, c, d ] ->
                    Ok [ mkAddStateWithFullName a b c d ]

                _ ->
                    Err quickPasteTsvFormatError
    in
    input
        |> stripTrailingLineBreaks
        |> String.lines
        |> List.foldl
            (\line acc ->
                case ( acc, parseLine line ) of
                    ( Ok rows, Ok parsedRows ) ->
                        Ok (rows ++ parsedRows)

                    ( Err err, _ ) ->
                        Err err

                    ( _, Err err ) ->
                        Err err
            )
            (Ok [])


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ shared user model =
    { title = "позивні (стара)"
    , body =
        [ div [ class "flex justify-start items-start app-shell-fill-height" ]
            [ if model.showSidebar then
                div
                    [ class "self-stretch max-h-full min-w-[260px] max-w-[340px] w-[22vw] overflow-y-auto border-r border-border bg-card relative transition-all duration-300"
                    ]
                    [ button
                        [ class "absolute top-2 right-2 z-10 btn btn-sm btn-outline-secondary"
                        , onClick ToggleSidebar
                        , attribute "title" "Сховати підрозділи"
                        ]
                        [ i [ class "bi bi-chevron-left" ] [] ]
                    , unitsBlock shared model
                    ]

              else
                text ""
            , div
                [ class
                    (if model.showSidebar then
                        "grow h-full overflow-auto"

                     else
                        "grow h-full overflow-auto mx-auto max-w-[98vw]"
                    )
                ]
                [ h1 [ class "py-2 ps-4" ]
                    [ span [ class "me-2" ] [ text "позивні (стара)" ]
                    , button
                        [ type_ "button"
                        , class "inline-block btn btn-outline-secondary me-2"
                        , onClick Refresh
                        , attribute "data-tooltip" "оновити"
                        , attribute "data-position" "bottom"
                        ]
                        (if model.loading then
                            [ Shared.Components.Spinner.loadingSpinner2Sm ]

                         else
                            [ i [ class "bi bi-arrow-repeat" ] [] ]
                        )
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
