module RerAnalysis.MainBody exposing (filtersAndMainContent)

import Bindings as B
import Components.Button as Button
import Components.ModalDialog exposing (modalDialog)
import Components.Toggle as Toggle
import Dict
import Dict.Extra as DE
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events as Events exposing (..)
import Html.Extra as HtmlX exposing (viewIf, viewMaybe)
import Json.Decode as Decode
import Json.Encode as Encode
import Le.Block.Spinner
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.RerMessage
import Le.Utils exposing (..)
import List.Extra exposing (frequencies)
import RerAnalysis.Constants exposing (..)
import RerAnalysis.Date
import RerAnalysis.Filters
import RerAnalysis.Graphs
import RerAnalysis.Model exposing (..)
import RerAnalysis.Msg exposing (..)
import RerAnalysis.SumTable
import Route exposing (Route)
import Route.Path
import Set
import Shared
import String exposing (fromInt)
import Time
import Views


isLoadingStats : Model -> Bool
isLoadingStats model =
    RD.isLoading model.counts || RD.isLoading model.freqs || RD.isLoading model.callsigns || RD.isLoading model.groups || RD.isLoading model.senders


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
            case model.counts |> RD.toMaybe |> mmap (\r -> r.countOverall) of
                Just 0 ->
                    div
                        [ class "text-center"
                        ]
                        [ text "немає жодного повідомлення для аналізу" ]

                _ ->
                    let
                        loadMoreBtn =
                            viewIf (not model.noMoreToLoad && not (List.isEmpty model.messages)) <|
                                div [ class "flex justify-center items-center mb-4" ]
                                    [ Button.new { label = "завантажити ще", onClick = LoadMoreMessages }
                                        |> Button.withIcon
                                            [ if model.loadingInboxMessages then
                                                Le.Block.Spinner.loadingSpinner2Sm

                                              else
                                                i [ class "bi bi-arrow-down-circle mr-2" ] []
                                            ]
                                        |> Button.withSecondary
                                        |> Button.view
                                    ]

                        vps =
                            { profiles = model.profiles
                            , groupInfos = model.groupInfos
                            , zone = model.zone
                            , messages = model.messages
                            , tags = model.tags
                            , bookmarks = model.bookmarks
                            , importants = model.importants
                            , callsignsInfo = model.callsignsInfo
                            , messageComments = model.messageComments
                            , user = user
                            , users = model.users
                            , serverInfo = shared.serverInfo
                            , networks = RD.withDefault Dict.empty shared.networks
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
                                    (Le.RerMessage.renderRow
                                        vps
                                        renderPs
                                        model.rowsModel
                                        model.formErrors
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
            [ if isLoadingStats model then
                div [ class "mr-2" ] [ Le.Block.Spinner.loadingSpinnerSm ]

              else
                div [ style "width" "16px", class "mr-2" ] []
            , if model.loadingInboxMessages then
                div [ class "mr-2" ] [ Le.Block.Spinner.loadingSpinnerSm ]

              else
                div [ style "width" "16px", class "mr-2" ] []
            , Toggle.new { onToggle = ToggleNewestFirst, label = "спочатку нові", id = "toggle-newest-first" } |> Toggle.view model.newestFirst
            , div
                [ class "mr-4 ml-[8px]"
                ]
              <|
                [ text <|
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


featuresBlock : Model -> Shared.Model -> Route () -> Html Msg
featuresBlock model shared route =
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
                                    Le.Block.Spinner.loadingSpinner2Sm

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
                        Le.Block.Spinner.loadingSpinner

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
        [ div [] (ifOrEmpty model.unfoldGraphs (RerAnalysis.Graphs.graphsBlock model shared))
        , div [ class "mb-2" ] (RerAnalysis.SumTable.sumTableBlock model shared route)
        , div
            (if model.unfoldCallsignGraph then
                [ style "margin-bottom" "50px" ]

             else
                []
            )
            callsignGraphBlock
        , div [ class "mb-2" ] newCallsignsBlock
        ]


filtersAndMainContent : B.User -> Model -> Shared.Model -> Route () -> Html Msg
filtersAndMainContent user model shared route =
    let
        mapFeatureFlag =
            case shared.serverInfo of
                Just info ->
                    info.featureAnalysisMap

                Nothing ->
                    False

        headerControls =
            div [ class "flex items-center gap-2 ml-4" ]
                [ case model.counts of
                    Success data ->
                        span
                            [ class "mr-1 inline-block px-3 py-1.5 text-xs font-medium rounded-full border transition-colors duration-200"
                            , classList
                                [ ( "bg-[var(--color-bg-muted)] text-[var(--color-text)] border-[var(--color-border-muted)]", True )
                                ]
                            ]
                            [ text (fromInt data.countSelected ++ " з " ++ fromInt data.countOverall) ]

                    _ ->
                        div [ class "mr-3 inline-block", style "min-width" "60px" ] []
                , div [ class "flex items-center gap-1" ]
                    [ button
                        [ onClick Refresh
                        , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw! py-[1px] px-[6px]"
                        , title "Оновити"
                        ]
                        [ if isLoadingStats model then
                            Le.Block.Spinner.loadingSpinner2Sm

                          else
                            i [ class "bi bi-arrow-clockwise" ] []
                        ]
                    , button
                        [ onClick ClearAllFilters
                        , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw! py-[1px] px-[6px]"
                        , title "Скинути фільтри"
                        ]
                        [ i [ class "bi bi-x-octagon" ] []
                        ]
                    ]
                , RerAnalysis.Date.dateAndPanelsBlock shared.isDarkMode model mapFeatureFlag
                ]

        reportConstructorBlock =
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
                            [ ( "bg-white border-gray-200 hover:border-gray-300", not active && not shared.isDarkMode )
                            , ( "bg-gray-800 border-gray-700 hover:border-gray-600", not active && shared.isDarkMode )
                            , ( "bg-secondary-light border-secondary shadow-lg ring-2 ring-secondary-light-active", active && not shared.isDarkMode )
                            , ( "bg-secondary-dark border-secondary shadow-lg ring-2 ring-secondary-light-active", active && shared.isDarkMode )
                            ]
                        , onClick <| toMsg
                        ]
                        [ div []
                            [ h5
                                [ class "text-lg font-semibold mb-3"
                                , classList
                                    [ ( "text-gray-900", not shared.isDarkMode )
                                    , ( "text-gray-100", shared.isDarkMode )
                                    ]
                                ]
                                [ text title ]
                            , p
                                [ class "text-sm leading-relaxed"
                                , classList
                                    [ ( "text-gray-600", not shared.isDarkMode )
                                    , ( "text-gray-400", shared.isDarkMode )
                                    ]
                                ]
                                [ text description ]
                            ]
                        , div [ class "mt-4 flex justify-between items-center" ]
                            [ viewIf active <|
                                div
                                    [ class "px-2 py-1 rounded-full text-xs font-medium"
                                    , classList
                                        [ ( "bg-secondary-light text-secondary-dark", not shared.isDarkMode )
                                        , ( "bg-secondary-light-active text-secondary-dark", shared.isDarkMode )
                                        ]
                                    ]
                                    [ text "Обрано" ]
                            , div
                                [ class "w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-200"
                                , classList
                                    [ ( "bg-gray-100", not active && not shared.isDarkMode )
                                    , ( "bg-gray-700", not active && shared.isDarkMode )
                                    , ( "bg-secondary", active && not shared.isDarkMode )
                                    , ( "bg-secondary", active && shared.isDarkMode )
                                    ]
                                ]
                                [ i
                                    [ class "text-xs"
                                    , classList
                                        [ ( "text-gray-400", not active && not shared.isDarkMode )
                                        , ( "text-gray-500", not active && shared.isDarkMode )
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
                    [ ( "text-gray-900", not shared.isDarkMode )
                    , ( "text-gray-100", shared.isDarkMode )
                    ]
                ]
                [ text "шаблон" ]
            , div [ class "grid grid-cols-3 gap-4 mb-6" ]
                [ templateCard
                    (model.reportTemplate == RTTags)
                    (ReportTemplateSelect RTTags)
                    "з донесенням"
                    "Простий перелік повідомлень разом з їх донесенням"
                , templateCard
                    (model.reportTemplate == RTPelengs)
                    (ReportTemplateSelect RTPelengs)
                    "пеленги"
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
                    (model.reportTemplate == RTMouse)
                    (ReportTemplateSelect RTMouse)
                    "Мишка"
                    "Детальний почастотний звіт по привʼязках"
                , a
                    [ class "border rounded-lg p-6 cursor-pointer transition-all duration-200 hover:shadow-md min-h-[140px] flex flex-col justify-between no-underline"
                    , classList
                        [ ( "bg-white border-gray-200 hover:border-gray-300", not shared.isDarkMode )
                        , ( "bg-gray-800 border-gray-700 hover:border-gray-600", shared.isDarkMode )
                        ]
                    , Route.href { path = Route.Path.RerFreqs, hash = Nothing, query = Dict.empty }
                    , target "_blank"
                    ]
                    [ div []
                        [ h5
                            [ class "text-lg font-semibold mb-3"
                            , classList
                                [ ( "text-gray-900", not shared.isDarkMode )
                                , ( "text-gray-100", shared.isDarkMode )
                                ]
                            ]
                            [ text "Еталонний опис р/м" ]
                        , p
                            [ class "text-sm leading-relaxed"
                            , classList
                                [ ( "text-gray-600", not shared.isDarkMode )
                                , ( "text-gray-400", shared.isDarkMode )
                                ]
                            ]
                            [ text "Еталонний опис радіомереж" ]
                        ]
                    , div [ class "mt-4 flex justify-end" ]
                        [ div
                            [ class "w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-200"
                            , classList
                                [ ( "bg-gray-100", not shared.isDarkMode )
                                , ( "bg-gray-700", shared.isDarkMode )
                                ]
                            ]
                            [ i
                                [ class "text-xs"
                                , classList
                                    [ ( "text-gray-400", not shared.isDarkMode )
                                    , ( "text-gray-500", shared.isDarkMode )
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
                ]
            , HtmlX.viewIf (List.member model.reportTemplate [ RTTags, RTBabak, RTInterception ]) <|
                div [ class "p-3 bg-gray-100 text-gray-900 mb-4" ]
                    [ div [ class "form-check" ]
                        [ input
                            [ class "form-check-input"
                            , type_ "checkbox"
                            , checked model.reportTagsOnlyThisUnit
                            , id "report-tags-only-this-unit"
                            , onClick <| ReportTagsOnlyThisUnitToggle
                            ]
                            []
                        , label
                            [ class "form-check-label"
                            , for "report-tags-only-this-unit"
                            ]
                            [ text "лише коментарі мого підрозділу"
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
                        ]

                _ ->
                    HtmlX.nothing
            , div [ class "flex justify-center items-center mb-4" ]
                [ Button.new { label = " завантажити docx/xlsx", onClick = ReportDownloadDocx }
                    |> Button.withIcon
                        [ if model.reportDownloadInProgress then
                            span [ class "me-1" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

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
                    in
                    div
                        (class "h-full relative"
                            :: (if not model.unfoldMapBlock then
                                    [ class "h-0" ]

                                else
                                    []
                               )
                        )
                        (Html.node "analysis-map"
                            [ class "h-full block relative z-10"
                            , attribute "daterange" (Encode.encode 0 encodedDates)
                            , attribute "points" (Encode.encode 0 encodedPoints)
                            , attribute "messages" (Encode.encode 0 encodedMessagesAndUnits)
                            , attribute "selected-units" (Encode.encode 0 encodedSelectedUnits)
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
    div [ class "" ]
        [ -- viewIf model.showReportConstructor reportConstructorBlock
          reportConstructorBlock
        , div
            [ class "flex justify-start items-start"
            , class "page-rer-analysis"
            , style "height" <| "calc(100vh - " ++ fromInt navbarHeightPx ++ "px)"
            , style "overflow-y" "hidden"
            ]
            [ div
                [ class "self-stretch overflow-auto text-sm w-[260px] min-w-[260px]"
                , style "height" <| "calc(100vh - " ++ fromInt navbarHeightPx ++ "px)"
                ]
                [ RerAnalysis.Filters.leftColumn shared.isDarkMode model ]
            , div
                [ class "border-l border-border self-stretch flex-grow mt-4"
                , id "messages-div"
                , style "max-width" "100"
                , style "height" <| "calc(100vh - " ++ fromInt navbarHeightPx ++ "px)"
                , style "overflow-y" "auto"
                , style "min-width" "1000px"
                , style "position" "relative"
                , style "display" "flex"
                , style "flex-direction" "column"
                ]
                [ div
                    [ style "position" "fixed"
                    , style "bottom" "20px"
                    , style "right" "30px"
                    , style "opacity" ".5"
                    , onClick <| ScrollMessagesToTop
                    ]
                    [ span [ class "text-[2rem] cursor-pointer" ]
                        [ i [ class "bi bi-arrow-up-circle" ] [] ]
                    ]

                -- , div
                --     [ style "float" "right"
                --     , style "position" "sticky"
                --     , style "top" "0"
                --     , style "z-index" "100"
                --     ]
                --     [ rightColumn model ]
                , div
                    [ style "position" "sticky"
                    , style "top" "0"
                    , class "bg-body"
                    , style "z-index" "50"
                    ]
                    [ div [ class "flex items-center justify-between px-4 mb-2" ]
                        [ div [ class "flex items-center" ]
                            [ h1 [ class "text-xl font-semibold" ] [ text "аналіз" ]
                            , headerControls
                            ]
                        ]
                    ]
                , div [ class "flex-grow max-xl:mx-2 mx-4" ]
                    (mapBlock
                        :: (if not model.unfoldMapBlock then
                                [ div []
                                    [ featuresBlock model shared route
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
