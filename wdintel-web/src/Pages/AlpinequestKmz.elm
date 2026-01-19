module Pages.AlpinequestKmz exposing (Model, Msg, page)

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
import Layouts
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
import Shared.Components.Button as Button
import Shared.Components.Console
import Shared.Model exposing (isDarkMode)
import String
import Task
import Utils.Api.ErrorHandling
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
        , activeName = "alpinequest-kmz"
        }


type alias Model =
    { formErrors : Dict String String
    , console : Shared.Components.Console.Model
    , file : Maybe File
    , taskId : Maybe Int
    , convertInProgress : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , console = Shared.Components.Console.init
      , file = Nothing
      , taskId = Nothing
      , convertInProgress = False
      }
    , E.none
    )


type Msg
    = UploadAlpinequestFile
    | UploadAlpinequestFileSelected File
    | UploadAlpinequestFileDone File (Result ApiError Int)
    | DownloadAlpinequestResultDone File (Result ApiError Bytes)
    | ConsoleMsg (Shared.Components.Console.Msg Msg)


finalizer : Model -> Effect Msg
finalizer model =
    case ( model.file, model.taskId ) of
        ( Just file, Just taskId ) ->
            E.sendCmd <|
                Api.alpine_download_result (DownloadAlpinequestResultDone file)
                    { bgtaskId = taskId }

        _ ->
            E.none


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadAlpinequestFile ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadAlpinequestFileSelected
            )

        UploadAlpinequestFileSelected file ->
            ( { model
                | convertInProgress = True
                , file = Just file
              }
            , E.sendCmd <| Api.alpine_convert (UploadAlpinequestFileDone file) file
            )

        UploadAlpinequestFileDone _ (Err e) ->
            ( { model | convertInProgress = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка конвертації AlpineQuest" e
            )

        UploadAlpinequestFileDone _ (Ok taskId) ->
            ( { model | convertInProgress = False, taskId = Just taskId }
            , E.sendCmd <|
                Task.perform
                    (always (ConsoleMsg (Shared.Components.Console.TaskLaunched taskId)))
                    (Process.sleep 0)
            )

        DownloadAlpinequestResultDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження результату" e )

        DownloadAlpinequestResultDone file (Ok bs) ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (ensureKmzName (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )

        ConsoleMsg imsg ->
            Shared.Components.Console.update
                { msg = imsg
                , model = model.console
                , toModel = \console -> { model | console = console }
                , toMsg = ConsoleMsg
                , finalizer = finalizer model
                }


ensureKmzName : String -> String
ensureKmzName name =
    if String.endsWith ".kmz" (String.toLower name) then
        name

    else
        name ++ ".kmz"


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none


pageBlock : Model -> Html Msg
pageBlock model =
    let
        showSpinner =
            model.convertInProgress
                || Shared.Components.Console.isInProgress model.console

        buttonIcon =
            if not showSpinner then
                i [ class "bi bi-file-earmark-arrow-up" ] []

            else
                div
                    [ class "inline-block w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin"
                    , attribute "role" "status"
                    ]
                    [ span [ class "sr-only" ] [ text "Loading..." ] ]
    in
    div []
        [ p [ class "mb-3 text-sm text-[var(--color-subtle-text)]" ]
            [ text "Конвертуйте AlpineQuest файли у формат .kmz, в дружній до Delta формі." ]
        , let
              extensions =
                  [ ".ldk", ".trk", ".are", ".rte", ".wpt", ".set", ".kml", ".kmz", ".geojson", ".gpx" ]

              renderExtension ext =
                  code [ class "font-mono font-semibold" ] [ text ext ]
          in
          p [ class "mb-3 text-sm text-[var(--color-subtle-text)]" ]
              ([ text "Конвертує файли у форматі " ]
                  ++ List.intersperse (text " ") (List.map renderExtension extensions)
              )
        , Button.new { label = " додати файл", onClick = UploadAlpinequestFile }
            |> Button.withIcon [ buttonIcon ]
            |> Button.view
        , Shared.Components.Console.view model.console
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "alpinequest в kmz"
    , body =
        [ div [ class "w-4/5 mx-auto px-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ h1 [ class "py-4" ] [ text "alpinequest в kmz" ]
                    , pageBlock model
                    ]
                ]
            ]
        ]
    }
