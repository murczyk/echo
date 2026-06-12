module Pages.RerNetworksNeo.Id_ exposing (Model, Msg, page)

import Auth
import Core.Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (attribute, class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Shared
import View exposing (View)


type alias Model =
    {}


init : Auth.User -> () -> ( Model, Effect Msg )
init user _ =
    if user.name == "anonymous" || Core.Auth.hasRole "Rer" user then
        ( {}, E.none )

    else
        ( {}, E.replaceRoutePath Route.Path.Home_ )


type Msg
    = NoOp


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user _ route =
    Page.new
        { init = init user
        , update = update
        , subscriptions = subscriptions
        , view = view route
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "networks-neo"
        }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Route { id : String } -> Model -> View Msg
view route _ =
    { title = "Мережа"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 py-4 w-full flex flex-col" ]
            [ node "rer-network-details-neo"
                [ class "block w-full h-full"
                , attribute "network-id" route.params.id
                ]
                []
            ]
        ]
    }
