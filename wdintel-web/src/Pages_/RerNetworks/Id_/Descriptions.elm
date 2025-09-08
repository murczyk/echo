module Pages_.RerNetworks.Id_.Descriptions exposing (..)

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
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (DescriptionsMsg(..), Msg)
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
import Svg.Styled exposing (desc)
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


update : Shared.Model -> DescriptionsMsg -> Model -> ( Model, Effect DescriptionsMsg )
update shared msg model =
    case msg of
        DescriptionAddClickedByUser networkId descType ->
            let
                desc =
                    case ( descType, model.addConfirmationFreqSelect.selected ) of
                        ( B.Confirmation, Just freq ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                []
                            , frequencyDescriptions =
                                [ { descrType = B.Confirmation
                                  , description = model.addConfirmationInp
                                  , freq = freq
                                  }
                                ]
                            }

                        ( B.Confirmation, Nothing ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                [ { descrType = B.Confirmation
                                  , description = model.addConfirmationInp
                                  }
                                ]
                            , frequencyDescriptions =
                                []
                            }

                        ( B.Sign, _ ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                [ { descrType = B.Sign
                                  , description = model.addSignsInp
                                  }
                                ]
                            , frequencyDescriptions =
                                []
                            }
            in
            ( model
            , E.networkAddDescription (NetworkDescriptionAdded descType) desc
            )

        NetworkDescriptionAdded _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання опису мережі" e
            )

        NetworkDescriptionAdded descType (Ok network) ->
            let
                m1 =
                    { model
                        | addConfirmationInp =
                            case descType of
                                B.Confirmation ->
                                    ""

                                B.Sign ->
                                    model.addConfirmationInp
                        , addSignsInp =
                            case descType of
                                B.Confirmation ->
                                    model.addSignsInp

                                B.Sign ->
                                    ""
                        , confirmationCreateSidebar = False
                        , signsCreateSidebar = False
                    }
            in
            ( { m1 | network = Success network }, E.none )

        ConfirmationInputChangedByUser inp ->
            ( { model | addConfirmationInp = inp }, E.none )

        SignsInputChangedByUser inp ->
            ( { model | addSignsInp = inp }, E.none )

        DescriptionDeleteClickedByUser description ->
            ( { model | deleteDescriptionConfirmation = Just description }, E.none )

        DescriptionEditClickedByUser description ->
            let
                freqItems =
                    case model.freqs of
                        Success freqs ->
                            List.map (\freq -> Select.basicMenuItem { item = freq.networkFreqId, label = freq.freq }) freqs

                        _ ->
                            []
            in
            ( { model
                | editDescriptionSidebar = Just ( description.id, description )
                , editDescriptionInp = description.description
                , editDescriptionFreqSelect =
                    { state = model.editDescriptionFreqSelect.state
                    , items = freqItems
                    , selected = description.networkFrequencyId
                    }
              }
            , E.none
            )

        DescriptionEditSave description ->
            let
                -- Use the current input from the sidebar
                updatedDescription =
                    model.editDescriptionInp

                -- Get selected frequency if any
                networkFreqId =
                    model.editDescriptionFreqSelect.selected
            in
            ( { model | editDescriptionSidebar = Nothing }
            , E.networkUpdateDescription (DescriptionEditUpdated description.id)
                { networkId = description.networkId
                , descriptionId = description.id
                , descrType = description.descrType
                , description = updatedDescription
                , networkFreqId = networkFreqId
                }
            )

        DescriptionEditUpdated _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення опису мережі" e
            )

        DescriptionEditUpdated descrId (Ok res) ->
            ( { model | network = Success res }, E.none )

        DescriptionDeleted (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення опису мережі" e
            )

        DescriptionDeleted (Ok res) ->
            ( { model | network = Success res }, E.none )

        AddConfirmationFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.addConfirmationFreqSelect.state

                updatedFreq =
                    Utils.Select.singleUpd mAct model.addConfirmationFreqSelect.selected

                freqsSelect =
                    model.addConfirmationFreqSelect

                freqsSelect2 =
                    { freqsSelect
                        | state = imodel
                        , selected = updatedFreq
                    }
            in
            ( { model
                | addConfirmationFreqSelect = freqsSelect2
              }
            , E.sendCmd <|
                Cmd.map
                    AddConfirmationFreqSelMsg
                    icmd
            )

        OpenConfirmationCreateSidebar ->
            ( { model | confirmationCreateSidebar = True }, E.none )

        CloseConfirmationCreateSidebar ->
            ( { model | confirmationCreateSidebar = False }, E.none )

        OpenSignsCreateSidebar ->
            ( { model | signsCreateSidebar = True }, E.none )

        CloseSignsCreateSidebar ->
            ( { model | signsCreateSidebar = False }, E.none )

        -- Sidebar management for editing descriptions
        OpenEditDescriptionSidebar description ->
            let
                -- Initialize input fields with current description data
                initialInput =
                    description.description

                -- For network descriptions, we don't have frequency info, so we'll leave it empty
                initialFreq =
                    Nothing

                freqItems =
                    case model.freqs of
                        Success freqs ->
                            List.map (\freq -> Select.basicMenuItem { item = freq.networkFreqId, label = freq.freq }) freqs

                        _ ->
                            []
            in
            ( { model
                | editDescriptionSidebar = Just ( description.id, description )
                , editDescriptionInp = initialInput
                , editDescriptionFreqSelect =
                    { state = model.editDescriptionFreqSelect.state
                    , items = freqItems
                    , selected = initialFreq
                    }
              }
            , E.none
            )

        CloseEditDescriptionSidebar ->
            ( { model
                | editDescriptionSidebar = Nothing
                , editDescriptionInp = ""
                , editDescriptionFreqSelect =
                    { state = model.editDescriptionFreqSelect.state
                    , items = []
                    , selected = Nothing
                    }
              }
            , E.none
            )

        -- Input field management for editing descriptions
        EditDescriptionInputChanged input ->
            ( { model | editDescriptionInp = input }, E.none )

        EditDescriptionFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.editDescriptionFreqSelect.state

                updatedFreq =
                    Utils.Select.singleUpd mAct model.editDescriptionFreqSelect.selected

                freqsSelect =
                    model.editDescriptionFreqSelect

                freqsSelect2 =
                    { freqsSelect
                        | state = imodel
                        , selected = updatedFreq
                    }
            in
            ( { model
                | editDescriptionFreqSelect = freqsSelect2
              }
            , E.sendCmd <|
                Cmd.map
                    EditDescriptionFreqSelMsg
                    icmd
            )

        -- Delete confirmation dialog management
        DeleteDescriptionConfirmed description ->
            ( { model | deleteDescriptionConfirmation = Nothing }
            , E.networkDeleteDescription DescriptionDeleted { descriptionId = description.id, networkId = description.networkId }
            )

        DeleteDescriptionCanceled ->
            ( { model | deleteDescriptionConfirmation = Nothing }, E.none )


view : B.Network -> Model -> Auth.User -> Shared.Model -> Html DescriptionsMsg
view network model user shared =
    let
        ( confirmations, signs ) =
            List.partition (\description -> description.descrType == B.Confirmation) network.descriptions
    in
    div [ class "bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col flex-1" ]
        [ div [ class "mb-[16px]" ]
            [ div [ class "flex justify-between items-center mb-[8px]" ]
                [ h5 [ class "" ] [ text "Обґрунтування прив'язки" ]
                , if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user || Core.Auth.hasRole "CallsignsEditor" user then
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
                , if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user || Core.Auth.hasRole "CallsignsEditor" user then
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


descriptionItem : B.NetworkDescription -> B.Network -> Auth.User -> Shared.Model -> Html DescriptionsMsg
descriptionItem description network user shared =
    div [ class "border rounded-lg p-2 mb-3 shadow-sm hover:shadow-md transition-shadow duration-200 border-border bg-card" ]
        [ div [ class "flex justify-between items-start mb-1" ]
            [ div [ class "flex flex-col gap-1" ]
                [ div [ class "flex items-center gap-2 text-sm text-muted" ]
                    (List.concat
                        [ [ i [ class "bi bi-person-circle", style "color" "var(--color-primary)" ] []
                          , span [ class "font-medium" ] [ text description.login ]
                          , span [ style "color" "var(--color-text-muted)" ] [ text "•" ]
                          , span [] [ text <| Utils.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
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
                (if Core.Auth.hasRole "Admin" user || Core.Auth.hasRole "UnitsEditor" user || Core.Auth.hasRole "CallsignsEditor" user then
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


viewDeleteConfirmation : Model -> Html DescriptionsMsg
viewDeleteConfirmation model =
    let
        deleteDescriptionDialogContent =
            [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                [ div [ class "pb-6" ]
                    [ h2 [] [ text "Видалити обґрунтування" ]
                    , p [] [ text "Ви впевнені, що хочете видалити це обґрунтування?" ]
                    ]
                , div [ class "flex justify-between" ]
                    [ Button.new { label = "Скасувати", onClick = DeleteDescriptionCanceled } |> Button.withStyleSecondary |> Button.view
                    , Button.new { label = "Видалити", onClick = DeleteDescriptionConfirmed (Maybe.withDefault (B.NetworkDescription 0 0 Nothing B.Confirmation "" "" 0) model.deleteDescriptionConfirmation) }
                        |> Button.withStyleDanger
                        |> Button.view
                    ]
                ]
            ]
    in
    ModalDialog.modalDialog (model.deleteDescriptionConfirmation /= Nothing) DeleteDescriptionCanceled [] deleteDescriptionDialogContent



-- SIDEBAR CONTENT


confirmationCreateSidebar : B.Network -> Model -> Auth.User -> Shared.Model -> Html DescriptionsMsg
confirmationCreateSidebar network model user shared =
    Sidebar.view True CloseConfirmationCreateSidebar [ confirmationCreateSidebarContent shared model user network ]


signsCreateSidebar : B.Network -> Model -> Auth.User -> Shared.Model -> Html DescriptionsMsg
signsCreateSidebar network model user shared =
    Sidebar.view True CloseSignsCreateSidebar [ signsCreateSidebarContent shared model user network ]


descriptionEditCloseSidebar : B.NetworkDescription -> B.Network -> Model -> Auth.User -> Shared.Model -> Html DescriptionsMsg
descriptionEditCloseSidebar description network model user shared =
    Sidebar.view True CloseEditDescriptionSidebar [ editDescriptionSidebarContent shared model user network description ]


confirmationCreateSidebarContent : Shared.Model -> Model -> Auth.User -> B.Network -> Html DescriptionsMsg
confirmationCreateSidebarContent shared model user network =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 flex flex-col" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити обґрунтування прив'язки" ]
            , div [ class "space-y-4 flex-1 flex flex-col" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота (необов'язково)" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\freq ->
                                    Select.basicMenuItem
                                        { item = freq
                                        , label = freq
                                        }
                                )
                                model.addConfirmationFreqSelect.selected

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map AddConfirmationFreqSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectedItem
                                model.addConfirmationFreqSelect.state
                                model.addConfirmationFreqSelect.items
                                "виберіть частоту"
                                defaultOptions
                    ]
                , div [ class "flex-1 flex flex-col min-h-0" ]
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Обґрунтування прив'язки *" ]
                    , textarea
                        [ class "w-full p-3 border border-border rounded flex-1 resize-none min-h-0"
                        , placeholder "Введіть обґрунтування прив'язки"
                        , value model.addConfirmationInp
                        , onInput ConfirmationInputChangedByUser
                        ]
                        []
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseConfirmationCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Confirmation }
                    |> Button.withDisabled (String.isEmpty model.addConfirmationInp)
                    |> Button.view
                ]
            ]
        ]


signsCreateSidebarContent : Shared.Model -> Model -> Auth.User -> B.Network -> Html DescriptionsMsg
signsCreateSidebarContent shared model user network =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 flex flex-col" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Створити розвідувальні ознаки" ]
            , div [ class "flex-1 flex flex-col min-h-0" ]
                [ div [ class "flex-1 flex flex-col min-h-0" ]
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Розвідувальні ознаки *" ]
                    , textarea
                        [ class "w-full p-3 border border-border rounded flex-1 resize-none min-h-0"
                        , placeholder "Введіть розвідувальні ознаки"
                        , value model.addSignsInp
                        , onInput SignsInputChangedByUser
                        ]
                        []
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseSignsCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Sign }
                    |> Button.withDisabled (String.isEmpty model.addSignsInp)
                    |> Button.view
                ]
            ]
        ]


editDescriptionSidebarContent : Shared.Model -> Model -> Auth.User -> B.Network -> B.NetworkDescription -> Html DescriptionsMsg
editDescriptionSidebarContent shared model user network description =
    div [ class "flex flex-col h-full" ]
        [ div [ class "flex-1 p-6 flex flex-col" ]
            [ h2 [ class "text-lg font-semibold mb-6" ] [ text "Редагувати опис" ]
            , div [ class "space-y-4 flex-1 flex flex-col" ]
                [ div []
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота (необов'язково)" ]
                    , let
                        selectedItem =
                            Maybe.map
                                (\freqId ->
                                    Select.basicMenuItem
                                        { item = freqId
                                        , label =
                                            RD.withDefault [] model.freqs
                                                |> List.filter (\f -> f.networkFreqId == freqId)
                                                |> List.head
                                                |> Maybe.map .freq
                                                |> Maybe.withDefault ""
                                        }
                                )
                                model.editDescriptionFreqSelect.selected

                        defaultOptions =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)
                      in
                      Html.map EditDescriptionFreqSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectedItem
                                model.editDescriptionFreqSelect.state
                                model.editDescriptionFreqSelect.items
                                "виберіть частоту"
                                defaultOptions
                    ]
                , div [ class "flex-1 flex flex-col min-h-0" ]
                    [ label [ class "block text-sm font-medium mb-1" ] [ text "Текст опису *" ]
                    , textarea
                        [ class "w-full p-3 border border-border rounded flex-1 resize-none min-h-0"
                        , placeholder "Введіть текст опису"
                        , value model.editDescriptionInp
                        , onInput EditDescriptionInputChanged
                        ]
                        []
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseEditDescriptionSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Зберегти", onClick = DescriptionEditSave description }
                    |> Button.withDisabled (String.isEmpty model.editDescriptionInp)
                    |> Button.view
                ]
            ]
        ]
