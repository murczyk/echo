module LoginRedirectRegressionTests exposing (tests)

import Expect
import Test exposing (Test, describe, test)
import Url
import Utils.LoginRedirect


tests : Test
tests =
    describe "Issue #3665 legacy login links with default ports"
        ([ ( "https://echo.example/login", "https://echo.example:443" )
         , ( "https://echo.example:443/login", "https://echo.example" )
         , ( "http://echo.example/login", "http://echo.example:80" )
         , ( "http://echo.example:80/login", "http://echo.example" )
         ]
            |> List.map
                (\( current, origin ) ->
                    test (current ++ " restores " ++ origin)
                        (\_ ->
                            Url.fromString current
                                |> Maybe.andThen (\url -> Utils.LoginRedirect.normalize url (origin ++ "/rer-analysis-neo?m=message#card"))
                                |> Expect.equal (Just "/rer-analysis-neo?m=message#card")
                        )
                )
            |> (\validCases ->
                    validCases
                        ++ [ test "a non-default port remains a different origin"
                                (\_ ->
                                    Url.fromString "https://echo.example/login"
                                        |> Maybe.andThen (\url -> Utils.LoginRedirect.normalize url "https://echo.example:8443/rer-analysis-neo?m=message#card")
                                        |> Expect.equal Nothing
                                )
                           ]
               )
        )
