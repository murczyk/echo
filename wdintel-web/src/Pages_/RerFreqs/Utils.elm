module Pages_.RerFreqs.Utils exposing (clearAltUnitsByFreqOnError, findConnectedNetworks, updateAltUnitsByFreq)

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
                    List.filter (\( id_, unit_ ) -> Unit.isSameOrChildUnit unit unit_) (Dict.toList masterUnits)

                Nothing ->
                    []

        sameRegimentUnitIds =
            sameRegimentUnits |> List.map Tuple.first
    in
    Dict.toList networks
        |> List.map Tuple.second
        |> List.filter (\network -> List.any (\unitId -> List.member unitId sameRegimentUnitIds) (Maybe.withDefault [] network.unitIds))


updateAltUnitsByFreq : Bool -> Api.ListAltUnitsByFreqsRsp -> Api.ListAltUnitsByFreqsRsp -> Api.ListAltUnitsByFreqsRsp
updateAltUnitsByFreq paginating current incoming =
    if paginating then
        Dict.union incoming current

    else
        incoming


clearAltUnitsByFreqOnError : Bool -> Api.ListAltUnitsByFreqsRsp -> Api.ListAltUnitsByFreqsRsp
clearAltUnitsByFreqOnError paginating current =
    if paginating then
        current

    else
        Dict.empty
