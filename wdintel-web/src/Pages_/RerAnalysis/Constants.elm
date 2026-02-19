module Pages_.RerAnalysis.Constants exposing (correlatedFreqsLimit, reportTemplateToString)

import Pages_.RerAnalysis.Model exposing (..)


correlatedFreqsLimit : number
correlatedFreqsLimit =
    20


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
