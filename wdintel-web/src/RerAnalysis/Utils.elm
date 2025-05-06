module RerAnalysis.Utils exposing ( updateQueryWithSelectedFreq)

import Bindings as B
import Dict exposing (Dict)
import Json.Decode as Decode
import Json.Encode as Encode
import Maybe
import Route exposing (Route)


updateQueryWithSelectedFreq : String -> Route () -> Route ()
updateQueryWithSelectedFreq freq route =
    let
        ms : Maybe B.RerAnalysisQueryState
        ms =
            Dict.get "state" route.query
                |> Maybe.andThen
                    (Decode.decodeString B.rerAnalysisQueryStateDecoder
                        >> Result.toMaybe
                    )
    in
    case ms of
        Just v ->
            let
                w =
                    { v | freqsSelected = [ freq ] }

                updatedQuery =
                    Dict.insert "state" (Encode.encode 0 <| B.rerAnalysisQueryStateEncoder w) route.query
            in
            { route | query = updatedQuery }

        Nothing ->
            route


