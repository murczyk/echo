module Pages.GoiSettings exposing (Model, Msg, page)

import Auth
import Effect as E exposing (Effect)
import Html exposing (div, node)
import Html.Attributes exposing (attribute, class)
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
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "goi-settings"
        }


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init () =
    ( {}
    , E.none
    )


type Msg
    = NoOp


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
    { title = "ГОІ: налаштування"
    , body =
        [ div [ class "box-border px-6 pt-6 pb-6 w-full flex flex-col" ]
            [ div [ class "w-full" ]
                [ node "goi-settings"
                    [ attribute "data-goi-host" (Maybe.withDefault "" user.goiHost)
                    , class "react-fill-host block w-full"
                    ]
                    []
                ]
            ]
        ]
    }
