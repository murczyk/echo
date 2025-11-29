port module PagePorts.RerAnalysisPorts exposing (rer_analysis_saveQueryState)

import Json.Encode as Encode


port rer_analysis_saveQueryState : Encode.Value -> Cmd msg
