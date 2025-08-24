module Le.Callsign.HintStrategy exposing (HintResult, HintStrategy(..), determineHintStrategy, getCallsignHints, getCallsignsForStrategy, getIconClass, getTooltipText)

import Bindings as B
import Dict exposing (Dict)
import Le.Block.Unit as Unit
import List.Extra as ListX


{-| Фільтрує мережі за частотою
-}
filterNetworksByFreq : Dict Int B.Network -> Maybe String -> List B.Network
filterNetworksByFreq networks mFreq =
    networks
        |> Dict.values
        |> List.filterMap
            (\network ->
                case mFreq of
                    Just freq ->
                        case ListX.find (\nFreq -> nFreq.freq == freq) network.freqs of
                            Just a ->
                                Just network

                            Nothing ->
                                Nothing

                    Nothing ->
                        Nothing
            )


{-| Отримує ID всіх юнітів з мереж
-}
getAllUnitsIdsForNetworks : List B.Network -> List Int
getAllUnitsIdsForNetworks networks =
    List.concatMap (\network -> Maybe.withDefault [] network.unitIds) networks


{-| Отримує інформацію про юніти за їх ID
-}
getUnitsInfoByIds : List Int -> Dict Int B.Unit -> List B.Unit
getUnitsInfoByIds unitIds masterUnits =
    List.filterMap (\id_ -> Dict.get id_ masterUnits) unitIds


{-| Стратегія для показу підказок позивних
-}
type HintStrategy
    = NetworkBased
        { networks : List B.Network
        , units : List B.Unit
        }
    | SystemWide
        { units : List B.Unit
        }
    | NoHints


{-| Результат аналізу підказок для позивного
-}
type alias HintResult =
    { strategy : HintStrategy
    , prioritizedCallsigns : List B.CallsignInfo
    , iconClass : String
    , tooltipText : String
    }


{-| Отримує підказки позивного для конкретної стратегії
-}
getCallsignsForStrategy :
    HintStrategy
    -> Dict Int B.Unit
    -> Dict String (List B.CallsignInfo)
    -> String
    -> List B.CallsignInfo
getCallsignsForStrategy strategy masterUnits callsignsInfo callsign =
    case Dict.get (String.toLower callsign) callsignsInfo of
        Just callsignInfo ->
            if List.length callsignInfo == 0 then
                []

            else
                case strategy of
                    NetworkBased { units } ->
                        let
                            allCallsigns =
                                callsignsInfo |> Dict.values |> List.concat
                        in
                        filterCallsignsByNetworkUnits allCallsigns masterUnits units

                    SystemWide { units } ->
                        let
                            allCallsigns =
                                callsignsInfo |> Dict.values |> List.concat
                        in
                        filterCallsignsByNetworkUnits allCallsigns masterUnits units

                    NoHints ->
                        []

        _ ->
            []


{-| Фільтрує позивні по зв'язку з мережевими юнітами
-}
filterCallsignsByNetworkUnits : List B.CallsignInfo -> Dict Int B.Unit -> List B.Unit -> List B.CallsignInfo
filterCallsignsByNetworkUnits callsigns masterUnits networkUnits  =
    let
        callsignsUnits =
            findCallsignUnit callsigns (Dict.values masterUnits)

        unitsWithSameRegiment =
            callsignsUnits |> List.filter (\callsignUnit -> networkUnits |> List.any (Unit.isSameOrChildUnit callsignUnit))

        isPrioritized : List B.Unit -> B.CallsignInfo -> Bool
        isPrioritized u callsign =
            List.any (\unit -> unit.id == Maybe.withDefault -1 callsign.unitId) u
    in
    callsigns |> List.filter (isPrioritized unitsWithSameRegiment)


{-| Знаходить юніти для позивних
-}
findCallsignUnit : List B.CallsignInfo -> List B.Unit -> List B.Unit
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


{-| Отримує клас іконки для стратегії
-}
getIconClass : HintStrategy -> String
getIconClass strategy =
    case strategy of
        NetworkBased _ ->
            "bi-info-circle-fill"

        SystemWide _ ->
            "bi-info-circle"

        NoHints ->
            ""


{-| Отримує текст tooltip для стратегії
-}
getTooltipText : HintStrategy -> String
getTooltipText strategy =
    case strategy of
        NetworkBased _ ->
            "📍 Позивні підрозділів мережі"

        SystemWide _ ->
            "🌐 Позивні з каталогу"

        NoHints ->
            "Немає підказок"


{-| Головна функція для отримання підказок позивного
Об'єднує визначення стратегії та її застосування
-}
getCallsignHints :
    { message | freq : Maybe String, networkIds : Maybe (List Int) }
    -> { context | networks : Dict Int B.Network, masterUnits : Dict Int B.Unit, callsignsInfo : Dict String (List B.CallsignInfo) }
    -> String
    -> HintResult
getCallsignHints message context callsign =
    let
        strategy =
            determineHintStrategy message context

        prioritizedCallsigns =
            getCallsignsForStrategy strategy context.masterUnits context.callsignsInfo callsign
    in
    { strategy = strategy
    , prioritizedCallsigns = prioritizedCallsigns
    , iconClass = getIconClass strategy
    , tooltipText = getTooltipText strategy
    }


{-| Визначає стратегію підказок на основі повідомлення та контексту
-}
determineHintStrategy :
    { message | freq : Maybe String, networkIds : Maybe (List Int) }
    -> { context | networks : Dict Int B.Network, masterUnits : Dict Int B.Unit }
    -> HintStrategy
determineHintStrategy message context =
    let
        -- Спочатку перевіряємо чи є мережа за частотою
        networksByFreq =
            filterNetworksByFreq context.networks message.freq

        -- Якщо є мережа за частотою - використовуємо її
        hasNetworksByFreq =
            not (List.isEmpty networksByFreq)
    in
    if hasNetworksByFreq then
        let
            networkUnits =
                getUnitsInfoByIds (getAllUnitsIdsForNetworks networksByFreq) context.masterUnits
        in
        NetworkBased
            { networks = networksByFreq
            , units = networkUnits
            }
        -- Якщо немає мережі за частотою, але є networkIds - використовуємо їх

    else if Maybe.withDefault False (Maybe.map (not << List.isEmpty) message.networkIds) then
        let
            networkUnits =
                getUnitsInfoByIds (Maybe.withDefault [] message.networkIds) context.masterUnits
        in
        NetworkBased
            { networks = []
            , units = networkUnits
            }
        -- Інакше показуємо підказки по всій системі

    else
        SystemWide
            { units = Dict.values context.masterUnits
            }
