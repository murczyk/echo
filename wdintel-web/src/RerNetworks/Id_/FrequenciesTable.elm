module RerNetworks.Id_.FrequenciesTable exposing (view)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Components.ModalDialog as ModalDialog
import Components.Pager as Pager
import Components.SegmentedControl as SegmentedControl
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Components.Table.Sorter as TableSorter
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Keyed
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import Le.Auth
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Popup as Popup
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Le.Utils exposing (networkKindVHFMapping)
import List.Extra as ListX
import Page exposing (Page)
import RerNetworks.Id_.Model exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), Model, ShowAllPopupFor(..))
import RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import Url.Builder
import View exposing (View)


filterFreqsByActivity : FreqActivityFilter -> List B.NetworkFreqsRes -> List B.NetworkFreqsRes
filterFreqsByActivity filter freqs =
    case filter of
        AllFreqs ->
            freqs

        ActiveFreqs ->
            List.filter .isActive freqs

        InactiveFreqs ->
            List.filter (\freq -> not freq.isActive) freqs


view freqs model user shared =
    let
        filteredFreqs =
            filterFreqsByActivity model.freqsActivityFilter freqs
    in
    div [ class "table-responsive-modern" ]
        [ if List.isEmpty filteredFreqs then
            emptyFreqsPlaceholder model.freqsActivityFilter

          else
            Table.view (freqsTableConfig shared model user) model.freqsTableState filteredFreqs
        ]


emptyFreqsPlaceholder : FreqActivityFilter -> Html msg
emptyFreqsPlaceholder filter =
    let
        message =
            case filter of
                AllFreqs ->
                    "Немає частот в мережі"

                ActiveFreqs ->
                    "Немає активних частот"

                InactiveFreqs ->
                    "Немає неактивних частот"
    in
    div
        [ class "flex flex-col items-center justify-center py-12 text-center" ]
        [ i [ class "bi bi-radio-tower text-4xl text-gray-400 mb-4" ] []
        , p [ class "text-gray-600 dark:text-gray-400 text-lg font-medium" ] [ text message ]
        , p [ class "text-gray-500 dark:text-gray-500 text-sm mt-2" ]
            [ text "Спробуйте змінити фільтр або перевірте налаштування мережі" ]
        ]


freqsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.NetworkFreqsRes Msg
freqsTableConfig shared model user =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute Msg ) -> Html Msg
        customTheadHelp ( name, status, click ) =
            let
                sortIcon =
                    case status of
                        TableConfig.Unsortable ->
                            text ""

                        TableConfig.Sortable selected ->
                            span
                                [ style "color"
                                    (if selected then
                                        "var(--ochre-normal)"

                                     else
                                        "var(--color-text-muted)"
                                    )
                                ]
                                [ text " ⇓" ]

                        TableConfig.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ⇕" ]

                        TableConfig.Reversible (Just isReversed) ->
                            span [ style "color" "var(--ochre-normal)" ]
                                [ text
                                    (if isReversed then
                                        " ⇑"

                                     else
                                        " ⇓"
                                    )
                                ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click ] [ headerContent ]

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customRowAttrs : B.NetworkFreqsRes -> List (Html.Attribute Msg)
        customRowAttrs freq =
            if not freq.isActive then
                [ class "bg-[#f8f9fa] dark:bg-[#2C2C2E]" ]

            else
                []

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
                , rowAttrs = customRowAttrs
            }
    in
    Table.customConfig
        { toId = .freq
        , toMsg = SetFreqsTableState
        , columns =
            [ Table.stringColumn "Частота" .freq |> Table.withColumnWidth "9%"
            , Table.customColumn
                { name = "Модуляція"
                , viewData = \freq -> Maybe.withDefault "" freq.modulation
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "10%"
            , Table.customColumn
                { name = "Тип"
                , viewData =
                    \freq ->
                        Maybe.withDefault "" freq.kind
                            |> NetworksUtils.networkKindFromString
                            |> NetworksUtils.networkKindToLabel
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "8%"
            , Table.intColumn "Кількість перехоплень" .messageCount |> Table.withColumnWidth "6%"
            , Table.veryCustomColumn
                { name = "Позивні"
                , viewData =
                    \freq ->
                        case freq.callsigns of
                            Just callsigns ->
                                let
                                    isOpen =
                                        case model.callsignsOpenedPopupId of
                                            Just openCallsignsPopup ->
                                                openCallsignsPopup == freq.freq

                                            Nothing ->
                                                False
                                in
                                { attributes = []
                                , children =
                                    [ CallsignsPopup.view
                                        { isOpened = isOpen
                                        , onClose = CallsignsPopupClosedByUser
                                        , onOpen = CallsignsPopupOpenedByUser freq.freq
                                        , callsigns = callsigns
                                        , callsignsInfo = shared.callsignsInfo
                                        , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                                        }
                                        (FreqsPage
                                            freq.freq
                                            (RD.withDefault Dict.empty shared.networks)
                                        )
                                    ]
                                }

                            _ ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Останній раз в етері"
                , viewData =
                    \freq ->
                        case freq.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дата прив'язки"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix freq.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Активність"
                , viewData =
                    \freq ->
                        case model.networkFreqsActivity of
                            Success data ->
                                case Dict.get freq.freq data of
                                    Just freqActivity ->
                                        let
                                            freqActivityJson =
                                                Encode.dict identity (Encode.dict identity Encode.int) (Dict.singleton freq.freq freqActivity)
                                        in
                                        { attributes = []
                                        , children =
                                            [ div [ style "width" "150px", style "height" "60px", style "cursor" "pointer", style "position" "relative", style "border-radius" "4px", style "transition" "all 0.2s ease", onClick (OpenFreqDetailPopup freq.freq) ]
                                                [ Html.node "freq-activity-chart"
                                                    [ property "data" <| freqActivityJson
                                                    , property "lastDay" <| Encode.int shared.now
                                                    ]
                                                    []
                                                , i [ class "bi bi-zoom-in", style "position" "absolute", style "top" "0", style "right" "4px", style "font-size" "12px", style "color" "#6b7280", style "opacity" "0.7", style "pointer-events" "none", style "z-index" "10", style "transition" "all 0.2s ease" ] []
                                                ]
                                            ]
                                        }

                                    Nothing ->
                                        { attributes = []
                                        , children = [ text "Немає активності" ]
                                        }

                            _ ->
                                { attributes = []
                                , children = [ Le.Block.Spinner.loadingSpinnerSm ]
                                }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "З"
                , viewData =
                    \freq ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix freq.activeFrom) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .activeFrom
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "По"
                , viewData =
                    \freq ->
                        case freq.activeTo of
                            Just x ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\freq -> Maybe.withDefault 0 freq.activeTo)
                }
                |> Table.withColumnWidth "8%"
            ]
                ++ (if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                        [ Table.veryCustomColumn
                            { name = "Дії"
                            , viewData =
                                \freq ->
                                    { attributes = [ class "col-narrow" ]
                                    , children =
                                        [ case model.network of
                                            Success network ->
                                                div [ class "flex gap-[4px] text-sm" ]
                                                    [ button
                                                        [ title "Редагувати"
                                                        , class "icon-btn icon-btn-primary"
                                                        , onClick <|
                                                            OpenFreqEditSidebar freq.freq
                                                                { networkId = network.id
                                                                , freq = freq.freq
                                                                , kind = Maybe.withDefault "VHF" freq.kind
                                                                , modulationId = freq.modulationId
                                                                , activeFrom = freq.activeFrom
                                                                , activeTo = freq.activeTo
                                                                }
                                                        ]
                                                        [ i [ class "bi bi-pencil-square" ] [] ]
                                                    , button
                                                        [ title "Видалити частоту"
                                                        , class "icon-btn icon-btn-danger"
                                                        , onClick (DeleteFreqClickedByUser freq.networkFreqId freq.freq)
                                                        ]
                                                        [ i [ class "bi bi-trash" ] [] ]
                                                    ]

                                            _ ->
                                                text ""
                                        ]
                                    }
                            , sorter = TableSorter.unsortable
                            }
                            |> Table.withColumnWidth "8%"
                        ]

                    else
                        []
                   )
        , customizations = customizations
        }
