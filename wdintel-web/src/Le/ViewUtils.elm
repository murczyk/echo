module Le.ViewUtils exposing (..)

import Bindings as B
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Le.Utils exposing (..)
import Maybe.Extra as MaybeX
import List.Extra as ListX
import Components.Tag as Tag

tagsBlock: Maybe (List Int) -> (Int -> msg) ->  List ( Int, B.Tag ) -> Html msg
tagsBlock tagIdsSet toggleTagMsg tags =
    let
        tagsShown =
            tags |> List.filter (\( _, x ) -> x.extra /= Just True)

        tagsExtra =
            tags |> List.filter (\( _, x ) -> x.extra == Just True)

        isSet tagId =
            tagIdsSet
                |> def []
                |> List.member tagId

        isExtraSet =
            tagsExtra
                |> List.map (Tuple.first >> isSet)
                |> ListX.find (\x -> x)
                |> MaybeX.isJust

        dropdownItem ( tagId, tag ) =
            let
                set =
                    isSet tagId
            in
            li []
                [ span
                    [ class "dropdown-item pointer"
                    , classList
                        [ ( "bg-tag-selected!", set )
                        , ( "hover-unmuted", not set )
                        ]
                    , onClick <| toggleTagMsg tagId
                    ]
                    [ String.uncons tag.label |> Maybe.map (\(head, tail) -> String.cons (Char.toUpper head) tail) |> Maybe.withDefault "" |> text  ]
                ]
    in
    div
        [ class "flex gap-1 justify-start text-xs flex-wrap dropup"
        ]
    <|
        List.map (\ (tagId_, tag_)-> Tag.new {isActive = isSet tagId_, onToggle = toggleTagMsg tagId_ } |> Tag.view tag_.label )tagsShown
            ++ (if List.length tagsExtra > 0 then
                    [ div
                        [ class "border-1 border-border rounded-sm pointer px-2 py-1"
                        , classList
                            [ ( "bg-tag-selected!", isExtraSet )
                            , ( "hover-unmuted bg-tag", not isExtraSet )
                            ]
                        , attribute "role" "button"
                        , attribute "data-bs-toggle" "dropdown"
                        , attribute "aria-expanded" "false"
                        ]
                        [ i [ class "bi bi-three-dots" ] [] ]
                    , ul
                        [ class "dropdown-menu pt-1 pb-1"
                        , style "border-radius" "none"
                        ]
                        (List.map dropdownItem tagsExtra)
                    ]

                else
                    []
               )
