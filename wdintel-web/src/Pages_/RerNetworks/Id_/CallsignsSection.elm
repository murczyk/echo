module Pages_.RerNetworks.Id_.CallsignsSection exposing
    ( ActivityCallsign
    , SectionConfig
    , hiddenCount
    , filterVisible
    , partitionVisible
    , sortVisible
    , view
    )

import Html exposing (Html, div, span, text)
import Html.Attributes exposing (class)
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
    , activeItems : List item
    , staleItems : List item
    , renderItem : item -> Html msg
    }


activeSince : Int -> Int
activeSince nowMillis =
    Utils.Time.xDaysAgo 14 (Time.millisToPosix nowMillis)
        |> Time.posixToMillis


isVisible : Int -> ActivityCallsign a -> Bool
isVisible nowMillis callsign =
    callsign.messageCount > 0
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


partitionVisible : Int -> List (ActivityCallsign a) -> ( List (ActivityCallsign a), List (ActivityCallsign a) )
partitionVisible nowMillis callsigns =
    List.partition (isVisible nowMillis) callsigns


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
    div [ class "p-3 bg-[var(--color-bg-muted)] rounded flex flex-col gap-3" ]
        [ div [ class "flex flex-wrap items-start justify-between gap-3" ]
            [ div [ class "min-w-0 flex flex-col" ]
                [ span [ class "font-medium" ] [ text (config.title ++ ":") ]
                ]
            , div [ class "flex flex-wrap items-center gap-2" ]
                (maybeSortButtonView config.maybeSortButton
                    ++ maybeToggleButtonView config
                )
            ]
        , viewItems config
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
        let
            staleCountText =
                if config.showStale then
                    ""

                else if List.isEmpty config.staleItems then
                    ""

                else
                    " (" ++ String.fromInt (List.length config.staleItems) ++ ")"
        in
        [ Button.new
            { label =
                if config.showStale then
                    config.toggleLabels.hide

                else
                    config.toggleLabels.show ++ staleCountText
            , onClick = config.onToggleStale
            }
            |> Button.withStyleSecondary
            |> Button.view
        ]

    else
        []


viewItems : SectionConfig msg item -> Html msg
viewItems config =
    if List.isEmpty config.activeItems && List.isEmpty config.staleItems then
        div [ class "text-[var(--color-text-muted)] text-sm mt-2" ]
            [ text config.emptyText ]

    else if not config.showStale && List.isEmpty config.activeItems then
        div [ class "text-[var(--color-text-muted)] text-sm mt-2" ]
            [ text config.emptyText ]

    else if config.showStale then
        div [ class "flex flex-col gap-4" ]
            (List.filterMap identity
                [ if List.isEmpty config.activeItems then
                    Nothing

                  else
                    Just (viewItemGroup "Активні" config.activeItems config.renderItem)
                , if List.isEmpty config.staleItems then
                    Nothing

                  else
                    Just (viewItemGroup "Застарілі" config.staleItems config.renderItem)
                ]
            )

    else
        viewItemGroup "" config.activeItems config.renderItem


viewItemGroup : String -> List item -> (item -> Html msg) -> Html msg
viewItemGroup label items renderItem =
    div [ class "flex flex-col gap-2" ]
        (if label == "" then
            [ div [ class "flex flex-wrap gap-[4px] text-[13px]" ]
                (List.map renderItem items)
            ]

         else
            [ span [ class "mt-1 mb-1 block text-[11px] uppercase tracking-[0.12em] opacity-70 leading-none" ]
                [ text label ]
            , div [ class "flex flex-wrap gap-[4px] text-[13px]" ]
                (List.map renderItem items)
            ]
        )
