module Pages.DeltaFixkmz exposing (Model, Msg, page)

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
    , hideTitles : Bool
    , fixKmzInProgress : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , hideTitles = False
      , fixKmzInProgress = False
      }
    , E.none
    )


type Msg
    = ToggleHideTitles
    | UploadKmzToFix
    | UploadKmzToFixSelected File
    | UploadKmzToFixDone File (Result ApiError Bytes)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadKmzToFix ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    [ "application/vnd.google-earth.kmz" ]
                    UploadKmzToFixSelected
            )

        UploadKmzToFixSelected file ->
            ( { model | fixKmzInProgress = True }
            , E.sendCmd <| Api.kmz_to_fix (UploadKmzToFixDone file) file model.hideTitles
            )

        UploadKmzToFixDone _ (Err e) ->
            ( { model | fixKmzInProgress = False }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "File Upload Error" e )

        UploadKmzToFixDone file (Ok bs) ->
            ( { model | fixKmzInProgress = False }
            , E.sendCmd <|
                Download.bytes
                    (String.replace ".kmz" "-fixed.kmz" (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )

        ToggleHideTitles ->
            ( { model | hideTitles = not model.hideTitles }
            , E.sendCmd <| Cmd.none
            )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


contentBlockFixKmz : Model -> Html Msg
contentBlockFixKmz model =
    div []
        [ div [ class "form-check mb-4" ]
            [ input
                [ class "form-check-input"
                , type_ "checkbox"
                , checked model.hideTitles
                , id "checkbox-kmz-hide-labels"
                , onClick <| ToggleHideTitles
                ]
                []
            , label
                [ class "form-check-label"
                , for "checkbox-kmz-hide-labels"
                ]
                [ text "Сховати написи (малювати лише при наведенні курсору)"
                ]
            ]
        , button
            [ class "btn btn-sm btn-outline-secondary me-2"
            , type_ "button"
            , onClick <| UploadKmzToFix
            ]
            [ if not model.fixKmzInProgress then
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


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ _ _ model =
    { title = "очисник kmz"
    , body =
        [ div [ class "w-4/5 mx-auto bd-gutter" ]
            [ div [ class "row" ]
                [ div [ class "col-12" ]
                    [ h1 [ class "py-4" ] [ text "очисник kmz" ]
                    , div [ class "page-delta-fixkmz" ] <|
                        [ div [ class "row" ]
                            [ div [ class "col-sm-12" ]
                                [ contentBlockFixKmz model ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }
