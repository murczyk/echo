module Config exposing
    ( adjacentFreqsRangeOptions
    , analysisHourAfterWhichWeTakeADayTomorrow
    , featureAudioTranscriptionBesidePlayer
    , featureDisableRerDutyDedup
    , featureEnableTornado
    , featureHideDocuments
    , featureShowCallsignsMetadata
    , thresholdStopCountingDays
    , waterfallLoadEarlierThresholdMs
    , waterfallMessageLimit
    )

{-| Show tornado on visible messages
-}


featureEnableTornado : Bool
featureEnableTornado =
    False


featureShowCallsignsMetadata : Bool
featureShowCallsignsMetadata =
    False


featureDisableRerDutyDedup : Bool
featureDisableRerDutyDedup =
    True


featureAudioTranscriptionBesidePlayer : Bool
featureAudioTranscriptionBesidePlayer =
    False


featureHideDocuments : Bool
featureHideDocuments =
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


{-| Threshold controlling if we show counters or not
-}
thresholdStopCountingDays : Int
thresholdStopCountingDays =
    15


{-| If it's past this hour -- take one more day
-}
analysisHourAfterWhichWeTakeADayTomorrow : Int
analysisHourAfterWhichWeTakeADayTomorrow =
    19
