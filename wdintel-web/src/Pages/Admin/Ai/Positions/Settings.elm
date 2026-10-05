module Pages.Admin.Ai.Positions.Settings exposing (Model, Msg, page)

import Auth
import Page exposing (Page)
import Pages.Admin.Ai.Positions as Positions
import Route exposing (Route)
import Shared


type alias Model =
    Positions.Model


type alias Msg =
    Positions.Msg


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user _ _ =
    Page.new (Positions.config "settings")
        |> Page.withLayout (Positions.toLayout user)
