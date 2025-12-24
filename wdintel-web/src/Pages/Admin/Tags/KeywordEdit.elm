module Pages.Admin.Tags.KeywordEdit exposing (Mode(..), Model, Msg, page)

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
import Shared
import Shared.Components.Spinner as Spinner
import String
import Utils.Api.ErrorHandling
import View exposing (View)


type alias Model =
    { tagId : Maybe Int
    , keywordId : Maybe Int
    , tagLabel : Maybe String
    , isRegex : Bool
    , keyword : String
    , keywordFormsInput : String
    , keywordNegativeFormsInput : String
    , loading : Bool
    , saving : Bool
    , formErrors : Dict String String
    , loadError : Maybe String
    }


type Msg
    = Loaded Int (Maybe Int) (Result ApiError (List B.TagAdmin))
    | KeywordChanged String
    | KeywordFormsChanged String
    | KeywordNegativeFormsChanged String
    | ToggleRegex Bool
    | Save
    | Saved (Result ApiError ())
    | GoBack


type Mode
    = Create
    | Edit


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared route =
    Page.new
        { init = init route
        , update = update
        , view = view
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
    case parseIds route.query of
        Err err ->
            ( defaultModel Nothing Nothing |> withError err, E.none )

        Ok ( tid, maybeKeywordId ) ->
            let
                base =
                    defaultModel (Just tid) maybeKeywordId
            in
            ( { base | loading = True }
            , E.sendCmd <| Api.admin_tags_list (Loaded tid maybeKeywordId)
            )


parseIds : Dict String String -> Result String ( Int, Maybe Int )
parseIds query =
    case Dict.get "tagId" query |> Maybe.andThen String.toInt of
        Nothing ->
            Err "Некоректний id тегу"

        Just tid ->
            case Dict.get "keywordId" query of
                Nothing ->
                    Ok ( tid, Nothing )

                Just keywordStr ->
                    case String.toInt keywordStr of
                        Just kid ->
                            Ok ( tid, Just kid )

                        Nothing ->
                            Err "Некоректний id ключового слова"


defaultModel : Maybe Int -> Maybe Int -> Model
defaultModel tid kid =
    { tagId = tid
    , keywordId = kid
    , tagLabel = Nothing
    , isRegex = False
    , keyword = ""
    , keywordFormsInput = ""
    , keywordNegativeFormsInput = ""
    , loading = False
    , saving = False
    , formErrors = Dict.empty
    , loadError = Nothing
    }


withError : String -> Model -> Model
withError err model =
    { model | loadError = Just err, loading = False }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        Loaded tagId keywordId (Ok tags) ->
            let
                maybeTag =
                    List.filter (\t -> t.tagId == tagId) tags |> List.head
            in
            case maybeTag of
                Nothing ->
                    ( withError "Тег не знайдено" model, E.none )

                Just tag ->
                    case keywordId of
                        Nothing ->
                            ( { model
                                | tagLabel = Just tag.label
                                , loading = False
                              }
                            , E.none
                            )

                        Just kid ->
                            case List.filter (\kw -> kw.tagKeywordId == kid) tag.keywords |> List.head of
                                Nothing ->
                                    ( withError "Ключове слово не знайдено" model, E.none )

                                Just kw ->
                                    ( { model
                                        | tagLabel = Just tag.label
                                        , keywordId = Just kid
                                        , isRegex = kw.isRegex
                                        , keyword = kw.keyword
                                        , keywordFormsInput = String.join "\n" kw.keywordForms
                                        , keywordNegativeFormsInput = String.join "\n" kw.keywordNegativeForms
                                        , loading = False
                                      }
                                    , E.none
                                    )

        Loaded _ _ (Err err) ->
            ( withError "Не вдалося завантажити дані" model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити дані" err
            )

        KeywordChanged v ->
            ( { model | keyword = v }, E.none )

        KeywordFormsChanged v ->
            ( { model | keywordFormsInput = v }, E.none )

        KeywordNegativeFormsChanged v ->
            ( { model | keywordNegativeFormsInput = v }, E.none )

        ToggleRegex v ->
            ( { model | isRegex = v }, E.none )

        Save ->
            let
                ( errors, maybeReq ) =
                    buildRequest model
            in
            case ( maybeReq, model.tagId ) of
                ( Nothing, _ ) ->
                    ( { model | formErrors = errors }, E.none )

                ( Just req, Just tid ) ->
                    case model.keywordId of
                        Nothing ->
                            ( { model | saving = True, formErrors = errors }
                            , Api.tag_keywords_add (Result.map (\_ -> ()) >> Saved) tid [ req ]
                                |> E.sendCmd
                            )

                        Just kid ->
                            ( { model | saving = True, formErrors = errors }
                            , Api.tag_keyword_update Saved { tagId = tid, tagKeywordId = kid } req
                                |> E.sendCmd
                            )

                ( Just _, Nothing ) ->
                    ( { model | formErrors = errors }, E.showError "Спочатку збережіть тег" )

        Saved (Ok _) ->
            let
                tid =
                    model.tagId |> Maybe.withDefault 0
            in
            ( { model | saving = False }
            , E.pushRoute
                { path = Route.Path.Admin_Tags_Edit
                , query = Dict.fromList [ ( "id", String.fromInt tid ) ]
                , hash = Nothing
                }
            )

        Saved (Err err) ->
            ( { model | saving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося зберегти ключове слово" err
            )

        GoBack ->
            case model.tagId of
                Just tid ->
                    ( model
                    , E.pushRoute
                        { path = Route.Path.Admin_Tags_Edit
                        , query = Dict.fromList [ ( "id", String.fromInt tid ) ]
                        , hash = Nothing
                        }
                    )

                Nothing ->
                    ( model, E.none )


buildRequest : Model -> ( Dict String String, Maybe B.TagKeywordAddReq )
buildRequest model =
    let
        trimmedKeyword =
            String.trim model.keyword

        errors =
            if trimmedKeyword == "" then
                Dict.insert "keyword" "Заповніть ключове слово" Dict.empty

            else
                Dict.empty

        formsList =
            model.keywordFormsInput
                |> String.split "\n"
                |> List.map String.trim
                |> List.filter (\v -> v /= "")

        formsListNegative =
            model.keywordNegativeFormsInput
                |> String.split "\n"
                |> List.map String.trim
                |> List.filter (\v -> v /= "")

        keywordForms =
            if List.isEmpty formsList then
                Nothing

            else
                Just formsList

        keywordNegativeForms =
            if List.isEmpty formsListNegative then
                Nothing

            else
                Just formsListNegative
    in
    if Dict.isEmpty errors then
        ( Dict.empty
        , Just
            { isRegex = model.isRegex
            , keyword = trimmedKeyword
            , keywordForms = keywordForms
            , keywordNegativeForms = keywordNegativeForms
            }
        )

    else
        ( errors, Nothing )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Model -> View Msg
view model =
    { title = "Адмін · Ключове слово"
    , body =
        [ div [ class "container py-4" ]
            [ navBar model.tagId
            , h2 [ class "text-xl font-semibold mb-3" ]
                [ text <|
                    case model.keywordId of
                        Nothing ->
                            "Створити ключове слово"

                        Just _ ->
                            "Редагувати ключове слово"
                ]
            , renderContent model
            ]
        ]
    }


navBar : Maybe Int -> Html Msg
navBar maybeTagId =
    case maybeTagId of
        Nothing ->
            text ""

        Just tid ->
            a
                [ class "text-decoration-none mb-3 inline-block"
                , Route.href
                    { path = Route.Path.Admin_Tags_Edit
                    , query = Dict.fromList [ ( "id", String.fromInt tid ) ]
                    , hash = Nothing
                    }
                ]
                [ text "← До тегу" ]


renderContent : Model -> Html Msg
renderContent model =
    if model.loading then
        div [ class "flex justify-center py-6" ] [ Spinner.loadingSpinner ]

    else
        case model.loadError of
            Just err ->
                div [ class "alert alert-danger" ] [ text err ]

            Nothing ->
                formView model


formView : Model -> Html Msg
formView model =
    let
        keywordError =
            Dict.get "keyword" model.formErrors |> Maybe.withDefault ""
    in
    div [ class "card shadow-sm" ]
        [ div [ class "card-body space-y-3" ]
            [ case model.tagLabel of
                Just label_ ->
                    div [ class "text-muted" ]
                        [ text ("Тег: " ++ label_) ]

                Nothing ->
                    text ""
            , div []
                [ label [ class "form-label fw-semibold" ] [ text "Ключове слово" ]
                , input
                    [ class "form-control"
                    , value model.keyword
                    , onInput KeywordChanged
                    , disabled model.saving
                    ]
                    []
                , if keywordError /= "" then
                    div [ class "text-danger text-sm mt-1" ] [ text keywordError ]

                  else
                    text ""
                ]
            , div []
                [ label [ class "form-label fw-semibold" ] [ text "Форми (по одному на рядок, опційно)" ]
                , textarea
                    [ class "form-control"
                    , value model.keywordFormsInput
                    , onInput KeywordFormsChanged
                    , rows 4
                    , disabled model.saving
                    ]
                    []
                ]
            , div []
                [ label [ class "form-label fw-semibold" ] [ text "Негативні форми (по одному на рядок, опційно)" ]
                , textarea
                    [ class "form-control"
                    , value model.keywordNegativeFormsInput
                    , onInput KeywordNegativeFormsChanged
                    , rows 4
                    , disabled model.saving
                    ]
                    []
                ]
            , div [ class "flex items-center gap-3" ]
                [ label [ class "flex items-center gap-2" ]
                    [ input
                        [ type_ "checkbox"
                        , class "form-check-input"
                        , checked model.isRegex
                        , onCheck ToggleRegex
                        , disabled model.saving
                        ]
                        []
                    , text "Regex"
                    ]
                ]
            , div [ class "flex gap-2" ]
                [ button
                    [ class "btn btn-primary"
                    , onClick Save
                    , disabled model.saving
                    ]
                    [ text "Зберегти" ]
                , button
                    [ class "btn btn-outline-secondary"
                    , onClick GoBack
                    , disabled model.saving
                    ]
                    [ text "Повернутись" ]
                , if model.saving then
                    div [ class "text-muted text-sm" ] [ text "Збереження..." ]

                  else
                    text ""
                ]
            ]
        ]
