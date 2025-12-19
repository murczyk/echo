module Pages.RerSignals exposing (EditSignalState, Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Auth
import Core.Types exposing (ApiError)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Watermark as Watermark
import Shared.Model exposing (isDarkMode)
import Task
import Time
import TimeZone
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update shared
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }


type alias Model =
    { inpUnitSelState : Select.State
    , signals : List B.Signal
    , deleteSignalConfirmation : Maybe Int
    , deleteDialogOpen : Bool
    , inpText : String
    , inpMeaning : String
    , inpUnit : Maybe Int
    , inpCoordinates : String
    , editSignalState : Maybe EditSignalState
    , editSignalSidebar : Maybe ( Int, B.Signal )
    , loading : Bool
    , loadingUnitStats : Bool
    , filterUnit : Maybe String
    , filterUnitDebounce : Debounce String
    , filterText : Maybe String
    , filterTextDebounce : Debounce String
    , filterMeaning : Maybe String
    , filterMeaningDebounce : Debounce String
    , unitStats : List B.SignalUnitStatRow
    , sortBy : List B.ListSignalsSortBy
    , tableState : Table.State
    , downloadCsvInProgress : Bool
    }


type Msg
    = GotSignals (Result ApiError B.ListSignalsRsp)
    | AddUnitSelMsg (Select.Msg Int)
    | EditUnitSelMsg (Select.Msg Int)
    | InpText String
    | InpMeaning String
    | InpCoordinates String
    | AddSignal
    | AddSignalDone (Result ApiError Int)
    | DeleteSignal Int
    | DeleteSignalConfirm
    | DeleteSignalCancel
    | DeleteSignalDone (Result ApiError Int)
    | EditSignal Int
    | EditSignalMsg EditSignalState
    | EditSignalSave Int
    | EditSignalDone Int (Result ApiError Int)
    | EditSignalCancel Int
    | FilterUnitMsg String
    | FilterUnitDebounceMsg Debounce.Msg
    | FilterMeaningMsg String
    | FilterMeaningDebounceMsg Debounce.Msg
    | FilterTextMsg String
    | FilterTextDebounceMsg Debounce.Msg
    | Refresh
    | DownloadCsv Bool
    | DownloadCsvDone (Result ApiError Bytes)
    | ClearInputs
    | GotUnitStats (Result ApiError B.SignalUnitStatsRsp)
    | SetTableState Table.State
    | OpenEditSignalSidebar Int B.Signal
    | CloseEditSignalSidebar


type alias EditSignalState =
    { inpText : String
    , inpMeaning : String
    , inpUnit : Int
    , inpCoordinates : String
    , inpUnitSelState : Select.State
    }


filterUnitDebounceConfig : Debounce.Config Msg
filterUnitDebounceConfig =
    { strategy = Debounce.later 50
    , transform = FilterUnitDebounceMsg
    }


filterTextDebounceConfig : Debounce.Config Msg
filterTextDebounceConfig =
    { strategy = Debounce.later 50
    , transform = FilterTextDebounceMsg
    }


filterMeaningDebounceConfig : Debounce.Config Msg
filterMeaningDebounceConfig =
    { strategy = Debounce.later 50
    , transform = FilterMeaningDebounceMsg
    }


init : () -> ( Model, Effect Msg )
init _ =
    let
        m2 : Model
        m2 =
            { inpUnitSelState = Select.initState (Select.selectIdentifier "sel-unit-add")
            , signals = []
            , deleteSignalConfirmation = Nothing
            , deleteDialogOpen = False
            , inpText = ""
            , inpMeaning = ""
            , inpUnit = Nothing
            , inpCoordinates = ""
            , editSignalState = Nothing
            , editSignalSidebar = Nothing
            , loading = True
            , loadingUnitStats = True
            , filterUnitDebounce = Debounce.init
            , filterUnit = Nothing
            , filterText = Nothing
            , filterTextDebounce = Debounce.init
            , filterMeaning = Nothing
            , filterMeaningDebounce = Debounce.init
            , sortBy = []
            , unitStats = []
            , tableState = Table.sortBy "Дата внесення" False
            , downloadCsvInProgress = False
            }
    in
    ( m2
    , E.batch
        [ loadSignals m2
        , loadUnitStats
        ]
    )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        GotSignals (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження сигналів" err
            )

        GotSignals (Ok rsp) ->
            ( { model | signals = rsp.signals, loading = False }
            , E.none
            )

        EditUnitSelMsg selMsg ->
            case model.editSignalState of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    let
                        ( mAction, iState, iCmd ) =
                            Select.update selMsg editState.inpUnitSelState
                    in
                    ( { model
                        | editSignalState =
                            case Utils.Select.singleUpd mAction (Just editState.inpUnit) of
                                Nothing ->
                                    Nothing

                                Just unitId ->
                                    Just
                                        { editState
                                            | inpUnitSelState = iState
                                            , inpUnit =
                                                unitId
                                        }
                      }
                    , E.sendCmd <| Cmd.map EditUnitSelMsg iCmd
                    )

        AddUnitSelMsg selMsg ->
            let
                ( mAction, iState, iCmd ) =
                    Select.update selMsg model.inpUnitSelState

                mUnitId =
                    Utils.Select.singleUpd mAction model.inpUnit

                m2 =
                    { model
                        | inpUnitSelState = iState
                        , inpUnit = mUnitId
                    }
            in
            ( m2
            , E.batch
                [ E.sendCmd <| Cmd.map AddUnitSelMsg iCmd ]
            )

        DeleteSignal id ->
            ( { model | deleteSignalConfirmation = Just id, deleteDialogOpen = True }
            , E.none
            )

        DeleteSignalConfirm ->
            let
                m2 =
                    { model | deleteSignalConfirmation = Nothing, deleteDialogOpen = False }
            in
            case model.deleteSignalConfirmation of
                Nothing ->
                    ( m2, E.none )

                Just id ->
                    ( m2
                    , E.sendCmd <| Api.sigint_signal_delete DeleteSignalDone id
                    )

        DeleteSignalCancel ->
            ( { model | deleteSignalConfirmation = Nothing, deleteDialogOpen = False }, E.none )

        DeleteSignalDone (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення сигналу" err
            )

        DeleteSignalDone (Ok _) ->
            ( { model | loading = True, loadingUnitStats = True, deleteDialogOpen = False }
            , initLoad model
            )

        EditSignal id ->
            case ListX.find (\u -> u.id == id) model.signals of
                Nothing ->
                    ( model, E.none )

                Just signal ->
                    ( { model
                        | editSignalState =
                            Just
                                { inpText = signal.text
                                , inpMeaning = Maybe.withDefault "" signal.meaning
                                , inpCoordinates = Maybe.withDefault "" signal.coordinates
                                , inpUnit = Maybe.withDefault 0 signal.unit
                                , inpUnitSelState =
                                    Select.initState
                                        (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt id)
                                }
                      }
                    , E.none
                    )

        EditSignalMsg editState ->
            ( { model | editSignalState = Just editState }
            , E.none
            )

        EditSignalSave id ->
            case model.editSignalState of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    case ListX.find (\u -> u.id == id) model.signals of
                        Nothing ->
                            ( model, E.none )

                        Just _ ->
                            ( model
                            , E.sendCmd <|
                                Api.sigint_signal_update (EditSignalDone id)
                                    { id = id
                                    , text = editState.inpText
                                    , meaning =
                                        if editState.inpMeaning == "" then
                                            Nothing

                                        else
                                            Just editState.inpMeaning
                                    , coordinates =
                                        if editState.inpCoordinates == "" then
                                            Nothing

                                        else
                                            Just editState.inpCoordinates
                                    , unit =
                                        case shared.masterUnits of
                                            Success units ->
                                                Maybe.map (\u -> u.id) (Dict.get editState.inpUnit units)

                                            _ ->
                                                Nothing
                                    }
                            )

        EditSignalDone _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення сигналу" err
            )

        EditSignalDone id (Ok _) ->
            ( { model | editSignalState = Nothing, editSignalSidebar = Nothing, loading = True, loadingUnitStats = True }
            , initLoad model
            )

        EditSignalCancel id ->
            ( { model | editSignalState = Nothing }, E.none )

        InpText v ->
            ( { model | inpText = v }, E.none )

        InpMeaning v ->
            ( { model | inpMeaning = v }, E.none )

        InpCoordinates v ->
            ( { model | inpCoordinates = v }, E.none )

        AddSignal ->
            ( model
            , E.sendCmd <|
                Api.sigint_signal_create AddSignalDone
                    { text = model.inpText
                    , meaning =
                        case model.inpMeaning of
                            "" ->
                                Nothing

                            _ ->
                                Just model.inpMeaning
                    , unit = model.inpUnit
                    , coordinates =
                        case model.inpCoordinates of
                            "" ->
                                Nothing

                            _ ->
                                Just model.inpCoordinates
                    }
            )

        AddSignalDone (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення сигналу" err
            )

        --TODO: подивитися чи можна не перезавантажувати все кожного разу
        AddSignalDone (Ok _) ->
            ( { model | loading = True, loadingUnitStats = True, inpText = "", inpMeaning = "", inpCoordinates = "" }
            , initLoad model
            )

        FilterUnitDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterUnitDebounceConfig
                        (Debounce.takeLast (\_ -> loadSignalsCmd model))
                        imsg
                        model.filterUnitDebounce
            in
            ( { model
                | filterUnitDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        FilterTextDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterTextDebounceConfig
                        (Debounce.takeLast (\_ -> loadSignalsCmd model))
                        imsg
                        model.filterTextDebounce
            in
            ( { model
                | filterTextDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        FilterMeaningDebounceMsg imsg ->
            let
                ( debounce, debounceCmd ) =
                    Debounce.update
                        filterMeaningDebounceConfig
                        (Debounce.takeLast (\_ -> loadSignalsCmd model))
                        imsg
                        model.filterMeaningDebounce
            in
            ( { model
                | filterMeaningDebounce = debounce
                , loading = True
              }
            , E.sendCmd debounceCmd
            )

        FilterUnitMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterUnitDebounceConfig v model.filterUnitDebounce
            in
            ( { model
                | filterUnit =
                    if v == "" then
                        Nothing

                    else
                        Just v
                , filterUnitDebounce = debounce
              }
            , E.sendCmd cmd
            )

        FilterTextMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterTextDebounceConfig v model.filterTextDebounce
            in
            ( { model
                | filterText =
                    if v == "" then
                        Nothing

                    else
                        Just v
                , filterTextDebounce = debounce
              }
            , E.sendCmd cmd
            )

        FilterMeaningMsg v ->
            let
                ( debounce, cmd ) =
                    Debounce.push filterMeaningDebounceConfig v model.filterMeaningDebounce
            in
            ( { model
                | filterMeaning =
                    if v == "" then
                        Nothing

                    else
                        Just v
                , filterMeaningDebounce = debounce
              }
            , E.sendCmd cmd
            )

        Refresh ->
            ( { model | loading = True, loadingUnitStats = True }
            , initLoad model
            )

        DownloadCsv allowed ->
            if allowed then
                ( { model | downloadCsvInProgress = True }
                , E.sendCmd <| Api.sigint_list_signals_csv DownloadCsvDone (listSignalsReq model)
                )

            else
                ( model, E.none )

        DownloadCsvDone (Err err) ->
            ( { model | downloadCsvInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження CSV" err
            )

        DownloadCsvDone (Ok bytes) ->
            ( { model | downloadCsvInProgress = False }
            , E.sendCmd <| Download.bytes "signals.csv" "text/csv" bytes
            )

        ClearInputs ->
            ( { model | inpText = "", inpMeaning = "", inpUnit = Nothing, inpCoordinates = "" }, E.none )

        GotUnitStats (Err err) ->
            ( { model | loadingUnitStats = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
            )

        GotUnitStats (Ok rsp) ->
            ( { model | unitStats = rsp.units, loadingUnitStats = False }
            , E.none
            )

        SetTableState tableState ->
            ( { model | tableState = tableState }
            , E.none
            )

        OpenEditSignalSidebar signalId signal ->
            ( { model
                | editSignalSidebar = Just ( signalId, signal )
                , editSignalState =
                    Just
                        { inpText = signal.text
                        , inpMeaning = Maybe.withDefault "" signal.meaning
                        , inpUnit = Maybe.withDefault 0 signal.unit
                        , inpCoordinates = Maybe.withDefault "" signal.coordinates
                        , inpUnitSelState = Select.initState (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt signalId)
                        }
              }
            , E.none
            )

        CloseEditSignalSidebar ->
            ( { model
                | editSignalSidebar = Nothing
                , editSignalState = Nothing
              }
            , E.none
            )


initLoad : Model -> Effect Msg
initLoad model =
    E.batch
        [ loadSignals model
        , loadUnitStats
        ]



-- Helper function to populate unit menu from shared masterUnits


populateUnitMenu : Shared.Model -> List (Select.MenuItem Int)
populateUnitMenu shared =
    case shared.masterUnits of
        Success units ->
            List.map (\u -> Select.basicMenuItem { item = u.id, label = u.name }) (Dict.values units)

        _ ->
            []


loadUnitStats : Effect Msg
loadUnitStats =
    E.sendCmd <| Api.sigint_signal_unit_stats GotUnitStats ()


listSignalsReq : Model -> B.ListSignalsReq
listSignalsReq model =
    { sortBy = model.sortBy
    , filterText = model.filterText
    , filterMeaning = model.filterMeaning
    , filterUnit = model.filterUnit
    }


loadSignalsCmd : Model -> Cmd Msg
loadSignalsCmd model =
    Api.sigint_list_signals GotSignals (listSignalsReq model)


loadSignals : Model -> Effect Msg
loadSignals model =
    E.sendCmd <| loadSignalsCmd model


filteredSignals : Model -> List B.Signal
filteredSignals model =
    model.signals
        |> List.filter (\signal -> String.contains (String.toLower model.inpText) (String.toLower signal.text))
        |> List.filter
            (\signal ->
                case signal.meaning of
                    Just meaning ->
                        String.contains (String.toLower model.inpMeaning) (String.toLower meaning)

                    Nothing ->
                        True
            )
        |> List.filter
            (\signal ->
                case model.inpUnit of
                    Just inpUnit ->
                        Just inpUnit == signal.unit

                    Nothing ->
                        True
            )


signalsTableConfig : Shared.Model -> Model -> B.User -> Maybe Int -> Table.Config B.Signal Msg
signalsTableConfig shared model user editingSignalId =
    let
        hasEditorRole =
            Core.Auth.hasRole "UnitsEditor" user

        getUnitName : Maybe Int -> String
        getUnitName unitId =
            case unitId of
                Nothing ->
                    ""

                Just id ->
                    case shared.masterUnits of
                        Success units ->
                            case Dict.get id units of
                                Nothing ->
                                    "<НВ ID=" ++ String.fromInt id ++ ">"

                                Just unit ->
                                    unit.name

                        _ ->
                            "<НВ ID=" ++ String.fromInt id ++ ">"

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute Msg ) -> Html Msg
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
                                [ text " ↓" ]

                        TableConfig.Reversible Nothing ->
                            span [ style "color" "var(--color-text-muted)" ] [ text " ↓" ]

                        TableConfig.Reversible (Just True) ->
                            span [ style "color" "var(--ochre-normal)" ] [ text " ↓" ]

                        TableConfig.Reversible (Just False) ->
                            span [ style "color" "var(--ochre-normal)" ] [ text " ↑" ]

                headerContent =
                    span [] [ text name, sortIcon ]
            in
            Html.th [ click, style "padding" "1rem 1.5rem" ] [ headerContent ]

        customRowAttrs : B.Signal -> List (Html.Attribute Msg)
        customRowAttrs signal =
            let
                baseClass =
                    if signal.active then
                        ""

                    else
                        "disabled"

                editingClass =
                    case editingSignalId of
                        Just editId ->
                            if signal.id == editId then
                                " table-row-editing"

                            else
                                ""

                        Nothing ->
                            ""
            in
            [ class (baseClass ++ editingClass) ]
    in
    Table.customConfig
        { toId = \signal -> String.fromInt signal.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Позиція/Сигнал" .text
                |> Table.withColumnWidth "20%"
            , Table.stringColumn "Значення" (\signal -> Maybe.withDefault "" signal.meaning)
                |> Table.withColumnWidth "20%"
            , Table.stringColumn "Підрозділ" (\signal -> getUnitName signal.unit)
                |> Table.withColumnWidth "20%"
            , Table.stringColumn "Координати" (\signal -> Maybe.withDefault "" signal.coordinates)
                |> Table.withColumnWidth "15%"
            , Table.stringColumn "Дата внесення"
                (\signal ->
                    Utils.Time.renderDateTimeF1 shared.timeZone (Time.millisToPosix signal.createdAt)
                )
                |> Table.withColumnWidth "15%"
            , Table.veryCustomColumn
                { name = "Дії"
                , viewData =
                    \signal ->
                        { attributes = []
                        , children =
                            if hasEditorRole then
                                [ div [ class "flex gap-2" ]
                                    [ button
                                        [ title "Редагувати"
                                        , class "icon-btn icon-btn-primary"
                                        , onClick <| OpenEditSignalSidebar signal.id signal
                                        ]
                                        [ i [ class "bi bi-pencil-square" ] [] ]
                                    , button
                                        [ title "Видалити"
                                        , class "icon-btn icon-btn-danger"
                                        , onClick <| DeleteSignal signal.id
                                        ]
                                        [ i [ class "bi bi-trash" ] [] ]
                                    ]
                                ]

                            else
                                []
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "10%"
            ]
        , customizations =
            { tableAttrs = [ class "base-table table table-bordered table-sm", style "font-size" ".85rem" ]
            , caption = Nothing
            , thead = customThead
            , tfoot = Nothing
            , tbodyAttrs = []
            , rowAttrs = customRowAttrs
            }
        }


editSignalSidebarContent : Shared.Model -> Model -> B.User -> B.Signal -> List (Html Msg)
editSignalSidebarContent shared model user signal =
    let
        hasEditorRole =
            Core.Auth.hasRole "UnitsEditor" user

        currentEditState =
            case model.editSignalState of
                Just editState ->
                    editState

                Nothing ->
                    { inpText = signal.text
                    , inpMeaning = Maybe.withDefault "" signal.meaning
                    , inpUnit = Maybe.withDefault 0 signal.unit
                    , inpCoordinates = Maybe.withDefault "" signal.coordinates
                    , inpUnitSelState = Select.initState (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt signal.id)
                    }
    in
    [ div [ class "p-6" ]
        [ h2 [ class "text-xl font-semibold mb-4" ] [ text "Редагування сигналу" ]
        , div [ class "space-y-4" ]
            [ div []
                [ label [ class "block text-sm font-medium mb-2" ] [ text "Позиція/Сигнал" ]
                , input
                    [ class "form-input w-full"
                    , type_ "text"
                    , placeholder "Позиція/Сигнал"
                    , value currentEditState.inpText
                    , onInput <| EditSignalMsg << (\v -> { currentEditState | inpText = v })
                    , Attr.disabled (not hasEditorRole)
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-2" ] [ text "Значення" ]
                , input
                    [ class "form-input w-full"
                    , type_ "text"
                    , placeholder "Значення"
                    , value currentEditState.inpMeaning
                    , onInput <| EditSignalMsg << (\v -> { currentEditState | inpMeaning = v })
                    , Attr.disabled (not hasEditorRole)
                    ]
                    []
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-2" ] [ text "Підрозділ" ]
                , div [ class "flex justify-between items-center" ]
                    [ div [ class "flex-grow" ]
                        [ Html.map EditUnitSelMsg <|
                            Styled.toUnstyled <|
                                Utils.Select.renderSelectSingle
                                    (case shared.masterUnits of
                                        Success units ->
                                            Dict.get currentEditState.inpUnit units
                                                |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })

                                        _ ->
                                            Nothing
                                    )
                                    currentEditState.inpUnitSelState
                                    (populateUnitMenu shared)
                                    "підрозділ"
                                    (Utils.Select.defaultOptions (isDarkMode shared.themeMode))
                        ]
                    ]
                ]
            , div []
                [ label [ class "block text-sm font-medium mb-2" ] [ text "Координати" ]
                , input
                    [ class "form-input w-full"
                    , type_ "text"
                    , placeholder "Координати"
                    , value currentEditState.inpCoordinates
                    , onInput <| EditSignalMsg << (\v -> { currentEditState | inpCoordinates = v })
                    , Attr.disabled (not hasEditorRole)
                    ]
                    []
                ]
            ]
        ]
    , div [ class "p-6 border-t border-border bg-muted/30" ]
        [ div [ class "flex justify-end gap-3" ]
            [ Button.new { label = "Скасувати", onClick = CloseEditSignalSidebar }
                |> Button.withStyleSecondary
                |> Button.view
            , Button.new { label = "Зберегти", onClick = EditSignalSave signal.id }
                |> Button.withDisabled (not hasEditorRole)
                |> Button.view
            ]
        ]
    ]


unitsBlock : Shared.Model -> Model -> Html Msg
unitsBlock shared model =
    let
        renderUnitStat : B.SignalUnitStatRow -> List (Html Msg)
        renderUnitStat stat =
            let
                unitName =
                    case shared.masterUnits of
                        Success units ->
                            case Dict.get stat.unitId units of
                                Nothing ->
                                    "<НВ ID=" ++ String.fromInt stat.unitId ++ ">"

                                Just unit ->
                                    unit.name

                        _ ->
                            "<НВ ID=" ++ String.fromInt stat.unitId ++ ">"
            in
            [ div
                [ class "d-flex justify-content-between align-items-between p-2 pointer"
                , onClick <| FilterUnitMsg unitName
                ]
                [ div [ class "flex-grow-1 text-end me-2" ] [ text unitName ]
                , div [ class "me-2" ]
                    [ div
                        [ style "min-width" "30px"
                        , class "text-center"
                        ]
                        [ span
                            [ class "badge badge-sm rounded-pill text-bg-secondary"
                            , style "font-size" "0.6rem"
                            ]
                            [ text <| String.fromInt stat.count
                            ]
                        ]
                    ]
                ]
            , div [ class "border-bottom" ] []
            ]
    in
    if model.loadingUnitStats then
        Shared.Components.Spinner.loadingSpinner

    else
        div [ style "font-size" ".8rem" ] <|
            List.concatMap renderUnitStat model.unitStats


deleteConfirmationModal : Model -> Html Msg
deleteConfirmationModal model =
    let
        dialogContent =
            [ div [ class "p-6" ]
                [ h2 [ class "text-xl font-semibold mb-4" ] [ text "Видалення сигналу" ]
                , p [ class "text-gray-600 mb-6" ] [ text "Ви впевнені, що хочете видалити цей сигнал?" ]
                , div [ class "flex justify-end gap-3" ]
                    [ Button.new { label = "Відміна", onClick = DeleteSignalCancel }
                        |> Button.withStyleSecondary
                        |> Button.view
                    , Button.new { label = "Видалити", onClick = DeleteSignalConfirm }
                        |> Button.withStyleDanger
                        |> Button.view
                    ]
                ]
            ]
    in
    ModalDialog.modalDialog model.deleteDialogOpen DeleteSignalCancel [] dialogContent


renderSignalTrEdit : Shared.Model -> Model -> B.User -> B.Signal -> EditSignalState -> Html Msg
renderSignalTrEdit shared model user signal editState =
    let
        hasEditorRole =
            Core.Auth.hasRole "UnitsEditor" user
    in
    tr []
        [ td []
            [ input
                [ class "form-control"
                , type_ "text"
                , placeholder "Позиція/Сигнал"
                , value editState.inpText
                , onInput <| EditSignalMsg << (\v -> { editState | inpText = v })
                ]
                []
            ]
        , td []
            [ input
                [ class "form-control"
                , type_ "text"
                , placeholder "Значення"
                , value editState.inpMeaning
                , onInput <| EditSignalMsg << (\v -> { editState | inpMeaning = v })
                ]
                []
            ]
        , td []
            [ let
                selectItem : Maybe (Select.MenuItem Int)
                selectItem =
                    case shared.masterUnits of
                        Success units ->
                            Dict.get editState.inpUnit units
                                |> Maybe.map
                                    (\unit ->
                                        Select.basicMenuItem
                                            { item = unit.id, label = unit.name }
                                    )

                        _ ->
                            Nothing
              in
              div
                [ class "d-flex justify-content-between align-items-center"
                , style "min-width" "200px"
                , style "font-size" ".8rem"
                ]
                [ div [ class "flex-grow-1" ]
                    [ let
                        options =
                            Utils.Select.defaultOptions (isDarkMode shared.themeMode)

                        options2 =
                            { options | disabled = not hasEditorRole }
                      in
                      Html.map EditUnitSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectItem
                                editState.inpUnitSelState
                                (populateUnitMenu shared)
                                "підрозділ"
                                options2
                    ]
                ]
            ]
        , td []
            [ input
                [ class "form-control"
                , type_ "text"
                , placeholder "Координати"
                , value editState.inpCoordinates
                , onInput <| EditSignalMsg << (\v -> { editState | inpCoordinates = v })
                ]
                []
            ]
        , td []
            [ text <|
                Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix signal.createdAt)
            ]
        , td [ style "font-size" ".8rem" ]
            [ div [ class "d-flex justify-content-start align-items-center" ]
                [ button
                    [ Attr.title "Зберегти"
                    , class "icon-btn icon-btn-primary"
                    , onClick <| EditSignalSave signal.id
                    ]
                    [ i [ class "bi bi-check2" ] [] ]
                , button
                    [ Attr.title "Скасувати"
                    , class "icon-btn icon-btn-danger"
                    , onClick <| EditSignalCancel signal.id
                    ]
                    [ i [ class "bi bi-x" ] [] ]
                ]
            ]
        ]


contentBlock : Shared.Model -> Model -> Auth.User -> Html Msg
contentBlock shared model user =
    let
        hasEditorRole =
            Core.Auth.hasRole "UnitsEditor" user

        filterPanel =
            let
                downloadCsvButton =
                    if hasEditorRole then
                        [ button
                            [ class "btn btn-outline-secondary d-flex align-items-center gap-2"
                            , style "white-space" "nowrap"
                            , onClick (DownloadCsv hasEditorRole)
                            , Attr.disabled (not hasEditorRole || model.downloadCsvInProgress)
                            , attribute "title" "Завантажити CSV з обраними фільтрами"
                            ]
                            ([ text "Завантажити csv" ]
                                ++ (if model.downloadCsvInProgress then
                                        [ Shared.Components.Spinner.loadingSpinner2Sm ]

                                    else
                                        []
                                   )
                            )
                        ]

                    else
                        []
            in
            div
                [ class "d-flex justify-content-start align-items-center"
                , style "width" "200px"
                ]
                ([ div [ class "me-2" ]
                    [ if model.loading then
                        Shared.Components.Spinner.loadingSpinner2Sm

                      else
                        i [ class "bi bi-filter text-[21px] text-action" ] []
                    ]
                 , input
                    [ class "form-control me-2 text-uppercase"
                    , style "min-width" "200px"
                    , type_ "text"
                    , placeholder "Позиція/Сигнал"
                    , value <| Maybe.withDefault "" model.filterText
                    , onInput FilterTextMsg
                    ]
                    []
                 , input
                    [ class "form-control me-2"
                    , style "width" "200px"
                    , type_ "text"
                    , placeholder "Значення"
                    , value <| Maybe.withDefault "" model.filterMeaning
                    , onInput FilterMeaningMsg
                    ]
                    []
                 , input
                    [ class "form-control me-2"
                    , style "width" "200px"
                    , type_ "text"
                    , placeholder "Підрозділ"
                    , value <| Maybe.withDefault "" model.filterUnit
                    , onInput FilterUnitMsg
                    ]
                    []
                 ]
                    ++ downloadCsvButton
                )

        addSignalPanel =
            div
                [ class "d-flex justify-content-start align-items-center" ]
                [ input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorRole)
                    , type_ "text"
                    , placeholder "Позиція/Сигнал"
                    , onInput InpText
                    , value model.inpText
                    ]
                    []
                , input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorRole)
                    , type_ "text"
                    , placeholder "Значення"
                    , onInput InpMeaning
                    , value model.inpMeaning
                    ]
                    []
                , div
                    [ class "me-2"
                    ]
                    [ let
                        selectItem =
                            model.inpUnit
                                |> Maybe.andThen
                                    (\unitId ->
                                        case shared.masterUnits of
                                            Success units ->
                                                Dict.get unitId units

                                            _ ->
                                                Nothing
                                    )
                                |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })
                      in
                      div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "min-width" "200px"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
                            [ let
                                options =
                                    Utils.Select.defaultOptions (isDarkMode shared.themeMode)

                                options2 =
                                    { options | disabled = not hasEditorRole }
                              in
                              Html.map AddUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Utils.Select.renderSelectSingle
                                        selectItem
                                        model.inpUnitSelState
                                        (populateUnitMenu shared)
                                        "підрозділ"
                                        options2
                            ]
                        ]
                    ]
                , input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorRole)
                    , type_ "text"
                    , placeholder "Координати"
                    , onInput InpCoordinates
                    , value model.inpCoordinates
                    ]
                    []
                , div [ class "flex gap-1" ]
                    [ Button.new { label = "Додати", onClick = AddSignal }
                        |> Button.withDisabled (not hasEditorRole)
                        |> Button.view
                    , Button.new { label = "Очистити", onClick = ClearInputs }
                        |> Button.withStyleSecondary
                        |> Button.view
                    ]
                ]

        mainContent =
            div []
                [ div [] []
                , div
                    [ class "border mb-4 p-3"
                    , style "background-color" "var(--bs-tertiary-bg)"
                    ]
                    [ addSignalPanel ]
                , div
                    [ class "border mb-4 p-2" ]
                    [ filterPanel ]
                , Table.view (signalsTableConfig shared model user (Maybe.map Tuple.first model.editSignalSidebar)) model.tableState (filteredSignals model)
                ]
    in
    div []
        [ mainContent
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ shared user model =
    let
        sidebarOpen =
            case model.editSignalSidebar of
                Just _ ->
                    True

                Nothing ->
                    False

        sidebarContent =
            case model.editSignalSidebar of
                Just ( signalId, signal ) ->
                    editSignalSidebarContent shared model user signal

                Nothing ->
                    []
    in
    { title = "сигнали"
    , body =
        [ div [ class "flex justify-start items-start page-rer-callsigns" ]
            [ div
                [ class "align-self-stretch"
                , style "width" "220px"
                , style "min-width" "220px"
                , style "height" "calc(-50px + 100vh)"
                , style "overflow-y" "scroll"
                ]
                [ div
                    [ class "filter-col d-flex flex-column pt-1 left-panel"
                    , style "height" "100%"
                    ]
                    [ unitsBlock shared model
                    , div [ class "flex-grow-1" ] []
                    ]
                ]
            , div
                [ class "border-start grow-1"
                , style "height" "calc(-50px + 100vh)"
                , style "overflow-y" "scroll"
                ]
                [ h1 [ class "py-2 ps-4" ]
                    [ span [ class "me-2" ] [ text "Сигнали" ]
                    , button
                        [ Attr.title "Оновити"
                        , class "btn btn-outline-secondary"
                        , onClick Refresh
                        ]
                        (if model.loading then
                            [ Shared.Components.Spinner.loadingSpinner2Sm ]

                         else
                            [ i [ class "bi bi-arrow-repeat" ] [] ]
                        )
                    ]
                , div [] <|
                    [ div []
                        [ div [ class "mx-2" ]
                            [ contentBlock shared model user ]
                        ]
                    ]
                ]
            ]
        , Sidebar.view sidebarOpen CloseEditSignalSidebar sidebarContent
        , deleteConfirmationModal model
        ]
    }
