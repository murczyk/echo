module Le.Config exposing (featureEnableTornado, waterfallLoadEarlierThresholdMs, waterfallMessageLimit, adjacentFreqsRangeOptions)

{-| Show tornado on visible messages
-}


featureEnableTornado : Bool
featureEnableTornado =
    False


{-| Only after X allow loading earlier messages
-}
waterfallLoadEarlierThresholdMs : Int
waterfallLoadEarlierThresholdMs =
    5000


waterfallMessageLimit : number
waterfallMessageLimit =
    100


adjacentFreqsRangeOptions : List Float
adjacentFreqsRangeOptions =
    [ 0, 0.0005, 0.002, 0.005 ]

-- Р/О
