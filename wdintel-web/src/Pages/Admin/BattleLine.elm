module Pages.Admin.BattleLine exposing (Model, Msg, page)

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
        { init = \() -> ( {}, E.none )
        , update = \_ model -> ( model, E.none )
        , subscriptions = \_ -> Sub.none
        , view = view
        }
        |> Page.withLayout (\_ -> Layouts.Navbar { user = user, activeName = "battle-line" })


type alias Model =
    {}


type Msg
    = NoOp


view : Model -> View Msg
view _ =
    { title = "Карта"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 pt-4 pb-6 w-full flex flex-col overflow-hidden" ]
            [ node "admin-battle-line" [ class "react-fill-host block w-full h-full" ] [] ]
        ]
    }
