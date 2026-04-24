module RerFreqsUtilsTests exposing (suite)

import Dict
import Expect
import Pages_.RerFreqs.Utils as Utils
import Test exposing (..)


suite : Test
suite =
    describe "Pages_.RerFreqs.Utils.updateAltUnitsByFreq"
        [ test "merges incoming data with current data" <|
            \_ ->
                let
                    current =
                        Dict.fromList
                            [ ( "150.3150"
                              , [ { freq = "150.3150", unit = "stale-unit", count = 10 } ]
                              )
                            , ( "154.8450"
                              , [ { freq = "154.8450", unit = "to-drop", count = 3 } ]
                              )
                            ]

                    incoming =
                        Dict.fromList
                            [ ( "150.3150"
                              , [ { freq = "150.3150", unit = "fresh-unit", count = 1 } ]
                              )
                            ]
                in
                Expect.equal
                    (Utils.updateAltUnitsByFreq current incoming)
                    (Dict.fromList
                        [ ( "150.3150"
                          , [ { freq = "150.3150", unit = "fresh-unit", count = 1 } ]
                          )
                        , ( "154.8450"
                          , [ { freq = "154.8450", unit = "to-drop", count = 3 } ]
                          )
                        ]
                    )
        ]
