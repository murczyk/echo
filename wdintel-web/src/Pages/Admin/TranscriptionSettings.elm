module Pages.Admin.TranscriptionSettings exposing (Model, Msg, page)

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
        , activeName = "transcription-settings"
        }


type alias Model =
    {}


init : () -> ( Model, Effect Msg )
init () =
    ( {}, E.none )


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


view : Model -> View Msg
view _ =
    { title = "Адмін: Транскрибація"
    , body =
        [ div [ class "app-shell-fill-height box-border min-h-0 px-6 pt-6 pb-6 w-full flex flex-col overflow-visible lg:overflow-hidden" ]
            [ div [ class "flex-1 min-h-0 w-full" ]
                [ node "transcription-settings" [ class "react-fill-host block w-full h-full" ] [] ]
            ]
        ]
    }
