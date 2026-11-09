module Pages.Devices.Id_.Files exposing (Model, Msg, page)

import Auth
import Core.DeviceDetailsPage as DevicePage
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared


type alias Model =
    DevicePage.Model


type alias Msg =
    DevicePage.Msg


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user shared route =
    Page.new
        { init = DevicePage.init user
        , update = DevicePage.update
        , subscriptions = always Sub.none
        , view = always (DevicePage.view "files" "Файли пристрою" user shared route)
        }
        |> Page.withLayout (always (Layouts.Navbar { user = user, activeName = "devices" }))
