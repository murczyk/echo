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
import Html.Events exposing (..)
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Shared
import Shared.Components.Button as Button
import Shared.Model exposing (isDarkMode)
import String
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
    = UploadAlpinequestFile
    | UploadAlpinequestFileSelected File
    | UploadAlpinequestFileDone File (Result ApiError Bytes)


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        UploadAlpinequestFile ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    [ "application/zip", "application/octet-stream", "application/vnd.google-earth.kmz" ]
                    UploadAlpinequestFileSelected
            )

        UploadAlpinequestFileSelected file ->
            ( { model | convertInProgress = True }
            , E.sendCmd <| Api.alpine_convert (UploadAlpinequestFileDone file) file
            )

        UploadAlpinequestFileDone _ (Err e) ->
            ( { model | convertInProgress = False }, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка конвертації AlpineQuest" e )

        UploadAlpinequestFileDone file (Ok bs) ->
            ( { model | convertInProgress = False }
            , E.sendCmd <|
                Download.bytes
                    (ensureKmzName (File.name file))
                    "application/vnd.google-earth.kmz"
                    bs
            )


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
        buttonIcon =
            if not model.convertInProgress then
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
            [ text "Конвертуйте експортовані файли AlpineQuest у KMZ для подальшої роботи." ]
        , Button.new { label = " додати файл", onClick = UploadAlpinequestFile }
            |> Button.withIcon [ buttonIcon ]
            |> Button.view
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
