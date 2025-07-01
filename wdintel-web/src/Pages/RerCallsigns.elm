module Pages.RerCallsigns exposing (AddState, EditCallsignState, Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.ModalDialog as ModalDialog
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Set exposing (Set)
import EnumeratedList as EL exposing (EnumeratedList)
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
import Le.Block.Toast
import Le.RemoteData exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Select
import Shared
import Task
import Time
import TimeZone
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init req
        , update = update req
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


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , zone : Maybe Time.Zone
    , units : List B.Unit
    , callsigns : List B.Callsign
    , callsignsWithUnitsFromInbox : RemoteData ApiError (List ( String, List String ))
    , addState : EnumeratedList AddState
    , inpUnitSelState : Select.State
    , inpUnitSelMenu : List (Select.MenuItem Int)
    , inpUnit : Maybe Int
    , editCallsign : Dict Int EditCallsignState
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
    }


type SortingOrder
    = AscAlphabetically
    | DescAlphabetically
    | Default


init : Route () -> () -> ( Model, Effect Msg )
init req _ =
    let
        mCallsignName =
            Dict.get "callsign" req.query

        m2 : Model
        m2 =
            { formErrors = Dict.empty
            , toasts = Le.Block.Toast.init
            , zone = Nothing
            , units = []
            , callsigns = []
            , callsignsWithUnitsFromInbox = NotAsked
            , addState = EL.fromList [ initAddState mCallsignName ]
            , inpUnitSelState = Select.initState (Select.selectIdentifier "sel-unit-add")
            , inpUnitSelMenu = []
            , inpUnit = Nothing
            , editCallsign = Dict.empty
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
            , sortingOrder = Default
            , showLoadMore = False
            , loadingMore = False
            , inpSourceSelState = Select.initState (Select.selectIdentifier "inpSourceSelState")
            , inpSourceSelMenu = []
            , expandedArmies = Set.empty
            , expandedDivisions = Set.empty
            , expandedRegiments = Set.empty
            , expandedBattalions = Set.empty
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <| Task.attempt InitGotZone Le.Time.getZone
        , E.replaceRoute { path = Route.Path.RerCallsigns, hash = Nothing, query = Dict.remove "callsign" req.query }
        ]
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | InitGotZone (Result TimeZone.Error ( String, Time.Zone ))
    | GotUnits (Result ApiError B.ListUnitsRsp)
    | GotCallsigns (Result ApiError B.ListCallsignsRsp)
    | GotCallsignsWithUnitsFromInbox (Result ApiError B.GetCallsignsWithUnitsFromInboxRsp)
    | AddStateMsg Int AddState
    | InpSource String
    | AddUnitSelMsg (Select.Msg Int)
    | EditUnitSelMsg Int (Select.Msg Int)
    | AddCallsign
    | AddCallsignDone (Result ApiError B.Callsign)
    | EditCallsign Int
    | EditCallsignMsg Int EditCallsignState
    | EditCallsignSave Int
    | EditCallsignDone Int (Result ApiError B.Callsign)
    | EditCallsignCancel Int
    | DeleteCallsign Int
    | DeleteCallsignConfirm
    | DeleteCallsignCancel
    | DeleteCallsignDone (Result ApiError B.Callsign)
    | ClearInputs
    | GotSources (Result ApiError B.ListSourcesRsp)
    | ReloadUnits
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
    | LoadMore
    | InpSourceSelMsg (Select.Msg Int)
    | ToggleArmyExpanded String
    | ToggleDivisionExpanded String String
    | ToggleRegimentExpanded String String String
    | ToggleBattalionExpanded String String String String


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


initLoad : Model -> Effect Msg
initLoad model =
    E.batch
        [ loadUnits
        , loadCallsigns model
        , loadSources
        , loadUnitStats
        ]


loadUnits : Effect Msg
loadUnits =
    E.getUnits GotUnits
        { sortBy = Nothing
        , afterUnitId = Nothing
        , beforeUnitId = Nothing
        }


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
    { strategy = Debounce.later 50
    , transform = FilterCallsignDebounceMsg
    }


filterPositionDebounceConfig : Debounce.Config Msg
filterPositionDebounceConfig =
    { strategy = Debounce.later 50
    , transform = FilterPositionDebounceMsg
    }


filterCommentDebounceConfig : Debounce.Config Msg
filterCommentDebounceConfig =
    { strategy = Debounce.later 50
    , transform = FilterCommentDebounceMsg
    }


filterUnitDebounceConfig : Debounce.Config Msg
filterUnitDebounceConfig =
    { strategy = Debounce.later 50
    , transform = FilterUnitDebounceMsg
    }


update : Route () -> Msg -> Model -> ( Model, Effect Msg )
update req msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        InitGotZone (Err e) ->
            ( model
            , E.sendCmd <|
                Le.Block.Toast.addError
                    ToastMsg
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

        GotUnits (Err err) ->
            Api.handleHttpError ToastMsg err model

        GotUnits (Ok rsp) ->
            case Dict.get "unitId" req.query |> Maybe.andThen String.toInt of
                Just unitId ->
                    ( { model
                        | units = rsp.units
                        , inpUnitSelMenu =
                            List.map
                                (\u -> Select.basicMenuItem { item = u.id, label = u.name })
                                rsp.units
                        , inpUnit = List.filter (\x -> x.id == unitId) rsp.units |> List.head |> Maybe.map .id
                      }
                    , E.replaceRoute { path = Route.Path.RerCallsigns, hash = Nothing, query = Dict.remove "unitId" req.query }
                    )

                Nothing ->
                    ( { model
                        | units = rsp.units
                        , inpUnitSelMenu =
                            List.map
                                (\u -> Select.basicMenuItem { item = u.id, label = u.name })
                                rsp.units
                      }
                    , E.none
                    )

        GotCallsigns (Err err) ->
            Api.handleHttpError ToastMsg err { model | loading = False, loadingMore = False }

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
            Api.handleHttpError ToastMsg err { model | callsignsWithUnitsFromInbox = Failure err }

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
                    mUnitId |> andThen (\unitId -> ListX.find (\y -> y.id == unitId) model.units)

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

        EditUnitSelMsg id selMsg ->
            case Dict.get id model.editCallsign of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editState.inpUnitSelState
                    in
                    ( { model
                        | editCallsign =
                            case Le.Block.Select.singleUpd mAction (Just editState.inpUnitId) of
                                Nothing ->
                                    Dict.remove id model.editCallsign

                                Just unitId ->
                                    Dict.insert id
                                        { editState
                                            | inpUnitSelState = iState
                                            , inpUnitId =
                                                unitId
                                        }
                                        model.editCallsign
                      }
                    , E.sendCmd <| Cmd.map (EditUnitSelMsg id) iCmd
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
            Api.handleHttpError ToastMsg err model

        AddCallsignDone (Ok _) ->
            ( { model
                | loading = True
                , loadingUnitStats = True
                , addState = EL.fromList [ initAddState Nothing ]
              }
            , initLoad model
            )

        EditCallsign id ->
            case ListX.find (\c -> c.id == id) model.callsigns of
                Nothing ->
                    ( model, E.none )

                Just callsign ->
                    ( { model
                        | editCallsign =
                            Dict.insert id
                                { inpCallsign = callsign.callsign
                                , inpPosition = callsign.position
                                , inpComment = callsign.comment
                                , inpUnitId = callsign.unitId
                                , inpSourceId = callsign.sourceId
                                , inpUnitSelState =
                                    Select.initState
                                        (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt id)
                                , inpUnitSelMenu =
                                    List.map
                                        (\u -> Select.basicMenuItem { item = u.id, label = u.name })
                                        model.units
                                , inpDeveloping = callsign.developing
                                , inpRadioFreq = callsign.radioFreq |> def ""
                                }
                                model.editCallsign
                      }
                    , E.none
                    )

        EditCallsignMsg id editState ->
            ( { model
                | editCallsign =
                    Dict.insert id editState model.editCallsign
              }
            , E.none
            )

        EditCallsignSave id ->
            case Dict.get id model.editCallsign of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    case ListX.find (\c -> c.id == id) model.callsigns of
                        Nothing ->
                            ( model, E.none )

                        Just callsign ->
                            ( model
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

        EditCallsignDone _ (Err err) ->
            Api.handleHttpError ToastMsg err model

        EditCallsignDone id (Ok _) ->
            ( { model
                | editCallsign = Dict.remove id model.editCallsign
                , loading = True
              }
            , loadCallsigns model
            )

        EditCallsignCancel id ->
            ( { model | editCallsign = Dict.remove id model.editCallsign }, E.none )

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
            Api.handleHttpError ToastMsg err model

        DeleteCallsignDone (Ok _) ->
            ( { model | loading = True }
            , loadCallsigns model
            )

        ClearInputs ->
            ( { model
                | addState = EL.fromList [ initAddState Nothing ]
                , inpUnit = Nothing
              }
            , E.none
            )

        GotSources (Err err) ->
            Api.handleHttpError ToastMsg err model

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

        ReloadUnits ->
            ( model, loadUnits )

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
            Api.handleHttpError ToastMsg
                err
                { model | loadingUnitStats = False }

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
            ( { model
                | sortingOrder =
                    case model.sortingOrder of
                        Default ->
                            AscAlphabetically

                        AscAlphabetically ->
                            DescAlphabetically

                        DescAlphabetically ->
                            AscAlphabetically
              }
            , E.none
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
                key = armyName ++ ":" ++ divisionName
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
                key = armyName ++ ":" ++ divisionName ++ ":" ++ regimentName
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
                key = armyName ++ ":" ++ divisionName ++ ":" ++ regimentName ++ ":" ++ battalionName
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


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


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

        renderUnitsFromInboxTd : B.Callsign -> Html Msg
        renderUnitsFromInboxTd callsign =
            case model.callsignsWithUnitsFromInbox of
                Loading ->
                    td [ class "align-middle text-center", style "width" "210px" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

                Success callsignsWithUnitsFromInbox ->
                    let
                        unit =
                            ListX.find (\u -> u.id == callsign.unitId) model.units

                        callsignWithUnitsFromInbox =
                            ListX.find
                                (\callsignWithUnitsFromInbox_ ->
                                    String.contains (Tuple.first callsignWithUnitsFromInbox_) callsign.callsign
                                )
                                callsignsWithUnitsFromInbox
                    in
                    td [ style "width" "210px" ]
                        [ case callsignWithUnitsFromInbox of
                            Nothing ->
                                text ""

                            Just callsignWithUnitsFromInbox_ ->
                                text
                                    (case unit of
                                        Nothing ->
                                            callsignWithUnitsFromInbox_
                                                |> Tuple.second
                                                |> String.join ", "

                                        Just unit_ ->
                                            callsignWithUnitsFromInbox_
                                                |> Tuple.second
                                                |> List.filter (\s -> not (String.contains s unit_.name))
                                                |> String.join ", "
                                    )
                        ]

                _ ->
                    td [ style "width" "210px" ] []

        renderCallsignTrView : Int -> B.Callsign -> Html Msg
        renderCallsignTrView rowIndex callsign =
            tr
                [ class <|
                    if callsign.active then
                        ""

                    else
                        "disabled"
                ]
                [ td
                    [ title (String.fromInt callsign.id)
                    ]
                    [ div []
                        [ div [ class "text-uppercase" ]
                            [ text callsign.callsign ]
                        , HtmlX.viewIf callsign.developing
                            (div [ class "badge rounded-pill text-bg-warning" ]
                                [ text "в дорозвідці" ]
                            )
                        ]
                    ]
                , td [] [ text callsign.position ]
                , td [ class "relative" ]
                    [ text callsign.comment
                    , Watermark.new user.name
                        |> Watermark.withPositioning ( 5, 5 )
                        |> Watermark.withRotate -10
                        |> Watermark.withFontSize "1.3rem"
                        |> Watermark.withOpacity 0.3
                        |> Watermark.view
                        |> HtmlX.viewIf (Basics.remainderBy 3 rowIndex == 0)
                    ]
                , td []
                    [ case ListX.find (\u -> u.id == callsign.unitId) model.units of
                        Nothing ->
                            text "<Виберіть підрозділ>"

                        Just unit ->
                            text unit.name
                    ]
                , renderUnitsFromInboxTd callsign
                , td []
                    [ case ListX.find (\s -> s.id == callsign.sourceId) model.sources of
                        Nothing ->
                            text "Loading..."

                        Just source ->
                            if source.id == 2 && not (String.isEmpty (callsign.radioFreq |> def "")) then
                                text (source.name ++ " (" ++ def "" callsign.radioFreq ++ ")")

                            else
                                text source.name
                    ]
                , td []
                    [ case model.zone of
                        Nothing ->
                            text "Loading..."

                        Just zone ->
                            text <|
                                Le.Time.renderDateF6 zone
                                    (Time.millisToPosix callsign.createdAt)
                    ]
                , if hasEditorRole then
                    td []
                        [ div [ class "text-sm" ]
                            [ div [ class "flex gap-2" ]
                                [ button
                                    [ title "Редагувати"
                                    , class "icon-btn icon-btn-primary"
                                    , onClick (EditCallsign callsign.id)
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
                        ]

                  else
                    text ""
                ]

        renderCallsignTrEdit : B.Callsign -> EditCallsignState -> Html Msg
        renderCallsignTrEdit callsign editState =
            tr []
                [ td []
                    [ div [ class "flex flex-col gap-2 w-full" ]
                        [ input
                            [ class "form-input uppercase w-full"
                            , type_ "text"
                            , placeholder "Позивний"
                            , value editState.inpCallsign
                            , onInput <|
                                EditCallsignMsg callsign.id
                                    << (\v -> { editState | inpCallsign = v })
                            ]
                            []
                        , div [ class "flex items-center gap-2 mt-1" ]
                            [ Checkbox.new
                                { isChecked = editState.inpDeveloping
                                , onToggle = \v -> EditCallsignMsg callsign.id { editState | inpDeveloping = v }
                                }
                                |> Checkbox.withContent [ text "в дорозвідці" ]
                                |> Checkbox.view
                            ]
                        ]
                    ]
                , td []
                    [ input
                        [ class "form-input w-full"
                        , type_ "text"
                        , placeholder "Посада"
                        , value editState.inpPosition
                        , onInput <| EditCallsignMsg callsign.id << (\v -> { editState | inpPosition = v })
                        ]
                        []
                    ]
                , td []
                    [ textarea
                        [ class "form-input w-full"
                        , rows 1
                        , placeholder "Коментар"
                        , onInput <|
                            EditCallsignMsg callsign.id
                                << (\v -> { editState | inpComment = v })
                        , value editState.inpComment
                        ]
                        []
                    ]
                , td []
                    [ div [ class "w-full" ]
                        [ let
                            selectItem : Maybe (Select.MenuItem Int)
                            selectItem =
                                ListX.find (\unit -> unit.id == editState.inpUnitId) model.units
                                    |> Maybe.map
                                        (\unit ->
                                            Select.basicMenuItem
                                                { item = unit.id, label = unit.name }
                                        )
                          in
                          Html.map (EditUnitSelMsg callsign.id) <|
                            Styled.toUnstyled <|
                                Le.Block.Select.renderSelectSingle
                                    selectItem
                                    editState.inpUnitSelState
                                    editState.inpUnitSelMenu
                                    "жоден"
                                    (Le.Block.Select.defaultOptions shared.isDarkMode)
                        ]
                    ]
                , renderUnitsFromInboxTd callsign
                , td []
                    [ div [ class "flex flex-col gap-2 w-full" ]
                        [ select
                            [ class "form-input w-full"
                            , onInput <|
                                EditCallsignMsg callsign.id
                                    << (\v ->
                                            case String.toInt v of
                                                Nothing ->
                                                    editState

                                                Just v2 ->
                                                    { editState | inpSourceId = v2 }
                                       )
                            ]
                            (List.map
                                (\source ->
                                    option
                                        [ value (String.fromInt source.id)
                                        , selected (editState.inpSourceId == source.id)
                                        ]
                                        [ text source.name ]
                                )
                                model.sources
                            )
                        , if editState.inpSourceId == 2 then
                            input
                                [ class "form-input w-full"
                                , type_ "text"
                                , placeholder "Частота"
                                , value editState.inpRadioFreq
                                , onInput <| EditCallsignMsg callsign.id << (\v -> { editState | inpRadioFreq = v })
                                ]
                                []

                          else
                            text ""
                        ]
                    ]
                , td []
                    [ case model.zone of
                        Nothing ->
                            text "Loading..."

                        Just zone ->
                            text <|
                                Le.Time.renderDateF6 zone
                                    (Time.millisToPosix callsign.createdAt)
                    ]
                , td []
                    [ div [ class "flex gap-2" ]
                        [ button
                            [ title "Зберегти"
                            , class "icon-btn icon-btn-primary"
                            , onClick (EditCallsignSave callsign.id)
                            ]
                            [ i [ class "bi bi-check2" ] [] ]
                        , button
                            [ title "Відмінити"
                            , class "icon-btn icon-btn-danger"
                            , onClick (EditCallsignCancel callsign.id)
                            ]
                            [ i [ class "bi bi-x" ] [] ]
                        ]
                    ]
                ]

        renderCallsignTr : Int -> B.Callsign -> Html Msg
        renderCallsignTr rowIndex callsign =
            case Dict.get callsign.id model.editCallsign of
                Nothing ->
                    renderCallsignTrView rowIndex callsign

                Just editState ->
                    renderCallsignTrEdit callsign editState

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
                , div [ class "col-span-2" ]
                    [ HtmlX.viewIf (pos == 0) <|
                        let
                            selectItem =
                                model.inpUnit
                                    |> Maybe.andThen (\unitId -> ListX.find (\u -> u.id == unitId) model.units)
                                    |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })
                        in
                        div
                            [ class "flex items-center gap-2" ]
                            [ div [ class "flex-grow" ]
                                [ let
                                    options =
                                        Le.Block.Select.defaultOptions shared.isDarkMode

                                    options2 =
                                        { options | disabled = not hasEditorRole }
                                  in
                                  Html.map AddUnitSelMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
                                            selectItem
                                            model.inpUnitSelState
                                            model.inpUnitSelMenu
                                            "жоден"
                                            options2
                                ]
                            , button
                                [ title "Оновити список підрозділів"
                                , class "icon-btn icon-btn-primary"
                                , onClick ReloadUnits
                                ]
                                [ i [ class "bi bi-arrow-clockwise" ] [] ]
                            ]
                    ]
                , div [ class "col-span-3" ]
                    [ HtmlX.viewIf (pos == 0) <|
                        div [ class "flex items-center gap-2" ]
                            [ div [ class "flex-grow" ]
                                [ let
                                    selectItem =
                                        model.inpSource
                                            |> Maybe.andThen (\sourceId -> ListX.find (\s -> s.id == sourceId) model.sources)
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                  in
                                  Html.map InpSourceSelMsg <|
                                    Styled.toUnstyled <|
                                        Le.Block.Select.renderSelectSingle
                                            selectItem
                                            model.inpSourceSelState
                                            (model.sources
                                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                            )
                                            "жоден"
                                            (Le.Block.Select.defaultOptions shared.isDarkMode
                                                |> (\opts -> { opts | disabled = not hasEditorRole })
                                            )
                                ]
                            , div [ class "flex gap-2" ]
                                [ Button.new { label = "Додати", onClick = AddCallsign }
                                    |> Button.withDisabled (not hasEditorRole)
                                    |> Button.view
                                , Button.new { label = "Очистити", onClick = ClearInputs }
                                    |> Button.withStyleSecondary
                                    |> Button.withDisabled (not hasEditorRole)
                                    |> Button.view
                                ]
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

        filterPanel =
            div [ class "flex flex-col gap-3 p-2" ]
                [ div [ class "flex items-center gap-2" ]
                    [ if not model.loading then
                        i [ class "bi bi-filter" ] []

                      else
                        Le.Block.Spinner.loadingSpinner2Sm
                    , div [ class "flex flex-wrap gap-2 flex-grow" ]
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
                        ]
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
                        , div [ class "inline-flex" ] (
                            Le.Block.DateTime.new
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
                        , div [ class "inline-flex" ] (
                            Le.Block.DateTime.new
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

        sortByName model_ callsigns_ =
            case model_.sortingOrder of
                Default ->
                    callsigns_

                AscAlphabetically ->
                    callsigns_ |> List.sortBy .callsign

                DescAlphabetically ->
                    callsigns_ |> List.sortBy .callsign |> List.reverse

        mainContent =
            div []
                [ div
                    [ class "border mb-2 p-2"
                    ]
                    (EL.mapPair
                        addCallsignPanel
                        model.addState
                    )
                , div
                    [ class "border mb-4 p-2"
                    ]
                    [ filterPanel
                    ]
                , div [ class "relative" ]
                    [ table
                        [ class "table table-bordered table-sm"
                        , style "font-size" ".85rem"
                        ]
                        [ thead []
                            [ tr []
                                [ th
                                    [ scope "col"
                                    , class "nowrap"
                                    , style "min-width" "200px"
                                    ]
                                    [ text "Позивний "
                                    , i
                                        [ class
                                            (case model.sortingOrder of
                                                Default ->
                                                    "bi bi-sort-alpha-down"

                                                AscAlphabetically ->
                                                    "bi bi-sort-alpha-up"

                                                DescAlphabetically ->
                                                    "bi bi-sort-alpha-down"
                                            )
                                        , style "cursor" "pointer"
                                        , style "font-size" "16px"
                                        , onClick SortByCallsignName
                                    ]
                                    []
                                ]
                            , th
                                [ scope "col"
                                , class "nowrap"
                                , style "min-width" "200px"
                                ]
                                [ text "Посада" ]
                            , th
                                [ scope "col"
                                , class "nowrap"
                                , style "min-width" "200px"
                                ]
                                [ text "Коментар" ]
                            , th
                                [ scope "col"
                                , class "nowrap"
                                , style "min-width" "200px"
                                ]
                                [ text "Підрозділ" ]
                            , th
                                [ scope "col"
                                , class "nowrap"
                                , style "min-width" "210px"
                                ]
                                [ text "Зустрічається у підрозділах" ]
                            , th [ scope "col", class "nowrap" ] [ text "Джерело" ]
                            , th [ scope "col", class "nowrap" ] [ text "Створено" ]
                            , if hasEditorRole then
                                th
                                    [ scope "col"
                                    , class "nowrap"
                                    , style "min-width" "100px"
                                    ]
                                    [ text "Дії" ]

                              else
                                text ""
                            ]
                        ]
                    , tbody [] <|
                        List.indexedMap renderCallsignTr (model.callsigns |> sortByName model)
                    ]
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
        ]


unitsBlock : Shared.Model -> Model -> Html Msg
unitsBlock shared model =
    let
        -- Helper to get count for a unit
        getUnitCount : Int -> Int
        getUnitCount unitId =
            case ListX.find (\s -> s.unitId == unitId) model.unitStats of
                Just stat -> stat.count
                Nothing -> 0

        -- Helper to group units by hierarchy levels
        groupByField : (B.Unit -> String) -> List B.Unit -> List ( String, List B.Unit )
        groupByField field units =
            let
                add : B.Unit -> Dict.Dict String (List B.Unit) -> Dict.Dict String (List B.Unit)
                add unit acc =
                    let 
                        key = field unit
                    in
                    Dict.update key (\maybe -> Just (unit :: Maybe.withDefault [] maybe)) acc
            in
            List.foldr add Dict.empty units
                |> Dict.toList
                |> List.sortBy Tuple.first

        -- Group units by army
        armies : List ( String, List B.Unit )
        armies =
            groupByField .army (List.filter .active model.units)

        -- Group units by division within an army
        divisions : String -> List ( String, List B.Unit )
        divisions armyName =
            model.units
                |> List.filter (\u -> u.active && u.army == armyName)
                |> groupByField .division

        -- Group units by regiment within a division
        regiments : String -> String -> List ( String, List B.Unit )
        regiments armyName divisionName =
            model.units
                |> List.filter (\u -> u.active && u.army == armyName && u.division == divisionName)
                |> groupByField .regiment

        -- Group units by battalion within a regiment
        battalions : String -> String -> String -> List ( String, List B.Unit )
        battalions armyName divisionName regimentName =
            model.units
                |> List.filter (\u -> u.active && u.army == armyName && u.division == divisionName && u.regiment == regimentName)
                |> groupByField .battalion

        -- Get companies within a battalion
        companies : String -> String -> String -> String -> List B.Unit
        companies armyName divisionName regimentName battalionName =
            model.units
                |> List.filter (\u -> u.active && u.army == armyName && u.division == divisionName && u.regiment == regimentName && u.battalion == battalionName)
                |> List.sortBy .company

        -- Render a single unit with count
        renderUnit : B.Unit -> Html Msg
        renderUnit unit =
            let
                count = getUnitCount unit.id
                isSelected = model.filterUnit == unit.name
                countText = if count > 0 then " (" ++ String.fromInt count ++ ")" else ""
            in
            div
                [ class ("px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors " ++ 
                        if isSelected then "bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500" else "")
                , onClick (FilterUnitMsg unit.name)
                ]
                [ text (unit.name ++ countText) ]

        -- Render companies level
        renderCompanies : String -> String -> String -> String -> Html Msg
        renderCompanies armyName divisionName regimentName battalionName =
            let
                companyUnits = companies armyName divisionName regimentName battalionName
            in
            if List.isEmpty companyUnits then
                text ""
            else
                div [ class "ml-6 space-y-1" ]
                    (List.map renderUnit companyUnits)

        -- Render battalions level
        renderBattalions : String -> String -> String -> Html Msg
        renderBattalions armyName divisionName regimentName =
            let
                battalionGroups = battalions armyName divisionName regimentName
                isExpanded = Set.member (armyName ++ ":" ++ divisionName ++ ":" ++ regimentName) model.expandedRegiments
            in
            if List.isEmpty battalionGroups then
                text ""
            else if not isExpanded then
                text ""
            else
                div [ class "ml-6 space-y-1" ]
                    (List.concatMap
                        (\(battalionName, battalionUnits) ->
                            if String.isEmpty battalionName then
                                List.map renderUnit battalionUnits
                            else
                                [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                    , onClick (ToggleBattalionExpanded armyName divisionName regimentName battalionName)
                                    ]
                                    [ span [ class "flex items-center gap-2" ] 
                                        [ battalionIndicator
                                        , text battalionName
                                        ]
                                    , i [ class "bi bi-chevron-down text-gray-500" ] []
                                    ]
                                , renderCompanies armyName divisionName regimentName battalionName
                                ]
                        )
                        battalionGroups
                    )

        -- Render regiments level
        renderRegiments : String -> String -> Html Msg
        renderRegiments armyName divisionName =
            let
                regimentGroups = regiments armyName divisionName
                isExpanded = Set.member (armyName ++ ":" ++ divisionName) model.expandedDivisions
            in
            if List.isEmpty regimentGroups then
                text ""
            else if not isExpanded then
                text ""
            else
                div [ class "ml-6 space-y-1" ]
                    (List.concatMap
                        (\(regimentName, regimentUnits) ->
                            if String.isEmpty regimentName then
                                List.map renderUnit regimentUnits
                            else
                                [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                    , onClick (ToggleRegimentExpanded armyName divisionName regimentName)
                                    ]
                                    [ span [ class "flex items-center gap-2" ] 
                                        [ regimentIndicator
                                        , text regimentName
                                        ]
                                    , i [ class "bi bi-chevron-down text-gray-500" ] []
                                    ]
                                , renderBattalions armyName divisionName regimentName
                                ]
                        )
                        regimentGroups
                    )

        -- Render divisions level
        renderDivisions : String -> Html Msg
        renderDivisions armyName =
            let
                divisionGroups = divisions armyName
                isExpanded = Set.member armyName model.expandedArmies
            in
            if List.isEmpty divisionGroups then
                text ""
            else if not isExpanded then
                text ""
            else
                div [ class "ml-6 space-y-1" ]
                    (List.concatMap
                        (\(divisionName, divisionUnits) ->
                            if String.isEmpty divisionName then
                                List.map renderUnit divisionUnits
                            else
                                [ div [ class "font-medium text-gray-700 dark:text-gray-300 py-1 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                    , onClick (ToggleDivisionExpanded armyName divisionName)
                                    ]
                                    [ span [ class "flex items-center gap-2" ] 
                                        [ divisionIndicator
                                        , text divisionName
                                        ]
                                    , i [ class "bi bi-chevron-down text-gray-500" ] []
                                    ]
                                , renderRegiments armyName divisionName
                                ]
                        )
                        divisionGroups
                    )

        -- Military hierarchy indicators
        armyIndicator : Html msg
        armyIndicator = 
            span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Армія" ] 
                [ text "XXX" ]

        divisionIndicator : Html msg
        divisionIndicator = 
            span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Дивізія" ] 
                [ text "XX" ]

        regimentIndicator : Html msg
        regimentIndicator = 
            span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Полк" ] 
                [ text "X" ]

        battalionIndicator : Html msg
        battalionIndicator = 
            span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Батальйон" ] 
                [ text "I" ]

        companyIndicator : Html msg
        companyIndicator = 
            span [ class "inline-block font-mono font-bold text-xs px-2 py-0.5 rounded mr-2 bg-red-100 text-red-800 border border-red-200", Attr.title "Рота" ] 
                [ text "II" ]

        -- Render army level
        renderArmy : ( String, List B.Unit ) -> Html Msg
        renderArmy ( armyName, armyUnits ) =
            let
                armyCount = List.sum (List.map (.id >> getUnitCount) armyUnits)
                armyCountText = if armyCount > 0 then " (" ++ String.fromInt armyCount ++ ")" else ""
                displayName = if String.isEmpty armyName then "Без армії" else armyName
                isExpanded = Set.member armyName model.expandedArmies
            in
            div [ class "border-b border-gray-200 dark:border-gray-700" ]
                [ div 
                    [ class "px-3 py-2 font-semibold text-gray-900 dark:text-gray-100 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-between"
                    , onClick (ToggleArmyExpanded armyName)
                    ]
                    [ span [ class "flex items-center gap-2" ] 
                        [ armyIndicator
                        , text (displayName ++ armyCountText)
                        ]
                    , i [ class ("bi " ++ (if isExpanded then "bi-chevron-up" else "bi-chevron-down") ++ " text-gray-500") ] []
                    ]
                , renderDivisions armyName
                ]

    in
    if model.loadingUnitStats then
        Le.Block.Spinner.loadingSpinner
    else
        div [ class "w-full max-w-md bg-card border rounded-lg shadow-sm overflow-hidden" ]
            [ div [ class "p-4 border-b border-gray-200 dark:border-gray-700" ]
                [ h3 [ class "text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2" ] 
                    [ text "Підрозділи" ]
                , p [ class "text-sm text-gray-600 dark:text-gray-400" ] 
                    [ text "Оберіть підрозділ для фільтрації" ]
                ]
            , div [ class "max-h-96 overflow-y-auto" ]
                (List.map renderArmy armies)
            , if not (String.isEmpty model.filterUnit) then
                div [ class "p-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800" ]
                    [ Button.new { label = "Очистити фільтр", onClick = FilterUnitMsg "" }
                        |> Button.withStyleSecondary
                        |> Button.view
                    ]
              else
                text ""
            ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "позивні"
    , body =
        [ Le.Block.Toast.view ToastMsg model.toasts <|
            div [ class "flex justify-start items-start h-[calc(100vh-50px)]" ]
                [ div
                    [ class "self-stretch max-h-full min-w-[200px] overflow-y-auto"
                    ]
                    [ div
                        [ class "flex flex-col pt-1"
                        ]
                        [ unitsBlock shared model
                        , div [ class "grow" ] []
                        ]
                    ]
                , div
                    [ class "grow h-full overflow-auto"
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
