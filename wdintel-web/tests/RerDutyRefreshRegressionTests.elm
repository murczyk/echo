module RerDutyRefreshRegressionTests exposing (suite)

import Bindings as B
import Dict
import Expect
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
        ]


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
