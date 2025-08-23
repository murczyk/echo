module Le.Callsign.HintStrategy exposing (HintStrategy, HintResult, determineHintStrategy)

import Bindings as B
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


{-| Визначає стратегію підказок на основі повідомлення та контексту
-}
determineHintStrategy : 
    { message | freq : Maybe String, networkIds : Maybe (List Int) }
    -> { context | networks : Dict Int B.Network, masterUnits : Dict Int B.Unit }
    -> HintStrategy
determineHintStrategy message context =
    let
        -- Спочатку перевіряємо чи є мережа за частотою
        networksByFreq = filterNetworksByFreq context.networks message.freq
        
        -- Якщо є мережа за частотою - використовуємо її
        hasNetworksByFreq = not (List.isEmpty networksByFreq)
    in
    if hasNetworksByFreq then
        let
            networkUnits = getUnitsInfoByIds (getAllUnitsIdsForNetworks networksByFreq) context.masterUnits
        in
        NetworkBased 
            { networks = networksByFreq
            , units = networkUnits
            }
    
    -- Якщо немає мережі за частотою, але є networkIds - використовуємо їх
    else if Maybe.withDefault False (Maybe.map (not << List.isEmpty) message.networkIds) then
        let
            networkUnits = getUnitsInfoByIds (Maybe.withDefault [] message.networkIds) context.masterUnits
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
