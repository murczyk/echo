module Pages.Admin.Keys exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (..)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Html.Styled as Styled
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner as Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Model exposing (isDarkMode)
import Time
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Time
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view (isDarkMode shared.themeMode) shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }


type alias CreateForm =
    { grantFromId : Maybe Int
    , grantToId : Maybe Int
    }


type alias Model =
    { policies : RemoteData ApiError (List B.SigintKeySharePolicy)
    , organisms : RemoteData ApiError (List B.Organism)
    , tableState : Table.State
    , createForm : CreateForm
    , showCreateSidebar : Bool
    , deleteDialogOpen : Bool
    , deletePolicy : Maybe B.SigintKeySharePolicy
    , formErrors : Dict String String
    , grantFromSelect : Utils.Select.SelectTypeSingle Int
    , grantToSelect : Utils.Select.SelectTypeSingle Int
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { policies = RD.Loading
      , organisms = RD.Loading
      , tableState = Table.initialSort "Створено"
      , createForm = emptyCreateForm
      , showCreateSidebar = False
      , deleteDialogOpen = False
      , deletePolicy = Nothing
      , formErrors = Dict.empty
      , grantFromSelect =
            { state = Select.initState (Select.selectIdentifier "grant-from-select")
            , items = []
            , selected = Nothing
            }
      , grantToSelect =
            { state = Select.initState (Select.selectIdentifier "grant-to-select")
            , items = []
            , selected = Nothing
            }
      }
    , E.batch
        [ E.sendCmd (Api.sigint_key_share_policy_list GotPolicies)
        , E.sendCmd (Api.list_organisms GotOrganisms { sortBy = Nothing })
        ]
    )


emptyCreateForm : CreateForm
emptyCreateForm =
    { grantFromId = Nothing
    , grantToId = Nothing
    }


type Msg
    = GotPolicies (Result ApiError (List B.SigintKeySharePolicy))
    | GotOrganisms (Result ApiError (List B.Organism))
    | SetTableState Table.State
    | ShowCreateSidebar
    | CloseCreateSidebar
    | GrantFromSelectMsg (Select.Msg Int)
    | GrantToSelectMsg (Select.Msg Int)
    | SubmitCreateForm
    | CreatePolicyResponse (Result ApiError B.SigintKeySharePolicy)
    | OpenDeleteDialog B.SigintKeySharePolicy
    | ConfirmDelete
    | CancelDelete
    | DeletePolicyResponse Int (Result ApiError ())


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotPolicies (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження політик" e
            )

        GotPolicies (Ok policies) ->
            ( { model | policies = RD.Success policies }, E.none )

        GotOrganisms (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження організмів" e
            )

        GotOrganisms (Ok organisms) ->
            let
                menuItems =
                    organisms
                        |> List.sortBy .name
                        |> List.map (\org -> Select.basicMenuItem { item = org.id, label = org.name })

                currentGrantFromSelect =
                    model.grantFromSelect

                currentGrantToSelect =
                    model.grantToSelect

                updatedGrantFromSelect =
                    { currentGrantFromSelect | items = menuItems }

                updatedGrantToSelect =
                    { currentGrantToSelect | items = menuItems }
            in
            ( { model
                | organisms = RD.Success organisms
                , grantFromSelect = updatedGrantFromSelect
                , grantToSelect = updatedGrantToSelect
              }
            , E.none
            )

        SetTableState newTableState ->
            ( { model | tableState = newTableState }, E.none )

        ShowCreateSidebar ->
            let
                currentGrantFromSelect =
                    model.grantFromSelect

                currentGrantToSelect =
                    model.grantToSelect
            in
            ( { model
                | showCreateSidebar = True
                , createForm = emptyCreateForm
                , formErrors = Dict.empty
                , grantFromSelect = { currentGrantFromSelect | selected = Nothing }
                , grantToSelect = { currentGrantToSelect | selected = Nothing }
              }
            , E.none
            )

        CloseCreateSidebar ->
            let
                currentGrantFromSelect =
                    model.grantFromSelect

                currentGrantToSelect =
                    model.grantToSelect
            in
            ( { model
                | showCreateSidebar = False
                , createForm = emptyCreateForm
                , formErrors = Dict.empty
                , grantFromSelect = { currentGrantFromSelect | selected = Nothing }
                , grantToSelect = { currentGrantToSelect | selected = Nothing }
              }
            , E.none
            )

        GrantFromSelectMsg selectMsg ->
            let
                ( mAction, selectState, selectCmd ) =
                    Select.update selectMsg model.grantFromSelect.state

                selected =
                    Utils.Select.singleUpd mAction model.grantFromSelect.selected

                currentGrantFromSelect =
                    model.grantFromSelect

                currentCreateForm =
                    model.createForm

                updatedCreateForm =
                    { currentCreateForm | grantFromId = selected }
            in
            ( { model
                | grantFromSelect =
                    { currentGrantFromSelect | state = selectState, selected = selected }
                , createForm = updatedCreateForm
                , formErrors = Dict.remove "grantFromId" model.formErrors
              }
            , E.sendCmd <| Cmd.map GrantFromSelectMsg selectCmd
            )

        GrantToSelectMsg selectMsg ->
            let
                ( mAction, selectState, selectCmd ) =
                    Select.update selectMsg model.grantToSelect.state

                selected =
                    Utils.Select.singleUpd mAction model.grantToSelect.selected

                currentGrantToSelect =
                    model.grantToSelect

                currentCreateForm =
                    model.createForm

                updatedCreateForm =
                    { currentCreateForm | grantToId = selected }
            in
            ( { model
                | grantToSelect =
                    { currentGrantToSelect | state = selectState, selected = selected }
                , createForm = updatedCreateForm
                , formErrors = Dict.remove "grantToId" model.formErrors
              }
            , E.sendCmd <| Cmd.map GrantToSelectMsg selectCmd
            )

        SubmitCreateForm ->
            let
                errors =
                    validateCreateForm model.createForm
            in
            if Dict.isEmpty errors then
                case ( model.createForm.grantFromId, model.createForm.grantToId ) of
                    ( Just grantFromId, Just grantToId ) ->
                        ( { model | formErrors = Dict.empty }
                        , E.sendCmd
                            (Api.sigint_key_share_policy_create CreatePolicyResponse
                                { grantFrom = grantFromId, grantTo = grantToId }
                            )
                        )

                    _ ->
                        ( { model | formErrors = errors }, E.none )

            else
                ( { model | formErrors = errors }, E.none )

        CreatePolicyResponse (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення політики" e
            )

        CreatePolicyResponse (Ok policy) ->
            let
                nextPolicies =
                    case model.policies of
                        RD.Success policies ->
                            policy :: policies

                        _ ->
                            [ policy ]

                currentGrantFromSelect =
                    model.grantFromSelect

                currentGrantToSelect =
                    model.grantToSelect
            in
            ( { model
                | policies = RD.Success nextPolicies
                , showCreateSidebar = False
                , createForm = emptyCreateForm
                , formErrors = Dict.empty
                , grantFromSelect = { currentGrantFromSelect | selected = Nothing }
                , grantToSelect = { currentGrantToSelect | selected = Nothing }
              }
            , E.none
            )

        OpenDeleteDialog policy ->
            ( { model | deleteDialogOpen = True, deletePolicy = Just policy }, E.none )

        ConfirmDelete ->
            case model.deletePolicy of
                Just policy ->
                    ( { model | deleteDialogOpen = False, deletePolicy = Nothing }
                    , E.sendCmd
                        (Api.sigint_key_share_policy_delete (DeletePolicyResponse policy.id)
                            { id = policy.id }
                        )
                    )

                Nothing ->
                    ( { model | deleteDialogOpen = False, deletePolicy = Nothing }, E.none )

        CancelDelete ->
            ( { model | deleteDialogOpen = False, deletePolicy = Nothing }, E.none )

        DeletePolicyResponse _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення політики" e
            )

        DeletePolicyResponse policyId (Ok _) ->
            let
                nextPolicies =
                    case model.policies of
                        RD.Success policies ->
                            RD.Success (List.filter (\p -> p.id /= policyId) policies)

                        _ ->
                            model.policies
            in
            ( { model | policies = nextPolicies }, E.none )


validateCreateForm : CreateForm -> Dict String String
validateCreateForm form =
    let
        addError key message errors =
            Dict.insert key message errors

        withGrantFrom =
            case form.grantFromId of
                Nothing ->
                    addError "grantFromId" "Оберіть організацію для надання" Dict.empty

                Just _ ->
                    Dict.empty

        withGrantTo =
            case form.grantToId of
                Nothing ->
                    addError "grantToId" "Оберіть організацію для отримання" withGrantFrom

                Just _ ->
                    withGrantFrom
    in
    case ( form.grantFromId, form.grantToId ) of
        ( Just fromId, Just toId ) ->
            if fromId == toId then
                addError "grantToId" "Організації мають відрізнятися" withGrantTo

            else
                withGrantTo

        _ ->
            withGrantTo


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


tableCustomizations : TableConfig.Customizations data Msg
tableCustomizations =
    let
        defaultCustomizations =
            Table.defaultCustomizations

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
                            span [ style "color" "var(--color-text-muted)" ] [ text " ↕" ]

                        TableConfig.Reversible (Just isReversed) ->
                            span [ style "color" "var(--ochre-normal)" ]
                                [ text
                                    (if isReversed then
                                        " ↑"

                                     else
                                        " ↓"
                                    )
                                ]

                headerContent =
                    div [ class "table-header-content", title name ]
                        [ span [] [ text name ]
                        , sortIcon
                        ]
            in
            Html.th [ click ] [ headerContent ]

        customThead : List ( String, TableConfig.Status, Html.Attribute Msg ) -> TableColumn.HtmlDetails Msg
        customThead headers =
            TableColumn.HtmlDetails [] (List.map customTheadHelp headers)

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
                , thead = customThead
            }
    in
    customizations


policyTableConfig : Dict Int String -> Time.Zone -> Table.Config B.SigintKeySharePolicy Msg
policyTableConfig organismNames timeZone =
    let
        organismName orgId =
            Dict.get orgId organismNames
                |> Maybe.withDefault ("#" ++ String.fromInt orgId)
    in
    Table.customConfig
        { toId = \policy -> String.fromInt policy.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Надати від" (\policy -> organismName policy.grantFrom)
                |> Table.withColumnWidth "22%"
            , Table.stringColumn "Надати до" (\policy -> organismName policy.grantTo)
                |> Table.withColumnWidth "22%"
            , Table.stringColumn "Автор" .author
                |> Table.withColumnWidth "18%"
            , Table.veryCustomColumn
                { name = "Створено"
                , viewData =
                    \policy ->
                        { attributes = [ class "col-narrow" ]
                        , children = [ text (Utils.Time.renderDateF5FromMillis policy.createdAt timeZone) ]
                        }
                , sorter = Table.increasingOrDecreasingBy (\policy -> String.fromInt policy.createdAt)
                }
                |> Table.withColumnWidth "16%"
            , Table.veryCustomColumn
                { name = ""
                , viewData =
                    \policy ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ button
                                [ title "Видалити"
                                , class "icon-btn icon-btn-danger"
                                , onClick (OpenDeleteDialog policy)
                                ]
                                [ i [ class "bi bi-trash" ] [] ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "8%"
            ]
        , customizations = tableCustomizations
        }


view : Bool -> Shared.Model -> Model -> View Msg
view isDark shared model =
    { title = "Політики доступу до ключів"
    , body = body isDark shared model
    }


body : Bool -> Shared.Model -> Model -> List (Html Msg)
body isDark shared model =
    let
        createSidebarOpen =
            model.showCreateSidebar

        anySidebarOpen =
            createSidebarOpen

        deleteConfirmationModal =
            let
                ( grantFromName, grantToName ) =
                    case ( model.deletePolicy, model.organisms ) of
                        ( Just policy, RD.Success organisms ) ->
                            let
                                names =
                                    organisms
                                        |> List.map (\org -> ( org.id, org.name ))
                                        |> Dict.fromList
                            in
                            ( Dict.get policy.grantFrom names |> Maybe.withDefault ("#" ++ String.fromInt policy.grantFrom)
                            , Dict.get policy.grantTo names |> Maybe.withDefault ("#" ++ String.fromInt policy.grantTo)
                            )

                        ( Just policy, _ ) ->
                            ( "#" ++ String.fromInt policy.grantFrom
                            , "#" ++ String.fromInt policy.grantTo
                            )

                        _ ->
                            ( "", "" )

                dialogContent =
                    [ div [ class "flex flex-col justify-between gap-4 p-2 w-[420px]" ]
                        [ div [ class "pb-12" ]
                            [ h2 [] [ text "Видалення політики" ]
                            , p []
                                [ text "Ви впевнені, що хочете видалити політику між "
                                , strong [] [ text grantFromName ]
                                , text " та "
                                , strong [] [ text grantToName ]
                                , text "?"
                                ]
                            ]
                        , div [ class "flex justify-between" ]
                            [ Button.new { label = "Відміна", onClick = CancelDelete }
                                |> Button.withStyleSecondary
                                |> Button.view
                            , button
                                [ class "px-4 py-2 rounded font-medium text-xs flex gap-[4px] items-center justify-center transition-colors duration-200 bg-red-600 text-white hover:bg-red-700 focus:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2 active:bg-red-800"
                                , onClick ConfirmDelete
                                ]
                                [ text "Видалити" ]
                            ]
                        ]
                    ]
            in
            ModalDialog.modalDialog model.deleteDialogOpen CancelDelete [] dialogContent
    in
    [ div
        [ classList [ ( "overflow-hidden", anySidebarOpen ) ]
        , class "w-5/6 mx-auto"
        ]
        [ deleteConfirmationModal
        , Sidebar.view createSidebarOpen CloseCreateSidebar (createPolicySidebarContent isDark model)
        , div [] (mainBlock shared model)
        ]
    ]


mainBlock : Shared.Model -> Model -> List (Html Msg)
mainBlock shared model =
    let
        tableContent =
            case model.policies of
                RD.Loading ->
                    div [ class "flex justify-center py-8" ] [ Spinner.loadingSpinner ]

                RD.Success policies ->
                    let
                        organismNames =
                            case model.organisms of
                                RD.Success organisms ->
                                    organisms
                                        |> List.map (\org -> ( org.id, org.name ))
                                        |> Dict.fromList

                                _ ->
                                    Dict.empty
                    in
                    Table.view
                        (policyTableConfig organismNames shared.timeZone)
                        model.tableState
                        policies

                _ ->
                    div [ class "py-6 text-center text-gray-500" ] [ text "Немає даних для відображення." ]
    in
    [ div []
        [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Політики доступу до ключів" ]
        , div [ class "mb-4 flex justify-end" ]
            [ Button.new { label = "Додати політику", onClick = ShowCreateSidebar }
                |> Button.view
            ]
        , div [ class "table-responsive-modern" ] [ tableContent ]
        ]
    ]


createPolicySidebarContent : Bool -> Model -> List (Html Msg)
createPolicySidebarContent isDark model =
    let
        defaultOptions =
            Utils.Select.defaultOptions isDark

        selectOptions =
            { defaultOptions | loading = RD.isLoading model.organisms }

        selectedItem mSelected =
            case ( mSelected, model.organisms ) of
                ( Just selectedId, RD.Success organisms ) ->
                    organisms
                        |> List.filter (\org -> org.id == selectedId)
                        |> List.head
                        |> Maybe.map (\org -> Select.basicMenuItem { item = org.id, label = org.name })

                _ ->
                    Nothing
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Створити політику" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Надати від *" ]
                    , Html.map GrantFromSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                (selectedItem model.grantFromSelect.selected)
                                model.grantFromSelect.state
                                model.grantFromSelect.items
                                "Оберіть організацію"
                                selectOptions
                    , case Dict.get "grantFromId" model.formErrors of
                        Just error ->
                            p [ class "text-xs text-red-600" ] [ text error ]

                        Nothing ->
                            text ""
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Надати до *" ]
                    , Html.map GrantToSelectMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                (selectedItem model.grantToSelect.selected)
                                model.grantToSelect.state
                                model.grantToSelect.items
                                "Оберіть організацію"
                                selectOptions
                    , case Dict.get "grantToId" model.formErrors of
                        Just error ->
                            p [ class "text-xs text-red-600" ] [ text error ]

                        Nothing ->
                            text ""
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border flex justify-end gap-3" ]
            [ Button.new { label = "Скасувати", onClick = CloseCreateSidebar }
                |> Button.withStyleSecondary
                |> Button.view
            , Button.new { label = "Зберегти", onClick = SubmitCreateForm }
                |> Button.view
            ]
        ]
    ]
