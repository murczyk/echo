module CoreAuthTests exposing (suite)

import Bindings exposing (User)
import Core.Auth
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
        , test "admits Cyber and Admin, but not DeviceSource alone" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Cyber" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Admin" ]))
                    , \_ -> Expect.equal False (Core.Auth.canReadDevices (user [ "DeviceSource" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "DeviceSource", "Cyber" ]))
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
                        [ [], [ "Basic" ], [ "DeviceSource" ], [ "Api" ], [ "ApiAgent" ] ]
                            |> List.any (user >> Core.Auth.hasRerOrCyber)
                            |> Expect.equal False
                    , \_ -> Expect.equal True (Core.Auth.hasRole "Basic" (user [ "Cyber" ]))
                    , \_ -> Expect.equal False (Core.Auth.hasRole "Rer" (user [ "Cyber" ]))
                    , \_ -> Expect.equal False (Core.Auth.hasRole "Cyber" (user [ "Rer" ]))
                    ]
                    ()
        , test "#3569 CyberViewer reads Cyber data with additive message write permissions" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.hasRerOrCyber (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal False (Core.Auth.canUseRadioFeatures (user [ "CyberViewer" ]))
                    , \_ -> Expect.equal False (Core.Auth.canWriteMessages (user [ "CyberViewer" ]))
                    , \_ ->
                        [ "Cyber", "Rer", "Full", "Admin" ]
                            |> List.all (\role -> Core.Auth.canWriteMessages (user [ "CyberViewer", role ]))
                            |> Expect.equal True
                    ]
                    ()
        ]
