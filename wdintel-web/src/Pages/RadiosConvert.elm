module Pages.RadiosConvert exposing (Model, Msg, page)

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
        , activeName = "delta"
        }


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , console : Le.Console.Model
    , file : Maybe File
    , taskId : Maybe Int
    , csvPage : Int
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , toasts = Le.Block.Toast.init
      , console = Le.Console.init
      , file = Nothing
      , taskId = Nothing
      , csvPage = 1
      }
    , E.none
    )


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | UploadFileToConvert
    | UploadFileToConvertSelected File
    | UploadFileToConvertDone File (Result ApiError Int)
    | ConvertDonePerRadio File (Result ApiError Bytes)
    | ConvertDonePerDate File (Result ApiError Bytes)
    | ConvertDoneCsv Int File (Result ApiError Bytes)
    | ConsoleMsg (Le.Console.Msg Msg)


finalizer : Model -> Effect Msg
finalizer model =
    case ( model.file, model.taskId ) of
        ( Just file, Just taskId ) ->
            E.sendCmd <|
                Cmd.batch
                    [ Api.radios_download_result_per_radio (ConvertDonePerRadio file) { bgtaskId = taskId, csvPage = Nothing }
                    , Api.radios_download_result_per_date (ConvertDonePerDate file) { bgtaskId = taskId, csvPage = Nothing }
                    , Api.radios_download_result_csv (ConvertDoneCsv model.csvPage file) { bgtaskId = taskId, csvPage = Just model.csvPage }
                    ]

        _ ->
            E.none


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

        UploadFileToConvert ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadFileToConvertSelected
            )

        UploadFileToConvertSelected file ->
            let
                m2 =
                    { model | file = Just file }
            in
            ( m2
            , E.sendCmd <|
                Api.radios_convert (UploadFileToConvertDone file) file
            )

        UploadFileToConvertDone _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        UploadFileToConvertDone _ (Ok taskId) ->
            ( { model | taskId = Just taskId }
            , E.sendCmd <| Task.perform (always (ConsoleMsg (Le.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsg imsg ->
            Le.Console.update
                { msg = imsg
                , model = model.console
                , toModel = \console -> { model | console = console }
                , toMsg = ConsoleMsg
                , finalizer = finalizer model
                }

        ConvertDonePerRadio _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        ConvertDonePerRadio file (Ok bs) ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (String.replace ".kmz" "-radio.kmz" (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )

        ConvertDonePerDate _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        ConvertDonePerDate file (Ok bs) ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (String.replace ".kmz" "-date.kmz" (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )

        ConvertDoneCsv _ _ (Err _) ->
            ( model, E.none )

        -- Api.handleHttpError ToastMsg e model
        ConvertDoneCsv resPage file (Ok bs) ->
            let
                m2 =
                    { model | csvPage = model.csvPage + 1 }
            in
            ( m2
            , E.sendCmd <|
                Cmd.batch
                    [ Download.bytes
                        (String.replace ".kmz"
                            ("-page-" ++ String.fromInt resPage ++ ".csv")
                            (File.name file)
                        )
                        "text/csv"
                        bs
                    , case model.taskId of
                        Nothing ->
                            Cmd.none

                        Just taskId ->
                            Api.radios_download_result_csv (ConvertDoneCsv m2.csvPage file)
                                { bgtaskId = taskId, csvPage = Just m2.csvPage }
                    ]
            )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


contentBlock : Model -> Html Msg
contentBlock model =
    div []
        [ p []
            [ text "Приймає файли типу РАДІОСТАНЦІЇ_29.09-03.10.2023.kmz" ]
        , button
            [ class "btn btn-sm btn-outline-secondary me-2"
            , type_ "button"
            , onClick <| UploadFileToConvert
            ]
            [ if not (Le.Console.isInProgress model.console) then
                i [ class "bi bi-file-zip" ] []

              else
                Le.Block.Spinner.loadingSpinnerSm
            , text " додати kmz"
            ]
        , Le.Console.view model.console
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Конвертер радіо kmz-файлу"
    , body =
        [ Views.headerAndContent "Конвертер радіо kmz-файлу" ToastMsg model.toasts <|
            div [ class "page-radios-convert" ] <|
                [ div [ class "row" ]
                    [ div [ class "col-sm-12" ]
                        [ contentBlock model ]
                    ]
                ]
        ]
    }
