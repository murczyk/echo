module Core.Callsign exposing (extractCallsignsInfo)

import Bindings as B
import Dict
import Set
import String


extractCallsignsInfo : List ( a, { b | callsigns : List String } ) -> Dict.Dict String (List B.CallsignInfo) -> List String
extractCallsignsInfo messages existingCallsignsInfo =
    let
        existingCallsignsLower =
            existingCallsignsInfo
                |> Dict.keys
                |> List.map String.toLower
                |> Set.fromList

        messageCallsignsLower =
            messages
                |> List.concatMap (\( _, message ) -> message.callsigns)
                |> List.map String.toLower
                |> Set.fromList
    in
    Set.diff messageCallsignsLower existingCallsignsLower
        |> Set.toList
