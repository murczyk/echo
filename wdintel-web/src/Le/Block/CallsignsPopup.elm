module Le.Block.CallsignsPopup exposing (..)

import Bindings as B
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (..)
import Le.Block.Callsign
import Le.Block.Popup
import Le.Callsign


prioUnitsAccessor : ( List B.CallsignInfo, String ) -> List B.CallsignInfo
prioUnitsAccessor callsignWithPrio =
    callsignWithPrio |> Tuple.first


type alias Params a =
    { a
        | masterUnits : Dict Int B.Unit
        , callsignsInfo : Dict String (List B.CallsignInfo)
        , callsigns : List String
    }


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
                    sortCallsigns freq networksDict viewParams

                NetworksPage network ->
                    sortCallsigns2 network viewParams

        ( callsignsWithUnits, callsignsWithoutUnits ) =
            let
                hasUnits : ( List B.CallsignInfo, String ) -> Bool
                hasUnits callsignWithPrio =
                    (prioUnitsAccessor callsignWithPrio |> List.length) > 0
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
                        [ viewCallsignsGroup callsignsWithUnits, viewCallsignsGroup callsignsWithoutUnits ]
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
            |> List.map (\callsignWithPrio -> Le.Block.Callsign.view (callsignWithPrio |> Tuple.second) ( callsignWithPrio |> Tuple.first, [] ))
        )


viewCallsignsGroup callsignsList =
    div [ class "callsigns-group" ]
        (callsignsList
            |> List.map
                (\callsignWithPrio -> div [] [ Le.Block.Callsign.view (callsignWithPrio |> Tuple.second) ( callsignWithPrio |> Tuple.first, [] ) ])
        )
