module RerDutyRefreshRegressionTests exposing (suite)

import Bindings as B
import Dict
import Expect
import Json.Decode
import Json.Encode
import Le.Waterfall.MessagesTests exposing (messageStub)
import Pages.RerDuty
import Pages_.RerDuty.Waterfall as Waterfall
import Pages_.RerDuty.Waterfall.Messages as Messages
import Route
import Set
import Shared
import String
import Test exposing (Test, describe, test)
import Url


suite : Test
suite =
    describe "Rer Duty refresh regressions"
        [ test "refresh enrichment stays isolated to the owning waterfall" <|
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
                                }

                            ( waterfallA, _ ) =
                                Waterfall.init "wf-a" Nothing

                            ( waterfallB, _ ) =
                                Waterfall.init "wf-b" Nothing

                            messageA =
                                callsignMessage "WOLF"

                            messageB =
                                callsignMessage "FOX"

                            ghost =
                                callsignMessage "GHOST"

                            model =
                                { baseModel
                                    | waterfalls =
                                        [ ( "wf-a"
                                          , { waterfallA
                                                | messages = Messages.fromList [ ( 1, messageStub ) ]
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
                                    anonymousUser
                                    (Pages.RerDuty.InboxMessagesUpdated (Ok { messages = [ ( 1, messageA ), ( 2, messageB ), ( 99, ghost ) ] }))
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
    , goiConfiguredForOrganism = False
    , goiFullAccessForOrganism = False
    , goiHost = Nothing
    , goiIntegrations = []
    , lastReleaseSeen = Nothing
    }
