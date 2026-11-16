module AnalysisDateRangeTests exposing (suite)

import Bindings exposing (User)
import Expect
import Pages.RerAnalysis as RerAnalysis
import Pages_.RerAnalysis.Msg exposing (Msg(..))
import Route
import Shared
import Shared.Components.DateTime as DateTime
import Test exposing (Test, describe, test)
import Time
import Url


user : List String -> User
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
    , administeredOrganismIds = []
    , rerReportEligible = False
    }


defaultRange : Bool -> ( DateTime.Model, DateTime.Model )
defaultRange radioFeaturesAllowed =
    DateTime.initAnalysisRanges
        { from = DateTime.init ()
        , radioFeaturesAllowed = radioFeaturesAllowed
        , to = DateTime.init ()
        , zone = Time.utc
        , now = Time.millisToPosix 1768564800000
        }


rangeStrings :
    ( DateTime.Model, DateTime.Model )
    -> { fromDate : String, fromTime : String, toDate : String, toTime : String }
rangeStrings ( from, to ) =
    { fromDate = from.dateStr
    , fromTime = from.timeStr
    , toDate = to.dateStr
    , toTime = to.timeStr
    }


suite : Test
suite =
    describe "Analysis default date range"
        [ test "Rer starts from today" <|
            \_ ->
                defaultRange True
                    |> rangeStrings
                    |> Expect.equal
                        { fromDate = "2026-01-16"
                        , fromTime = "00:00"
                        , toDate = "2026-01-17"
                        , toTime = "00:00"
                        }
        , test "non-Rer starts from the 90-day boundary" <|
            \_ ->
                defaultRange False
                    |> rangeStrings
                    |> Expect.equal
                        { fromDate = "2025-10-19"
                        , fromTime = "00:00"
                        , toDate = "2026-01-17"
                        , toTime = "00:00"
                        }
        , test "classic Analysis resolves Rer before keeping its default range" <|
            \_ ->
                case Url.fromString "http://localhost/rer-analysis" of
                    Nothing ->
                        Expect.fail "invalid test URL"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            baseUser =
                                user []

                            anonymous =
                                { baseUser | name = "anonymous" }

                            ( initial, _ ) =
                                RerAnalysis.init anonymous route ()

                            ( timed, _ ) =
                                RerAnalysis.update
                                    anonymous
                                    shared
                                    route
                                    (InitGotTime (Time.millisToPosix 1768564800000))
                                    initial

                            ( resolved, _ ) =
                                RerAnalysis.update
                                    anonymous
                                    shared
                                    route
                                    (GotCurrentUser (Ok (user [ "Rer" ])))
                                    timed
                        in
                        Expect.all
                            [ \_ -> Expect.equal True resolved.radioFeaturesAllowed
                            , \_ -> Expect.equal True resolved.currentUserLoaded
                            , \_ -> Expect.equal "2026-01-16" resolved.from.dateStr
                            ]
                            ()
        ]
