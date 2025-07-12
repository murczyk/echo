module Pages.Delta exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Download as Download
import File.Select
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Le.ErrorHandling
import Le.Types exposing (ApiError)
import Page exposing (Page)
import Route exposing (Route)
import Shared
import View exposing (View)
import Views


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared.isDarkMode shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "delta"
        }



-- INIT


type alias Model =
    { formErrors : Dict String String
    , convertKmzInProgress : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , convertKmzInProgress = False
      }
    , E.none
    )



-- UPDATE


type Msg
    = UploadKmzToGeojson
    | UploadKmzToGeojsonSelected File
    | UploadKmzToGeojsonDone File (Result ApiError Bytes)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadKmzToGeojson ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    [ "application/vnd.google-earth.kmz" ]
                    UploadKmzToGeojsonSelected
            )

        UploadKmzToGeojsonSelected file ->
            ( { model | convertKmzInProgress = True }
            , E.sendCmd <| Api.delta_kmz_to_geojson (UploadKmzToGeojsonDone file) file
            )

        UploadKmzToGeojsonDone _ (Err e) ->
            ( { model | convertKmzInProgress = False }, Le.ErrorHandling.formatErrorForShowErrorWithDetails "File Upload Error" e )

        UploadKmzToGeojsonDone file (Ok bs) ->
            ( { model | convertKmzInProgress = False }
            , E.sendCmd <|
                Download.bytes
                    (String.replace ".kmz" ".geojson" (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


pageBlock : Model -> Html Msg
pageBlock model =
    let
        contentBlockKmz2Geojson =
            div []
                [ button
                    [ class "btn btn-sm btn-outline-secondary me-2"
                    , type_ "button"
                    , onClick <| UploadKmzToGeojson
                    ]
                    [ if not model.convertKmzInProgress then
                        i [ class "bi bi-file-zip" ] []

                      else
                        div
                            [ class "spinner-border spinner-border-sm"
                            , attribute "role" "status"
                            ]
                            [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
                    , text " додати kmz"
                    ]
                ]
    in
    div [ class "page-delta" ] <|
        [ div [ class "row" ]
            [ div [ class "col-sm-12" ]
                [ contentBlockKmz2Geojson ]
            ]
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "дельта"
    , body =
        [ div [ class "w-4/5 mx-auto bd-gutter" ]
            [ div [ class "row" ]
                [ div [ class "col-12" ]
                    [ h1 [ class "py-4" ] [ text "kmz в geojson" ]
                    , pageBlock model
                    ]
                ]
            ]
        ]
    }
