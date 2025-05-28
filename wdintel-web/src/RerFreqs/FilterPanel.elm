module RerFreqs.FilterPanel exposing (view)

import Bindings as B
import Components.Button as Button
import Components.ModalDialog as ModalDialog
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Le.Block.Select
import Le.Block.Spinner
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Utils exposing (..)
import RerFreqs.Model exposing (FilterName(..), Model, NetworkAddStatus(..), ReportCreation(..), TextLocation(..))
import RerFreqs.Msg exposing (Msg(..))
import RerFreqs.Utils as Utils
import Select
import Shared


view : Shared.Model -> Model -> Html Msg
view shared model =
    let
        filterState =
            model.filterState

        tabFiltersCallsigns =
            let
                items =
                    List.map
                        (\callsign ->
                            Select.basicMenuItem
                                { item = callsign
                                , label = callsign
                                }
                        )
                        filterState.callsigns
            in
            div
                [ style "font-size" ".8rem"
                , style "min-width" "330px"
                ]
                [ Html.map SelCallsignMsg
                    (Styled.toUnstyled <|
                        Le.Block.Select.renderSelectVirtual
                            items
                            model.selCallsignState
                            model.selCallsignMenu
                            "всі"
                            { loading = RD.isLoading model.callsignsForFilter, disabled = False, isDark = shared.isDarkMode }
                    )
                ]
    in
    div
        [ class "flex justify-start items-center"
        ]
        [ div [ class "me-2" ]
            [ if model.loading then
                Le.Block.Spinner.loadingSpinner2Sm

              else
                i [ class "bi bi-filter" ] []
            ]
        , input
            [ class "form-control me-2"
            , style "width" "200px"
            , type_ "text"
            , placeholder "частота"
            , value model.filterState.freq
            , onInput <| \v -> FilterStateMsg { filterState | freq = v }
            ]
            []
        , input
            [ class "form-control me-2"
            , style "width" "200px"
            , type_ "text"
            , placeholder "підрозділ"
            , value model.filterState.unit
            , onInput <| \v -> FilterStateMsg { filterState | unit = v }
            ]
            []
        , span [ class "me-2" ] [ text "позивні" ]
        , tabFiltersCallsigns
        , span [ class "grow-1" ] []
        , Button.new { label = "Звіт \"Еталонка\"", onClick = OpenReportModal } |> Button.view
        , let
            dialogContent =
                [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                    [ div [ class "pb-12" ]
                        [ h2 [] [ text "Звіт \"еталонка\"" ]
                        , p [] [ text "Еталонка по фільтру дата/частота/підрозділ" ]
                        , div
                            [ class "form-check mb-2" ]
                            [ input
                                [ class "form-check-input"
                                , type_ "checkbox"
                                , id "include-adjacent-freqs"
                                , onCheck <| ChangeReportStatus
                                , checked (model.reportStatus == ReportWithAdjacentFreqs B.ShortRange || model.reportStatus == ReportWithAdjacentFreqs B.LongRange)
                                ]
                                []
                            , label
                                [ class "form-check-label"
                                , for "include-adjacent-freqs"
                                ]
                                [ text "Включати суміжні частоти" ]
                            ]
                        , div
                            [ style "width" "100%"
                            , style "font-size" ".8rem"
                            ]
                            [ let
                                selItem =
                                    Just
                                        (Select.basicMenuItem
                                            { item = model.adjacentFreqsRangeSelect.selected
                                            , label = Utils.adjacentRangeToLabel model.adjacentFreqsRangeSelect.selected
                                            }
                                        )

                                options =
                                    Le.Block.Select.defaultOptions shared.isDarkMode

                                options2 =
                                    { options | clearable = False, disabled = model.reportStatus == ReportBasic }
                              in
                              Html.map SelectReportAdjacentFreqsRange
                                (Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selItem
                                        model.adjacentFreqsRangeSelect.state
                                        model.adjacentFreqsRangeSelect.items
                                        "не обрано"
                                        options2
                                )
                            ]
                        ]
                    , div [ class "flex justify-between" ]
                        [ Button.new { label = "Назад", onClick = CloseReportModal } |> Button.withStyleSecondary |> Button.view
                        , Button.new { label = "Згенерувати", onClick = ReportEtalonkaDownload False }
                            |> (if model.reportDownloadInProgress then
                                    Button.withIcon
                                        [ Le.Block.Spinner.loadingSpinner2Sm
                                        ]

                                else
                                    identity
                               )
                            |> Button.view
                        ]
                    ]
                ]
          in
          ModalDialog.modalDialog model.reportModalOpen CloseReportModal [] dialogContent
        ]
