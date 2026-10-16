module Pages_.RerAnalysis.Date exposing (dateAndPanelsBlock)

import Bindings as B
import Config
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra exposing (viewIf)
import Json.Decode as Decode
import Pages_.RerAnalysis.Constants exposing (analysisSearchModes)
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Pages_.RerAnalysis.ToggleButton exposing (toggleButton2)
import Shared.Components.DateRangePicker
import String
import Time


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
                    , style "overflow" "visible"
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
                            , onFocus (SearchFocusChanged True)
                            , onClick (SearchFocusChanged True)
                            , onBlur (SearchFocusChanged False)
                            , preventDefaultOn "keydown"
                                (Decode.map
                                    (\key -> ( SearchInputKeyDown key, List.member key [ 13, 27, 38, 40 ] ))
                                    keyCode
                                )
                            , attribute "role" "combobox"
                            , attribute "aria-label" "Пошук"
                            , attribute "aria-autocomplete" "list"
                            , attribute "aria-controls" "analysis-search-suggestions"
                            , attribute "aria-expanded"
                                (if searchSuggestionsVisible model then
                                    "true"

                                 else
                                    "false"
                                )
                            , attribute "aria-activedescendant"
                                (if searchSuggestionsVisible model then
                                    model.searchSuggestionIndex
                                        |> Maybe.map (String.fromInt >> (++) "analysis-search-option-")
                                        |> Maybe.withDefault ""

                                 else
                                    ""
                                )
                            , autocomplete False
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
                        , searchSuggestions model
                        ]
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


searchSuggestionsVisible : Model -> Bool
searchSuggestionsVisible model =
    model.searchSuggestionsOpen && String.trim model.searchInput /= ""


searchSuggestions : Model -> Html Msg
searchSuggestions model =
    viewIf (searchSuggestionsVisible model) <|
        ul
            [ id "analysis-search-suggestions"
            , attribute "role" "listbox"
            , attribute "aria-label" "Режим пошуку"
            , class "absolute top-full left-0 z-[1060] m-0 w-max max-w-[calc(100vw-24px)] list-none rounded-echo-sm border border-echo-border bg-echo-surface-raised p-echo-xs text-echo-text shadow-lg"
            ]
            (List.indexedMap
                (\index ( mode, label ) ->
                    li
                        [ id ("analysis-search-option-" ++ String.fromInt index)
                        , attribute "role" "option"
                        , attribute "aria-selected"
                            (if Maybe.withDefault B.Fuzzy model.searchMode == mode then
                                "true"

                             else
                                "false"
                            )
                        ]
                        [ button
                            [ type_ "button"
                            , tabindex -1
                            , classList
                                [ ( "block w-full rounded-echo-sm border-0 px-echo-md py-echo-sm text-left text-echo-text hover:bg-echo-surface-inactive", True )
                                , ( "bg-echo-surface-inactive", model.searchSuggestionIndex == Just index )
                                , ( "bg-transparent", model.searchSuggestionIndex /= Just index )
                                ]
                            , preventDefaultOn "mousedown" (Decode.succeed ( SearchFocusChanged True, True ))
                            , onClick (SearchModeChanged mode)
                            ]
                            [ em [] [ text model.searchInput ]
                            , text " - "
                            , strong [] [ text label ]
                            ]
                        ]
                )
                analysisSearchModes
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
            [ p [] [ text "Пошук працює в 3 режимах. Наприклад, для запиту «рота»:" ]
            , ul []
                [ li [] [ text "Точний збіг: лише слово «рота»" ]
                , li [] [ text "Гнучкий пошук: також «ротний», «роти»" ]
                , li [] [ text "Збіг за входженням: також «воротар»" ]
                ]
            , a [ href Config.analysisSearchDocUrl, target "_blank", rel "noopener noreferrer" ] [ text "Докладніше на сторінці документації" ]
            ]
        ]
