module Pages_.RerAnalysis.MainBody exposing (view)

import Bindings as B
import Dict
import Dict.Extra as DE
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events as Events exposing (..)
import Html.Extra as HtmlX exposing (viewIf, viewMaybe)
import Html.Styled
import Json.Decode as Decode
import Json.Encode as Encode
import List.Extra as ListX exposing (frequencies)
import Pages_.RerAnalysis.Constants exposing (..)
import Pages_.RerAnalysis.Date
import Pages_.RerAnalysis.Filters
import Pages_.RerAnalysis.Graphs
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Pages_.RerAnalysis.SumTable
import Route exposing (Route)
import Route.Path
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.ModalDialog exposing (modalDialog)
import Shared.Components.RerMessage
import Shared.Components.Spinner
import Shared.Components.Toggle as Toggle
import Shared.Model exposing (isDarkMode)
import String exposing (fromInt)
import Time
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Utils exposing (..)
import Utils.Select
import Utils.Views


isLoadingStats : Model -> Bool
isLoadingStats model =
    let
        countsLoading =
            case model.counts of
                NeedsReload _ ->
                    True

                _ ->
                    RD.isLoading model.counts
    in
    countsLoading || RD.isLoading model.freqs || RD.isLoading model.callsigns || RD.isLoading model.groups || RD.isLoading model.senders


mainBody : B.User -> Model -> Shared.Model -> Route () -> List (Html Msg)
mainBody user model shared route =
    let
        masterUnitsDict =
            case shared.masterUnits of
                Success units ->
                    units

                _ ->
                    Dict.empty

        messagesShown =
            List.length model.messages

        messagesCountOverall =
            extractMRecordField (\r -> r.countOverall) 0 (RD.toMaybe model.counts)

        deleteConfirmationModal =
            modalDialog
                (model.deleteMessageModalId /= Nothing)
                DeleteMessageCancel
                [ class "max-w-md mx-auto bg-card rounded-lg shadow-lg" ]
                [ div [ class "p-6" ]
                    [ h3 [ class "text-lg font-semibold mb-4" ]
                        [ text "Видалення повідомлення" ]
                    , p [ class "text-gray-600 mb-6" ]
                        [ text "Ви впевнені, що хочете видалити це повідомлення?" ]
                    , div [ class "flex gap-3 justify-end" ]
                        [ Button.new { label = "Скасувати", onClick = DeleteMessageCancel }
                            |> Button.withSecondary
                            |> Button.view
                        , Button.new { label = "Видалити", onClick = DeleteMessageConfirm }
                            |> Button.view
                        ]
                    ]
                ]

        messagesBlock =
            if (not model.loadingInboxMessages) && List.isEmpty model.messages then
                div
                    [ class "text-center"
                    ]
                    [ text "немає жодного повідомлення для аналізу" ]

            else
                let
                    loadMoreBtn =
                        viewIf (not model.noMoreToLoad && not (List.isEmpty model.messages)) <|
                            div [ class "flex justify-center items-center mb-4" ]
                                [ Button.new { label = "завантажити ще", onClick = LoadMoreMessages }
                                    |> Button.withIcon
                                        [ i [ class "bi bi-arrow-down-circle mr-2" ] [] ]
                                    |> Button.withDisabled model.loadingInboxMessages
                                    |> Button.withSecondary
                                    |> Button.view
                                ]

                    vps =
                        { profiles = model.profiles
                        , groupInfos = model.groupInfos
                        , zone = shared.timeZone
                        , messages = model.messages
                        , tags = model.tags
                        , callsignsInfo = model.callsignsInfo
                        , messageComments = model.messageComments
                        , user = user
                        , users = model.users
                        , serverInfo = shared.serverInfo
                        , networks =
                            Dict.union
                                model.networksExtra
                                (RD.withDefault Dict.empty shared.networks)
                        , masterUnits = masterUnitsDict
                        , currentRoute = Just route
                        }

                    renderPs =
                        { hideCheckboxes = False
                        , hideIndividualSave = False
                        }
                in
                div [ class "" ]
                    [ div []
                        (List.map (Html.map RowsMsg)
                            (List.map
                                (Shared.Components.RerMessage.renderRow
                                    vps
                                    renderPs
                                    model.rowsModel
                                )
                                (enumerate model.messages)
                            )
                        )
                    , loadMoreBtn
                    ]
    in
    [ div [] <|
        [ div
            [ class "flex justify-center items-center mb-4"
            , style "position" "relative"
            ]
          <|
            [ Toggle.new { onToggle = ToggleNewestFirst, label = "спочатку нові", id = "toggle-newest-first" } |> Toggle.view model.newestFirst
            , div [ class "flex items-center mr-4 ml-[8px]" ] <|
                (if model.loadingInboxMessages then
                    [ div [ class "mr-2" ] [ Shared.Components.Spinner.loadingSpinnerSm ] ]

                 else
                    []
                )
                    ++ [ text <|
                            "показано повідомлень: "
                                ++ String.fromInt (List.length model.messages)
                       ]
            , viewIf (messagesShown < messagesCountOverall && not model.nolimitShown) <|
                div [ class "mr-4" ]
                    [ span
                        [ class "text-action cursor-pointer"
                        , onClick LoadMessagesNolimit
                        ]
                        [ i [ class "bi bi-inboxes-fill" ] []
                        , text <|
                            " показати всі "
                                ++ String.fromInt (extractMRecordField (\r -> r.countSelected) 0 (RD.toMaybe model.counts))
                        ]
                    ]
            , div [ class "mr-4" ]
                [ Button.new { label = " конструктор звітів", onClick = ToggleReportConstructor }
                    |> Button.withIcon [ i [ class "bi bi-tools" ] [] ]
                    |> Button.withSecondary
                    |> Button.view
                ]
            ]
        , messagesBlock
        , deleteConfirmationModal
        ]
    ]


analysisFeaturesBlock : Model -> Shared.Model -> Route () -> Html Msg
analysisFeaturesBlock model shared route =
    let
        newCallsignsBlock =
            let
                renderStats stats =
                    div [ class "flex justify-between items-start" ]
                        [ showTable "Нові відносно 30 днів" stats.notSeen30days
                        , showTable "Нові відносно 7 днів" stats.notSeen7days
                        , showTable "Нові відносно 24 годин" stats.notSeen24h
                        ]

                showTable title callsigns =
                    table [ class "table table-striped table-sm table-borderless" ]
                        [ thead []
                            [ tr []
                                [ th [] [ text title ]
                                ]
                            ]
                        , tbody []
                            (callsigns |> List.map (\x -> tr [] [ td [] [ text x ] ]))
                        ]
            in
            ifOrEmpty model.unfoldNewCallsignsBlock
                [ div [ class "fade-in border border-light shadow-sm p-2 mb-2 py-2" ] <|
                    [ div
                        []
                        [ Button.new { label = " завантажити", onClick = LoadNewCallsignStats }
                            |> Button.withIcon
                                [ if model.newCallsignsLoading then
                                    Shared.Components.Spinner.loadingSpinner2Sm

                                  else
                                    i [ class "bi bi-arrow-clockwise mr-2" ] []
                                ]
                            |> Button.withSecondary
                            |> Button.view
                        , div [ class "mb-2" ] [ text "тут показуватимуться позивні, які присутні в обраний період, але не їх було певний час до цього. тобто вони \"нові\" відносно різних періодів часу" ]
                        ]
                    , viewMaybe renderStats model.newCallsignsRsp
                    ]
                ]

        callsignGraphBlock =
            let
                fullHeight =
                    600
            in
            [ if model.unfoldCallsignGraph then
                div
                    [ style "position" "relative"
                    , style "transform" "translateZ(0)"
                    , class "so-visible"
                    , style "height" (String.fromInt fullHeight ++ "px")
                    ]
                <|
                    [ div
                        [ id "callsign-graph-div"
                        , style "height" (String.fromInt fullHeight ++ "px")
                        ]
                        []
                    , if model.loadingCallsignGraph then
                        Shared.Components.Spinner.loadingSpinner

                      else
                        flip viewMaybe model.callsignGraph <|
                            \callsignGraph ->
                                let
                                    shown =
                                        List.length callsignGraph.graph.nodes

                                    overall =
                                        model.callsignGraph
                                            |> Maybe.andThen .overallCount
                                            |> def 0
                                in
                                div [ class "mt-2 flex justify-center items-center" ]
                                    [ div
                                        [ class "me-2"
                                        , style "margin-bottom" ".125rem"
                                        ]
                                        [ text <|
                                            "показано "
                                                ++ String.fromInt shown
                                                ++ " з "
                                                ++ String.fromInt overall
                                                ++ " позивних "
                                        ]
                                    , div [ class "form-check form-switch" ]
                                        [ input
                                            [ class "form-check-input"
                                            , type_ "checkbox"
                                            , attribute "role" "switch"
                                            , id "callsign-graph-load-all"
                                            , checked model.callsignGraphNolimit
                                            , onClick ToggleCallsignGraphNolimit
                                            ]
                                            []
                                        , label
                                            [ class "form-check-label"
                                            , for "callsign-graph-load-all"
                                            ]
                                            [ text "показувати всі" ]
                                        ]
                                    ]
                    ]

              else
                text ""
            ]
    in
    div []
        [ div [] (ifOrEmpty model.unfoldGraphs (Pages_.RerAnalysis.Graphs.graphsBlock model shared))
        , div [ class "mb-2" ] (Pages_.RerAnalysis.SumTable.sumTableBlock model shared route)
        , div
            (if model.unfoldCallsignGraph then
                [ style "margin-bottom" "50px" ]

             else
                []
            )
            callsignGraphBlock
        , div [ class "mb-2" ] newCallsignsBlock
        ]


view : B.User -> Model -> Shared.Model -> Route () -> Html Msg
view user model shared route =
    let
        mapFeatureFlag =
            case shared.serverInfo of
                Just info ->
                    info.featureAnalysisMap

                Nothing ->
                    False

        headerCountsPill data isReloading =
            node "analysis-count-chip"
                [ attribute "selected-count" (fromInt data.countSelected)
                , attribute "overall-count" (fromInt data.countOverall)
                , attribute "is-reloading"
                    (if isReloading then
                        "true"

                     else
                        "false"
                    )
                , attribute "role" "status"
                , attribute "aria-live" "polite"
                ]
                []

        headerControls =
            div [ class "flex items-center ml-4", style "gap" "8px" ]
                [ case model.counts of
                    Success data ->
                        headerCountsPill data False

                    NeedsReload data ->
                        headerCountsPill data True

                    _ ->
                        div [ class "mr-3 inline-block", style "min-width" "60px" ] []
                , div
                    [ class "inline-flex items-stretch border border-border"
                    , style "border-radius" "2px"
                    , style "overflow" "hidden"
                    ]
                    [ button
                        [ onClick Refresh
                        , class "inline-flex items-center justify-center text-nowrap rounded-none p-1 transition-colors duration-200 ease-in-out bg-neutral-light text-text hover:bg-neutral-light-hover dark:bg-neutral-dark dark:text-w dark:hover:bg-neutral-dark-hover"
                        , style "min-height" "40px"
                        , style "min-width" "50px"
                        , style "border" "none"
                        , style "border-right" "1px solid var(--color-border)"
                        , title "Оновити"
                        ]
                        [ if isLoadingStats model then
                            Shared.Components.Spinner.loadingSpinner2Sm

                          else
                            i [ class "bi bi-arrow-clockwise" ] []
                        ]
                    , button
                        [ onClick ClearAllFilters
                        , class "inline-flex items-center justify-center text-nowrap rounded-none p-1 transition-colors duration-200 ease-in-out bg-neutral-light text-text hover:bg-neutral-light-hover dark:bg-neutral-dark dark:text-w dark:hover:bg-neutral-dark-hover"
                        , style "min-height" "40px"
                        , style "min-width" "50px"
                        , style "border" "none"
                        , title "Скинути фільтри"
                        ]
                        [ i [ class "bi bi-x-octagon" ] []
                        ]
                    ]
                , Pages_.RerAnalysis.Date.dateAndPanelsBlock (isDarkMode shared.themeMode) shared.timeZone model mapFeatureFlag
                ]

        viewReportConstructor =
            modalDialog
                model.showReportConstructor
                CloseReportConstructor
                [ class "max-w-6xl mx-auto bg-card rounded-lg shadow-lg" ]
                [ div [ class "p-6" ]
                    [ h3 [ class "text-xl font-semibold mb-6" ]
                        [ text "конструктор звітів" ]
                    , div [ class "mb-6" ] reportConstructorBlockBody
                    , div [ class "flex justify-end" ]
                        [ Button.new { label = "закрити", onClick = CloseReportConstructor }
                            |> Button.withSecondary
                            |> Button.view
                        ]
                    ]
                ]

        reportConstructorBlockBody =
            let
                templateCard active toMsg title description =
                    div
                        [ class "border rounded-lg p-6 cursor-pointer transition-all duration-200 hover:shadow-md min-h-[140px] flex flex-col justify-between relative"
                        , classList
                            [ ( "bg-white border-gray-200 hover:border-gray-300", not active && not (isDarkMode shared.themeMode) )
                            , ( "bg-gray-800 border-gray-700 hover:border-gray-600", not active && isDarkMode shared.themeMode )
                            , ( "bg-secondary-light border-secondary shadow-lg ring-2 ring-secondary-light-active", active && not (isDarkMode shared.themeMode) )
                            , ( "bg-secondary-dark border-secondary shadow-lg ring-2 ring-secondary-light-active", active && isDarkMode shared.themeMode )
                            ]
                        , onClick <| toMsg
                        ]
                        [ div []
                            [ h5
                                [ class "text-lg font-semibold mb-3"
                                , classList
                                    [ ( "text-gray-900", not (isDarkMode shared.themeMode) )
                                    , ( "text-gray-100", isDarkMode shared.themeMode )
                                    ]
                                ]
                                [ text title ]
                            , p
                                [ class "text-sm leading-relaxed"
                                , classList
                                    [ ( "text-gray-600", not (isDarkMode shared.themeMode) )
                                    , ( "text-gray-400", isDarkMode shared.themeMode )
                                    ]
                                ]
                                [ text description ]
                            ]
                        , div [ class "mt-4 flex justify-between items-center" ]
                            [ viewIf active <|
                                div
                                    [ class "px-2 py-1 rounded-full text-xs font-medium"
                                    , classList
                                        [ ( "bg-secondary-light text-secondary-dark", not (isDarkMode shared.themeMode) )
                                        , ( "bg-secondary-light-active text-secondary-dark", isDarkMode shared.themeMode )
                                        ]
                                    ]
                                    [ text "Обрано" ]
                            , div
                                [ class "w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-200"
                                , classList
                                    [ ( "bg-gray-100", not active && not (isDarkMode shared.themeMode) )
                                    , ( "bg-gray-700", not active && isDarkMode shared.themeMode )
                                    , ( "bg-secondary", active && not (isDarkMode shared.themeMode) )
                                    , ( "bg-secondary", active && isDarkMode shared.themeMode )
                                    ]
                                ]
                                [ i
                                    [ class "text-xs"
                                    , classList
                                        [ ( "text-gray-400", not active && not (isDarkMode shared.themeMode) )
                                        , ( "text-gray-500", not active && isDarkMode shared.themeMode )
                                        , ( "text-white", active )
                                        ]
                                    , class "bi bi-check"
                                    ]
                                    []
                                ]
                            ]
                        ]
            in
            [ h4
                [ class "text-lg font-semibold mb-6"
                , classList
                    [ ( "text-gray-900", not (isDarkMode shared.themeMode) )
                    , ( "text-gray-100", isDarkMode shared.themeMode )
                    ]
                ]
                [ text "шаблон" ]
            , div [ class "grid grid-cols-3 gap-4 mb-6" ]
                [ templateCard
                    (model.reportTemplate == RTTags)
                    (ReportTemplateSelect RTTags)
                    "З донесенням"
                    "Простий перелік повідомлень разом з їх донесенням"
                , templateCard
                    (model.reportTemplate == RTPelengs)
                    (ReportTemplateSelect RTPelengs)
                    "Пеленги"
                    "Таблиця з пеленгами"
                , templateCard
                    (model.reportTemplate == RTBabak)
                    (ReportTemplateSelect RTBabak)
                    "Бабак"
                    "Детальний звіт по підрозділах"
                , templateCard
                    (model.reportTemplate == RTInterception)
                    (ReportTemplateSelect RTInterception)
                    "Перехоплення"
                    "Звіт по перехопленнях"
                , templateCard
                    (model.reportTemplate == RTSenders Senders || model.reportTemplate == RTSenders Posts)
                    (ReportTemplateSelect (RTSenders Senders))
                    "Відправники"
                    "Аналіз відправників"
                , templateCard
                    (model.reportTemplate == RTPostsDocx)
                    (ReportTemplateSelect RTPostsDocx)
                    "Пости"
                    "Docx-звіт з узагальненими метриками по постах"
                , templateCard
                    (model.reportTemplate == RTMouse)
                    (ReportTemplateSelect RTMouse)
                    "Мишка"
                    "Детальний почастотний звіт по привʼязках"
                , a
                    [ class "border rounded-lg p-6 cursor-pointer transition-all duration-200 hover:shadow-md min-h-[140px] flex flex-col justify-between no-underline"
                    , classList
                        [ ( "bg-white border-gray-200 hover:border-gray-300", not (isDarkMode shared.themeMode) )
                        , ( "bg-gray-800 border-gray-700 hover:border-gray-600", isDarkMode shared.themeMode )
                        ]
                    , Route.href { path = Route.Path.RerNetworks, hash = Nothing, query = Dict.empty }
                    , target "_blank"
                    ]
                    [ div []
                        [ h5
                            [ class "text-lg font-semibold mb-3"
                            , classList
                                [ ( "text-gray-900", not (isDarkMode shared.themeMode) )
                                , ( "text-gray-100", isDarkMode shared.themeMode )
                                ]
                            ]
                            [ text "Еталонний опис р/м" ]
                        , p
                            [ class "text-sm leading-relaxed"
                            , classList
                                [ ( "text-gray-600", not (isDarkMode shared.themeMode) )
                                , ( "text-gray-400", isDarkMode shared.themeMode )
                                ]
                            ]
                            [ text "Еталонний опис радіомереж" ]
                        ]
                    , div [ class "mt-4 flex justify-end" ]
                        [ div
                            [ class "w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-200"
                            , classList
                                [ ( "bg-gray-100", not (isDarkMode shared.themeMode) )
                                , ( "bg-gray-700", isDarkMode shared.themeMode )
                                ]
                            ]
                            [ i
                                [ class "text-xs"
                                , classList
                                    [ ( "text-gray-400", not (isDarkMode shared.themeMode) )
                                    , ( "text-gray-500", isDarkMode shared.themeMode )
                                    ]
                                , class "bi bi-box-arrow-up-right"
                                ]
                                []
                            ]
                        ]
                    ]
                , templateCard
                    (model.reportTemplate == RTReo)
                    (ReportTemplateSelect RTReo)
                    "РЕО"
                    "Для генерування потрібні права редактора чи адміна"
                , templateCard
                    (model.reportTemplate == RTDigest)
                    (ReportTemplateSelect RTDigest)
                    "Дайджест"
                    "Для генерування потрібні права редактора чи адміна"
                , templateCard
                    (model.reportTemplate == ActiveNetworks)
                    (ReportTemplateSelect ActiveNetworks)
                    "Активні радіомережі"
                    "Для генерування потрібні права редактора чи адміна"
                ]
            -- Add adjacent-freqs range selector when RTReo is chosen
            , HtmlX.viewIf (model.reportTemplate == RTReo) <|
                let
                    isDark = isDarkMode shared.themeMode

                    selDescription = p
                                [ class "text-sm leading-relaxed"
                                , classList
                                    [ ( "text-gray-600", not (isDarkMode shared.themeMode) )
                                    , ( "text-gray-400", isDarkMode shared.themeMode )
                                    ]
                                ]
                                [ text "Об'єднувати суміжні частоти в діапазоні, кГц" ]

                    selItem =
                        Just
                            (Select.basicMenuItem
                                { item = model.reportAdjacentFreqsRangeSelect.selected
                                , label = String.fromFloat (model.reportAdjacentFreqsRangeSelect.selected * 1000) ++ " кГц"
                                }
                            )

                    options =
                        Utils.Select.defaultOptions isDark

                    options2 =
                        { options | clearable = False }
                in
                div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                    [ selDescription
                    , Html.map SelectReportAdjacentFreqsRange
                        (Html.Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selItem
                                model.reportAdjacentFreqsRangeSelect.state
                                model.reportAdjacentFreqsRangeSelect.items
                                "не обрано"
                                options2
                        )
                    ]
            , HtmlX.viewIf (model.reportTemplate == RTReo) <|
                let
                    isDark =
                        isDarkMode shared.themeMode

                    selDescription =
                        p
                            [ class "text-sm leading-relaxed"
                            , classList
                                [ ( "text-gray-600", not (isDarkMode shared.themeMode) )
                                , ( "text-gray-400", isDarkMode shared.themeMode )
                                ]
                            ]
                            [ text "Формат файлу" ]

                    selItem =
                        Just
                            (Select.basicMenuItem
                                { item = model.reportReoFileTypeSelect.selected
                                , label =
                                    case model.reportReoFileTypeSelect.selected of
                                        B.Docx ->
                                            "docx"

                                        B.Xlsx ->
                                            "xlsx"
                                }
                            )

                    options =
                        Utils.Select.defaultOptions isDark

                    options2 =
                        { options | clearable = False }
                in
                div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                    [ selDescription
                    , Html.map SelectReportReoFileType
                        (Html.Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selItem
                                model.reportReoFileTypeSelect.state
                                model.reportReoFileTypeSelect.items
                                "не обрано"
                                options2
                        )
                    ]

            , HtmlX.viewIf (model.reportTemplate == ActiveNetworks) <|
                let
                    isDark =
                        isDarkMode shared.themeMode

                    selDescription =
                        p
                            [ class "text-sm leading-relaxed"
                            , classList
                                [ ( "text-gray-600", not (isDarkMode shared.themeMode) )
                                , ( "text-gray-400", isDarkMode shared.themeMode )
                                ]
                            ]
                            [ text "Обрати смуги відповідальності (якщо не обрано жодної - будуть всі)" ]

                    selectedItems =
                        model.reportActiveNetworksAorsSelect.selected
                            |> List.filterMap
                                (\id ->
                                    model.allAors
                                        |> ListX.find (\entry -> entry.id == id)
                                        |> Maybe.map (\entry -> Select.basicMenuItem { item = entry.id, label = entry.name })
                                )

                    options =
                        Utils.Select.defaultOptions isDark

                    options2 =
                        options
                in
                div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                    [ selDescription
                    , Html.map SelectReportActiveNetworksAors
                        (Html.Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.reportActiveNetworksAorsSelect.state
                                model.reportActiveNetworksAorsSelect.items
                                "обрати смуги..."
                                options2
                        )
                    ]
            , HtmlX.viewIf (List.member model.reportTemplate [
            RTBabak,
            RTInterception
            ]) <|
                div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                    [ div [ class "form-check" ]
                        [ input
                            [ class "form-check-input"
                            , type_ "checkbox"
                            , checked model.withoutModelTags
                            , id "report-without-model-tags"
                            , onClick ReportTagsWithoutBotTagsToggle
                            ]
                            []
                        , label
                            [ class "form-check-label"
                            , for "report-without-model-tags"
                            ]
                            [ text "без автоматичних тегів" ]
                        ]
                    ]
            , HtmlX.viewIf (List.member model.reportTemplate [
            RTTags,
            RTPelengs,
            RTBabak,
            RTInterception,
            RTPostsDocx,
            RTMouse,
            RTReo
             ]) <|
                div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                    [ div [ class "form-check" ]
                        [ input
                            [ class "form-check-input"
                            , type_ "checkbox"
                            , checked model.reportTagsOnlyThisUnitForReport
                            , id "report-tags-only-this-unit-docx"
                            , onClick <| ReportTagsOnlyThisUnitForReportToggle
                            ]
                            []
                        , label
                            [ class "form-check-label"
                            , for "report-tags-only-this-unit-docx"
                            ]
                            [ text "лише теги/коментарі мого підрозділу"
                            ]
                        ]
                    ]
            , case model.reportTemplate of
                RTSenders x ->
                    div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                        [ div [ class "form-check" ]
                            [ input
                                [ class "form-check-input"
                                , type_ "checkbox"
                                , checked <| model.reportTemplate == RTSenders Posts
                                , id "senders-posts-checkbox"
                                , onClick <|
                                    ReportTemplateSelect
                                        (RTSenders
                                            (if x == Posts then
                                                Senders

                                             else
                                                Posts
                                            )
                                        )
                                ]
                                []
                            , label
                                [ class "form-check-label"
                                , for "senders-posts-checkbox"
                                ]
                                [ text "шукати по постах"
                                ]
                            ]
                        , div [ class "form-check mt-2" ]
                            [ input
                                [ class "form-check-input"
                                , type_ "checkbox"
                                , checked model.reportAdvancedSenders
                                , id "senders-advanced-checkbox"
                                , onClick ReportAdvancedSendersToggle
                                ]
                                []
                            , label
                                [ class "form-check-label"
                                , for "senders-advanced-checkbox"
                                ]
                                [ text
                                    (if x == Posts then
                                        "розширений звіт (пости)"

                                     else
                                        "розширений звіт (профілі)"
                                    )
                                ]
                            ]
                        ]

                _ ->
                    HtmlX.nothing
            , div [ class "flex justify-center items-center mb-4" ]
                [ Button.new { label = " завантажити docx/xlsx", onClick = ReportDownloadDocx }
                    |> Button.withIcon
                        [ if model.reportDownloadInProgress then
                            span [ class "me-1" ] [ Shared.Components.Spinner.loadingSpinner2Sm ]

                          else
                            i [ class "bi bi-filetype-docx" ] []
                        ]
                    |> Button.view
                ]
            ]

        mapBlock =
            case ( model.from.datePosix, model.to.datePosix ) of
                ( Just fromPosix, Just toPosix ) ->
                    let
                        dates =
                            { startDate = Time.posixToMillis fromPosix, endDate = Time.posixToMillis toPosix }

                        encodedDates =
                            Encode.object
                                [ ( "startDate", Encode.int dates.startDate )
                                , ( "endDate", Encode.int dates.endDate )
                                ]

                        points =
                            RD.withDefault [] model.mapPoints

                        encodedPoints =
                            Encode.list B.freqDetailedPointEncoder points

                        dateRangeDecoder =
                            Decode.at [ "detail" ] <|
                                Decode.map2 (\startDate endDate -> { startDate = startDate, endDate = endDate })
                                    (Decode.field "startDate" Decode.int)
                                    (Decode.field "endDate" Decode.int)

                        messagesIdsDecoder =
                            Decode.at [ "detail" ] <|
                                Decode.field "messageIds" (Decode.list Decode.int)

                        unitNameDecoder =
                            Decode.at [ "detail" ] <|
                                Decode.field "networkUnitName" Decode.string

                        encodedMessages =
                            Encode.list (\( a, b ) -> Encode.list identity [ Encode.int a, B.inboxMessageEncoder b ])
                                (RD.withDefault [] model.mapOpenMessages)

                        --TODO: додати обробку пустої частоти, що має відбуватися?
                        allFreqs =
                            RD.withDefault [] model.mapOpenMessages |> List.map Tuple.second |> List.filterMap .freq

                        filteredNetworkUnits =
                            model.mapNetworkUnits |> List.filter (\n -> List.any (\freq -> List.member freq allFreqs) n.frequencies)

                        encodedNetworkUnits =
                            Encode.list B.networkUnitEncoder filteredNetworkUnits

                        encodedMessagesAndUnits =
                            Encode.object [ ( "networkUnits", encodedNetworkUnits ), ( "messages", encodedMessages ) ]

                        encodedSelectedUnits =
                            Encode.list Encode.string model.unitsSelected
                        
                        ( encodedPalitras, palitrasLoaded ) =
                            case model.palitras of
                                Success palitras ->
                                    ( Encode.list B.palitraDetailsEncoder palitras, True )

                                _ ->
                                    ( Encode.list B.palitraDetailsEncoder [], False )
                    in
                    div
                        (class "h-full min-h-0 relative"
                            :: (if not model.unfoldMapBlock then
                                    [ class "h-0" ]

                                else
                                    []
                               )
                        )
                        (Html.node "analysis-map"
                            [ class "h-full block z-10"
                            , attribute "daterange" (Encode.encode 0 encodedDates)
                            , attribute "points" (Encode.encode 0 encodedPoints)
                            , attribute "messages" (Encode.encode 0 encodedMessagesAndUnits)
                            , attribute "selected-units" (Encode.encode 0 encodedSelectedUnits)
                            , attribute "palitras" (Encode.encode 0 encodedPalitras)
                            , attribute "palitras-loaded" (Encode.encode 0 (Encode.bool palitrasLoaded))
                            , attribute "visibility"
                                (if model.unfoldMapBlock then
                                    "true"

                                 else
                                    "false"
                                )
                            , Events.on "exit" (Decode.succeed MapClosed)
                            , Events.on "date-range-changed" (Decode.map MapPeriodChanged dateRangeDecoder)
                            , Events.on "load-messages-description" (Decode.map LoadMessagesForMap messagesIdsDecoder)
                            , Events.on "message-unit-clicked" (Decode.map SetUnitFilterFromMap unitNameDecoder)
                            ]
                            []
                            :: (if model.mapPoints == Loading || model.mapOpenMessages == Loading then
                                    [ div [ class "absolute z-10 top-0 left-0 right-0 bottom-0 flex justify-center items-center" ]
                                        [ div [ class "animate-spin border-4 border-gray-300 border-t-blue-600 rounded-full w-8 h-8 relative z-20" ] []
                                        ]
                                    , div [ class "absolute z-20 top-0 left-0 right-0 bottom-0 bg-gray-100 opacity-25" ] []
                                    ]

                                else
                                    []
                               )
                        )

                _ ->
                    div [] []
    in
    div [ class "bg-[var(--background-color)]" ]
        [ -- viewIf model.showReportConstructor reportConstructorBlock
          viewReportConstructor
        , div
            [ class "page-rer-analysis overflow-y-hidden grid grid-cols-24 gap-2 app-shell-fill-height" ]
            [ div
                [ class "overflow-auto text-sm col-span-5 h-full "
                ]
                [ Pages_.RerAnalysis.Filters.view (isDarkMode shared.themeMode) user model ]
            , div
                [ class "col-span-19 flex flex-col h-full min-h-0 relative overflow-auto pt-4"
                , id "messages-div"
                ]
                [ div
                    [ class "fixed bottom-[20px] right-[30px] opacity-50 z-55"
                    , onClick <| ScrollMessagesToTop
                    ]
                    [ span [ class "text-[2rem] cursor-pointer" ]
                        [ i [ class "bi bi-arrow-up-circle" ] [] ]
                    ]
                , div
                    [ class "sticky top-0 z-50 bg-[var(--background-color)]"
                    ]
                    [ div [ class "flex items-center justify-between px-4 mb-6" ]
                        [ div [ class "flex items-center" ]
                            [ h1 [ class "text-xl font-semibold" ] [ text "аналіз" ]
                            , headerControls
                            ]
                        ]
                    ]
                , div
                    [ class "flex-grow min-h-0 ml-2 mr-6" ]
                    (mapBlock
                        :: (if not model.unfoldMapBlock then
                                [ div []
                                    [ analysisFeaturesBlock model shared route
                                    , div [] (mainBody user model shared route)
                                    ]
                                ]

                            else
                                [ div [] [] ]
                           )
                    )
                ]
            ]
        ]
