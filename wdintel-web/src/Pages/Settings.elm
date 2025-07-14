module Pages.Settings exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Le.Block.Spinner
import Le.ErrorHandling
import Le.Types exposing (..)
import Maybe.Extra as MaybeX
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)
import Views


type alias Model =
    { formErrors : Dict String String
    , zones : List ( Int, B.SigintZone )
    , zoneId : Maybe Int
    , saveInProgress : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , zones = []
      , zoneId = Nothing
      , saveInProgress = False
      }
    , E.sendCmd <|
        Cmd.batch
            [ Api.sigint_zones_list GotZoneList
            , Api.api_user GotUser
            ]
    )


type Msg
    = LogOut
    | GotZoneList (Result ApiError (List ( Int, B.SigintZone )))
    | SelectZone String
    | Save
    | SaveDone (Result ApiError ())
    | GotUser (Result ApiError B.User)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "settings"
        }


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        LogOut ->
            ( model
            , E.logout
            )

        GotZoneList (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load Zones" e )

        GotZoneList (Ok vs) ->
            ( { model | zones = vs }, E.none )

        SelectZone str ->
            let
                m2 =
                    case String.toInt str of
                        Nothing ->
                            { model | zoneId = Nothing }

                        Just i ->
                            { model | zoneId = Just i }
            in
            ( m2, E.none )

        Save ->
            ( { model | saveInProgress = True }
            , E.sendCmd <|
                Api.settings_save SaveDone
                    { sigintZoneId = model.zoneId }
            )

        SaveDone (Err e) ->
            let
                m2 =
                    { model | saveInProgress = False }
            in
            ( m2, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Save Failed" e )

        SaveDone (Ok ()) ->
            let
                m2 =
                    { model | saveInProgress = False }
            in
            ( m2, E.none )

        GotUser (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "Failed to Load User" e )

        GotUser (Ok user) ->
            ( { model | zoneId = user.sigintZoneId }
            , E.none
            )


view : Shared.Model -> B.User -> Model -> View Msg
view shared user model =
    let
        labels =
            [ sup
                [ class "text-primary ms-2 fs-6 d-inline-block"
                , style "transform" "translateY(-10px)"
                ]
                [ i [ class "bi bi-signal" ] []
                , a
                    [ href "https://signal.me/#p/+380502711438"
                    , target "_blank"
                    ]
                    [ text " підтримка" ]
                ]
            , sup
                [ class "text-primary ms-2 fs-6 d-inline-block"
                , style "transform" "translateY(-10px)"
                ]
                [ span
                    [ class "text-action cursor-pointer"
                    , onClick LogOut
                    ]
                    [ text <| "вийти (" ++ user.name ++ ")" ]
                ]
            ]

        renderZone ( zoneId, zone ) =
            option
                (value (String.fromInt zoneId)
                    :: (if Just zoneId == model.zoneId then
                            [ selected True ]

                        else
                            []
                       )
                )
                [ text zone.name ]
    in
    { title = "налаштування"
    , body =
        [ div [ class "w-4/5 mx-auto bd-gutter mt-4" ]
            [ div [ class "row" ]
                [ div [ class "col-12 p-0" ]
                    [ h1 [ class "py-2" ] <|
                        text "налаштування"
                            :: labels
                    , div []
                        [ div [ class "d-flex justify-content-center align-items-center" ]
                            [ div
                                [ class "text-end me-2"
                                , style "width" "260px"
                                ]
                                [ text "РЕР-напрямок:" ]
                            , div
                                [ style "width" "600px"
                                , style "font-size" ".8rem"
                                ]
                                [ select
                                    [ class "form-select"
                                    , onInput SelectZone
                                    ]
                                  <|
                                    (if MaybeX.isNothing model.zoneId then
                                        [ option [ selected True ]
                                            [ text "Оберіть зону" ]
                                        ]

                                     else
                                        []
                                    )
                                        ++ List.map renderZone model.zones
                                ]
                            ]
                        , div [ class "d-flex justify-content-center align-items-center mt-4" ]
                            [ button
                                [ class "btn btn-primary btn-sm"
                                , onClick Save
                                ]
                              <|
                                (if model.saveInProgress then
                                    [ Le.Block.Spinner.loadingSpinner2Sm ]

                                 else
                                    [ i [ class "bi bi-save fade-in" ] [] ]
                                )
                                    ++ [ text " зберегти"
                                       ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }
