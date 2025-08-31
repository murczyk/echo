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



-- SIDEBAR CONTENTS


callsignCreateSidebarContent : Shared.Model -> Model -> Auth.User -> Html Msg
callsignCreateSidebarContent shared model user =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити позивний мережі" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позивний *" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позивний"
                        , value (Maybe.map .callsign model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just { s | callsign = String.toUpper v }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .mainRadioStation model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | mainRadioStation = not s.mainRadioStation }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Головна радіостанція" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })

                        selectItem =
                            Maybe.andThen .sourceId model.callsignCreateState
                                |> Maybe.andThen
                                    (\sourceId ->
                                        ListX.find (\s -> s.id == sourceId) model.callsignCreateSources
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                    )
                      in
                      Html.map CallsignCreateSourceSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectItem
                                model.callsignCreateSourceSelState
                                sourceMenu
                                "Виберіть джерело (необов'язково)"
                                (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                    |> (\opts ->
                                            { opts
                                                | clearable = True
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Підрозділ" ]
                    , div [ class "flex items-center gap-2 p-2 border border-border rounded bg-gray-50 dark:bg-gray-700" ]
                        [ span [ class "text-sm text-gray-700 dark:text-gray-300" ]
                            [ text
                                (case Maybe.andThen .unitId model.callsignCreateState of
                                    Just unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault "Невідомий підрозділ"

                                            _ ->
                                                "Завантаження..."

                                    Nothing ->
                                        -- Показуємо назву першого підрозділу мережі
                                        case model.editUnitsSelect.selected of
                                            firstUnitId :: _ ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get firstUnitId units
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault "Підрозділ мережі"

                                                    _ ->
                                                        "Підрозділ мережі"

                                            [] ->
                                                "Підрозділ мережі"
                                )
                            ]
                        , button
                            [ type_ "button"
                            , class "text-blue-600 hover:text-blue-800 text-sm"
                            , title "Змінити підрозділ"
                            , onClick ToggleCallsignCreateUnitSelector
                            ]
                            [ text "✏️" ]
                        , button
                            [ type_ "button"
                            , class "text-gray-600 hover:text-gray-800 text-sm"
                            , title "Повернути підрозділ мережі"
                            , onClick ResetCallsignCreateUnit
                            ]
                            [ text "✖️" ]
                        ]
                    , if model.callsignCreateUnitSelectorVisible then
                        -- Показуємо селект підрозділів
                        div [ class "mt-2" ]
                            [ let
                                unitMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            Dict.values units |> List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            []

                                selectedUnit =
                                    Maybe.andThen .unitId model.callsignCreateState
                                        |> Maybe.andThen
                                            (\unitId ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get unitId units
                                                            |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                                    _ ->
                                                        Nothing
                                            )
                              in
                              Html.map CallsignCreateUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectedUnit
                                        model.callsignCreateUnitSelState
                                        unitMenu
                                        "Виберіть підрозділ"
                                        (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                            |> (\opts ->
                                                    { opts
                                                        | clearable = True
                                                    }
                                               )
                                        )
                            ]

                      else
                        text ""
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .unitDeveloping model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | unitDeveloping = not s.unitDeveloping }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Підрозділ в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Посада" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть посаду (необов'язково)"
                        , value (Maybe.andThen .position model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | position =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Коментар" ]
                    , textarea
                        [ class "w-full p-2 border border-border rounded resize-none"
                        , rows 3
                        , placeholder "Введіть коментар (необов'язково)"
                        , value (Maybe.andThen .comment model.callsignCreateState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateCallsignCreateField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | comment =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .developing model.callsignCreateState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateCallsignCreateField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | developing = not s.developing }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Позначити як позивний в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , if Maybe.andThen .sourceId model.callsignCreateState == Just 2 then
                    div []
                        [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота *" ]
                        , input
                            [ type_ "text"
                            , class "w-full p-2 border border-border rounded"
                            , placeholder "Введіть частоту (обов'язково для РО)"
                            , value (Maybe.andThen .radioFreq model.callsignCreateState |> Maybe.withDefault "")
                            , onInput <|
                                UpdateCallsignCreateField
                                    << (\v maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just
                                                        { s
                                                            | radioFreq =
                                                                if String.trim v == "" then
                                                                    Nothing

                                                                else
                                                                    Just v
                                                        }

                                                Nothing ->
                                                    Nothing
                                       )
                            ]
                            []
                        ]

                  else
                    text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCallsignCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.callsignCreateSaving then
                    Button.new { label = "Створення...", onClick = CreateCallsignClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Створити", onClick = CreateCallsignClicked }
                        |> Button.withDisabled
                            (let
                                callsignEmpty =
                                    Maybe.map .callsign model.callsignCreateState
                                        |> Maybe.map (String.trim >> (==) "")
                                        |> Maybe.withDefault True

                                isRO =
                                    Maybe.andThen .sourceId model.callsignCreateState == Just 2

                                roFreqEmpty =
                                    if isRO then
                                        Maybe.andThen .radioFreq model.callsignCreateState
                                            |> Maybe.map (String.trim >> (==) "")
                                            |> Maybe.withDefault True

                                    else
                                        False
                             in
                             callsignEmpty || roFreqEmpty
                            )
                        |> Button.view
                ]
            ]
        ]


editCallsignSidebarContent : Shared.Model -> Model -> B.User -> Html Msg
editCallsignSidebarContent shared model user =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 overflow-y-auto" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Редагувати позивний мережі" ]
            , div [ class "space-y-4" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Позивний *" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть позивний"
                        , value (Maybe.map .callsign model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just { s | callsign = String.toUpper v }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .mainRadioStation model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | mainRadioStation = not s.mainRadioStation }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Головна радіостанція" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Джерело" ]
                    , let
                        sourceMenu =
                            model.callsignCreateSources
                                |> List.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })

                        selectItem =
                            Maybe.andThen .sourceId model.editCallsignState
                                |> Maybe.andThen
                                    (\sourceId ->
                                        ListX.find (\s -> s.id == sourceId) model.callsignCreateSources
                                            |> Maybe.map (\source -> Select.basicMenuItem { item = source.id, label = source.name })
                                    )
                      in
                      Html.map EditCallsignSourceSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectItem
                                model.editCallsignSourceSelState
                                sourceMenu
                                "Виберіть джерело (необов'язково)"
                                (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                    |> (\opts ->
                                            { opts
                                                | clearable = True
                                            }
                                       )
                                )
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Підрозділ" ]
                    , div [ class "flex items-center gap-2 p-2 border border-border rounded bg-gray-50 dark:bg-gray-700" ]
                        [ span [ class "text-sm text-gray-700 dark:text-gray-300" ]
                            [ text
                                (case Maybe.andThen .unitId model.editCallsignState of
                                    Just unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault "Невідомий підрозділ"

                                            _ ->
                                                "Завантаження..."

                                    Nothing ->
                                        -- Показуємо назву першого підрозділу мережі
                                        case model.editUnitsSelect.selected of
                                            firstUnitId :: _ ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get firstUnitId units
                                                            |> Maybe.map .name
                                                            |> Maybe.withDefault "Підрозділ мережі"

                                                    _ ->
                                                        "Підрозділ мережі"

                                            [] ->
                                                "Підрозділ мережі"
                                )
                            ]
                        , button
                            [ type_ "button"
                            , class "text-blue-600 hover:text-blue-800 text-sm"
                            , title "Змінити підрозділ"
                            , onClick ToggleEditCallsignUnitSelector
                            ]
                            [ text "✏️" ]
                        , button
                            [ type_ "button"
                            , class "text-gray-600 hover:text-gray-800 text-sm"
                            , title "Повернути підрозділ мережі"
                            , onClick ResetEditCallsignUnit
                            ]
                            [ text "✖️" ]
                        ]
                    , if model.editCallsignUnitSelectorVisible then
                        -- Показуємо селект підрозділів
                        div [ class "mt-2" ]
                            [ let
                                unitMenu =
                                    case shared.masterUnits of
                                        Success units ->
                                            Dict.values units |> List.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            []

                                selectedUnit =
                                    Maybe.andThen .unitId model.editCallsignState
                                        |> Maybe.andThen
                                            (\unitId ->
                                                case shared.masterUnits of
                                                    Success units ->
                                                        Dict.get unitId units
                                                            |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                                    _ ->
                                                        Nothing
                                            )
                              in
                              Html.map EditCallsignUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectedUnit
                                        model.editCallsignUnitSelState
                                        unitMenu
                                        "Виберіть підрозділ"
                                        (Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                                            |> (\opts ->
                                                    { opts
                                                        | clearable = True
                                                    }
                                               )
                                        )
                            ]

                      else
                        text ""
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .unitDeveloping model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | unitDeveloping = not s.unitDeveloping }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Підрозділ в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Посада" ]
                    , input
                        [ type_ "text"
                        , class "w-full p-2 border border-border rounded"
                        , placeholder "Введіть посаду (необов'язково)"
                        , value (Maybe.andThen .position model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | position =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Коментар" ]
                    , textarea
                        [ class "w-full p-2 border border-border rounded resize-none"
                        , rows 3
                        , placeholder "Введіть коментар (необов'язково)"
                        , value (Maybe.andThen .comment model.editCallsignState |> Maybe.withDefault "")
                        , onInput <|
                            UpdateEditCallsignField
                                << (\v maybeState ->
                                        case maybeState of
                                            Just s ->
                                                Just
                                                    { s
                                                        | comment =
                                                            if String.trim v == "" then
                                                                Nothing

                                                            else
                                                                Just v
                                                    }

                                            Nothing ->
                                                Nothing
                                   )
                        ]
                        []
                    ]
                , div []
                    [ div [ class "flex items-center" ]
                        [ Checkbox.new
                            { isChecked = Maybe.map .developing model.editCallsignState |> Maybe.withDefault False
                            , onToggle =
                                \_ ->
                                    UpdateEditCallsignField
                                        (\maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just { s | developing = not s.developing }

                                                Nothing ->
                                                    Nothing
                                        )
                            }
                            |> Checkbox.withContent [ text "Позначити як позивний в дорозвідці" ]
                            |> Checkbox.view
                        ]
                    ]
                , if Maybe.andThen .sourceId model.editCallsignState == Just 2 then
                    div []
                        [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота *" ]
                        , input
                            [ type_ "text"
                            , class "w-full p-2 border border-border rounded"
                            , placeholder "Введіть частоту (обов'язково для РО)"
                            , value (Maybe.andThen .radioFreq model.editCallsignState |> Maybe.withDefault "")
                            , onInput <|
                                UpdateEditCallsignField
                                    << (\v maybeState ->
                                            case maybeState of
                                                Just s ->
                                                    Just
                                                        { s
                                                            | radioFreq =
                                                                if String.trim v == "" then
                                                                    Nothing

                                                                else
                                                                    Just v
                                                        }

                                                Nothing ->
                                                    Nothing
                                       )
                            ]
                            []
                        ]

                  else
                    text ""

                -- Display errors if any
                , case Dict.get "general" model.editCallsignErrors of
                    Just error ->
                        div [ class "p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm" ]
                            [ text error ]

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseEditCallsignSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.editCallsignSaving then
                    Button.new { label = "Збереження...", onClick = SaveEditCallsignClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Зберегти", onClick = SaveEditCallsignClicked }
                        |> Button.withDisabled
                            (let
                                callsignEmpty =
                                    Maybe.map .callsign model.editCallsignState
                                        |> Maybe.map (String.trim >> (==) "")
                                        |> Maybe.withDefault True

                                isRO =
                                    Maybe.andThen .sourceId model.editCallsignState == Just 2

                                roFreqEmpty =
                                    if isRO then
                                        Maybe.andThen .radioFreq model.editCallsignState
                                            |> Maybe.map (String.trim >> (==) "")
                                            |> Maybe.withDefault True

                                    else
                                        False
                             in
                             callsignEmpty || roFreqEmpty
                            )
                        |> Button.view
                ]
            ]
        ]
