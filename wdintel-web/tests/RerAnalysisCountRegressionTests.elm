module RerAnalysisCountRegressionTests exposing (suite)

import Bindings as B
import Dict
import Expect
import Http
import Pages.RerAnalysis as RerAnalysis
import Pages_.RerAnalysis.Model exposing (StatsCountField(..))
import Pages_.RerAnalysis.Msg exposing (Msg(..))
import Pages_.RerAnalysis.Query as Query
import Route
import Shared
import Test exposing (Test, describe, test)
import Time
import Url
import Utils.RemoteData exposing (RemoteData(..))


user : B.User
user =
    { id = "test"
    , name = "operator"
    , roles = [ "Rer" ]
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


withContext testFn =
    case Url.fromString "http://localhost/rer-analysis" of
        Nothing ->
            Expect.fail "invalid test URL"

        Just url ->
            let
                route =
                    Route.fromUrl () url

                ( shared, _ ) =
                    Shared.init (Ok { isDark = False, now = 0 }) route

                ( model, _ ) =
                    RerAnalysis.init user route ()
            in
            testFn shared route model


withDateRange since till model =
    let
        from =
            model.from

        to =
            model.to
    in
    { model
        | from = { from | datePosix = Just (Time.millisToPosix since) }
        , to = { to | datePosix = Just (Time.millisToPosix till) }
    }


suite : Test
suite =
    describe "RerAnalysis count regressions"
        [ test "#3001 ignores a prior generation even when request values match" <|
            \_ ->
                withContext <|
                    \shared route initial ->
                        let
                            dated =
                                withDateRange 0 1000 initial

                            req =
                                Query.analysisStatsParams (Time.millisToPosix 0) (Time.millisToPosix 1000) dated

                            model =
                                { dated | statsCountGeneration = 2, statsCountRemaining = 1 }

                            ( stale, _ ) =
                                RerAnalysis.update user shared route (GotStatsCount 1 req GroupsCountField (Ok 41)) model

                            ( current, _ ) =
                                RerAnalysis.update user shared route (GotStatsCount 2 req GroupsCountField (Ok 42)) stale
                        in
                        Expect.all
                            [ \_ -> Expect.equal NotAsked stale.counts
                            , \_ -> Expect.equal 1 stale.statsCountRemaining
                            , \_ ->
                                case current.counts of
                                    Success counts ->
                                        Expect.equal 42 counts.groupsCount

                                    _ ->
                                        Expect.fail "current generation count was not applied"
                            ]
                            ()
        , test "#3001 ignores a matching generation from another request scope" <|
            \_ ->
                withContext <|
                    \shared route initial ->
                        let
                            prior =
                                withDateRange 0 1000 initial

                            req =
                                Query.analysisStatsParams (Time.millisToPosix 0) (Time.millisToPosix 1000) prior

                            current =
                                withDateRange 2000 3000 initial

                            model =
                                { current
                                    | statsCountGeneration = 1
                                    , statsCountRemaining = 1
                                }

                            ( stale, _ ) =
                                RerAnalysis.update user shared route (GotStatsCount 1 req GroupsCountField (Ok 42)) model
                        in
                        Expect.all
                            [ \_ -> Expect.equal NotAsked stale.counts
                            , \_ -> Expect.equal 1 stale.statsCountRemaining
                            ]
                            ()
        , test "#3001 finishes a fully failed count generation" <|
            \_ ->
                withContext <|
                    \shared route initial ->
                        let
                            dated =
                                withDateRange 0 1000 initial

                            req =
                                Query.analysisStatsParams (Time.millisToPosix 0) (Time.millisToPosix 1000) dated

                            error =
                                { httpError = Http.NetworkError
                                , formErrors = Dict.empty
                                , errors = [ "failure" ]
                                }

                            model =
                                { dated
                                    | counts = Loading
                                    , statsCountGeneration = 1
                                    , statsCountRemaining = 2
                                }

                            ( firstFailure, _ ) =
                                RerAnalysis.update user shared route (GotStatsCount 1 req GroupsCountField (Err error)) model

                            ( finalFailure, _ ) =
                                RerAnalysis.update user shared route (GotStatsCount 1 req SendersCountField (Err error)) firstFailure
                        in
                        Expect.all
                            [ \_ -> Expect.equal 1 firstFailure.statsCountRemaining
                            , \_ -> Expect.notEqual Nothing firstFailure.statsCountError
                            , \_ -> Expect.equal 0 finalFailure.statsCountRemaining
                            , \_ ->
                                case finalFailure.counts of
                                    Failure _ ->
                                        Expect.pass

                                    _ ->
                                        Expect.fail "failed generation remained loading"
                            ]
                            ()
        , test "#3001 queues canonical unit-match counts with bounded concurrency" <|
            \_ ->
                withContext <|
                    \shared route initial ->
                        let
                            dated =
                                withDateRange 0 1000 initial

                            ( withoutUnits, _ ) =
                                RerAnalysis.update user shared route Refresh dated

                            ( withCanonicalUnit, _ ) =
                                RerAnalysis.update user shared route Refresh { dated | unitsSelected = [ "unit-id:17" ] }
                        in
                        Expect.all
                            [ \_ -> Expect.equal 11 withoutUnits.statsCountRemaining
                            , \_ -> Expect.equal 12 withCanonicalUnit.statsCountRemaining
                            , \_ -> Expect.equal 8 (List.length withCanonicalUnit.statsCountPending)
                            ]
                            ()
        ]
