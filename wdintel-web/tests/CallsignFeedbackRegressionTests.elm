module CallsignFeedbackRegressionTests exposing (suite)

import Bindings
import Expect
import Json.Decode as Decode
import Test exposing (Test, test)


suite : Test
suite =
    -- Regression for https://github.com/echoua/echo/issues/3167.
    test "Elm submits callsign feedback using the backend field name" <|
        \_ ->
            let
                edit =
                    { messageId = 42
                    , actionId = "6bfb1c2d-4f2e-4db4-98e7-9b759471af55"
                    , added = []
                    , removed = [ "фипка" ]
                    }
            in
            Bindings.inboxSubmitReqEncoder
                { messages = []
                , callsignEdits = Just [ edit ]
                }
                |> Decode.decodeValue
                    (Decode.field "callsignEdits" (Decode.list Bindings.callsignEditDecoder))
                |> Expect.equal (Ok [ edit ])
