module UserSettingsRegressionTests exposing (suite)

import Bindings
import Expect
import Json.Decode as Decode
import Json.Encode as Encode
import Test exposing (Test, describe, test)


suite : Test
suite =
    describe "User settings compatibility"
        [ test "#3324 classic analysis preserves transcription preferences from older settings responses" <|
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
        , test "#3927 quick actions use the same wire values as the API" <|
            \_ ->
                let
                    cases =
                        [ ( "createReport", Bindings.QuickActionCreateReport )
                        , ( "reply", Bindings.QuickActionReply )
                        , ( "important", Bindings.QuickActionImportant )
                        , ( "bookmark", Bindings.QuickActionBookmark )
                        , ( "copyText", Bindings.QuickActionCopyText )
                        , ( "copyLink", Bindings.QuickActionCopyLink )
                        , ( "edit", Bindings.QuickActionEdit )
                        , ( "delete", Bindings.QuickActionDelete )
                        ]

                    json wire =
                        Encode.encode 0 (Encode.string wire)
                in
                cases
                    |> List.map
                        (\( wire, action ) ->
                            ( Decode.decodeString Bindings.messageCardQuickActionDecoder (json wire)
                            , Encode.encode 0 (Bindings.messageCardQuickActionEncoder action)
                            )
                        )
                    |> Expect.equal (List.map (\( wire, action ) -> ( Ok action, json wire )) cases)
        ]
