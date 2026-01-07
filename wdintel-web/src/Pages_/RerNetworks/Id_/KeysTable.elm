module Pages_.RerNetworks.Id_.KeysTable exposing
    ( createSidebar
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
import Html.Styled as Styled
import List.Extra as ListX
import Pages_.RerNetworks.Id_.Model exposing (Model)
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (KeysMsg(..))
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Model exposing (isDarkMode)
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
            ( { networkModel
                | keyCreateSidebar = True
                , keyCreateSaving = False
                , keyCreateState =
                    { key = ""
                    , description = ""
                    , sigintNetworkFreqId = Nothing
                    }
                , keyCreateFreqSelect =
                    { networkModel.keyCreateFreqSelect | selected = Nothing }
              }
            , E.none
            )

        CloseKeyCreateSidebar ->
            ( { networkModel
                | keyCreateSidebar = False
                , keyCreateSaving = False
                , keyCreateState =
                    { key = ""
                    , description = ""
                    , sigintNetworkFreqId = Nothing
                    }
                , keyCreateFreqSelect =
                    { networkModel.keyCreateFreqSelect | selected = Nothing }
              }
            , E.none
            )

        KeyCreateKeyChanged value ->
            ( { networkModel
                | keyCreateState =
                    { networkModel.keyCreateState | key = value }
              }
            , E.none
            )

        KeyCreateDescriptionChanged value ->
            ( { networkModel
                | keyCreateState =
                    { networkModel.keyCreateState | description = value }
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
                    { networkModel.keyCreateFreqSelect
                        | state = imodel
                        , selected = updatedSelected
                    }
            in
            ( { networkModel
                | keyCreateFreqSelect = keyCreateFreqSelect
                , keyCreateState =
                    { networkModel.keyCreateState
                        | sigintNetworkFreqId = updatedSelected
                    }
              }
            , E.sendCmd <| Cmd.map KeyCreateFreqSelMsg icmd
            )

        CreateKeyClicked ->
            case networkModel.network of
                Success network ->
                    if String.trim networkModel.keyCreateState.key == "" then
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
                            { networkModel.keyCreateFreqSelect | selected = Nothing }
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
                            { networkModel.keyEditFreqSelect
                                | selected = keyData.sigintNetworkFreqId
                            }
                    in
                    ( { networkModel
                        | keyEditSidebar = Just updateReq
                        , keyEditSaving = False
                        , keyEditFreqSelect = keyEditFreqSelect
                      }
                    , E.none
                    )

                Nothing ->
                    ( networkModel, E.none )

        CloseKeyEditSidebar ->
            ( { networkModel
                | keyEditSidebar = Nothing
                , keyEditSaving = False
                , keyEditFreqSelect =
                    { networkModel.keyEditFreqSelect | selected = Nothing }
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
                    { networkModel.keyEditFreqSelect
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

        SaveKeyEditClicked ->
            case networkModel.keyEditSidebar of
                Just req ->
                    if String.trim req.key == "" then
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
                div [ class "table-responsive-modern" ]
                    [ if List.isEmpty keys then
                        emptyKeysPlaceholder

                      else
                        Table.view (keysTableConfig user networkModel) networkModel.keysTableState keys
                    ]

            _ ->
                Shared.Components.Spinner.loadingSpinnerSm
        ]


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
        selectedItem =
            findSelectItem model.keyEditFreqSelect.selected model.keyEditFreqSelect.items

        defaultOptions =
            Utils.Select.defaultOptions (isDarkMode shared.themeMode)

        keyIsEmpty =
            String.trim updateReq.key == ""
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати ключ" ]
            , p [ class "text-sm text-muted-foreground" ] [ text "Оновіть дані ключа" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6 space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Ключ*" ]
                , input
                    [ class <|
                        "w-full p-2 border rounded "
                            ++ (if keyIsEmpty then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                    , type_ "text"
                    , placeholder "Введіть ключ"
                    , value updateReq.key
                    , onInput KeyEditKeyChanged
                    ]
                    []
                , if keyIsEmpty then
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
                        |> Button.withDisabled keyIsEmpty
                        |> Button.view
                ]
            ]
        ]
    ]


keyCreateSidebarContent : Shared.Model -> Model -> List (Html KeysMsg)
keyCreateSidebarContent shared model =
    let
        selectedItem =
            findSelectItem model.keyCreateFreqSelect.selected model.keyCreateFreqSelect.items

        defaultOptions =
            Utils.Select.defaultOptions (isDarkMode shared.themeMode)

        keyIsEmpty =
            String.trim model.keyCreateState.key == ""
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Додати ключ" ]
            , p [ class "text-sm text-muted-foreground" ] [ text "Створіть новий ключ для мережі" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6 space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-1" ] [ text "Ключ*" ]
                , input
                    [ class <|
                        "w-full p-2 border rounded "
                            ++ (if keyIsEmpty then
                                    "border-red-500"

                                else
                                    "border-border"
                               )
                    , type_ "text"
                    , placeholder "Введіть ключ"
                    , value model.keyCreateState.key
                    , onInput KeyCreateKeyChanged
                    ]
                    []
                , if keyIsEmpty then
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
                        |> Button.withDisabled keyIsEmpty
                        |> Button.view
                ]
            ]
        ]
    ]


findSelectItem : Maybe Int -> List (Select.MenuItem Int) -> Maybe (Select.MenuItem Int)
findSelectItem selected items =
    selected
        |> Maybe.andThen
            (\selectedId ->
                items
                    |> List.filter (\item -> item.item == selectedId)
                    |> List.head
            )

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
    TableConfig.config
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
                                    { attributes = [ style "width" "120px" ]
                                    , children =
                                        [ if key.key == "🔑" then
                                            span [ class "text-muted-foreground text-sm" ] [ text "-" ]

                                          else
                                            Button.new { label = "Редагувати", onClick = OpenKeyEditSidebar key }
                                                |> Button.withStyleSecondary
                                                |> Button.view
                                        ]
                                    }
                            , sorter = Table.unsortable
                            }
                        ]

                    else
                        []
                   )
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
