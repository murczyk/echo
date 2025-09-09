module Pages.RerDeltaImport exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Shared.Components.Button as Button
import Shared.Components.Console
import Shared.Components.Spinner
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
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
        , activeName = "rer-delta-import"
        }


type alias Model =
    { formErrors : Dict String String
    , consoleCSV : Shared.Components.Console.Model
    , consoleKMZ : Shared.Components.Console.Model
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , consoleCSV = Shared.Components.Console.init
      , consoleKMZ = Shared.Components.Console.init
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
    | ConsoleMsgCSV (Shared.Components.Console.Msg Msg)
    | ConsoleMsgKMZ (Shared.Components.Console.Msg Msg)


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
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "CSV Import Error" e )

        UploadCSVFileToConvertDone _ (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsgCSV (Shared.Components.Console.TaskLaunched taskId))) (Process.sleep 0)
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
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "KMZ Import Error" e )

        UploadKMZFileToConvertDone _ (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsgKMZ (Shared.Components.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsgCSV imsg ->
            Shared.Components.Console.update
                { msg = imsg
                , model = model.consoleCSV
                , toModel = \console -> { model | consoleCSV = console }
                , toMsg = ConsoleMsgCSV
                , finalizer = E.none
                }

        ConsoleMsgKMZ imsg ->
            Shared.Components.Console.update
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
    div [ class "space-y-6" ]
        [ div [ class "space-y-4" ]
            [ h2 [ class "text-2xl font-semibold text-gray-800" ]
                [ text "Імпорт файлів" ]
            , div [ class "space-y-2" ]
                [ p [ class "text-gray-600 leading-relaxed" ]
                    [ text "Приймає CSV-файл експортований з Комінтіфай або Дельти, що містить виключно координати." ]
                , p [ class "text-gray-600 leading-relaxed" ]
                    [ text "Приклад вмісту файлу що приймається:" ]
                ]
            ]
        , div [ class "bg-gray-50 border border-gray-200 rounded-lg p-4" ]
            [ pre [ class "text-sm text-gray-700 font-mono whitespace-pre-wrap" ]
                [ text """type,name,time,y,x,comment
10061500002001000000,"139.3351",2023-11-06T05:14:54,47.3605,36.05332,"НВ(Викликаючий) УКХ НВ 139.3375 (33_ombr_T01)"
""" ]
            ]
        , div [ class "flex flex-col sm:flex-row gap-4" ]
            [ Button.new { label = " додати csv", onClick = UploadCSVFileToConvert }
                |> Button.withStyleSecondary
                |> Button.withIcon
                    [ if not (Shared.Components.Console.isInProgress model.consoleCSV) then
                        i [ class "bi bi-file-earmark-text" ] []

                      else
                        Shared.Components.Spinner.loadingSpinnerSm
                    ]
                |> Button.view
            , Button.new { label = " додати kmz", onClick = UploadKMZFileToConvert }
                |> Button.withStyleSecondary
                |> Button.withIcon
                    [ if not (Shared.Components.Console.isInProgress model.consoleKMZ) then
                        i [ class "bi bi-geo-alt" ] []

                      else
                        Shared.Components.Spinner.loadingSpinnerSm
                    ]
                |> Button.view
            ]
        , div [ class "space-y-4" ]
            [ Shared.Components.Console.view model.consoleCSV
            , Shared.Components.Console.view model.consoleKMZ
            ]
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Імпорт Дельта/Комінтіфай CSV/KMZ"
    , body =
        [ div [ class "w-4/5 mx-auto px-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ contentBlock model ]
                ]
            ]
        ]
    }
