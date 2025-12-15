module Pages.Admin.Tags.Edit exposing (Mode(..), Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onCheck, onClick, onInput)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Set exposing (Set)
import Shared
import Shared.Components.Spinner as Spinner
import String
import Utils.Api.ErrorHandling
import View exposing (View)


type Mode
    = Create
    | Edit


type alias Model =
    { mode : Mode
    , tagId : Maybe Int
    , label : String
    , extra : Maybe Bool
    , ordInput : String
    , enabled : Bool
    , keywords : List B.TagKeyword
    , loading : Bool
    , saving : Bool
    , deleting : Set Int
    , formErrors : Dict String String
    , loadError : Maybe String
    }


type Msg
    = GotTagData Int (Result ApiError (List B.TagAdmin))
    | LabelChanged String
    | ToggleExtra Bool
    | ToggleEnabled Bool
    | OrdChanged String
    | Save
    | Saved (Result ApiError B.TagAdmin)
    | DeleteKeyword Int
    | KeywordDeleted Int (Result ApiError ())
    | OpenKeywordCreate
    | OpenKeywordEdit Int


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared route =
    Page.new
        { init = init route
        , update = update
        , view = view user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }


init : Route () -> () -> ( Model, Effect Msg )
init route _ =
    let
        parsedId =
            case Dict.get "id" route.query of
                Nothing ->
                    Ok Nothing

                Just idStr ->
                    case String.toInt idStr of
                        Just tid ->
                            Ok (Just tid)

                        Nothing ->
                            Err "Некоректний id тегу"

        base mode tagId =
            { mode = mode
            , tagId = tagId
            , label = ""
            , extra = Nothing
            , ordInput = ""
            , enabled = True
            , keywords = []
            , loading = False
            , saving = False
            , deleting = Set.empty
            , formErrors = Dict.empty
            , loadError = Nothing
            }
    in
    case parsedId of
        Err err ->
            let
                modelBase =
                    base Edit Nothing
            in
            ( { modelBase | loadError = Just err }, E.none )

        Ok Nothing ->
            ( base Create Nothing, E.none )

        Ok (Just tid) ->
            let
                modelBase =
                    base Edit (Just tid)
            in
            ( { modelBase | loading = True }
            , E.sendCmd <| Api.admin_tags_list (GotTagData tid)
            )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotTagData tagId (Ok tags) ->
            let
                maybeTag =
                    List.filter (\t -> t.tagId == tagId) tags |> List.head
            in
            case maybeTag of
                Just tag ->
                    ( applyTag tag model, E.none )

                Nothing ->
                    ( { model | loading = False, loadError = Just "Тег не знайдено" }, E.none )

        GotTagData _ (Err err) ->
            ( { model | loading = False, loadError = Just "Не вдалося завантажити тег" }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити тег" err
            )

        LabelChanged v ->
            ( { model | label = v }, E.none )

        ToggleExtra flag ->
            ( { model
                | extra =
                    if flag then
                        Just True

                    else
                        Nothing
              }
            , E.none
            )

        ToggleEnabled flag ->
            ( { model | enabled = flag }, E.none )

        OrdChanged v ->
            ( { model | ordInput = v }, E.none )

        Save ->
            let
                ( errors, maybeReq ) =
                    buildRequest model

                modelWithErrors =
                    { model | formErrors = errors }
            in
            case maybeReq of
                Nothing ->
                    ( modelWithErrors, E.none )

                Just req ->
                    case ( model.mode, model.tagId ) of
                        ( Create, _ ) ->
                            ( { modelWithErrors | saving = True }
                            , E.sendCmd <| Api.admin_create_tag Saved req
                            )

                        ( Edit, Just tid ) ->
                            ( { modelWithErrors | saving = True }
                            , E.sendCmd <| Api.admin_update_tag Saved tid req
                            )

                        _ ->
                            ( { modelWithErrors | loadError = Just "Спочатку збережіть тег" }, E.none )

        Saved (Ok tag) ->
            let
                newModel =
                    applyTag tag { model | saving = False }

                effect =
                    case model.mode of
                        Create ->
                            E.pushRoute
                                { path = Route.Path.Admin_Tags_Edit
                                , query = Dict.fromList [ ( "id", String.fromInt tag.tagId ) ]
                                , hash = Nothing
                                }

                        Edit ->
                            E.none
            in
            ( newModel, effect )

        Saved (Err err) ->
            ( { model | saving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося зберегти тег" err
            )

        DeleteKeyword keywordId ->
            case model.tagId of
                Nothing ->
                    ( model, E.showError "Спочатку збережіть тег" )

                Just tid ->
                    ( { model | deleting = Set.insert keywordId model.deleting }
                    , E.sendCmd <|
                        Api.tag_keyword_delete
                            (KeywordDeleted keywordId)
                            { tagId = tid, tagKeywordId = keywordId }
                    )

        KeywordDeleted keywordId (Ok _) ->
            ( { model
                | deleting = Set.remove keywordId model.deleting
                , keywords = List.filter (\kw -> kw.tagKeywordId /= keywordId) model.keywords
              }
            , E.none
            )

        KeywordDeleted keywordId (Err err) ->
            ( { model | deleting = Set.remove keywordId model.deleting }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося видалити ключове слово" err
            )

        OpenKeywordCreate ->
            case model.tagId of
                Nothing ->
                    ( model, E.showError "Спочатку збережіть тег" )

                Just tid ->
                    ( model
                    , E.pushRoute
                        { path = Route.Path.Admin_Tags_KeywordEdit
                        , query = Dict.fromList [ ( "tagId", String.fromInt tid ) ]
                        , hash = Nothing
                        }
                    )

        OpenKeywordEdit keywordId ->
            case model.tagId of
                Nothing ->
                    ( model, E.showError "Спочатку збережіть тег" )

                Just tid ->
                    ( model
                    , E.pushRoute
                        { path = Route.Path.Admin_Tags_KeywordEdit
                        , query =
                            Dict.fromList
                                [ ( "tagId", String.fromInt tid )
                                , ( "keywordId", String.fromInt keywordId )
                                ]
                        , hash = Nothing
                        }
                    )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


applyTag : B.TagAdmin -> Model -> Model
applyTag tag model =
    { model
        | mode = Edit
        , tagId = Just tag.tagId
        , label = tag.label
        , extra = tag.extra
        , ordInput = tag.ord |> Maybe.map String.fromFloat |> Maybe.withDefault ""
        , enabled = tag.enabled
        , keywords = tag.keywords
        , loading = False
        , loadError = Nothing
        , formErrors = Dict.empty
    }


buildRequest : Model -> ( Dict String String, Maybe B.TagUpsertReq )
buildRequest model =
    let
        trimmedLabel =
            String.trim model.label

        errors =
            if trimmedLabel == "" then
                Dict.insert "label" "Заповніть назву" Dict.empty

            else
                Dict.empty

        ( ordErrors, ordValue ) =
            if String.trim model.ordInput == "" then
                ( Dict.empty, Nothing )

            else
                case String.toFloat model.ordInput of
                    Just v ->
                        ( Dict.empty, Just v )

                    Nothing ->
                        ( Dict.fromList [ ( "ord", "Некоректне число" ) ], Nothing )

        allErrors =
            Dict.union errors ordErrors
    in
    if Dict.isEmpty allErrors then
        ( Dict.empty
        , Just
            { label = trimmedLabel
            , extra = model.extra
            , ord = ordValue
            , enabled = model.enabled
            }
        )

    else
        ( allErrors, Nothing )


view : Auth.User -> Model -> View Msg
view user model =
    { title = "Адмін · Тег"
    , body =
        [ div [ class "container py-4" ]
            [ navBar
            , h2 [ class "text-xl font-semibold mb-3" ]
                [ text <|
                    case model.mode of
                        Create ->
                            "Створити тег"

                        Edit ->
                            "Редагувати тег"
                ]
            , renderContent model
            ]
        ]
    }


navBar : Html Msg
navBar =
    div [ class "mb-3" ]
        [ a
            [ class "text-decoration-none"
            , Route.href { path = Route.Path.Admin_Tags, query = Dict.empty, hash = Nothing }
            ]
            [ text "← До списку тегів" ]
        ]


renderContent : Model -> Html Msg
renderContent model =
    if model.loading then
        div [ class "flex justify-center py-6" ] [ Spinner.loadingSpinner ]

    else
        case model.loadError of
            Just err ->
                div [ class "alert alert-danger" ] [ text err ]

            Nothing ->
                div [ class "space-y-4" ]
                    [ formView model
                    , keywordsBlock model
                    ]


formView : Model -> Html Msg
formView model =
    let
        labelError =
            Dict.get "label" model.formErrors |> Maybe.withDefault ""

        ordError =
            Dict.get "ord" model.formErrors |> Maybe.withDefault ""
    in
    div [ class "card shadow-sm" ]
        [ div [ class "card-body space-y-3" ]
            [ div [] [ text "Поля" ]
            , div [ class "mb-3" ]
                [ label [ class "form-label fw-semibold" ] [ text "Назва" ]
                , input
                    [ class "form-control"
                    , value model.label
                    , onInput LabelChanged
                    , disabled model.saving
                    ]
                    []
                , if labelError /= "" then
                    div [ class "text-danger text-sm mt-1" ] [ text labelError ]

                  else
                    text ""
                ]
            , div [ class "mb-3 flex items-center gap-2" ]
                [ input
                    [ type_ "checkbox"
                    , class "form-check-input"
                    , checked (model.extra == Just True)
                    , onCheck ToggleExtra
                    , disabled model.saving
                    ]
                    []
                , label [ class "form-check-label" ] [ text "Додатковий тег" ]
                ]
            , div [ class "mb-3" ]
                [ label [ class "form-label fw-semibold" ] [ text "Ord (опційно)" ]
                , input
                    [ class "form-control"
                    , value model.ordInput
                    , onInput OrdChanged
                    , placeholder "напр., 10.5"
                    , disabled model.saving
                    ]
                    []
                , if ordError /= "" then
                    div [ class "text-danger text-sm mt-1" ] [ text ordError ]

                  else
                    text ""
                ]
            , div [ class "mb-3 flex items-center gap-2" ]
                [ input
                    [ type_ "checkbox"
                    , class "form-check-input"
                    , checked model.enabled
                    , onCheck ToggleEnabled
                    , disabled model.saving
                    ]
                    []
                , label [ class "form-check-label" ] [ text "Активний" ]
                ]
            , div [ class "flex gap-2" ]
                [ button
                    [ class "btn btn-primary"
                    , onClick Save
                    , disabled model.saving
                    ]
                    [ text <|
                        case model.mode of
                            Create ->
                                "Створити"

                            Edit ->
                                "Зберегти"
                    ]
                , if model.saving then
                    div [ class "text-sm text-muted" ] [ text "Збереження..." ]

                  else
                    text ""
                ]
            ]
        ]


keywordsBlock : Model -> Html Msg
keywordsBlock model =
    let
        actionButtons =
            case model.tagId of
                Just _ ->
                    [ button
                        [ class "btn btn-sm btn-primary"
                        , onClick OpenKeywordCreate
                        ]
                        [ text "Створити ключове слово" ]
                    ]

                Nothing ->
                    [ div [ class "text-muted text-sm" ] [ text "Збережіть тег, щоб додавати ключові слова" ] ]
    in
    div [ class "card shadow-sm" ]
        [ div [ class "card-body" ]
            [ div [ class "flex items-center justify-between mb-2" ]
                [ h3 [ class "h6 mb-0" ] [ text "Ключові слова" ]
                , div [ class "flex gap-2" ] actionButtons
                ]
            , if List.isEmpty model.keywords then
                div [ class "text-muted text-sm" ] [ text "Немає ключових слів" ]

              else
                div [ class "overflow-x-auto" ]
                    [ table [ class "table table-sm align-middle" ]
                        [ thead []
                            [ tr []
                                [ th [] [ text "Ключ" ]
                                , th [] [ text "Regex" ]
                                , th [] [ text "Позитивний" ]
                                , th [] [ text "Форми" ]
                                , th [ class "text-end" ] [ text "Дії" ]
                                ]
                            ]
                        , tbody [] (List.map (keywordRow model) model.keywords)
                        ]
                    ]
            ]
        ]


keywordRow : Model -> B.TagKeyword -> Html Msg
keywordRow model kw =
    let
        deletingNow =
            Set.member kw.tagKeywordId model.deleting
    in
    tr []
        [ td [] [ text kw.keyword ]
        , td []
            [ text
                (if kw.isRegex then
                    "так"

                 else
                    "ні"
                )
            ]
        , td []
            [ text
                (if kw.isPositive then
                    "так"

                 else
                    "ні"
                )
            ]
        , td [] [ text (String.join ", " kw.keywordForms) ]
        , td [ class "text-end flex gap-2 justify-end" ]
            [ button
                [ class "btn btn-sm btn-outline-primary"
                , onClick (OpenKeywordEdit kw.tagKeywordId)
                ]
                [ text "Редагувати" ]
            , button
                [ class "btn btn-sm btn-outline-danger"
                , onClick (DeleteKeyword kw.tagKeywordId)
                , disabled deletingNow
                ]
                [ if deletingNow then
                    text "Видалення..."

                  else
                    text "Видалити"
                ]
            ]
        ]
