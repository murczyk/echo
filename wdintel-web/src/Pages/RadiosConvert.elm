module Pages.RadiosConvert exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Shared.Components.Button as Button
import Shared.Components.Console
import Shared.Components.Spinner
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
import Process
import Route exposing (Route)
import Shared
import Shared.Model exposing (isDarkMode)
import Task
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
    , console : Shared.Components.Console.Model
    , file : Maybe File
    , taskId : Maybe Int
    , csvPage : Int
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , console = Shared.Components.Console.init
      , file = Nothing
      , taskId = Nothing
      , csvPage = 1
      }
    , E.none
    )


type Msg
    = UploadFileToConvert
    | UploadFileToConvertSelected File
    | UploadFileToConvertDone File (Result ApiError Int)
    | ConvertDonePerRadio File (Result ApiError Bytes)
    | ConvertDonePerDate File (Result ApiError Bytes)
    | ConvertDoneCsv Int File (Result ApiError Bytes)
    | ConsoleMsg (Shared.Components.Console.Msg Msg)


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
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "File Upload Error" e )

        UploadFileToConvertDone _ (Ok taskId) ->
            ( { model | taskId = Just taskId }
            , E.sendCmd <| Task.perform (always (ConsoleMsg (Shared.Components.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsg imsg ->
            Shared.Components.Console.update
                { msg = imsg
                , model = model.console
                , toModel = \console -> { model | console = console }
                , toMsg = ConsoleMsg
                , finalizer = finalizer model
                }

        ConvertDonePerRadio _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Download Error" e )

        ConvertDonePerRadio file (Ok bs) ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (String.replace ".kmz" "-radio.kmz" (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )

        ConvertDonePerDate _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Download Error" e )

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
subscriptions _ =
    Sub.none


contentBlock : Model -> Html Msg
contentBlock model =
    div []
        [ p []
            [ text "Приймає файли типу РАДІОСТАНЦІЇ_29.09-03.10.2023.kmz" ]
        , Button.new { label = " додати kmz", onClick = UploadFileToConvert }
            |> Button.withStyleSecondary
            |> Button.withIcon
                [ if not (Shared.Components.Console.isInProgress model.console) then
                    i [ class "bi bi-file-zip" ] []

                  else
                    Shared.Components.Spinner.loadingSpinnerSm
                ]
            |> Button.view
        , Shared.Components.Console.view model.console
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ _ _ model =
    { title = "Конвертер радіо kmz-файлу"
    , body =
        [ div [ class "w-4/5 mx-auto px-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ h1 [ class "py-4" ] [ text "Конвертер радіо kmz-файлу" ]
                    , div [ class "page-radios-convert" ] <|
                        [ div [ class "flex" ]
                            [ div [ class "w-full" ]
                                [ contentBlock model ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }
