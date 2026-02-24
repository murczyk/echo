module Pages.Admin.TagsNeo.Edit exposing (Model, Msg, page)

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
        , activeName = "tags-neo"
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
subscriptions _ =
    Sub.none



-- VIEW


view : Route () -> Model -> View Msg
view route _ =
    let
        tagIdAttrs =
            case Dict.get "id" route.query of
                Just tagId ->
                    [ attribute "data-tag-id" tagId ]

                Nothing ->
                    []
    in
    { title = "Адмін: теги (neo)"
    , body =
        [ div [ class "mt-4 w-full" ]
            [ node "tags-neo-edit" tagIdAttrs [] ]
        ]
    }
