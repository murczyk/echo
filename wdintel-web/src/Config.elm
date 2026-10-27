module Config exposing
    ( adjacentFreqsRangeOptions
    , analysisHourAfterWhichWeTakeADayTomorrow
    , analysisSearchDocUrl
    , babakNewCallsignMinMentionsDefault
    , eventServicePollTracker
    , eventServicePollingMinIntervalMs
    , eventServiceGenericFullIntervalMs
    , sharedLookupReconciliationIntervalMs
    , featureAudioTranscriptionBesidePlayer
    , featureDisableRerDutyDedup
    , featureEnableTornado
    , featureHideDocuments
    , featureShowCallsignsMetadata
    , rerUnitsPollingMinIntervalMs
    , thresholdStopCountingDays
    , waterfallLoadEarlierThresholdMs
    , waterfallMessageLimit
    , waterfallNetworkRetryDelayMs
    , waterfallPollingMinIntervalMs
    )

{-| Show tornado on visible messages
-}


featureEnableTornado : Bool
featureEnableTornado =
    False


eventServicePollTracker : String
eventServicePollTracker =
    "shared-event-stream"


eventServicePollingMinIntervalMs : Float
eventServicePollingMinIntervalMs =
    2000


eventServiceGenericFullIntervalMs : Int
eventServiceGenericFullIntervalMs =
    10000


sharedLookupReconciliationIntervalMs : Float
sharedLookupReconciliationIntervalMs =
    60000


rerUnitsPollingMinIntervalMs : Float
rerUnitsPollingMinIntervalMs =
    5000


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


babakNewCallsignMinMentionsDefault : Int
babakNewCallsignMinMentionsDefault =
    3


{-| Only after X allow loading earlier messages
-}
waterfallLoadEarlierThresholdMs : Int
waterfallLoadEarlierThresholdMs =
    5000


waterfallMessageLimit : number
waterfallMessageLimit =
    100


waterfallNetworkRetryDelayMs : Float
waterfallNetworkRetryDelayMs =
    5000


waterfallPollingMinIntervalMs : Float
waterfallPollingMinIntervalMs =
    5000


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


analysisSearchDocUrl : String
analysisSearchDocUrl =
    "/docs/analysis-search/"
