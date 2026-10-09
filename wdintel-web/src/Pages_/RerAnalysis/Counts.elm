module Pages_.RerAnalysis.Counts exposing (get, label)

import Bindings as B
import Pages_.RerAnalysis.Model exposing (Model, StatsCountRequest)
import Utils.RemoteData exposing (RemoteData(..))


get : StatsCountRequest -> (B.CountStatsRsp -> a) -> Model -> Maybe a
get request accessor analysis =
    case analysis.counts of
        Success counts ->
            Just (accessor counts)

        _ ->
            if List.member request analysis.statsCountReady then
                Just (accessor analysis.statsCountPartial)

            else
                Nothing


label : StatsCountRequest -> (B.CountStatsRsp -> Int) -> Model -> String
label request accessor analysis =
    get request accessor analysis
        |> Maybe.map String.fromInt
        |> Maybe.withDefault "—"
