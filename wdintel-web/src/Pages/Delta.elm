module Pages.Delta exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Shared.Components.Button as Button
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Download as Download
import File.Select
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Model exposing (isDarkMode)
import Utils.Api.ErrorHandling
import Utils.Views
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
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
            ( { model | convertKmzInProgress = False }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "File Upload Error" e )

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
                [ Button.new { label = " додати kmz", onClick = UploadKmzToGeojson }
                    |> Button.withIcon
                        [ if not model.convertKmzInProgress then
                            i [ class "bi bi-file-zip" ] []

                          else
                            div
                                [ class "inline-block w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin"
                                , attribute "role" "status"
                                ]
                                [ span [ class "sr-only" ] [ text "Loading..." ] ]
                        ]
                    |> Button.view
                ]
    in
    div [ class "page-delta" ] <|
        [ div [ class "flex" ]
            [ div [ class "w-full" ]
                [ contentBlockKmz2Geojson ]
            ]
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "дельта"
    , body =
        [ div [ class "w-4/5 mx-auto px-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ h1 [ class "py-4" ] [ text "kmz в geojson" ]
                    , pageBlock model
                    ]
                ]
            ]
        ]
    }
