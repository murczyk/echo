module Pages.RerPalitra exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (Html, div, text)
import Layouts
import Page exposing (Page)
import Platform.Sub as Sub
import Route exposing (Route)
import Shared
import View exposing (View)


type alias Model =
    {}


type Msg
    = NoOp


init : () -> ( Model, Effect Msg )
init _ =
    ( {}, E.none )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


view : Auth.User -> Shared.Model -> Model -> View Msg
view _ _ _ =
    { title = "палітри"
    , body = [ div [] [ text "Палітри (сторінка у розробці)" ] ]
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
