module Pages_.RerAnalysis.Date exposing (dateAndPanelsBlock)

import Bindings as B
import Config
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra exposing (viewIf)
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Pages_.RerAnalysis.ToggleButton exposing (toggleButton2)
import Shared.Components.DateRangePicker
import String
import Time
import Utils.Utils exposing (onKeyDown)


dateAndPanelsBlock : Bool -> Time.Zone -> Model -> Bool -> Html Msg
dateAndPanelsBlock isDark timeZone model mapFeatureFlag =
    let
        searchButtonClass =
            "inline-flex items-center justify-center text-nowrap rounded-none p-1 bg-neutral-light text-text dark:bg-neutral-dark dark:text-w transition-colors duration-200 ease-in-out hover:bg-neutral-light-hover dark:hover:bg-neutral-dark-hover"
    in
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
                [ viewIf model.radioFeaturesAllowed <|
                  toggleButton2
                    { isDark = isDark
                    , toggleMsg = ToggleUnfoldGraphs
                    , tooltip = "графіки"
                    , unfold = model.unfoldGraphs
                    , disabled = model.unfoldMapBlock
                    }
                    (i [ class "bi bi-bar-chart" ] [])
                    Nothing
                , viewIf model.radioFeaturesAllowed <|
                  toggleButton2
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
            , viewIf (not model.unfoldMapBlock) <|
                div
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
                    , searchModeSelect model.searchMode
                    , button
                        [ type_ "button"
                        , class searchButtonClass
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
            , searchHelp
            ]
        ]


searchModeSelect : Maybe B.AnalysisSearchMode -> Html Msg
searchModeSelect selectedMode =
    select
        [ attribute "aria-label" "Режим пошуку"
        , style "background" "var(--color-bw)"
        , style "color" "var(--color-text)"
        , style "border" "none"
        , style "border-left" "1px solid var(--color-border)"
        , style "padding" "0 8px"
        , onInput
            (\mode ->
                SearchModeChanged <|
                    case mode of
                        "Exact" ->
                            B.Exact

                        "Substring" ->
                            B.Substring

                        _ ->
                            B.Fuzzy
            )
        ]
        (List.map
            (\( mode, key, label ) ->
                option [ value key, selected (Maybe.withDefault B.Fuzzy selectedMode == mode) ] [ text label ]
            )
            [ ( B.Fuzzy, "Fuzzy", "Гнучкий пошук" )
            , ( B.Exact, "Exact", "Точний збіг" )
            , ( B.Substring, "Substring", "Збіг за входженням" )
            ]
        )


searchHelp : Html Msg
searchHelp =
    details [ style "position" "relative" ]
        [ summary
            [ attribute "aria-label" "Довідка про пошук"
            , attribute "role" "button"
            , title "Режими пошуку"
            , style "cursor" "pointer"
            , style "list-style" "none"
            , style "padding" "8px"
            ]
            [ i [ class "bi bi-info-circle", attribute "aria-hidden" "true" ] [] ]
        , div
            [ style "position" "absolute"
            , style "right" "0"
            , style "top" "100%"
            , style "width" "320px"
            , style "max-width" "calc(100vw - 24px)"
            , style "z-index" "1060"
            , style "background" "var(--color-bw)"
            , style "border" "1px solid var(--color-border)"
            , style "border-radius" "4px"
            , style "padding" "12px"
            ]
            [ p [] [ text "Усі режими не враховують регістр. Для запиту «нора»:" ]
            , ul []
                [ li [] [ text "Гнучкий пошук: також «норма», «нормальний»." ]
                , li [] [ text "Точний збіг: лише слово «нора», також «НОРА!»." ]
                , li [] [ text "Збіг за входженням: також «панорама»." ]
                ]
            , a [ href Config.analysisSearchDocUrl, target "_blank", rel "noopener noreferrer" ] [ text "Докладніше про пошук" ]
            ]
        ]
