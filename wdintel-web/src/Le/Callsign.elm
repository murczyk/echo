module Le.Callsign exposing (extractCallsignsInfo, filterNetworksByFreq, getAllUnitsIdsForNetworks, getNetworkUnits2, getUnitsInfoByIds, prioritizeCallsigns, prioritizeCallsignsForNetwork)

import Bindings as B
import Dict
import Le.Block.Unit as Unit
import Set


extractCallsignsInfo : List ( a, { b | callsigns : List String } ) -> Dict.Dict String (List B.CallsignInfo) -> List String
extractCallsignsInfo messages existingCallsignsInfo =
    let
        diff new old =
            Set.diff old new
    in
    messages
        |> List.concatMap (\( _, message ) -> message.callsigns)
        |> Set.fromList
        |> diff (Set.fromList (Dict.keys existingCallsignsInfo))
        |> Set.toList


findCallsignUnit : List { a | unitId : Maybe Int } -> List B.Unit -> List B.Unit
findCallsignUnit callsigns units =
    let
        unitIds =
            callsigns |> List.filterMap .unitId
    in
    units
        |> List.filter
            (\unit ->
                List.member unit.id unitIds
            )


prioritizeCallsignsConnectedToNetworkUnitsRegiment : List B.Unit -> List B.Unit -> List B.CallsignInfo -> ( List B.CallsignInfo, List B.CallsignInfo )
prioritizeCallsignsConnectedToNetworkUnitsRegiment units networkUnits callsigns =
    let
        callsignsUnits =
            findCallsignUnit callsigns units

        unitsWithSameRegiment =
            callsignsUnits |> List.filter (\callsignUnit -> networkUnits |> List.any (Unit.sameRegiment callsignUnit))

        isPrioritized : List B.Unit -> B.CallsignInfo -> Bool
        isPrioritized u callsign =
            List.any (\unit -> unit.id == Maybe.withDefault -1 callsign.unitId) u
    in
    callsigns |> List.partition (isPrioritized unitsWithSameRegiment)


filterNetworksByFreq : Dict.Dict Int B.Network -> Maybe String -> List B.Network
filterNetworksByFreq networks mFreq =
    networks
        |> Dict.values
        |> List.filterMap
            (\network ->
                case mFreq of
                    Just freq ->
                        if List.member freq network.freqs then
                            Just network

                        else
                            Nothing

                    _ ->
                        Nothing
            )


getAllUnitsIdsForNetworks : List B.Network -> List Int
getAllUnitsIdsForNetworks networks =
    List.concatMap (\network -> network.unitIds) networks


getUnitsInfoByIds : List Int -> Dict.Dict Int B.Unit -> List B.Unit
getUnitsInfoByIds unitIds masterUnits =
    List.filterMap (\id_ -> Dict.get id_ masterUnits) unitIds


getNetworkUnits2 : B.Network -> Dict.Dict Int B.Unit -> List B.Unit
getNetworkUnits2 network masterUnits =
    network.unitIds
        |> List.filterMap (\id_ -> Dict.get id_ masterUnits)


prioritizeCallsigns : Dict.Dict Int B.Unit -> List B.Unit -> Dict.Dict String (List B.CallsignInfo) -> String -> ( List B.CallsignInfo, List B.CallsignInfo )
prioritizeCallsigns masterUnits networkUnits callsignsInfo callsign =
    case Dict.get (String.toLower callsign) callsignsInfo of
        Just callsignInfo ->
            if List.length callsignInfo == 0 then
                ( [], [] )

            else
                let
                    masterUnitsList =
                        masterUnits |> Dict.values
                in
                prioritizeCallsignsConnectedToNetworkUnitsRegiment masterUnitsList networkUnits callsignInfo

        _ ->
            ( [], [] )


prioritizeCallsignsForNetwork : Dict.Dict Int B.Unit -> B.Network -> Dict.Dict String (Maybe (List B.CallsignInfo)) -> String -> ( List B.CallsignInfo, List B.CallsignInfo )
prioritizeCallsignsForNetwork masterUnits network gdocCallsigns callsign =
    case Dict.get (String.toLower callsign) gdocCallsigns of
        Just (Just callsignInfos) ->
            if List.length callsignInfos == 0 then
                ( [], [] )

            else
                let
                    networkUnits =
                        getNetworkUnits2 network masterUnits

                    masterUnitsList =
                        masterUnits |> Dict.values
                in
                prioritizeCallsignsConnectedToNetworkUnitsRegiment masterUnitsList networkUnits callsignInfos

        _ ->
            ( [], [] )
