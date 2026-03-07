module Core.Callsigns.HintStrategy exposing (HintContext(..), HintResult, HintStrategy(..), determineHintStrategyForCallsign, getCallsignHints, getCallsignsForStrategy, getIconClass, isCallsignRelatedToNetworks)

import Bindings as B
import Core.Unit as Unit
import Dict exposing (Dict)
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


{-| Отримує мережі за списком ID з Dict
-}
getNetworksByIds : List Int -> Dict Int B.Network -> List B.Network
getNetworksByIds ids networksDict =
    ids |> List.filterMap (\id -> Dict.get id networksDict)


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


{-| Контекст використання підказок
-}
type HintContext
    = MessageContext -- Для повідомлень: мережа → тільки мережеві підказки
    | FrequencyContext -- Для частот: мережа → мережеві + каталогові підказки


{-| Стратегія для показу підказок позивних
-}
type HintStrategy
    = NetworkBased
        { networks : List B.Network
        , units : List B.Unit
        }
    | SystemWide
    | NoHints


{-| Результат аналізу підказок для позивного
-}
type alias HintResult =
    { strategy : HintStrategy
    , prioritizedCallsigns : List B.CallsignInfo
    , iconClass : String
    }


{-| Отримує підказки позивного для конкретної стратегії
-}
getCallsignsForStrategy :
    HintStrategy
    -> Maybe (List Int)
    -> Dict Int B.Unit
    -> Dict String (List B.CallsignInfo)
    -> String
    -> List B.CallsignInfo
getCallsignsForStrategy strategy maybeMessageNetworkIds masterUnits callsignsInfo callsign =
    case Dict.get (String.toLower callsign) callsignsInfo of
        Just callsignInfo ->
            if List.length callsignInfo == 0 then
                []

            else
                case strategy of
                    NetworkBased { units } ->
                        case maybeMessageNetworkIds of
                            Just networkIds ->
                                if List.isEmpty networkIds then
                                    filterCallsignsByNetworkUnits callsignInfo masterUnits units

                                else
                                    callsignInfo
                                        |> List.filter
                                            (\info ->
                                                info.networkIdsReportedIn
                                                    |> List.any (\networkId -> List.member networkId networkIds)
                                            )

                            Nothing ->
                                filterCallsignsByNetworkUnits callsignInfo masterUnits units

                    SystemWide ->
                        -- Для SystemWide просто повертаємо позивні для конкретного запиту
                        callsignInfo

                    NoHints ->
                        []

        _ ->
            []


{-| Фільтрує позивні по зв'язку з мережевими юнітами
-}
filterCallsignsByNetworkUnits : List B.CallsignInfo -> Dict Int B.Unit -> List B.Unit -> List B.CallsignInfo
filterCallsignsByNetworkUnits callsigns masterUnits networkUnits =
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


{-| Перевіряє чи є позивний пов'язаний з мережевими юнітами
-}
isCallsignRelatedToNetworks : Maybe (List B.CallsignInfo) -> List B.Network -> Dict Int B.Unit -> Bool
isCallsignRelatedToNetworks maybeCallsignInfo networks masterUnits =
    case maybeCallsignInfo of
        Nothing ->
            False

        Just callsignInfoList ->
            if List.isEmpty callsignInfoList then
                False

            else
                let
                    -- Отримуємо всі юніти з мереж
                    networkUnitIds =
                        getAllUnitsIdsForNetworks networks

                    networkUnits =
                        getUnitsInfoByIds networkUnitIds masterUnits

                    -- Знаходимо юніти для цього позивного
                    callsignUnits =
                        findCallsignUnit callsignInfoList (Dict.values masterUnits)

                    -- Перевіряємо чи є хоча б один юніт позивного пов'язаний з мережевими юнітами
                    isRelated =
                        callsignUnits
                            |> List.any
                                (\callsignUnit ->
                                    networkUnits
                                        |> List.any (Unit.isSameOrChildUnit callsignUnit)
                                )
                in
                isRelated


hasCallsignInMessageNetworks : Maybe (List B.CallsignInfo) -> List Int -> Bool
hasCallsignInMessageNetworks maybeCallsignInfo messageNetworkIds =
    case maybeCallsignInfo of
        Nothing ->
            False

        Just callsignInfoList ->
            callsignInfoList
                |> List.any
                    (\callsignInfo ->
                        callsignInfo.networkIdsReportedIn
                            |> List.any (\networkId -> List.member networkId messageNetworkIds)
                    )


{-| Отримує клас іконки для стратегії
-}
getIconClass : HintStrategy -> String
getIconClass strategy =
    case strategy of
        NetworkBased _ ->
            "bi-info-circle-fill"

        SystemWide ->
            "bi-info-circle"

        NoHints ->
            ""


{-| Головна функція для отримання підказок позивного з урахуванням контексту
Об'єднує визначення стратегії та її застосування
-}
getCallsignHints :
    HintContext
    -> { message | freq : Maybe String, networkIds : Maybe (List Int) }
    -> { context | networks : Dict Int B.Network, masterUnits : Dict Int B.Unit, callsignsInfo : Dict String (List B.CallsignInfo) }
    -> String
    -> HintResult
getCallsignHints hintContext message context callsign =
    let
        -- Отримуємо інформацію про цей конкретний позивний
        callsignInfo =
            Dict.get (String.toLower callsign) context.callsignsInfo

        -- Знаходимо мережі за частотою
        networksByFreq =
            filterNetworksByFreq context.networks message.freq

        -- Персонально визначаємо стратегію для цього позивного з урахуванням контексту
        strategy =
            determineHintStrategyForCallsign hintContext message context callsignInfo networksByFreq

        messageNetworkIdsForPriority =
            case message.networkIds of
                Just networkIds ->
                    if List.isEmpty networkIds then
                        Nothing

                    else
                        Just networkIds

                Nothing ->
                    Nothing

        prioritizedCallsigns =
            getCallsignsForStrategy strategy messageNetworkIdsForPriority context.masterUnits context.callsignsInfo callsign
    in
    { strategy = strategy
    , prioritizedCallsigns = prioritizedCallsigns
    , iconClass = getIconClass strategy
    }


{-| Персонально визначає стратегію підказок для конкретного позивного з урахуванням контексту
-}
determineHintStrategyForCallsign :
    HintContext
    -> { message | freq : Maybe String, networkIds : Maybe (List Int) }
    -> { context | networks : Dict Int B.Network, masterUnits : Dict Int B.Unit }
    -> Maybe (List B.CallsignInfo)
    -> List B.Network
    -> HintStrategy
determineHintStrategyForCallsign hintContext message context callsignInfo networksByFreq =
    let
        hasNetworksByFreq =
            not (List.isEmpty networksByFreq)

        hasCatalogMatch =
            case callsignInfo of
                Just callsignInfoList ->
                    not (List.isEmpty callsignInfoList)

                Nothing ->
                    False

        messageNetworkIds =
            case message.networkIds of
                Just networkIds ->
                    if List.isEmpty networkIds then
                        Nothing

                    else
                        Just networkIds

                Nothing ->
                    Nothing
    in
    case hintContext of
        MessageContext ->
            case messageNetworkIds of
                Just networkIds ->
                    if hasCallsignInMessageNetworks callsignInfo networkIds then
                        let
                            networksFromMessage =
                                getNetworksByIds networkIds context.networks

                            networkUnits =
                                getUnitsInfoByIds (getAllUnitsIdsForNetworks networksFromMessage) context.masterUnits
                        in
                        NetworkBased
                            { networks = networksFromMessage
                            , units = networkUnits
                            }

                    else if hasCatalogMatch then
                        SystemWide

                    else
                        NoHints

                Nothing ->
                    if hasCatalogMatch then
                        SystemWide

                    else
                        NoHints

        FrequencyContext ->
            -- Пріоритет 1: спочатку мережі з message.networkIds
            if Maybe.withDefault False (Maybe.map (not << List.isEmpty) message.networkIds) then
                let
                    networksFromMessage =
                        getNetworksByIds (Maybe.withDefault [] message.networkIds) context.networks
                    networkUnits =
                        getUnitsInfoByIds (getAllUnitsIdsForNetworks networksFromMessage) context.masterUnits
                in
                NetworkBased
                    { networks = networksFromMessage
                    , units = networkUnits
                    }

                -- Пріоритет 2: мережі за частотою
            else if hasNetworksByFreq then
                let
                    -- Персонально перевіряємо чи цей позивний пов'язаний з мережевими юнітами
                    isRelated =
                        isCallsignRelatedToNetworks callsignInfo networksByFreq context.masterUnits
                in
                if isRelated then
                    let
                        networkUnits =
                            getUnitsInfoByIds (getAllUnitsIdsForNetworks networksByFreq) context.masterUnits
                    in
                    NetworkBased
                        { networks = networksByFreq
                        , units = networkUnits
                        }

                else
                    SystemWide

            else
                SystemWide
