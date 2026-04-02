module Pages_.RerNetworks.Id_.NetworkInfo exposing (view)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Char
import Core.Auth
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
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
import List.Extra as ListX
import Page exposing (Page)
import Pages_.RerNetworks.Id_.CallsignsTables as CallsignsTables exposing (getDevelopingCallsigns, getRegularCallsigns)
import Pages_.RerNetworks.Id_.FrequenciesTable as FreqsTable
import Pages_.RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), Model, ShowAllPopupFor(..))
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import Pages_.RerNetworks.Utils as IdUtils
import Route exposing (Route)
import Route.Path
import Select
import Set exposing (Set)
import Shared
import Shared.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DropdownBadge as DropdownBadge exposing (DropdownAction(..))
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Pager as Pager
import Shared.Components.Popup as Popup
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Table.Sorter as TableSorter
import Shared.Model exposing (isDarkMode)
import Time
import Time.Extra
import Url.Builder
import Utils.Api.ErrorHandling
import Utils.NetworksUtils as NetworksUtils
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (networkKindVHFMapping)
import View exposing (View)


view network model user shared =
    [ div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        (case ( model.mode, Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user ) of
            ( Editing eNetwork, True ) ->
                viewNetworkInfoForm eNetwork network network.freqs shared model

            _ ->
                viewNetworkInfoReadonly user network shared model
        )
    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ] <|
        activityBlock shared model
    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col h-[250px]" ]
        [ h4 [] [ text "Пеленги" ]
        , let
            mapPoints =
                case model.mapPoints of
                    Success points ->
                        points

                    _ ->
                        []
          in
          if List.length mapPoints > 0 then
            Html.node "small-map"
                [ property "points" (Encode.list B.networkPointEncoder mapPoints)
                , class "flex-1"
                , property "withExitButton" (Encode.bool False)
                ]
                []

          else
            div [ class "flex-1 flex justify-center items-center" ] [ text "Пеленги відсутні" ]
        ]
    ]


networkStatusLabel : B.NetworkStatus -> String
networkStatusLabel status =
    case status of
        B.NetworkActive ->
            "Активна"

        B.NetworkInactive ->
            "Неактивна"


networkStatusFromValue : String -> B.NetworkStatus
networkStatusFromValue value =
    if value == "inactive" then
        B.NetworkInactive

    else
        B.NetworkActive


activityBlock : Shared.Model -> Model -> List (Html Msg)
activityBlock shared model =
    [ div [ class "flex justify-between items-center" ]
        [ h5 [] [ text "Активність мережі" ]
        ]
    , div [ class "space-y-4" ]
        [ div [ class "mb-2" ]
            [ span [ class "opacity-70 text-sm" ] [ text "Графік активності мережі за місяць" ]
            ]
        , div [ class "h-[200px]" ]
            [ case model.groupsActivity of
                Success data ->
                    let
                        groupsMessageCountByDayJson =
                            data |> Encode.dict identity (Encode.dict identity Encode.int)
                    in
                    Html.node "bar-chart"
                        [ property "data" <| groupsMessageCountByDayJson
                        , property "last-day" <| Encode.int shared.now
                        , class "block"
                        ]
                        []

                _ ->
                    Shared.Components.Spinner.loadingSpinnerSm
            ]
        ]
    ]


createActivityStr : Maybe Int -> Maybe Int -> Time.Zone -> String
createActivityStr mActiveFrom mActiveTo timeZone =
    let
        fromStr =
            case mActiveFrom of
                Just activeFrom ->
                    Utils.Time.renderDateF6 timeZone (Time.millisToPosix activeFrom)

                Nothing ->
                    "Помилка"

        toStr =
            case mActiveTo of
                Just millis ->
                    Utils.Time.renderDateF6 timeZone (Time.millisToPosix millis)

                Nothing ->
                    "Досі"
    in
    fromStr ++ " - " ++ toStr


viewNetworkInfoReadonly : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
viewNetworkInfoReadonly user network shared model =
    [ if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user then
        div [ class "mb-[8px] flex justify-end items-center" ]
            [ i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick NetworkEditStartedByUser ] []
            ]

      else
        text ""
    , div [ class "space-y-3" ]
        [ if Core.Auth.hasRole "UnitsEditor" user then
            div [ class "grid grid-cols-3 gap-x-4 items-center" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Смуги:" ]
                , div [ class "col-span-2 h-[40px] flex items-center" ]
                    [ case model.aorList of
                        Success aors ->
                            let
                                aorNames =
                                    network.aorIds
                                        |> List.filterMap (\aid -> aors |> List.filter (\a -> a.id == aid) |> List.head |> Maybe.map .name)
                                        |> String.join ", "
                            in
                            text aorNames

                        _ ->
                            text ""
                    ]
                ]

          else
            text ""
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Назва:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text network.name ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Підрозділи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.unitIds of
                    Just unitIds ->
                        List.map
                            (\unitId ->
                                Dict.get unitId (RD.withDefault Dict.empty shared.masterUnits)
                                    |> Maybe.map .name
                                    |> Maybe.withDefault (String.fromInt unitId)
                            )
                            unitIds
                            |> String.join ", "
                            |> text

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text network.location ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Призначення:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.purpose ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Склад кореспондентів:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Вид передачі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ List.map (\freqObj -> freqObj.kind) network.freqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Режим роботи радіомережі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.operationMode ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Характер роботи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.operationType ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Період функціонування:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| Maybe.withDefault "" network.operationPeriod ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активність:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| createActivityStr network.activeFrom network.activeTo shared.timeZone
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case shared.posts of
                    Success posts ->
                        List.map (\postId -> Dict.get postId posts) network.postIds
                            |> List.filterMap identity
                            |> List.map .name
                            |> String.join ", "
                            |> text

                    _ ->
                        text ""
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text (Maybe.withDefault "" network.radioStation) ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Статус:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text (networkStatusLabel network.status) ]
            ]
        ]
    ]


viewNetworkInfoForm : B.UpdateNetworkReq -> B.Network -> List B.NetworkFreq -> Shared.Model -> Model -> List (Html Msg)
viewNetworkInfoForm updNetworkReq network networkFreqs shared model =
    [ div [ class "mb-[8px] flex justify-end items-center" ]
        [ -- Без заголовка для економії місця
          div [ class "flex gap-[8px]" ]
            [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick NetworkEditingCanceledByUser, title "Скасувати" ] []
            , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick NetworkEditingSavedByUser, title "Зберегти" ] []
            ]
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Смуги:" ]
            , div [ class "col-span-2" ]
                [ let
                    selectedItems =
                        List.map
                            (\aorId ->
                                let
                                    label =
                                        case model.aorList of
                                            Success aors ->
                                                aors
                                                    |> List.filter (\a -> a.id == aorId)
                                                    |> List.head
                                                    |> Maybe.map .name
                                                    |> Maybe.withDefault ""

                                            _ ->
                                                ""
                                in
                                Select.basicMenuItem { item = aorId, label = label }
                            )
                            model.editAorSelect.selected

                    defaultOptions =
                        Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map NetworkEditAorSelMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelect
                            selectedItems
                            model.editAorSelect.state
                            model.editAorSelect.items
                            "виберіть смуги"
                            { defaultOptions | trunc = Utils.Select.Shortest }
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Назва:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.name
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | name = v })
                    , class "form-input w-full"
                    , placeholder "введіть назву"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Підрозділи:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ div [ class "w-full" ]
                    [ let
                        selectedItems =
                            List.map
                                (\unitId ->
                                    Select.basicMenuItem
                                        { item = unitId
                                        , label =
                                            RD.withDefault Dict.empty shared.masterUnits
                                                |> Dict.get unitId
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editUnitsSelect.selected

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditUnitsSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.editUnitsSelect.state
                                model.editUnitsSelect.items
                                "почніть вводити назву підрозділу"
                                { defaultOptions | trunc = Utils.Select.Short }
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.location
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | location = v })
                    , class "form-input w-full"
                    , placeholder "введіть район функціонування/розгортання"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Призначення:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.purpose
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | purpose = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть призначення"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Склад кореспондентів:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Вид передачі:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ List.map (\freqObj -> freqObj.kind) networkFreqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Режим роботи радіомережі:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationMode
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationMode = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть режим роботи радіомережі"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Характер роботи:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationType
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationType = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть характер роботи"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Період функціонування:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value <| Maybe.withDefault "" updNetworkReq.operationPeriod
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationPeriod = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть період функціонування"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center mt-[24px]" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активність:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text <| createActivityStr network.activeFrom network.activeTo shared.timeZone ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ div [ class "w-full" ]
                    [ let
                        selectedItems =
                            List.map
                                (\postId ->
                                    Select.basicMenuItem
                                        { item = postId
                                        , label =
                                            RD.withDefault Dict.empty shared.posts
                                                |> Dict.get postId
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editPostsSelect.selected

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditPostsSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelect
                                selectedItems
                                model.editPostsSelect.state
                                model.editPostsSelect.items
                                "виберіть пости"
                                defaultOptions
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value (Maybe.withDefault "" updNetworkReq.radioStation)
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | radioStation = Just v })
                    , class "form-input w-full"
                    , placeholder "введіть радіостанцію"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Статус:" ]
            , div [ class "col-span-2" ]
                [ select
                    [ class "form-input w-full"
                    , onInput <| \value -> NetworkEditingMsg { updNetworkReq | status = networkStatusFromValue value }
                    ]
                    [ option [ value "active", selected (updNetworkReq.status == B.NetworkActive) ] [ text "Активна" ]
                    , option [ value "inactive", selected (updNetworkReq.status == B.NetworkInactive) ] [ text "Неактивна" ]
                    ]
                ]
            ]
        ]

    -- Прибираємо другий заголовок, залишаємо тільки поля
    ]
