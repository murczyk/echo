module Pages_.RerAnalysis.Constants exposing (correlatedFreqsLimit, reportPermissionDeniedErrorCode, reportPermissionDeniedMessage, reportTemplateToString)

import Pages_.RerAnalysis.Model exposing (..)


correlatedFreqsLimit : number
correlatedFreqsLimit =
    20


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

        ActiveNetworks ->
            "active_networks"

        RTReport1213 ->
            "report_1213"
