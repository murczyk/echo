module Utils.ViewUtils exposing (..)

import Bindings as B
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import List.Extra as ListX
import Maybe.Extra as MaybeX
import Shared.Components.Tag as Tag
import String
import Utils.Utils exposing (..)


tagsBlock :
    Maybe (List Int)
    -> Maybe (List B.InboxMessageTag)
    -> (Int -> msg)
    -> List ( Int, B.Tag )
    -> Html msg
tagsBlock tagIdsSet inboxTags toggleTagMsg tags =
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

        tagInboxContribs tagId =
            if not (isSet tagId) then
                []

            else
                inboxTags
                    |> Maybe.withDefault []
                    |> List.filter (\tag -> tag.tagId == tagId)

        humanLogins tagId =
            tagInboxContribs tagId
                |> List.filter (\tag -> MaybeX.isNothing tag.model)
                |> List.filterMap .login
                |> ListX.unique

        botModels tagId =
            tagInboxContribs tagId
                |> List.filter (\tag -> MaybeX.isJust tag.model)
                |> List.filterMap .model
                |> ListX.unique

        tooltipSection label entries =
            div [ class "flex gap-1 text-xs items-start" ]
                [ span [ class "font-semibold whitespace-nowrap" ] [ text label ]
                , span [ class "flex-1" ] [ text <| String.join ", " entries ]
                ]

        tooltipBody humans robots =
            let
                sections =
                    List.filterMap identity
                        [ if List.isEmpty humans then
                            Nothing

                          else
                            Just <| tooltipSection "Користувачі:" humans
                        , if List.isEmpty robots then
                            Nothing

                          else
                            Just <| tooltipSection "Боти:" robots
                        ]
            in
            div [ class "space-y-1 max-w-[260px]" ] sections

        viewCountBadge iconClass entries =
            if List.isEmpty entries then
                Nothing

            else
                Just <|
                    div
                        [ class "bg-card text-text border border-border rounded-full px-1 py-[1px] flex items-center gap-1 shadow-sm" ]
                        [ i [ class (iconClass ++ " text-[10px]") ] []
                        , text <| String.fromInt <| List.length entries
                        ]

        overlaysFor tagId =
            let
                humans =
                    humanLogins tagId

                robots =
                    botModels tagId

                badges =
                    List.filterMap identity
                        [ viewCountBadge "bi bi-person-fill" humans
                        , viewCountBadge "bi bi-robot" robots
                        ]
            in
            if List.isEmpty badges then
                []

            else
                [ node
                    "sl-tooltip"
                    [ attribute "hoist" "", attribute "placement" "top" ]
                    [ div
                        [ attribute "slot" "content"
                        , class "p-1"
                        ]
                        [ tooltipBody humans robots ]
                    , div
                        [ class "absolute -top-1 -right-1 flex gap-1 items-center text-[10px]" ]
                        badges
                    ]
                ]

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
                    [ String.uncons tag.label |> Maybe.map (\( head, tail ) -> String.cons (Char.toUpper head) tail) |> Maybe.withDefault "" |> text ]
                ]
    in
    div
        [ class "flex gap-1 justify-start text-xs flex-wrap dropup"
        ]
    <|
        List.map
            (\( tagId_, tag_ ) ->
                Tag.new { isActive = isSet tagId_, onToggle = toggleTagMsg tagId_ }
                    |> Tag.withOverlays (overlaysFor tagId_)
                    |> Tag.view tag_.label
            )
            tagsShown
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
