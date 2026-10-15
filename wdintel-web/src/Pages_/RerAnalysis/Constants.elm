module Pages_.RerAnalysis.Constants exposing (analysisSearchModes, correlatedFreqsLimit, mouseReportMessageLimitErrorCode, mouseReportMessageLimitMessage, reportPermissionDeniedErrorCode, reportPermissionDeniedMessage, reportTemplateToString)

import Bindings as B
import Pages_.RerAnalysis.Model exposing (..)


analysisSearchModes : List ( B.AnalysisSearchMode, String )
analysisSearchModes =
    [ ( B.Fuzzy, "Гнучкий пошук" )
    , ( B.Exact, "Точний збіг" )
    , ( B.Substring, "Збіг за входженням" )
    ]


correlatedFreqsLimit : number
correlatedFreqsLimit =
    20


mouseReportMessageLimitErrorCode : String
mouseReportMessageLimitErrorCode =
    "mouse_report_message_limit"


mouseReportMessageLimitMessage : String
mouseReportMessageLimitMessage =
    "Звіт містить понад 10 000 повідомлень. Зменшіть період або звузьте фільтри."


reportPermissionDeniedErrorCode : String
reportPermissionDeniedErrorCode =
    "8125378"


reportPermissionDeniedMessage : String
reportPermissionDeniedMessage =
    "У вас недостатньо прав для конструювання даного звіту, зверніться до адміністратора."


reportTemplateToString : ReportTemplate -> String
reportTemplateToString x =
    case x of
        RTTags ->
            "tags"

        RTMouse ->
            "mouse"

        RTPelengs ->
            "pelengs"

        RTBabak ->
            "babak"

        RTInterception ->
            "interception"

        RTPostsDocx ->
            "posts_docx"

        RTSenders y ->
            if y == Senders then
                "senders"

            else
                "posts"

        RTNaUshnom ->
            "naushnom"

        RTReo ->
            "reo"

        RTDigest ->
            "digest"

        RTRerReport ->
            "rer_report"

        RTSposob ->
            "sposob"

        ActiveNetworks ->
            "active_networks"

        RTNetworkFrequencies ->
            "network_frequencies"

        RTSummaryTable ->
            "summary_table"

        RTReport125 ->
            "report_125"

        RTReport1213 ->
            "report_1213"
