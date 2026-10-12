module RerDutyRefreshRegressionTests exposing (suite)

import Bindings as B
import Dict
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
                                , eventLastId = Nothing
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
                        , ( "selected_unit_ids", Json.Encode.list Json.Encode.int [ 7 ] )
                        , ( "denied_unit_ids", Json.Encode.null )
                        , ( "selected_device_names", Json.Encode.list Json.Encode.string [ "DEVICE-A" ] )
                        , ( "denied_device_names", Json.Encode.null )
                        , ( "units_exact_match_only", Json.Encode.bool True )
                        ] of
                    Ok filter ->
                        Expect.all
                            [ \_ -> Expect.equal Nothing filter.unitsSelected
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
