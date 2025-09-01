module RerNetworks.Id_.NetworkInfo exposing (view)

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
import RerNetworks.Id_.CallsignsTables as CallsignsTables exposing (getDevelopingCallsigns, getRegularCallsigns)
import RerNetworks.Id_.FrequenciesTable as FreqsTable
import RerNetworks.Id_.Model as Types exposing (CallsignCreateMode(..), CallsignTableRow, FreqActivityFilter(..), Mode(..), Model, ShowAllPopupFor(..))
import RerNetworks.Id_.Msg as Msgs exposing (Msg(..))
import RerNetworks.Utils as IdUtils
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


view network model user shared =
    [ div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        (case model.missingFieldsMode of
            Readonly ->
                missingFieldsBlock user network shared model

            Editing eNetwork ->
                missingFieldsEditBlock user network eNetwork shared model
        )
    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ]
        (case model.mode of
            Readonly ->
                if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                    mainInfoBlock user network shared model

                else
                    mainInfoBlock user network shared model

            Editing eNetwork ->
                if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
                    mainInfoEditBlock eNetwork network network.freqs shared model

                else
                    mainInfoBlock user network shared model
        )
    , div [ class "bg-w dark:bg-[#1C1C21] p-[16px]" ] <|
        activityBlock shared model
    ]


activityBlock : Shared.Model -> Model -> List (Html Msg)
activityBlock shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 [] [ text "Активність мережі" ]
        ]
    , div [ class "space-y-4" ]
        [ div [ class "mb-4" ]
            [ span [ class "opacity-70 text-sm" ] [ text "Графік активності мережі за місяць" ]
            ]
        , div [ class "h-[300px]" ]
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
                    Le.Block.Spinner.loadingSpinnerSm
            ]
        ]
    ]


missingFieldsBlock : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
missingFieldsBlock user network shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 [] [ text "Загальне" ]
        , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
            i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick MissingFieldsEditStartedByUser ] []

          else
            text ""
        ]
    , div [ class "space-y-3" ]
        [ if Le.Auth.hasRole "UnitsEditor" user then
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
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ text (Maybe.withDefault "" network.radioStation) ]
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
            [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.activeFrom of
                    Just activeFrom ->
                        text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix activeFrom)

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.activeTo of
                    Just millis ->
                        Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix millis) |> text

                    Nothing ->
                        text ""
                ]
            ]
        ]
    ]


missingFieldsEditBlock : Auth.User -> B.Network -> B.UpdateNetworkReq -> Shared.Model -> Model -> List (Html Msg)
missingFieldsEditBlock user network updNetworkReq shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 [] [ text "Загальне" ]
        , div [ class "flex gap-[8px]" ]
            [ if model.missingFieldsEditLoading then
                i [ class "bi bi-x-square text-gray-400 text-[20px]", title "Скасувати" ] []

              else
                i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick MissingFieldsEditCanceledByUser, title "Скасувати" ] []
            , if model.missingFieldsEditLoading then
                i [ class "text-[20px]" ] [ Le.Block.Spinner.loadingSpinner2Sm ]

              else
                i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick MissingFieldsEditSavedByUser, title "Зберегти" ] []
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
                        Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                  in
                  Html.map NetworkEditAorSelMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelect
                            selectedItems
                            model.editAorSelect.state
                            model.editAorSelect.items
                            "виберіть смуги"
                            defaultOptions
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Назва:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.name
                    , onInput <| MissingFieldsEditingMsg << (\v -> { updNetworkReq | name = v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть назву"
                    ]
                    []
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Радіостанція:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value (Maybe.withDefault "" updNetworkReq.radioStation)
                    , onInput <| MissingFieldsEditingMsg << (\v -> { updNetworkReq | radioStation = Just v })
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть радіостанцію"
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
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditUnitsSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
                                selectedItems
                                model.editUnitsSelect.state
                                model.editUnitsSelect.items
                                "почніть вводити назву підрозділу"
                                defaultOptions
                    ]
                ]
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
                            Le.Block.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map NetworkEditPostsSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelect
                                selectedItems
                                model.editPostsSelect.state
                                model.editPostsSelect.items
                                "виберіть пости"
                                defaultOptions
                    ]
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center mt-[24px]" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.activeFrom of
                    Just activeFrom ->
                        text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix activeFrom)

                    Nothing ->
                        text ""
                ]
            ]
        , div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
            , div [ class "col-span-2 h-[40px] flex items-center" ]
                [ case network.activeTo of
                    Just millis ->
                        text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix millis)

                    Nothing ->
                        text ""
                ]
            ]
        ]
    ]


mainInfoBlock : Auth.User -> B.Network -> Shared.Model -> Model -> List (Html Msg)
mainInfoBlock user network shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user then
            i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick NetworkEditStartedByUser ] []

          else
            text ""
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
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
        ]
    ]


mainInfoEditBlock : B.UpdateNetworkReq -> B.Network -> List B.NetworkFreq -> Shared.Model -> Model -> List (Html Msg)
mainInfoEditBlock updNetworkReq network networkFreqs shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        , div [ class "flex gap-[8px]" ]
            [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick NetworkEditingCanceledByUser ] []
            , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick NetworkEditingSavedByUser ] []
            ]
        ]
    , div [ class "space-y-3" ]
        [ div [ class "grid grid-cols-3 gap-x-4 items-center" ]
            [ span [ class "text-[13px] font-medium" ] [ text "Район функціонування/розгортання:" ]
            , div [ class "col-span-2" ]
                [ input
                    [ value updNetworkReq.location
                    , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | location = v })
                    , class "form-input w-full h-[40px]"
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
                    , class "form-input w-full h-[40px]"
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
                    , class "form-input w-full h-[40px]"
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
                    , class "form-input w-full h-[40px]"
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
                    , class "form-input w-full h-[40px]"
                    , placeholder "введіть період функціонування"
                    ]
                    []
                ]
            ]
        ]
    ]
