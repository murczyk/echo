module Pages.Admin.TagsNeo.KeywordEdit exposing (Model, Msg, page)

import Auth
import Dict
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (attribute, class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user _ route =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view route
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }



-- INIT


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init () =
    ( {}
    , E.none
    )



-- UPDATE


type Msg
    = NoOp


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model
            , E.none
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Route () -> Model -> View Msg
view route _ =
    let
        tagIdAttrs =
            case Dict.get "tagId" route.query of
                Just tagId ->
                    [ attribute "data-tag-id" tagId ]

                Nothing ->
                    []

        keywordIdAttrs =
            case Dict.get "keywordId" route.query of
                Just keywordId ->
                    [ attribute "data-keyword-id" keywordId ]

                Nothing ->
                    []
    in
    { title = "Адмін: ключове слово (neo)"
    , body =
        [ div [ class "mt-2 w-full" ]
            [ node "tags-neo-keyword-edit" (tagIdAttrs ++ keywordIdAttrs) [] ]
        ]
    }
