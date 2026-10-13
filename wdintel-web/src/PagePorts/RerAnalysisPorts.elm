port module PagePorts.RerAnalysisPorts exposing (rer_analysis_inboxChanged, rer_analysis_saveQueryState)

import Json.Encode as Encode


port rer_analysis_saveQueryState : Encode.Value -> Cmd msg


port rer_analysis_inboxChanged : (List Int -> msg) -> Sub msg
