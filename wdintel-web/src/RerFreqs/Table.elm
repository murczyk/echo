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
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import Le.Auth
import Le.Block.ActionMenu
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Spinner
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Utils exposing (..)
import Page exposing (Page)
import RerFreqs.Model exposing (FilterName(..), Model, NetworkAddStatus(..), ReportCreation(..), TextLocation(..))
import RerFreqs.Msg exposing (Msg(..))
import Route exposing (Route)
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
            [ class "table table-bordered table-sm"
            , style "font-size" ".85rem"
            ]
            [ thead []
                [ tr []
                    [ th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "120px"
                        ]
                        [ freqsHeader ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "190px"
                        ]
                        [ text "Позивні" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "190px"
                        ]
                        [ text "Пеленги" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "min-width" "400px"
                        ]
                        [ text "Привʼязки" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "min-width" "200px"
                        ]
                        [ text "Альтернативні Привʼязки" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "200px"
                        ]
                        [ text "Активність р/м" ]
                    , th
                        [ scope "col"
                        , class "nowrap"
                        , style "width" "150px"
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

                stateS =
                    Encode.encode 0
                        (B.rerAnalysisQueryStateEncoder
                            { dateFromStr = dateFromStr
                            , timeFromStr = ""
                            , dateToStr = ""
                            , timeToStr = ""
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

        createTextElement textLocation clickable =
            let
                styles =
                    if clickable then
                        [ style "cursor" "pointer", style "text-decoration" "underline" ]

                    else
                        []

                events =
                    if clickable then
                        [ onClick <| SwitchFromTextToMap freq.freq ]

                    else
                        []
            in
            p
                (styles ++ events)
                [ text textLocation ]

        alternativeUnits =
            model.altUnitsByFreq |> Dict.get freq.freq

        groupsMessageCountByDayJson =
            model.groupsMessageCountByDay |> Dict.get freq.freq |> Maybe.map (Encode.dict identity (Encode.dict identity Encode.int))

        locations =
            if List.isEmpty freq.locations then
                "Текстова локація"

            else
                String.join ", " freq.locations
    in
    tr []
        [ td [ class "flex relative", style "gap" "2px", style "align-items" "baseline" ]
            [ span [] [ text freq.freq ]
            , div [ class "flex-grow-1" ]
                [ span
                    [ class "badge badge-sm rounded-pill text-bg-secondary"
                    , style "font-size" "0.6rem"
                    ]
                    [ text <| String.fromInt freq.messageCount
                    ]
                ]
            , Le.Block.ActionMenu.actionMenu actionMenuBody "bi-three-dots-vertical"
            , Watermark.new user.name
                |> Watermark.withPositioning ( 30, 10 )
                |> Watermark.withFontSize "1.5rem"
                |> Watermark.view
                |> HtmlX.viewIf (Basics.remainderBy 2 rowIndex == 0)
            ]
        , let
            callsigns =
                case Dict.get freq.freq model.callsignsByFreq of
                    Nothing ->
                        []

                    Just v ->
                        v

            isOpen =
                case model.showAllCallsignsForFreq of
                    Just showAllCallsignsForFreq ->
                        showAllCallsignsForFreq == freq.freq

                    Nothing ->
                        False
          in
          CallsignsPopup.view
            { isOpened = isOpen
            , onClose = SetFreqToShowAllCallsignsPopup Nothing
            , onOpen = SetFreqToShowAllCallsignsPopup (Just freq.freq)
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

                    ( Just LocationText, False ) ->
                        createTextElement locations True

                    ( Just NoCoords, _ ) ->
                        createTextElement "Немає координат" False

                    ( Nothing, _ ) ->
                        p
                            [ style "cursor" "pointer"
                            , style "text-decoration" "underline"
                            , onClick <| SwitchFromTextToMap freq.freq
                            ]
                            [ text locations ]
                ]
            ]
        , td [] <|
            viewFreqBlock shared.user model freq
        , td []
            [ div []
                (case alternativeUnits of
                    Just units ->
                        List.map (\u -> p [ class "mb-0" ] [ text u.unit ]) units

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
                                    [ class "btn btn-outline-primary btn-sm me-2 ms-2 py-0 px-1"
                                    , type_ "button"
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
                                NetworksUtils.renderNetwork network model.masterUnits

                            _ ->
                                text "Невідома мережа"
            ]
        , editBlock
        ]
    ]
