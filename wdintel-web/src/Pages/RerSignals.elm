module Pages.RerSignals exposing (EditSignalState, Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Watermark as Watermark
import Components.Sidebar as Sidebar
import Components.Button as Button
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import Layouts
import Le.Auth
import Le.Block.Select
import Le.Block.Spinner
import Le.ErrorHandling
import Le.Time
import Le.Types exposing (ApiError)
import Le.Utils exposing (..)
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import Task
import Time
import TimeZone
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view shared.isDarkMode shared user
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
    { zone : Maybe Time.Zone
    , inpUnitSelState : Select.State
    , inpUnitSelMenu : List (Select.MenuItem Int)
    , units : List B.Unit
    , signals : List B.Signal
    , deleteSignalConfirmation : Maybe Int
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
    }


type Msg
    = InitGotZone (Result TimeZone.Error ( String, Time.Zone ))
    | GotUnits (Result ApiError B.ListUnitsRsp)
    | GotSignals (Result ApiError B.ListSignalsRsp)
    | AddUnitSelMsg (Select.Msg Int)
    | EditUnitSelMsg (Select.Msg Int)
    | ReloadUnits
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
    , inpUnitSelMenu : List (Select.MenuItem Int)
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
            { zone = Nothing
            , inpUnitSelState = Select.initState (Select.selectIdentifier "sel-unit-add")
            , inpUnitSelMenu = []
            , units = []
            , signals = []
            , deleteSignalConfirmation = Nothing
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
            }
    in
    ( m2
    , E.batch
        [ E.sendCmd <| Task.attempt InitGotZone Le.Time.getZone
        , loadUnits
        , loadSignals m2
        , loadUnitStats
        ]
    )


loadUnits : Effect Msg
loadUnits =
    E.getUnits GotUnits
        { sortBy = Nothing
        , afterUnitId = Nothing
        , beforeUnitId = Nothing
        }


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        InitGotZone (Err e) ->
            ( model
            , E.showError
                ("Error getting timezone: " ++ renderZoneError e)
            )

        InitGotZone (Ok ( _, zone )) ->
            ( { model | zone = Just zone }
            , E.none
            )

        GotSignals (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження сигналів" err
            )

        GotSignals (Ok rsp) ->
            ( { model | signals = rsp.signals, loading = False }
            , E.none
            )

        ReloadUnits ->
            ( model, loadUnits )

        GotUnits (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підрозділів" err
            )

        GotUnits (Ok rsp) ->
            let
                newUnitMenu =
                    List.map
                        (\u -> Select.basicMenuItem { item = u.id, label = u.name })
                        rsp.units
                
                updatedEditSignalState =
                    Maybe.map (\editState -> { editState | inpUnitSelMenu = newUnitMenu }) model.editSignalState
            in
            ( { model
                | units = rsp.units
                , inpUnitSelMenu = newUnitMenu
                , editSignalState = updatedEditSignalState
              }
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
                            case Le.Block.Select.singleUpd mAction (Just editState.inpUnit) of
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
                    Le.Block.Select.singleUpd mAction model.inpUnit

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
            ( { model | deleteSignalConfirmation = Just id }
            , E.none
            )

        DeleteSignalConfirm ->
            let
                m2 =
                    { model | deleteSignalConfirmation = Nothing }
            in
            case model.deleteSignalConfirmation of
                Nothing ->
                    ( m2, E.none )

                Just id ->
                    ( m2
                    , E.sendCmd <| Api.sigint_signal_delete DeleteSignalDone id
                    )

        DeleteSignalCancel ->
            ( { model | deleteSignalConfirmation = Nothing }, E.none )

        DeleteSignalDone (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення сигналу" err
            )

        DeleteSignalDone (Ok _) ->
            ( { model | loading = True, loadingUnitStats = True }
            , initLoad model
            )

        EditSignal id ->
            case ListX.find (\u -> u.id == id) model.signals of
                Nothing ->
                    ( model, E.none )

                Just signal ->
                    ( { model
                        | editSignalState = Just
                            { inpText = signal.text
                            , inpMeaning = Maybe.withDefault "" signal.meaning
                            , inpCoordinates = Maybe.withDefault "" signal.coordinates
                            , inpUnit = Maybe.withDefault 0 signal.unit
                            , inpUnitSelState =
                                Select.initState
                                    (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt id)
                            , inpUnitSelMenu =
                                List.map
                                    (\u -> Select.basicMenuItem { item = u.id, label = u.name })
                                    model.units
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
                                        Maybe.map (\u -> u.id) (ListX.find (\u -> u.id == editState.inpUnit) model.units)
                                    }
                            )

        EditSignalDone _ (Err err) ->
            ( model
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення сигналу" err
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
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення сигналу" err
            )

        --TODO: подивитися чи можна не перезавантажувати все кожного разу
        AddSignalDone (Ok _) ->
            ( { model | loading = True, loadingUnitStats = True, inpText = "", inpMeaning = "", inpUnit = Nothing, inpCoordinates = "" }
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

        ClearInputs ->
            ( { model | inpText = "", inpMeaning = "", inpUnit = Nothing, inpCoordinates = "" }, E.none )

        GotUnitStats (Err err) ->
            ( { model | loadingUnitStats = False }
            , Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження статистики підрозділів" err
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
                , editSignalState = Just
                    { inpText = signal.text
                    , inpMeaning = Maybe.withDefault "" signal.meaning
                    , inpUnit = Maybe.withDefault 0 signal.unit
                    , inpCoordinates = Maybe.withDefault "" signal.coordinates
                    , inpUnitSelState = Select.initState (Select.selectIdentifier <| "sel-unit-" ++ String.fromInt signalId)
                    , inpUnitSelMenu = List.map (\u -> Select.basicMenuItem { item = u.id, label = u.name }) model.units
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
        [ loadUnits
        , loadSignals model
        , loadUnitStats
        ]


loadUnitStats : Effect Msg
loadUnitStats =
    E.sendCmd <| Api.sigint_signal_unit_stats GotUnitStats ()


loadSignalsCmd : Model -> Cmd Msg
loadSignalsCmd model =
    Api.sigint_list_signals GotSignals
        { sortBy = model.sortBy
        , filterText = model.filterText
        , filterMeaning = model.filterMeaning
        , filterUnit = model.filterUnit
        }


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
            Le.Auth.hasRole "UnitsEditor" user

        getUnitName : Maybe Int -> String
        getUnitName unitId =
            case unitId of
                Nothing ->
                    ""
                Just id ->
                    case ListX.find (\u -> u.id == id) model.units of
                        Nothing -> "<НВ ID=" ++ String.fromInt id ++ ">"
                        Just unit -> unit.name

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customTheadHelp : ( String, TableConfig.Status, Html.Attribute Msg ) -> Html Msg
        customTheadHelp ( name, status, click ) =
            let
                sortIcon =
                    case status of
                        TableConfig.Unsortable -> text ""
                        TableConfig.Sortable selected ->
                            span
                                [ style "color"
                                    (if selected then "var(--ochre-normal)" else "var(--color-text-muted)")
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
                    if signal.active then "" else "disabled"
                
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
                    case model.zone of
                        Nothing -> "Loading..."
                        Just zone -> Le.Time.renderDateTimeF1 zone (Time.millisToPosix signal.createdAt)
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
            Le.Auth.hasRole "UnitsEditor" user

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
                    , inpUnitSelMenu = List.map (\u -> Select.basicMenuItem { item = u.id, label = u.name }) model.units
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
                                Le.Block.Select.renderSelectSingle
                                    (ListX.find (\unit -> unit.id == currentEditState.inpUnit) model.units
                                        |> Maybe.map (\unit -> Select.basicMenuItem { item = unit.id, label = unit.name })
                                    )
                                    currentEditState.inpUnitSelState
                                    currentEditState.inpUnitSelMenu
                                    "підрозділ"
                                    (Le.Block.Select.defaultOptions shared.isDarkMode)
                        ]
                    , button
                        [ Attr.title "Оновити список підрозділів"
                        , class "icon-btn icon-btn-secondary"
                        , onClick <| ReloadUnits
                        ]
                        [ i [ class "bi bi-arrow-repeat" ] [] ]
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
unitsBlock _ model =
    let
        renderUnitStat : B.SignalUnitStatRow -> List (Html Msg)
        renderUnitStat stat =
            let
                unitName =
                    case ListX.find (\u -> u.id == stat.unitId) model.units of
                        Nothing ->
                            "<НВ ID=" ++ String.fromInt stat.unitId ++ ">"

                        Just unit ->
                            unit.name
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
        Le.Block.Spinner.loadingSpinner

    else
        div [ style "font-size" ".8rem" ] <|
            List.concatMap renderUnitStat model.unitStats


contentBlock : Shared.Model -> Model -> Auth.User -> Html Msg
contentBlock shared model user =
    let
        hasEditorRole =
            Le.Auth.hasRole "UnitsEditor" user



        filterPanel =
            div
                [ class "d-flex justify-content-start align-items-center"
                , style "width" "200px"
                ]
                [ div [ class "me-2" ]
                    [ if model.loading then
                        Le.Block.Spinner.loadingSpinner2Sm

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

        deleteConfirmationModal =
            div
                [ class "modal fade"
                , attribute "tabindex" "-1"
                , attribute "role" "dialog"
                , attribute "aria-hidden" "true"
                , id "deleteConfirmationModal"
                ]
                [ div
                    [ class "modal-dialog"
                    , attribute "role" "document"
                    ]
                    [ div
                        [ class "modal-content" ]
                        [ div
                            [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "Видалення сигналу" ]
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
                            [ text "Ви впевнені, що хочете видалити цей сигнал?"
                            ]
                        , div
                            [ class "modal-footer" ]
                            [ Button.new { label = "Відміна", onClick = DeleteSignalCancel }
                                |> Button.withSecondary
                                |> Button.view
                            , Button.new { label = "Видалити", onClick = DeleteSignalConfirm }
                                |> Button.withSecondary
                                |> Button.view
                            ]
                        ]
                    ]
                ]

        renderSignalTrEdit : B.Signal -> EditSignalState -> Html Msg
        renderSignalTrEdit signal editState =
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
                            ListX.find (\unit -> unit.id == editState.inpUnit) model.units
                                |> Maybe.map
                                    (\unit ->
                                        Select.basicMenuItem
                                            { item = unit.id, label = unit.name }
                                    )
                      in
                      div
                        [ class "d-flex justify-content-between align-items-center"
                        , style "min-width" "200px"
                        , style "font-size" ".8rem"
                        ]
                        [ div [ class "flex-grow-1" ]
                            [ let
                                options =
                                    Le.Block.Select.defaultOptions shared.isDarkMode

                                options2 =
                                    { options | disabled = not hasEditorRole }
                              in
                                                             Html.map EditUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectItem
                                        editState.inpUnitSelState
                                        editState.inpUnitSelMenu
                                        "підрозділ"
                                        options2
                            ]
                        , button
                            [ class "btn btn-sm btn-outline-secondary ms-2"
                            , type_ "button"
                            , onClick <| ReloadUnits
                            ]
                            [ i [ class "bi bi-arrow-clockwise" ]
                                []
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
                        case model.zone of
                            Nothing ->
                                "Loading..."

                            Just zone ->
                                Le.Time.renderDateTimeF1 zone
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

        addSignalPanel : Html Msg
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
                                |> Maybe.andThen (\unitId -> ListX.find (\u -> u.id == unitId) model.units)
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
                                    Le.Block.Select.defaultOptions shared.isDarkMode

                                options2 =
                                    { options | disabled = not hasEditorRole }
                              in
                              Html.map AddUnitSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectItem
                                        model.inpUnitSelState
                                        model.inpUnitSelMenu
                                        "підрозділ"
                                        options2
                            ]
                        , button
                            [ Attr.title "Оновити список підрозділів"
                            , class "icon-btn icon-btn-secondary"
                            , onClick <| ReloadUnits
                            ]
                            [ i [ class "bi bi-arrow-repeat" ] [] ]
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
                , Button.new { label = "Додати", onClick = AddSignal }
                    |> Button.withDisabled (not hasEditorRole)
                    |> Button.view
                , Button.new { label = "Очистити", onClick = ClearInputs }
                    |> Button.withStyleSecondary
                    |> Button.view
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
        [ deleteConfirmationModal
        , mainContent
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
                            [ Le.Block.Spinner.loadingSpinner2Sm ]
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
        ]
    }
