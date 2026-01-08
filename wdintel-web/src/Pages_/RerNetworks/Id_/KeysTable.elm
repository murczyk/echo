module Pages_.RerNetworks.Id_.KeysTable exposing
    ( createSidebar
    , deleteKeyConfirmationModal
    , editSidebar
    , initLoad
    , update
    , view
    )

import Api
import Auth
import Bindings as B
import Core.Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onInput)
import Html.Styled as Styled
import List.Extra as ListX
import Pages_.RerNetworks.Id_.Model exposing (Model)
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (KeysMsg(..))
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Model exposing (isDarkMode)
import Utils.Modulations as Modulations
import Utils.Select
import String
import Utils.Api.ErrorHandling
import Utils.RemoteData exposing (RemoteData(..))


initLoad : Int -> Effect KeysMsg
initLoad networkId =
    E.sendCmd (Api.sigint_list_keys KeysReturnedByApi { sigintNetworkId = networkId })


update : Shared.Model -> KeysMsg -> Model -> ( Model, Effect KeysMsg )
update _ msg networkModel =
    case msg of
        KeysReturnedByApi (Err e) ->
            ( { networkModel | networkKeys = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження ключів" e
            )

        KeysReturnedByApi (Ok res) ->
            ( { networkModel | networkKeys = Success res.keys }
            , E.none
            )

        SetKeysTableState newState ->
            ( { networkModel | keysTableState = newState }
            , E.none
            )

        OpenKeyCreateSidebar ->
            let
                keyCreateFreqSelect =
                    let
                        select =
                            networkModel.keyCreateFreqSelect
                    in
                    { select | selected = Nothing }

                keyCreateModulationSelect =
                    let
                        select =
                            networkModel.keyCreateModulationSelect
                    in
                    { select | selected = Nothing }
            in
            ( { networkModel
                | keyCreateSidebar = True
                , keyCreateSaving = False
                , keyCreateState =
                    { key = ""
                    , description = ""
                    , sigintNetworkFreqId = Nothing
                    }
                , keyCreateFreqSelect = keyCreateFreqSelect
                , keyCreateModulationSelect = keyCreateModulationSelect
              }
            , E.none
            )

        CloseKeyCreateSidebar ->
            let
                keyCreateFreqSelect =
                    let
                        select =
                            networkModel.keyCreateFreqSelect
                    in
                    { select | selected = Nothing }

                keyCreateModulationSelect =
                    let
                        select =
                            networkModel.keyCreateModulationSelect
                    in
                    { select | selected = Nothing }
            in
            ( { networkModel
                | keyCreateSidebar = False
                , keyCreateSaving = False
                , keyCreateState =
                    { key = ""
                    , description = ""
                    , sigintNetworkFreqId = Nothing
                    }
                , keyCreateFreqSelect = keyCreateFreqSelect
                , keyCreateModulationSelect = keyCreateModulationSelect
              }
            , E.none
            )

        KeyCreateKeyChanged value ->
            let
                keyCreateState =
                    networkModel.keyCreateState
            in
            ( { networkModel
                | keyCreateState =
                    { keyCreateState | key = value }
              }
            , E.none
            )

        KeyCreateDescriptionChanged value ->
            let
                keyCreateState =
                    networkModel.keyCreateState
            in
            ( { networkModel
                | keyCreateState =
                    { keyCreateState | description = value }
              }
            , E.none
            )

        KeyCreateFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg networkModel.keyCreateFreqSelect.state

                updatedSelected =
                    Utils.Select.singleUpd mAct networkModel.keyCreateFreqSelect.selected

                keyCreateFreqSelect =
                    let
                        select =
                            networkModel.keyCreateFreqSelect
                    in
                    { select
                        | state = imodel
                        , selected = updatedSelected
                    }

                keyCreateState =
                    let
                        state =
                            networkModel.keyCreateState
                    in
                    { state | sigintNetworkFreqId = updatedSelected }
            in
            ( { networkModel
                | keyCreateFreqSelect = keyCreateFreqSelect
                , keyCreateState = keyCreateState
              }
            , E.sendCmd <| Cmd.map KeyCreateFreqSelMsg icmd
            )

        KeyCreateModulationSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg networkModel.keyCreateModulationSelect.state

                updatedSelected =
                    Utils.Select.singleUpd mAct networkModel.keyCreateModulationSelect.selected

                keyCreateModulationSelect =
                    let
                        select =
                            networkModel.keyCreateModulationSelect
                    in
                    { select
                        | state = imodel
                        , selected = updatedSelected
                    }
            in
            ( { networkModel
                | keyCreateModulationSelect = keyCreateModulationSelect
              }
            , E.sendCmd <| Cmd.map KeyCreateModulationSelMsg icmd
            )

        CreateKeyClicked ->
            case networkModel.network of
                Success network ->
                    if networkModel.keyCreateModulationSelect.selected == Nothing then
                        ( networkModel, E.none )

                    else if String.trim networkModel.keyCreateState.key == "" then
                        ( networkModel, E.none )

                    else
                        let
                            description =
                                if String.trim networkModel.keyCreateState.description == "" then
                                    Nothing

                                else
                                    Just networkModel.keyCreateState.description

                            req =
                                { sigintNetworkId = network.id
                                , sigintNetworkFreqId =
                                    networkModel.keyCreateState.sigintNetworkFreqId
                                , key = networkModel.keyCreateState.key
                                , description = description
                                }
                        in
                        ( { networkModel | keyCreateSaving = True }
                        , E.sendCmd <|
                            Api.sigint_create_key KeyCreated req
                        )

                _ ->
                    ( networkModel, E.none )

        KeyCreated (Err e) ->
            ( { networkModel | keyCreateSaving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання ключа" e
            )

        KeyCreated (Ok _) ->
            case networkModel.network of
                Success network ->
                    ( { networkModel
                        | keyCreateSaving = False
                        , keyCreateSidebar = False
                        , keyCreateState =
                            { key = ""
                            , description = ""
                            , sigintNetworkFreqId = Nothing
                            }
                        , keyCreateFreqSelect =
                            let
                                select =
                                    networkModel.keyCreateFreqSelect
                            in
                            { select | selected = Nothing }
                      }
                    , initLoad network.id
                    )

                _ ->
                    ( { networkModel | keyCreateSaving = False }, E.none )

        OpenKeyEditSidebar keyData ->
            case keyData.id of
                Just keyId ->
                    let
                        updateReq =
                            { id = keyId
                            , sigintNetworkFreqId = keyData.sigintNetworkFreqId
                            , key = keyData.key
                            , description = keyData.description
                            }

                        keyEditFreqSelect =
                            let
                                select =
                                    networkModel.keyEditFreqSelect
                            in
                            { select
                                | selected = keyData.sigintNetworkFreqId
                            }

                        keyEditModulationSelect =
                            let
                                selectedModulation =
                                    case ( networkModel.freqs, keyData.sigintNetworkFreqId ) of
                                        ( Success freqs, Just freqId ) ->
                                            freqs
                                                |> ListX.find (\freq -> freq.networkFreqId == freqId)
                                                |> Maybe.andThen .modulationId

                                        _ ->
                                            Nothing

                                select =
                                    networkModel.keyEditModulationSelect
                            in
                            { select | selected = selectedModulation }
                    in
                    ( { networkModel
                        | keyEditSidebar = Just updateReq
                        , keyEditSaving = False
                        , keyEditFreqSelect = keyEditFreqSelect
                        , keyEditModulationSelect = keyEditModulationSelect
                      }
                    , E.none
                    )

                Nothing ->
                    ( networkModel, E.none )

        CloseKeyEditSidebar ->
            let
                keyEditFreqSelect =
                    let
                        select =
                            networkModel.keyEditFreqSelect
                    in
                    { select | selected = Nothing }

                keyEditModulationSelect =
                    let
                        select =
                            networkModel.keyEditModulationSelect
                    in
                    { select | selected = Nothing }
            in
            ( { networkModel
                | keyEditSidebar = Nothing
                , keyEditSaving = False
                , keyEditFreqSelect = keyEditFreqSelect
                , keyEditModulationSelect = keyEditModulationSelect
              }
            , E.none
            )

        KeyEditKeyChanged value ->
            ( { networkModel
                | keyEditSidebar =
                    networkModel.keyEditSidebar
                        |> Maybe.map (\req -> { req | key = value })
              }
            , E.none
            )

        KeyEditDescriptionChanged value ->
            let
                description =
                    if String.trim value == "" then
                        Nothing

                    else
                        Just value
            in
            ( { networkModel
                | keyEditSidebar =
                    networkModel.keyEditSidebar
                        |> Maybe.map (\req -> { req | description = description })
              }
            , E.none
            )

        KeyEditFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg networkModel.keyEditFreqSelect.state

                updatedSelected =
                    Utils.Select.singleUpd mAct networkModel.keyEditFreqSelect.selected

                keyEditFreqSelect =
                    let
                        select =
                            networkModel.keyEditFreqSelect
                    in
                    { select
                        | state = imodel
                        , selected = updatedSelected
                    }
            in
            ( { networkModel
                | keyEditFreqSelect = keyEditFreqSelect
                , keyEditSidebar =
                    networkModel.keyEditSidebar
                        |> Maybe.map
                            (\req ->
                                { req
                                    | sigintNetworkFreqId = updatedSelected
                                }
                            )
              }
            , E.sendCmd <| Cmd.map KeyEditFreqSelMsg icmd
            )

        KeyEditModulationSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg networkModel.keyEditModulationSelect.state

                updatedSelected =
                    Utils.Select.singleUpd mAct networkModel.keyEditModulationSelect.selected

                keyEditModulationSelect =
                    let
                        select =
                            networkModel.keyEditModulationSelect
                    in
                    { select
                        | state = imodel
                        , selected = updatedSelected
                    }
            in
            ( { networkModel
                | keyEditModulationSelect = keyEditModulationSelect
              }
            , E.sendCmd <| Cmd.map KeyEditModulationSelMsg icmd
            )

        SaveKeyEditClicked ->
            case networkModel.keyEditSidebar of
                Just req ->
                    if networkModel.keyEditModulationSelect.selected == Nothing then
                        ( networkModel, E.none )

                    else if String.trim req.key == "" then
                        ( networkModel, E.none )

                    else
                        ( { networkModel | keyEditSaving = True }
                        , E.sendCmd <| Api.sigint_update_key KeyUpdated req
                        )

                Nothing ->
                    ( networkModel, E.none )

        KeyUpdated (Err e) ->
            ( { networkModel | keyEditSaving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення ключа" e
            )

        KeyUpdated (Ok _) ->
            case networkModel.network of
                Success network ->
                    ( { networkModel | keyEditSaving = False, keyEditSidebar = Nothing }
                    , initLoad network.id
                    )

                _ ->
                    ( { networkModel | keyEditSaving = False }, E.none )

        DeleteKeyClickedByUser keyId keyValue ->
            ( { networkModel | deleteKeyConfirmation = Just ( keyId, keyValue ) }
            , E.none
            )

        DeleteKeyCanceledByUser ->
            ( { networkModel | deleteKeyConfirmation = Nothing }
            , E.none
            )

        DeleteKeyConfirmedByUser ->
            case ( networkModel.network, networkModel.deleteKeyConfirmation ) of
                ( Success _, Just ( keyId, _ ) ) ->
                    ( { networkModel
                        | deleteKeyLoading = True
                        , deleteKeyConfirmation = Nothing
                      }
                    , E.sendCmd <|
                        Api.sigint_delete_key DeleteKeyReturnedByApi { id = keyId }
                    )

                _ ->
                    ( networkModel, E.none )

        DeleteKeyReturnedByApi (Err e) ->
            ( { networkModel | deleteKeyLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення ключа" e
            )

        DeleteKeyReturnedByApi (Ok _) ->
            case networkModel.network of
                Success network ->
                    ( { networkModel | deleteKeyLoading = False }
                    , initLoad network.id
                    )

                _ ->
                    ( { networkModel | deleteKeyLoading = False }, E.none )


view : Model -> Auth.User -> Html KeysMsg
view networkModel user =
    section [ class "bg-w dark:bg-[#1C1C21] p-[16px] mt-[30px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [] [ text "Ключі" ]
            , if Core.Auth.hasRole "UnitsEditor" user then
                Button.new { label = "Додати ключ", onClick = OpenKeyCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view

              else
                text ""
            ]
        , case networkModel.networkKeys of
            Success keys ->
                div [ class "table-responsive-modern w-full" ]
                    [ if List.isEmpty keys then
                        emptyKeysPlaceholder

                      else
                        Table.view (keysTableConfig user networkModel) networkModel.keysTableState keys
                    ]

            _ ->
                Shared.Components.Spinner.loadingSpinnerSm
        ]


deleteKeyConfirmationModal : Model -> Html KeysMsg
deleteKeyConfirmationModal model =
    let
        keyValue =
            case model.deleteKeyConfirmation of
                Just ( _, value ) ->
                    keyLabel value

                Nothing ->
                    "-"

        deleteKeyDialogContent =
            [ div [ class "flex flex-col justify-between gap-4 p-2 w-[400px]" ]
                [ div [ class "pb-12" ]
                    [ h2 [] [ text "Видалити ключ" ]
                    , p [] [ text <| "Ви впевнені, що хочете видалити ключ \"" ++ keyValue ++ "\"?" ]
                    ]
                , div [ class "flex justify-between" ]
                    [ Button.new { label = "Скасувати", onClick = DeleteKeyCanceledByUser }
                        |> Button.withStyleSecondary
                        |> Button.view
                    , Button.new { label = "Видалити", onClick = DeleteKeyConfirmedByUser }
                        |> Button.withStyleDanger
                        |> (if model.deleteKeyLoading then
                                Button.withIcon
                                    [ Shared.Components.Spinner.loadingSpinner2Sm ]

                            else
                                identity
                           )
                        |> Button.view
                    ]
                ]
            ]
    in
    ModalDialog.modalDialog (model.deleteKeyConfirmation /= Nothing) DeleteKeyCanceledByUser [] deleteKeyDialogContent


editSidebar : Model -> Auth.User -> Shared.Model -> Html KeysMsg
editSidebar model user shared =
    case model.keyEditSidebar of
        Just updateReq ->
            if Core.Auth.hasRole "UnitsEditor" user then
                Sidebar.view True CloseKeyEditSidebar (keyEditSidebarContent shared model updateReq)

            else
                text ""

        Nothing ->
            text ""


createSidebar : Model -> Auth.User -> Shared.Model -> Html KeysMsg
createSidebar model user shared =
    if model.keyCreateSidebar && Core.Auth.hasRole "UnitsEditor" user then
        Sidebar.view True CloseKeyCreateSidebar (keyCreateSidebarContent shared model)

    else
        text ""


keyEditSidebarContent : Shared.Model -> Model -> B.UpdateEncryptionKeyReq -> List (Html KeysMsg)
keyEditSidebarContent shared model updateReq =
    let
        isModulationSelected =
            model.keyEditModulationSelect.selected /= Nothing

        selectedModulationName =
            case ( model.modulations, model.keyEditModulationSelect.selected ) of
                ( Success modulations, Just modulationId ) ->
                    if modulationId == Modulations.undefinedModulationId then
                        Nothing

                    else
                        modulations
                            |> ListX.find (\modulation -> modulation.id == modulationId)
                            |> Maybe.map .name

                _ ->
                    Nothing

        keyMaxLength =
            case selectedModulationName of
                Just "DMR (ARC40)" ->
                    Just 4

                Just "DMR (AES256)" ->
                    Just 64

                Just "HYTERA (256 bit)" ->
                    Just 64

                Just "TYT (16 bit)" ->
                    Just 4

                Just "TYT (128 bit)" ->
                    Just 32

                Just "NFM" ->
                    Nothing

                Just "AM" ->
                    Nothing

                Just "АМ" ->
                    Nothing

                Just "DMR" ->
                    Nothing

                Just "HYTERA" ->
                    Nothing

                Just "TYT" ->
                    Nothing

                Just "TETRA" ->
                    Nothing

                Just "Гранит" ->
                    Nothing

                Just "GSM" ->
                    Nothing

                Just "Умовна" ->
                    Nothing

                _ ->
                    Nothing

        selectedItem =
            findSelectItem model model.keyEditFreqSelect.selected

        defaultOptions =
            Utils.Select.defaultOptions (isDarkMode shared.themeMode)

        keyIsEmpty =
            String.trim updateReq.key == ""

        modulationIsEmpty =
            not isModulationSelected
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати ключ" ]
            , p [ class "text-sm text-muted-foreground" ] [ text "Оновіть дані ключа" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6 space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Модуляція*" ]
                , Html.map KeyEditModulationSelMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelectSingle
                            (Maybe.map (\item -> Select.basicMenuItem { item = item, label = modulationLabelById model item }) model.keyEditModulationSelect.selected)
                            model.keyEditModulationSelect.state
                            model.keyEditModulationSelect.items
                            "Оберіть модуляцію"
                            defaultOptions
                , if modulationIsEmpty then
                    div [ class "text-sm text-red-600 mt-1" ] [ text "Це поле обов'язкове" ]

                  else
                    text ""
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Ключ*" ]
                , input
                    ([ class <|
                        "w-full p-2 border rounded "
                            ++ (if keyIsEmpty && isModulationSelected then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                     , type_ "text"
                     , placeholder "Введіть ключ"
                     , value updateReq.key
                     , onInput KeyEditKeyChanged
                     , disabled (not isModulationSelected)
                     ]
                        ++ (case keyMaxLength of
                                Just maxLen ->
                                    [ maxlength maxLen ]

                                Nothing ->
                                    []
                           )
                    )
                    []
                , if keyIsEmpty && isModulationSelected then
                    div [ class "text-sm text-red-600 mt-1" ] [ text "Це поле обов'язкове" ]

                  else
                    text ""
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Опис" ]
                , textarea
                    [ class "w-full p-2 border border-border rounded resize-none"
                    , rows 3
                    , placeholder "Додайте опис (необов'язково)"
                    , value (Maybe.withDefault "" updateReq.description)
                    , onInput KeyEditDescriptionChanged
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота (необов'язково)" ]
                , Html.map KeyEditFreqSelMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelectSingle
                            selectedItem
                            model.keyEditFreqSelect.state
                            model.keyEditFreqSelect.items
                            "Без частоти"
                            defaultOptions
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseKeyEditSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.keyEditSaving then
                    Button.new { label = "Збереження...", onClick = SaveKeyEditClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Зберегти", onClick = SaveKeyEditClicked }
                        |> Button.withDisabled (modulationIsEmpty || keyIsEmpty)
                        |> Button.view
                ]
            ]
        ]
    ]


keyCreateSidebarContent : Shared.Model -> Model -> List (Html KeysMsg)
keyCreateSidebarContent shared model =
    let
        isModulationSelected =
            model.keyCreateModulationSelect.selected /= Nothing

        selectedModulationName =
            case ( model.modulations, model.keyCreateModulationSelect.selected ) of
                ( Success modulations, Just modulationId ) ->
                    if modulationId == Modulations.undefinedModulationId then
                        Nothing

                    else
                        modulations
                            |> ListX.find (\modulation -> modulation.id == modulationId)
                            |> Maybe.map .name

                _ ->
                    Nothing

        keyMaxLength =
            case selectedModulationName of
                Just "DMR (ARC40)" ->
                    Just 4

                Just "DMR (AES256)" ->
                    Just 64

                Just "HYTERA (256 bit)" ->
                    Just 64

                Just "TYT (16 bit)" ->
                    Just 4

                Just "TYT (128 bit)" ->
                    Just 32

                Just "NFM" ->
                    Nothing

                Just "AM" ->
                    Nothing

                Just "АМ" ->
                    Nothing

                Just "DMR" ->
                    Nothing

                Just "HYTERA" ->
                    Nothing

                Just "TYT" ->
                    Nothing

                Just "TETRA" ->
                    Nothing

                Just "Гранит" ->
                    Nothing

                Just "GSM" ->
                    Nothing

                Just "Умовна" ->
                    Nothing

                _ ->
                    Nothing

        selectedItem =
            findSelectItem model model.keyCreateFreqSelect.selected

        defaultOptions =
            Utils.Select.defaultOptions (isDarkMode shared.themeMode)

        keyIsEmpty =
            String.trim model.keyCreateState.key == ""

        modulationIsEmpty =
            not isModulationSelected
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Додати ключ" ]
            , p [ class "text-sm text-muted-foreground" ] [ text "Створіть новий ключ для мережі" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6 space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Модуляція*" ]
                , Html.map KeyCreateModulationSelMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelectSingle
                            (Maybe.map (\item -> Select.basicMenuItem { item = item, label = modulationLabelById model item }) model.keyCreateModulationSelect.selected)
                            model.keyCreateModulationSelect.state
                            model.keyCreateModulationSelect.items
                            "Оберіть модуляцію"
                            defaultOptions
                , if modulationIsEmpty then
                    div [ class "text-sm text-red-600 mt-1" ] [ text "Це поле обов'язкове" ]

                  else
                    text ""
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Ключ*" ]
                , input
                    ([ class <|
                        "w-full p-2 border rounded "
                            ++ (if keyIsEmpty && isModulationSelected then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                     , type_ "text"
                     , placeholder "Введіть ключ"
                     , value model.keyCreateState.key
                     , onInput KeyCreateKeyChanged
                     , disabled (not isModulationSelected)
                     ]
                        ++ (case keyMaxLength of
                                Just maxLen ->
                                    [ maxlength maxLen ]

                                Nothing ->
                                    []
                           )
                    )
                    []
                , if keyIsEmpty && isModulationSelected then
                    div [ class "text-sm text-red-600 mt-1" ] [ text "Це поле обов'язкове" ]

                  else
                    text ""
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Опис" ]
                , textarea
                    [ class "w-full p-2 border border-border rounded resize-none"
                    , rows 3
                    , placeholder "Додайте опис (необов'язково)"
                    , value model.keyCreateState.description
                    , onInput KeyCreateDescriptionChanged
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Частота (необов'язково)" ]
                , Html.map KeyCreateFreqSelMsg <|
                    Styled.toUnstyled <|
                        Utils.Select.renderSelectSingle
                            selectedItem
                            model.keyCreateFreqSelect.state
                            model.keyCreateFreqSelect.items
                            "Без частоти"
                            defaultOptions
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseKeyCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , if model.keyCreateSaving then
                    Button.new { label = "Додавання...", onClick = CreateKeyClicked }
                        |> Button.withDisabled True
                        |> Button.view

                  else
                    Button.new { label = "Додати", onClick = CreateKeyClicked }
                        |> Button.withDisabled (modulationIsEmpty || keyIsEmpty)
                        |> Button.view
                ]
            ]
        ]
    ]


findSelectItem : Model -> Maybe Int -> Maybe (Select.MenuItem Int)
findSelectItem model selectedId =
    case ( model.freqs, selectedId ) of
        ( Success freqs, Just freqId ) ->
            freqs
                |> ListX.find (\freq -> freq.networkFreqId == freqId)
                |> Maybe.map
                    (\freq ->
                        Select.basicMenuItem
                            { item = freq.networkFreqId
                            , label = freq.freq
                            }
                    )

        _ ->
            Nothing

emptyKeysPlaceholder : Html msg
emptyKeysPlaceholder =
    div
        [ class "flex flex-col items-center justify-center py-12 text-center" ]
        [ i [ class "bi bi-key text-4xl text-gray-400 mb-4" ] []
        , p [ class "text-gray-600 dark:text-gray-400 text-lg font-medium" ] [ text "Немає ключів в мережі" ]
        , p [ class "text-gray-500 dark:text-gray-500 text-sm mt-2" ]
            [ text "Додайте ключі до мережі або частот" ]
        ]


keysTableConfig : Auth.User -> Model -> Table.Config B.EncryptionKeyData KeysMsg
keysTableConfig user networkModel =
    let
        defaultCustomizations =
            Table.defaultCustomizations

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute KeysMsg ) -> Html KeysMsg
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

        customThead : List ( String, TableConfig.Status, Html.Attribute KeysMsg ) -> TableColumn.HtmlDetails KeysMsg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    Table.customConfig
        { toId = keyRowId
        , toMsg = SetKeysTableState
        , columns =
            [ TableColumn.stringColumn "Частота" (\key -> freqLabelById networkModel key.sigintNetworkFreqId)
            , TableColumn.stringColumn "Ключ" (\key -> keyLabel key.key)
            , TableColumn.stringColumn "Опис" (\key -> Maybe.withDefault "-" key.description)
            ]
                ++ (if Core.Auth.hasRole "UnitsEditor" user then
                        [ Table.veryCustomColumn
                            { name = "Дії"
                            , viewData =
                                \key ->
                                    { attributes = [ class "col-narrow" ]
                                    , children =
                                        [ if key.key == "🔑" then
                                            span [ class "text-muted-foreground text-sm" ] [ text "-" ]

                                          else
                                            case key.id of
                                                Just keyId ->
                                                    div [ class "flex gap-[4px] text-sm" ]
                                                        [ button
                                                            [ title "Редагувати"
                                                            , class "icon-btn icon-btn-primary"
                                                            , onClick (OpenKeyEditSidebar key)
                                                            ]
                                                            [ i [ class "bi bi-pencil-square" ] [] ]
                                                        , button
                                                            [ title "Видалити ключ"
                                                            , class "icon-btn icon-btn-danger"
                                                            , onClick (DeleteKeyClickedByUser keyId (keyLabel key.key))
                                                            ]
                                                            [ i [ class "bi bi-trash" ] [] ]
                                                        ]

                                                Nothing ->
                                                    span [ class "text-muted-foreground text-sm" ] [ text "-" ]
                                        ]
                                    }
                            , sorter = Table.unsortable
                            }
                        ]

                    else
                        []
                   )
        , customizations = customizations
        }


keyRowId : B.EncryptionKeyData -> String
keyRowId key =
    case key.id of
        Just keyId ->
            String.fromInt keyId

        Nothing ->
            String.join "|"
                [ Maybe.map String.fromInt key.sigintNetworkFreqId
                    |> Maybe.withDefault "no-freq"
                , Maybe.map String.fromInt key.sigintNetworkId
                    |> Maybe.withDefault "no-network"
                , key.key
                , Maybe.withDefault "" key.description
                ]


freqLabelById : Model -> Maybe Int -> String
freqLabelById networkModel freqId =
    case ( networkModel.freqs, freqId ) of
        ( Success freqs, Just id ) ->
            freqs
                |> ListX.find (\freq -> freq.networkFreqId == id)
                |> Maybe.map .freq
                |> Maybe.withDefault "-"

        _ ->
            "-"


keyLabel : String -> String
keyLabel value =
    if String.trim value == "" then
        "-"

    else
        value


modulationLabelById : Model -> Int -> String
modulationLabelById model modulationId =
    case model.modulations of
        Success modulations ->
            if modulationId == Modulations.undefinedModulationId then
                Modulations.undefinedModulationLabel

            else
                modulations
                    |> ListX.find (\modulation -> modulation.id == modulationId)
                    |> Maybe.map (.name >> Modulations.displayModulationName)
                    |> Maybe.withDefault Modulations.undefinedModulationLabel

        _ ->
            Modulations.undefinedModulationLabel
