module Components.Tabs exposing (..)

import Html exposing (Html, button, div, h2, text)
import Html.Attributes exposing (class)
import Html.Events exposing (onClick)



-- Define a type alias for the model


type alias Model =
    { activeTab : Int }



-- Define a type for the tabs


type alias Tab msg =
    { title : String, content : Html msg }



-- Define the Tabs component


tabs : List (Tab msg) -> Model -> (Int -> msg) -> Html msg
tabs tabList model onTabClick =
    div []
        [ div [ class "flex space-x-4 border-b" ]
            (List.indexedMap
                (\index tab ->
                    button
                        [ class
                            (if index == model.activeTab then
                                "text-blue-500 border-b-2 border-blue-500"

                             else
                                "text-gray-500"
                            )
                        , onClick (onTabClick index)
                        ]
                        [ text tab.title ]
                )
                tabList
            )
        , div [ class "mt-4" ]
            [ case List.head (List.drop model.activeTab tabList) of
                Just tab ->
                    tab.content

                Nothing ->
                    text "No content available."
            ]
        ]
