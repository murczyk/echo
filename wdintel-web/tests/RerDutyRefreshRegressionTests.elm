module RerDutyRefreshRegressionTests exposing (suite)

import Bindings as B
import Dict
import Effect as E
import Expect
import Http
import Json.Decode
import Json.Encode
import Le.Waterfall.MessagesTests exposing (messageStub)
import Page
import Pages.RerDuty
import Pages_.RerDuty.Waterfall as Waterfall
import Pages_.RerDuty.Waterfall.Message as WaterfallMessage
import Pages_.RerDuty.Waterfall.Messages as Messages
import Route
import Set
import Shared
import Shared.Msg as SharedMsg
import Shared.Model exposing (RerNetworkDetailsPreferredView(..))
import String
import Test exposing (Test, describe, test)
import Test.Html.Query as HtmlQuery
import Test.Html.Selector as Selector
import Time
import Url
import Utils.RemoteData exposing (RemoteData(..))


suite : Test
suite =
    describe "Rer Duty refresh regressions"
        [ test "#3598 hidden network fallback ignores a missing frequency" <|
            \_ ->
                let
                    viewParams message =
                        { isDarkMode = False
                        , user = { anonymousUser | roles = [ "Rer" ] }
                        , waterfallId = "wf-a"
                        , datasources = []
                        , serverInfo = Nothing
                        , networks = Dict.empty
                        , zone = Time.utc
                        , time = Nothing
                        , profiles = Dict.empty
                        , message = ( 1, message )
                        , tags = []
                        , callsignsInfo = Dict.empty
                        , messageCallsignsInfo = Dict.empty
                        , masterUnits = Dict.empty
                        , networkDetailsViewPreference = Classic
                        , signals = []
                        , copied = Nothing
                        , isMsgVisible = []
                        , groupInfos = Dict.empty
                        , messageNetworkIds = [ 7 ]
                        , hideNetworks = True
                        , onlyMyUnitTagsEnabled = False
                        }

                    check message expected =
                        WaterfallMessage.view (viewParams message) ( 1, message ) (WaterfallMessage.init { id = 1 })
                            |> HtmlQuery.fromHtml
                            |> HtmlQuery.has [ Selector.text expected ]
                in
                Expect.all
                    [ \_ -> check { messageStub | freq = Nothing, unit = Just "Analysis Unit" } "Analysis Unit"
                    , \_ -> check { messageStub | freq = Nothing, unit = Nothing } "Не встановлена"
                    ]
                    ()
        , test "#3598 unresolved settings defer network hydration" <|
            \_ ->
                case Url.fromString "http://localhost/rer-duty" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            ( waterfall, _ ) =
                                Waterfall.init True "wf-a" Nothing

                            ( updatedWaterfall, _ ) =
                                Waterfall.update
                                    shared
                                    anonymousUser
                                    (Waterfall.TickTimeTick (Time.millisToPosix 0))
                                    { waterfall
                                        | messages =
                                            Messages.fromList
                                                [ ( 1, { messageStub | networkIds = Just [ 7 ] } ) ]
                                    }
                        in
                        Expect.equal Set.empty updatedWaterfall.networkIdsRequested
        , test "#3598 failed initial settings allow deferred network hydration" <|
            \_ ->
                case Url.fromString "http://localhost/rer-duty" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            ( settingsFailed, _ ) =
                                Shared.update route
                                    (SharedMsg.GotSystemSettings (Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }))
                                    shared

                            ( waterfall, _ ) =
                                Waterfall.init True "wf-a" Nothing

                            ( updatedWaterfall, _ ) =
                                Waterfall.update
                                    settingsFailed
                                    anonymousUser
                                    (Waterfall.TickTimeTick (Time.millisToPosix 0))
                                    { waterfall
                                        | messages =
                                            Messages.fromList
                                                [ ( 1, { messageStub | networkIds = Just [ 7 ] } ) ]
                                    }
                        in
                        Expect.all
                            [ \_ -> Expect.equal True settingsFailed.systemSettingsLoaded
                            , \_ -> Expect.equal (Set.singleton 7) updatedWaterfall.networkIdsRequested
                            ]
                            ()
        , test "#3598 network hydration retries temporary failures once and exhausts omitted responses" <|
            \_ ->
                case Url.fromString "http://localhost/rer-duty" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) (Route.fromUrl () url)

                            ( waterfall, _ ) =
                                Waterfall.init True "wf-a" Nothing

                            ( failed, _ ) =
                                Waterfall.update shared anonymousUser
                                    (Waterfall.GotNetworksInfo [ 7 ] (Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }))
                                    { waterfall | networkIdsRequested = Set.fromList [ 7, 8 ] }

                            ( ticked, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.TickTimeTick (Time.millisToPosix 1000)) failed

                            ( completed, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.GotNetworksInfo [ 8 ] (Ok [])) ticked

                            ( retried, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.RetryNetworks [ 7 ]) completed

                            ( exhausted, _ ) =
                                Waterfall.update shared anonymousUser
                                    (Waterfall.GotNetworksInfo [ 7 ] (Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }))
                                    retried

                            ( tickedExhausted, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.TickTimeTick (Time.millisToPosix 2000))
                                    { exhausted
                                        | messages =
                                            Messages.fromList
                                                [ ( 1, { messageStub | networkIds = Just [ 7, 8 ] } ) ]
                                    }
                        in
                        Expect.all
                            [ \_ -> Expect.equal (Set.singleton 8) failed.networkIdsRequested
                            , \_ -> Expect.equal (Set.singleton 7) failed.networkIdsWaitingForRetry
                            , \_ -> Expect.equal Set.empty failed.networkIdsRetryExhausted
                            , \_ -> Expect.equal failed.networkIdsWaitingForRetry ticked.networkIdsWaitingForRetry
                            , \_ -> Expect.equal Set.empty completed.networkIdsRequested
                            , \_ -> Expect.equal (Set.singleton 7) completed.networkIdsWaitingForRetry
                            , \_ -> Expect.equal (Set.singleton 8) completed.networkIdsRetryExhausted
                            , \_ -> Expect.equal Set.empty retried.networkIdsWaitingForRetry
                            , \_ -> Expect.equal (Set.fromList [ 7, 8 ]) retried.networkIdsRetryExhausted
                            , \_ -> Expect.equal Set.empty retried.networkIdsRequested
                            , \_ -> Expect.equal (Set.fromList [ 7, 8 ]) exhausted.networkIdsRetryExhausted
                            , \_ -> Expect.equal Set.empty tickedExhausted.networkIdsRequested
                            ]
                            ()
        , test "#3598 permanent network hydration failures are immediately exhausted" <|
            \_ ->
                case Url.fromString "http://localhost/rer-duty" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) (Route.fromUrl () url)

                            ( waterfall, _ ) =
                                Waterfall.init True "wf-a" Nothing

                            ( failed, _ ) =
                                Waterfall.update shared anonymousUser
                                    (Waterfall.GotNetworksInfo [ 7 ] (Err { httpError = Http.BadStatus 403, formErrors = Dict.empty, errors = [] }))
                                    { waterfall | networkIdsRequested = Set.singleton 7 }

                            ( ticked, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.TickTimeTick (Time.millisToPosix 1000))
                                    { failed
                                        | messages =
                                            Messages.fromList
                                                [ ( 1, { messageStub | networkIds = Just [ 7 ] } ) ]
                                    }
                        in
                        Expect.all
                            [ \_ -> Expect.equal Set.empty failed.networkIdsRequested
                            , \_ -> Expect.equal Set.empty failed.networkIdsWaitingForRetry
                            , \_ -> Expect.equal (Set.singleton 7) failed.networkIdsRetryExhausted
                            , \_ -> Expect.equal Set.empty ticked.networkIdsRequested
                            ]
                            ()
        , test "#3780 fast count responses do not allow early automatic polls" <|
            \_ ->
                withPollingWaterfall <|
                    \shared waterfall ->
                        let
                            ( started, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 5000)) waterfall

                            ( settled, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.GotInboxMessagesDigest (Ok { quantity = 0, firstElementTs = Nothing })) started

                            ( early, earlyEffect ) =
                                Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 9999)) settled

                            ( due, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 10000)) early
                        in
                        Expect.all
                            [ \_ -> Expect.equal True started.loadingInboxDigest
                            , \_ -> Expect.equal False early.loadingInboxDigest
                            , \_ -> Expect.equal E.none earlyEffect
                            , \_ -> Expect.equal (Just (Time.millisToPosix 5000)) early.lastInboxPollStartedAt
                            , \_ -> Expect.equal True due.loadingInboxDigest
                            , \_ -> Expect.equal (Just (Time.millisToPosix 10000)) due.lastInboxPollStartedAt
                            ]
                            ()
        , test "#3780 active count and message requests prevent overlapping automatic polls" <|
            \_ ->
                withPollingWaterfall <|
                    \shared waterfall ->
                        let
                            check active =
                                let
                                    ( blocked, effect ) =
                                        Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 5000)) active
                                in
                                Expect.all
                                    [ \_ -> Expect.equal Nothing blocked.lastInboxPollStartedAt
                                    , \_ -> Expect.equal E.none effect
                                    ]
                                    ()
                        in
                        Expect.all
                            [ \_ -> check { waterfall | loadingInboxDigest = True }
                            , \_ -> check { waterfall | loadingInboxMessages = True }
                            ]
                            ()
        , describe "#3780 blocked automatic polls resume after request completion"
            (let
                inboxResponse =
                    Ok { inboxItems = [ ( 1, messageStub ) ], historySinceMs = Nothing, historyPeriodMs = Nothing, pollCursorId = Nothing, callsigns = [], signalProfiles = Dict.empty, signalGroups = [], freqPelengsSummary = Nothing, pageLimit = Just 20 }

                failure =
                    Err { httpError = Http.Timeout, formErrors = Dict.empty, errors = [] }

                loadingMessages waterfall =
                    { waterfall | loadingInboxMessages = True }

                loadingDigest waterfall =
                    { waterfall | loadingInboxDigest = True }
             in
             [ pendingInboxPollTest "initial messages succeed" loadingMessages (Waterfall.GotInitialInbox False inboxResponse)
             , pendingInboxPollTest "initial messages fail" loadingMessages (Waterfall.GotInitialInbox False failure)
             , pendingInboxPollTest "earlier messages succeed" loadingMessages (Waterfall.GotInboxEarlier inboxResponse)
             , pendingInboxPollTest "earlier messages fail" loadingMessages (Waterfall.GotInboxEarlier failure)
             , pendingInboxPollTest "newer messages succeed" loadingMessages
                (Waterfall.InboxLoopGotMessages False
                    (Ok { inboxItems = [], historySinceMs = Nothing, historyPeriodMs = Nothing, pollCursorId = Nothing, callsigns = [], signalProfiles = Dict.empty, signalGroups = [], freqPelengsSummary = Nothing, pageLimit = Just 20 })
                )
             , pendingInboxPollTest "newer messages fail" loadingMessages (Waterfall.InboxLoopGotMessages False failure)
             , pendingInboxPollTest "digest succeeds" loadingDigest (Waterfall.GotInboxMessagesDigest (Ok { quantity = 0, firstElementTs = Nothing }))
             , pendingInboxPollTest "digest fails" loadingDigest (Waterfall.GotInboxMessagesDigest failure)
             ]
            )
        , test "#3780 pending polls wait for both message and digest requests" <|
            \_ ->
                withPollingWaterfall <|
                    \shared waterfall ->
                        let
                            ( blocked, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 5000))
                                    { waterfall | loadingInboxMessages = True, loadingInboxDigest = True }

                            ( partiallySettled, effect ) =
                                Waterfall.update shared anonymousUser (Waterfall.GotInboxMessagesDigest (Ok { quantity = 0, firstElementTs = Nothing })) blocked
                        in
                        Expect.all
                            [ \_ -> Expect.equal True partiallySettled.inboxPollPending
                            , \_ -> Expect.equal True partiallySettled.loadingInboxMessages
                            , \_ -> Expect.equal E.none effect
                            ]
                            ()
        , test "#3780 buffered messages finish rendering before pending polls resume" <|
            \_ ->
                withPollingWaterfall <|
                    \shared waterfall ->
                        let
                            ( blocked, _ ) =
                                Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 5000))
                                    { waterfall | loadingInboxMessages = True }

                            ( buffered, _ ) =
                                Waterfall.update shared anonymousUser
                                    (Waterfall.InboxLoopGotMessages False
                                        (Ok { inboxItems = [ ( 2, messageStub ) ], historySinceMs = Nothing, historyPeriodMs = Nothing, pollCursorId = Nothing, callsigns = [], signalProfiles = Dict.empty, signalGroups = [], freqPelengsSummary = Nothing, pageLimit = Just 20 })
                                    )
                                    blocked

                            ( rendered, effect ) =
                                Waterfall.update shared anonymousUser
                                    (Waterfall.GetVisibleMsgIdsRes { waterfallId = waterfall.id, msgIds = [ 1 ], firstVisibleHeight = 0 })
                                    buffered
                        in
                        Expect.all
                            [ \_ -> Expect.equal True buffered.inboxPollPending
                            , \_ -> Expect.equal True buffered.loadingInboxMessages
                            , \_ -> expectInboxPollRetry shared rendered effect
                            ]
                            ()
        , test "#3780 scroll-to-latest keeps the previous automatic poll boundary" <|
            \_ ->
                withPollingWaterfall <|
                    \shared waterfall ->
                        let
                            ( reloading, _ ) =
                                Waterfall.update shared anonymousUser Waterfall.ScrollToLatestElement
                                    { waterfall | lastInboxPollStartedAt = Just (Time.millisToPosix 5000) }
                        in
                        Expect.all
                            [ \_ -> Expect.equal True reloading.loadingInboxMessages
                            , \_ -> Expect.equal (Just (Time.millisToPosix 5000)) reloading.lastInboxPollStartedAt
                            ]
                            ()
        , test "#3780 refreshes buffered messages and keeps enrichment in the owning waterfall" <|
            \_ ->
                case Url.fromString "http://localhost/rer-duty" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            baseModel : Pages.RerDuty.Model
                            baseModel =
                                { navCollapsed = False
                                , waterfalls = []
                                , duplicates = Set.empty
                                , lastPushQuery = Dict.empty
                                , datasources = []
                                , currentUser = Success anonymousUser
                                }

                            ( waterfallA, _ ) =
                                Waterfall.init True "wf-a" Nothing

                            ( waterfallB, _ ) =
                                Waterfall.init True "wf-b" Nothing

                            messageA =
                                callsignMessage "WOLF"

                            messageB =
                                callsignMessage "FOX"

                            bufferedMessage =
                                callsignMessage "BUFFERED"

                            ghost =
                                callsignMessage "GHOST"

                            model =
                                { baseModel
                                    | waterfalls =
                                        [ ( "wf-a"
                                          , { waterfallA
                                                | messages = Messages.fromList [ ( 1, messageStub ) ]
                                                , notRenderedMessagesYet = [ ( 3, messageStub ) ]
                                                , messageCallsignsRequested = Set.singleton "existing-a"
                                            }
                                          )
                                        , ( "wf-b"
                                          , { waterfallB
                                                | messages = Messages.fromList [ ( 2, messageStub ) ]
                                                , messageCallsignsRequested = Set.singleton "existing-b"
                                            }
                                          )
                                        ]
                                }

                            ( updatedModel, _ ) =
                                Pages.RerDuty.update
                                    shared
                                    route
                                    (Pages.RerDuty.InboxMessagesUpdated (Ok { messages = [ ( 1, messageA ), ( 2, messageB ), ( 3, bufferedMessage ), ( 99, ghost ) ] }))
                                    model

                            waterfallAUpdated =
                                updatedModel.waterfalls
                                    |> List.filter (Tuple.first >> (==) "wf-a")
                                    |> List.head
                                    |> Maybe.map Tuple.second

                            waterfallBUpdated =
                                updatedModel.waterfalls
                                    |> List.filter (Tuple.first >> (==) "wf-b")
                                    |> List.head
                                    |> Maybe.map Tuple.second
                        in
                        case ( waterfallAUpdated, waterfallBUpdated ) of
                            ( Just wfA, Just wfB ) ->
                                Expect.all
                                    [ \_ -> Expect.equal [ "wf-a", "wf-b" ] (List.map Tuple.first updatedModel.waterfalls)
                                    , \_ -> Expect.equal (Just ( 1, messageA )) (Messages.toMessageList wfA.messages |> List.head)
                                    , \_ -> Expect.equal (Just ( 2, messageB )) (Messages.toMessageList wfB.messages |> List.head)
                                    , \_ -> Expect.equal [ ( 3, bufferedMessage ) ] wfA.notRenderedMessagesYet
                                    , \_ -> Expect.equal [] wfB.notRenderedMessagesYet
                                    , \_ -> Expect.equal True (Set.member "buffered" wfA.messageCallsignsRequested)
                                    , \_ -> Expect.equal False (Set.member "buffered" wfB.messageCallsignsRequested)
                                    , \_ -> Expect.equal True (Set.member "wolf" wfA.messageCallsignsRequested)
                                    , \_ -> Expect.equal True (Set.member "existing-a" wfA.messageCallsignsRequested)
                                    , \_ -> Expect.equal False (Set.member "fox" wfA.messageCallsignsRequested)
                                    , \_ -> Expect.equal False (Set.member "ghost" wfA.messageCallsignsRequested)
                                    , \_ -> Expect.equal True (Set.member "fox" wfB.messageCallsignsRequested)
                                    , \_ -> Expect.equal True (Set.member "existing-b" wfB.messageCallsignsRequested)
                                    , \_ -> Expect.equal False (Set.member "wolf" wfB.messageCallsignsRequested)
                                    , \_ -> Expect.equal False (Set.member "ghost" wfB.messageCallsignsRequested)
                                    , \_ -> Expect.equal 2 (List.length updatedModel.waterfalls)
                                    ]
                                    ()

                            _ ->
                                Expect.fail "expected both waterfalls to remain present"
        , test "#3568 saved Duty columns wait for the real user's radio permissions" <|
            \_ ->
                let
                    state =
                        Json.Encode.object
                            [ ( "waterfalls"
                              , Json.Encode.list identity
                                    [ Json.Encode.list identity [ Json.Encode.string "wf-saved", dutyFilter [] ] ]
                              )
                            ]
                            |> Json.Encode.encode 0
                in
                case Url.fromString ("http://localhost/rer-duty?state=" ++ Url.percentEncode state) of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            ( waiting, _ ) =
                                Page.init (Pages.RerDuty.page anonymousUser shared route) ()

                            user =
                                { anonymousUser | name = "operator", roles = [ "Rer" ] }

                            ( ready, _ ) =
                                Pages.RerDuty.update shared route (Pages.RerDuty.GotCurrentUser (Ok user)) waiting
                        in
                        Expect.all
                            [ \_ -> Expect.equal [] waiting.waterfalls
                            , \_ -> Expect.equal route.query waiting.lastPushQuery
                            , \_ ->
                                ready.waterfalls
                                    |> List.map (\( id, waterfall ) -> ( id, waterfall.radioFeaturesAllowed ))
                                    |> Expect.equal [ ( "wf-saved", True ) ]
                            ]
                            ()
        , test "legacy saved Duty filters keep waterfall state when device fields are absent" <|
            \_ ->
                case Json.Decode.decodeValue B.rerDutyQueryStateDecoder legacyDutyState of
                    Ok state ->
                        case state.waterfalls of
                            Just [ ( name, filter ) ] ->
                                Expect.all
                                    [ \_ -> Expect.equal "legacy-waterfall" name
                                    , \_ -> Expect.equal (Just [ "group-a" ]) filter.groupsSelected
                                    , \_ -> Expect.equal Nothing filter.unitsSelected
                                    , \_ -> Expect.equal Nothing filter.unitsDenied
                                    , \_ -> Expect.equal Nothing filter.unitsIncludeChildren
                                    , \_ -> Expect.equal Nothing filter.selectedUnitIds
                                    , \_ -> Expect.equal Nothing filter.deniedUnitIds
                                    , \_ -> Expect.equal Nothing filter.selectedDeviceNames
                                    , \_ -> Expect.equal Nothing filter.deniedDeviceNames
                                    , \_ -> Expect.equal Nothing filter.unitsExactMatchOnly
                                    ]
                                    ()

                            _ ->
                                Expect.fail "expected decoded legacy waterfall"

                    Err error ->
                        Expect.fail (Json.Decode.errorToString error)
        , test "Duty compatibility fields accept null and preserve valid values" <|
            \_ ->
                case Json.Decode.decodeValue B.rerDutyQueryStateWfDecoder <|
                    dutyFilter
                        [ ( "units_selected", Json.Encode.null )
                        , ( "units_denied", Json.Encode.null )
                        , ( "units_include_children", Json.Encode.bool True )
                        , ( "selected_unit_ids", Json.Encode.list Json.Encode.int [ 7 ] )
                        , ( "denied_unit_ids", Json.Encode.null )
                        , ( "selected_device_names", Json.Encode.list Json.Encode.string [ "DEVICE-A" ] )
                        , ( "denied_device_names", Json.Encode.null )
                        , ( "units_exact_match_only", Json.Encode.bool True )
                        ] of
                    Ok filter ->
                        Expect.all
                            [ \_ -> Expect.equal Nothing filter.unitsSelected
                            , \_ -> Expect.equal (Just True) filter.unitsIncludeChildren
                            , \_ -> Expect.equal (Just [ 7 ]) filter.selectedUnitIds
                            , \_ -> Expect.equal (Just [ "DEVICE-A" ]) filter.selectedDeviceNames
                            , \_ -> Expect.equal Nothing filter.deniedDeviceNames
                            , \_ -> Expect.equal (Just True) filter.unitsExactMatchOnly
                            ]
                            ()

                    Err error ->
                        Expect.fail (Json.Decode.errorToString error)
        , test "Duty compatibility fallback does not hide malformed present values" <|
            \_ ->
                case Json.Decode.decodeValue B.rerDutyQueryStateWfDecoder <|
                    dutyFilter [ ( "selected_device_names", Json.Encode.string "not-a-list" ) ] of
                    Ok _ ->
                        Expect.fail "expected malformed device names to fail"

                    Err _ ->
                        Expect.pass
        ]


legacyDutyState : Json.Encode.Value
legacyDutyState =
    Json.Encode.object
        [ ( "waterfalls"
          , Json.Encode.list identity
                [ Json.Encode.list identity
                    [ Json.Encode.string "legacy-waterfall"
                    , dutyFilter []
                    ]
                ]
          )
        ]


dutyFilter : List ( String, Json.Encode.Value ) -> Json.Encode.Value
dutyFilter compatibilityFields =
    Json.Encode.object <|
        [ ( "groups_selected", Json.Encode.list Json.Encode.string [ "group-a" ] )
        , ( "groups_denied", Json.Encode.null )
        , ( "senders_selected", Json.Encode.null )
        , ( "denied_senders", Json.Encode.null )
        , ( "freqs_selected", Json.Encode.null )
        , ( "freqs_denied", Json.Encode.null )
        , ( "posts_selected", Json.Encode.null )
        , ( "posts_denied", Json.Encode.null )
        , ( "last_viewed_message_id", Json.Encode.null )
        , ( "highlight_keywords_enabled", Json.Encode.null )
        , ( "highlight_keyword_set_id", Json.Encode.null )
        ]
            ++ compatibilityFields


withPollingWaterfall : (Shared.Model -> Waterfall.Model -> Expect.Expectation) -> Expect.Expectation
withPollingWaterfall check =
    case Url.fromString "http://localhost/rer-duty" of
        Nothing ->
            Expect.fail "invalid test url"

        Just url ->
            let
                ( shared, _ ) =
                    Shared.init (Ok { isDark = False, now = 0 }) (Route.fromUrl () url)

                ( waterfall, _ ) =
                    Waterfall.init True "wf-polling" Nothing

                ( initialized, _ ) =
                    Waterfall.update shared anonymousUser (Waterfall.InitGotTime (Time.millisToPosix 0)) waterfall

                ( loaded, _ ) =
                    Waterfall.update shared anonymousUser
                        (Waterfall.InboxLoopGotMessages True
                            (Ok { inboxItems = [], historySinceMs = Nothing, historyPeriodMs = Nothing, pollCursorId = Nothing, callsigns = [], signalProfiles = Dict.empty, signalGroups = [], freqPelengsSummary = Nothing, pageLimit = Just 20 })
                        )
                        { initialized
                            | messages = Messages.fromList [ ( 1, messageStub ) ]
                        }
            in
            check shared loaded


pendingInboxPollTest : String -> (Waterfall.Model -> Waterfall.Model) -> Waterfall.Msg -> Test
pendingInboxPollTest name startRequest completion =
    test name <|
        \_ ->
            withPollingWaterfall <|
                \shared waterfall ->
                    let
                        ( early, _ ) =
                            Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 9999))
                                (startRequest { waterfall | lastInboxPollStartedAt = Just (Time.millisToPosix 5000) })

                        ( blocked, _ ) =
                            Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 10000)) early

                        ( settled, effect ) =
                            Waterfall.update shared anonymousUser completion blocked
                    in
                    Expect.all
                        [ \_ -> Expect.equal True early.inboxPollPending
                        , \_ -> Expect.equal True blocked.inboxPollPending
                        , \_ -> expectInboxPollRetry shared settled effect
                        ]
                        ()


expectInboxPollRetry : Shared.Model -> Waterfall.Model -> E.Effect Waterfall.Msg -> Expect.Expectation
expectInboxPollRetry shared waterfall effect =
    let
        now =
            Time.millisToPosix 12500

        ( resumed, _ ) =
            Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer now) waterfall

        ( messagesSettled, _ ) =
            Waterfall.update shared anonymousUser
                (Waterfall.InboxLoopGotMessages False
                    (Ok { inboxItems = [], historySinceMs = Nothing, historyPeriodMs = Nothing, pollCursorId = Nothing, callsigns = [], signalProfiles = Dict.empty, signalGroups = [], freqPelengsSummary = Nothing, pageLimit = Just 20 })
                )
                resumed

        ( settled, _ ) =
            Waterfall.update shared anonymousUser (Waterfall.GotInboxMessagesDigest (Ok { quantity = 0, firstElementTs = Nothing })) messagesSettled

        ( early, earlyEffect ) =
            Waterfall.update shared anonymousUser (Waterfall.InboxLoopLoadNewer (Time.millisToPosix 12501)) settled
    in
    Expect.all
        [ \_ -> Expect.equal True (String.contains "GetCurrentTime" (Debug.toString effect))
        , \_ -> Expect.equal False waterfall.inboxPollPending
        , \_ -> Expect.equal True (resumed.loadingInboxMessages || resumed.loadingInboxDigest)
        , \_ -> Expect.equal (Just now) resumed.lastInboxPollStartedAt
        , \_ -> Expect.equal False early.loadingInboxDigest
        , \_ -> Expect.equal False early.loadingInboxMessages
        , \_ -> Expect.equal E.none earlyEffect
        ]
        ()


callsignMessage : String -> B.InboxMessage
callsignMessage callsign =
    { messageStub
        | textMarked = Just [ B.CnCallsignC { begin = 0, end = String.length callsign, etalon = callsign, text = " " ++ callsign ++ " " } ]
        , callsigns = []
    }


anonymousUser : B.User
anonymousUser =
    { id = ""
    , name = "anonymous"
    , roles = []
    , sigintZoneId = Nothing
    , organismId = Nothing
    , deltaLogin = Nothing
    , displayName = Nothing
    , goiConfiguredForOrganism = False
    , goiFullAccessForOrganism = False
    , goiHost = Nothing
    , goiIntegrations = []
    , lastReleaseSeen = Nothing
    , rerReportEligible = False
    }
