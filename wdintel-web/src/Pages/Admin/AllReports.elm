module Pages.Admin.AllReports exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user _ _ =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "all-reports"
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


view : Model -> View Msg
view _ =
    { title = "Адмін: всі звіти"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 pt-6 pb-6 w-full flex flex-col overflow-hidden" ]
            [ div [ class "flex-1 min-h-0 w-full" ]
                [ node "admin-all-reports" [ class "react-fill-host block w-full h-full" ] [] ]
            ]
        ]
    }
