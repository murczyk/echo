module Pages.RerDeltaImport exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Select
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Layouts
import Le.Block.Spinner
import Le.ErrorHandling
import Le.Console
import Le.Types exposing (ApiError)
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
import Task
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
        , activeName = "rer-delta-import"
        }


type alias Model =
    { formErrors : Dict String String
    , consoleCSV : Le.Console.Model
    , consoleKMZ : Le.Console.Model
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , consoleCSV = Le.Console.init
      , consoleKMZ = Le.Console.init
      }
    , E.none
    )


type Msg
    = UploadCSVFileToConvert
    | UploadCSVFileToConvertSelected File
    | UploadCSVFileToConvertDone File (Result ApiError Int)
    | UploadKMZFileToConvert
    | UploadKMZFileToConvertSelected File
    | UploadKMZFileToConvertDone File (Result ApiError Int)
    | ConsoleMsgCSV (Le.Console.Msg Msg)
    | ConsoleMsgKMZ (Le.Console.Msg Msg)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadCSVFileToConvert ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadCSVFileToConvertSelected
            )

        UploadCSVFileToConvertSelected file ->
            let
                m2 =
                    model
            in
            ( m2
            , E.sendCmd <|
                Api.rer_delta_csv_import (UploadCSVFileToConvertDone file) file
            )

        UploadCSVFileToConvertDone _ (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "CSV Import Error" e )

        UploadCSVFileToConvertDone _ (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsgCSV (Le.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        UploadKMZFileToConvert ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadKMZFileToConvertSelected
            )

        UploadKMZFileToConvertSelected file ->
            let
                m2 =
                    model
            in
            ( m2
            , E.sendCmd <|
                Api.rer_delta_kmz_import (UploadKMZFileToConvertDone file) file
            )

        UploadKMZFileToConvertDone _ (Err e) ->
            ( model, Le.ErrorHandling.formatErrorForShowErrorWithDetails "KMZ Import Error" e )

        UploadKMZFileToConvertDone _ (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsgKMZ (Le.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsgCSV imsg ->
            Le.Console.update
                { msg = imsg
                , model = model.consoleCSV
                , toModel = \console -> { model | consoleCSV = console }
                , toMsg = ConsoleMsgCSV
                , finalizer = E.none
                }

        ConsoleMsgKMZ imsg ->
            Le.Console.update
                { msg = imsg
                , model = model.consoleKMZ
                , toModel = \console -> { model | consoleKMZ = console }
                , toMsg = ConsoleMsgKMZ
                , finalizer = E.none
                }


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


contentBlock : Model -> Html Msg
contentBlock model =
    div [class "mt-2"]
        [ h3 []
            [ text "Приймає CSV-файл експортований з Комінтіфай або Дельти, що містить виключно координати. Приклад вмісту файлу що приймається:" ]
        , pre []
            [ text """type,name,time,y,x,comment
10061500002001000000,"139.3351",2023-11-06T05:14:54,47.3605,36.05332,"НВ(Викликаючий) УКХ НВ 139.3375 (33_ombr_T01)"
""" ]
        , button
            [ class "btn btn-sm btn-outline-secondary me-2"
            , type_ "button"
            , onClick <| UploadCSVFileToConvert
            ]
            [ if not (Le.Console.isInProgress model.consoleCSV) then
                i [ class "bi bi-file-zip" ] []

              else
                Le.Block.Spinner.loadingSpinnerSm
            , text " додати csv"
            ]
        , button
            [ class "btn btn-sm btn-outline-secondary me-2"
            , type_ "button"
            , onClick <| UploadKMZFileToConvert
            ]
            [ if not (Le.Console.isInProgress model.consoleKMZ) then
                i [ class "bi bi-file-zip" ] []

              else
                Le.Block.Spinner.loadingSpinnerSm
            , text " додати kmz"
            ]
        , Le.Console.view model.consoleCSV
        , Le.Console.view model.consoleKMZ
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Імпорт Дельта/Комінтіфай CSV/KMZ"
    , body =
        [ div [ class "w-4/5 mx-auto bd-gutter" ]
            [ div [ class "row" ]
                [ div [ class "col-sm-12" ]
                    [ contentBlock model ]
                ]
            ]
        ]
    }
