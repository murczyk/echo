module Pages.RerPalitra exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (Html, div, text)
import Layouts
import Page exposing (Page)
import Platform.Sub as Sub
import Route exposing (Route)
import Shared
import Utils.RemoteData as RD exposing (RemoteData(..))
import View exposing (View)


type alias Model =
    { palitras : RemoteData ApiError (List B.Palitra)
    }


type Msg
    = NoOp
    | PalitraListResp (Result ApiError (List B.Palitra))


init : () -> ( Model, Effect Msg )
init _ =
    ( { palitras = Loading }
    , E.sendCmd <| Api.palitra_list PalitraListResp
    )


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        PalitraListResp (Ok list) ->
            ( { model | palitras = Success list }, E.none )

        PalitraListResp (Err err) ->
            ( { model | palitras = Failure err }, E.none )


view : Auth.User -> Shared.Model -> Model -> View Msg
view _ _ model =
    { title = "палітри"
    , body =
        [ case model.palitras of
            Loading ->
                div [] [ text "Завантаження..." ]

            Failure _ ->
                div [] [ text "Не вдалося завантажити палітри" ]

            Success pal ->
                div [] [ text <| "Доступні палітри: " ++ String.fromInt (List.length pal) ]

            NeedsReload _ ->
                text ""

            NotAsked ->
                text ""
        ]
    }


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view user shared
        , subscriptions = \_ -> Sub.none
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "etalonka"
        }
