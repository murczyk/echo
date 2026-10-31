module UserSettingsRegressionTests exposing (suite)

import Bindings
import Expect
import Json.Decode as Decode
import Test exposing (Test, test)


suite : Test
suite =
    test "#3324 classic analysis preserves transcription preferences from older settings responses" <|
        \_ ->
            """
            {
                "tagsLayout": "compact",
                "messageTextPreviewLines": "twenty",
                "disableAutoScroll": false,
                "analysisMapInSidebar": false,
                "dutyAudioTranscriptionCollapsed": false,
                "analysisAudioTranscriptionCollapsed": true,
                "showAnalysisCallsignAddForm": false,
                "showClassicDuty": false,
                "showClassicAnalysis": true,
                "dutyCollapseMediaPreviews": false,
                "mediaSummaryEnabled": false,
                "messageSortBy": "interception",
                "messageAutoParseEnabled": false,
                "aiPositionHighlightsEnabled": false
            }
            """
                |> Decode.decodeString Bindings.userDutySettingsDtoDecoder
                |> Result.map (\settings -> ( ( settings.analysisAudioTranscriptionCollapsed, settings.largeMediaPreviews, settings.largeMessageCardText ), settings.messageCardQuickAction ))
                |> Expect.equal (Ok ( ( True, False, False ), Bindings.QuickActionCreateReport ))
