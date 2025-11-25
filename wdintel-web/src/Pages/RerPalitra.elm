module Pages.RerPalitra exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (Html, div, span, text)
import Html.Attributes exposing (class, style)
import Layouts
import Page exposing (Page)
import Platform.Sub as Sub
import Route exposing (Route)
import Shared
import Shared.Components.Button as Button
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import Shared.Components.Table.Sorter as Sorter
import Utils.RemoteData as RD exposing (RemoteData(..))
import View exposing (View)


type alias Model =
    { palitras : RemoteData ApiError (List B.Palitra)
    , tableState : Table.State
    , deleting : Maybe Int
    }


type Msg
    = NoOp
    | PalitraListResp (Result ApiError (List B.Palitra))
    | TableStateChanged Table.State
    | DeleteRequested Int
    | DeleteResponse Int (Result ApiError ())


init : () -> ( Model, Effect Msg )
init _ =
    ( { palitras = Loading
      , tableState = Table.initialSort "Назва"
      , deleting = Nothing
      }
    , E.sendCmd <| Api.palitra_list PalitraListResp
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        PalitraListResp (Ok list) ->
            ( { model | palitras = Success list }, E.none )

        PalitraListResp (Err err) ->
            ( { model | palitras = Failure err }, E.none )

        TableStateChanged state ->
            ( { model | tableState = state }, E.none )

        DeleteRequested palitraId ->
            ( { model | deleting = Just palitraId }
            , E.sendCmd <| Api.palitra_delete (DeleteResponse palitraId) palitraId
            )

        DeleteResponse palitraId (Ok _) ->
            case model.palitras of
                Success list ->
                    ( { model
                        | palitras = Success <| List.filter (\p -> p.id /= palitraId) list
                        , deleting = Nothing
                      }
                    , E.none
                    )

                _ ->
                    ( { model | deleting = Nothing }, E.none )

        DeleteResponse _ (Err _) ->
            ( { model | deleting = Nothing }, E.none )


view : Auth.User -> Shared.Model -> Model -> View Msg
view user _ model =
    { title = "палітри"
    , body =
        [ div [ class "" ]
            [ case model.palitras of
                Loading ->
                    div [ class "p-4" ] [ Shared.Components.Spinner.loadingSpinner2Sm ]

                Failure _ ->
                    div [ class "p-4 text-red-600" ] [ text "Не вдалося завантажити палітри" ]

                Success pal ->
                    div [] [ renderTable user model pal ]

                NeedsReload _ ->
                    text ""

                NotAsked ->
                    text ""
            ]
        ]
    }


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view user shared
        , subscriptions = \_ -> Sub.none
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "etalonka"
        }


renderTable : Auth.User -> Model -> List B.Palitra -> Html Msg
renderTable user model palitras =
    let
        canDelete palitra =
            Core.Auth.hasRole "Admin" user
                || Core.Auth.hasRole "UnitsEditor" user
                || Core.Auth.hasRole "CallsignsEditor" user
                || (Maybe.withDefault "" palitra.author == user.name)

        defaultCustomizations =
            Table.defaultCustomizations

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
            }

        tableConfig : Table.Config B.Palitra Msg
        tableConfig =
            Table.customConfig
                { toId = .id >> String.fromInt
                , toMsg = TableStateChanged
                , customizations = customizations
                , columns =
                    [ Table.stringColumn "Назва" .name
                    , Table.veryCustomColumn
                        { name = "Колір"
                        , viewData =
                            \p ->
                                { attributes = [ class "col-narrow" ]
                                , children =
                                    [ span
                                        [ class "inline-block w-6 h-6 rounded"
                                        , style "background" p.colorHex
                                        , style "display" "inline-block"
                                        ]
                                        []
                                    ]
                                }
                        , sorter = Sorter.increasingOrDecreasingBy .colorHex
                        }
                    , Table.stringColumn "Файл" (\p -> Maybe.withDefault "—" p.sourceFileName)
                    , Table.stringColumn "Автор" (\p -> Maybe.withDefault "—" p.author)
                    , Table.stringColumn "Доступ" renderAccess
                    , Table.veryCustomColumn
                        { name = "Дія"
                        , viewData =
                            \p ->
                                let
                                    isDeleting =
                                        model.deleting == Just p.id
                                in
                                { attributes = [ class "col-narrow flex gap-2 items-center" ]
                                , children =
                                    if canDelete p then
                                        [ Button.view
                                            (Button.new
                                                { label = "Видалити"
                                                , onClick =
                                                    if isDeleting then
                                                        NoOp

                                                    else
                                                        DeleteRequested p.id
                                                }
                                                |> Button.withStyleDanger
                                                |> Button.withDisabled isDeleting
                                            )
                                        , if isDeleting then
                                            Shared.Components.Spinner.loadingSpinner2Sm

                                          else
                                            text ""
                                        ]

                                    else
                                        [ text "" ]
                                }
                        , sorter = Sorter.unsortable
                        }
                    ]
                }
    in
    Table.view tableConfig model.tableState palitras


renderAccess : B.Palitra -> String
renderAccess p =
    if not (List.isEmpty p.accessLogins) then
        "за логінами"

    else if not (List.isEmpty p.accessOrganismIds) then
        "за підрозділами"

    else if not (List.isEmpty p.accessAorId) then
        "за смугами"

    else
        "глобальна"
