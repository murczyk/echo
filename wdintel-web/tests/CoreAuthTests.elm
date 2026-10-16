module CoreAuthTests exposing (suite)

import Bindings exposing (User)
import Core.Auth
import Core.RadioFeatures
import Expect
import Json.Decode
import Json.Encode
import Test exposing (Test, describe, test)


user : List String -> User
user roles =
    { id = "test"
    , name = "test"
    , roles = roles
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


suite : Test
suite =
    describe "account authorization and compatibility"
        [ test "#3575 accepts a user response without a display name" <|
            \_ ->
                Bindings.userEncoder (user [ "Rer" ])
                    |> Json.Decode.decodeValue (Json.Decode.keyValuePairs Json.Decode.value)
                    |> Result.map (List.filter (\( key, _ ) -> key /= "display_name") >> Json.Encode.object)
                    |> Result.andThen (Json.Decode.decodeValue Bindings.userDecoder)
                    |> Result.map .displayName
                    |> Expect.equal (Ok Nothing)
        , test "admits Cyber and Admin, but not unrelated roles" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Cyber" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Admin" ]))
                    , \_ -> Expect.equal False (Core.Auth.canReadDevices (user [ "Basic" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Cyber", "Rer" ]))
                    ]
                    ()
        , test "#3568 radio access respects Rer inheritance independently of Cyber and editors" <|
            \_ ->
                [ ( [ "Cyber" ], False )
                , ( [ "Cyber", "UnitsEditor", "NetworkEditor", "CallsignsEditor" ], False )
                , ( [ "Rer" ], True )
                , ( [ "Rer", "Cyber" ], True )
                , ( [ "Admin" ], True )
                , ( [ "Full", "Cyber" ], True )
                ]
                    |> List.map (\( roles, expected ) -> Core.Auth.canUseRadioFeatures (user roles) == expected)
                    |> List.all identity
                    |> Expect.equal True
        , test "#3568 admits Rer or Cyber while keeping roles distinct" <|
            \_ ->
                Expect.all
                    [ \_ ->
                        [ [ "Rer" ], [ "Cyber" ], [ "Rer", "Cyber" ], [ "Admin" ], [ "Full" ] ]
                            |> List.all (user >> Core.Auth.hasRerOrCyber)
                            |> Expect.equal True
                    , \_ ->
                        [ [], [ "Basic" ], [ "Api" ], [ "ApiAgent" ] ]
                            |> List.any (user >> Core.Auth.hasRerOrCyber)
                            |> Expect.equal False
                    , \_ -> Expect.equal True (Core.Auth.hasRole "Basic" (user [ "Cyber" ]))
                    , \_ -> Expect.equal False (Core.Auth.hasRole "Rer" (user [ "Cyber" ]))
                    , \_ -> Expect.equal False (Core.Auth.hasRole "Cyber" (user [ "Rer" ]))
                    ]
                    ()
        , test "#3568 removes hidden network filters without Rer access" <|
            \_ ->
                let
                    normalized =
                        Core.RadioFeatures.analysisFilters False
                            { selectedFreqs = Just [ "123.4" ]
                            , selectedNetworks = Just [ 7 ]
                            , selectedPosts = Just [ "post" ]
                            , includePelengLocations = Just True
                            , metadataCc = Just [ "cc" ]
                            , metadataSender = Just [ "sender" ]
                            , metadataReceiver = Just [ "receiver" ]
                            , metadataHash = Just [ "hash" ]
                            , onlyWithMetadata = Just True
                            , withoutNetwork = Just True
                            , withoutMetadata = Just True
                            }
                in
                Expect.all
                    [ \_ -> Expect.equal Nothing normalized.selectedNetworks
                    , \_ -> Expect.equal (Just False) normalized.withoutNetwork
                    ]
                    ()
        , test "Cyber can write messages without radio access" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.canWriteMessages (user [ "Cyber" ]))
                    , \_ -> Expect.equal False (Core.Auth.canUseRadioFeatures (user [ "Cyber" ]))
                    ]
                    ()
        , test "removed roles grant no application access" <|
            \_ ->
                [ [ "DeviceSource" ] ]
                    |> List.map user
                    |> List.any
                        (\account ->
                            Core.Auth.hasRole "Basic" account
                                || Core.Auth.hasRerOrCyber account
                                || Core.Auth.canReadDevices account
                                || Core.Auth.canWriteMessages account
                                || Core.Auth.canUseRadioFeatures account
                                || Core.Auth.hasRole "DeviceSource" account
                                || Core.Auth.hasRole "CyberViewer" account
                        )
                    |> Expect.equal False
        , test "restricted viewers retain shared access without devices or message writes" <|
            \_ ->
                let
                    restricted =
                        user [ "CyberViewerRestricted" ]
                in
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.hasRole "Basic" restricted)
                    , \_ -> Expect.equal True (Core.Auth.hasRerOrCyber restricted)
                    , \_ -> Expect.equal False (Core.Auth.canReadDevices restricted)
                    , \_ -> Expect.equal False (Core.Auth.canWriteMessages restricted)
                    , \_ -> Expect.equal False (Core.Auth.canUseRadioFeatures restricted)
                    , \_ ->
                        [ "Rer", "Full", "CyberViewer", "Cyber", "Admin" ]
                            |> List.all
                                (\role ->
                                    Core.Auth.canReadDevices (user [ "CyberViewerRestricted", role ])
                                        == Core.Auth.canReadDevices (user [ role ])
                                )
                            |> Expect.equal True
                    ]
                    ()
        , test "#3569 CyberViewer can read without message writes or radio access" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.hasRole "Basic" (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal True (Core.Auth.hasRerOrCyber (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal True (Core.Auth.hasRole "CyberViewer" (user [ "Cyber" ]))
                    , \_ -> Expect.equal False (Core.Auth.hasRole "Cyber" (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal False (Core.Auth.canWriteMessages (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal False (Core.Auth.canUseRadioFeatures (user [ "CyberViewer" ]))
                    , \_ ->
                        [ "Cyber", "Rer", "Full", "Admin" ]
                            |> List.all (\role -> Core.Auth.canWriteMessages (user [ "CyberViewer", role ]))
                            |> Expect.equal True
                    ]
                    ()
        ]
