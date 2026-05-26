module Tests exposing (..)

import CoordinatesTests
import Le.Block.UnitTests
import Le.Callsign.HintStrategyTests
import RerAnalysisMapRegressionTests
import RerFreqsUtilsTests
import Test exposing (..)
import UnitHierarchyTests


suite : Test
suite =
    describe "All Tests"
        [ Le.Block.UnitTests.suite
        , Le.Callsign.HintStrategyTests.suite
        , UnitHierarchyTests.suite
        , CoordinatesTests.suite
        , RerFreqsUtilsTests.suite
        , RerAnalysisMapRegressionTests.suite
        ]
