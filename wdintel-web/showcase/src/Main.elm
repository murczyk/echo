module Main exposing (main)

import Chapters.Button
import ElmBook exposing (..)


main : Book ()
main =
    book "Elm-UI"
        |> withChapters
            [ Chapters.Button.firstChapter
            ]
