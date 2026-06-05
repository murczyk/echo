module RerAnalysisMapRegressionTests exposing (suite)

import Bindings as B
import Expect
import Pages.RerAnalysis as RerAnalysis
import Pages_.RerAnalysis.Query as Query
import Pages_.RerAnalysis.Msg exposing (Msg(..))
import Le.Waterfall.MessagesTests exposing (messageStub)
import Route
import Shared
import Test exposing (Test, describe, test)
import Url
import Utils.RemoteData exposing (RemoteData(..))


suite : Test
suite =
    describe "RerAnalysis map regressions"
        [ test "map message serial advances only after a non-empty success" <|
            \_ ->
                case Url.fromString "http://localhost/rer-analysis" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            user =
                                Maybe.withDefault
                                    { name = "anonymous"
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
                                    shared.user

                            ( model, _ ) =
                                RerAnalysis.init route ()

                            ( loadingModel, _ ) =
                                RerAnalysis.update user shared route (LoadMessagesForMap [ 7 ]) model

                            ( successModel, _ ) =
                                RerAnalysis.update
                                    user
                                    shared
                                    route
                                    (GotMessagesForMap 1 (Ok { messages = [ ( 7, messageStub ) ] }))
                                    loadingModel
                        in
                        Expect.all
                            [ \_ -> loadingModel.mapOpenMessagesLoadRequestId |> Expect.equal 1
                            , \_ -> loadingModel.mapOpenMessagesRequestId |> Expect.equal 0
                            , \_ -> successModel.mapOpenMessagesLoadRequestId |> Expect.equal 1
                            , \_ -> successModel.mapOpenMessagesRequestId |> Expect.equal 1
                            , \_ -> successModel.mapOpenMessages |> Expect.equal (Success [ ( 7, messageStub ) ])
                            ]
                            ()
        , test "empty success does not advance the popup serial" <|
            \_ ->
                case Url.fromString "http://localhost/rer-analysis" of
                    Nothing ->
                        Expect.fail "invalid test url"

                    Just url ->
                        let
                            route =
                                Route.fromUrl () url

                            ( shared, _ ) =
                                Shared.init (Ok { isDark = False, now = 0 }) route

                            user =
                                Maybe.withDefault
                                    { name = "anonymous"
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
                                    shared.user

                            ( model, _ ) =
                                RerAnalysis.init route ()

                            ( loadingModel, _ ) =
                                RerAnalysis.update user shared route (LoadMessagesForMap [ 7 ]) model

                            ( emptySuccessModel, _ ) =
                                RerAnalysis.update
                                    user
                                    shared
                                    route
                                    (GotMessagesForMap 1 (Ok { messages = [] }))
                                    loadingModel
                        in
                        Expect.all
                            [ \_ -> emptySuccessModel.mapOpenMessagesLoadRequestId |> Expect.equal 1
                            , \_ -> emptySuccessModel.mapOpenMessagesRequestId |> Expect.equal 0
                            , \_ -> emptySuccessModel.mapOpenMessages |> Expect.equal (Success [])
                            ]
                            ()
        , test "normalizes legacy unit aliases before toggling" <|
            \_ ->
                Expect.equal
                    [ "" ]
                    (Query.normalizeUnitSelections [ "Не визначено", "" ])
        ]
