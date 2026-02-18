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
    div [ class "d-inline-block align-middle" ]
        [ div [ class "d-flex align-items-center", style "gap" "8px", style "padding-top" "1px" ]
            [ Shared.Components.DateRangePicker.view { zone = timeZone, from = model.from, to = model.to } model.dateRangePicker
                |> Html.map DateRangePickerMsg
            , div [ class "d-flex align-items-center", style "gap" "8px" ]
                [ if mapFeatureFlag then
                    toggleButton2
                        { isDark = isDark
                        , toggleMsg = ToggleUnfoldMapBlock
                        , tooltip = "карта"
                        , unfold = model.unfoldMapBlock
                        , disabled = False
                        }
                        (i [ class "bi bi-map" ] [])
                        Nothing

                  else
                    text ""
                ]
            , div
                [ class "d-flex"
                , style "gap" "0"
                , style "border-radius" "2px"
                , style "overflow" "hidden"
                ]
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
            , div
                [ class "d-inline-flex align-items-stretch"
                , style "border" "1px solid var(--color-border)"
                , style "border-radius" "2px"
                , style "overflow" "hidden"
                ]
                [ div
                    [ class "position-relative d-inline-flex align-items-center"
                    , style "min-height" "40px"
                    ]
                    [ input
                        [ type_ "text"
                        , style "width" "220px"
                        , style "height" "40px"
                        , style "padding" "0 32px 0 12px"
                        , style "border" "none"
                        , style "outline" "none"
                        , style "box-shadow" "none"
                        , style "background" "var(--color-bw)"
                        , style "color" "var(--color-text)"
                        , placeholder "пошук"
                        , onInput SearchInput
                        , onKeyDown SearchInputKeyDown
                        , value <| model.searchInput
                        ]
                        []
                    , viewIf (String.length model.searchInput > 0) <|
                        button
                            [ type_ "button"
                            , class "btn-close position-absolute top-50 translate-middle-y"
                            , attribute "aria-label" "Очистити пошук"
                            , style "font-size" "8px"
                            , style "right" "8px"
                            , style "outline" "none"
                            , style "box-shadow" "none"
                            , onClick SearchReset
                            ]
                            []
                    ]
                , button
                    [ type_ "button"
                    , class "inline-flex items-center justify-center text-nowrap rounded-none p-1 transition-colors duration-200 ease-in-out bg-neutral-light text-text hover:bg-neutral-light-hover dark:bg-neutral-dark dark:text-w dark:hover:bg-neutral-dark-hover"
                    , style "min-height" "40px"
                    , style "min-width" "50px"
                    , style "border" "none"
                    , style "border-left" "1px solid var(--color-border)"
                    , title "шукати"
                    , onClick SearchDo
                    ]
                    [ i [ class "bi bi-search" ] []
                    ]
                ]
            ]
        ]
