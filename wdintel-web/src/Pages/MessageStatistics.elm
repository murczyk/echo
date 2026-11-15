module Pages.MessageStatistics exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (attribute, class)
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
        , view = view user
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "message-statistics"
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


view : Auth.User -> Model -> View Msg
view user _ =
    { title = "Статистика повідомлень"
    , body =
        [ div
            [ class "app-shell-fill-height box-border min-h-0 w-full flex flex-col overflow-visible lg:overflow-hidden"
            ]
            [ div [ class "flex-1 min-h-0 w-full" ]
                [ node "message-statistics"
                    [ class "block w-full h-full"
                    , attribute "data-auth-user-id" user.id
                    , attribute "data-auth-user-roles" (String.join "," user.roles)
                    ]
                    []
                ]
            ]
        ]
    }
