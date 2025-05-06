module Pages.RerImporter exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B exposing (..)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Le.Block.Spinner
import Le.Block.Toast
import Le.Components exposing (fieldError, isInvalidCls)
import Le.RerMessage
import Le.Time
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import List.Extra as ListX
import Maybe.Extra as MaybeX
import Page exposing (Page)
import PagePorts.RerImporterPorts as Ports
import Process
import Route exposing (Route)
import Set exposing (Set)
import Shared
import Task
import Time exposing (Posix)
import Time.Extra
import View exposing (View)
import Views


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , loadingInboxMessages : Bool
    , messages : List ( Int, InboxMessage )
    , zone : Maybe Time.Zone
    , inboxSubmitInProgress : Bool
    , inboxCursor : Maybe Int
    , earliestMessage : Maybe Posix
    , latestMessage : Maybe Posix
    , unreadCounters : Maybe B.UnreadCountersRsp
    , showDateSelector : Bool
    , showFilter : Bool
    , dateSelectedStr : String
    , dateSelected : Maybe Posix
    , groupInfos : Dict String B.SignalGroupEntry
    , profiles : Dict String (Maybe B.SignalProfileEntry)
    , filterOnlyShowUnprocessed : Bool
    , rowsModel : Le.RerMessage.Model
    , tags : List ( Int, B.Tag )
    , bookmarks : Set Int
    , importants : Set Int
    , callsignsInfo : Dict String (List B.CallsignInfo)
    }


init : () -> ( Model, Effect Msg )
init _ =
    let
        model =
            { formErrors = Dict.empty
            , toasts = Le.Block.Toast.init
            , loadingInboxMessages = True
            , messages = []
            , zone = Nothing
            , inboxSubmitInProgress = False
            , inboxCursor = Nothing
            , earliestMessage = Nothing
            , latestMessage = Nothing
            , unreadCounters = Nothing
            , showDateSelector = False
            , showFilter = False
            , dateSelectedStr = ""
            , dateSelected = Nothing
            , groupInfos = Dict.empty
            , profiles = Dict.empty
            , filterOnlyShowUnprocessed = False
            , rowsModel = Le.RerMessage.model0
            , tags = []
            , bookmarks = Set.empty
            , importants = Set.empty
            , callsignsInfo = Dict.empty
            }
    in
    ( model
    , E.batch
        [ E.getInboxMessages Nothing
            GotInbox
            { sinceIdNoninclusive = Nothing
            , beforeIdNoninclusive = Nothing
            , sinceDateInclusiveMs = Nothing
            , tillDateInclusiveMs = Nothing
            , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
            , checkedOnly = Nothing
            , selectedGroups = Nothing
            , selectedSenders = Nothing
            , deniedSenders = Nothing
            , selectedFreqs = Nothing
            , deniedFreqs = Nothing
            , selectedCallsigns = Nothing
            , selectedUnits = Nothing
            , selectedLocations = Nothing
            , includePelengLocations = Nothing
            , selectedTags = Nothing
            , nolimit = Nothing
            , orWithExtendedForm = Nothing
            , loadLatest = Nothing
            , returnDuplicates = Nothing
            , orBookmarked = Nothing
            , orImportant = Nothing
            , orWithCoords = Nothing
            , newestFirst = Nothing
            , search = Nothing
            , highlightCallsigns = Nothing
            , highlightSignals = Nothing
            , highlightKeywords = Nothing
            , highlightSearchres = Nothing
            , sortBy = Just ImsTimestamp
            , reportTagsOnlyThisUnit = Nothing
            , selectedPosts = Nothing
            , deniedPosts = Nothing
            , ignoreImportedCoords = Nothing
            , calculateFreqPelengsSummary = Nothing
            , filterTagsOption = Nothing
            , pageId = Just "rer-importer"
            , unitsExactMatchOnly = Nothing
            }
        , E.sendCmd <| Task.perform GotZone Time.here
        , E.sendCmd <| Api.rer_importer_inbox_cursor GotInboxCursor
        , E.getTags GotTags
        , Process.sleep (1000 * refreshCountersSecs)
            |> Task.perform UnreadCountersCycleSlept
            |> E.sendCmd
        , E.map RowsMsg Le.RerMessage.init
        ]
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | GotZone Time.Zone
    | GotInbox (Result ApiError B.InboxMessagesRsp)
    | LoadEarlier
    | LoadMore
    | InboxSubmit
    | InboxSubmitDone Int (Result ApiError ())
    | GotInboxCursor (Result ApiError (Maybe Int))
    | CursorUpdateDone (Result ApiError ())
    | GotUnreadCounters (Result ApiError B.UnreadCountersRsp)
    | UnreadCountersCycleGot (Result ApiError B.UnreadCountersRsp)
    | UnreadCountersCycleSlept ()
    | ToggleDateSelector
    | ToggleFilter
    | SetGotoDate String
    | GotoDate
    | GotGroupInfos (Result ApiError SignalGroupsRsp)
    | GotProfileInfos (Result ApiError SignalProfilesRsp)
    | GotTime Time.Zone Posix
    | ToggleFilterOnlyShowUnprocessed
    | ApplyFilters
    | RowsMsg Le.RerMessage.Msg
    | GotTags (Result ApiError (List ( Int, B.Tag )))


refreshCountersSecs =
    5


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update user shared
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


dateFieldErrId =
    "select-date"



-- todo: move out


computeEarliestMessage : List ( Int, InboxMessage ) -> Maybe Posix
computeEarliestMessage messages =
    List.foldl
        (\( _, msg ) acc ->
            case acc of
                Nothing ->
                    case msg.timestamp of
                        Nothing ->
                            Nothing

                        Just ts ->
                            Just (Time.millisToPosix ts)

                Just posix ->
                    case msg.timestamp of
                        Nothing ->
                            Just posix

                        Just ts ->
                            if Time.posixToMillis posix > ts then
                                Just (Time.millisToPosix ts)

                            else
                                Just posix
        )
        Nothing
        messages


computeLatestMessage : List ( Int, InboxMessage ) -> Maybe Posix
computeLatestMessage messages =
    List.foldl
        (\( _, msg ) acc ->
            case acc of
                Nothing ->
                    case msg.timestamp of
                        Nothing ->
                            Nothing

                        Just ts ->
                            Just (Time.millisToPosix ts)

                Just posix ->
                    case msg.timestamp of
                        Nothing ->
                            Just posix

                        Just ts ->
                            if Time.posixToMillis posix < ts then
                                Just (Time.millisToPosix ts)

                            else
                                Just posix
        )
        Nothing
        messages


update : B.User -> Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update user shared msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        GotTime zone time_ ->
            let
                dateSelected =
                    time_
                        |> Time.posixToMillis
                        |> (\x -> x - (1000 * 60 * 60))
                        |> Time.millisToPosix

                dateSelectedStr =
                    Le.Time.renderPartsAsInputValue (Time.Extra.posixToParts zone dateSelected)
            in
            ( { model
                | dateSelected = Just dateSelected
                , dateSelectedStr = dateSelectedStr
              }
            , E.none
            )

        GotInbox (Err e) ->
            Api.handleHttpError ToastMsg
                e
                { model | loadingInboxMessages = False }

        GotInbox (Ok { inboxItems }) ->
            let
                messages =
                    inboxItems

                mEarliestIdPred =
                    List.head messages
                        |> Maybe.map Tuple.first
                        |> Maybe.map (\x -> x - 1)

                mLastId =
                    ListX.last messages
                        |> Maybe.map Tuple.first

                unreadCounters2 =
                    case mLastId of
                        Just _ ->
                            model.unreadCounters

                        Nothing ->
                            Just { newerMsgCount = 0 }

                groupKeysNew =
                    Le.RerMessage.compNewGroups messages model.groupInfos

                profilesNew =
                    Le.RerMessage.compNewProfiles messages model.profiles
            in
            ( { model
                | messages = messages
                , loadingInboxMessages = False
                , earliestMessage = computeEarliestMessage messages
                , latestMessage = computeLatestMessage messages

                -- , inboxCursor = mEarliestIdPred
                , unreadCounters = unreadCounters2
              }
            , E.sendCmd <|
                Cmd.batch <|
                    [ case mEarliestIdPred of
                        Just earliestIdPred ->
                            Api.rer_importer_inbox_update_cursor CursorUpdateDone
                                { cursor = earliestIdPred }

                        Nothing ->
                            Cmd.none
                    , case mLastId of
                        Just lastId ->
                            Api.rer_importer_unread_counters GotUnreadCounters
                                { lastId = lastId
                                , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                                }

                        Nothing ->
                            Cmd.none
                    , if List.length profilesNew > 0 then
                        Api.rer_importer_signal_profile_info_batch
                            GotProfileInfos
                            { profiles = profilesNew |> List.map (\id -> { uuid = id }) }

                      else
                        Cmd.none
                    , if List.length groupKeysNew > 0 then
                        Api.rer_importer_signal_group_info_batch
                            GotGroupInfos
                            { groups = groupKeysNew |> List.map (\key -> { masterKey = key }) }

                      else
                        Cmd.none
                    ]
            )

        GotZone zone ->
            ( { model | zone = Just zone }
            , E.sendCmd <|
                Task.perform (GotTime zone) Time.now
            )

        LoadEarlier ->
            let
                mEarliestId =
                    List.head model.messages
                        |> Maybe.map Tuple.first

                mEarliestIdOrCursor =
                    mEarliestId
                        |> MaybeX.orElse model.inboxCursor
            in
            ( { model | loadingInboxMessages = True }
            , E.getInboxMessages Nothing
                GotInbox
                { sinceIdNoninclusive = Nothing
                , beforeIdNoninclusive = mEarliestIdOrCursor
                , sinceDateInclusiveMs = Nothing
                , tillDateInclusiveMs = Nothing
                , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                , checkedOnly = Nothing
                , selectedGroups = Nothing
                , selectedSenders = Nothing
                , deniedSenders = Nothing
                , selectedFreqs = Nothing
                , deniedFreqs = Nothing
                , selectedCallsigns = Nothing
                , selectedUnits = Nothing
                , selectedLocations = Nothing
                , includePelengLocations = Nothing
                , selectedTags = Nothing
                , nolimit = Nothing
                , orWithExtendedForm = Nothing
                , loadLatest = Nothing
                , returnDuplicates = Nothing
                , orBookmarked = Nothing
                , orImportant = Nothing
                , orWithCoords = Nothing
                , newestFirst = Nothing
                , search = Nothing
                , highlightCallsigns = Nothing
                , highlightSignals = Nothing
                , highlightKeywords = Nothing
                , highlightSearchres = Nothing
                , sortBy = Just ImsTimestamp
                , reportTagsOnlyThisUnit = Nothing
                , selectedPosts = Nothing
                , deniedPosts = Nothing
                , ignoreImportedCoords = Nothing
                , calculateFreqPelengsSummary = Nothing
                , filterTagsOption = Nothing
                , pageId = Just "rer-importer"
                , unitsExactMatchOnly = Nothing
                }
            )

        LoadMore ->
            let
                mOldestId =
                    ListX.last model.messages
                        |> Maybe.map Tuple.first

                -- mOldestIdSucc =
                --     mOldestId
                --         |> Maybe.map (\x -> x + 1)
            in
            ( { model | loadingInboxMessages = True }
            , E.batch
                [ E.getInboxMessages Nothing
                    GotInbox
                    { sinceIdNoninclusive = mOldestId
                    , beforeIdNoninclusive = Nothing
                    , sinceDateInclusiveMs = Nothing
                    , tillDateInclusiveMs = Nothing
                    , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                    , checkedOnly = Nothing
                    , selectedGroups = Nothing
                    , selectedSenders = Nothing
                    , deniedSenders = Nothing
                    , selectedFreqs = Nothing
                    , deniedFreqs = Nothing
                    , selectedCallsigns = Nothing
                    , selectedUnits = Nothing
                    , selectedLocations = Nothing
                    , includePelengLocations = Nothing
                    , selectedTags = Nothing
                    , nolimit = Nothing
                    , orWithExtendedForm = Nothing
                    , loadLatest = Nothing
                    , returnDuplicates = Nothing
                    , orBookmarked = Nothing
                    , orImportant = Nothing
                    , orWithCoords = Nothing
                    , newestFirst = Nothing
                    , search = Nothing
                    , highlightCallsigns = Nothing
                    , highlightSignals = Nothing
                    , highlightKeywords = Nothing
                    , highlightSearchres = Nothing
                    , sortBy = Just ImsTimestamp
                    , reportTagsOnlyThisUnit = Nothing
                    , selectedPosts = Nothing
                    , deniedPosts = Nothing
                    , ignoreImportedCoords = Nothing
                    , calculateFreqPelengsSummary = Nothing
                    , filterTagsOption = Nothing
                    , pageId = Just "rer-improrter"
                    , unitsExactMatchOnly = Nothing
                    }
                , E.sendCmd <|
                    case mOldestId of
                        Just oldestId ->
                            Api.rer_importer_inbox_update_cursor CursorUpdateDone
                                { cursor = oldestId }

                        Nothing ->
                            Cmd.none
                ]
            )

        InboxSubmit ->
            let
                mOldestId =
                    ListX.last model.messages
                        |> Maybe.map Tuple.first
            in
            case mOldestId of
                Nothing ->
                    ( model, E.none )

                Just oldestId ->
                    ( { model
                        | inboxSubmitInProgress = True
                        , inboxCursor = mOldestId
                      }
                    , E.sendCmd <|
                        Cmd.batch
                            [ Api.rer_importer_inbox_submit (InboxSubmitDone oldestId)
                                { messages = model.messages }
                            , Api.rer_importer_inbox_update_cursor CursorUpdateDone
                                { cursor = oldestId }
                            ]
                    )

        InboxSubmitDone _ (Err e) ->
            let
                m2 =
                    { model | inboxSubmitInProgress = False }
            in
            Api.handleHttpError ToastMsg e m2

        InboxSubmitDone oldestId (Ok ()) ->
            ( { model
                | inboxSubmitInProgress = False
                , loadingInboxMessages = True
                , messages = []
                , earliestMessage = Nothing
                , latestMessage = Nothing
              }
            , E.getInboxMessages Nothing
                GotInbox
                { sinceIdNoninclusive = Just oldestId
                , beforeIdNoninclusive = Nothing
                , sinceDateInclusiveMs = Nothing
                , tillDateInclusiveMs = Nothing
                , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                , checkedOnly = Nothing
                , selectedGroups = Nothing
                , selectedSenders = Nothing
                , deniedSenders = Nothing
                , selectedFreqs = Nothing
                , deniedFreqs = Nothing
                , selectedCallsigns = Nothing
                , selectedUnits = Nothing
                , selectedLocations = Nothing
                , includePelengLocations = Nothing
                , selectedTags = Nothing
                , nolimit = Nothing
                , orWithExtendedForm = Nothing
                , loadLatest = Nothing
                , returnDuplicates = Nothing
                , orBookmarked = Nothing
                , orImportant = Nothing
                , orWithCoords = Nothing
                , newestFirst = Nothing
                , search = Nothing
                , highlightCallsigns = Nothing
                , highlightSignals = Nothing
                , highlightKeywords = Nothing
                , highlightSearchres = Nothing
                , sortBy = Just ImsTimestamp
                , reportTagsOnlyThisUnit = Nothing
                , selectedPosts = Nothing
                , deniedPosts = Nothing
                , ignoreImportedCoords = Nothing
                , calculateFreqPelengsSummary = Nothing
                , filterTagsOption = Nothing
                , pageId = Just "rer-importer"
                , unitsExactMatchOnly = Nothing
                }
            )

        GotInboxCursor (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotInboxCursor (Ok mCursor) ->
            ( { model
                | inboxCursor = mCursor
              }
            , E.sendCmd <| Cmd.none
            )

        CursorUpdateDone (Err e) ->
            Api.handleHttpError ToastMsg e model

        CursorUpdateDone (Ok ()) ->
            ( model, E.none )

        GotUnreadCounters (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotUnreadCounters (Ok unreadCounters) ->
            ( { model | unreadCounters = Just unreadCounters }
            , E.none
            )

        UnreadCountersCycleSlept () ->
            let
                mLastIdOrCursor =
                    ListX.last model.messages
                        |> Maybe.map Tuple.first
                        |> MaybeX.orElse model.inboxCursor
            in
            ( model
            , E.sendCmd <|
                case mLastIdOrCursor of
                    Nothing ->
                        Cmd.none

                    Just lastIdOrCursor ->
                        Api.rer_importer_unread_counters UnreadCountersCycleGot
                            { lastId = lastIdOrCursor
                            , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                            }
            )

        UnreadCountersCycleGot rsp ->
            let
                m2 =
                    case rsp of
                        Err _ ->
                            model

                        Ok unreadCounters ->
                            { model | unreadCounters = Just unreadCounters }
            in
            ( m2
            , E.sendCmd <|
                (Process.sleep (1000 * 10)
                    |> Task.perform UnreadCountersCycleSlept
                )
            )

        ToggleDateSelector ->
            ( { model | showDateSelector = not model.showDateSelector }, E.none )

        ToggleFilter ->
            ( { model | showFilter = not model.showFilter }, E.none )

        ApplyFilters ->
            let
                mEarliestId =
                    List.head model.messages
                        |> Maybe.map Tuple.first

                mEarliestIdOrCursor =
                    mEarliestId
                        |> MaybeX.orElse model.inboxCursor
            in
            ( { model | showFilter = False }
            , E.getInboxMessages Nothing
                GotInbox
                { sinceIdNoninclusive = Nothing
                , beforeIdNoninclusive = mEarliestIdOrCursor
                , sinceDateInclusiveMs = Nothing
                , tillDateInclusiveMs = Nothing
                , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                , checkedOnly = Nothing
                , selectedGroups = Nothing
                , selectedSenders = Nothing
                , deniedSenders = Nothing
                , selectedFreqs = Nothing
                , deniedFreqs = Nothing
                , selectedCallsigns = Nothing
                , selectedUnits = Nothing
                , selectedLocations = Nothing
                , includePelengLocations = Nothing
                , selectedTags = Nothing
                , nolimit = Nothing
                , orWithExtendedForm = Nothing
                , loadLatest = Nothing
                , returnDuplicates = Nothing
                , orBookmarked = Nothing
                , orImportant = Nothing
                , orWithCoords = Nothing
                , newestFirst = Nothing
                , search = Nothing
                , highlightCallsigns = Nothing
                , highlightSignals = Nothing
                , highlightKeywords = Nothing
                , highlightSearchres = Nothing
                , sortBy = Just ImsTimestamp
                , reportTagsOnlyThisUnit = Nothing
                , selectedPosts = Nothing
                , deniedPosts = Nothing
                , ignoreImportedCoords = Nothing
                , calculateFreqPelengsSummary = Nothing
                , filterTagsOption = Nothing
                , pageId = Just "rer-importer"
                , unitsExactMatchOnly = Nothing
                }
            )

        SetGotoDate dateStr ->
            let
                m2 =
                    case model.zone of
                        Nothing ->
                            model

                        Just zone ->
                            case Le.Time.parseDatetimeParts dateStr of
                                Err e ->
                                    { model
                                        | formErrors =
                                            Dict.insert dateFieldErrId e model.formErrors
                                    }

                                Ok parts ->
                                    let
                                        formErrors2 =
                                            Dict.remove dateFieldErrId model.formErrors
                                    in
                                    { model
                                        | formErrors = formErrors2
                                        , dateSelected = Just (Time.Extra.partsToPosix zone parts)
                                    }

                m3 =
                    { m2 | dateSelectedStr = dateStr }
            in
            ( m3, E.none )

        GotoDate ->
            case model.dateSelected of
                Nothing ->
                    ( model, E.none )

                Just dateSelected ->
                    ( { model
                        | loadingInboxMessages = True
                        , showDateSelector = False
                      }
                    , E.getInboxMessages Nothing
                        GotInbox
                        { sinceIdNoninclusive = Nothing
                        , beforeIdNoninclusive = Nothing
                        , sinceDateInclusiveMs = Just (Time.posixToMillis dateSelected)
                        , tillDateInclusiveMs = Nothing
                        , onlyShowUnprocessed = Just model.filterOnlyShowUnprocessed
                        , checkedOnly = Nothing
                        , selectedGroups = Nothing
                        , selectedSenders = Nothing
                        , deniedSenders = Nothing
                        , selectedFreqs = Nothing
                        , deniedFreqs = Nothing
                        , selectedCallsigns = Nothing
                        , selectedUnits = Nothing
                        , selectedLocations = Nothing
                        , includePelengLocations = Nothing
                        , selectedTags = Nothing
                        , nolimit = Nothing
                        , orWithExtendedForm = Nothing
                        , loadLatest = Nothing
                        , returnDuplicates = Nothing
                        , orBookmarked = Nothing
                        , orImportant = Nothing
                        , orWithCoords = Nothing
                        , newestFirst = Nothing
                        , search = Nothing
                        , highlightCallsigns = Nothing
                        , highlightSignals = Nothing
                        , highlightKeywords = Nothing
                        , highlightSearchres = Nothing
                        , sortBy = Just ImsTimestamp
                        , reportTagsOnlyThisUnit = Nothing
                        , selectedPosts = Nothing
                        , deniedPosts = Nothing
                        , ignoreImportedCoords = Nothing
                        , calculateFreqPelengsSummary = Nothing
                        , filterTagsOption = Nothing
                        , pageId = Just "rer-importer"
                        , unitsExactMatchOnly = Nothing
                        }
                    )

        GotGroupInfos (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotGroupInfos (Ok groups) ->
            ( { model | groupInfos = groups.data |> List.foldl (\group acc -> Dict.insert group.masterKey group acc) model.groupInfos }, E.none )

        GotProfileInfos (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotProfileInfos (Ok profiles) ->
            ( { model | profiles = Dict.union profiles.data model.profiles }, E.none )

        ToggleFilterOnlyShowUnprocessed ->
            ( { model | filterOnlyShowUnprocessed = not model.filterOnlyShowUnprocessed }, E.none )

        RowsMsg rowsMsg ->
            let
                vps : Le.RerMessage.ViewParams
                vps =
                    { profiles = model.profiles
                    , groupInfos = model.groupInfos
                    , zone = model.zone
                    , messages = model.messages
                    , tags = model.tags
                    , bookmarks = model.bookmarks
                    , importants = model.importants
                    , callsignsInfo = model.callsignsInfo
                    , messageComments = Dict.empty
                    , user = user
                    , users = Dict.empty
                    , serverInfo = shared.serverInfo
                    , networks = Dict.empty
                    , masterUnits = Dict.empty
                    , freqNetworkIds = Dict.empty
                    , currentRoute = Nothing
                    }

                res =
                    Le.RerMessage.update vps rowsMsg model.rowsModel

                m2 =
                    { model | rowsModel = res.model, messages = res.messages }

                mAndCmds : ( Model, List (Effect Msg) )
                mAndCmds =
                    List.foldl
                        (\sig ( accM, accCmds ) ->
                            case sig of
                                Le.RerMessage.OutFocus { elemId } ->
                                    ( accM
                                    , accCmds ++ [ E.sendCmd <| Ports.rer_importer_focus { elemId = elemId } ]
                                    )

                                Le.RerMessage.OutToastMsg imsg ->
                                    let
                                        ( im, icmds ) =
                                            Le.Block.Toast.update imsg accM.toasts
                                    in
                                    ( { model | toasts = im }
                                    , (E.sendCmd <| Cmd.map ToastMsg icmds) :: accCmds
                                    )

                                Le.RerMessage.OutFormErrors _ ->
                                    ( accM
                                    , accCmds
                                    )

                                Le.RerMessage.OutBookmarkAdd msgId ->
                                    ( { accM | bookmarks = Set.insert msgId accM.bookmarks }
                                    , accCmds
                                    )

                                Le.RerMessage.OutBookmarkRm msgId ->
                                    ( { accM | bookmarks = Set.remove msgId accM.bookmarks }
                                    , accCmds
                                    )

                                Le.RerMessage.OutImportantAdd msgId ->
                                    ( { accM | importants = Set.insert msgId accM.importants }
                                    , accCmds
                                    )

                                Le.RerMessage.OutImportantRm msgId ->
                                    ( { accM | importants = Set.remove msgId accM.importants }
                                    , accCmds
                                    )

                                Le.RerMessage.OutDeleteMessage _ ->
                                    ( accM, accCmds )

                                Le.RerMessage.OutSelectFreqAndShowMap _ ->
                                    ( accM, accCmds )
                        )
                        ( m2, [] )
                        res.sigs

                ( m3, cmds3 ) =
                    mAndCmds

                cmds =
                    E.batch <| E.map RowsMsg res.cmds :: cmds3
            in
            ( m3
            , cmds
            )

        GotTags (Err e) ->
            Api.handleHttpError ToastMsg e model

        GotTags (Ok vs) ->
            ( { model | tags = vs }
            , E.none
            )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


body : Bool -> Shared.Model -> User -> Model -> List (Html Msg)
body dark shared user model =
    let
        navButtonsBlock =
            [ div [ class "d-flex justify-content-center align-items-center" ] <|
                button
                    [ type_ "button"
                    , class "btn btn-light me-2"
                    , onClick LoadEarlier
                    ]
                    [ i [ class "bi bi-chevron-left" ] [] ]
                    :: (case ( model.earliestMessage, model.latestMessage ) of
                            ( Just earliest, Just latest ) ->
                                case model.zone of
                                    Nothing ->
                                        []

                                    Just zone ->
                                        let
                                            fromto =
                                                Le.Time.renderDateTimeF1 zone earliest
                                                    ++ " - "
                                                    ++ Le.Time.renderDateTimeF2 zone latest
                                        in
                                        [ div
                                            [ class "d-inline-block me-2"
                                            , style "font-size" ".8rem"
                                            ]
                                            [ text fromto ]
                                        ]

                            _ ->
                                []
                       )
                    ++ [ button
                            [ type_ "button"
                            , class "btn btn-light me-2"
                            , onClick LoadMore
                            ]
                         <|
                            (case model.unreadCounters of
                                Nothing ->
                                    []

                                Just unreadCounters ->
                                    [ span [ class "badge rounded-pill text-bg-secondary" ]
                                        [ text <| String.fromInt unreadCounters.newerMsgCount ]
                                    , text " "
                                    ]
                            )
                                ++ [ i [ class "bi bi-chevron-right" ] [] ]
                       ]
                    ++ (if model.loadingInboxMessages then
                            [ div [ class "d-inline-block me-2 fade-in" ]
                                [ Le.Block.Spinner.loadingSpinner2Sm ]
                            ]

                        else
                            [ div
                                [ class "d-inline-block"
                                , style "width" "24px"
                                ]
                                []
                            ]
                       )
            ]
    in
    [ -- , Views.navBarRer dark mServerInfo "inbox" (SharedMsg Shared.NeedReload)
      Views.headerAndContent "вхідні" ToastMsg model.toasts <|
        div [ class "page-rer-importer" ] <|
            (div [ class "d-flex justify-content-between align-items-center mb-4" ] <|
                [ div [ class "flex-shrink-1" ]
                    [ button
                        [ type_ "button"
                        , class "btn btn-light me-2 text-nowrap"
                        , onClick ToggleFilter
                        , classList [ ( "active", model.showFilter ) ]
                        ]
                        [ span
                            [ class "text-muted"
                            ]
                            [ i
                                [ class "bi bi-funnel"
                                , style "vertical-align" "middle"
                                ]
                                []
                            , span
                                [ style "font-size" ".8rem"
                                ]
                                [ text " фільтр" ]
                            ]
                        ]
                    ]
                , div [ class "flex-shrink-1" ]
                    [ button
                        [ type_ "button"
                        , class "btn btn-light me-2 text-nowrap"
                        , onClick ToggleDateSelector
                        , classList [ ( "active", model.showDateSelector ) ]
                        ]
                        [ span
                            [ class "text-muted"
                            , style "font-size" ".8rem"
                            ]
                            [ text "перейти на дату/час" ]
                        ]
                    ]
                , div [ class "w-100" ] navButtonsBlock
                ]
            )
                :: (if model.showFilter then
                        let
                            filterBlock =
                                div
                                    [ class "fade-in mb-4"
                                    ]
                                <|
                                    [ div [ class "form-check d-block" ] <|
                                        [ input
                                            [ class "form-check-input me-1"
                                            , type_ "checkbox"
                                            , id "filter-only-show-unprocessed"
                                            , checked <| model.filterOnlyShowUnprocessed
                                            , onClick ToggleFilterOnlyShowUnprocessed
                                            ]
                                            []
                                        , label
                                            [ class "form-check-label"
                                            , for "filter-only-show-unprocessed"
                                            , style "user-select" "none"
                                            ]
                                            [ text "лише необроблені" ]
                                        ]
                                    , div []
                                        [ button
                                            [ type_ "button"
                                            , class "btn btn-primary mt-3"
                                            , onClick <| ApplyFilters
                                            ]
                                            [ text "застосувати" ]
                                        ]
                                    ]
                        in
                        [ filterBlock ]

                    else
                        []
                   )
                ++ (if model.showDateSelector then
                        let
                            dateSelectorBlock =
                                div
                                    [ class "fade-in mb-4 d-flex justify-content-start align-items-start"
                                    ]
                                <|
                                    [ div [] <|
                                        input
                                            [ type_ "datetime-local"
                                            , class "form-control"
                                            , style "max-width" "300px"
                                            , onInput <| SetGotoDate
                                            , value model.dateSelectedStr
                                            , isInvalidCls dateFieldErrId model.formErrors
                                            ]
                                            []
                                            :: fieldError dateFieldErrId model.formErrors
                                    , button
                                        [ type_ "button"
                                        , class "btn btn-primary ms-2"
                                        , classList [ ( "disabled", MaybeX.isNothing model.dateSelected ) ]
                                        , onClick GotoDate
                                        ]
                                        [ text "перейти" ]
                                    ]
                        in
                        [ dateSelectorBlock ]

                    else
                        []
                   )
                ++ (if List.length model.messages == 0 then
                        [ div
                            [ class "text-center"
                            , style "margin-top" "7rem"
                            , style "margin-bottom" "7rem"
                            ]
                            [ text "немає вхідних повідомлень. натисніть \"завантажити раніше\" для перегляду старших повідомлень" ]
                        ]

                    else
                        []
                   )
                ++ [ div [] <|
                        let
                            vps =
                                { profiles = model.profiles
                                , groupInfos = model.groupInfos
                                , zone = model.zone
                                , messages = model.messages
                                , tags = model.tags
                                , bookmarks = model.bookmarks
                                , importants = model.importants
                                , callsignsInfo = model.callsignsInfo
                                , messageComments = Dict.empty
                                , user = user
                                , users = Dict.empty
                                , serverInfo = shared.serverInfo
                                , networks = Dict.empty
                                , masterUnits = Dict.empty
                                , freqNetworkIds = Dict.empty
                                , currentRoute = Nothing
                                }

                            renderPs =
                                { hideCheckboxes = False
                                , hideIndividualSave = True
                                }
                        in
                        List.map (Html.map RowsMsg)
                            (List.map
                                (Le.RerMessage.renderRow vps
                                    renderPs
                                    model.rowsModel
                                    model.formErrors
                                )
                                (enumerate model.messages)
                            )
                   , div [ class "d-flex justify-content-center align-items-center" ] <|
                        button
                            [ type_ "button"
                            , class "btn btn-primary me-2 text-nowrap"
                            , onClick InboxSubmit
                            ]
                            [ if not model.inboxSubmitInProgress then
                                i [ class "bi bi-send-fill" ] []

                              else
                                Le.Block.Spinner.loadingSpinner2Sm
                            , text " обробити, завантажити наступні"
                            ]
                            :: navButtonsBlock
                   ]
    ]


view : Bool -> Shared.Model -> User -> Model -> View Msg
view dark shared user model =
    { title = "РЕР-імпортер"
    , body = body dark shared user model
    }
