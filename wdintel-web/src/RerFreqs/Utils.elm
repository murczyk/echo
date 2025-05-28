module RerFreqs.Utils exposing (adjacentRangeToLabel, findConnectedNetworks)

import Bindings as B
import Dict
import Le.Block.Unit as Unit


findConnectedNetworks selectedUnit networks masterUnits =
    let
        mSelUnit =
            --model.networkDialogUnitSelect.selected
            selectedUnit
                |> Maybe.andThen (\unitId -> Dict.get unitId masterUnits)

        sameRegimentUnits =
            case mSelUnit of
                Just unit ->
                    List.filter (\( id_, unit_ ) -> Unit.sameRegiment unit unit_) (Dict.toList masterUnits)

                Nothing ->
                    []

        sameRegimentUnitIds =
            sameRegimentUnits |> List.map Tuple.first
    in
    Dict.toList networks
        |> List.map Tuple.second
        |> List.filter (\network -> List.any (\unitId -> List.member unitId sameRegimentUnitIds) network.unitIds)


adjacentRangeToLabel value =
    case value of
        B.ShortRange ->
            "5 кГц"

        B.LongRange ->
            "7.5 кГц"
