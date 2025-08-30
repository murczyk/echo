module RerNetworks.Id_.CallsignsTables exposing (..)

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
import RerNetworks.Id_.FrequenciesTable as FreqsTable
import RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), Model, ShowAllPopupFor(..))
import RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import RerNetworks.Id_.Utils as IdUtils
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



-- Helper functions for filtering callsigns


getRegularCallsigns : List B.NetworkCallsign -> List B.NetworkCallsign
getRegularCallsigns callsigns =
    List.filter (\callsign -> not callsign.developing) callsigns


getDevelopingCallsigns : List B.NetworkCallsign -> List B.NetworkCallsign
getDevelopingCallsigns callsigns =
    List.filter (\callsign -> callsign.developing) callsigns


viewCallsigns callsigns model user shared =
    div [ class "flex flex-col flex-1" ]
        [ div [ class "overflow-y-auto flex-1" ]
            [ let
                -- Перетворюємо дані у плоску структуру для таблиці
                allCallsignsTableRows =
                    callsigns
                        |> List.concatMap
                            (\callsign ->
                                case callsign.knownCallsigns of
                                    Just knownCallsigns ->
                                        List.map
                                            (\knownCallsign ->
                                                { id = knownCallsign.id
                                                , callsign = callsign.callsign
                                                , messageCount = callsign.messageCount
                                                , lastDatetime = callsign.lastDatetime
                                                , position = knownCallsign.position
                                                , unitName = knownCallsign.unitName
                                                , comment = knownCallsign.comment
                                                , createdAt = knownCallsign.createdAt
                                                , sourceName = knownCallsign.sourceName
                                                }
                                            )
                                            knownCallsigns

                                    Nothing ->
                                        []
                            )

                -- Спочатку сортуємо всі дані, потім застосовуємо пагінацію
                sortedCallsigns =
                    Table.getSortedData (callsignsTableConfig shared model user) model.callsignsTableState allCallsignsTableRows

                paginatedCallsigns =
                    Pager.getPageData model.callsignsPager sortedCallsigns

                callsignsUnknown =
                    callsigns
                        |> List.filterMap
                            (\callsign ->
                                case callsign.knownCallsigns of
                                    Just knownCallsigns ->
                                        if List.isEmpty knownCallsigns then
                                            Just callsign.callsign

                                        else
                                            Nothing

                                    Nothing ->
                                        Just callsign.callsign
                            )
              in
              div [ class "table-responsive-modern" ]
                [ -- Таблиця "Всі позивні" (з пагінацією)
                  Table.view (callsignsTableConfig shared model user) model.callsignsTableState paginatedCallsigns
                , -- Пейджер для таблиці
                  Pager.view model.callsignsPager
                    |> Html.map CallsignsPagerMsg
                , div [ class "mt-4 p-3 bg-[var(--color-bg-muted)] rounded" ]
                    [ span [ class "font-medium" ] [ text "Присутні в перехопленнях: " ]
                    , div [ class "flex flex-wrap gap-[4px] text-[13px] mt-2" ]
                        (List.map
                            (\c ->
                                let
                                    config =
                                        DropdownBadge.config
                                            (String.toUpper c)
                                            (model.unknownCallsignDropdown == Just c)
                                            (ToggleUnknownCallsignDropdown c)
                                            CloseUnknownCallsignDropdown
                                            [ DropdownBadge.InternalAction
                                                { icon = "bi-plus"
                                                , label = "Додати"
                                                , action = OpenAddFromUnknownSidebar c
                                                }
                                            , DropdownBadge.ExternalLink
                                                { icon = "bi-arrow-right"
                                                , label = "Проаналізувати"
                                                , url = IdUtils.createAnalysisUrl shared model c
                                                }
                                            ]
                                in
                                DropdownBadge.view
                                    (DropdownBadge.withAutoDirection DropdownBadge.Up config)
                            )
                            callsignsUnknown
                        )
                    ]
                ]
            ]
        ]


viewNetworkCallsigns networkCallsigns model user shared =
    let
        -- Використовуємо helper функцію для фільтрації звичайних позивних
        regularCallsigns =
            getRegularCallsigns networkCallsigns

        -- Спочатку сортуємо всі дані, потім застосовуємо пагінацію
        sortedCallsigns =
            Table.getSortedData (networkCallsignsTableConfig shared model user) model.networkCallsignsTableState regularCallsigns

        paginatedCallsigns =
            Pager.getPageData model.networkCallsignsPager sortedCallsigns
    in
    div [ class "flex flex-col flex-1 mb-2" ]
        [ div [ class "overflow-y-auto flex-1" ]
            [ Table.view (networkCallsignsTableConfig shared model user) model.networkCallsignsTableState paginatedCallsigns
            ]
        , Pager.view model.networkCallsignsPager
            |> Html.map NetworkCallsignsPagerMsg
        ]


callsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config CallsignTableRow Msg
callsignsTableConfig shared model user =
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

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    Table.customConfig
        { toId = .callsign
        , toMsg = SetCallsignsTableState
        , columns =
            [ Table.veryCustomColumn
                { name = ""
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ let
                                isAdding =
                                    Set.member row.id model.callsignAddingInProgress
                              in
                              button
                                [ class <|
                                    if isAdding then
                                        "icon-btn icon-btn-primary opacity-50 cursor-not-allowed"

                                    else
                                        "icon-btn icon-btn-primary"
                                , title <|
                                    if isAdding then
                                        "Додається до мережі..."

                                    else
                                        "Додати до мережі"
                                , if isAdding then
                                    attribute "disabled" "true"

                                  else
                                    onClick (AddCallsignToNetwork row.id)
                                ]
                                [ if isAdding then
                                    Le.Block.Spinner.loadingSpinner2Sm

                                  else
                                    i [ class "bi bi-plus" ] []
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "4%"
            , Table.veryCustomColumn
                { name = "Позивний"
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ div [ class "flex items-center flex-wrap" ]
                                [ text <| String.toUpper row.callsign
                                , a
                                    [ href (IdUtils.createAnalysisUrl shared model row.callsign)
                                    , target "_blank"
                                    , title "Відкрити позивний в аналізі"
                                    , class "ml-2"
                                    ]
                                    [ i [ class "bi bi-box-arrow-up-right text-action text-sm" ] [] ]
                                ]
                            ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .callsign
                }
                |> Table.withColumnWidth "13%"
            , Table.intColumn "К-сть" .messageCount |> Table.withColumnWidth "6%"
            , Table.veryCustomColumn
                { name = "Останній раз в етері"
                , viewData =
                    \row ->
                        case row.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\row -> Maybe.withDefault 0 row.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Посада"
                , viewData = \row -> { attributes = [], children = [ text row.position ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Підрозділ"
                , viewData = \row -> { attributes = [], children = [ text row.unitName ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "18%"
            , Table.veryCustomColumn
                { name = "Коментар"
                , viewData =
                    \row ->
                        { attributes = [ class "relative" ]
                        , children =
                            [ div [ class "flex flex-col gap-2" ]
                                [ div
                                    [ class "comment-preview"
                                    , style "max-height" "4.5rem" -- ~3 рядки
                                    , style "overflow" "hidden"
                                    , style "white-space" "pre-line"
                                    ]
                                    [ text row.comment ]
                                , if String.length row.comment > 100 then
                                    let
                                        isOpen =
                                            case model.rowShowAllPopupStatus of
                                                Just ( callsignId, ShowAllComment ) ->
                                                    callsignId == row.id

                                                _ ->
                                                    False
                                    in
                                    Popup.new
                                        { body =
                                            span
                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                ]
                                                [ text "Показати повністю"
                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                ]
                                        , popupBody =
                                            div [ class "comment-popup-content p-4" ]
                                                [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                    [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                        [ text "Повний коментар" ]
                                                    ]
                                                , div [ class "whitespace-pre-line text-sm" ]
                                                    [ text row.comment ]
                                                ]
                                        , isOpen = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( row.id, ShowAllComment )
                                        , disabled = False
                                        }
                                        |> Popup.view

                                  else
                                    text ""
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Дата прив'язки"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix row.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "12%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData = \row -> { attributes = [], children = [ span [ class "text-sm" ] [ text row.sourceName ] ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "10%"
            ]
        , customizations = customizations
        }


networkCallsignsTableConfig : Shared.Model -> Model -> Auth.User -> Table.Config B.NetworkCallsign Msg
networkCallsignsTableConfig shared model user =
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

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    Table.customConfig
        { toId = String.fromInt << .id
        , toMsg = SetNetworkCallsignsTableState
        , columns =
            [ Table.veryCustomColumn
                { name = ""
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ button
                                [ class "icon-btn icon-btn-danger"
                                , title "Відв'язати від мережі"
                                , onClick (DeleteCallsignFromNetwork row.id)
                                ]
                                [ i [ class "bi bi-dash" ] [] ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "4%"
            , Table.veryCustomColumn
                { name = "Позивний"
                , viewData =
                    \row ->
                        let
                            callsignText =
                                String.toUpper row.callsign

                            callsignContent =
                                if row.mainRadioStation then
                                    [ text callsignText
                                    , span [ class "ml-2 badge badge-main-radio" ]
                                        [ text "ГВЗ" ]
                                    ]

                                else
                                    [ text callsignText ]
                        in
                        { attributes = [], children = callsignContent }
                , sorter = TableSorter.increasingOrDecreasingBy .callsign
                }
                |> Table.withColumnWidth "12%"
            , Table.intColumn "К-сть" .messageCount |> Table.withColumnWidth "7%"
            , Table.veryCustomColumn
                { name = "Остання активність"
                , viewData =
                    \row ->
                        case row.lastDatetime of
                            Just lastDatetime ->
                                { attributes = []
                                , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix lastDatetime) ]
                                }

                            Nothing ->
                                { attributes = []
                                , children = [ text "-" ]
                                }
                , sorter = TableSorter.increasingOrDecreasingBy (\row -> Maybe.withDefault 0 row.lastDatetime)
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Посада"
                , viewData = \row -> { attributes = [], children = [ text (Maybe.withDefault "-" row.position) ] }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "14%"
            , Table.veryCustomColumn
                { name = "Підрозділ"
                , viewData =
                    \row ->
                        let
                            unitText =
                                Maybe.withDefault "-" row.unitName

                            unitContent =
                                if row.unitDeveloping then
                                    [ text unitText
                                    , span [ class "ml-2 badge badge-no-unit" ]
                                        [ text "в дорозвідці" ]
                                    ]

                                else
                                    [ text unitText ]
                        in
                        { attributes = [], children = unitContent }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "16%"
            , Table.veryCustomColumn
                { name = "Коментар"
                , viewData =
                    \row ->
                        { attributes = [ class "relative" ]
                        , children =
                            [ div [ class "flex flex-col gap-2" ]
                                [ div
                                    [ class "comment-preview"
                                    , style "max-height" "4.5rem" -- ~3 рядки
                                    , style "overflow" "hidden"
                                    , style "white-space" "pre-line"
                                    ]
                                    [ text (Maybe.withDefault "-" row.comment) ]
                                , if String.length (Maybe.withDefault "" row.comment) > 100 then
                                    let
                                        isOpen =
                                            case model.rowShowAllPopupStatus of
                                                Just ( callsignId, ShowAllComment ) ->
                                                    callsignId == row.id

                                                _ ->
                                                    False
                                    in
                                    Popup.new
                                        { body =
                                            span
                                                [ class "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                                ]
                                                [ text "Показати повний коментар"
                                                , i [ class "bi bi-chevron-down text-xs" ] []
                                                ]
                                        , popupBody =
                                            div [ class "comment-popup-content p-4" ]
                                                [ div [ class "mb-3 pb-2 border-b border-gray-200 dark:border-gray-700" ]
                                                    [ h4 [ class "text-sm font-semibold text-gray-900 dark:text-gray-100" ]
                                                        [ text "Повний коментар" ]
                                                    ]
                                                , div [ class "whitespace-pre-line text-sm" ]
                                                    [ text (Maybe.withDefault "-" row.comment) ]
                                                ]
                                        , isOpen = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( row.id, ShowAllComment )
                                        , disabled = False
                                        }
                                        |> Popup.view

                                  else
                                    text ""
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Дата створення"
                , viewData =
                    \row ->
                        { attributes = []
                        , children = [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix row.createdAt) ]
                        }
                , sorter = TableSorter.increasingOrDecreasingBy .createdAt
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Джерело"
                , viewData =
                    \row ->
                        { attributes = []
                        , children =
                            [ case row.sourceId of
                                Just sourceId ->
                                    case ListX.find (\s -> s.id == sourceId) model.callsignCreateSources of
                                        Just source ->
                                            div []
                                                [ span [ class "text-sm" ] [ text source.name ]
                                                , if sourceId == 2 && row.radioFreq /= Nothing then
                                                    span [ class "text-xs text-muted-foreground ml-1" ]
                                                        [ text <| Maybe.withDefault "" row.radioFreq ]

                                                  else
                                                    text ""
                                                ]

                                        Nothing ->
                                            span [ class "text-sm" ] [ text (String.fromInt sourceId) ]

                                Nothing ->
                                    text "-"
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "8%"
            , Table.veryCustomColumn
                { name = "Дії"
                , viewData =
                    \row ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ div [ class "flex gap-[4px] text-sm" ]
                                [ button
                                    [ title "Редагувати"
                                    , class "icon-btn icon-btn-primary"
                                    , onClick (EditCallsignClicked row.id)
                                    ]
                                    [ i [ class "bi bi-pencil" ] [] ]
                                ]
                            ]
                        }
                , sorter = TableSorter.unsortable
                }
                |> Table.withColumnWidth "5%"
            ]
        , customizations = customizations
        }
