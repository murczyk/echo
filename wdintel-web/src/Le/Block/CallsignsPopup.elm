module Le.Block.CallsignsPopup exposing (..)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (..)
import Le.Block.Callsign
import Le.Block.Popup
import Le.Callsign
import Le.Callsign.HintStrategy as HintStrategy


prioUnitsAccessor : ( List B.CallsignInfo, String ) -> List B.CallsignInfo
prioUnitsAccessor callsignWithPrio =
    callsignWithPrio |> Tuple.first


type alias Params a =
    { a
        | masterUnits : Dict Int B.Unit
        , callsignsInfo : Dict String (List B.CallsignInfo)
        , callsigns : List String
    }


{-| Допоміжна функція для конвертації параметрів у нову систему HintStrategy
-}
createHintContext : Dict Int B.Network -> Params a -> { networks : Dict Int B.Network, masterUnits : Dict Int B.Unit, callsignsInfo : Dict String (List B.CallsignInfo) }
createHintContext networks params =
    { networks = networks
    , masterUnits = params.masterUnits
    , callsignsInfo = params.callsignsInfo
    }


{-| Створює тестове повідомлення для частоти (для використання з HintStrategy)
-}
createMessageForFreq : String -> { freq : Maybe String, networkIds : Maybe (List Int) }
createMessageForFreq freq =
    { freq = Just freq
    , networkIds = Nothing
    }


{-| Отримує підказки для позивного через нову систему HintStrategy
-}
getCallsignHintsNew : String -> Dict Int B.Network -> Params a -> String -> HintStrategy.HintResult
getCallsignHintsNew freq networks params callsign =
    let
        message = createMessageForFreq freq
        context = createHintContext networks params
    in
    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context callsign


sortByPrio callsignWithPrioA callsignWithPrioB =
    let
        lengthA = callsignWithPrioA |> prioUnitsAccessor |> List.length
        lengthB = callsignWithPrioB |> prioUnitsAccessor |> List.length
    in
    if lengthA > lengthB then
        LT
    else if lengthA < lengthB then
        GT
    else
        EQ


sortCallsigns : String -> Dict Int B.Network -> Params a -> List ( List B.CallsignInfo, String )
sortCallsigns freq networksDict params =
    let
        networksWithMessageFreq =
            Le.Callsign.filterNetworksByFreq networksDict (Just freq)

        networksUnitIds =
            Le.Callsign.getAllUnitsIdsForNetworks networksWithMessageFreq

        networkUnits =
            Le.Callsign.getUnitsInfoByIds networksUnitIds params.masterUnits

        prioritizeCallsignsPartial callsign =
            Le.Callsign.prioritizeCallsigns params.masterUnits networkUnits params.callsignsInfo callsign
    in
    params.callsigns
        |> List.map (\callsign -> ( prioritizeCallsignsPartial callsign, callsign ))
        |> List.sortWith sortByPrio


{-| Нова функція сортування через HintStrategy (поки що не використовується)
-}
sortCallsignsNew : String -> Dict Int B.Network -> Params a -> List ( HintStrategy.HintResult, String )
sortCallsignsNew freq networksDict params =
    params.callsigns
        |> List.map (\callsign -> ( getCallsignHintsNew freq networksDict params callsign, callsign ))
        |> List.sortWith sortByPrioNew


{-| Нова функція сортування для HintResult
Спочатку NetworkBased (мережеві), потім SystemWide (каталог), потім по кількості підказок
-}
sortByPrioNew : ( HintStrategy.HintResult, String ) -> ( HintStrategy.HintResult, String ) -> Order
sortByPrioNew callsignWithPrioA callsignWithPrioB =
    let
        hintA = callsignWithPrioA |> Tuple.first
        hintB = callsignWithPrioB |> Tuple.first
        
        -- Приоритет стратегії: NetworkBased > SystemWide > NoHints
        strategyPriority strategy =
            case strategy of
                HintStrategy.NetworkBased _ -> 1
                HintStrategy.SystemWide -> 2
                HintStrategy.NoHints -> 3
        
        priorityA = strategyPriority hintA.strategy
        priorityB = strategyPriority hintB.strategy
        
        lengthA = List.length hintA.prioritizedCallsigns
        lengthB = List.length hintB.prioritizedCallsigns
    in
    if priorityA < priorityB then
        LT
    else if priorityA > priorityB then
        GT
    else
        -- Якщо стратегії однакові - сортуємо по кількості підказок
        if lengthA > lengthB then
            LT
        else if lengthA < lengthB then
            GT
        else
            EQ


sortCallsigns2 : B.Network -> Params a -> List ( List B.CallsignInfo, String )
sortCallsigns2 network params =
    let
        networkUnits =
            Le.Callsign.getNetworkUnits2 network params.masterUnits

        prioritizeCallsignsPartial callsign =
            Le.Callsign.prioritizeCallsigns params.masterUnits networkUnits params.callsignsInfo callsign
    in
    params.callsigns
        |> List.map (\callsign -> ( prioritizeCallsignsPartial callsign, callsign ))
        |> List.sortWith sortByPrio


{-| Нова функція сортування для мережі через HintStrategy (поки що не використовується)
-}
sortCallsigns2New : B.Network -> Params a -> List ( HintStrategy.HintResult, String )
sortCallsigns2New network params =
    let
        -- Створюємо повідомлення з networkIds
        message = { freq = Nothing, networkIds = Just [ network.id ] }
        context = createHintContext Dict.empty params
    in
    params.callsigns
        |> List.map (\callsign -> ( HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context callsign, callsign ))
        |> List.sortWith sortByPrioNew


type PopupCallerOrigin
    = FreqsPage String (Dict Int B.Network)
    | NetworksPage B.Network


type alias ViewParams msg =
    { callsigns : List String
    , isOpened : Bool
    , onOpen : msg
    , onClose : msg
    , masterUnits : Dict Int B.Unit
    , callsignsInfo : Dict String (List B.CallsignInfo)
    }


view : ViewParams msg -> PopupCallerOrigin -> Html msg
view viewParams pageSpecific =
    let
        sortedCallsigns =
            case pageSpecific of
                FreqsPage freq networksDict ->
                    -- ✅ ВИПРАВЛЕННЯ: Використовуємо нову систему HintStrategy
                    sortCallsignsNew freq networksDict viewParams

                NetworksPage network ->
                    -- ✅ ВИПРАВЛЕННЯ: Використовуємо нову систему HintStrategy
                    sortCallsigns2New network viewParams

        ( callsignsWithUnits, callsignsWithoutUnits ) =
            let
                hasUnits : ( HintStrategy.HintResult, String ) -> Bool
                hasUnits callsignWithPrio =
                    (callsignWithPrio |> Tuple.first |> .prioritizedCallsigns |> List.length) > 0
            in
            sortedCallsigns
                |> List.partition hasUnits
    in
    div []
        [ viewCallsignsRow sortedCallsigns
        , if List.length viewParams.callsigns > 3 then
            let
                body =
                    span
                        [ style "font-size" "12px"
                        , style "font-weight" "300"
                        , style "cursor" "pointer"
                        , style "display" "block"
                        , style "padding-right" "6px"
                        , style "text-decoration" "underline"
                        ]
                        [ text ("Показати всі " ++ (viewParams.callsigns |> List.length |> String.fromInt)) ]

                popupBody =
                    div [ class "d-flex flex-column", style "gap" "20px" ]
                        [ if not (List.isEmpty callsignsWithUnits) then
                            div [ class "callsigns-section" ]
                                [ div [ class "callsigns-section-header" ] [ text "Еталонні позивні" ]
                                , viewCallsignsGroup callsignsWithUnits
                                ]
                          else
                            text ""
                        , if not (List.isEmpty callsignsWithoutUnits) then
                            div [ class "callsigns-section" ]
                                [ div [ class "callsigns-section-header" ] [ text "Не прив'язані позивні" ]
                                , viewCallsignsGroup callsignsWithoutUnits
                                ]
                          else
                            text ""
                        , if List.isEmpty callsignsWithUnits && List.isEmpty callsignsWithoutUnits then
                            div [ class "callsigns-section-empty" ] [ text "Немає позивних для відображення" ]
                          else
                            text ""
                        ]
            in
            Le.Block.Popup.new
                { body = body
                , popupBody = popupBody
                , isOpen = viewParams.isOpened
                , onOpen = viewParams.onOpen
                , onClose = viewParams.onClose
                , disabled = False
                }
                |> Le.Block.Popup.withFakeAnchor
                |> Le.Block.Popup.withCloseButton
                |> Le.Block.Popup.view

          else
            text ""
        ]


viewCallsignsRow callsignsList =
    div [ class "flex flex-col gap-[4px]" ]
        (callsignsList
            |> List.take 3
            |> List.map (\callsignWithPrio -> 
                let
                    callsign = callsignWithPrio |> Tuple.second
                    hintResult = callsignWithPrio |> Tuple.first
                in
                Le.Block.Callsign.viewWithHintResult callsign hintResult
            )
        )


viewCallsignsGroup callsignsList =
    div [ class "callsigns-group" ]
        (callsignsList
            |> List.map
                (\callsignWithPrio -> 
                    let
                        callsign = callsignWithPrio |> Tuple.second
                        hintResult = callsignWithPrio |> Tuple.first
                    in
                    div [] [ Le.Block.Callsign.viewWithHintResult callsign hintResult ]
                )
        )
