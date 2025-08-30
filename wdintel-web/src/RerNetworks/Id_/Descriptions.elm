module RerNetworks.Id_.Descriptions exposing (..)

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


view network model user shared =
    let
        ( confirmations, signs ) =
            List.partition (\description -> description.descrType == B.Confirmation) network.descriptions
    in
    div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
        [ div [ class "mb-[16px]" ]
            [ div [ class "flex justify-between items-center mb-[8px]" ]
                [ h5 [ class "" ] [ text "Обґрунтування прив'язки" ]
                , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user || Le.Auth.hasRole "CallsignsEditor" user then
                    Button.new { label = "Створити", onClick = OpenConfirmationCreateSidebar }
                        |> Button.withStyleSecondary
                        |> Button.view

                  else
                    text ""
                ]
            , Html.Keyed.node "div"
                [ class "h-[350px] overflow-y-auto" ]
                (List.sortWith
                    (\a b ->
                        if a.createdAt > b.createdAt then
                            LT

                        else
                            GT
                    )
                    confirmations
                    |> List.map
                        (\description ->
                            ( String.fromInt description.id
                            , descriptionItem description network user shared
                            )
                        )
                )
            ]
        , div []
            [ div [ class "flex justify-between items-center mb-[8px]" ]
                [ h5 [ class "" ] [ text "Розвідувальні ознаки" ]
                , if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user || Le.Auth.hasRole "CallsignsEditor" user then
                    Button.new { label = "Створити", onClick = OpenSignsCreateSidebar }
                        |> Button.withStyleSecondary
                        |> Button.view

                  else
                    text ""
                ]
            , Html.Keyed.node "div"
                [ class "h-[350px] overflow-y-auto" ]
                (List.sortWith
                    (\a b ->
                        if a.createdAt > b.createdAt then
                            LT

                        else
                            GT
                    )
                    signs
                    |> List.map
                        (\description ->
                            ( String.fromInt description.id
                            , descriptionItem description network user shared
                            )
                        )
                )
            , section [ class "mt-[8px]" ]
                [ h5 [] [ text "Сигнали" ]
                , div [ class "h-[100px] overflow-y-auto" ]
                    (List.map
                        (\signalsForUnit ->
                            if List.length signalsForUnit.signals > 0 then
                                div []
                                    [ div []
                                        [ span [ class "font-medium" ] [ text signalsForUnit.unitName ]
                                        , div [ class "grid grid-cols-2 gap-[8px]" ] (List.map (\s -> div [ class "" ] [ span [ class "w-[50px] mr-[8px]" ] [ text s.text ], span [] [ text <| Maybe.withDefault "" s.meaning ] ]) signalsForUnit.signals)
                                        ]
                                    ]

                            else
                                text "Відсутні прив'язані до підрозділів сигнали"
                        )
                        (RD.withDefault [] model.signals)
                    )
                ]
            ]
        ]


descriptionItem : B.NetworkDescription -> B.Network -> Auth.User -> Shared.Model -> Html Msg
descriptionItem description network user shared =
    div [ class "border rounded-lg p-2 mb-3 shadow-sm hover:shadow-md transition-shadow duration-200 border-border bg-card" ]
        [ div [ class "flex justify-between items-start mb-1" ]
            [ div [ class "flex flex-col gap-1" ]
                [ div [ class "flex items-center gap-2 text-sm text-muted" ]
                    (List.concat
                        [ [ i [ class "bi bi-person-circle", style "color" "var(--color-primary)" ] []
                          , span [ class "font-medium" ] [ text description.login ]
                          , span [ style "color" "var(--color-text-muted)" ] [ text "•" ]
                          , span [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
                          ]
                        , if description.networkFrequencyId /= Nothing then
                            [ span [ style "color" "var(--color-text-muted)" ] [ text "•" ]
                            , span [ class "font-medium", style "color" "var(--color-primary)" ]
                                [ text <|
                                    Maybe.withDefault ""
                                        (description.networkFrequencyId
                                            |> Maybe.andThen
                                                (\freqId ->
                                                    ListX.find (\freq -> freq.id == freqId) network.freqs
                                                )
                                            |> Maybe.map .freq
                                        )
                                ]
                            ]

                          else
                            []
                        ]
                    )
                ]
            , div [ class "flex gap-2" ]
                (if Le.Auth.hasRole "Admin" user || Le.Auth.hasRole "UnitsEditor" user || Le.Auth.hasRole "CallsignsEditor" user then
                    [ button [ class "p-1 rounded-md transition-colors duration-200 description-item-edit-btn", style "color" "var(--color-primary)", style "background-color" "transparent", onClick <| DescriptionEditClickedByUser description, title "Редагувати" ]
                        [ i [ class "bi bi-pencil text-lg" ] [] ]
                    , button [ class "p-1 rounded-md transition-colors duration-200 description-item-delete-btn", style "color" "var(--color-error)", style "background-color" "transparent", onClick <| DescriptionDeleteClickedByUser description, title "Видалити" ]
                        [ i [ class "bi bi-trash text-lg" ] [] ]
                    ]

                 else
                    []
                )
            ]
        , div []
            [ div [ class "leading-relaxed", style "color" "var(--color-text)", style "white-space" "pre-line" ] [ text description.description ]
            ]
        ]
