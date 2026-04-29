module Pages_.RerNetworks.Id_.CallsignsSection exposing
    ( ActivityCallsign
    , SectionConfig
    , hiddenCount
    , filterVisible
    , sortVisible
    , view
    )

import Html exposing (Html, div, span, text)
import Html.Attributes exposing (class, style)
import Time
import Shared.Components.Button as Button
import Utils.Time


type alias ActivityCallsign a =
    { a | callsign : String, messageCount : Int, lastDatetime : Maybe Int }


type alias ToggleLabels =
    { show : String
    , hide : String
    }


type alias SortButton msg =
    { label : String
    , onClick : msg
    }


type alias SectionConfig msg item =
    { title : String
    , activeHint : String
    , staleHint : String
    , showStale : Bool
    , hiddenCount : Int
    , toggleLabels : ToggleLabels
    , onToggleStale : msg
    , maybeSortButton : Maybe (SortButton msg)
    , emptyText : String
    , items : List item
    , renderItem : item -> Html msg
    }


activeSince : Int -> Int
activeSince nowMillis =
    Utils.Time.xDaysAgo 14 (Time.millisToPosix nowMillis)
        |> Time.posixToMillis


isVisible : Int -> ActivityCallsign a -> Bool
isVisible nowMillis callsign =
    callsign.messageCount > 2
        && Maybe.withDefault False
            (Maybe.map (\lastDatetime -> lastDatetime >= activeSince nowMillis) callsign.lastDatetime)


filterVisible : Int -> Bool -> List (ActivityCallsign a) -> List (ActivityCallsign a)
filterVisible nowMillis showStale callsigns =
    if showStale then
        callsigns

    else
        List.filter (isVisible nowMillis) callsigns


hiddenCount : Int -> Bool -> List (ActivityCallsign a) -> Int
hiddenCount nowMillis showStale callsigns =
    List.length callsigns - List.length (filterVisible nowMillis showStale callsigns)


sortVisible : Bool -> List (ActivityCallsign a) -> List (ActivityCallsign a)
sortVisible sortByMessages callsigns =
    if sortByMessages then
        List.sortWith
            (\left right ->
                case compare right.messageCount left.messageCount of
                    EQ ->
                        compare (String.toUpper left.callsign) (String.toUpper right.callsign)

                    ordering ->
                        ordering
            )
            callsigns

    else
        List.sortBy (\callsign -> String.toUpper callsign.callsign) callsigns


view : SectionConfig msg item -> Html msg
view config =
    let
        hintText =
            if config.showStale then
                config.staleHint

            else
                config.activeHint
    in
    div [ class "p-3 bg-[var(--color-bg-muted)] rounded" ]
        [ div [ class "flex flex-wrap items-start justify-between gap-3" ]
            [ div [ class "min-w-0 flex flex-col gap-1" ]
                [ span [ class "font-medium" ] [ text (config.title ++ ":") ]
                , div [ class "opacity-75", style "color" "var(--color-text)" ]
                    [ text hintText ]
                ]
            , div [ class "flex flex-wrap items-center gap-2" ]
                (maybeSortButtonView config.maybeSortButton
                    ++ maybeToggleButtonView config
                )
            ]
        , if List.isEmpty config.items then
            div [ class "text-[var(--color-text-muted)] text-sm mt-2" ]
                [ text config.emptyText ]

          else
            div [ class "flex flex-wrap gap-[4px] text-[13px] mt-2" ]
                (List.map config.renderItem config.items)
        ]


maybeSortButtonView : Maybe (SortButton msg) -> List (Html msg)
maybeSortButtonView maybeSortButton =
    case maybeSortButton of
        Just sortButton ->
            [ Button.new
                { label = sortButton.label
                , onClick = sortButton.onClick
                }
                |> Button.withStyleSecondary
                |> Button.view
            ]

        Nothing ->
            []


maybeToggleButtonView : SectionConfig msg item -> List (Html msg)
maybeToggleButtonView config =
    if config.showStale || config.hiddenCount > 0 then
        [ Button.new
            { label =
                if config.showStale then
                    config.toggleLabels.hide

                else
                    config.toggleLabels.show
            , onClick = config.onToggleStale
            }
            |> Button.withStyleSecondary
            |> Button.view
        ]

    else
        []
