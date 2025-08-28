module Tests exposing (..)

import CoordinatesTests
import Le.Block.UnitTests
import Le.Callsign.HintStrategyTests
import Le.Callsign.TabDelimitedParserTests
import Test exposing (..)
import UnitHierarchyTests


suite : Test
suite =
    describe "All Tests"
        [ Le.Block.UnitTests.suite
        , Le.Callsign.HintStrategyTests.suite
        , Le.Callsign.TabDelimitedParserTests.suite
        , UnitHierarchyTests.suite
        , CoordinatesTests.suite
        ]
