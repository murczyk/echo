module Pages.Admin.Ai.Ocr exposing (Model, Msg, page)

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
    Page.new { init = init, update = update, subscriptions = subscriptions, view = view }
        |> Page.withLayout (toLayout user)


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


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar { user = user, activeName = "ai-agent-ocr" }


view : Model -> View Msg
view _ =
    { title = "Адмін: OCR"
    , body =
        [ div [ class "box-border px-6 py-6 w-full" ]
            [ node "admin-ai-agent" [ attribute "data-section" "ocr", class "block w-full" ] [] ]
        ]
    }
