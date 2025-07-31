module Pages.AreasOfResponsibility exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick, onInput, onCheck)
import Layouts
import Le.Block.Toast
import Le.ErrorHandling
import Le.Types exposing (..)
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared route =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "areasOfResponsibility"
        }



-- INIT


type alias Model =
    { aors : List B.AreaOfResponsibility
    , tableState : Table.State
    , createForm : CreateForm
    , showCreateSidebar : Bool
    }


type alias CreateForm =
    { name : String
    , description : String
    , leftBound : String
    , rightBound : String
    , leftLatitude : String
    , leftLongitude : String
    , leftSettlement : String
    , rightLatitude : String
    , rightLongitude : String
    , rightSettlement : String
    , isTopLevel : Bool
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { aors = []
      , tableState = Table.initialSort "Назва"
      , createForm = emptyCreateForm
      , showCreateSidebar = False
      }
    , E.sendCmd <| Api.aor_list GotAors { sortBy = Nothing }
    )


emptyCreateForm : CreateForm
emptyCreateForm =
    { name = ""
    , description = ""
    , leftBound = ""
    , rightBound = ""
    , leftLatitude = ""
    , leftLongitude = ""
    , leftSettlement = ""
    , rightLatitude = ""
    , rightLongitude = ""
    , rightSettlement = ""
    , isTopLevel = False
    }



-- UPDATE


type Msg
    = NoOp
    | GotAors (Result ApiError (List B.AreaOfResponsibility))
    | SetTableState Table.State
    | ShowCreateSidebar
    | CloseCreateSidebar
    | UpdateCreateForm CreateForm
    | SubmitCreateForm
    | CreateAorResponse (Result ApiError B.AreaOfResponsibility)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model
            , E.none
            )

        GotAors (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження територій" e )

        GotAors (Ok res) ->
            ( { model | aors = res }, E.none )

        SetTableState newTableState ->
            ( { model | tableState = newTableState }, E.none )

        ShowCreateSidebar ->
            ( { model | showCreateSidebar = True, createForm = emptyCreateForm }, E.none )

        CloseCreateSidebar ->
            ( { model | showCreateSidebar = False, createForm = emptyCreateForm }, E.none )

        UpdateCreateForm form ->
            ( { model | createForm = form }, E.none )

        SubmitCreateForm ->
            ( model, submitCreateForm model.createForm )

        CreateAorResponse (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення території" e )

        CreateAorResponse (Ok newAor) ->
            ( { model | aors = newAor :: model.aors, createForm = emptyCreateForm, showCreateSidebar = False }
            , E.none
            )



-- SUBSCRIPTIONS


submitCreateForm : CreateForm -> Effect Msg
submitCreateForm form =
    let
        leftCoords =
            if String.isEmpty form.leftLatitude || String.isEmpty form.leftLongitude then
                Nothing
            else
                Just
                    { latitude = Maybe.withDefault 0 (String.toFloat form.leftLatitude)
                    , longitude = Maybe.withDefault 0 (String.toFloat form.leftLongitude)
                    , settlement = if String.isEmpty form.leftSettlement then Nothing else Just form.leftSettlement
                    }

        rightCoords =
            if String.isEmpty form.rightLatitude || String.isEmpty form.rightLongitude then
                Nothing
            else
                Just
                    { latitude = Maybe.withDefault 0 (String.toFloat form.rightLatitude)
                    , longitude = Maybe.withDefault 0 (String.toFloat form.rightLongitude)
                    , settlement = if String.isEmpty form.rightSettlement then Nothing else Just form.rightSettlement
                    }

        insertReq =
            { name = form.name
            , description = if String.isEmpty form.description then Nothing else Just form.description
            , leftBound = Maybe.withDefault 0 (String.toFloat form.leftBound)
            , rightBound = Maybe.withDefault 0 (String.toFloat form.rightBound)
            , leftCoordinates = leftCoords
            , rightCoordinates = rightCoords
            , isTopLevel = form.isTopLevel
            }
    in
    E.sendCmd (Api.create_aor CreateAorResponse insertReq)


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


-- TABLE CONFIGURATION

aorTableConfig : List B.AreaOfResponsibility -> Table.Config B.AreaOfResponsibility Msg
aorTableConfig aors =
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
    Table.customConfig
        { toId = \aor -> String.fromInt aor.id
        , toMsg = SetTableState
        , columns =
            [ Table.stringColumn "Назва" .name |> Table.withColumnWidth "20%"
            , Table.stringColumn "Опис" (\aor -> Maybe.withDefault "" aor.description) |> Table.withColumnWidth "30%"
            , Table.floatColumn "Ліва межа" .leftBound |> Table.withColumnWidth "10%"
            , Table.floatColumn "Права межа" .rightBound |> Table.withColumnWidth "10%"
            , Table.veryCustomColumn
                { name = "Координати"
                , viewData =
                    \aor ->
                        { attributes = []
                        , children =
                            [ div [ class "text-sm" ]
                                [ div [] [ text "Ліва: " ]
                                , case aor.leftCoordinates of
                                    Just coords ->
                                        text (String.fromFloat coords.latitude ++ ", " ++ String.fromFloat coords.longitude)

                                    Nothing ->
                                        text "Не вказано"
                                , div [] [ text "Права: " ]
                                , case aor.rightCoordinates of
                                    Just coords ->
                                        text (String.fromFloat coords.latitude ++ ", " ++ String.fromFloat coords.longitude)

                                    Nothing ->
                                        text "Не вказано"
                                ]
                            ]
                        }
                , sorter = Table.unsortable
                }
                |> Table.withColumnWidth "20%"
            , Table.veryCustomColumn
                { name = "Топ-рівень"
                , viewData =
                    \aor ->
                        { attributes = [ class "col-narrow" ]
                        , children =
                            [ i
                                [ class
                                    (if aor.isTopLevel then
                                        "bi bi-check-circle-fill text-green-500"

                                     else
                                        "bi bi-x-circle-fill text-red-500"
                                    )
                                ]
                                []
                            ]
                        }
                , sorter =
                    Table.increasingOrDecreasingBy
                        (\aor ->
                            if aor.isTopLevel then
                                "1"

                            else
                                "0"
                        )
                }
                |> Table.withColumnWidth "10%"
            ]
        , customizations = customizations
        }



-- VIEW


view : Model -> View Msg
view model =
    { title = "Смуги відповідальності"
    , body = body model
    }


body : Model -> List (Html Msg)
body model =
    let
        sidebarOpen =
            model.showCreateSidebar

        sidebarContent =
            createAorSidebarContent model.createForm
    in
    [ div
        [ classList [ ( "overflow-hidden", sidebarOpen ) ]
        , class "w-5/6 mx-auto"
        ]
        [ Sidebar.view sidebarOpen CloseCreateSidebar sidebarContent
        , div [] (mainBlock model)
        ]
    ]


mainBlock : Model -> List (Html Msg)
mainBlock model =
    [ div []
        [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Смуги відповідальності" ]
        , div [ class "mb-4" ]
            [ Button.new { label = "Додати смугу", onClick = ShowCreateSidebar }
                |> Button.view
            ]
        , div [ class "table-responsive-modern" ]
            [ Table.view
                (aorTableConfig model.aors)
                model.tableState
                model.aors
            ]
        ]
    ]


createAorSidebarContent : CreateForm -> List (Html Msg)
createAorSidebarContent form =
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Створити нову смугу" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва *" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Назва смуги"
                        , value form.name
                        , onInput (\val -> UpdateCreateForm { form | name = val })
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Опис" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Опис смуги"
                        , value form.description
                        , onInput (\val -> UpdateCreateForm { form | description = val })
                        ]
                        []
                    ]
                , div [ class "grid grid-cols-2 gap-4" ]
                    [ div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Ліва межа *" ]
                        , input
                            [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                            , type_ "number"
                            , step "0.1"
                            , placeholder "0.0"
                            , value form.leftBound
                            , onInput (\val -> UpdateCreateForm { form | leftBound = val })
                            ]
                            []
                        ]
                    , div [ class "space-y-2" ]
                        [ label [ class "text-sm font-medium text-foreground" ] [ text "Права межа *" ]
                        , input
                            [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                            , type_ "number"
                            , step "0.1"
                            , placeholder "0.0"
                            , value form.rightBound
                            , onInput (\val -> UpdateCreateForm { form | rightBound = val })
                            ]
                            []
                        ]
                    ]
                , div [ class "space-y-4" ]
                    [ h4 [ class "text-md font-medium" ] [ text "Координати лівої межі" ]
                    , div [ class "grid grid-cols-3 gap-4" ]
                        [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Широта" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "number"
                                , step "0.000001"
                                , placeholder "0.0"
                                , value form.leftLatitude
                                , onInput (\val -> UpdateCreateForm { form | leftLatitude = val })
                                ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Довгота" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "number"
                                , step "0.000001"
                                , placeholder "0.0"
                                , value form.leftLongitude
                                , onInput (\val -> UpdateCreateForm { form | leftLongitude = val })
                                ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Населений пункт" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "text"
                                , placeholder "Назва населеного пункту"
                                , value form.leftSettlement
                                , onInput (\val -> UpdateCreateForm { form | leftSettlement = val })
                                ]
                                []
                            ]
                        ]
                    ]
                , div [ class "space-y-4" ]
                    [ h4 [ class "text-md font-medium" ] [ text "Координати правої межі" ]
                    , div [ class "grid grid-cols-3 gap-4" ]
                        [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Широта" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "number"
                                , step "0.000001"
                                , placeholder "0.0"
                                , value form.rightLatitude
                                , onInput (\val -> UpdateCreateForm { form | rightLatitude = val })
                                ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Довгота" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "number"
                                , step "0.000001"
                                , placeholder "0.0"
                                , value form.rightLongitude
                                , onInput (\val -> UpdateCreateForm { form | rightLongitude = val })
                                ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Населений пункт" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "text"
                                , placeholder "Назва населеного пункту"
                                , value form.rightSettlement
                                , onInput (\val -> UpdateCreateForm { form | rightSettlement = val })
                                ]
                                []
                            ]
                        ]
                    ]
                , div [ class "space-y-2" ]
                    [ Checkbox.new { isChecked = form.isTopLevel, onToggle = \val -> UpdateCreateForm { form | isTopLevel = val } }
                        |> Checkbox.withContent [ text "Топ-рівень" ]
                        |> Checkbox.view
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new { label = "Створити", onClick = SubmitCreateForm }
                    |> Button.view
                ]
            ]
        ]
    ]
