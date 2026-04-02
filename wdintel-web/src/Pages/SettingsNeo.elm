module Pages.SettingsNeo exposing (Model, Msg, page)

import Auth
import Dict
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


init : () -> ( Model, Effect Msg )
init _ =
    ( {}
    , E.none
    )


type Msg
    = NoOp


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared route =
    Page.new
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view route shared
        }
        |> Page.withLayout (toLayout user route)


settingsSection : Route () -> String
settingsSection route =
    route.query
        |> Dict.get "section"
        |> Maybe.withDefault "general"


toLayout : Auth.User -> Route () -> Model -> Layouts.Layout Msg
toLayout user route _ =
    Layouts.Navbar
        { user = user
        , activeName =
            case settingsSection route of
                "duty" ->
                    "settings-neo-duty"

                "analysis" ->
                    "settings-neo-analysis"

                _ ->
                    "settings-neo"
        }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Route () -> Shared.Model -> Model -> View Msg
view route _ _ =
    { title = "Налаштування"
    , body =
        [ div [ class "box-border px-6 pt-6 pb-6 w-full flex flex-col" ]
            [ div [ class "w-full" ]
                [ node "settings-neo" [ attribute "data-settings-section" (settingsSection route), class "react-fill-host block w-full" ] [] ]
            ]
        ]
    }
