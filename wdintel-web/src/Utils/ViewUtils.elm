module Utils.ViewUtils exposing (..)

import Bindings as B
import Dict
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
            case inboxTags of
                Just entries ->
                    List.any (\tag -> tag.tagId == tagId) entries

                Nothing ->
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
                |> List.foldl
                    (\tag acc ->
                        case tag.model of
                            Just modelName ->
                                let
                                    percent =
                                        tag.confidence
                                            |> clamp 0 1
                                            |> (*) 100
                                            |> round
                                in
                                Dict.update modelName
                                    (\existing ->
                                        Just <|
                                            Maybe.withDefault percent
                                                (Maybe.map (Basics.max percent) existing)
                                    )
                                    acc

                            Nothing ->
                                acc
                    )
                    Dict.empty
                |> Dict.toList
                |> List.map
                    (\( modelName, percent ) ->
                        modelName ++ " (впевненість " ++ String.fromInt percent ++ "%)"
                    )

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

                callout =
                    if List.isEmpty robots then
                        Nothing

                    else
                        Just <|
                            div
                                [ class "text-xs text-warning mt-1 leading-snug" ]
                                [ text "Знайшли помилку? Відмітьте та зніміть тег, та натисніть \"Бот помилився\"" ]
            in
            div [ class "space-y-1 max-w-[260px]" ]
                (sections
                    ++ (callout
                            |> Maybe.map List.singleton
                            |> Maybe.withDefault []
                       )
                )

        combinedBadge humans robots =
            let
                showHuman =
                    not (List.isEmpty humans)

                showRobot =
                    not (List.isEmpty robots)
            in
            if not (showHuman || showRobot) then
                Nothing

            else
                Just <|
                    div
                        [ class "bg-card text-text border border-border rounded-full px-2 py-[1px] flex items-center gap-2 shadow-sm" ]
                        (List.filterMap identity
                            [ if showRobot then
                                Just <|
                                    span [ class "flex items-center gap-1" ]
                                        [ i [ class "bi bi-robot text-[10px]" ] []
                                        , text <| String.fromInt <| List.length robots
                                        ]

                              else
                                Nothing
                            , if showHuman then
                                Just <|
                                    span [ class "flex items-center gap-1" ]
                                        [ i [ class "bi bi-person-fill text-[10px]" ] []
                                        , text <| String.fromInt <| List.length humans
                                        ]

                              else
                                Nothing
                            ]
                        )

        overlaysFor tagId =
            let
                humans =
                    humanLogins tagId

                robots =
                    botModels tagId
            in
            case combinedBadge humans robots of
                Nothing ->
                    []

                Just badge ->
                    [ node
                        "sl-tooltip"
                        [ attribute "hoist" "", attribute "placement" "top" ]
                        [ div
                            [ attribute "slot" "content"
                            , class "p-1"
                            ]
                            [ tooltipBody humans robots ]
                        , div
                            [ class "absolute -top-2 -right-1 flex items-center text-[10px]" ]
                            [ badge ]
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
