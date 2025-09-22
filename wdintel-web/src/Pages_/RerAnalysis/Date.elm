module Pages_.RerAnalysis.Date exposing (dateAndPanelsBlock)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra exposing (viewIf)
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Pages_.RerAnalysis.ToggleButton exposing (toggleButton2)
import Shared.Components.DateRangePicker
import String
import Utils.Utils exposing (..)
import Time


dateAndPanelsBlock : Bool -> Time.Zone -> Model -> Bool -> Html Msg
dateAndPanelsBlock isDark timeZone model mapFeatureFlag =
    div [ class "d-inline-block align-middle ms-2" ]
        [ div [ class "d-flex align-items-center", style "gap" "8px", style "padding-top" "1px" ]
            [ Shared.Components.DateRangePicker.view { zone = timeZone, from = model.from, to = model.to } model.dateRangePicker
                |> Html.map DateRangePickerMsg
            , div [ class "d-flex align-items-center" ]
                [ if mapFeatureFlag then
                    toggleButton2
                        { isDark = isDark
                        , toggleMsg = ToggleUnfoldMapBlock
                        , tooltip = "карта"
                        , unfold = model.unfoldMapBlock
                        , disabled = False
                        }
                        (i [ class "bi bi-pin-map" ] [])
                        Nothing

                  else
                    text ""
                ]
            , div [ class "d-flex" ]
                [ toggleButton2
                    { isDark = isDark
                    , toggleMsg = ToggleUnfoldGraphs
                    , tooltip = "графіки"
                    , unfold = model.unfoldGraphs
                    , disabled = model.unfoldMapBlock
                    }
                    (i [ class "bi bi-bar-chart" ] [])
                    Nothing
                , toggleButton2
                    { isDark = isDark
                    , toggleMsg = ToggleUnfoldSumTable
                    , tooltip = "сумарна таблиця"
                    , unfold = model.unfoldSumTable
                    , disabled = model.unfoldMapBlock
                    }
                    (i [ class "bi bi-table" ] [])
                    Nothing
                , toggleButton2
                    { isDark = isDark
                    , toggleMsg = ToggleUnfoldCallsignGraph
                    , tooltip = "хмара позивних"
                    , unfold = model.unfoldCallsignGraph
                    , disabled = model.unfoldMapBlock
                    }
                    (i [ class "bi bi-people" ] [])
                    Nothing
                , toggleButton2
                    { isDark = isDark
                    , toggleMsg = ToggleUnfoldNewCallsignsBlock
                    , tooltip = "нові позивні"
                    , unfold = model.unfoldNewCallsignsBlock
                    , disabled = model.unfoldMapBlock
                    }
                    (i [ class "bi bi-person-plus-fill" ] [])
                    Nothing
                ]
            , div [ class "d-flex gap-1 justify-content-center align-items-center" ]
                [ div
                    [ class "position-relative" ]
                    [ input
                        [ type_ "text"
                        , style "width" "200px"
                        , placeholder "пошук"
                        , onInput SearchInput
                        , onKeyDown SearchInputKeyDown
                        , class "form-control"
                        , value <| model.searchInput
                        ]
                        []
                    , viewIf (String.length model.searchInput > 0) <|
                        button
                            [ type_ "button"
                            , class "btn-close position-absolute top-50 translate-middle"
                            , attribute "aria-label" "Close"
                            , style "font-size" "8px"
                            , style "right" "6px"
                            , style "outline" "none"
                            , style "box-shadow" "none"
                            , onClick SearchReset
                            ]
                            []
                    ]
                , button
                    [ type_ "button"
                    , class "btn btn-secondary btn-sm text-nowrap"
                    , attribute "data-tooltip" "шукати"
                    , attribute "data-position" "bottom"
                    , onClick SearchDo
                    ]
                    [ i [ class "bi bi-search" ] []
                    ]
                ]
            ]
        ]
