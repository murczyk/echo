module Core.DeviceDetailsPage exposing (Model, Msg, init, update, view)

import Auth
import Core.Auth
import Dict
import Effect as E exposing (Effect)
import Html exposing (div, node, text)
import Html.Attributes exposing (attribute, class)
import Route exposing (Route)
import Route.Path
import Shared
import View exposing (View)


type alias Model =
    {}


type Msg
    = NoOp


init : Auth.User -> () -> ( Model, Effect Msg )
init user _ =
    if user.name == "anonymous" || Core.Auth.canReadDevices user then
        ( {}, E.none )

    else
        ( {}, E.replaceRoutePath Route.Path.Home_ )


update : Msg -> Model -> ( Model, Effect Msg )
update NoOp state =
    ( state, E.none )


view : String -> String -> Auth.User -> Shared.Model -> Route { id : String } -> View Msg
view section title user shared route =
    { title = title
    , body =
        [ div
            [ class
                ("app-shell-fill-height box-border min-h-0 py-4 w-full flex flex-col "
                    ++ (if section == "files" then
                            "pl-6"

                        else
                            "px-6"
                       )
                )
            ]
            [ case shared.systemSettings of
                Nothing ->
                    div [ class "p-6 text-sm text-[var(--color-text-muted)]" ]
                        [ text "Завантаження налаштувань…" ]

                Just settings ->
                    if not (Core.Auth.canReadDevices user) then
                        div [] []

                    else if not settings.devicesSectionEnabled then
                        div [] [ text "Пристрої вимкнені в налаштуваннях системи." ]

                    else
                        node "device-details-page"
                            ([ class "block w-full h-full"
                             , attribute "device-id" route.params.id
                             , attribute "page-section" section
                             , attribute "data-auth-user-roles" (String.join "," user.roles)
                             ]
                                ++ (Dict.get "sync_id" route.query |> Maybe.map (attribute "sync-id" >> List.singleton) |> Maybe.withDefault [])
                            )
                            []
            ]
        ]
    }
