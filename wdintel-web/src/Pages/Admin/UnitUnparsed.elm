module Pages.Admin.UnitUnparsed exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (attribute, class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import String
import View exposing (View)


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
        , activeName = "unit-unparsed"
        }


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init () =
    ( {}, E.none )


type Msg
    = NoOp


update : Msg -> Model -> ( Model, Effect Msg )
update _ model =
    ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Model -> View Msg
view user _ =
    { title = "Адмін: нерозпізнані підрозділи"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 pt-2 pb-6 w-full flex flex-col overflow-visible lg:overflow-hidden" ]
            [ div [ class "flex-1 min-h-0 w-full" ]
                [ node "admin-unit-unparsed"
                    [ class "react-fill-host block w-full h-full"
                    , attribute "data-auth-user-roles" (String.join "," user.roles)
                    ]
                    []
                ]
            ]
        ]
    }
