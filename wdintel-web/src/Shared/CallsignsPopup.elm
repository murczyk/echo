module Shared.CallsignsPopup exposing (..)

import Bindings as B
import Core.Callsigns.HintStrategy as HintStrategy
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (..)
import Shared.Callsign
import Shared.Components.Popup


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
        message =
            createMessageForFreq freq

        context =
            createHintContext networks params
    in
    HintStrategy.getCallsignHints HintStrategy.FrequencyContext message context callsign


{-| Нова функція сортування через HintStrategy (поки що не використовується)
-}
sortCallsignsNew : String -> Dict Int B.Network -> Params a -> List ( HintStrategy.HintResult, String )
sortCallsignsNew freq networksDict params =
    let
        networksForFreq =
            Dict.filter
                (\_ network -> List.any (\networkFreq -> networkFreq.freq == freq) network.freqs)
                networksDict
    in
    params.callsigns
        |> List.map (\callsign -> ( getCallsignHintsNew freq networksForFreq params callsign, callsign ))
        |> List.sortWith sortByPrioNew


sortCallsignsForPreview : String -> Dict Int B.Network -> Dict Int B.Unit -> Dict String (List Int) -> List String -> Maybe (List String)
sortCallsignsForPreview freq networksDict masterUnits priorities callsigns =
    if List.all (\callsign -> Dict.member (String.toLower callsign) priorities) callsigns then
        let
            networksForFreq =
                Dict.values networksDict
                    |> List.filter (\network -> List.any (\networkFreq -> networkFreq.freq == freq) network.freqs)

            priority callsign =
                Dict.get (String.toLower callsign) priorities
                    |> Maybe.withDefault []
                    |> HintStrategy.previewCallsignPriority networksForFreq masterUnits
        in
        callsigns
            |> List.map (\callsign -> ( priority callsign, callsign ))
            |> List.sortWith (\left right -> comparePriorities (Tuple.first left) (Tuple.first right))
            |> List.take 3
            |> List.map Tuple.second
            |> Just

    else
        Nothing


comparePriorities : ( Int, Int ) -> ( Int, Int ) -> Order
comparePriorities ( priorityA, countA ) ( priorityB, countB ) =
    case compare priorityA priorityB of
        EQ ->
            compare countB countA

        order ->
            order


{-| Нова функція сортування для HintResult
Спочатку NetworkBased (мережеві), потім SystemWide (каталог), потім по кількості підказок
-}
sortByPrioNew : ( HintStrategy.HintResult, String ) -> ( HintStrategy.HintResult, String ) -> Order
sortByPrioNew callsignWithPrioA callsignWithPrioB =
    let
        hintA =
            callsignWithPrioA |> Tuple.first

        hintB =
            callsignWithPrioB |> Tuple.first

        -- Приоритет стратегії: NetworkBased > SystemWide > NoHints
        strategyPriority strategy =
            case strategy of
                HintStrategy.NetworkBased _ ->
                    1

                HintStrategy.SystemWide ->
                    2

                HintStrategy.NoHints ->
                    3

        priorityA =
            strategyPriority hintA.strategy

        priorityB =
            strategyPriority hintB.strategy

        lengthA =
            List.length hintA.prioritizedCallsigns

        lengthB =
            List.length hintB.prioritizedCallsigns
    in
    comparePriorities ( priorityA, lengthA ) ( priorityB, lengthB )


{-| Нова функція сортування для мережі через HintStrategy (поки що не використовується)
-}
sortCallsigns2New : B.Network -> Params a -> List ( HintStrategy.HintResult, String )
sortCallsigns2New network params =
    let
        -- Створюємо повідомлення з networkIds
        message =
            { freq = Nothing, networkIds = Just [ network.id ] }

        context =
            createHintContext Dict.empty params
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
    , isLoading : Bool
    , previewCallsigns : Maybe (List String)
    , onOpen : msg
    , onClose : msg
    , masterUnits : Dict Int B.Unit
    , callsignsInfo : Dict String (List B.CallsignInfo)
    }


view : ViewParams msg -> PopupCallerOrigin -> Html msg
view viewParams pageSpecific =
    let
        sortCallsigns callsigns =
            case pageSpecific of
                FreqsPage freq networksDict ->
                    sortCallsignsNew freq networksDict { viewParams | callsigns = callsigns }

                NetworksPage network ->
                    sortCallsigns2New network { viewParams | callsigns = callsigns }

        sortedPreview =
            sortCallsigns (Maybe.withDefault viewParams.callsigns viewParams.previewCallsigns)

        sortedPopup =
            if viewParams.isOpened && not viewParams.isLoading then
                case viewParams.previewCallsigns of
                    Just _ ->
                        sortCallsigns viewParams.callsigns

                    Nothing ->
                        sortedPreview

            else
                []

        ( callsignsWithUnits, callsignsWithoutUnits ) =
            let
                hasUnits : ( HintStrategy.HintResult, String ) -> Bool
                hasUnits callsignWithPrio =
                    (callsignWithPrio |> Tuple.first |> .prioritizedCallsigns |> List.length) > 0
            in
            sortedPopup
                |> List.partition hasUnits
    in
    div []
        [ if viewParams.previewCallsigns == Just [] && not (List.isEmpty viewParams.callsigns) then
            div [] [ text "Завантаження позивних..." ]

          else
            viewCallsignsRow sortedPreview
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
                    if viewParams.isLoading then
                        div [] [ text "Завантаження інформації про позивні..." ]

                    else if viewParams.isOpened then
                        viewPopupBody callsignsWithUnits callsignsWithoutUnits

                    else
                        text ""
            in
            Shared.Components.Popup.new
                { body = body
                , popupBody = popupBody
                , isOpen = viewParams.isOpened
                , onOpen = viewParams.onOpen
                , onClose = viewParams.onClose
                , disabled = False
                }
                |> Shared.Components.Popup.withFakeAnchor
                |> Shared.Components.Popup.withCloseButton
                |> Shared.Components.Popup.view

          else
            text ""
        ]


viewPopupBody : List ( HintStrategy.HintResult, String ) -> List ( HintStrategy.HintResult, String ) -> Html msg
viewPopupBody callsignsWithUnits callsignsWithoutUnits =
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


viewCallsignsRow : List ( HintStrategy.HintResult, String ) -> Html msg
viewCallsignsRow callsignsList =
    div [ class "flex flex-col gap-[4px]" ]
        (callsignsList
            |> List.take 3
            |> List.map
                (\callsignWithPrio ->
                    let
                        callsign =
                            callsignWithPrio |> Tuple.second

                        hintResult =
                            callsignWithPrio |> Tuple.first
                    in
                    Shared.Callsign.viewWithHintResult callsign hintResult
                )
        )


viewCallsignsGroup : List ( HintStrategy.HintResult, String ) -> Html msg
viewCallsignsGroup callsignsList =
    div [ class "callsigns-group" ]
        (callsignsList
            |> List.map
                (\callsignWithPrio ->
                    let
                        callsign =
                            callsignWithPrio |> Tuple.second

                        hintResult =
                            callsignWithPrio |> Tuple.first
                    in
                    div [] [ Shared.Callsign.viewWithHintResult callsign hintResult ]
                )
        )
