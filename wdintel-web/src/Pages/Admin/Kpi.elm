module Pages.Admin.Kpi exposing (Model, Msg, page)

import Auth
import Core.Auth
import Effect as E exposing (Effect)
import Html exposing (div, node, text)
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
        , view = view user
        }
        |> Page.withLayout (\_ -> Layouts.Navbar { user = user, activeName = "kpi" })


type alias Model =
    {}


type Msg
    = NoOp


init : () -> ( Model, Effect Msg )
init _ =
    ( {}, E.none )


update : Msg -> Model -> ( Model, Effect Msg )
update _ model =
    ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Model -> View Msg
view user _ =
    { title = "Адмін: KPI"
    , body =
        [ div [ class "box-border w-full min-w-0 p-echo-lg echo-md:p-echo-xl" ]
            (if Core.Auth.hasRole "Admin" user then
                [ node "admin-kpi" [ class "block w-full min-w-0" ] [] ]

             else
                [ text "KPI доступні лише адміністраторам." ]
            )
        ]
    }
