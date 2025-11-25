module Pages.RerPalitra exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events  exposing (onInput)
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
import String


type alias Model =
    { palitras : RemoteData ApiError (List B.Palitra)
    , tableState : Table.State
    , deleting : Maybe Int
    , form : Form
    , submitInFlight : Bool
    }


type alias Form =
    { name : String
    , colorHex : String
    , access : AccessForm
    , fileName : String
    }

type AccessForm
    = GlobalAccess
    | LoginsAccess String
    | OrganismsAccess String
    | AorAccess String


type Msg
    = NoOp
    | PalitraListResp (Result ApiError (List B.Palitra))
    | TableStateChanged Table.State
    | DeleteRequested Int
    | DeleteResponse Int (Result ApiError ())
    | UpdateForm (Form -> Form)
    | ChangeAccess AccessForm
    | SubmitCreate
    | CreateResponse (Result ApiError B.Palitra)


init : () -> ( Model, Effect Msg )
init _ =
    ( { palitras = Loading
      , tableState = Table.initialSort "Назва"
      , deleting = Nothing
      , form = emptyForm
      , submitInFlight = False
      }
    , E.sendCmd <| Api.palitra_list PalitraListResp
    )


emptyForm : Form
emptyForm =
    { name = ""
    , colorHex = "#00bcd4"
    , access = GlobalAccess
    , fileName = ""
    }


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

        UpdateForm fn ->
            ( { model | form = fn model.form }, E.none )

        ChangeAccess access ->
            let
                form =
                    model.form

                form1 =
                    { form | access = access }
            in
            ( { model | form = form1 }, E.none )

        SubmitCreate ->
            let
                req =
                    buildCreateReq model.form
            in
            ( { model | submitInFlight = True }
            , E.sendCmd <| Api.palitra_create CreateResponse req
            )

        CreateResponse (Ok p) ->
            let
                newList =
                    case model.palitras of
                        Success list ->
                            Success (p :: list)

                        _ ->
                            Success [ p ]
            in
            ( { model
                | palitras = newList
                , form = emptyForm
                , submitInFlight = False
              }
            , E.none
            )

        CreateResponse (Err _) ->
            ( { model | submitInFlight = False }, E.none )


view : Auth.User -> Shared.Model -> Model -> View Msg
view user _ model =
    { title = "палітри"
    , body =
        [ case model.palitras of
            Loading ->
                div [ class "p-4" ] [ Shared.Components.Spinner.loadingSpinner2Sm ]

            Failure _ ->
                div [ class "p-4 text-red-600" ] [ text "Не вдалося завантажити палітри" ]

            Success pal ->
                div []
                    [ renderForm model
                    , div [ class "mt-6 table-responsive-modern" ] [ renderTable user model pal ]
                    ]

            NeedsReload _ ->
                text ""

            NotAsked ->
                text ""
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


renderForm : Model -> Html Msg
renderForm model =
    let
        ( _, accessFields ) =
            case model.form.access of
                GlobalAccess ->
                    ( "Глобально", [] )

                LoginsAccess logins ->
                    ( "За логінами"
                    , [ div [ class "flex flex-col gap-1" ]
                            [ span [ class "text-sm text-foreground" ] [ text "Логіни (через кому)" ]
                            , inputText logins (\v -> UpdateForm (\f -> { f | access = LoginsAccess v }))
                            ]
                      ]
                    )

                OrganismsAccess ids ->
                    ( "За підрозділами"
                    , [ div [ class "flex flex-col gap-1" ]
                            [ span [ class "text-sm text-foreground" ] [ text "Organism IDs (через кому)" ]
                            , inputText ids (\v -> UpdateForm (\f -> { f | access = OrganismsAccess v }))
                            ]
                      ]
                    )

                AorAccess ids ->
                    ( "За смугами"
                    , [ div [ class "flex flex-col gap-1" ]
                            [ span [ class "text-sm text-foreground" ] [ text "AOR IDs (через кому)" ]
                            , inputText ids (\v -> UpdateForm (\f -> { f | access = AorAccess v }))
                            ]
                      ]
                    )
    in
    div [ class "space-y-4 p-4 rounded border border-border bg-card" ]
        [ div [ class "text-lg font-semibold" ] [ text "Створити палітру" ]
        , div [ class "flex flex-col gap-2" ]
            [ span [ class "text-sm text-foreground" ] [ text "Назва" ]
            , inputText model.form.name (\v -> UpdateForm (\f -> { f | name = v }))
            ]
        , div [ class "flex flex-col gap-2" ]
            [ span [ class "text-sm text-foreground" ] [ text "Колір" ]
            , input
                [ type_ "color"
                , class "w-16 h-10"
                , value model.form.colorHex
                , onInput (\v -> UpdateForm (\f -> { f | colorHex = v }))
                ]
                []
            ]
        , div [ class "flex flex-col gap-2" ]
            [ span [ class "text-sm text-foreground" ] [ text "Назва файлу (опціонально)" ]
            , inputText model.form.fileName (\v -> UpdateForm (\f -> { f | fileName = v }))
            ]
        , div [ class "flex flex-col gap-2" ]
            [ span [ class "text-sm text-foreground" ] [ text "Доступ" ]
            , div [ class "flex flex-wrap gap-2" ]
                [ accessButton "Глобально" GlobalAccess model.form.access
                , accessButton "Логіни" (LoginsAccess "") model.form.access
                , accessButton "Підрозділи" (OrganismsAccess "") model.form.access
                , accessButton "Смуги" (AorAccess "") model.form.access
                ]
            , div [] accessFields
            ]
        , Button.view
            (Button.new
                { label = "Створити"
                , onClick =
                    if model.submitInFlight then
                        NoOp

                    else
                        SubmitCreate
                }
                |> Button.withDisabled model.submitInFlight
            )
        ]


inputText : String -> (String -> Msg) -> Html Msg
inputText val toMsg =
    input
        [ class "w-full px-3 py-2 border border-border rounded bg-background text-foreground"
        , value val
        , onInput toMsg
        ]
        []


accessButton : String -> AccessForm -> AccessForm -> Html Msg
accessButton label target current =
    let
        isActive =
            case ( target, current ) of
                ( GlobalAccess, GlobalAccess ) ->
                    True
                ( LoginsAccess _, LoginsAccess _ ) ->
                    True
                ( OrganismsAccess _, OrganismsAccess _ ) ->
                    True
                ( AorAccess _, AorAccess _ ) ->
                    True
                _ ->
                    False
    in
    Button.view
        (Button.new
            { label = label
            , onClick = ChangeAccess target
            }
        )


buildCreateReq : Form -> B.CreatePalitraReq
buildCreateReq form =
    { name = form.name
    , colorHex = form.colorHex
    , access = accessToBinding form.access
    , sourceFileName =
        if String.isEmpty form.fileName then
            Nothing

        else
            Just form.fileName
    , lastUploadedAtTs = Nothing
    }


accessToBinding : AccessForm -> B.PalitraAccess
accessToBinding accessForm =
    case accessForm of
        GlobalAccess ->
            B.Global

        LoginsAccess logins ->
            let
                items =
                    logins
                        |> String.split ","
                        |> List.map String.trim
                        |> List.filter (\s -> s /= "")
            in
            B.ByLogins { logins = items }

        OrganismsAccess ids ->
            let
                items =
                    ids
                        |> String.split ","
                        |> List.filter (\s -> s /= "")
                        |> List.filterMap String.toInt
            in
            B.ByOrganisms { organismIds = items }

        AorAccess ids ->
            let
                items =
                    ids
                        |> String.split ","
                        |> List.filter (\s -> s /= "")
                        |> List.filterMap String.toInt
            in
            B.ByAor { aorIds = items }
