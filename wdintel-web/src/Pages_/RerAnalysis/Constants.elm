module Pages_.RerAnalysis.Constants exposing (correlatedFreqsLimit, navbarHeightPx, reportTemplateToString)

import Pages_.RerAnalysis.Model exposing (..)


correlatedFreqsLimit : number
correlatedFreqsLimit =
    20


{-| Used in css calc
-}
navbarHeightPx : number
navbarHeightPx =
    50


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
