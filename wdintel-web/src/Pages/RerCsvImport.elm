module Pages.RerCsvImport exposing (..)
import Html exposing (text)
import View exposing (View)
import Auth
import Shared
import Route exposing (Route)
import Page exposing (Page)
import Effect exposing (Effect)

type alias Model = ()
type alias Msg = ()

page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = \_ -> ( (), Effect.none )
        , update = \_ m -> ( m, Effect.none )
        , view = \_ -> { title = "Moved", body = [ text "This page moved to /admin/rer-csv-import" ] }
        , subscriptions = \_ -> Sub.none
        }
