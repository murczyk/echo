module Pages.RerCallsigns exposing (AddState, EditCallsignState, Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.ModalDialog as ModalDialog
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Components.Tag as Tag
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import EnumeratedList as EL exposing (EnumeratedList)
import FloatingPopup
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import Layouts
import Le.Auth
import Le.Block.DateTime
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.RemoteData exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Task
import Time
import TimeZone
import UnitHierarchy
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
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }


type alias Model =
    { zone : Maybe Time.Zone
    , callsigns : List B.Callsign
    , callsignsWithUnitsFromInbox : RemoteData ApiError (List ( String, List String ))
    , addState : EnumeratedList AddState
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
    , filterCallsignDebounce : Debounce String
    , filterPositionDebounce : Debounce String
    , filterCommentDebounce : Debounce String
    , filterUnitDebounce : Debounce String
    , loading : Bool
    , loadingUnitStats : Bool
    , unitStats : List B.CallsignUnitStatRow
    , from : Le.Block.DateTime.Model
    , to : Le.Block.DateTime.Model
    , now : Maybe Time.Posix
    , isIgnoringDateFilter : Bool
    , sortingOrder : SortingOrder
    , showLoadMore : Bool
    , loadingMore : Bool
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
    = ShowAllUnits
    | ShowAllComment


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
            { zone = Nothing
            , callsigns = []
            , callsignsWithUnitsFromInbox = NotAsked
            , addState = EL.fromList [ initAddState mCallsignName ]
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
            , filterCallsignDebounce = Debounce.init
            , filterPositionDebounce = Debounce.init
            , filterCommentDebounce = Debounce.init
            , filterUnitDebounce = Debounce.init
            , loading = True
            , loadingUnitStats = True
            , unitStats = []
            , from = Le.Block.DateTime.init ()
            , to = Le.Block.DateTime.init ()
            , now = Nothing
            , isIgnoringDateFilter = False
            , sortingOrder = UnitAsc
            , showLoadMore = False
            , loadingMore = False
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
        [ E.sendCmd <| Task.attempt InitGotZone Le.Time.getZone
        , E.replaceRoute { path = Route.Path.RerCallsigns, hash = Nothing, query = Dict.remove "callsign" req.query }
        ]
    )


type Msg
    = InitGotZone (Result TimeZone.Error ( String, Time.Zone ))
    | GotCallsigns (Result ApiError B.ListCallsignsRsp)
    | GotCallsignsWithUnitsFromInbox (Result ApiError B.GetCallsignsWithUnitsFromInboxRsp)
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
    | FilterCallsignDebounceMsg Debounce.Msg
    | FilterPositionDebounceMsg Debounce.Msg
    | FilterCommentDebounceMsg Debounce.Msg
    | FilterUnitDebounceMsg Debounce.Msg
    | Refresh
    | GotUnitStats (Result ApiError B.CallsignUnitStatsRsp)
    | DateTimeFromMsg (Le.Block.DateTime.Msg Msg)
    | DateTimeToMsg (Le.Block.DateTime.Msg Msg)
    | InitGotTime Time.Zone Time.Posix
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
    , inpComment : String
    , inpDeveloping : Bool
    , inpRadioFreq : String
    }


type alias EditCallsignState =
    { inpCallsign : String
    , inpPosition : String
    , inpComment : String
    , inpUnitId : Int
    , inpUnitSelState : Select.State
    , inpUnitSelMenu : List (Select.MenuItem Int)
    , inpSourceId : Int
    , inpDeveloping : Bool
    , inpRadioFreq : String
    }


initAddState : Maybe String -> AddState
initAddState mCallsignName =
    { inpCallsign = Maybe.withDefault "" mCallsignName, inpPosition = "", inpComment = "", inpDeveloping = False, inpRadioFreq = "" }



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


loadCallsignsCmd : Model -> Cmd Msg
loadCallsignsCmd model =
    Api.sigint_list_callsigns GotCallsigns
        { afterId = Nothing
        , beforeId = Nothing
        , filterCallsign = Just model.filterCallsign
        , filterPosition = Just model.filterPosition
        , filterComment = Just model.filterComment
        , filterUnit = Just model.filterUnit
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
        , limit = Just 100
        , sortBy = Just (sortingOrderToBackendSort model.sortingOrder)
        }


loadMoreCallsignsCmd : Model -> Cmd Msg
loadMoreCallsignsCmd model =
    case List.reverse model.callsigns |> List.head of
        Nothing ->
            Cmd.none

        Just lastCallsign ->
            Api.sigint_list_callsigns GotCallsigns
                { afterId = Just lastCallsign.id
                , beforeId = Nothing
                , filterCallsign = Just model.filterCallsign
                , filterPosition = Just model.filterPosition
                , filterComment = Just model.filterComment
                , filterUnit = Just model.filterUnit
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
                , limit = Just 100
                , sortBy = Just (sortingOrderToBackendSort model.sortingOrder)
                }


callsignsInpoxItemsPeriodLimit : Int
callsignsInpoxItemsPeriodLimit =
    14


loadCallsignsWithUnitsFromInbox : Model -> Effect Msg
loadCallsignsWithUnitsFromInbox model =
    case ( model.now, ( model.from.datePosix, model.to.datePosix ) ) of
        ( Just now, ( Just dateFrom, Just dateTo ) ) ->
            let
                tillDateInclusiveMs =
                    if model.isIgnoringDateFilter then
                        Time.posixToMillis now

                    else
                        Time.posixToMillis dateTo

                sinceDateInclusiveMs =
                    if model.isIgnoringDateFilter then
                        Time.posixToMillis (Le.Time.xDaysAgo callsignsInpoxItemsPeriodLimit now)

                    else if (Time.posixToMillis dateTo - Time.posixToMillis dateFrom) < Le.Time.xDaysInMillis callsignsInpoxItemsPeriodLimit then
                        Time.posixToMillis dateFrom

                    else
                        Time.posixToMillis (Le.Time.xDaysAgo callsignsInpoxItemsPeriodLimit dateTo)
            in
            E.sendCmd
                (Api.sigint_callsigns_with_units_from_inbox
                    GotCallsignsWithUnitsFromInbox
                    { callsigns = model.callsigns |> List.map (\callsign -> callsign.callsign)
                    , sinceDateInclusiveMs = sinceDateInclusiveMs
                    , tillDateInclusiveMs = tillDateInclusiveMs
                    }
                )

        _ ->
            E.none


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
update req shared msg model =
    case msg of
        InitGotZone (Err e) ->
            ( model
            , E.showError
                ("Error getting timezone: " ++ renderZoneError e)
            )

        InitGotZone (Ok ( _, zone )) ->
            ( { model | zone = Just zone }
            , E.sendCmd <|
                Task.perform (InitGotTime zone) Time.now
            )

        InitGotTime zone now_ ->
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
            ( m2
            , initLoad m2
            )

        GotCallsigns (Err err) ->
            ( { model | loading = False, loadingMore = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних" err
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
                        , callsignsWithUnitsFromInbox = Loading
                        , loading = False
                        , loadingMore = False
                        , showLoadMore = rsp.showLoadMore
                    }
            in
            ( m2, loadCallsignsWithUnitsFromInbox m2 )

        GotCallsignsWithUnitsFromInbox (Err err) ->
            ( { model | callsignsWithUnitsFromInbox = Failure err }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження позивних з підрозділами" err
            )

        GotCallsignsWithUnitsFromInbox (Ok rsp) ->
            ( { model
                | callsignsWithUnitsFromInbox = Success rsp.callsignsWithUnits
              }
            , E.none
            )

        AddStateMsg pos state ->
            let
                triples : List AddState
                triples =
                    state.inpCallsign
                        |> String.lines
                        |> List.map (String.split "\t")
                        |> List.filterMap
                            (\row ->
                                case row of
                                    [ a, b, c ] ->
                                        Just
                                            { inpCallsign = a
                                            , inpPosition = b
                                            , inpComment = c
                                            , inpDeveloping = False
                                            , inpRadioFreq = ""
                                            }

                                    _ ->
                                        Nothing
                            )

                addState =
                    if pos > 0 || triples == [] then
                        EL.setAtPos pos state model.addState

                    else
                        triples |> EL.fromList
            in
            ( { model | addState = addState }
            , E.none
            )

        InpSource v ->
            ( { model | inpSource = String.toInt v }, E.none )

        AddUnitSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpUnitSelState

                mUnitId =
                    Le.Block.Select.singleUpd mAction model.inpUnit

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
                            case Le.Block.Select.singleUpd mAction (Just editState.inpUnitId) of
                                Nothing ->
                                    Nothing

                                Just unitId ->
                                    Just
                                        { editState
                                            | inpUnitSelState = iState
                                            , inpUnitId = unitId
                                        }
                      }
                    , E.sendCmd <| Cmd.map EditUnitSelMsg iCmd
                    )

        -- adds many
        AddCallsign ->
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
                                                        , unitId = unitId
                                                        , sourceId = sourceId
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення позивного" err
            )

        AddCallsignDone (Ok newCallsign) ->
            ( { model
                | callsigns = newCallsign :: model.callsigns
                , addState = EL.fromList [ initAddState Nothing ]
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
                                    if editState.inpSourceId == 2 then
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
                                        , unitId = editState.inpUnitId
                                        , sourceId = editState.inpSourceId
                                        , createdAt = callsign.createdAt
                                        , developing = editState.inpDeveloping
                                        , radioFreq = Just editState.inpRadioFreq
                                        , active = True
                                        }
                                )

                            else
                                ( { model | validationError = Just "При виборі джерела 'РО' необхідно вказати частоту" }
                                , E.none
                                )

        EditCallsignDone _ (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення позивного" err
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

        EditCallsignCancel id ->
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення позивного" err
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
                , inpUnit = Nothing
              }
            , E.none
            )

        GotSources (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел" err
            )

        GotSources (Ok rsp) ->
            ( { model
                | sources = rsp.sources
                , inpSource =
                    case model.inpSource of
                        Nothing ->
                            rsp.sources |> List.head |> Maybe.map .id

                        Just v ->
                            Just v
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

        GotUnitStats (Err err) ->
            ( { model | loadingUnitStats = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
            )

        GotUnitStats (Ok rsp) ->
            ( { model | unitStats = rsp.units, loadingUnitStats = False }
            , E.none
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
            case m2.from.datePosix of
                Nothing ->
                    ( m2, eff2 )

                Just _ ->
                    ( m2, loadCallsigns m2 )

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
                    Le.Block.Select.singleUpd mAction model.inpSource
            in
            ( { model
                | inpSourceSelState = imodel2
                , inpSource = updatedSourceId
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
            ( { model | filterCallsign = "", filterPosition = "", filterComment = "", filterUnit = "" }, loadCallsigns model )

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
                                    if editState.inpSourceId == 2 then
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
                                        , unitId = editState.inpUnitId
                                        , sourceId = editState.inpSourceId
                                        , createdAt = callsign.createdAt
                                        , developing = editState.inpDeveloping
                                        , radioFreq = Just editState.inpRadioFreq
                                        , active = True
                                        }
                                )

                            else
                                ( { model | validationError = Just "При виборі джерела 'РО' необхідно вказати частоту" }
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
subscriptions model =
    Sub.none


callsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.Callsign Msg
callsignsTableConfig shared model user =
    let
        hasEditorRole =
            Le.Auth.hasRole "CallsignsEditor" user || Le.Auth.hasRole "UnitsEditor" user

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
                                    FloatingPopup.new
                                        { anchorContent =
                                            span
                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                ]
                                                [ text "Показати повний коментар"
                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                ]
                                        , popupContent =
                                            div [ class "comment-popup-content p-4" ]
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
                                        |> FloatingPopup.withPlacement FloatingPopup.Top
                                        |> FloatingPopup.view

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
                { name = "Зустрічається у підрозділах"
                , viewData =
                    \callsign ->
                        { attributes = []
                        , children =
                            case model.callsignsWithUnitsFromInbox of
                                Loading ->
                                    [ Le.Block.Spinner.loadingSpinner2Sm ]

                                Success callsignsWithUnitsFromInbox ->
                                    let
                                        unit =
                                            case shared.masterUnits of
                                                Success units ->
                                                    ListX.find (\u -> u.id == callsign.unitId) (Dict.values units)

                                                _ ->
                                                    Nothing

                                        callsignWithUnitsFromInbox =
                                            ListX.find
                                                (\callsignWithUnitsFromInbox_ ->
                                                    String.contains (Tuple.first callsignWithUnitsFromInbox_) callsign.callsign
                                                )
                                                callsignsWithUnitsFromInbox

                                        unitsList =
                                            case callsignWithUnitsFromInbox of
                                                Nothing ->
                                                    []

                                                Just callsignWithUnitsFromInbox_ ->
                                                    case unit of
                                                        Nothing ->
                                                            callsignWithUnitsFromInbox_
                                                                |> Tuple.second

                                                        Just unit_ ->
                                                            callsignWithUnitsFromInbox_
                                                                |> Tuple.second
                                                                |> List.filter (\s -> not (String.contains s unit_.name))
                                    in
                                    [ div [ class "flex flex-col gap-[4px]" ]
                                        ((List.map (\u -> span [] [ text u ]) unitsList
                                            |> List.take 1
                                         )
                                            ++ (if List.length unitsList > 1 then
                                                    let
                                                        body =
                                                            span
                                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                                , style "cursor"
                                                                    (if isOpen then
                                                                        "default"

                                                                     else
                                                                        "pointer"
                                                                    )
                                                                , style "pointer-events"
                                                                    (if isOpen then
                                                                        "none"

                                                                     else
                                                                        "auto"
                                                                    )
                                                                ]
                                                                [ text ("Показати всі " ++ (unitsList |> List.length |> String.fromInt))
                                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                                ]

                                                        popupBody =
                                                            div
                                                                [ class "p-4 max-h-[300px] max-w-[400px] overflow-y-auto"
                                                                , style "position" "relative"
                                                                , style "z-index" "40"
                                                                ]
                                                                [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                                    [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                                        [ text ("Підрозділи (" ++ (unitsList |> List.length |> String.fromInt) ++ ")") ]
                                                                    ]
                                                                , div [ class "space-y-2" ]
                                                                    (List.map
                                                                        (\unitName ->
                                                                            div
                                                                                [ class "px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700" ]
                                                                                [ text unitName ]
                                                                        )
                                                                        unitsList
                                                                    )
                                                                ]

                                                        isOpen =
                                                            case model.rowShowAllPopupStatus of
                                                                Just ( callsignId, ShowAllUnits ) ->
                                                                    callsignId == callsign.id

                                                                _ ->
                                                                    False
                                                    in
                                                    [ FloatingPopup.new
                                                        { anchorContent = body
                                                        , popupContent = popupBody
                                                        , isOpen = isOpen
                                                        , onClose = RowShowAllPopupChanged Nothing
                                                        , onOpen = RowShowAllPopupChanged <| Just ( callsign.id, ShowAllUnits )
                                                        }
                                                        |> FloatingPopup.withPlacement FloatingPopup.Top
                                                        |> FloatingPopup.view
                                                    ]

                                                else
                                                    [ text "" ]
                                               )
                                        )
                                    ]

                                _ ->
                                    []
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData =
                    \callsign ->
                        { attributes = [ class "text-sm" ]
                        , children =
                            [ case ListX.find (\s -> s.id == callsign.sourceId) model.sources of
                                Nothing ->
                                    text "Loading..."

                                Just source ->
                                    if source.id == 2 && not (String.isEmpty (callsign.radioFreq |> def "")) then
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
                            [ case model.zone of
                                Nothing ->
                                    text "Loading..."

                                Just zone ->
                                    text <|
                                        Le.Time.renderDateF6 zone
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
editSidebarContent model shared user =
    case model.editingCallsign of
        Just callsign ->
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
                                        Le.Block.Select.renderSelectSingle
                                            selectItem
                                            editState.inpUnitSelState
                                            editState.inpUnitSelMenu
                                            "жоден"
                                            (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode))
                                ]
                            , div []
                                [ label [ class "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2" ]
                                    [ text "Джерело" ]
                                , div [ class "flex flex-wrap gap-2" ]
                                    (List.map
                                        (\source ->
                                            Tag.new
                                                { isActive = editState.inpSourceId == source.id
                                                , onToggle = EditCallsignMsg { editState | inpSourceId = source.id }
                                                }
                                                |> Tag.view source.name
                                        )
                                        model.sources
                                    )
                                , if editState.inpSourceId == 2 then
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
            Le.Auth.hasRole "CallsignsEditor" user || Le.Auth.hasRole "UnitsEditor" user

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
                        [ input
                            [ class "form-input uppercase w-full"
                            , rows 1
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
                                        Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)

                                    options2 =
                                        { options | disabled = not hasEditorRole }
                                  in
                                  Html.map AddUnitSelMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
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
                                        Le.Block.Select.renderSelectSingle
                                            selectItem
                                            model.inpSourceSelState
                                            (model.sources
                                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                            )
                                            "жоден"
                                            (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
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
                                , Attr.disabled (not hasEditorRole)
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
                    , if Maybe.withDefault 0 model.inpSource == 2 then
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
            ]
                |> List.filter identity
                |> List.length

        filterPanel =
            div [ class "flex flex-col gap-3" ]
                [ -- Title and Clear button row
                  div [ class "d-flex justify-content-between align-items-center" ]
                    [ div [ class "flex items-center gap-2" ]
                        [ if model.loading then
                            Le.Block.Spinner.loadingSpinner2Sm

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
                        [ div [ class "flex flex-wrap gap-2 mb-2" ]
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
                            ]
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
                                    (Le.Block.DateTime.new
                                        { model =
                                            if not model.isIgnoringDateFilter then
                                                model.from

                                            else
                                                Le.Block.DateTime.init ()
                                        , toMsg = DateTimeFromMsg
                                        }
                                        |> Le.Block.DateTime.setDisabled model.isIgnoringDateFilter
                                        |> Le.Block.DateTime.view
                                    )
                                , span [ class "text-sm text-gray-700 dark:text-gray-300" ] [ text "по" ]
                                , div [ class "inline-flex" ]
                                    (Le.Block.DateTime.new
                                        { model =
                                            if not model.isIgnoringDateFilter then
                                                model.to

                                            else
                                                Le.Block.DateTime.init ()
                                        , toMsg = DateTimeToMsg
                                        }
                                        |> Le.Block.DateTime.setDisabled model.isIgnoringDateFilter
                                        |> Le.Block.DateTime.view
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
                                [ Le.Block.Spinner.loadingSpinner
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
                                    [ Le.Block.Spinner.loadingSpinner2Sm ]

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
            , selectedUnit = model.filterUnit
            , autoExpandArmies = False
            , autoExpandDivisions = True
            , autoExpandRegiments = True
            , autoExpandBattalions = True
            }
    in
    if model.loadingUnitStats then
        Le.Block.Spinner.loadingSpinner

    else
        section []
            [ div [ class "p-4 border-b border-border" ]
                [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2" ]
                    [ Html.text "Підрозділи" ]
                , p [ class "text-sm text-gray-600 dark:text-gray-400" ]
                    [ Html.text "Оберіть підрозділ для фільтрації" ]
                ]
            , UnitHierarchy.view config
                (case shared.masterUnits of
                    Success units ->
                        Dict.values units

                    _ ->
                        []
                )
                model.unitStats
            ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "позивні"
    , body =
        [ div [ class "flex justify-start items-start h-[calc(100vh-50px)]" ]
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
                    [ span [ class "me-2" ] [ text "позивні" ]
                    , button
                        [ type_ "button"
                        , class "inline-block btn btn-outline-secondary me-2"
                        , onClick Refresh
                        , attribute "data-tooltip" "оновити"
                        , attribute "data-position" "bottom"
                        ]
                        (if model.loading then
                            [ Le.Block.Spinner.loadingSpinner2Sm ]

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
