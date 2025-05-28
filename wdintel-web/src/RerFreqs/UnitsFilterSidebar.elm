module RerFreqs.UnitsFilterSidebar exposing (view)

import Bindings as B
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Le.Block.Spinner
import Le.Block.Unit as Unit
import RerFreqs.Model exposing (Model)
import RerFreqs.Msg exposing (Msg(..))
import Shared


view : Shared.Model -> Model -> Html Msg
view shared model =
    div
        [ class "align-self-stretch"
        , style "width" "220px"
        , style "min-width" "220px"
        , style "height" "calc(-50px + 100vh)"
        , style "overflow-y" "scroll"
        ]
        [ div
            [ class "filter-col d-flex flex-column pt-1 left-panel"
            , style "height" "100%"
            ]
            [ unitStatsBlock shared model
            , div [ class "flex-grow-1" ] []
            ]
        ]


unitStatsBlock : Shared.Model -> Model -> Html Msg
unitStatsBlock _ model =
    let
        filterState =
            model.filterState

        renderUnitStat : B.FreqUnitStatRow -> List (Html Msg)
        renderUnitStat stat =
            [ div
                [ class "d-flex justify-content-between align-items-between p-2 pointer"
                , onClick <| FilterStateMsg { filterState | unit = Unit.unitName model.masterUnits stat.unitId }
                ]
                [ div [ class "flex-grow-1 text-end me-2" ] [ text <| Unit.unitName model.masterUnits stat.unitId ]
                , div [ class "me-2" ]
                    [ div
                        [ style "min-width" "30px"
                        , class "text-center"
                        ]
                        [ span
                            [ class "badge badge-sm rounded-pill text-bg-secondary"
                            , style "font-size" "0.6rem"
                            ]
                            [ text <| String.fromInt stat.count
                            ]
                        ]
                    ]
                ]
            , div [ class "border-bottom" ] []
            ]
    in
    if model.loadingUnitStats then
        Le.Block.Spinner.loadingSpinner

    else
        div [ style "font-size" ".8rem" ] <|
            List.concatMap renderUnitStat model.unitStats
