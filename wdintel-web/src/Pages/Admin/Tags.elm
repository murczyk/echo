module Pages.Admin.Tags exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (onClick)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Shared
import Shared.Components.Spinner as Spinner
import String
import Utils.Api.ErrorHandling
import Utils.RemoteData as RD
import View exposing (View)


type alias Model =
    { tags : RD.RemoteData ApiError (List B.TagAdmin)
    }


type Msg
    = GotTags (Result ApiError (List B.TagAdmin))
    | Reload


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }


init : () -> ( Model, Effect Msg )
init _ =
    ( { tags = RD.Loading }
    , E.sendCmd <| Api.admin_tags_list GotTags
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotTags (Ok tags) ->
            ( { model | tags = RD.Success tags }, E.none )

        GotTags (Err err) ->
            ( { model | tags = RD.Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити теги" err
            )

        Reload ->
            ( { model | tags = RD.Loading }
            , E.sendCmd <| Api.admin_tags_list GotTags
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Model -> View Msg
view user model =
    { title = "Адмін · Теги"
    , body =
        [ div [ class "container py-4" ]
            [ div [ class "flex items-center justify-between mb-4" ]
                [ h2 [ class "text-xl font-semibold" ] [ text "Теги" ]
                , div [ class "flex gap-2" ]
                    [ a
                        [ class "btn btn-primary"
                        , Route.href { path = Route.Path.Admin_Tags_Edit, query = Dict.empty, hash = Nothing }
                        ]
                        [ text "Створити" ]
                    , button [ class "btn btn-outline-secondary", onClick Reload ] [ text "Оновити" ]
                    ]
                ]
            , renderContent model.tags
            ]
        ]
    }


renderContent : RD.RemoteData ApiError (List B.TagAdmin) -> Html Msg
renderContent tagsState =
    case tagsState of
        RD.NotAsked ->
            text ""

        RD.Loading ->
            div [ class "flex justify-center py-8" ] [ Spinner.loadingSpinner ]

        RD.NeedsReload tags ->
            renderContent (RD.Success tags)

        RD.Failure _ ->
            div [ class "alert alert-danger" ]
                [ text "Не вдалося завантажити теги." ]

        RD.Success tags ->
            if List.isEmpty tags then
                div [ class "text-muted" ] [ text "Поки що немає тегів." ]

            else
                div [ class "overflow-x-auto" ]
                    [ table [ class "table table-sm align-middle" ]
                        [ thead []
                            [ tr []
                                [ th [] [ text "ID" ]
                                , th [] [ text "Назва" ]
                                , th [] [ text "Додатковий" ]
                                , th [] [ text "Ord" ]
                                , th [] [ text "Активний" ]
                                , th [] [ text "Ключові слова" ]
                                , th [] [ text "" ]
                                ]
                            ]
                        , tbody [] (List.map renderRow tags)
                        ]
                    ]


renderRow : B.TagAdmin -> Html Msg
renderRow tag =
    let
        extraLabel =
            case tag.extra of
                Just True ->
                    "так"

                _ ->
                    "ні"

        ordLabel =
            tag.ord
                |> Maybe.map String.fromFloat
                |> Maybe.withDefault "—"
    in
    tr []
        [ td [] [ text (String.fromInt tag.tagId) ]
        , td [] [ text tag.label ]
        , td [] [ text extraLabel ]
        , td [] [ text ordLabel ]
        , td []
            [ text
                (if tag.enabled then
                    "так"

                 else
                    "ні"
                )
            ]
        , td [] [ text (String.fromInt (List.length tag.keywords)) ]
        , td [ class "text-end" ]
            [ a
                [ class "btn btn-sm btn-outline-primary"
                , Route.href
                    { path = Route.Path.Admin_Tags_Edit
                    , query = Dict.fromList [ ( "id", String.fromInt tag.tagId ) ]
                    , hash = Nothing
                    }
                ]
                [ text "Редагувати" ]
            ]
        ]
