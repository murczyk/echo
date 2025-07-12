module RerAnalysis.MainBody exposing (filtersAndMainContent)

import Bindings as B
import Components.Toggle as Toggle
import Dict
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
        messagesShown =
            List.length model.messages

        messagesCountOverall =
            extractMRecordField (\r -> r.countOverall) 0 (RD.toMaybe model.counts)

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
                            viewIf (not model.noMoreToLoad) <|
                                div [ class "d-flex justify-content-center align-items-center mb-4" ]
                                    [ button
                                        [ class "btn btn-outline-secondary btn-sm"
                                        , onClick LoadMoreMessages
                                        ]
                                        [ if model.loadingInboxMessages then
                                            Le.Block.Spinner.loadingSpinner2Sm

                                          else
                                            i [ class "bi bi-arrow-down-circle me-2" ] []
                                        , text "завантажити ще"
                                        ]
                                    ]

                        deleteConfirmationModal =
                            div
                                [ class "modal fade"
                                , attribute "tabindex" "-1"
                                , attribute "role" "dialog"
                                , attribute "aria-hidden" "true"
                                , id "deleteMessageModal"
                                ]
                                [ div
                                    [ class "modal-dialog"
                                    , attribute "role" "document"
                                    ]
                                    [ div
                                        [ class "modal-content" ]
                                        [ div
                                            [ class "modal-header" ]
                                            [ h5 [ class "modal-title" ] [ text "Видалення повідомлення" ]
                                            , button
                                                [ class "btn-close"
                                                , type_ "button"
                                                , attribute "data-bs-dismiss" "modal"
                                                , attribute "ariaLabel" "Close"
                                                ]
                                                []
                                            ]
                                        , div
                                            [ class "modal-body p-3" ]
                                            [ text "Ви впевнені, що хочете видалити це повідомлення?"
                                            ]
                                        , div
                                            [ class "modal-footer" ]
                                            [ button
                                                [ class "btn btn-secondary"
                                                , attribute "type" "button"
                                                , attribute "data-bs-dismiss" "modal"
                                                , onClick DeleteMessageCancel
                                                ]
                                                [ text "Відміна" ]
                                            , button
                                                [ class "btn btn-danger"
                                                , type_ "button"
                                                , attribute "data-bs-dismiss" "modal"
                                                , onClick DeleteMessageConfirm
                                                ]
                                                [ text "Видалити" ]
                                            ]
                                        ]
                                    ]
                                ]
                    in
                    div []
                        [ deleteConfirmationModal
                        , messagesNonEmptyBlock
                        , loadMoreBtn
                        ]

        messagesNonEmptyBlock =
            let
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
                    , networks = model.networks
                    , masterUnits = model.masterUnits
                    , freqNetworkIds = model.freqNetworkIds
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
                ]
    in
    [ div [] <|
        [ div
            [ class "d-flex justify-content-center align-items-center mb-4"
            , style "position" "relative"
            ]
          <|
            [ if isLoadingStats model then
                div [ class "me-2" ] [ Le.Block.Spinner.loadingSpinnerSm ]

              else
                div [ style "width" "16px", class "me-2" ] []
            , if model.loadingInboxMessages then
                div [ class "me-2" ] [ Le.Block.Spinner.loadingSpinnerSm ]

              else
                div [ style "width" "16px", class "me-2" ] []
            , Toggle.new { onToggle = ToggleNewestFirst, label = "спочатку нові", id = "toggle-newest-first" } |> Toggle.view model.newestFirst
            , div
                [ class "me-4 ml-[8px]"
                ]
              <|
                [ text <|
                    "показано повідомлень: "
                        ++ String.fromInt (List.length model.messages)
                ]
            , viewIf (messagesShown < messagesCountOverall && not model.nolimitShown) <|
                div [ class "me-4" ]
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
            , div [ class "me-4" ]
                [ span
                    [ class "text-action cursor-pointer"

                    -- , onClick ToggleReportConstructor
                    , attribute "data-bs-toggle" "modal"
                    , attribute "data-bs-target" "#report-constructor"
                    ]
                    [ i [ class "bi bi-tools" ] []
                    , text " конструктор звітів"
                    ]
                ]
            ]
        , messagesBlock
        ]
    ]


featuresBlock : Model -> Shared.Model -> Route () -> Html Msg
featuresBlock model shared route =
    let
        newCallsignsBlock =
            let
                renderStats stats =
                    div [ class "d-flex justify-content-between align-items-start" ]
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
                        [ div
                            [ class "btn btn-sm btn-outline-secondary mb-2"
                            , onClick LoadNewCallsignStats
                            ]
                            [ if model.newCallsignsLoading then
                                Le.Block.Spinner.loadingSpinner2Sm

                              else
                                i [ class "bi bi-arrow-clockwise me-2" ] []
                            , text " завантажити"
                            ]
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
            [ div
                [ style "position" "relative"
                , style "transform" "translateZ(0)"
                , classList
                    [ ( "so-visible", model.unfoldCallsignGraph )
                    , ( "so-hidden", not model.unfoldCallsignGraph )
                    ]
                , style "height"
                    (if model.unfoldCallsignGraph then
                        String.fromInt fullHeight ++ "px"

                     else
                        "10px"
                    )
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
                            div [ class "mt-2 d-flex justify-content-center align-items-center" ]
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

        mLblStr =
            case model.counts of
                NotAsked ->
                    Just ""

                Success data ->
                    Just (fromInt data.countSelected ++ " з " ++ fromInt data.countOverall)

                _ ->
                    Nothing

        lbl =
            (case mLblStr of
                Nothing ->
                    [ div
                        [ class "me-1 d-inline-block"
                        , style "min-width" "60px"
                        ]
                        []
                    ]

                Just lblS ->
                    [ span [ class "me-1" ] [ Views.h1SupLbl lblS ] ]
            )
                ++ [ button
                        [ type_ "button"
                        , class "inline-block btn btn-outline-secondary me-1 py-2"
                        , style "padding-left" "12px"
                        , style "padding-right" "12px"
                        , onClick Refresh
                        , attribute "data-tooltip" "оновити"
                        , attribute "data-position" "bottom"
                        ]
                     <|
                        if isLoadingStats model then
                            [ Le.Block.Spinner.loadingSpinner2Sm ]

                        else
                            [ i [ class "bi bi-arrow-repeat" ] [] ]
                   , button
                        [ type_ "button"
                        , class "inline-block btn btn-outline-secondary py-2"
                        , style "padding-left" "12px"
                        , style "padding-right" "12px"
                        , onClick ClearAllFilters
                        , attribute "data-tooltip" "скинути фільтри"
                        , attribute "data-position" "bottom"

                        -- , attribute "data-bs-toggle" "tooltip"
                        -- , attribute "data-bs-placement" "bottom"
                        -- , attribute "data-bs-title" "скинути фільтри"
                        ]
                        [ i [ class "bi bi-x-octagon" ] []
                        ]
                   , RerAnalysis.Date.dateAndPanelsBlock shared.isDarkMode model mapFeatureFlag
                   ]

        reportConstructorBlock =
            div
                [ class "modal modal-xl fade"
                , attribute "tabindex" "-1"
                , id "report-constructor"
                ]
                [ div [ class "modal-dialog" ]
                    [ div [ class "modal-content" ]
                        [ div [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "конструктор звітів" ]
                            , button
                                [ type_ "button"
                                , class "btn-close"
                                , attribute "data-bs-dismiss" "modal"
                                , attribute "aria-label" "Close"
                                ]
                                []
                            ]
                        , div [ class "modal-body" ] reportConstructorBlockBody
                        , div [ class "modal-footer" ]
                            [ button
                                [ type_ "button"
                                , class "btn btn-secondary"

                                -- , onClick ToggleReportConstructor
                                , attribute "data-bs-dismiss" "modal"
                                ]
                                [ text "закрити" ]
                            ]
                        ]
                    ]
                ]

        reportConstructorBlockBody =
            let
                templateCard active toMsg title description =
                    div
                        [ class "card pointer me-4 flex-1"
                        , classList
                            [ ( "bg-grad-mm14-dark", active && shared.isDarkMode )
                            , ( "bg-grad-mm14-light", active && not shared.isDarkMode )
                            ]
                        , classList [ ( "shadow", active ) ]
                        , onClick <| toMsg
                        ]
                        [ div [ class "card-body" ]
                            [ h5
                                [ class "card-title"
                                ]
                                [ text title ]
                            , p [ class "card-text" ]
                                [ text description ]
                            ]
                        ]
            in
            [ h4 [] [ text "шаблон" ]
            , div [ class "flex justify-center mb-4" ]
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
                    ""
                , templateCard
                    (model.reportTemplate == RTSenders Senders || model.reportTemplate == RTSenders Posts)
                    (ReportTemplateSelect (RTSenders Senders))
                    "Відправники"
                    ""
                , a
                    [ class "card pointer me-4 flex-1"
                    , Route.href { path = Route.Path.RerFreqs, hash = Nothing, query = Dict.empty }
                    , target "_blank"
                    ]
                    [ div [ class "card-body" ]
                        [ h5
                            [ class "card-title"
                            ]
                            [ text "Еталонний опис р/м" ]
                        ]
                    ]
                ]
            , div [ class "flex justify-start" ]
                [ div
                    [ class "card pointer me-4 basis-[200px]"
                    , classList
                        [ ( "bg-grad-mm14-dark", model.reportTemplate == RTMouse && shared.isDarkMode )
                        , ( "bg-grad-mm14-light", model.reportTemplate == RTMouse && not shared.isDarkMode )
                        ]
                    , classList [ ( "shadow", model.reportTemplate == RTMouse ) ]
                    , onClick <| ReportTemplateSelect RTMouse
                    ]
                    [ div [ class "card-body" ]
                        [ h5
                            [ class "card-title"
                            ]
                            [ text "мишка" ]
                        , p [ class "card-text" ]
                            [ text "Детальний почастотний звіт по привʼязках" ]
                        ]
                    ]
                , div
                    [ class "card pointer me-4 basis-[200px]"
                    , classList
                        [ ( "bg-grad-mm14-dark", model.reportTemplate == RTNaUshnom && shared.isDarkMode )
                        , ( "bg-grad-mm14-light", model.reportTemplate == RTNaUshnom && not shared.isDarkMode )
                        ]
                    , classList [ ( "shadow", model.reportTemplate == RTNaUshnom ) ]
                    , onClick <| ReportTemplateSelect RTNaUshnom
                    ]
                    [ div [ class "card-body" ]
                        [ h5
                            [ class "card-title"
                            ]
                            [ text "NaUshnom" ]
                        , p [ class "card-text" ]
                            [ text "" ]
                        ]
                    ]
                ]
            , HtmlX.viewIf (List.member model.reportTemplate [ RTTags, RTBabak, RTInterception ]) <|
                div [ class "p-3 bg-light text-dark mb-4" ]
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
                    div [ class "p-3 bg-light text-dark mb-4" ]
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
            , div [ class "d-flex justify-content-center align-items-center mb-4" ]
                [ button
                    [ type_ "button"
                    , class "inline-block btn btn-primary btn-sm me-2"
                    , onClick ReportDownloadDocx
                    ]
                    [ if model.reportDownloadInProgress then
                        span [ class "me-1" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

                      else
                        i [ class "bi bi-filetype-docx" ] []
                    , text " завантажити docx/xlsx"
                    ]
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
                            [ class "h-100 d-block position-relative z-1"
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
                                    [ div [ class "position-absolute z-3 top-0 start-0 end-0 bottom-0 d-flex justify-content-center align-items-center" ]
                                        [ div [ class "spinner-border position-relative z-2" ] []
                                        ]
                                    , div [ class "position-absolute z-2 top-0 start-0 end-0 bottom-0 bg-light opacity-25" ] []
                                    ]

                                else
                                    []
                               )
                        )

                _ ->
                    div [] []
    in
    div []
        [ -- viewIf model.showReportConstructor reportConstructorBlock
          reportConstructorBlock
        , div
            [ class "d-flex justify-content-start align-items-start"
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
                [ class "border-start align-self-stretch flex-grow-1"
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
                    [ span [ class "fs-2 pointer" ]
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
                    [ Views.headerAndContentLabeled "аналіз" lbl ToastMsg model.toasts <|
                        div [] []
                    ]
                , div [ class "grow-1 max-xl:mx-2 mx-4" ]
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
