module Pages.RerUnitsNeo exposing (Model, Msg, page)

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
import String
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


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user _ _ =
    Page.new
        { init = init user
        , update = update
        , subscriptions = subscriptions
        , view = view user
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-units"
        }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Model -> View Msg
view user _ =
    { title = "Підрозділи противника"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 pt-6 pb-6 w-full flex flex-col gap-6 overflow-visible lg:overflow-hidden" ]
            [ div [ class "flex-1 min-h-0 w-full" ]
                [ node "rer-units-neo"
                    [ attribute "data-auth-user-roles" (String.join "," user.roles)
                    , class "block w-full h-full"
                    ]
                    []
                ]
            ]
        ]
    }
