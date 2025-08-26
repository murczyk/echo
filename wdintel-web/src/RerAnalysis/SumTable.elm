module RerAnalysis.SumTable exposing (sumTableBlock)

import Bindings as B
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Keyed as Keyed
import Le.Block.ActionMenu
import Le.Block.Callsign
import Le.Block.Spinner
import Le.Block.Unit
import Le.Callsign
import Le.Callsign.HintStrategy
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Utils exposing (..)
import RerAnalysis.Model exposing (..)
import RerAnalysis.Msg exposing (..)
import RerAnalysis.Utils exposing (updateQueryWithSelectedFreq)
import Route exposing (Route)
import Set
import Shared
import Shared.Model exposing (isDarkMode)


sumTableHeight =
    300


sumTableHeightMin =
    60


buttonBlockHeight =
    40


sumTableBlock : Model -> Shared.Model -> Route () -> List (Html Msg)
sumTableBlock model shared route =
    if model.unfoldSumTable then
        [ div [ class "fade-in" ] <|
            [ case model.sumTable of
                Success sumTable ->
                    sumTableBlock2 model shared route sumTable

                NotAsked ->
                    div
                        [ class "d-flex flex-column justify-content-center align-items-center gap-2"
                        , style "height" (String.fromInt (sumTableHeightMin + buttonBlockHeight) ++ "px")
                        ]
                        [ span [] [ text "Вибраний період більше 1 тижня." ]
                        , button [ onClick GetSumTable, class "btn btn-outline-secondary" ] [ text "завантажити таблицю" ]
                        ]

                _ ->
                    div
                        [ class "d-flex justify-content-center align-items-center"
                        , style "height" (String.fromInt (sumTableHeightMin + buttonBlockHeight) ++ "px")
                        ]
                        [ Le.Block.Spinner.loadingSpinnerSm
                        ]
            ]
        ]

    else
        []


renderLocation : String -> Html Msg
renderLocation location =
    li [] <|
        [ span [] [ text location ]
        , span [] [ text " " ]
        ]


renderUnitWithEdit : Model -> B.SummaryTableFreqRow -> String -> Html Msg
renderUnitWithEdit model row unit =
    li [] <|
        case Dict.get ( row.freq, unit ) model.editUnitMap of
            Nothing ->
                [ div []
                    [ span [] [ text unit ]
                    , span [] [ text " " ]
                    , i
                        [ class "bi bi-pen"
                        , style "cursor" "pointer"
                        , onClick <| EditUnitName row.freq unit
                        ]
                        []
                    ]
                ]

            Just str ->
                [ div []
                    [ textarea
                        [ class "form-control mb-1"
                        , style "font-size" ".9rem"
                        , onInput (EditUnitFormChanged row.freq unit)
                        , value <| Maybe.withDefault unit str
                        , style "height" "80px"
                        , style "width" "400px"
                        , spellcheck False
                        ]
                        []
                    , div [ class "mb-2" ]
                        [ button
                            [ type_ "button"
                            , class "btn btn-light btn-sm text-nowrap me-1"
                            , onClick <| EditUnitCancel row.freq unit
                            , style "font-size" ".75rem"
                            ]
                            [ text "відмінити"
                            ]
                        , button
                            [ type_ "button"
                            , class "btn btn-outline btn-primary btn-sm text-nowrap"
                            , style "font-size" ".75rem"
                            , onClick <| EditUnitSave row.freq unit
                            ]
                            [ text "зберегти"
                            ]
                        ]
                    ]
                ]


sumTableBlock2 : Model -> Shared.Model -> Route () -> B.SummaryTableFreq -> Html Msg
sumTableBlock2 model shared route sumTable =
    let
        masterUnitsDict =
            case shared.masterUnits of
                Success units ->
                    units

                _ ->
                    Dict.empty

        renderRow row =
            let
                sharedNetworks =
                    RD.withDefault Dict.empty shared.networks

                actionMenuBody =
                    [ span []
                        [ i [ class "bi me-1 bi-pin-map" ] []
                        , a [ href <| insertShowMapToQuery (updateQueryWithSelectedFreq row.freq route), target "_blank" ]
                            [ text "на мапі "
                            , sup []
                                [ i
                                    [ class "bi bi-box-arrow-up-right"
                                    ]
                                    []
                                ]
                            ]
                        ]
                    , span []
                        [ i [ class "bi me-1 bi-funnel" ] []
                        , button [ class "bg-transparent border-0", onClick (SelectOneFreq row.freq) ]
                            [ text "в фільтр" ]
                        ]
                    ]

                networkBlock =
                    let
                        freqNetworkIds =
                            sharedNetworks
                                |> Dict.values
                                |> List.concatMap
                                    (\network ->
                                        List.map (\freq -> ( freq.freq, network.id )) network.freqs
                                    )
                                |> List.filter (\( freq, _ ) -> freq == row.freq)
                                |> List.map Tuple.second
                                |> Set.fromList
                    in
                    if Set.isEmpty freqNetworkIds then
                        text ""

                    else
                        div [] <|
                            for_ (Set.toList freqNetworkIds) <|
                                \networkId ->
                                    case Dict.get networkId sharedNetworks of
                                        Just network ->
                                            Le.Block.Unit.boldMasterUnit masterUnitsDict network

                                        _ ->
                                            text "Невідома мережа"
            in
            tr [ style "font-size" ".9rem" ]
                [ td
                    [ style "white-space" "nowrap"
                    ]
                    [ text <| row.freq ++ " "
                    , Le.Block.ActionMenu.actionMenu actionMenuBody "bi-three-dots-vertical"
                    ]
                , td [] [ text <| String.fromInt row.count ]
                , td [] <|
                    [ ul [ class "list-unstyled mb-0" ] <|
                        List.map
                            (\lc ->
                                li []
                                    [ text <| textBeforeComma lc.locality

                                    -- , text " ("
                                    -- , span [] <|
                                    --     List.map
                                    --         (\latlng ->
                                    --                 [ text " "
                                    --                 ]
                                    --         )
                                    --         (List.take 5 lc.coords)
                                    -- , text ")"
                                    ]
                            )
                            row.localityCoords
                    ]
                , td []
                    (List.intersperse (text ", ")
                        (row.callsigns
                            |> List.map
                                (\callsign ->
                                    let
                                        -- Створюємо message для частоти
                                        message =
                                            { freq = Just row.freq, networkIds = Nothing }

                                        -- Створюємо контекст для HintStrategy
                                        context =
                                            { networks = sharedNetworks
                                            , masterUnits = masterUnitsDict
                                            , callsignsInfo = model.callsignsInfoSumTable
                                            }

                                        -- Використовуємо нову HintStrategy з FrequencyContext
                                        hintResult =
                                            Le.Callsign.HintStrategy.getCallsignHints 
                                                Le.Callsign.HintStrategy.FrequencyContext 
                                                message 
                                                context 
                                                callsign

                                        conditionMet =
                                            List.length hintResult.prioritizedCallsigns > 0

                                        result =
                                            if conditionMet then
                                                Le.Block.Callsign.viewWithHintResult callsign hintResult

                                            else
                                                Le.Block.Callsign.viewDefault callsign False
                                    in
                                    ( conditionMet, result )
                                )
                            |> List.sortWith
                                (\( isPrioA, _ ) ( isPrioB, _ ) ->
                                    if isPrioA == isPrioB then
                                        EQ

                                    else if isPrioA then
                                        LT

                                    else
                                        GT
                                )
                            |> List.map Tuple.second
                        )
                    )
                , td [] <|
                    [ ul
                        [ class "list-unstyled mb-0"
                        ]
                      <|
                        networkBlock
                            :: List.map (renderUnitWithEdit model row) row.units
                    ]
                , td [] <|
                    [ ul
                        [ class "list-unstyled mb-0"
                        ]
                      <|
                        List.map renderLocation row.locations
                    ]
                ]

        -- kmzDotsNum =
        --     sumTable
        --         |> .rows
        --         |> List.map
        --             (\row -> List.sum (List.map .count row.localityCoords))
        --         |> List.sum
    in
    div [ class "bg-body" ]
        [ div
            [ style "max-height" (String.fromInt sumTableHeight ++ "px")
            , style "min-height" "230px"
            , style "overflow-y" "auto"
            ]
            [ table [ class "table table-striped table-sm border shadow-sm" ]
                [ thead []
                    [ tr []
                        [ th
                            [ scope "col"
                            , classList [ ( "bg-white", not (isDarkMode shared.themeMode) ) ]
                            , style "position" "sticky"
                            , style "top" "0"
                            , style "z-index" "1"
                            ]
                            [ text "частота" ]
                        , th
                            [ scope "col"
                            , classList [ ( "bg-white", not (isDarkMode shared.themeMode) ) ]
                            , class "text-nowrap"
                            , style "position" "sticky"
                            , style "top" "0"
                            , style "z-index" "1"
                            ]
                            [ text "к-ть"
                            , sup
                                [ attribute "data-bs-toggle" "tooltip"
                                , attribute "data-bs-placement" "top"
                                , attribute "data-bs-title" "кількість повідомлень"
                                ]
                                [ i [ class "bi bi-question" ] [] ]
                            ]
                        , th
                            [ scope "col"
                            , classList [ ( "bg-white", not (isDarkMode shared.themeMode) ) ]
                            , style "position" "sticky"
                            , style "top" "0"
                            , style "z-index" "1"
                            ]
                            [ text "координати" ]
                        , th
                            [ scope "col"
                            , classList [ ( "bg-white", not (isDarkMode shared.themeMode) ) ]
                            , style "position" "sticky"
                            , style "top" "0"
                            , style "z-index" "1"
                            ]
                            [ text "позивні" ]
                        , th
                            [ scope "col"
                            , classList [ ( "bg-white", not (isDarkMode shared.themeMode) ) ]
                            , style "position" "sticky"
                            , style "top" "0"
                            , style "z-index" "1"
                            , style "min-width" "400px"
                            ]
                            [ text "підрозділи" ]
                        , th
                            [ scope "col"
                            , classList [ ( "bg-white", not (isDarkMode shared.themeMode) ) ]
                            , style "position" "sticky"
                            , style "top" "0"
                            , style "z-index" "1"
                            ]
                            [ text "локації" ]
                        ]
                    ]
                , Keyed.node "tbody" [] <|
                    List.indexedMap (\index row -> ( String.fromInt index, renderRow row )) sumTable.rows
                ]
            ]
        , div
            [ class "d-flex justify-content-start mb-2 mt-2 me-2"
            ]
            [ button
                [ type_ "button"
                , class "inline-block btn btn-outline-secondary btn-sm me-2"
                , onClick DownloadXlsx
                ]
                [ i [ class "bi bi-filetype-xlsx" ] []
                , text <| " скачати xlsx"
                ]
            , button
                [ type_ "button"
                , class "inline-block btn btn-outline-secondary btn-sm me-2"
                , onClick DownloadKmz
                ]
                [ i [ class "bi bi-pin-map" ] []
                , text <| " скачати kmz"

                -- , span
                --     [ class "badge badge-sm rounded-pill text-bg-light"
                --     , style "font-size" ".6rem"
                --     ]
                --   <|
                --     [ text <| String.fromInt kmzDotsNum ]
                ]
            , button
                [ type_ "button"
                , class "inline-block btn btn-outline-secondary btn-sm"
                , onClick DownloadGeojson
                ]
                [ i [ class "bi bi-pin-map" ] []
                , text <| " скачати geojson"

                -- , span
                --     [ class "badge badge-sm rounded-pill text-bg-light"
                --     , style "font-size" ".6rem"
                --     ]
                --   <|
                --     [ text <| String.fromInt kmzDotsNum ]
                ]
            ]
        ]
