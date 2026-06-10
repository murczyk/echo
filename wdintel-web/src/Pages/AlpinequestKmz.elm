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
import Html.Events exposing (preventDefaultOn)
import Json.Decode as Decode
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
        , activeName = "alpinequest-kmz"
        }


type alias Model =
    { formErrors : Dict String String
    , kmz : ConversionModel
    , geotiff : ConversionModel
    }


type alias ConversionModel =
    { console : Shared.Components.Console.Model
    , file : Maybe File
    , taskId : Maybe Int
    , convertInProgress : Bool
    }


init : () -> ( Model, Effect Msg )
init _ =
    ( { formErrors = Dict.empty
      , kmz = initConversionModel
      , geotiff = initConversionModel
      }
    , E.none
    )


initConversionModel : ConversionModel
initConversionModel =
    { console = Shared.Components.Console.init
    , file = Nothing
    , taskId = Nothing
    , convertInProgress = False
    }


type Msg
    = UploadAlpinequestKmzFile
    | OpenDocsDodatki
    | UploadAlpinequestKmzFileSelected File
    | UploadAlpinequestKmzFileDone File (Result ApiError Int)
    | DownloadAlpinequestKmzResultDone File (Result ApiError Bytes)
    | KmzConsoleMsg (Shared.Components.Console.Msg Msg)
    | UploadAlpinequestGeotiffFile
    | UploadAlpinequestGeotiffFileSelected File
    | UploadAlpinequestGeotiffFileDone File (Result ApiError Int)
    | DownloadAlpinequestGeotiffResultDone File (Result ApiError Bytes)
    | GeotiffConsoleMsg (Shared.Components.Console.Msg Msg)


finalizer : (File -> Result ApiError Bytes -> Msg) -> ConversionModel -> Effect Msg
finalizer toMsg conversionModel =
    case ( conversionModel.file, conversionModel.taskId ) of
        ( Just file, Just taskId ) ->
            E.sendCmd <|
                Api.alpine_download_result (toMsg file)
                    { bgtaskId = taskId }

        _ ->
            E.none


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        OpenDocsDodatki ->
            ( model, E.loadExternalUrl "/docs/delta-geotiff/" )

        UploadAlpinequestKmzFile ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadAlpinequestKmzFileSelected
            )

        UploadAlpinequestKmzFileSelected file ->
            let
                kmz =
                    model.kmz
            in
            ( { model
                | kmz =
                    { kmz
                        | convertInProgress = True
                        , file = Just file
                    }
              }
            , E.sendCmd <|
                Api.alpine_convert (UploadAlpinequestKmzFileDone file) file "kmz"
            )

        UploadAlpinequestKmzFileDone _ (Err e) ->
            let
                kmz =
                    model.kmz
            in
            ( { model
                | kmz =
                    { kmz
                        | convertInProgress = False
                    }
              }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка конвертації AlpineQuest" e
            )

        UploadAlpinequestKmzFileDone _ (Ok taskId) ->
            let
                kmz =
                    model.kmz
            in
            ( { model
                | kmz =
                    { kmz
                        | convertInProgress = False
                        , taskId = Just taskId
                    }
              }
            , E.sendCmd <|
                Task.perform
                    (always (KmzConsoleMsg (Shared.Components.Console.TaskLaunched taskId)))
                    (Process.sleep 0)
            )

        DownloadAlpinequestKmzResultDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження результату" e )

        DownloadAlpinequestKmzResultDone file (Ok bs) ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (ensureKmzName (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )

        KmzConsoleMsg imsg ->
            let
                kmz =
                    model.kmz
            in
            Shared.Components.Console.update
                { msg = imsg
                , model = kmz.console
                , toModel = \console -> { model | kmz = { kmz | console = console } }
                , toMsg = KmzConsoleMsg
                , finalizer = finalizer DownloadAlpinequestKmzResultDone model.kmz
                }

        UploadAlpinequestGeotiffFile ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    UploadAlpinequestGeotiffFileSelected
            )

        UploadAlpinequestGeotiffFileSelected file ->
            let
                geotiff =
                    model.geotiff
            in
            ( { model
                | geotiff =
                    { geotiff
                        | convertInProgress = True
                        , file = Just file
                    }
              }
            , E.sendCmd <|
                Api.alpine_convert (UploadAlpinequestGeotiffFileDone file) file "cog"
            )

        UploadAlpinequestGeotiffFileDone _ (Err e) ->
            let
                geotiff =
                    model.geotiff
            in
            ( { model
                | geotiff =
                    { geotiff
                        | convertInProgress = False
                    }
              }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка конвертації AlpineQuest" e
            )

        UploadAlpinequestGeotiffFileDone _ (Ok taskId) ->
            let
                geotiff =
                    model.geotiff
            in
            ( { model
                | geotiff =
                    { geotiff
                        | convertInProgress = False
                        , taskId = Just taskId
                    }
              }
            , E.sendCmd <|
                Task.perform
                    (always (GeotiffConsoleMsg (Shared.Components.Console.TaskLaunched taskId)))
                    (Process.sleep 0)
            )

        DownloadAlpinequestGeotiffResultDone _ (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження результату" e )

        DownloadAlpinequestGeotiffResultDone file (Ok bs) ->
            ( model
            , E.sendCmd <|
                Download.bytes
                    (ensureTifName (File.name file))
                    "image/tiff"
                    bs
            )

        GeotiffConsoleMsg imsg ->
            let
                geotiff =
                    model.geotiff
            in
            Shared.Components.Console.update
                { msg = imsg
                , model = geotiff.console
                , toModel = \console -> { model | geotiff = { geotiff | console = console } }
                , toMsg = GeotiffConsoleMsg
                , finalizer = finalizer DownloadAlpinequestGeotiffResultDone model.geotiff
                }


ensureKmzName : String -> String
ensureKmzName name =
    if String.endsWith ".kmz" (String.toLower name) then
        name

    else
        name ++ ".kmz"


ensureTifName : String -> String
ensureTifName name =
    let
        lowerName =
            String.toLower name

        baseName =
            if String.endsWith ".tiff" lowerName then
                String.dropRight 5 name

            else if String.endsWith ".tif" lowerName || String.endsWith ".cog" lowerName then
                String.dropRight 4 name

            else
                name
    in
    baseName ++ ".tif"


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


conversionBlock :
    { heading : Maybe String
    , description : List (Html Msg)
    , conversionModel : ConversionModel
    , onUpload : Msg
    , showSupportedFormats : Bool
    , warning : Maybe String
    }
    -> Html Msg
conversionBlock config =
    let
        showSpinner =
            config.conversionModel.convertInProgress
                || Shared.Components.Console.isInProgress config.conversionModel.console

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
    div [ class "mb-8" ]
        [ case config.heading of
            Just heading ->
                h2 [ class "py-2" ] [ text heading ]

            Nothing ->
                text ""
        , p [ class "mb-3 text-sm text-[var(--color-subtle-text)]" ]
            config.description
        , if config.showSupportedFormats then
            let
                extensions =
                    [ ".ldk", ".trk", ".are", ".rte", ".wpt", ".set", ".kml", ".kmz", ".geojson", ".gpx" ]

                renderExtension ext =
                    code [ class "font-mono font-semibold" ] [ text ext ]
            in
            p [ class "mb-3 text-sm text-[var(--color-subtle-text)]" ]
                ((text "Конвертує файли у форматі ")
                    :: List.intersperse (text " ") (List.map renderExtension extensions)
                )

          else
            text ""
        , case config.warning of
            Just warning ->
                blockquote [ class "mb-3 text-sm text-yellow-600 border-l-4 border-yellow-600 pl-4" ]
                    [ p [] [ text warning ] ]

            Nothing ->
                text ""
        , Button.new { label = " додати файл", onClick = config.onUpload }
            |> Button.withIcon [ buttonIcon ]
            |> Button.view
        , Shared.Components.Console.view config.conversionModel.console
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ _ _ model =
    { title = "AlpineQuest в KMZ"
    , body =
        [ div [ class "w-4/5 mx-auto px-4" ]
            [ div [ class "flex" ]
                [ div [ class "w-full" ]
                    [ h1 [ class "py-4" ] [ text "AlpineQuest в KMZ" ]
                    , conversionBlock
                        { heading = Nothing
                        , description =
                            [ text "Конвертуйте AlpineQuest файли у формат KMZ, в дружній до Delta формі." ]
                        , conversionModel = model.kmz
                        , onUpload = UploadAlpinequestKmzFile
                        , showSupportedFormats = True
                        , warning = Just "ⓘ Формат .pgd наразі підтримується в експериментальному режимі"
                        }
                    , conversionBlock
                        { heading = Just ".pgd в .tif (cloud-optimised GeoTiff)"
                        , description =
                            [ text "Радимо конвертувати файли .pgd у формат .tif (Cloud-Optimized GeoTIFF, відповідає вимогам Delta до ортознімків), щоб використовувати їх як підкладку в шарах Delta. Інструкція з додавання ортофото в Delta: "
                            , a
                                [ href "/docs/delta-geotiff/"
                                , preventDefaultOn "click" (Decode.succeed ( OpenDocsDodatki, True ))
                                ]
                                [ text "/docs/delta-geotiff/" ]
                            ]
                        , conversionModel = model.geotiff
                        , onUpload = UploadAlpinequestGeotiffFile
                        , showSupportedFormats = False
                        , warning = Nothing
                        }
                    ]
                ]
            ]
        ]
    }
