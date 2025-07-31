module Pages.AreasOfResponsibility exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
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
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { aors = []
      , tableState = Table.initialSort "Назва"
      }
    , E.sendCmd <| Api.aor_list GotAors { sortBy = Nothing }
    )



-- UPDATE


type Msg
    = NoOp
    | GotAors (Result ApiError (List B.AreaOfResponsibility))
    | SetTableState Table.State


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



-- SUBSCRIPTIONS


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
    { title = "Території відповідальності"
    , body = 
        [ div [ class "w-5/6 mx-auto" ]
            [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Території відповідальності" ]
            , div [ class "table-responsive-modern" ]
                [ Table.view
                    (aorTableConfig model.aors)
                    model.tableState
                    model.aors
                ]
            ]
        ]
    }
