module Pages.RerAnalysisNeo exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


type alias Model =
    {}


type Msg
    = NoOp


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
        , activeName = "rer-analysis-neo"
        }


init : () -> ( Model, Effect Msg )
init () =
    ( {}
    , E.none
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Model -> View Msg
view _ =
    { title = "РЕР-аналіз"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 w-full flex flex-col overflow-visible lg:overflow-hidden" ]
            [ div [ class "flex-1 min-h-0 w-full" ]
                [ node "rer-analysis-neo"
                    [ class "block w-full h-full" ]
                    []
                ]
            ]
        ]
    }
