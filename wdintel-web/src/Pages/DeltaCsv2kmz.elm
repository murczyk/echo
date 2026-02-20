module Pages.DeltaCsv2kmz exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
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
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "delta"
        }


type alias Model =
    { formErrors : Dict String String
    , convertInProgress : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , convertInProgress = False
      }
    , E.none
    )


type Msg
    = UploadCsvToConvert
    | UploadCsvToConvertSelected File
    | UploadCsvToConvertDone File (Result ApiError Bytes)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadCsvToConvert ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    [ "text/csv" ]
                    UploadCsvToConvertSelected
            )

        UploadCsvToConvertSelected file ->
            ( { model | convertInProgress = True }
            , E.sendCmd <| Api.delta_csv_to_kmz (UploadCsvToConvertDone file) file
            )

        UploadCsvToConvertDone _ (Err e) ->
            ( { model | convertInProgress = False }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "File Upload Error" e )

        UploadCsvToConvertDone file (Ok bs) ->
            ( { model | convertInProgress = False }
            , E.sendCmd <|
                Download.bytes
                    (String.replace ".csv" ".kmz" (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


contentBlock : Model -> Html Msg
contentBlock model =
    div []
        [ p [] [ text "УВАГА! Приймається лише csv в форматі, який віддає Дельта. Інші формати не підтримуються." ]
        , button
            [ class "btn btn-sm btn-outline-secondary me-2"
            , type_ "button"
            , onClick <| UploadCsvToConvert
            ]
            [ if not model.convertInProgress then
                i [ class "bi bi-file-zip" ] []

              else
                div
                    [ class "spinner-border spinner-border-sm"
                    , attribute "role" "status"
                    ]
                    [ span [ class "visually-hidden" ] [ text "Loading..." ] ]
            , text " додати csv"
            ]
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ _ _ model =
    { title = "csv в kmz"
    , body =
        [ div [ class "w-4/5 mx-auto bd-gutter" ]
            [ div [ class "row" ]
                [ div [ class "col-12" ]
                    [ h1 [ class "py-4" ] [ text "csv в kmz" ]
                    , div [ class "page-csv2kmz" ] <|
                        [ div [ class "row" ]
                            [ div [ class "col-sm-12" ]
                                [ contentBlock model ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }
