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
import Le.Block.Toast
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
    , toasts : Le.Block.Toast.Model
    , consoleCSV : Le.Console.Model
    , consoleKMZ : Le.Console.Model
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , consoleCSV = Le.Console.init
      , consoleKMZ = Le.Console.init
      }
    , E.none
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | UploadCSVFileToConvert
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
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

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
            Api.handleHttpError ToastMsg e model

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
            Api.handleHttpError ToastMsg e model

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
    div []
        [ p []
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
        [ Views.headerAndContent "Імпорт Дельта/Комінтіфай CSV/KMZ" ToastMsg model.toasts <|
            div [ class "page-rer-delta-import-csv" ] <|
                [ div [ class "row" ]
                    [ div [ class "col-sm-12" ]
                        [ contentBlock model ]
                    ]
                ]
        ]
    }
