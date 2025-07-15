module RerFreqs.Table exposing (view)

import Bindings as B
import Bytes exposing (Bytes)
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Json.Encode as Encode
import Layouts
import Le.Auth
import Le.Block.ActionMenu
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Popup
import Le.Block.Spinner
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Utils exposing (..)
import Page exposing (Page)
import RerFreqs.Model exposing (FilterName(..), Model, NetworkWorkflowStatus(..), ShowAllPopupFor(..), TextLocation(..))
import RerFreqs.Msg exposing (Msg(..))
import Route exposing (Route)
import Route.Path
import Shared
import Time exposing (Posix)
import Url.Builder
import View exposing (View)


view : Shared.Model -> Model -> B.User -> Html Msg
view shared model user =
    let
        freqsHeader =
            span []
                [ text "Частота"
                , i
                    [ class
                        (if model.sortingOrder == B.MessageCountDesc then
                            "bi bi-sort-numeric-down-alt"

                         else
                            "bi bi-sort-numeric-up-alt"
                        )
                    , style "cursor" "pointer"
                    , style "font-size" "16px"
                    , onClick SortByMessageNumber
                    ]
                    []
                ]

        loadMoreBtn =
            div [ class "d-flex justify-content-center align-items-center mb-4" ]
                [ button
                    [ class "btn btn-outline-secondary btn-sm"
                    , onClick FreqsLoadMore
                    ]
                    [ if model.loading then
                        Le.Block.Spinner.loadingSpinner2Sm

                      else
                        i [ class "bi bi-arrow-down-circle me-2" ] []
                    , text "завантажити ще"
                    ]
                ]
    in
    section []
        [ table
            [ class "table-fixed w-full"
            , style "font-size" ".85rem"
            ]
            [ thead []
                [ tr []
                    [ th
                        [ scope "col"
                        , class ""
                        , style "width" "8%"
                        ]
                        [ freqsHeader ]
                    , th
                        [ scope "col"
                        , class ""
                        , style "width" "8%"
                        ]
                        [ text "Позивні" ]
                    , th
                        [ scope "col"
                        , class ""
                        , style "width" "14%"
                        ]
                        [ text "Пеленги" ]
                    , th
                        [ scope "col"
                        , class ""
                        , style "width" "26%"
                        ]
                        [ text "Привʼязки" ]
                    , th
                        [ scope "col"
                        , class ""
                        , style "width" "20%"
                        ]
                        [ text "Альтернативні Привʼязки" ]
                    , th
                        [ scope "col"
                        , class ""
                        , style "width" "15%"
                        ]
                        [ text "Активність р/м" ]
                    , th
                        [ scope "col"
                        , class ""
                        , style "width" "9%"
                        ]
                        [ text "Останнє оновлення" ]
                    ]
                ]
            , tbody [] <|
                List.indexedMap (renderFreqTr shared model user) model.freqs
            , HtmlX.viewIf (not model.noMoreToLoad) <|
                tfoot []
                    [ td [ colspan 7, style "border-bottom" "none" ] [ loadMoreBtn ]
                    ]
            ]
        ]


renderFreqTr : Shared.Model -> Model -> B.User -> Int -> B.Freq -> Html Msg
renderFreqTr shared model user rowIndex freq =
    let
        analysisHref withMap =
            let
                dateFromStr =
                    case ( model.zone, model.now ) of
                        ( Just zone, Just time ) ->
                            Le.Time.renderDateF4 zone (Le.Time.xDaysAgo 15 time)

                        _ ->
                            ""

                dateToStr =
                    case ( model.zone, model.now ) of
                        ( Just zone, Just time ) ->
                            Le.Time.renderDateF4 zone (Le.Time.xDaysAgo -1 time)

                        _ ->
                            ""

                stateS =
                    Encode.encode 0
                        (B.rerAnalysisQueryStateEncoder
                            { dateFromStr = dateFromStr
                            , timeFromStr = ""
                            , dateToStr = dateToStr
                            , timeToStr = "00:00"
                            , groupsSelected = []
                            , sendersSelected = []
                            , freqsSelected = [ freq.freq ]
                            , callsignsSelected = []
                            , unitsSelected = []
                            , locationsSelected = []
                            , includePelengLocations = False
                            , orWithExtendedForm = False
                            , orBookmarked = False
                            , orImportant = False
                            , orWithCoords = False
                            , search = ""
                            , tags = []
                            }
                        )

                query =
                    if withMap then
                        [ Url.Builder.string "state" stateS, Url.Builder.string "showMap" "true" ]

                    else
                        [ Url.Builder.string "state" stateS ]
            in
            Url.Builder.relative [ "rer-analysis" ] query

        actionMenuBody =
            [ span []
                [ i [ class "bi me-1 bi-bar-chart" ] []
                , a [ href <| analysisHref False, target "_blank" ]
                    [ text "аналіз "
                    , sup []
                        [ i
                            [ class "bi bi-box-arrow-up-right"
                            ]
                            []
                        ]
                    ]
                ]
            , span []
                [ i [ class "bi me-1 bi-pin-map" ] []
                , a [ href <| analysisHref True, target "_blank" ]
                    [ text "на мапі "
                    , sup []
                        [ i
                            [ class "bi bi-box-arrow-up-right"
                            ]
                            []
                        ]
                    ]
                ]
            ]

        mMap =
            model.locationTexts |> Dict.get freq.freq

        alternativeUnits =
            model.altUnitsByFreq |> Dict.get freq.freq

        groupsMessageCountByDayJson =
            model.groupsMessageCountByDay |> Dict.get freq.freq |> Maybe.map (Encode.dict identity (Encode.dict identity Encode.int))
    in
    tr []
        [ td []
            [ div [ class "relative" ]
                [ div [] [ text freq.freq ]
                , div [ class "" ]
                    [ span
                        [ class "badge badge-sm rounded-pill text-bg-secondary"
                        , style "font-size" "0.6rem"
                        ]
                        [ text <| String.fromInt freq.messageCount
                        ]
                    , Le.Block.ActionMenu.actionMenu actionMenuBody "bi-three-dots-vertical"
                    ]
                , Watermark.new user.name
                    |> Watermark.withPositioning ( 30, 10 )
                    |> Watermark.withFontSize "1.5rem"
                    |> Watermark.view
                    |> HtmlX.viewIf (Basics.remainderBy 2 rowIndex == 0)
                ]
            ]
        , let
            callsigns =
                case Dict.get freq.freq model.callsignsByFreq of
                    Nothing ->
                        []

                    Just v ->
                        v

            isOpen =
                case model.rowShowAllPopupStatus of
                    Just ( freq_, ShowAllCallsigns ) ->
                        freq_ == freq.freq

                    _ ->
                        False
          in
          CallsignsPopup.view
            { isOpened = isOpen
            , onClose = RowShowAllPopupChanged Nothing
            , onOpen = RowShowAllPopupChanged <| Just ( freq.freq, ShowAllCallsigns )
            , callsigns = callsigns
            , callsignsInfo = model.callsignsInfo
            , masterUnits = model.masterUnits
            }
            (FreqsPage
                freq.freq
                model.networks
            )
        , td []
            [ div []
                [ case ( mMap, model.openMapRowId == Just freq.freq ) of
                    ( Just LocationText, True ) ->
                        div [ id ("map-container-" ++ freq.freq) ]
                            []

                    ( Just NoCoords, _ ) ->
                        p []
                            [ text "Немає координат" ]

                    _ ->
                        p [ class "flex gap-[4px] flex-col" ]
                            (if List.isEmpty freq.locations then
                                [ span [] [ text "Текстова локація" ] ]

                             else
                                (List.map (\location -> span [ class "cursor-pointer underline ", onClick <| SwitchFromTextToMap freq.freq ] [ text location ]) freq.locations
                                    |> List.take 3
                                )
                                    ++ (if List.length freq.locations > 3 then
                                            let
                                                body =
                                                    span
                                                        [ style "font-size" "12px"
                                                        , style "font-weight" "300"
                                                        , style "cursor" "pointer"
                                                        , style "display" "block"
                                                        , style "padding-right" "6px"
                                                        , style "text-decoration" "underline"
                                                        ]
                                                        [ text ("Показати всі " ++ (freq.locations |> List.length |> String.fromInt)) ]

                                                popupBody =
                                                    div [ class "d-flex flex-column", style "gap" "20px" ]
                                                        (List.map (\location -> span [] [ text location ]) freq.locations)

                                                isOpen =
                                                    case model.rowShowAllPopupStatus of
                                                        Just ( freq_, ShowAllLocations ) ->
                                                            freq_ == freq.freq

                                                        _ ->
                                                            False
                                            in
                                            [ Le.Block.Popup.new
                                                { body = body
                                                , popupBody = popupBody
                                                , isOpen = isOpen
                                                , onClose = RowShowAllPopupChanged Nothing
                                                , onOpen = RowShowAllPopupChanged <| Just ( freq.freq, ShowAllLocations )
                                                , disabled = False
                                                }
                                                |> Le.Block.Popup.withFakeAnchor
                                                |> Le.Block.Popup.withCloseButton
                                                |> Le.Block.Popup.view
                                            ]

                                        else
                                            [ text "" ]
                                       )
                            )
                ]
            ]
        , td [] <|
            viewFreqBlock shared.user model freq
        , td []
            [ div [ class "flex flex-col gap-[4px]" ]
                (case alternativeUnits of
                    Just units ->
                        (List.map (\u -> span [] [ text u.unit ]) units
                            |> List.take 3
                        )
                            ++ (if List.length units > 3 then
                                    let
                                        body =
                                            span
                                                [ style "font-size" "12px"
                                                , style "font-weight" "300"
                                                , style "cursor" "pointer"
                                                , style "display" "block"
                                                , style "padding-right" "6px"
                                                , style "text-decoration" "underline"
                                                ]
                                                [ text ("Показати всі " ++ (units |> List.length |> String.fromInt)) ]

                                        popupBody =
                                            div [ class "d-flex flex-column", style "gap" "20px" ]
                                                (List.map (\unit -> span [] [ text unit.unit ]) units)

                                        isOpen =
                                            case model.rowShowAllPopupStatus of
                                                Just ( freq_, ShowAllAltUnits ) ->
                                                    freq_ == freq.freq

                                                _ ->
                                                    False
                                    in
                                    [ Le.Block.Popup.new
                                        { body = body
                                        , popupBody = popupBody
                                        , isOpen = isOpen
                                        , onClose = RowShowAllPopupChanged Nothing
                                        , onOpen = RowShowAllPopupChanged <| Just ( freq.freq, ShowAllAltUnits )
                                        , disabled = False
                                        }
                                        |> Le.Block.Popup.withFakeAnchor
                                        |> Le.Block.Popup.withCloseButton
                                        |> Le.Block.Popup.view
                                    ]

                                else
                                    [ text "" ]
                               )

                    Nothing ->
                        [ text "" ]
                )
            ]
        , td []
            [ case groupsMessageCountByDayJson of
                Just g ->
                    div [ style "width" "200px", style "height" "90px" ]
                        [ Html.node "bar-chart"
                            [ Attr.property "data" <| g
                            , Attr.property "lastDay" <| Encode.string model.to.dateStr
                            ]
                            []
                        ]

                Nothing ->
                    text "Не активні останні 10 днів"
            ]
        , td []
            (case ( freq.lastUpdatedAt, model.zone ) of
                ( Just updatedAt, Just zone ) ->
                    let
                        updatedAtString =
                            Le.Time.renderDateF6 zone
                                (Time.millisToPosix updatedAt)

                        updatedByString =
                            Maybe.withDefault "невідомий" freq.lastUpdatedBy

                        createdAtString =
                            case freq.createdAt of
                                Just createdAt ->
                                    Le.Time.renderDateF6 zone
                                        (Time.millisToPosix createdAt)

                                Nothing ->
                                    "невідомо"
                    in
                    [ div [ style "padding-left" "4px", title ("Прив'язку створено " ++ createdAtString) ]
                        [ i [ class "bi bi-calendar-date" ]
                            []
                        , text <|
                            " "
                                ++ createdAtString
                        ]
                    , div [ style "padding-left" "4px", title ("Востаннє прив'язка редагована " ++ updatedAtString ++ " користувачем " ++ updatedByString) ]
                        [ i [ class "bi bi-pencil-square" ] []
                        , text (" " ++ updatedAtString ++ " (" ++ updatedByString ++ ")")
                        ]
                    ]

                _ ->
                    [ text "" ]
            )
        ]


viewFreqBlock : Maybe B.User -> Model -> B.Freq -> List (Html Msg)
viewFreqBlock mUser model freq =
    let
        editBlock =
            case mUser of
                Just user ->
                    if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                        div []
                            [ div [ style "font-size" ".8rem" ]
                                [ button
                                    [ title "Редагувати прив'язки"
                                    , class "outline-0! px-[4px] border-1! border-border rounded-sm! bg-transparent text-action text-[16px]! transition-colors duration-350 hover:bg-action! hover:text-bw"
                                    , onClick <| OpenAddNetworkSidebar freq.freq
                                    ]
                                    [ i [ class "bi bi-pencil" ] []
                                    ]
                                ]
                            ]

                    else
                        text ""

                Nothing ->
                    text ""
    in
    [ div [ class "d-flex justify-content-between" ]
        [ div [ class "d-flex" ]
            [ div [] <|
                for_ freq.networkIds <|
                    \networkId ->
                        case Dict.get networkId model.networks of
                            Just network ->
                                span [ class "inline-flex items-center gap-1" ]
                                    [ a
                                        [ class "cursor-pointer"
                                        , Route.href { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network.id }, hash = Nothing, query = Dict.empty }
                                        , target "_blank"
                                        ]
                                        [ NetworksUtils.renderNetwork network model.masterUnits ]
                                    , case network.unitIds of
                                        Nothing -> span [ class "badge badge-no-unit" ] [ text "в дорозвідці" ]
                                        Just ids -> if List.isEmpty ids then span [ class "badge badge-no-unit" ] [ text "в дорозвідці" ] else text ""
                                    ]
                            _ ->
                                text "Невідома мережа"
            ]
        , editBlock
        ]
    ]
