module RerFreqs.Utils exposing (findConnectedNetworks)

import Bindings as B
import Dict exposing (Dict)
import Le.Block.Unit as Unit


findConnectedNetworks : Maybe Int -> Dict Int B.Network -> Dict Int B.Unit -> List B.Network
findConnectedNetworks selectedUnit networks masterUnits =
    let
        mSelUnit =
            selectedUnit
                |> Maybe.andThen (\unitId -> Dict.get unitId masterUnits)

        sameRegimentUnits =
            case mSelUnit of
                Just unit ->
                    List.filter (\( id_, unit_ ) -> Unit.isSameOrChildUnit unit unit_) (Dict.toList masterUnits)

                Nothing ->
                    []

        sameRegimentUnitIds =
            sameRegimentUnits |> List.map Tuple.first
    in
    Dict.toList networks
        |> List.map Tuple.second
        |> List.filter (\network -> List.any (\unitId -> List.member unitId sameRegimentUnitIds) network.unitIds)
