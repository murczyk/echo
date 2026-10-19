module RerAnalysisReportRegressionTests exposing (suite)

import Bindings as B
import Expect
import Pages.RerAnalysis as RerAnalysis
import Pages_.RerAnalysis.MainBody as MainBody
import Route
import Shared
import Test exposing (Test, describe, test)
import Test.Html.Query as HtmlQuery
import Test.Html.Selector as Selector
import Url


user : List String -> B.User
user roles =
    { id = "test"
    , name = "operator"
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
    describe "#3827 legacy report 1.2.17 access"
        ([ ( [ "Rer" ], 0 )
         , ( [ "Full" ], 0 )
         , ( [ "Rer", "NetworkEditor" ], 0 )
         , ( [ "Cyber", "AdvancedReports" ], 0 )
         , ( [ "Rer", "UnitsEditor" ], 1 )
         , ( [ "Rer", "CallsignsEditor" ], 1 )
         , ( [ "Rer", "AdvancedReports" ], 1 )
         , ( [ "Admin" ], 1 )
         ]
            |> List.map
                (\( roles, count ) ->
                    test (String.join ", " roles) <|
                        \_ ->
                            case Url.fromString "http://localhost/rer-analysis" of
                                Nothing ->
                                    Expect.fail "invalid test URL"

                                Just url ->
                                    let
                                        account =
                                            user roles

                                        route =
                                            Route.fromUrl () url

                                        ( shared, _ ) =
                                            Shared.init (Ok { isDark = False, now = 0 }) route

                                        ( initial, _ ) =
                                            RerAnalysis.init account route ()
                                    in
                                    MainBody.view account { initial | showReportConstructor = True } shared route
                                        |> HtmlQuery.fromHtml
                                        |> HtmlQuery.findAll [ Selector.tag "h5", Selector.text "Звіт 1.2.17" ]
                                        |> HtmlQuery.count (Expect.equal count)
                )
        )
