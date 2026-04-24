module RerFreqsUtilsTests exposing (suite)

import Dict
import Expect
import Pages_.RerFreqs.Utils as Utils
import Test exposing (..)


suite : Test
suite =
    describe "Pages_.RerFreqs.Utils.updateAltUnitsByFreq"
        [ test "replaces data on non-paginated reload" <|
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
                    (Utils.updateAltUnitsByFreq False current incoming)
                    incoming
        , test "merges data on pagination and prefers incoming values on collisions" <|
            \_ ->
                let
                    current =
                        Dict.fromList
                            [ ( "150.3150"
                              , [ { freq = "150.3150", unit = "old", count = 10 } ]
                              )
                            , ( "154.8450"
                              , [ { freq = "154.8450", unit = "keep", count = 3 } ]
                              )
                            ]

                    incoming =
                        Dict.fromList
                            [ ( "150.3150"
                              , [ { freq = "150.3150", unit = "new", count = 1 } ]
                              )
                            , ( "147.4750"
                              , [ { freq = "147.4750", unit = "added", count = 2 } ]
                              )
                            ]
                in
                Expect.equal
                    (Utils.updateAltUnitsByFreq True current incoming)
                    (Dict.fromList
                        [ ( "150.3150"
                          , [ { freq = "150.3150", unit = "new", count = 1 } ]
                          )
                        , ( "154.8450"
                          , [ { freq = "154.8450", unit = "keep", count = 3 } ]
                          )
                        , ( "147.4750"
                          , [ { freq = "147.4750", unit = "added", count = 2 } ]
                          )
                        ]
                    )
        , test "clears data on non-paginated alt-units error" <|
            \_ ->
                let
                    current =
                        Dict.fromList
                            [ ( "150.3150"
                              , [ { freq = "150.3150", unit = "stale", count = 10 } ]
                              )
                            ]
                in
                Expect.equal
                    (Utils.clearAltUnitsByFreqOnError False current)
                    Dict.empty
        , test "keeps data on paginated alt-units error" <|
            \_ ->
                let
                    current =
                        Dict.fromList
                            [ ( "150.3150"
                              , [ { freq = "150.3150", unit = "existing", count = 10 } ]
                              )
                            ]
                in
                Expect.equal
                    (Utils.clearAltUnitsByFreqOnError True current)
                    current
        ]
