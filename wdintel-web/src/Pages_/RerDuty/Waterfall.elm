module Pages_.RerDuty.Waterfall exposing
    ( DigestLoadingTimestamp
    , LoadingEarlierStatus
    , LoadingStrategy
    , MessageTabPs
    , Model
    , Msg(..)
    , init
    , messageTab
    , subscriptions
    , update
    , waterfallDivId
    )

import Api
import Bindings as B
import Browser.Dom exposing (Element)
import Config
import Core.Callsign
import Core.Types exposing (..)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Dict.Extra as DE
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Keyed
import Html.Styled as Styled
import Http
import Json.Decode as Decode
import List.Extra as ListX
import Maybe
import Maybe.Extra as MaybeX
import PagePorts.WaterfallPorts as Ports
import Pages_.RerAnalysis.Query as Query
import Pages_.RerDuty.Waterfall.Filters as Filters exposing (Filter, FilterMsg(..))
import Pages_.RerDuty.Waterfall.Message
import Pages_.RerDuty.Waterfall.Messages as Messages
import Pages_.RerDuty.Waterfall.Types exposing (..)
import Pages_.RerDuty.Waterfall.Utils as WUtils
import Process
import Select
import Set exposing (Set)
import Shared
import Shared.Components.Badges exposing (badgeNotSelectedHtml, badgeSelectedCloseCounter, badgeSelectedHtml)
import Shared.Components.RerMessage exposing (model0)
import Shared.Components.Spinner
import Shared.Components.Toast
import Shared.Components.Toggle as Toggle
import Shared.Components.Tooltip as Tooltip
import Shared.Model exposing (isDarkMode)
import String
import Task
import Time exposing (Posix)
import TimeZone
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select as LeSelect
import Utils.Time
import Utils.Utils exposing (andThen, def, emptyToNothing, findK, getLabelOrDefault, jumpToBottom, renderZoneError)


type Msg
    = NoOp
      -- TIME
    | TickTimeTick Posix
    | TickTimeSlept
    | InitGotTime Posix
    | GotTime Posix
    | InboxLoopSleptBeforeLoadNewer
      -- API CALLS
    | GotSignals (Result ApiError B.ListSignalsRsp)
    | GotLatestFrequencies (Result ApiError (List String))
    | GotCallsignsInfo (Result ApiError (List B.CallsignInfoRes))
    | GotNetworksInfo (Result ApiError (List B.Network))
    | GotGroupKeys (Result ApiError (List String))
    | GotTags (Result ApiError (List ( Int, B.Tag )))
    | InitGotLatestSenders (Result ApiError B.SignalProfilesRsp)
    | GotProfileInfos (Result ApiError B.SignalProfilesRsp)
    | GotGroupInfos (Result ApiError B.SignalGroupsRsp)
    | ReloadLatestFrequencies
      -- FILTERS
    | FiltersMsg FilterMsg
      -- CLIPBOARD
    | CopyToClipboard Pages_.RerDuty.Waterfall.Message.ClipboardObject Int
    | RemoveClipboardCopied
      -- VIEWPORT
    | GotWaterfallDiv (Result Browser.Dom.Error Element)
    | GotWaterfallContainerDiv (Result Browser.Dom.Error Element)
    | GetVisibleMsgIdsRes { waterfallId : String, msgIds : List Int, firstVisibleHeight : Float }
      -- LOADING MESSAGES
    | InboxLoopLoadNewer
    | GotInitialInbox Bool (Result ApiError B.InboxMessagesRsp)
    | GotInboxEarlier (Result ApiError B.InboxMessagesRsp)
    | InboxLoopGotMessages Bool (Result ApiError B.InboxMessagesRsp)
    | LoadInitialStatsNow Posix
    | GotInboxMessagesDigest (Result ApiError B.InboxMessagesDigestRsp)
      -- SCROLL
    | Scroll
    | ScrollEnd
    | ScrollThrottleMsg Debounce.Msg
    | ScrollToLatestElement
    | GotEarlierMessageDiv (Result Browser.Dom.Error Element)
    | CloseWaterfall
    | ScrollIntoMessageDone
      -- MESSAGE
    | MessageMsg Int B.InboxMessage Pages_.RerDuty.Waterfall.Message.InternalMsg
    | BookmarkChanged Int
    | ImportantChanged Int
    | BookmarkAddDone Int (Result ApiError ())
    | BookmarkRemoveDone Int (Result ApiError ())
    | ImportantAddDone Int (Result ApiError ())
    | ImportantRemoveDone Int (Result ApiError ())
    | DeleteMessage Int
    | DeleteMessageConfirm
    | DeleteMessageCancel
    | DeleteMessageDone Int (Result ApiError ())
    | GotPosts (Result ApiError B.PostStatsRsp)


type Direction
    = Up
    | Down


type ScrollingToBottom
    = InProgress
    | Done


type LoadingStrategy
    = AutoScrollToLatest ScrollingToBottom
    | ManualScroll Direction
    | InitialLoad


type DigestLoadingTimestamp
    = SinceTime Posix
    | NotDefinedYet


type LoadingEarlierStatus
    = NotLoading
    | Loading
    | ScrollingIntoMessage


type alias Model =
    { id : String
    , height : Int
    , lastScroll : Maybe Posix
    , lastBottomCheck : Maybe Posix
    , scrollThrottle : Debounce ()
    , scrollDebounce : Debounce ()
    , scrollManual : Debounce ()
    , time : Maybe Posix
    , initTime : Maybe Posix
    , dtFromPosix : Maybe Posix
    , groupsSelected : List String
    , sendersSelect : LeSelect.SelectType String
    , sendersDeniedSelect : LeSelect.SelectType String
    , freqsSelect : LeSelect.SelectType String
    , freqsDeniedSelect : LeSelect.SelectType String
    , postsSelect : LeSelect.SelectType String
    , postsDeniedSelect : LeSelect.SelectType String
    , filterSelect :
        { state : Select.State
        , items : List (Select.MenuItem Int)
        , selected : Maybe Int
        }
    , adjacentFreqsRangeSelect :
        { state : Select.State
        , items : List (Select.MenuItem Float)
        , selected : Float
        }
    , sendersSelectedNames : List String
    , sendersDeniedNames : List String
    , freqs : List String
    , posts : List String
    , profiles : Dict String (Maybe B.SignalProfileEntry)
    , groupInfos : Dict String B.SignalGroupEntry
    , networksExtra : Dict Int B.Network
    , groups : List String
    , messages : Messages.Messages
    , loadingEarlier : LoadingEarlierStatus
    , loadingInboxMessages : Bool
    , clipboardCopied : Maybe ( Int, Pages_.RerDuty.Waterfall.Message.ClipboardObject )
    , isMsgVisible : List Int
    , unreadIds : List Int
    , unfoldSettings : Bool
    , highlightSignalsEnabled : Bool
    , onlyMyUnitTagsEnabled : Bool
    , datasources : List ( Int, B.Datasource )
    , tags : List ( Int, B.Tag )
    , edited : Dict Int Shared.Components.RerMessage.Edited
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , savedFilters : List ( Int, B.SavedFilterDuty )
    , saveFilterInp : String
    , deleteFilterConfirmationId : Maybe Int
    , signals : List B.Signal
    , noEarlierMessagesLeft : Bool
    , lastViewedMessageId : LastViewedMessageId
    , loadingStrategy : LoadingStrategy
    , containerY : Float

    --
    , notLoadedYetMessagesCounter : Int
    , digestLoadingTimestamp : DigestLoadingTimestamp
    , firstNewMessageTimestamp : Maybe Int
    , notRenderedMessagesYet : List ( Int, B.InboxMessage )
    , unreadMessagesLeft : Bool
    , deleteMessageConfirmationId : Maybe Int
    , filterSelectedAdjacentFreqs : List String
    , filterDeniedAdjacentFreqs : List String
    , loadingInboxDigest : Bool
    }


init :
    String
    -> Maybe B.RerDutyQueryStateWf
    -> ( Model, Effect Msg )
init id_ ms =
    ( { id = id_
      , height = 200
      , lastScroll = Nothing
      , lastBottomCheck = Nothing
      , scrollThrottle = Debounce.init
      , scrollDebounce = Debounce.init
      , scrollManual = Debounce.init
      , time = Nothing
      , initTime = Nothing
      , dtFromPosix = Nothing
      , loadingInboxMessages = True
      , highlightSignalsEnabled = False
      , onlyMyUnitTagsEnabled = False
      , groupsSelected = ms |> andThen .groupsSelected |> def []
      , sendersSelect =
            { state = Select.initState (Select.selectIdentifier "selectSenders")
            , items = []
            , selected = ms |> andThen .sendersSelected |> def []
            }
      , freqsSelect =
            { state = Select.initState (Select.selectIdentifier "selectFreqs")
            , selected = ms |> andThen .freqsSelected |> def []
            , items = []
            }
      , freqsDeniedSelect =
            { state = Select.initState (Select.selectIdentifier "denyFreqs")
            , selected = ms |> andThen .freqsDenied |> def []
            , items = []
            }
      , postsSelect =
            { state = Select.initState (Select.selectIdentifier "selectPosts")
            , selected = ms |> andThen .postsSelected |> def []
            , items = []
            }
      , postsDeniedSelect =
            { state = Select.initState (Select.selectIdentifier "denyPosts")
            , selected = ms |> andThen .postsDenied |> def []
            , items = []
            }
      , sendersDeniedSelect =
            { state = Select.initState (Select.selectIdentifier "denySenders")
            , items = []
            , selected = ms |> andThen .deniedSenders |> def []
            }
      , filterSelect =
            { state = Select.initState (Select.selectIdentifier "selectFilter")
            , items = []
            , selected = Nothing
            }
      , adjacentFreqsRangeSelect =
            { state = Select.initState (Select.selectIdentifier "selectAdjacentFreqsRange")
            , items = Config.adjacentFreqsRangeOptions |> List.map (\x -> Select.basicMenuItem { item = x, label = String.fromFloat (x * 1000) ++ " кГц" })
            , selected = 0
            }
      , sendersSelectedNames = []
      , sendersDeniedNames = []
      , freqs = []
      , posts = []
      , profiles = Dict.empty
      , groupInfos = Dict.empty
      , networksExtra = Dict.empty
      , groups = []
      , messages = Messages.fromList []
      , loadingEarlier = NotLoading
      , clipboardCopied = Nothing
      , isMsgVisible = []
      , unreadIds = []
      , unfoldSettings = False
      , datasources = []
      , tags = []
      , edited = Dict.empty
      , callsignsInfo = Dict.empty
      , savedFilters = []
      , saveFilterInp = ""
      , deleteFilterConfirmationId = Nothing
      , signals = []
      , noEarlierMessagesLeft = False
      , lastViewedMessageId =
            case ms of
                Just state ->
                    case state.lastViewedMessageId of
                        Just lastViewedId_ ->
                            LastViewedId lastViewedId_

                        Nothing ->
                            NotSet

                Nothing ->
                    NotSet
      , loadingStrategy = InitialLoad
      , containerY = 0
      , notLoadedYetMessagesCounter = 0
      , digestLoadingTimestamp = NotDefinedYet
      , firstNewMessageTimestamp = Nothing
      , notRenderedMessagesYet = []
      , unreadMessagesLeft = True
      , deleteMessageConfirmationId = Nothing
      , filterSelectedAdjacentFreqs = []
      , filterDeniedAdjacentFreqs = []
      , loadingInboxDigest = False
      }
    , E.batch
        [ initCmd id_
        , initCmdOnce
        ]
    )


{-| a message that's N items from top, if you scroll to it we'll load earlier messages from server
-}
earlyMessageCount =
    10



{- how often do we try to load new messages -}


loadingNewMessagesInterval =
    1000


initCmd : String -> Effect Msg
initCmd id_ =
    E.batch
        [ E.getElementById (waterfallDivId id_) GotWaterfallDiv
        , E.getCurrentTime InitGotTime
        , E.sendCmd <| Api.sigint_latest_frequencies GotLatestFrequencies
        ]


initCmdOnce : Effect Msg
initCmdOnce =
    E.batch
        [ E.sendCmd <| Task.perform (\_ -> InboxLoopSleptBeforeLoadNewer) (Process.sleep loadingNewMessagesInterval)
        , E.sendCmd <| Api.rer_analysis_latest_senders InitGotLatestSenders
        , E.getCurrentTime TickTimeTick
        , E.getCurrentTime GotTime
        , E.getTags GotTags
        , E.sendCmd <| Api.waterfall_saved_filters_list (FiltersMsg << SavedFiltersGot)
        , E.sendCmd <|
            Api.sigint_list_signals GotSignals
                { sortBy = []
                , filterText = Nothing
                , filterMeaning = Nothing
                , filterUnit = Nothing
                }
        ]


subscriptions : Model -> Sub Msg
subscriptions _ =
    Ports.waterfall_getVisibleMsgIdsRes GetVisibleMsgIdsRes


scrollThrottleConfig : Debounce.Config Msg
scrollThrottleConfig =
    { strategy = Debounce.soon 100
    , transform = ScrollThrottleMsg
    }


getBasicInboxParams : Model -> B.InboxMessagesReq
getBasicInboxParams model =
    { sinceIdNoninclusive = Nothing
    , beforeIdNoninclusive = Nothing
    , sinceDateInclusiveMs = Nothing
    , tillDateInclusiveMs = Nothing
    , onlyShowUnprocessed = Nothing
    , checkedOnly = Just False
    , selectedGroups = emptyToNothing model.groupsSelected
    , selectedSenders = emptyToNothing model.sendersSelect.selected
    , deniedSenders = emptyToNothing model.sendersDeniedSelect.selected
    , selectedFreqs = emptyToNothing (model.freqsSelect.selected ++ model.filterSelectedAdjacentFreqs)
    , deniedFreqs = emptyToNothing (model.freqsDeniedSelect.selected ++ model.filterDeniedAdjacentFreqs)
    , selectedPosts = emptyToNothing model.postsSelect.selected
    , deniedPosts = emptyToNothing model.postsDeniedSelect.selected
    , selectedAors = Nothing
    , selectedCallsigns = Nothing
    , selectedUnits = Nothing
    , selectedLocations = Nothing
    , includePelengLocations = Nothing
    , selectedTags = Nothing
    , nolimit = Nothing
    , orWithExtendedForm = Nothing
    , loadLatest = Nothing
    , returnDuplicates = Just True
    , orBookmarked = Nothing
    , orImportant = Nothing
    , orWithCoords = Nothing
    , newestFirst = Nothing
    , search = Nothing
    , highlightCallsigns = Just True
    , highlightSignals = Just model.highlightSignalsEnabled
    , highlightKeywords = Just True
    , highlightSearchres = Just True
    , highlightPoints = Just True
    , metadataCc = Nothing
    , metadataSender = Nothing
    , metadataReceiver = Nothing
    , metadataHash = Nothing
    , onlyWithMetadata = Nothing
    , withoutMetadata = Nothing
    , sortBy = Just B.ImsTimestamp
    , reportTagsOnlyThisUnit = Nothing
    , ignoreImportedCoords = Just True
    , calculateFreqPelengsSummary = Nothing
    , skipGroupStats = Just True
    , filterTagsOption = Nothing
    , pageId = Just "rer-duty"
    , unitsExactMatchOnly = Nothing
    , selectedNetworks = Nothing
    , withoutNetwork = Nothing
    , withoutModelTags = Nothing
    }


getInboxParamsForMessages : Model -> B.InboxMessagesReq
getInboxParamsForMessages model =
    let
        params =
            getBasicInboxParams model
    in
    { params | sortBy = Just B.ImsTimestamp }


setBeforeIdNoninclusive : Maybe Int -> B.InboxMessagesReq -> B.InboxMessagesReq
setBeforeIdNoninclusive v params =
    { params | beforeIdNoninclusive = v }


setSinceIdNoninclusive : Maybe Int -> B.InboxMessagesReq -> B.InboxMessagesReq
setSinceIdNoninclusive v params =
    { params | sinceIdNoninclusive = v }


setSinceDateInclusiveMs : Maybe Int -> B.InboxMessagesReq -> B.InboxMessagesReq
setSinceDateInclusiveMs v params =
    { params | sinceDateInclusiveMs = v }


setLoadLatest : Maybe Bool -> B.InboxMessagesReq -> B.InboxMessagesReq
setLoadLatest v params =
    { params | loadLatest = v }


setNolimit : Maybe Bool -> B.InboxMessagesReq -> B.InboxMessagesReq
setNolimit v params =
    { params | nolimit = v }


loadInitialStats : Model -> Bool -> ( Model, Effect Msg )
loadInitialStats model reload =
    case ( model.dtFromPosix, model.loadingStrategy ) of
        ( Just _, InitialLoad ) ->
            ( { model
                | loadingInboxMessages = True
                , noEarlierMessagesLeft = False
              }
            , E.getInboxMessages Nothing
                (GotInitialInbox False)
                (getInboxParamsForMessages model
                    |> setLoadLatest (Just True)
                    |> setBeforeIdNoninclusive (WUtils.lastViewedIdToMaybe model.lastViewedMessageId)
                )
            )

        ( Just _, _ ) ->
            if reload then
                ( { model
                    | loadingInboxMessages = True
                    , noEarlierMessagesLeft = False
                    , loadingInboxDigest = False
                  }
                , E.batch
                    [ E.getInboxMessages Nothing (GotInitialInbox True) (getInboxParamsForMessages model |> setLoadLatest (Just True))
                    , E.sendCmd <| Task.perform (\_ -> InboxLoopSleptBeforeLoadNewer) (Process.sleep loadingNewMessagesInterval)
                    , E.sendCmd <| Http.cancel <| loadEarlierTracker model.id
                    , E.sendCmd <| Http.cancel <| loadNewerTracker model.id
                    , E.sendCmd <| Http.cancel <| loadDigestTracker model.id
                    ]
                )

            else
                ( { model
                    | loadingInboxMessages = True
                    , noEarlierMessagesLeft = False
                  }
                , E.getInboxMessages Nothing (GotInitialInbox False) (getInboxParamsForMessages model |> setLoadLatest (Just True))
                )

        _ ->
            ( model, E.none )


appendUnreadIds : List ( Int, B.InboxMessage ) -> Model -> Model
appendUnreadIds messages model =
    let
        unreadIds =
            case model.loadingStrategy of
                AutoScrollToLatest _ ->
                    model.unreadIds

                _ ->
                    model.unreadIds ++ List.map Tuple.first messages
    in
    { model
        | unreadIds = unreadIds
        , notLoadedYetMessagesCounter = Basics.max (model.notLoadedYetMessagesCounter - List.length messages) 0
    }


loadNewGroups : List ( Int, B.InboxMessage ) -> { a | groupInfos : Dict String B.SignalGroupEntry } -> Effect Msg
loadNewGroups messages model =
    let
        newGroupsIds =
            Shared.Components.RerMessage.compNewGroups messages model.groupInfos
    in
    if List.length newGroupsIds > 0 then
        E.sendCmd <|
            Api.rer_importer_signal_group_info_batch
                GotGroupInfos
                { groups = newGroupsIds |> List.map (\id -> { masterKey = id })
                , skipGroupStats = Just True
                }

    else
        E.none


loadNewProfiles : List ( Int, B.InboxMessage ) -> { a | profiles : Dict String (Maybe B.SignalProfileEntry) } -> Effect Msg
loadNewProfiles messages model =
    let
        newProfilesIds =
            Shared.Components.RerMessage.compNewProfiles messages model.profiles
    in
    if List.length newProfilesIds > 0 then
        E.sendCmd <|
            Api.rer_importer_signal_profile_info_batch
                GotProfileInfos
                { profiles = newProfilesIds |> List.map (\id -> { uuid = id }) }

    else
        E.none


loadInboxDigest : Model -> DigestLoadingTimestamp -> Cmd Msg
loadInboxDigest model strategy =
    case strategy of
        SinceTime time ->
            Api.inbox_messages_digest (Just (loadDigestTracker model.id))
                GotInboxMessagesDigest
                (getInboxParamsForMessages model
                    |> setSinceDateInclusiveMs (Just (Time.posixToMillis time))
                    |> setNolimit (Just True)
                )

        _ ->
            Cmd.none


findNewFreqs : List ( Int, B.InboxMessage ) -> List String -> List String
findNewFreqs messages freqs =
    messages
        |> List.map Tuple.second
        |> List.filterMap .freq
        |> Set.fromList
        |> Set.toList
        |> List.filter (\x -> not (List.member x freqs))


hasLoadingTrasholdPassed : { a | messages : Messages.Messages, isMsgVisible : List Int } -> Bool
hasLoadingTrasholdPassed model =
    -- potential bug here, we also have not rendered messages until VisibleMsgRes has arrived
    let
        loadNewerTrasholdMessage =
            findEarlyMessage (model.messages |> Messages.toMessageList |> List.reverse)

        --TODO: do not calculate it each time, optimize somehow
        maxVisibleMessage =
            model.isMsgVisible
                |> List.reverse
                |> List.head
                |> Maybe.andThen (\id_ -> ListX.find (\( id, _ ) -> id == id_) (Messages.toMessageList model.messages))
    in
    case Maybe.map2 WUtils.compareTwoMessages maxVisibleMessage loadNewerTrasholdMessage of
        Just True ->
            True

        _ ->
            False



--TODO: change name


updateFreqsAndCallsigns :
    List ( Int, B.InboxMessage )
    ->
        { a
            | freqs : List String
            , freqsSelect : LeSelect.SelectType String
            , freqsDeniedSelect : LeSelect.SelectType String
            , callsignsInfo : Dict String (List B.CallsignInfo)
        }
    ->
        ( { a
            | freqs : List String
            , freqsSelect : LeSelect.SelectType String
            , freqsDeniedSelect : LeSelect.SelectType String
            , callsignsInfo : Dict String (List B.CallsignInfo)
          }
        , Effect Msg
        )
updateFreqsAndCallsigns messages model =
    let
        newFreqs =
            findNewFreqs messages model.freqs

        ( freqs, freqMenu ) =
            case newFreqs of
                [] ->
                    ( model.freqs, model.freqsSelect.items )

                _ ->
                    ( model.freqs ++ newFreqs, Filters.createMenu (model.freqs ++ newFreqs) )

        fs =
            LeSelect.updateSelectItems (\_ -> freqMenu) model.freqsSelect

        fd =
            LeSelect.updateSelectItems (\_ -> freqMenu) model.freqsDeniedSelect

        newCallsigns =
            Core.Callsign.extractCallsignsInfo messages model.callsignsInfo
    in
    ( { model
        | freqs = freqs
        , freqsSelect = fs
        , freqsDeniedSelect = fd
      }
    , E.batch
        [ if List.length newCallsigns > 0 then
            E.getCallsignsInfo GotCallsignsInfo { callsigns = newCallsigns }

          else
            E.none
        ]
    )


mergeCallsignsInfo :
    List B.CallsignInfoRes
    ->
        { a
            | callsignsInfo : Dict String (List B.CallsignInfo)
        }
    ->
        { a
            | callsignsInfo : Dict String (List B.CallsignInfo)
        }
mergeCallsignsInfo callsigns model =
    List.foldl
        (\callsign m ->
            { m
                | callsignsInfo =
                    Dict.insert (String.toLower callsign.callsign)
                        callsign.res
                        m.callsignsInfo
            }
        )
        model
        callsigns


networksForView : Shared.Model -> Model -> Dict Int B.Network
networksForView shared model =
    Dict.union model.networksExtra (RD.withDefault Dict.empty shared.networks)


missingNetworkIdsForMessages : Shared.Model -> Model -> List ( Int, B.InboxMessage ) -> List Int
missingNetworkIdsForMessages shared model messages =
    let
        knownNetworks =
            networksForView shared model
    in
    messages
        |> List.concatMap (\( _, msg ) -> msg.networkIds |> Maybe.withDefault [])
        |> List.filter (\networkId -> not (Dict.member networkId knownNetworks))
        |> ListX.unique


loadNetworksForMessages : Shared.Model -> Model -> List ( Int, B.InboxMessage ) -> Effect Msg
loadNetworksForMessages shared model messages =
    let
        missingIds =
            missingNetworkIdsForMessages shared model messages
    in
    if List.isEmpty missingIds then
        E.none

    else
        E.getNetworksInfoByIds GotNetworksInfo missingIds


commonGotVisibleMsgFunc : List Int -> { a | unreadIds : List Int, lastViewedMessageId : LastViewedMessageId, isMsgVisible : List Int } -> { a | unreadIds : List Int, lastViewedMessageId : LastViewedMessageId, isMsgVisible : List Int }
commonGotVisibleMsgFunc msgIds model =
    let
        unreadIds2 =
            List.map (\x -> ListX.elemIndex x model.unreadIds) msgIds
                |> MaybeX.values
                |> List.maximum
                |> Maybe.map (\i -> List.drop (i + 1) model.unreadIds)
                |> Maybe.withDefault model.unreadIds
    in
    { model
        | unreadIds = unreadIds2
        , isMsgVisible = msgIds
        , lastViewedMessageId =
            if List.length msgIds /= 0 then
                case msgIds |> List.reverse |> List.head of
                    Just lastViewedId_ ->
                        LastViewedId lastViewedId_

                    Nothing ->
                        model.lastViewedMessageId

            else
                model.lastViewedMessageId
    }


commonGotInboxLoopFunc :
    List ( Int, B.InboxMessage )
    -> { a | unreadMessagesLeft : Bool, groupInfos : Dict String B.SignalGroupEntry, profiles : Dict String (Maybe B.SignalProfileEntry) }
    -> ( { a | unreadMessagesLeft : Bool, groupInfos : Dict String B.SignalGroupEntry, profiles : Dict String (Maybe B.SignalProfileEntry) }, Effect Msg )
commonGotInboxLoopFunc messages model =
    ( { model
        | unreadMessagesLeft =
            List.length messages /= 0
      }
    , E.batch
        [ E.sendCmd <| Task.perform (\_ -> InboxLoopSleptBeforeLoadNewer) (Process.sleep loadingNewMessagesInterval)
        , loadNewGroups messages model
        , loadNewProfiles messages model
        ]
    )


loadNewerTracker id =
    waterfallDivId id ++ " load-newer-messages"


loadEarlierTracker id =
    waterfallDivId id ++ "load-earlier-messages"


loadDigestTracker id =
    waterfallDivId id ++ "load-messages-digest"


updateFilters : FilterMsg -> Filter a -> ( Filter a, Effect Msg )
updateFilters msg model =
    case msg of
        SelectGroup groupLbl ->
            let
                ids =
                    Filters.groupNameToIds groupLbl model.groupInfos

                groupsSelected =
                    if List.any (\x -> List.member x ids) model.groupsSelected then
                        model.groupsSelected

                    else
                        model.groupsSelected ++ ids

                m2 =
                    { model | groupsSelected = groupsSelected }

                m3 =
                    Filters.updateSelectItems m2
            in
            ( m3, E.getCurrentTime LoadInitialStatsNow )

        UnselectGroup groupLbl ->
            let
                m2 =
                    { model
                        | groupsSelected = List.filter (\x -> not (List.member x (Filters.groupNameToIds groupLbl model.groupInfos))) model.groupsSelected
                    }

                m3 =
                    Filters.updateSelectItems m2
            in
            ( m3, E.getCurrentTime LoadInitialStatsNow )

        SavedFiltersGot (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження збережених фільтрів" e )

        SavedFiltersGot (Ok filters) ->
            let
                selectFilterMenu =
                    filters
                        |> List.map
                            (\filter ->
                                Select.basicMenuItem
                                    { item = filter.id
                                    , label = filter.name
                                    }
                            )

                fs =
                    model.filterSelect

                fs2 =
                    { fs | items = selectFilterMenu }
            in
            ( { model | savedFilters = List.map (\x -> ( x.id, x )) filters, filterSelect = fs2 }
            , E.none
            )

        SaveFilterDo ->
            let
                reqParams : Filter a -> B.RerDutyQueryStateWf
                reqParams m =
                    { groupsSelected = Just m.groupsSelected
                    , sendersSelected = Just m.sendersSelect.selected
                    , deniedSenders = Just m.sendersDeniedSelect.selected
                    , freqsSelected = Just m.freqsSelect.selected
                    , freqsDenied = Just m.freqsDeniedSelect.selected
                    , postsSelected = Just m.postsSelect.selected
                    , postsDenied = Just m.postsDeniedSelect.selected
                    , lastViewedMessageId = WUtils.lastViewedIdToMaybe m.lastViewedMessageId
                    }

                req : B.SavedFilterDutyUpsertReq
                req =
                    { name = model.saveFilterInp, req = reqParams model }
            in
            ( model
            , E.sendCmd <| Api.waterfall_saved_filter_upsert (FiltersMsg << SaveFilterDone) req
            )

        SaveFilterDone (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження фільтру" e )

        SaveFilterDone (Ok filters) ->
            let
                selectFilterMenu =
                    filters
                        |> List.map
                            (\filter ->
                                Select.basicMenuItem
                                    { item = filter.id
                                    , label = filter.name
                                    }
                            )

                fs =
                    model.filterSelect

                fs2 =
                    { fs | items = selectFilterMenu }
            in
            ( { model
                | savedFilters = List.map (\x -> ( x.id, x )) filters
                , saveFilterInp = ""
                , filterSelect = fs2
              }
            , E.none
            )

        SaveFilterInp val ->
            ( { model | saveFilterInp = val }
            , E.none
            )

        SelectFilterMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.filterSelect.state

                f =
                    model.filterSelect

                f2 =
                    { f
                        | state = imodel2
                        , selected =
                            case mAction of
                                Just (Select.Select x) ->
                                    Just x

                                Just Select.Clear ->
                                    Nothing

                                _ ->
                                    model.filterSelect.selected
                    }

                m2 =
                    { model | filterSelect = f2 }

                updateFields : Maybe.Maybe (Select.Action Int) -> Filter a -> Filter a
                updateFields mSelectAction m =
                    case mSelectAction of
                        Just (Select.Select x) ->
                            m.savedFilters
                                |> List.map Tuple.second
                                |> List.filter (\y -> y.id == x)
                                |> List.head
                                |> Maybe.map
                                    (\filter ->
                                        { m
                                            | groupsSelected = Maybe.withDefault [] filter.req.groupsSelected
                                            , sendersSelect = LeSelect.updateSelectSelected (\_ -> Maybe.withDefault [] filter.req.sendersSelected) m.sendersSelect
                                            , sendersDeniedSelect = LeSelect.updateSelectSelected (\_ -> Maybe.withDefault [] filter.req.deniedSenders) m.sendersDeniedSelect
                                            , freqsSelect = LeSelect.updateSelectSelected (\_ -> Maybe.withDefault [] filter.req.freqsSelected) m.freqsSelect
                                            , freqsDeniedSelect = LeSelect.updateSelectSelected (\_ -> Maybe.withDefault [] filter.req.freqsDenied) m.freqsDeniedSelect
                                            , postsSelect = LeSelect.updateSelectSelected (\_ -> Maybe.withDefault [] filter.req.postsSelected) m.postsSelect
                                            , postsDeniedSelect = LeSelect.updateSelectSelected (\_ -> Maybe.withDefault [] filter.req.postsDenied) m.postsDeniedSelect
                                        }
                                    )
                                |> Maybe.withDefault m

                        Just Select.Clear ->
                            { m
                                | groupsSelected = []
                                , sendersSelect = LeSelect.updateSelectSelected (\_ -> []) m.sendersSelect
                                , sendersDeniedSelect = LeSelect.updateSelectSelected (\_ -> []) m.sendersDeniedSelect
                                , freqsSelect = LeSelect.updateSelectSelected (\_ -> []) m.freqsSelect
                                , freqsDeniedSelect = LeSelect.updateSelectSelected (\_ -> []) m.freqsDeniedSelect
                                , postsSelect = LeSelect.updateSelectSelected (\_ -> []) m.postsSelect
                                , postsDeniedSelect = LeSelect.updateSelectSelected (\_ -> []) m.postsDeniedSelect
                            }

                        _ ->
                            m

                m3 =
                    updateFields mAction m2

                sendersSelectedNames =
                    Filters.ensureAllSendersNamed m3.profiles m3.sendersSelect.selected m3.sendersSelectedNames

                sendersDeniedNames =
                    Filters.ensureAllSendersNamed m3.profiles m3.sendersDeniedSelect.selected m3.sendersDeniedNames
            in
            ( { m3 | sendersSelectedNames = sendersSelectedNames, sendersDeniedNames = sendersDeniedNames }
            , E.sendCmd <|
                Cmd.batch
                    [ case mAction of
                        Just (Select.Select _) ->
                            Task.perform LoadInitialStatsNow Time.now

                        Just Select.Clear ->
                            Task.perform LoadInitialStatsNow Time.now

                        _ ->
                            Cmd.none
                    , Cmd.map (FiltersMsg << SelectFilterMsg) icmd
                    ]
            )

        DeleteFilter id ->
            ( { model | deleteFilterConfirmationId = Just id }, E.none )

        DeleteFilterConfirm ->
            case model.deleteFilterConfirmationId of
                Nothing ->
                    ( { model
                        | deleteFilterConfirmationId = Nothing
                      }
                    , E.none
                    )

                Just id ->
                    let
                        f =
                            model.filterSelect

                        f2 =
                            { f | selected = Nothing }
                    in
                    ( { model
                        | deleteFilterConfirmationId = Nothing
                        , savedFilters = List.filter (\( k, _ ) -> k /= id) model.savedFilters
                        , filterSelect = f2
                      }
                    , E.sendCmd <| Api.waterfall_saved_filter_delete (FiltersMsg << DeleteFilterDone) id
                    )

        DeleteFilterCancel ->
            ( { model | deleteFilterConfirmationId = Nothing }, E.none )

        DeleteFilterDone (Err err) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення фільтру" err )

        DeleteFilterDone (Ok _) ->
            let
                selectFilterMenu =
                    model.savedFilters
                        |> List.map Tuple.second
                        |> List.map
                            (\filter ->
                                Select.basicMenuItem
                                    { item = filter.id
                                    , label = filter.name
                                    }
                            )

                f =
                    model.filterSelect

                f2 =
                    { f | items = selectFilterMenu }
            in
            ( { model
                | filterSelect = f2
                , sendersSelect = LeSelect.updateSelectSelected (\_ -> []) model.sendersSelect
                , sendersDeniedSelect = LeSelect.updateSelectSelected (\_ -> []) model.sendersDeniedSelect
                , freqsSelect = LeSelect.updateSelectSelected (\_ -> []) model.freqsSelect
                , freqsDeniedSelect = LeSelect.updateSelectSelected (\_ -> []) model.freqsDeniedSelect
              }
            , E.getCurrentTime LoadInitialStatsNow
            )

        ToggleUnfoldSettings ->
            ( { model | unfoldSettings = not model.unfoldSettings }
            , E.none
            )

        ToggleHighlightSignals ->
            ( { model | highlightSignalsEnabled = not model.highlightSignalsEnabled }
            , E.getCurrentTime LoadInitialStatsNow
            )

        ToggleOnlyMyUnitTags ->
            ( { model | onlyMyUnitTagsEnabled = not model.onlyMyUnitTagsEnabled }
            , E.none
            )

        SelectSendersMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.sendersSelect.state

                m2 =
                    { model
                        | sendersSelect = LeSelect.updateSelectState (\_ -> imodel2) model.sendersSelect
                        , sendersSelectedNames = LeSelect.multiUpdS mAction model.sendersSelectedNames
                    }

                m3 =
                    { m2
                        | sendersSelect = LeSelect.updateSelectSelected (\sel -> Filters.extractSendersIds model.sendersSelectedNames m2.sendersSelectedNames m2.profiles sel) m2.sendersSelect
                    }
            in
            ( m3
            , E.sendCmd <|
                Cmd.batch
                    [ LeSelect.multiUpdIfModified mAction <|
                        Task.perform LoadInitialStatsNow Time.now
                    , Cmd.map (FiltersMsg << SelectSendersMsg) icmd
                    ]
            )

        SelectFreqsMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.freqsSelect.state

                freqsSelect =
                    LeSelect.updateSelectState (\_ -> imodel2) model.freqsSelect
                        |> LeSelect.updateSelectSelected (\s -> LeSelect.multiUpdS mAction s)

                filterSelectedAdjacentFreqs =
                    Utils.Utils.findAllAdjacentFreqs model.freqs freqsSelect.selected model.adjacentFreqsRangeSelect.selected
            in
            ( { model | freqsSelect = freqsSelect, filterSelectedAdjacentFreqs = filterSelectedAdjacentFreqs }
            , E.sendCmd <|
                Cmd.batch
                    [ LeSelect.multiUpdIfModified mAction <|
                        Task.perform LoadInitialStatsNow Time.now
                    , Cmd.map (FiltersMsg << SelectFreqsMsg) icmd
                    ]
            )

        SelectPostsMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.postsSelect.state

                m2 =
                    { model
                        | postsSelect =
                            LeSelect.updateSelectState (\_ -> imodel2) model.postsSelect
                                |> LeSelect.updateSelectSelected (\s -> LeSelect.multiUpdS mAction s)
                    }
            in
            ( m2
            , E.sendCmd <|
                Cmd.batch
                    [ LeSelect.multiUpdIfModified mAction <|
                        Task.perform LoadInitialStatsNow Time.now
                    , Cmd.map (FiltersMsg << SelectPostsMsg) icmd
                    ]
            )

        DenyPostsMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.postsDeniedSelect.state

                m2 =
                    { model
                        | postsDeniedSelect =
                            LeSelect.updateSelectState (\_ -> imodel2) model.postsDeniedSelect
                                |> LeSelect.updateSelectSelected (\s -> LeSelect.multiUpdS mAction s)
                    }
            in
            ( m2
            , E.sendCmd <|
                Cmd.batch
                    [ LeSelect.multiUpdIfModified mAction <|
                        Task.perform LoadInitialStatsNow Time.now
                    , Cmd.map (FiltersMsg << DenyPostsMsg) icmd
                    ]
            )

        DenyFreqsMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.freqsDeniedSelect.state

                freqsDeniedSelect =
                    LeSelect.updateSelectState (\_ -> imodel2) model.freqsDeniedSelect
                        |> LeSelect.updateSelectSelected (\s -> LeSelect.multiUpdS mAction s)

                filterDeniedAdjacentFreqs =
                    Utils.Utils.findAllAdjacentFreqs model.freqs freqsDeniedSelect.selected model.adjacentFreqsRangeSelect.selected
            in
            ( { model | freqsDeniedSelect = freqsDeniedSelect, filterDeniedAdjacentFreqs = filterDeniedAdjacentFreqs }
            , E.sendCmd <|
                Cmd.batch
                    [ LeSelect.multiUpdIfModified mAction <|
                        Task.perform LoadInitialStatsNow Time.now
                    , Cmd.map (FiltersMsg << DenyFreqsMsg) icmd
                    ]
            )

        DenySendersMsg imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.sendersDeniedSelect.state

                m2 =
                    { model
                        | sendersDeniedSelect =
                            LeSelect.updateSelectState (\_ -> imodel2) model.sendersDeniedSelect
                        , sendersDeniedNames = LeSelect.multiUpdS mAction model.sendersDeniedNames
                    }

                m3 =
                    { m2
                        | sendersDeniedSelect = LeSelect.updateSelectSelected (\s -> Filters.extractSendersIds model.sendersDeniedNames m2.sendersDeniedNames m2.profiles s) m2.sendersDeniedSelect
                    }
            in
            ( m3
            , E.sendCmd <|
                Cmd.batch
                    [ LeSelect.multiUpdIfModified mAction <|
                        Task.perform LoadInitialStatsNow Time.now
                    , Cmd.map (FiltersMsg << DenySendersMsg) icmd
                    ]
            )

        SelectAllGroups ->
            let
                m2 =
                    { model | groupsSelected = [] }

                m3 =
                    Filters.updateSelectItems m2
            in
            ( m3
            , E.none
            )

        SelectFilterFreqsRange imsg ->
            let
                ( mAction, imodel2, icmd ) =
                    Select.update imsg model.adjacentFreqsRangeSelect.state

                adjacentFreqsRangeSelect =
                    model.adjacentFreqsRangeSelect

                a2 =
                    { adjacentFreqsRangeSelect
                        | state = imodel2
                        , selected =
                            case mAction of
                                Just (Select.Select i) ->
                                    i

                                _ ->
                                    adjacentFreqsRangeSelect.selected
                    }
            in
            ( { model
                | filterSelectedAdjacentFreqs =
                    Utils.Utils.findAllAdjacentFreqs model.freqs model.freqsSelect.selected a2.selected
                , filterDeniedAdjacentFreqs =
                    Utils.Utils.findAllAdjacentFreqs model.freqs model.freqsDeniedSelect.selected a2.selected
                , adjacentFreqsRangeSelect = a2
              }
            , E.sendCmd <|
                Cmd.map (FiltersMsg << SelectFilterFreqsRange) icmd
            )


update : Shared.Model -> B.User -> Msg -> Model -> ( Model, Effect Msg )
update shared user msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        InitGotTime now_ ->
            let
                dtFromPosix =
                    now_
                        |> Time.posixToMillis
                        |> (\x -> x - 1000 * 60 * 60)
                        |> Time.millisToPosix

                m2 =
                    { model | dtFromPosix = Just dtFromPosix, digestLoadingTimestamp = SinceTime now_ }

                ( m3, cmd3 ) =
                    loadInitialStats m2 False
            in
            ( m3
            , E.batch
                [ E.sendCmd <| Api.user_sigint_groups GotGroupKeys { sinceDateInclusiveMs = Just (Utils.Time.xDaysAgo 2 now_ |> Time.posixToMillis) }
                , E.getPosts GotPosts (Query.analysisStatsDefaultParams (Utils.Time.xDaysAgo 14 now_) now_)
                , cmd3
                ]
            )

        GotWaterfallDiv res ->
            case res of
                Ok vp ->
                    let
                        wfHeight =
                            vp.viewport.y + vp.viewport.height - vp.element.y

                        wfHeight2 =
                            if wfHeight < 200 then
                                200

                            else
                                wfHeight
                    in
                    ( { model
                        | height = round wfHeight2
                      }
                    , E.none
                    )

                Err _ ->
                    ( model, E.none )

        GotWaterfallContainerDiv res ->
            case res of
                Ok vp ->
                    let
                        tolerance =
                            50

                        a =
                            Basics.abs vp.element.y + vp.viewport.height

                        isLastVisible =
                            Basics.abs (vp.element.height - a) <= tolerance

                        m2 =
                            { model
                                | loadingStrategy =
                                    case model.loadingStrategy of
                                        AutoScrollToLatest Done ->
                                            if isLastVisible then
                                                model.loadingStrategy

                                            else
                                                ManualScroll Up

                                        AutoScrollToLatest InProgress ->
                                            if isLastVisible && not model.loadingInboxMessages then
                                                AutoScrollToLatest Done

                                            else
                                                ManualScroll Up

                                        InitialLoad ->
                                            if isLastVisible then
                                                InitialLoad

                                            else if model.containerY < vp.element.y then
                                                ManualScroll Up

                                            else
                                                ManualScroll Down

                                        ManualScroll Up ->
                                            if model.containerY < vp.element.y then
                                                model.loadingStrategy

                                            else
                                                ManualScroll Down

                                        ManualScroll Down ->
                                            if model.containerY > vp.element.y then
                                                model.loadingStrategy

                                            else
                                                ManualScroll Up
                            }
                    in
                    ( { m2
                        | containerY = vp.element.y
                      }
                    , E.none
                    )

                Err _ ->
                    ( model, E.none )

        ScrollToLatestElement ->
            let
                ( m1, ef1 ) =
                    loadInitialStats model True
            in
            ( { m1 | loadingStrategy = AutoScrollToLatest InProgress, messages = Messages.fromList [] }
            , E.batch
                [ ef1 ]
            )

        Scroll ->
            let
                ( scrollThrottle, scrollThrottleCmd ) =
                    Debounce.push scrollThrottleConfig () model.scrollThrottle
            in
            ( { model
                | scrollThrottle = scrollThrottle
              }
            , E.sendCmd <| scrollThrottleCmd
            )

        ScrollEnd ->
            ( model
            , E.sendCmd <|
                Cmd.batch
                    [ Task.attempt
                        GotWaterfallContainerDiv
                        (Browser.Dom.getElement
                            (waterfallContainerId model.id)
                        )
                    , Ports.waterfall_getVisibleMsgIds
                        { waterfallId = model.id
                        , allMsgIds = List.map Tuple.first (Messages.toMessageList model.messages)
                        }
                    , if model.loadingEarlier == ScrollingIntoMessage then
                        Task.perform (always ScrollIntoMessageDone) (Task.succeed ())

                      else
                        Cmd.none
                    ]
            )

        ScrollThrottleMsg msg_ ->
            let
                ( scrollThrottle, scrollThrottleCmd ) =
                    Debounce.update
                        scrollThrottleConfig
                        (Debounce.takeLast (scrollThrottleAction model))
                        msg_
                        model.scrollThrottle
            in
            ( { model | scrollThrottle = scrollThrottle }
            , E.sendCmd <| scrollThrottleCmd
            )

        GotInitialInbox _ (Err e) ->
            ( { model | loadingInboxMessages = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження повідомлень" e
            )

        GotInitialInbox reload (Ok inboxRsp) ->
            let
                messages =
                    inboxRsp.inboxItems

                m0 =
                    mergeCallsignsInfo inboxRsp.callsigns model

                ( m1, eff1 ) =
                    updateFreqsAndCallsigns messages m0

                m2 =
                    { m1
                        | messages = Messages.fromList messages
                        , loadingInboxMessages = False
                    }

                m3 =
                    if reload then
                        { m2
                            | unreadIds = []
                            , notLoadedYetMessagesCounter = 0
                            , isMsgVisible = []
                            , initTime = model.time
                            , digestLoadingTimestamp =
                                case model.time of
                                    Just posix_ ->
                                        SinceTime posix_

                                    Nothing ->
                                        model.digestLoadingTimestamp
                        }

                    else
                        m2
            in
            ( m3
            , E.batch <|
                [ loadNewGroups messages model
                , loadNewProfiles messages model
                , loadNetworksForMessages shared model messages
                , E.sendCmd <| jumpToBottom (waterfallDivId model.id) NoOp
                , eff1
                ]
            )

        GotInboxEarlier (Err e) ->
            ( { model | loadingInboxMessages = False, loadingEarlier = NotLoading }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження старіших повідомлень" e
            )

        GotInboxEarlier (Ok inboxRsp) ->
            let
                messages =
                    inboxRsp.inboxItems

                m0 =
                    mergeCallsignsInfo inboxRsp.callsigns model

                ( m1, eff1 ) =
                    updateFreqsAndCallsigns messages m0

                m2 =
                    { m1
                        | loadingInboxMessages = False
                        , noEarlierMessagesLeft =
                            List.length messages <= 0
                    }

                loadingEarlierIdTrigger =
                    findEarlyMessage (Messages.toMessageList model.messages) |> Maybe.map Tuple.first

                minVisibleId =
                    model.isMsgVisible |> List.head

                oldestViewedMessageId =
                    Maybe.map2 (\id1 id2 -> Basics.min id1 id2) loadingEarlierIdTrigger minVisibleId
            in
            ( { m2
                | messages = Messages.prependList model.messages messages
                , loadingEarlier = ScrollingIntoMessage
              }
            , E.batch <|
                [ loadNewGroups messages model
                , loadNewProfiles messages model
                , loadNetworksForMessages shared model messages

                --, E.getViewportById (waterfallDivId model.id) (GotViewportBeforePrepending messages)
                , E.sendCmd <|
                    case oldestViewedMessageId of
                        Just id_ ->
                            Ports.waterfall_scrollIntoView { elemId = waterfallMessageDivId model.id id_, height = 0, waterfallId = waterfallDivId model.id }

                        Nothing ->
                            Cmd.none
                , eff1
                ]
            )

        GotProfileInfos (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження профілів" e )

        GotProfileInfos (Ok profiles) ->
            let
                m2 =
                    { model
                        | profiles = Dict.union profiles.data model.profiles
                    }

                m3 =
                    { m2
                        | sendersSelectedNames = Filters.ensureAllSendersNamed m2.profiles m2.sendersSelect.selected m2.sendersSelectedNames
                        , sendersDeniedNames = Filters.ensureAllSendersNamed m2.profiles m2.sendersDeniedSelect.selected m2.sendersDeniedNames
                    }

                m4 =
                    Filters.updateSelectItems m3
            in
            ( m4, E.none )

        GotGroupInfos (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження груп" e )

        GotGroupInfos (Ok groups) ->
            let
                m2 =
                    { model
                        | groupInfos =
                            groups.data
                                |> List.filter (\item -> not item.ignoreOperativny)
                                |> List.foldl (\group acc -> Dict.insert group.masterKey group acc) model.groupInfos
                    }

                m3 =
                    Filters.updateSelectItems m2
            in
            ( m3
            , E.getElementById (waterfallDivId model.id) GotWaterfallDiv
            )

        LoadInitialStatsNow _ ->
            loadInitialStats model False

        GotEarlierMessageDiv (Err _) ->
            ( model, E.none )

        GotEarlierMessageDiv (Ok vp) ->
            let
                enoughTimeWentBy =
                    case ( model.initTime, model.time ) of
                        ( Just initTime, Just time ) ->
                            (Time.posixToMillis time - Time.posixToMillis initTime)
                                > Config.waterfallLoadEarlierThresholdMs

                        _ ->
                            False

                loadEarlier =
                    model.loadingEarlier
                        == NotLoading
                        && (round vp.element.y > 0)
                        && enoughTimeWentBy
                        && not model.noEarlierMessagesLeft
            in
            if loadEarlier then
                let
                    mFirstId =
                        model.messages |> Messages.toMessageList |> List.head |> Maybe.map Tuple.first
                in
                ( { model
                    | loadingEarlier = Loading
                    , loadingInboxMessages = True
                  }
                , E.getInboxMessages (Just (loadEarlierTracker model.id)) GotInboxEarlier (getInboxParamsForMessages model |> setBeforeIdNoninclusive mFirstId)
                )

            else
                ( model, E.none )

        InboxLoopLoadNewer ->
            case ListX.last (Messages.toMessageList model.messages) of
                Nothing ->
                    ( model
                    , E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval)
                    )

                Just ( messageId, _ ) ->
                    case model.loadingStrategy of
                        AutoScrollToLatest InProgress ->
                            ( model, E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval) )

                        AutoScrollToLatest Done ->
                            if not model.loadingInboxMessages then
                                ( { model
                                    | digestLoadingTimestamp =
                                        case model.time of
                                            Just time_ ->
                                                SinceTime time_

                                            Nothing ->
                                                model.digestLoadingTimestamp
                                    , loadingInboxMessages = True
                                  }
                                , E.getInboxMessages Nothing
                                    (InboxLoopGotMessages False)
                                    (getInboxParamsForMessages model |> setSinceIdNoninclusive (Just messageId))
                                )

                            else
                                ( model, E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval) )

                        InitialLoad ->
                            ( { model | loadingInboxMessages = True, loadingInboxDigest = True }
                            , E.batch
                                [ E.getInboxMessages Nothing
                                    (InboxLoopGotMessages True)
                                    (getInboxParamsForMessages model |> setSinceIdNoninclusive (Just messageId))
                                , E.sendCmd <| loadInboxDigest model model.digestLoadingTimestamp
                                ]
                            )

                        ManualScroll _ ->
                            if not model.loadingInboxMessages then
                                let
                                    loadingTrasholdPassed =
                                        hasLoadingTrasholdPassed model

                                    m2 =
                                        { model
                                            | loadingInboxMessages =
                                                loadingTrasholdPassed && (model.unreadMessagesLeft || model.notLoadedYetMessagesCounter > 0)
                                        }

                                    ( m3, eff3 ) =
                                        if loadingTrasholdPassed then
                                            if model.unreadMessagesLeft then
                                                ( m2
                                                , [ E.getInboxMessages (Just (loadNewerTracker model.id))
                                                        (InboxLoopGotMessages False)
                                                        (getInboxParamsForMessages model |> setSinceIdNoninclusive (Just messageId))
                                                  ]
                                                )

                                            else if model.notLoadedYetMessagesCounter > 0 then
                                                ( m2
                                                , [ E.getInboxMessages (Just (loadNewerTracker model.id))
                                                        (InboxLoopGotMessages False)
                                                        (getInboxParamsForMessages model |> setSinceIdNoninclusive (Just messageId))
                                                  ]
                                                )

                                            else if m2.loadingInboxDigest then
                                                ( m2
                                                , [ E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval)
                                                  ]
                                                )

                                            else
                                                ( { m2 | loadingInboxDigest = True }
                                                , [ E.sendCmd <| loadInboxDigest model model.digestLoadingTimestamp
                                                  , E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval)
                                                  ]
                                                )

                                        else if m2.loadingInboxDigest then
                                            ( m2
                                            , [ E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval)
                                              ]
                                            )

                                        else
                                            ( { m2 | loadingInboxDigest = True }
                                            , [ E.sendCmd <| loadInboxDigest model model.digestLoadingTimestamp
                                              , E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval)
                                              ]
                                            )
                                in
                                ( m3
                                , E.batch eff3
                                )

                            else
                                ( model, E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) (Process.sleep loadingNewMessagesInterval) )

        GotInboxMessagesDigest (Ok rsp) ->
            ( { model
                | notLoadedYetMessagesCounter =
                    rsp.quantity
                , firstNewMessageTimestamp =
                    case rsp.firstElementTs of
                        Just ts_ ->
                            Just ts_

                        Nothing ->
                            model.firstNewMessageTimestamp
                , loadingInboxDigest = False
              }
            , E.none
            )

        GotInboxMessagesDigest (Err e) ->
            ( { model | loadingInboxDigest = False }
            , E.none
            )

        InboxLoopSleptBeforeLoadNewer ->
            ( model
            , E.sendCmd <| Task.perform (\_ -> InboxLoopLoadNewer) Time.now
            )

        InboxLoopGotMessages _ (Err _) ->
            -- Api.handleHttpError ToastMsg e model
            ( { model | loadingInboxMessages = False }
            , E.sendCmd <| Task.perform (\_ -> InboxLoopSleptBeforeLoadNewer) (Process.sleep loadingNewMessagesInterval)
            )

        InboxLoopGotMessages once (Ok inboxRsp) ->
            let
                messages =
                    inboxRsp.inboxItems
            in
            case model.loadingStrategy of
                ManualScroll _ ->
                    let
                        ( m1, eff1 ) =
                            commonGotInboxLoopFunc messages model

                        m2 =
                            { m1
                                | notRenderedMessagesYet =
                                    case model.loadingStrategy of
                                        ManualScroll _ ->
                                            messages

                                        _ ->
                                            []
                            }

                        m2WithCallsigns =
                            mergeCallsignsInfo inboxRsp.callsigns m2

                        ( m3, eff3 ) =
                            updateFreqsAndCallsigns messages m2WithCallsigns
                    in
                    ( { m3
                        | loadingInboxMessages =
                            if List.length m2.notRenderedMessagesYet == 0 then
                                False

                            else
                                model.loadingInboxMessages
                      }
                    , E.batch <|
                        [ eff1
                        , eff3
                        , loadNetworksForMessages shared model messages
                        , E.sendCmd <|
                            if List.length m3.notRenderedMessagesYet > 0 then
                                Ports.waterfall_getVisibleMsgIds
                                    { waterfallId = model.id
                                    , allMsgIds = List.map Tuple.first (messages |> Messages.appendList model.messages |> Messages.toMessageList)
                                    }

                            else
                                Cmd.none
                        ]
                    )

                AutoScrollToLatest _ ->
                    let
                        ( m1, eff1 ) =
                            commonGotInboxLoopFunc messages model

                        m2 =
                            { m1
                                | messages =
                                    Messages.appendList model.messages messages
                                , loadingInboxMessages =
                                    False
                                , loadingStrategy =
                                    if List.length messages > 0 then
                                        AutoScrollToLatest InProgress

                                    else
                                        AutoScrollToLatest Done
                            }

                        m2WithCallsigns =
                            mergeCallsignsInfo inboxRsp.callsigns m2

                        ( m3, eff3 ) =
                            updateFreqsAndCallsigns messages m2WithCallsigns
                    in
                    ( m3
                    , E.batch <|
                        [ eff1
                        , eff3
                        , loadNetworksForMessages shared model messages
                        , if List.length messages > 0 then
                            E.sendCmd <| jumpToBottom (waterfallDivId model.id) NoOp

                          else
                            E.none
                        ]
                    )

                InitialLoad ->
                    let
                        ( m1, eff1 ) =
                            commonGotInboxLoopFunc messages model

                        m2 =
                            { m1
                                | loadingStrategy =
                                    if once then
                                        ManualScroll Up

                                    else
                                        model.loadingStrategy
                                , loadingInboxMessages =
                                    False
                                , messages =
                                    Messages.appendList model.messages messages
                                , lastViewedMessageId =
                                    case messages |> List.reverse |> List.head |> Maybe.map Tuple.first of
                                        Just lastViewedId_ ->
                                            LastViewedId lastViewedId_

                                        Nothing ->
                                            model.lastViewedMessageId
                            }

                        m2WithCallsigns =
                            mergeCallsignsInfo inboxRsp.callsigns m2

                        ( m3, eff3 ) =
                            updateFreqsAndCallsigns messages m2WithCallsigns
                    in
                    ( m3
                    , E.batch <|
                        [ eff1
                        , eff3
                        , loadNetworksForMessages shared model messages
                        ]
                    )

        CloseWaterfall ->
            ( model, E.none )

        GetVisibleMsgIdsRes res ->
            if model.id == res.waterfallId then
                case model.loadingStrategy of
                    ManualScroll _ ->
                        let
                            newToUnreadMessages =
                                model.notRenderedMessagesYet
                                    |> ListX.findIndex
                                        (\( _, message_ ) ->
                                            case ( message_.timestamp, model.firstNewMessageTimestamp ) of
                                                ( Just ts_, Just firstNewMTs ) ->
                                                    ts_ >= firstNewMTs

                                                ( Just ts_, Nothing ) ->
                                                    case model.initTime of
                                                        Just posix_ ->
                                                            ts_ >= Time.posixToMillis posix_

                                                        Nothing ->
                                                            False

                                                _ ->
                                                    False
                                        )
                                    |> (\mIndex ->
                                            case mIndex of
                                                Just index ->
                                                    List.drop index model.notRenderedMessagesYet

                                                Nothing ->
                                                    []
                                       )

                            firstNotRenderedMessageTs =
                                model.notRenderedMessagesYet |> List.reverse |> List.head |> Maybe.andThen (\( _, message_ ) -> message_.timestamp)

                            m2 =
                                { model
                                    | digestLoadingTimestamp =
                                        case ( firstNotRenderedMessageTs, model.digestLoadingTimestamp ) of
                                            ( Just timestamp_, SinceTime oldTimePosix ) ->
                                                if timestamp_ > Time.posixToMillis oldTimePosix then
                                                    SinceTime (Time.millisToPosix <| timestamp_ + 1)

                                                else
                                                    model.digestLoadingTimestamp

                                            _ ->
                                                model.digestLoadingTimestamp
                                }
                                    |> (if List.length newToUnreadMessages > 0 then
                                            appendUnreadIds newToUnreadMessages

                                        else
                                            identity
                                       )

                            messages =
                                if List.length model.notRenderedMessagesYet > 0 then
                                    Messages.appendList model.messages model.notRenderedMessagesYet

                                else
                                    model.messages

                            m3 =
                                commonGotVisibleMsgFunc res.msgIds m2
                        in
                        ( { m3
                            | messages = messages
                            , notRenderedMessagesYet = []
                            , loadingInboxMessages =
                                case model.loadingStrategy of
                                    ManualScroll _ ->
                                        False

                                    _ ->
                                        model.loadingInboxMessages
                          }
                        , E.sendCmd <|
                            case List.head res.msgIds of
                                Just id_ ->
                                    let
                                        moreThanLimit =
                                            (List.length model.notRenderedMessagesYet + List.length (Messages.toMessageList model.messages)) > 100
                                    in
                                    if List.length model.notRenderedMessagesYet > 0 && moreThanLimit then
                                        Ports.waterfall_scrollIntoView
                                            { elemId = waterfallMessageDivId model.id id_
                                            , waterfallId = waterfallDivId model.id
                                            , height = res.firstVisibleHeight
                                            }

                                    else
                                        Cmd.none

                                _ ->
                                    Cmd.none
                        )

                    _ ->
                        let
                            m2 =
                                commonGotVisibleMsgFunc res.msgIds model
                        in
                        ( m2
                        , E.none
                        )

            else
                ( model, E.none )

        InitGotLatestSenders (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження відправників" e )

        InitGotLatestSenders (Ok profiles) ->
            let
                m2 =
                    { model | profiles = profiles.data }

                m3 =
                    Filters.updateSelectItems m2

                loadFilteredProfilesCmd =
                    model.sendersDeniedSelect.selected
                        ++ model.sendersSelect.selected
                        |> Set.fromList
                        |> Set.toList
                        |> List.filter (\uuid -> Dict.get uuid model.profiles == Nothing)
                        |> (\uuids -> Api.rer_importer_signal_profile_info_batch GotProfileInfos { profiles = uuids |> List.map (\id -> { uuid = id }) })
            in
            ( m3
            , E.sendCmd <| loadFilteredProfilesCmd
            )

        GotGroupKeys (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження ключів груп" e )

        GotGroupKeys (Ok vs) ->
            ( { model | groups = vs }
            , E.sendCmd <|
                Api.rer_importer_signal_group_info_batch
                    GotGroupInfos
                    { groups = vs |> List.map (\id -> { masterKey = id })
                    , skipGroupStats = Just True
                    }
            )

        TickTimeTick now ->
            let
                m2 =
                    { model | time = Just now }

                m3 =
                    case m2.initTime of
                        Nothing ->
                            { m2 | initTime = Just now, digestLoadingTimestamp = SinceTime now }

                        Just _ ->
                            m2
            in
            ( m3
            , E.sendCmd <| Task.perform (\_ -> TickTimeSlept) (Process.sleep 1000)
            )

        TickTimeSlept ->
            ( model
            , E.getCurrentTime TickTimeTick
            )

        GotTags (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження тегів" e )

        GotTags (Ok vs) ->
            ( { model | tags = vs }
            , E.none
            )

        GotTime _ ->
            ( model, E.none )

        GotLatestFrequencies (Ok freqs) ->
            let
                newFreqs =
                    freqs |> List.filter (\x -> not (List.member x model.freqs))

                freqsMenu =
                    Filters.createMenu (model.freqs ++ newFreqs)
            in
            ( { model
                | freqs = model.freqs ++ freqs
                , freqsSelect = LeSelect.updateSelectItems (\_ -> freqsMenu) model.freqsSelect
                , freqsDeniedSelect = LeSelect.updateSelectItems (\_ -> freqsMenu) model.freqsDeniedSelect
              }
            , E.none
            )

        GotLatestFrequencies (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження частот" e )

        GotPosts (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження постів" e )

        GotPosts (Ok rsp) ->
            let
                posts =
                    List.map (\p -> p.post) rsp.posts

                postsMenu =
                    Filters.createMenu posts
            in
            ( { model
                | posts = posts
                , postsSelect = LeSelect.updateSelectItems (\_ -> postsMenu) model.postsSelect
                , postsDeniedSelect = LeSelect.updateSelectItems (\_ -> postsMenu) model.postsDeniedSelect
              }
            , E.none
            )

        ReloadLatestFrequencies ->
            ( model, E.sendCmd <| Api.sigint_latest_frequencies GotLatestFrequencies )

        GotCallsignsInfo (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження інформації про позивні" e )

        GotCallsignsInfo (Ok callsigns) ->
            ( mergeCallsignsInfo callsigns model, E.none )

        GotNetworksInfo (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження мереж" e )

        GotNetworksInfo (Ok networks) ->
            let
                newNetworks =
                    networks
                        |> List.map (\network -> ( network.id, network ))
                        |> Dict.fromList
            in
            ( { model | networksExtra = Dict.union newNetworks model.networksExtra }, E.none )

        GotSignals (Err err) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження сигналів" err )

        GotSignals (Ok rsp) ->
            ( { model | signals = rsp.signals }
            , E.none
            )

        MessageMsg id message innerMsg ->
            case model.messages |> Messages.getItem id of
                Just ( message_, model_ ) ->
                    let
                        copied =
                            case model.clipboardCopied of
                                Just clipboard ->
                                    if Tuple.first clipboard == id then
                                        Just (Tuple.second clipboard)

                                    else
                                        Nothing

                                Nothing ->
                                    Nothing

                        vps =
                            let
                                networksDict =
                                    networksForView shared model

                                messageNetworkIds =
                                    case message_.networkIds of
                                        Just networkIds ->
                                            ListX.unique networkIds

                                        Nothing ->
                                            []
                            in
                            { isDarkMode = isDarkMode shared.themeMode
                            , user = user
                            , serverInfo = shared.serverInfo
                            , waterfallId = model.id
                            , datasources = model.datasources
                            , messageNetworkIds = messageNetworkIds
                            , masterUnits =
                                case shared.masterUnits of
                                    Success units ->
                                        units

                                    _ ->
                                        Dict.empty
                            , callsignsInfo = model.callsignsInfo
                            , networks = networksDict
                            , zone = shared.timeZone
                            , time = model.time
                            , profiles = model.profiles
                            , tags = model.tags
                            , signals = model.signals
                            , message = ( id, message_ )
                            , copied = copied
                            , isMsgVisible = model.isMsgVisible
                            , groupInfos = model.groupInfos
                            , onlyMyUnitTagsEnabled = model.onlyMyUnitTagsEnabled
                            }

                        ( innerModel_, innerCmd_, updatedMessage_ ) =
                            Pages_.RerDuty.Waterfall.Message.update vps innerMsg model_
                    in
                    ( { model | messages = Messages.updateModel id innerModel_ model.messages |> Messages.updateMessage id updatedMessage_ }
                    , E.map (MessageMsg id message) innerCmd_
                    )

                Nothing ->
                    ( model, E.none )

        CopyToClipboard t id_ ->
            case findK id_ (Messages.toMessageList model.messages) of
                Nothing ->
                    ( model, E.none )

                Just message ->
                    let
                        m2 =
                            { model | clipboardCopied = Just ( id_, t ) }
                    in
                    ( m2
                    , E.sendCmd <|
                        Cmd.batch
                            [ Ports.waterfall_copyTextToClipboard
                                { text =
                                    case t of
                                        Pages_.RerDuty.Waterfall.Message.Message ->
                                            Pages_.RerDuty.Waterfall.Message.clipboardMessage message model

                                        Pages_.RerDuty.Waterfall.Message.Freq ->
                                            Maybe.withDefault "Невідома" message.freq

                                        Pages_.RerDuty.Waterfall.Message.Empty ->
                                            ""
                                }
                            , Task.perform (\_ -> RemoveClipboardCopied) (Process.sleep 1000)
                            ]
                    )

        RemoveClipboardCopied ->
            ( { model | clipboardCopied = Nothing }, E.none )

        FiltersMsg filterMsg ->
            updateFilters filterMsg model

        BookmarkChanged id ->
            let
                updatedMessages =
                    case Messages.getItem id model.messages of
                        Just ( message, _ ) ->
                            Messages.updateMessage id ( id, { message | bookmarked = not message.bookmarked } ) model.messages

                        Nothing ->
                            model.messages

                cmd =
                    case Messages.getItem id model.messages of
                        Just ( message, _ ) ->
                            if message.bookmarked then
                                E.sendCmd <| Api.rer_bookmark_rm (BookmarkRemoveDone id) { messageId = id }

                            else
                                E.sendCmd <| Api.rer_bookmark_add (BookmarkAddDone id) { messageId = id }

                        Nothing ->
                            E.none
            in
            ( { model | messages = updatedMessages }, cmd )

        BookmarkAddDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання закладки" e )

        BookmarkAddDone _ (Ok ()) ->
            ( model, E.none )

        BookmarkRemoveDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення закладки" e )

        BookmarkRemoveDone _ (Ok ()) ->
            ( model, E.none )

        ImportantChanged id ->
            let
                updatedMessages =
                    case Messages.getItem id model.messages of
                        Just ( message, _ ) ->
                            Messages.updateMessage id ( id, { message | important = not message.important } ) model.messages

                        Nothing ->
                            model.messages

                cmd =
                    case Messages.getItem id model.messages of
                        Just ( message, _ ) ->
                            if message.important then
                                E.sendCmd <| Api.rer_important_rm (ImportantRemoveDone id) { messageId = id }

                            else
                                E.sendCmd <| Api.rer_important_add (ImportantAddDone id) { messageId = id }

                        Nothing ->
                            E.none
            in
            ( { model | messages = updatedMessages }, cmd )

        ImportantAddDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання важливого повідомлення" e )

        ImportantAddDone _ (Ok ()) ->
            ( model, E.none )

        ImportantRemoveDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення важливого повідомлення" e )

        ImportantRemoveDone _ (Ok ()) ->
            ( model, E.none )

        ScrollIntoMessageDone ->
            ( { model | loadingEarlier = NotLoading }, E.none )

        DeleteMessage id ->
            ( { model | deleteMessageConfirmationId = Just id }, E.none )

        DeleteMessageCancel ->
            ( { model | deleteMessageConfirmationId = Nothing }, E.none )

        DeleteMessageConfirm ->
            case model.deleteMessageConfirmationId of
                Just id_ ->
                    ( model, E.deleteMessage (DeleteMessageDone id_) { id = id_ } )

                Nothing ->
                    ( model, E.none )

        DeleteMessageDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення повідомлення" e )

        DeleteMessageDone id (Ok ()) ->
            ( { model | messages = model.messages |> Messages.filterMessages (\( id_, _ ) -> id_ /= id), deleteMessageConfirmationId = Nothing }, E.none )


findEarlyMessage : List ( Int, B.InboxMessage ) -> Maybe ( Int, B.InboxMessage )
findEarlyMessage messages =
    case messages of
        [] ->
            Nothing

        x :: xs ->
            let
                go m ms counter =
                    if counter == 0 then
                        Just m

                    else
                        case ms of
                            [] ->
                                Just m

                            m2 :: ms2 ->
                                go m2 ms2 (counter - 1)
            in
            go x xs (earlyMessageCount - 1)


scrollThrottleAction : Model -> () -> Cmd Msg
scrollThrottleAction model _ =
    case findEarlyMessage (Messages.toMessageList model.messages) of
        Nothing ->
            Cmd.none

        Just ( i, _ ) ->
            Task.attempt
                GotEarlierMessageDiv
                (Browser.Dom.getElement
                    (waterfallMessageDivId model.id i)
                )


waterfallDivId : String -> String
waterfallDivId id_ =
    "waterfall-" ++ id_


waterfallContainerId : String -> String
waterfallContainerId id_ =
    "waterfall-" ++ id_ ++ "-container"


waterfallBottomDivId : String -> String
waterfallBottomDivId id_ =
    "waterfall-bottom-" ++ id_


waterfallMessageDivId : String -> Int -> String
waterfallMessageDivId waterfallId messageId =
    "waterfall-" ++ waterfallId ++ "-message-" ++ String.fromInt messageId


waterfallControlPanelId : String -> String
waterfallControlPanelId waterfallId =
    "waterfall-control-" ++ waterfallId


waterfallDiv :
    B.User
    -> Bool
    -> Set Int
    -> List ( Int, B.Datasource )
    -> Maybe B.ServerInfo
    -> Dict Int B.Unit
    -> Model
    -> Shared.Model
    -> Html Msg
waterfallDiv user isDarkMode duplicates datasources serverInfo masterUnits model shared =
    let
        hideGoLatestButton =
            case model.loadingStrategy of
                AutoScrollToLatest _ ->
                    True

                _ ->
                    False

        unreadLoadedCount =
            --List.length (List.filter (\x -> not (Set.member x duplicates)) model.unreadIds)
            List.length model.unreadIds

        unreadMessagesCounter =
            model.notLoadedYetMessagesCounter + unreadLoadedCount
    in
    div
        [ style "position" "relative"
        , class "waterfall bg-column min-w-[500px] grow-1"
        , style "z-index" "50"
        ]
        [ div
            [ style "overflow-y" "auto"
            , style "overflow-x" "hidden"
            , id <| waterfallDivId model.id
            , style "scroll-behavior" "smooth"
            , on "scroll" (Decode.succeed Scroll)
            , on "scrollend" (Decode.succeed ScrollEnd)
            , style "height" <| String.fromInt model.height ++ "px"
            ]
            [ Html.Keyed.node "div" [ style "overflow" "hidden", id <| waterfallContainerId model.id, style "min-height" <| String.fromInt model.height ++ "px" ] <|
                ( "scroll-to-latest-button"
                , div
                    [ style "position" "absolute"
                    , style "bottom" "10px"
                    , style "right" "20px"
                    , style "cursor" "pointer"
                    , style "z-index" "800"
                    , classList [ ( "d-none", hideGoLatestButton ) ]
                    , onClick ScrollToLatestElement
                    ]
                    [ div
                        [ style "position" "relative"
                        , class "text-center"
                        ]
                      <|
                        div
                            [ style "font-size" "2rem"
                            , classList
                                [ ( "text-action opacity-75", unreadMessagesCounter > 0 )
                                , ( "opacity-50", unreadMessagesCounter == 0 )
                                ]
                            ]
                            [ i [ class "bi bi-arrow-down-circle" ] [] ]
                            :: (if unreadMessagesCounter > 0 then
                                    [ div
                                        [ style "position" "absolute"
                                        , style "bottom" "0px"
                                        , style "width" "100%"
                                        , class "text-center"
                                        , style "font-size" ".7rem"
                                        ]
                                        [ span [ class "badge rounded-pill text-bg-primary" ]
                                            [ text <| String.fromInt unreadMessagesCounter ]
                                        ]
                                    ]

                                else
                                    []
                               )
                    ]
                )
                    :: (if (model.messages |> Messages.toModelList |> List.length) > 0 then
                            List.map
                                (\( id, ( message, msgModel ) ) ->
                                    let
                                        isDuplicate =
                                            Set.member id duplicates

                                        copied =
                                            case model.clipboardCopied of
                                                Just c ->
                                                    if Tuple.first c == id then
                                                        Just (Tuple.second c)

                                                    else
                                                        Nothing

                                                Nothing ->
                                                    Nothing

                                        translator : Pages_.RerDuty.Waterfall.Message.Translator Msg
                                        translator =
                                            let
                                                translationDictionary =
                                                    { onInternalMessage = MessageMsg id message
                                                    , onCopyToClipboard = \clipboardObject -> CopyToClipboard clipboardObject id
                                                    , onBookmarkChanged = BookmarkChanged
                                                    , onImportantChanged = ImportantChanged
                                                    , onMessageDelete = \id_ -> DeleteMessage id_
                                                    }
                                            in
                                            Pages_.RerDuty.Waterfall.Message.translator translationDictionary

                                        vps =
                                            let
                                                networksDict =
                                                    networksForView shared model

                                                messageNetworkIds =
                                                    case message.networkIds of
                                                        Just networkIds ->
                                                            ListX.unique networkIds

                                                        Nothing ->
                                                            []
                                            in
                                            { isDarkMode = isDarkMode
                                            , waterfallId = model.id
                                            , datasources = datasources
                                            , serverInfo = serverInfo
                                            , user = user
                                            , messageNetworkIds = messageNetworkIds
                                            , masterUnits = masterUnits
                                            , callsignsInfo = model.callsignsInfo
                                            , networks = networksDict
                                            , zone = shared.timeZone
                                            , time = model.time
                                            , profiles = model.profiles
                                            , tags = model.tags
                                            , signals = model.signals
                                            , message = ( id, message )
                                            , copied = copied
                                            , isMsgVisible = model.isMsgVisible
                                            , groupInfos = model.groupInfos
                                            , onlyMyUnitTagsEnabled = model.onlyMyUnitTagsEnabled
                                            }
                                    in
                                    ( String.fromInt msgModel.id
                                    , msgModel
                                        |> Pages_.RerDuty.Waterfall.Message.setIsDuplicate isDuplicate
                                        |> Pages_.RerDuty.Waterfall.Message.view vps ( id, message )
                                        |> Html.map translator
                                    )
                                )
                                (model.messages |> Messages.toList)

                        else
                            [ ( "empty-list"
                              , div
                                    [ class "text-muted"
                                    , style "min-height" <|
                                        String.fromInt model.height
                                            ++ "px"
                                    , style "display" "flex"
                                    , style "justify-content" "center"
                                    , style "align-items" "center"
                                    ]
                                    [ div []
                                        [ if model.loadingInboxMessages then
                                            Shared.Components.Spinner.loadingSpinner

                                          else
                                            div [] [ text "Немає повідомлень" ]
                                        ]
                                    ]
                              )
                            ]
                       )
                    ++ [ ( "waterfall-bottom"
                         , div
                            [ id <| waterfallBottomDivId model.id
                            , style "transform" "translateY(-10px)"
                            ]
                            []
                         )
                       ]
            ]
        ]


type alias MessageTabPs =
    { isDarkMode : Bool
    , duplicates : Set Int
    , datasources : List ( Int, B.Datasource )
    , serverInfo : Maybe B.ServerInfo
    , user : B.User
    , waterfallsAmount : Int
    , masterUnits : Dict Int B.Unit
    , networks : Dict Int B.Network
    }


messageTab : MessageTabPs -> Shared.Model -> Model -> Html Msg
messageTab ps shared model =
    let
        deleteFilterModal =
            div
                [ class "modal fade"
                , attribute "tabindex" "-1"
                , attribute "role" "dialog"
                , attribute "aria-hidden" "true"
                , id "deleteConfirmationModal"
                ]
                [ div
                    [ class "modal-dialog"
                    , attribute "role" "document"
                    ]
                    [ div
                        [ class "modal-content" ]
                        [ div
                            [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "Видалення фільтру" ]
                            , button
                                [ class "btn-close"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , attribute "ariaLabel" "Close"
                                ]
                                []
                            ]
                        , div
                            [ class "modal-body p-3" ]
                            [ text "Ви впевнені, що хочете видалити цей фільтр?"
                            ]
                        , div
                            [ class "modal-footer" ]
                            [ button
                                [ class "btn btn-secondary"
                                , attribute "type" "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick (FiltersMsg DeleteFilterCancel)
                                ]
                                [ text "Відміна" ]
                            , button
                                [ class "btn btn-danger"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick (FiltersMsg DeleteFilterConfirm)
                                ]
                                [ text "Видалити" ]
                            ]
                        ]
                    ]
                ]

        deleteMessageModal =
            div
                [ class "modal fade"
                , attribute "tabindex" "-1"
                , attribute "role" "dialog"
                , attribute "aria-hidden" "true"
                , id "deleteMessageConfirmation"
                ]
                [ div
                    [ class "modal-dialog"
                    , attribute "role" "document"
                    ]
                    [ div
                        [ class "modal-content" ]
                        [ div
                            [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "Видалення повідомлення" ]
                            , button
                                [ class "btn-close"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , attribute "ariaLabel" "Close"
                                ]
                                []
                            ]
                        , div
                            [ class "modal-body p-3" ]
                            [ text "Ви впевнені, що хочете видалити це повідомлення?"
                            ]
                        , div
                            [ class "modal-footer" ]
                            [ button
                                [ class "btn btn-secondary"
                                , attribute "type" "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick DeleteMessageCancel
                                ]
                                [ text "Відміна" ]
                            , button
                                [ class "btn btn-danger"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick DeleteMessageConfirm
                                ]
                                [ text "Видалити" ]
                            ]
                        ]
                    ]
                ]

        groupBadge groupN =
            let
                isSelected : String -> Bool
                isSelected n =
                    let
                        ids =
                            Filters.groupNameToIds n model.groupInfos
                    in
                    List.any (\id -> List.member id model.groupsSelected) ids

                lblHtml =
                    [ div [ class "d-flex align-items-center" ] <|
                        [ div [] [ text <| groupN ]
                        ]
                    ]
            in
            div [ class "fs-6 mb-1 text-nowrap" ] <|
                if isSelected groupN then
                    badgeSelectedCloseCounter lblHtml (FiltersMsg (UnselectGroup groupN))

                else
                    [ badgeNotSelectedHtml lblHtml
                        (FiltersMsg (SelectGroup groupN))
                    ]

        settingsPanelBlock =
            let
                findFilterName : Int -> List ( Int, B.SavedFilterDuty ) -> String
                findFilterName id list =
                    list
                        |> List.filter (\( itemId, _ ) -> itemId == id)
                        |> List.head
                        |> Maybe.map Tuple.second
                        |> Maybe.map .name
                        |> Maybe.withDefault ""
            in
            div [] <|
                (div
                    [ class "flex flex-wrap justify-start items-center" ]
                 <|
                    div [ class "me-1 mb-1" ]
                        [ button
                            [ type_ "button"
                            , class "btn btn-light btn-sm text-nowrap me-1"
                            , onClick <| FiltersMsg ToggleUnfoldSettings
                            , style "font-size" ".75rem"
                            , classList [ ( "active", model.unfoldSettings ) ]
                            ]
                            [ i [ class "bi bi-gear" ] [] ]
                        ]
                        :: (if model.unfoldSettings then
                                let
                                    selectAll =
                                        [ div [ class "me-2" ] <|
                                            if List.length model.groupsSelected == 0 then
                                                [ badgeSelectedHtml [ span [] [ text "всі" ] ] ]

                                            else
                                                [ badgeNotSelectedHtml [ span [] [ text "всі" ] ] (FiltersMsg SelectAllGroups) ]
                                        ]
                                in
                                selectAll
                                    ++ List.map groupBadge (model.groupInfos |> Dict.values |> List.map .name |> Set.fromList |> Set.toList)

                            else
                                let
                                    selectAllOrEmpty =
                                        if List.length model.groupsSelected == 0 then
                                            [ badgeSelectedHtml [ span [] [ text "всі" ] ] ]

                                        else
                                            []

                                    groupsSelected =
                                        List.filter (\x -> List.member x model.groupsSelected) model.groups

                                    groupNames =
                                        groupsSelected |> List.filterMap (\id -> Dict.get id model.groupInfos) |> List.map .name |> Set.fromList |> Set.toList

                                    firstThreeGroups =
                                        List.take 3 groupNames

                                    remainingCount =
                                        List.length groupNames - 3

                                    additionalBadge =
                                        if remainingCount > 0 then
                                            [ badgeSelectedHtml [ span [] [ text ("+ " ++ String.fromInt remainingCount) ] ] ]

                                        else
                                            []
                                in
                                selectAllOrEmpty
                                    ++ List.map groupBadge firstThreeGroups
                                    ++ additionalBadge
                           )
                )
                    :: (if model.unfoldSettings then
                            let
                                selectUsersSelectedItems =
                                    List.map
                                        (\name ->
                                            Select.basicMenuItem
                                                { item = name
                                                , label = name
                                                }
                                        )
                                        model.sendersSelectedNames

                                selectedFilter =
                                    case model.filterSelect.selected of
                                        Just filterId ->
                                            Just
                                                (Select.basicMenuItem
                                                    { item = filterId
                                                    , label = findFilterName filterId model.savedFilters
                                                    }
                                                )

                                        Nothing ->
                                            Nothing

                                deniedSendersSelectedItems =
                                    List.map
                                        (\name ->
                                            Select.basicMenuItem
                                                { item = name
                                                , label = name
                                                }
                                        )
                                        model.sendersDeniedNames

                                selectFreqsSelectedItems =
                                    List.map
                                        (\freq ->
                                            Select.basicMenuItem
                                                { item = freq
                                                , label = freq
                                                }
                                        )
                                        model.freqsSelect.selected

                                selectPostsSelectedItems =
                                    List.map
                                        (\post ->
                                            Select.basicMenuItem
                                                { item = post
                                                , label = getLabelOrDefault post
                                                }
                                        )
                                        model.postsSelect.selected

                                deniedPostsSelectedItems =
                                    List.map
                                        (\post ->
                                            Select.basicMenuItem
                                                { item = post
                                                , label = getLabelOrDefault post
                                                }
                                        )
                                        model.postsDeniedSelect.selected

                                deniedFreqsSelectedItems =
                                    List.map
                                        (\freq ->
                                            Select.basicMenuItem
                                                { item = freq
                                                , label = freq
                                                }
                                        )
                                        model.freqsDeniedSelect.selected

                                savedFiltersBlock =
                                    div
                                        [ class "mt-2" ]
                                        [ p [ class "fw-bold" ] [ text "збережені фільтри" ]
                                        , div
                                            [ style "padding-left" "110px" ]
                                            [ div [ class "w-100" ]
                                                [ div [ class "flex  items-center gap-2" ]
                                                    [ input
                                                        [ placeholder "назва"
                                                        , id "filter-name"
                                                        , class "form-control"
                                                        , style "font-size" ".8rem"
                                                        , style "width" "100%"
                                                        , type_ "text"
                                                        , onInput <| (FiltersMsg << SaveFilterInp)
                                                        , value <| model.saveFilterInp
                                                        ]
                                                        []
                                                    , button
                                                        [ class "btn btn-secondary"
                                                        , style "margin-left" "auto"
                                                        , attribute "type" "button"
                                                        , onClick (FiltersMsg SaveFilterDo)
                                                        , disabled (String.isEmpty model.saveFilterInp)
                                                        ]
                                                        [ text "додати" ]
                                                    ]
                                                ]
                                            , div
                                                [ class "mt-2 flex items-center gap-2" ]
                                                [ div
                                                    [ style "font-size" ".8rem"
                                                    , style "flex" "0 0 85%"
                                                    ]
                                                  <|
                                                    [ Html.map (FiltersMsg << SelectFilterMsg)
                                                        (Styled.toUnstyled <|
                                                            LeSelect.renderSelectSingle
                                                                selectedFilter
                                                                model.filterSelect.state
                                                                model.filterSelect.items
                                                                "вибрати фільтр"
                                                                (LeSelect.defaultOptions ps.isDarkMode)
                                                        )
                                                    ]
                                                , div []
                                                    [ case model.filterSelect.selected of
                                                        Just filterId ->
                                                            div []
                                                                [ button
                                                                    [ class "btn btn-outline-danger btn-sm"
                                                                    , type_ "button"
                                                                    , onClick <| FiltersMsg (DeleteFilter filterId)
                                                                    , attribute "data-bs-toggle" "modal"
                                                                    , attribute "data-bs-target" "#deleteConfirmationModal"
                                                                    ]
                                                                    [ i [ class "bi bi-trash" ]
                                                                        []
                                                                    ]
                                                                ]

                                                        Nothing ->
                                                            text ""
                                                    ]
                                                ]
                                            ]
                                        ]

                                additionalSettingsBlock =
                                    let
                                        highlightToggle =
                                            Toggle.new
                                                { onToggle = FiltersMsg ToggleHighlightSignals
                                                , label = "підсвічувати сигнали"
                                                , id = "highlight-signals-" ++ model.id
                                                }

                                        onlyMyUnitTagsToggle =
                                            Toggle.new
                                                { onToggle = FiltersMsg ToggleOnlyMyUnitTags
                                                , label = "лише теги мого підрозділу"
                                                , id = "only-my-unit-tags-" ++ model.id
                                                }
                                    in
                                    div
                                        [ class "mt-3" ]
                                        [ p [ class "fw-bold" ] [ text "додатково" ]
                                        , div [ style "padding-left" "110px", class "mt-2 flex flex-col gap-2" ]
                                            [ Toggle.view model.highlightSignalsEnabled highlightToggle
                                            , Toggle.view model.onlyMyUnitTagsEnabled onlyMyUnitTagsToggle
                                            ]
                                        ]
                            in
                            [ div [ style "margin-bottom" "12px" ]
                                [ p [ class "fw-bold" ] [ text "відправник" ]
                                , div [ class "flex justify-center items-center mt-1 ps-2 text-start" ]
                                    [ div
                                        [ class "me-2 text-nowrap text-end"
                                        , style "min-width" "100px"
                                        ]
                                        [ text "лише " ]
                                    , div
                                        [ style "width" "100%"
                                        , style "font-size" ".8rem"
                                        ]
                                      <|
                                        [ Html.map (FiltersMsg << SelectSendersMsg)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectVirtual
                                                    selectUsersSelectedItems
                                                    model.sendersSelect.state
                                                    model.sendersSelect.items
                                                    "всі"
                                                    { loading = False, disabled = False, isDark = ps.isDarkMode }
                                            )
                                        ]
                                    ]
                                , div [ class "flex justify-center items-center mt-1 ps-2 text-start mb-2" ]
                                    [ div
                                        [ class "me-2 text-nowrap text-end"
                                        , style "min-width" "100px"
                                        ]
                                        [ text "окрім " ]
                                    , div
                                        [ style "width" "100%"
                                        , style "font-size" ".8rem"
                                        ]
                                      <|
                                        [ Html.map (FiltersMsg << DenySendersMsg)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectVirtual
                                                    deniedSendersSelectedItems
                                                    model.sendersDeniedSelect.state
                                                    model.sendersDeniedSelect.items
                                                    "ніхто"
                                                    { loading = False, disabled = False, isDark = ps.isDarkMode }
                                            )
                                        ]
                                    ]
                                ]
                            , div [ style "margin-bottom" "12px" ]
                                [ div [ class "relative", style "height" "32px" ]
                                    [ span [ class "fw-bold" ] [ text "частота" ]
                                    , button
                                        [ class "btn btn-sm btn-outline-secondary ms-2 position-absolute end-0 top-0"
                                        , type_ "button"
                                        , onClick <| ReloadLatestFrequencies
                                        ]
                                        [ i [ class "bi bi-arrow-clockwise" ]
                                            []
                                        ]
                                    ]
                                , div [ class "d-flex justify-content-center align-items-center mt-1 ps-2 text-start" ]
                                    [ div
                                        [ class "me-2 text-nowrap text-end"
                                        , style "min-width" "100px"
                                        ]
                                        [ text "лише " ]
                                    , div
                                        [ style "width" "100%"
                                        , style "font-size" ".8rem"
                                        ]
                                      <|
                                        [ Html.map (FiltersMsg << SelectFreqsMsg)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectVirtual
                                                    selectFreqsSelectedItems
                                                    model.freqsSelect.state
                                                    model.freqsSelect.items
                                                    "всі"
                                                    { loading = False, disabled = False, isDark = ps.isDarkMode }
                                            )
                                        ]
                                    ]
                                , div [ class "d-flex justify-content-center align-items-center mt-1 ps-2 text-start" ]
                                    [ div
                                        [ class "me-2 text-nowrap text-end mb-2"
                                        , style "min-width" "100px"
                                        ]
                                        [ text "окрім " ]
                                    , div
                                        [ style "width" "100%"
                                        , style "font-size" ".8rem"
                                        ]
                                      <|
                                        [ Html.map (FiltersMsg << DenyFreqsMsg)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectVirtual
                                                    deniedFreqsSelectedItems
                                                    model.freqsDeniedSelect.state
                                                    model.freqsDeniedSelect.items
                                                    "ніяка"
                                                    { loading = False, disabled = False, isDark = ps.isDarkMode }
                                            )
                                        ]
                                    ]
                                , div [ style "display" "flex", style "margin-top" "6px", style "justify-content" "space-between", style "gap" "4px" ]
                                    [ div [ style "margin-left" "117px", style "align-self" "center", style "font-size" "14px" ]
                                        [ let
                                            adjacentFreqs =
                                                model.filterDeniedAdjacentFreqs ++ model.filterSelectedAdjacentFreqs |> Set.fromList |> Set.toList

                                            tooltipBody =
                                                div [ style "display" "flex", style "gap" "8px", style "max-width" "400px", style "flex-wrap" "wrap" ]
                                                    (if List.length adjacentFreqs > 0 then
                                                        List.map (\f -> span [ style "display" "block" ] [ text f ]) adjacentFreqs

                                                     else
                                                        [ text "відсутні" ]
                                                    )
                                          in
                                          span []
                                            [ Tooltip.new "автоматично додавати частоти в діапазоні:"
                                                |> Tooltip.view tooltipBody
                                            ]
                                        ]
                                    , div [ style "flex-grow" "1" ]
                                        [ let
                                            selItem =
                                                Just
                                                    (Select.basicMenuItem
                                                        { item = model.adjacentFreqsRangeSelect.selected
                                                        , label = String.fromFloat (model.adjacentFreqsRangeSelect.selected * 1000) ++ " кГц"
                                                        }
                                                    )

                                            options =
                                                LeSelect.defaultOptions ps.isDarkMode

                                            options2 =
                                                { options | clearable = False }
                                          in
                                          Html.map (FiltersMsg << SelectFilterFreqsRange)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectSingle
                                                    selItem
                                                    model.adjacentFreqsRangeSelect.state
                                                    model.adjacentFreqsRangeSelect.items
                                                    "не обрано"
                                                    options2
                                            )
                                        ]
                                    ]
                                ]
                            , div [ style "margin-bottom" "12px" ]
                                [ div [ class "position-relative", style "height" "32px" ]
                                    [ span [ class "fw-bold" ] [ text "пост" ]
                                    ]
                                , div [ class "d-flex justify-content-center align-items-center mt-1 ps-2 text-start" ]
                                    [ div
                                        [ class "me-2 text-nowrap text-end"
                                        , style "min-width" "100px"
                                        ]
                                        [ text "лише " ]
                                    , div
                                        [ style "width" "100%"
                                        , style "font-size" ".8rem"
                                        ]
                                      <|
                                        [ Html.map (FiltersMsg << SelectPostsMsg)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectVirtual
                                                    selectPostsSelectedItems
                                                    model.postsSelect.state
                                                    model.postsSelect.items
                                                    "всі"
                                                    { loading = False, disabled = False, isDark = ps.isDarkMode }
                                            )
                                        ]
                                    ]
                                , div [ class "d-flex justify-content-center align-items-center mt-1 ps-2 text-start" ]
                                    [ div
                                        [ class "me-2 text-nowrap text-end mb-2"
                                        , style "min-width" "100px"
                                        ]
                                        [ text "окрім " ]
                                    , div
                                        [ style "width" "100%"
                                        , style "font-size" ".8rem"
                                        ]
                                      <|
                                        [ Html.map (FiltersMsg << DenyPostsMsg)
                                            (Styled.toUnstyled <|
                                                LeSelect.renderSelectVirtual
                                                    deniedPostsSelectedItems
                                                    model.postsDeniedSelect.state
                                                    model.postsDeniedSelect.items
                                                    "ніяка"
                                                    { loading = False, disabled = False, isDark = ps.isDarkMode }
                                            )
                                        ]
                                    ]
                                ]
                            , savedFiltersBlock
                            , additionalSettingsBlock
                            ]

                        else
                            []
                       )
    in
    div
        [ class "relative max-w-[800px] flex flex-col"
        ]
        [ deleteFilterModal
        , deleteMessageModal
        , div
            [ class "flex justify-center items-start w-full app-shell-fill-max-height overflow-auto bg-column"
            , id <| waterfallControlPanelId model.id
            , classList [ ( "border", model.unfoldSettings ), ( "pos-abs", model.unfoldSettings ) ]
            ]
            [ div
                [ class "w-100 m-2 text-center ps-2"
                ]
                [ settingsPanelBlock
                ]
            , div [ class "flex flex-col justify-center items-center mt-1 relative" ] <|
                (div [ class "me-2 absolute -left-5 top-[50%] w-[18px]" ]
                    [ if model.loadingInboxMessages && (model.notLoadedYetMessagesCounter > 0 || model.unreadMessagesLeft) then
                        Shared.Components.Spinner.loadingSpinnerSm

                      else
                        text ""
                    ]
                    :: (if model.unfoldSettings then
                            [ div
                                [ style "font-size" "1.4rem"
                                , style "cursor" "pointer"
                                , class "me-2"
                                , onClick (FiltersMsg ToggleUnfoldSettings)
                                , title "закрити налаштування"
                                ]
                                [ i [ class "bi bi-x" ] [] ]
                            ]

                        else
                            [ div
                                [ style "font-size" "1.4rem"
                                , style "cursor" "pointer"
                                , class "me-2"
                                , onClick CloseWaterfall
                                , title "закрити колонку"
                                ]
                                [ i [ class "bi bi-x" ] [] ]
                            ]
                       )
                )
            ]
        , HtmlX.viewIf model.unfoldSettings <| div [ class "h-[48px]" ] []
        , waterfallDiv ps.user ps.isDarkMode ps.duplicates ps.datasources ps.serverInfo ps.masterUnits model shared
        ]
