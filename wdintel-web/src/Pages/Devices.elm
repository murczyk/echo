module Pages.Devices exposing (Model, Msg, page)

import Auth
import Core.Auth
import Effect as E exposing (Effect)
import Html exposing (div, node, text)
import Html.Attributes exposing (attribute, class)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Shared
import String
import View exposing (View)


type alias Model =
    {}




init : Auth.User -> () -> ( Model, Effect Msg )
init user _ =
    if user.name == "anonymous" || Core.Auth.canReadDevices user then
        ( {}, E.none )

    else
        ( {}, E.replaceRoutePath Route.Path.Home_ )


type Msg
    = NoOp


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init user
        , update = update
        , subscriptions = subscriptions
        , view = view user shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "devices"
        }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared _ =
    { title = "Пристрої"
    , body =
        [ devicesBody user shared ]
    }


devicesBody : Auth.User -> Shared.Model -> Html.Html Msg
devicesBody user shared =
    div [ class "app-shell-fill-height box-border min-h-0 px-6 w-full flex flex-col gap-6 overflow-visible lg:overflow-hidden" ]
        [ case shared.systemSettings of
            Nothing ->
                div [ class "p-6 text-sm text-[var(--color-text-muted)]" ]
                    [ text "Завантаження налаштувань…" ]

            Just settings ->
                if not (Core.Auth.canReadDevices user) then
                    div [] []

                else if not settings.devicesSectionEnabled then
                    div [ class "p-6 text-sm text-[var(--color-text-muted)]" ]
                        [ text "Пристрої вимкнені в налаштуваннях системи." ]

                else
                    div [ class "flex-1 min-h-0 w-full" ]
                        [ node "devices-page"
                            [ attribute "data-auth-user-roles" (String.join "," user.roles)
                            , class "block w-full h-full"
                            ]
                            []
                        ]
        ]
