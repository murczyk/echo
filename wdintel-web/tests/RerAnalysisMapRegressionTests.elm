module RerAnalysisMapRegressionTests exposing (suite)

import Expect
import Pages_.RerAnalysis.Query exposing (normalizeUnitNameFromMap, normalizeUnitSelections)
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "RerAnalysis map unit normalization"
        [ test "normalizes legacy map labels to the empty unit value" <|
            \_ ->
                Expect.equal "" (normalizeUnitNameFromMap "Не визначено")
        , test "normalizes, trims, and deduplicates unit selections" <|
            \_ ->
                Expect.equal
                    [ "", "Unit A" ]
                    (normalizeUnitSelections [ "Не визначено", "  ", "Unit A", "Unit A", "" ])
        ]
