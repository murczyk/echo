module Pages.Admin.AllReports.Id_ exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (attribute, class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
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
    Layouts.Navbar { user = user, activeName = "all-reports" }


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init _ =
    ( {}, E.none )


type Msg
    = NoOp


update : Msg -> Model -> ( Model, Effect Msg )
update _ model =
    ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Route { id : String } -> Model -> View Msg
view route _ =
    { title = "Адмін: звіт"
    , body =
        [ div [ class "box-border px-6 py-6 w-full" ]
            [ node "admin-report-details"
                [ attribute "report-id" route.params.id, class "block w-full" ]
                []
            ]
        ]
    }
