module CoreAuthTests exposing (suite)

import Bindings exposing (User)
import Core.Auth
import Expect
import Test exposing (Test, describe, test)


user : List String -> User
user roles =
    { id = "test"
    , name = "test"
    , roles = roles
    , sigintZoneId = Nothing
    , organismId = Nothing
    , deltaLogin = Nothing
    , goiConfiguredForOrganism = False
    , goiFullAccessForOrganism = False
    , goiHost = Nothing
    , goiIntegrations = []
    , lastReleaseSeen = Nothing
    }


suite : Test
suite =
    describe "device route authorization"
        [ test "admits Cyber and Admin, but not DeviceSource alone" <|
            \_ ->
                Expect.all
                    [ \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Cyber" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "Admin" ]))
                    , \_ -> Expect.equal False (Core.Auth.canReadDevices (user [ "DeviceSource" ]))
                    , \_ -> Expect.equal True (Core.Auth.canReadDevices (user [ "DeviceSource", "Cyber" ]))
                    ]
                    ()
        ]
