module Le.Delta exposing (contentBlockUploadImages)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)


contentBlockUploadImages : String -> (String -> msg) -> Html msg
contentBlockUploadImages cookies onCookieChanged =
    div []
        [ div
            [ class "mb-1"
            ]
            [ text "для взаємодії з дельтою, вставте значення, скопійоване з розширення "
            , a
                [ href "https://chrome.google.com/webstore/detail/copy-cookies/jcbpglbplpblnagieibnemmkiamekcdg"
                , target "_blank"
                ]
                [ text "copy cookies" ]
            ]
        , div [ class "form-floating mb-4" ] <|
            [ textarea
                [ class "form-control font-monospace cookie-txtarea"
                , placeholder "Вставте текст "
                , id <| "cookie-txtarea"
                , style "height" "140px"
                , onInput <| onCookieChanged
                , value cookies
                , spellcheck False
                , attribute "data-gramm" "false"
                , attribute "autocorrect" "false"
                , attribute "autocomplete" "false"
                , attribute "autocapitalize" "false"
                ]
                []
            , label [ for "cookie-txtarea" ] [ text "🍪" ]
            ]
        ]
