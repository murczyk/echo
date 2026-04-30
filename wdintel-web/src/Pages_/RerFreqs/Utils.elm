module Pages_.RerFreqs.Utils exposing (findConnectedNetworks, updateAltUnitsByFreq)

import Api
import Bindings as B
import Core.Unit as Unit
import Dict exposing (Dict)


findConnectedNetworks : Maybe Int -> Dict Int B.Network -> Dict Int B.Unit -> List B.Network
findConnectedNetworks selectedUnit networks masterUnits =
    let
        mSelUnit =
            selectedUnit
                |> Maybe.andThen (\unitId -> Dict.get unitId masterUnits)

        sameRegimentUnits =
            case mSelUnit of
                Just unit ->
                    List.filter (\( _, unit_ ) -> Unit.isSameOrChildUnit unit unit_) (Dict.toList masterUnits)

                Nothing ->
                    []

        sameRegimentUnitIds =
            sameRegimentUnits |> List.map Tuple.first
    in
    Dict.values networks
        |> List.filter (\network -> List.any (\unitId -> List.member unitId sameRegimentUnitIds) (Maybe.withDefault [] network.unitIds))


updateAltUnitsByFreq : Api.ListAltUnitsByFreqsRsp -> Api.ListAltUnitsByFreqsRsp -> Api.ListAltUnitsByFreqsRsp
updateAltUnitsByFreq current incoming =
    Dict.union incoming current
