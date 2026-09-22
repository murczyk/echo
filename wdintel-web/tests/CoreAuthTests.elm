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
        ]
