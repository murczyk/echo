module Pages_.RerAnalysis.Filters exposing (view)

import Bindings as B
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled
import Json.Decode
import List.Extra as ListX
import Maybe.Extra as MaybeX
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Pages_.RerAnalysis.Query
import Select
import Set
import Shared.Components.Checkbox
import Shared.Components.RerMessage
import Shared.Components.Spinner
import Shared.Components.Tag as Tag
import Shared.Components.Tooltip as Tooltip
import String exposing (fromInt)
import Time
import Utils.RemoteData as RD
import Utils.Select
import Utils.Time
import Utils.Utils exposing (..)


isSavedFilterSelected : B.SavedFilter -> Model -> Bool
isSavedFilterSelected filter model =
    let
        req1 =
            filter.req

        req2 =
            Pages_.RerAnalysis.Query.analysisStatsParams
                (Time.millisToPosix req1.sinceDateInclusiveMs)
                (Time.millisToPosix req1.tillDateNoninclusiveMs)
                model
    in
    req1 == req2


filterMenuBlockCountOutOf : { unfold : Bool, toggleMsg : msg, label : String, mCountLabel : Maybe String, overallLabel : String, withGreenCircle : Bool } -> Html msg -> Html msg
filterMenuBlockCountOutOf config content =
    div [ class "bg-[var(--color-card)] border border-[var(--color-border)] rounded mb-2 shadow-sm hover:shadow transition-shadow duration-150" ]
        [ div
            [ class "flex items-center px-3 py-2 cursor-pointer hover:bg-[var(--color-bg-muted)] transition-colors duration-150"
            , onClick config.toggleMsg
            ]
            [ div [ class "flex items-center gap-2 flex-grow" ]
                [ span [ classList [ ( "font-medium text-[var(--color-text)] text-sm", config.unfold ), ( "font-normal text-[var(--color-text)] text-sm", not config.unfold ) ] ] [ text config.label ]
                , if config.withGreenCircle then
                    div [ class "w-1.5 h-1.5 bg-[var(--color-success)] rounded-full" ] []

                  else
                    text ""
                ]
            , div [ class "flex items-center gap-2" ]
                [ span
                    [ class "text-xs font-medium"
                    , classList
                        [ ( "text-[var(--color-text-muted)]", MaybeX.isNothing config.mCountLabel )
                        , ( "text-[var(--color-secondary)]", MaybeX.isJust config.mCountLabel )
                        ]
                    ]
                  <|
                    (case config.mCountLabel of
                        Nothing ->
                            []

                        Just countLabel ->
                            [ text countLabel
                            , text " з "
                            ]
                    )
                        ++ [ text config.overallLabel ]
                ]
            , i
                [ class "bi text-xs transition-transform duration-150 ml-2"
                , classList [ ( "text-[var(--color-secondary)]", MaybeX.isJust config.mCountLabel ), ( "text-[var(--color-text)]", MaybeX.isNothing config.mCountLabel ) ]
                , classList [ ( "bi-chevron-up", config.unfold ) ]
                , classList [ ( "bi-chevron-down", not config.unfold ) ]
                ]
                []
            ]
        , HtmlX.viewIf config.unfold content
        ]


view : Bool -> B.User -> Model -> Html Msg
view isDark user model =
    let
        renderSavedFilter ( filterId, filter ) =
            let
                isSelected =
                    isSavedFilterSelected filter model

                mSavedFilter =
                    Dict.get filter.id model.savedFilterEditInp

                filterDiv =
                    div
                        [ class "p-2 bg-[var(--color-card)] border border-[var(--color-border)] rounded mb-1 flex justify-between items-center hover:shadow transition-shadow duration-150"
                        , classList [ ( "hidden", MaybeX.isJust mSavedFilter ) ]
                        , style "user-select" "none"
                        , onClick <| SavedFilterMenuClose
                        ]
                        [ div
                            [ class "flex-grow cursor-pointer"
                            , onClick <| SavedFilterSelect filterId
                            ]
                            [ if isSelected then
                                span [ class "font-medium text-[var(--color-action)] text-sm" ] [ text filter.name ]

                              else
                                span [ class "text-[var(--color-text)] hover:text-[var(--color-action)] text-sm" ] [ text filter.name ]
                            ]
                        , div [ class "relative" ]
                            [ div
                                [ class "p-1 cursor-pointer hover:bg-[var(--color-bg-muted)] rounded transition-colors duration-150"
                                , attribute "role" "button"
                                , onClick <| SavedFilterMenuToggle filter.id
                                , Html.Events.stopPropagationOn "click" (Json.Decode.succeed ( SavedFilterMenuToggle filter.id, True ))
                                ]
                                [ i [ class "bi bi-three-dots text-[var(--color-text)] text-xs" ] []
                                ]
                            , if model.savedFilterMenuOpen == Just filter.id then
                                div [ class "absolute right-0 top-full mt-1 w-32 bg-[var(--color-card)] border border-[var(--color-border)] rounded shadow-lg z-10" ]
                                    [ div [ class "py-1" ]
                                        [ button
                                            [ class "w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-muted)] transition-colors duration-150"
                                            , onClick <| SavedFilterEdit filter.id
                                            ]
                                            [ text "Редагувати"
                                            ]
                                        , button
                                            [ class "w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-muted)] transition-colors duration-150"
                                            , onClick <| SavedFilterDelete filter.id
                                            ]
                                            [ text "Видалити"
                                            ]
                                        ]
                                    ]

                              else
                                text ""
                            ]
                        ]

                editDiv inp =
                    div [ class "p-2 bg-[var(--color-bg-muted)] border border-[var(--color-border)] rounded mb-1" ]
                        [ div [ class "flex justify-center items-start mb-2" ]
                            [ textarea
                                [ class "w-full p-2 border border-[var(--color-border)] rounded bg-[var(--color-card)] text-[var(--color-text)] resize-none focus:ring-1 focus:ring-[var(--color-primary)] focus:border-transparent text-sm"
                                , onInput <| SavedFilterEditInp filter.id
                                , value inp
                                , style "height" "50px"
                                , spellcheck False
                                ]
                                []
                            ]
                        , div [ class "flex justify-center gap-1.5" ]
                            [ button
                                [ type_ "button"
                                , class "px-3 py-1.5 text-xs font-medium text-[var(--color-text)] bg-[var(--color-card)] border border-[var(--color-border)] rounded hover:bg-[var(--color-bg-muted)] focus:ring-1 focus:ring-[var(--color-primary)] transition-colors duration-150"
                                , onClick <| SavedFilterEditCancel filterId
                                ]
                                [ text "відмінити"
                                ]
                            , button
                                [ type_ "button"
                                , class "px-3 py-1.5 text-xs font-medium text-[var(--color-button-text)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] focus:ring-1 focus:ring-[var(--color-primary)] rounded transition-colors duration-150"
                                , onClick <| SavedFilterRename filter.id
                                ]
                                [ text "зберегти"
                                ]
                            ]
                        ]
            in
            div [] <|
                [ filterDiv
                , flip HtmlX.viewMaybe (Dict.get filter.id model.savedFilterEditInp) editDiv
                ]

        tabFiltersBlock =
            let
                tagListBlock =
                    div [ class "overflow-y-auto p-2" ]
                        [ div
                            [ class "flex flex-wrap gap-2 text-xs"
                            ]
                          <|
                            List.map
                                (\( tagId_, tag_ ) ->
                                    let
                                        count =
                                            model.statsTags
                                                |> RD.withDefault []
                                                |> ListX.find (\x -> x.tagId == tagId_)
                                                |> mmap .count
                                                |> def 0
                                    in
                                    Tag.new { isActive = List.member tagId_ model.tagsSelected, onToggle = ToggleTagSelection tagId_ }
                                        |> (\config ->
                                                if count > 0 then
                                                    Tag.withBadge (String.fromInt count) config

                                                else
                                                    config
                                           )
                                        |> Tag.view tag_.label
                                )
                                model.tags
                        , let
                            checkboxLabel =
                                [ Html.node
                                    "sl-tooltip"
                                    [ attribute "content" "якщо ця опція вимкнена - при виборі 2+ тегів \"x\" і \"y\" знайдуться повідомлення де є \"x\" або \"y\". якщо ввімкнена - при виборі 2+ тегів знайдуться повідомлення де є і \"x\" i \"y\""
                                    , attribute "placement" "right"
                                    , class "sl-tooltip-delay sl-tooltip-max-w-250 text-sm"
                                    ]
                                    [ text "співпадіння з усіма вибраними вище"
                                    , sup []
                                        [ i
                                            [ class "bi-question-circle" ]
                                            []
                                        ]
                                    ]
                                ]
                          in
                          Shared.Components.Checkbox.new { isChecked = model.filterTagsOption == B.AllTags, onToggle = FilterTagsOptionChanged }
                            |> Shared.Components.Checkbox.withContent checkboxLabel
                            |> Shared.Components.Checkbox.view
                        , div
                            [ class "mt-4 flex flex-wrap gap-2 text-xs"
                            ]
                            [ Tag.new { isActive = model.orWithExtendedForm, onToggle = ToggleOnlyWithExtendedForm }
                                |> Tag.view "з нотаткою"
                            , Tag.new { isActive = model.orBookmarked, onToggle = ToggleOnlyBookmarked }
                                |> Tag.view "збережені"
                            , Tag.new { isActive = model.orImportant, onToggle = ToggleOnlyImportant }
                                |> Tag.view "важливі"
                            , Tag.new { isActive = model.orWithCoords, onToggle = ToggleOrWithCoords }
                                |> Tag.view "з пеленгом"
                            ]
                        ]

                getOverallOptionsCount fieldAccessor remoteData =
                    case ( model.from.datePosix, model.to.datePosix ) of
                        ( Just dtFromPosix, Just dtToPosix ) ->
                            if not (Utils.Time.isMoreThanAWeekApart dtFromPosix dtToPosix) then
                                extractMRecordField fieldAccessor (List.length <| RD.withDefault [] remoteData) (RD.toMaybe model.counts)
                                    |> String.fromInt

                            else
                                "10+"

                        _ ->
                            ""
            in
            (if List.member "Admin" user.roles then
                [ filterMenuBlockCountOutOf
                    { unfold = model.unfoldAorsFilter
                    , toggleMsg = ToggleUnfoldAorsFilter
                    , label = "смуги"
                    , mCountLabel = List.length model.aorsSelected |> zeroToNothing |> mmap String.fromInt
                    , overallLabel = getOverallOptionsCount (\r -> r.aorsCount) model.aors
                    , withGreenCircle = False
                    }
                    tabFiltersAors
                ]

             else
                []
            )
                ++ [ filterMenuBlockCountOutOf
                        { unfold = model.unfoldGroupsFilter
                        , toggleMsg = ToggleUnfoldGroupsFilter
                        , label = "група"
                        , mCountLabel = List.length model.groupsSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.groupsCount) model.groups
                        , withGreenCircle = False
                        }
                        tabFiltersGroups
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldSendersFilter
                        , toggleMsg = ToggleUnfoldSendersFilter
                        , label = "відправник"
                        , mCountLabel = model.sendersSelectedNames |> List.length |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.sendersCount) model.senders
                        , withGreenCircle = False
                        }
                        tabFiltersSenders
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldFreqsFilter
                        , toggleMsg = ToggleUnfoldFreqsFilter
                        , label = "частоти"
                        , mCountLabel = List.length model.freqsSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.freqsCount) model.freqs
                        , withGreenCircle = model.includeOnlyNewFreqs
                        }
                        tabFiltersFreqs
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldCallsignsFilter
                        , toggleMsg = ToggleUnfoldCallsignsFilter
                        , label = "позивні"
                        , mCountLabel = List.length model.callsignsSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.callsignsCount) model.callsigns
                        , withGreenCircle = False
                        }
                        tabFiltersCallsigns
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldUnitsFilter
                        , toggleMsg = ToggleUnfoldUnitsFilter
                        , label = "підрозділи"
                        , mCountLabel = List.length model.unitsSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.unitsCount) model.units
                        , withGreenCircle = False
                        }
                        tabFiltersUnits
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldLocationsFilter
                        , toggleMsg = ToggleUnfoldLocationsFilter
                        , label = "локації"
                        , mCountLabel = List.length model.locationsSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.locationsCount) model.locations
                        , withGreenCircle = not model.includePelengLocations
                        }
                        tabFiltersLocations
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldPostsFilter
                        , toggleMsg = ToggleUnfoldPostsFilter
                        , label = "пости"
                        , mCountLabel = List.length model.postsSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.postsCount) model.posts
                        , withGreenCircle = False
                        }
                        tabFiltersPosts
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldNetworksFilter
                        , toggleMsg = ToggleUnfoldNetworksFilter
                        , label = "мережі"
                        , mCountLabel = List.length model.networksSelected |> zeroToNothing |> mmap String.fromInt
                        , overallLabel = getOverallOptionsCount (\r -> r.networksCount) model.networksStats
                        , withGreenCircle = False
                        }
                        tabFiltersNetworks
                   , filterMenuBlockCountOutOf
                        { unfold = model.unfoldTagsFilter
                        , toggleMsg = ToggleUnfoldTagsFilter
                        , label = "теги, збережені"
                        , mCountLabel =
                            (List.length model.tagsSelected
                                + trueToOne model.orBookmarked
                                + trueToOne model.orImportant
                                + trueToOne model.orWithCoords
                                + trueToOne model.orWithExtendedForm
                            )
                                |> zeroToNothing
                                |> mmap String.fromInt
                        , overallLabel =
                            extractMRecordField (\r -> r.tagsCount) (List.length model.tags) (RD.toMaybe model.counts)
                                |> String.fromInt
                        , withGreenCircle = False
                        }
                        tagListBlock
                   , div [ class "flex-grow-1", style "margin-top" "100px" ]
                        [-- text "space"
                        ]
                   ]

        tabFiltersAors =
            let
                findAorName aorId =
                    model.aorNames
                        |> ListX.find (\entry -> String.fromInt entry.id == aorId)
                        |> Maybe.map .name
                        |> Maybe.withDefault ("AOR " ++ aorId)

                items =
                    List.map
                        (\aorId ->
                            Select.basicMenuItem
                                { item = aorId
                                , label = findAorName aorId
                                }
                        )
                        model.aorsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelAorMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selAorState
                            model.selAorMenu
                            "всі"
                            { loading = RD.isLoading model.aors, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersGroups =
            let
                items =
                    List.map
                        (\masterKey ->
                            Select.basicMenuItem
                                { item = masterKey
                                , label = Shared.Components.RerMessage.groupName masterKey model.groupInfos
                                }
                        )
                        model.groupsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelGroupMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selGroupState
                            model.selGroupMenu
                            "всі"
                            { loading = RD.isLoading model.groups, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersSenders =
            let
                items =
                    model.sendersSelectedNames
                        |> List.concatMap
                            (\name ->
                                model.profiles
                                    |> Dict.toList
                                    |> List.filterMap
                                        (\( k, v ) ->
                                            case v of
                                                Nothing ->
                                                    Nothing

                                                Just profile ->
                                                    if name == Shared.Components.RerMessage.profileNameStr k profile then
                                                        Just ( k, name )

                                                    else
                                                        Nothing
                                        )
                            )
                        |> List.foldl
                            (\( uuid, name ) ( acc, seen ) ->
                                let
                                    count =
                                        model.senders
                                            |> RD.withDefault []
                                            |> ListX.find (\x -> x.uuid == uuid)
                                            |> mmap .count
                                            |> def 0
                                in
                                if Set.member name seen then
                                    let
                                        updatedAcc =
                                            List.map
                                                (\( c, n ) ->
                                                    if n == name then
                                                        ( c + count, name )

                                                    else
                                                        ( c, n )
                                                )
                                                acc
                                    in
                                    ( updatedAcc, seen )

                                else
                                    ( ( count, name ) :: acc, Set.insert name seen )
                            )
                            ( [], Set.empty )
                        |> Tuple.first
                        |> List.map
                            (\( count, name ) ->
                                Select.basicMenuItem
                                    { item = name
                                    , label =
                                        name
                                            ++ " ("
                                            ++ fromInt count
                                            ++ ")"
                                    }
                            )
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelSenderMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selSenderState
                            model.selSenderMenu
                            "всі"
                            { loading = RD.isLoading model.senders, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersFreqs =
            let
                items =
                    if model.includeOnlyNewFreqs then
                        []

                    else
                        List.map
                            (\freq ->
                                Select.basicMenuItem
                                    { item = freq
                                    , label =
                                        getLabelOrDefault freq
                                    }
                            )
                            model.freqsSelected
            in
            div [ class "py-1 px-2" ]
                [ div []
                    [ Html.map SelFreqMsg
                        (Html.Styled.toUnstyled <|
                            Utils.Select.renderSelectVirtual
                                items
                                model.selFreqState
                                model.selFreqMenu
                                "всі"
                                { loading = RD.isLoading model.freqs, disabled = model.includeOnlyNewFreqs, isDark = isDark }
                        )
                    ]
                , let
                    selItem =
                        Just
                            (Select.basicMenuItem
                                { item = model.adjacentFreqsRangeSelect.selected
                                , label = String.fromFloat (model.adjacentFreqsRangeSelect.selected * 1000) ++ " кГц"
                                }
                            )

                    options =
                        Utils.Select.defaultOptions isDark

                    options2 =
                        { options | clearable = False, disabled = model.includeOnlyNewFreqs }

                    adjacentFreqs =
                        model.filterSelectedAdjacentFreqs |> Set.fromList |> Set.toList

                    tooltipBody =
                        div [ style "display" "flex", style "gap" "8px", style "max-width" "400px", style "flex-wrap" "wrap" ]
                            (if List.length adjacentFreqs > 0 then
                                List.map (\f -> span [ style "display" "block" ] [ text f ]) adjacentFreqs

                             else
                                [ text "відсутні" ]
                            )
                  in
                  div [ class "mb-1 mt-2" ]
                    [ span []
                        [ Tooltip.new "включати частоти в діапазоні:"
                            |> Tooltip.view tooltipBody
                        ]
                    , div [ class "max-w-[50%]" ]
                        [ Html.map SelectFilterAdjacentFreqsRange
                            (Html.Styled.toUnstyled <|
                                Utils.Select.renderSelectSingle
                                    selItem
                                    model.adjacentFreqsRangeSelect.state
                                    model.adjacentFreqsRangeSelect.items
                                    "не обрано"
                                    options2
                            )
                        ]
                    ]
                , div []
                    [ div
                        [ class "my-1" ]
                        [ let
                            checkboxLabel =
                                [ Html.node
                                    "sl-tooltip"
                                    [ attribute "content" "фільтрує по частотам, що були за обраний період, але яких не було за попередні до нього 10 днів"
                                    , attribute "placement" "right"
                                    , class "sl-tooltip-delay sl-tooltip-max-w-250"
                                    ]
                                    [ text "тільки нові частоти "
                                    , sup []
                                        [ i
                                            [ class "bi-question-circle" ]
                                            []
                                        ]
                                    ]
                                ]
                          in
                          Shared.Components.Checkbox.new { isChecked = model.includeOnlyNewFreqs, onToggle = SetIncludeOnlyNewFreqs }
                            |> Shared.Components.Checkbox.withContent checkboxLabel
                            |> Shared.Components.Checkbox.view
                        ]
                    ]
                ]

        tabFiltersCallsigns =
            let
                items =
                    List.map
                        (\callsign ->
                            Select.basicMenuItem
                                { item = callsign
                                , label = callsign
                                }
                        )
                        model.callsignsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelCallsignMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selCallsignState
                            model.selCallsignMenu
                            "всі"
                            { loading = RD.isLoading model.callsigns, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersUnits =
            let
                items =
                    List.map
                        (\unit ->
                            Select.customMenuItem
                                { item = unit
                                , label = unit
                                , view =
                                    Html.Styled.fromUnstyled <|
                                        div []
                                            [ text unit
                                            , span [ class "badge rounded-pill text-bg-light" ]
                                                [ text <| unit ]
                                            ]
                                }
                        )
                        model.unitsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelUnitMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelect
                            items
                            model.selUnitState
                            model.selUnitMenu
                            "всі"
                            (Utils.Select.defaultOptions isDark)
                    )
                , div [ class "my-1" ]
                    [ Shared.Components.Checkbox.new { isChecked = model.unitsExactMatchOnly, onToggle = UnitsExactMatchOnlyChanged }
                        |> Shared.Components.Checkbox.withContent [ text "точний збіг за еталонкою" ]
                        |> Shared.Components.Checkbox.view
                    ]
                ]

        tabFiltersLocations =
            let
                items =
                    List.map
                        (\loc ->
                            Select.basicMenuItem
                                { item = loc
                                , label = loc
                                }
                        )
                        model.locationsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map
                    SelLocationMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selLocationState
                            model.selLocationMenu
                            "всі"
                            { loading = RD.isLoading model.locations, disabled = False, isDark = isDark }
                    )
                , div [ class "my-3" ]
                    [ Shared.Components.Checkbox.new { isChecked = not model.includePelengLocations, onToggle = SetIncludePelengLocations }
                        |> Shared.Components.Checkbox.withContent
                            [ text "точний збіг "
                            , i [ class "bi-question-circle text-xs text-gray-500 dark:text-gray-400" ] []
                            ]
                        |> Shared.Components.Checkbox.view
                    ]
                ]

        tabFiltersPosts =
            let
                items =
                    List.map
                        (\post ->
                            Select.basicMenuItem
                                { item = post
                                , label =
                                    getLabelOrDefault post
                                }
                        )
                        model.postsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelPostMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selPostState
                            model.selPostMenu
                            "всі"
                            { loading = RD.isLoading model.posts, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersNetworks =
            let
                findNetworkName networkId =
                    model.networkNames
                        |> ListX.find (\entry -> entry.id == (String.toInt networkId |> Maybe.withDefault 0))
                        |> Maybe.map .name
                        |> Maybe.withDefault ("Network " ++ networkId)

                selected =
                    List.map
                        (\networkId ->
                            Select.basicMenuItem
                                { item = networkId
                                , label = findNetworkName networkId
                                }
                        )
                        model.networksSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelNetworkMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelect
                            selected
                            model.selNetworkState
                            model.selNetworkMenu
                            "всі"
                            { loading = RD.isLoading model.networksStats
                            , clearable = True
                            , disabled = False
                            , isDark = isDark
                            , trunc = Utils.Select.Long
                            }
                    )
                ]
    in
    div
        [ class "flex flex-col p-2  min-h-full"
        , style "min-height" "100%"
        ]
    <|
        div [ class "flex border-b border-[var(--color-border)] mb-3" ]
            [ button
                [ class "flex-1 px-4 py-2 text-sm font-medium border-b-2 transition-colors duration-150"
                , classList [ ( "border-[var(--color-text)] text-[var(--color-text)]", model.menuTab == TabFilters ), ( "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border)]", model.menuTab /= TabFilters ) ]
                , onClick <| SelectTab TabFilters
                ]
                [ text "фільтри" ]
            , button
                [ class "flex-1 px-4 py-2 text-sm font-medium border-b-2 transition-colors duration-150"
                , classList [ ( "border-[var(--color-text)] text-[var(--color-text)]", model.menuTab == TabSaved ), ( "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border)]", model.menuTab /= TabSaved ) ]
                , onClick <| SelectTab TabSaved
                ]
                [ text "збережені" ]
            ]
            :: (case model.menuTab of
                    TabFilters ->
                        tabFiltersBlock

                    TabSaved ->
                        div [ class "text-center mb-3" ]
                            [ button
                                [ class "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-[var(--color-action)] hover:text-[var(--color-action-hovered)] hover:bg-[var(--color-bg-muted)] rounded transition-colors duration-150"
                                , onClick SaveFilterExpandToggle
                                ]
                                [ text "зберегти фільтр як"
                                , i [ class "bi bi-info-circle text-xs" ] []
                                ]
                            ]
                            :: ifOrEmpty model.saveFilterExpanded
                                [ div [ class "bg-[var(--color-bg-muted)] border border-[var(--color-border)] rounded p-3" ]
                                    [ div [ class "flex justify-center mb-2" ]
                                        [ textarea
                                            [ class "w-full max-w-xs p-2 border border-[var(--color-border)] rounded bg-[var(--color-card)] text-[var(--color-text)] resize-none focus:ring-1 focus:ring-[var(--color-primary)] focus:border-transparent text-sm"
                                            , onInput <| SaveFilterInp
                                            , value <| model.saveFilterInp
                                            , style "height" "50px"
                                            , spellcheck False
                                            ]
                                            []
                                        ]
                                    , div [ class "flex justify-center gap-1.5" ]
                                        [ button
                                            [ type_ "button"
                                            , class "px-3 py-1.5 text-xs font-medium text-[var(--color-text)] bg-[var(--color-card)] border border-[var(--color-border)] rounded hover:bg-[var(--color-bg-muted)] focus:ring-1 focus:ring-[var(--color-primary)] transition-colors duration-150"
                                            , onClick <| SaveFilterExpandToggle
                                            ]
                                            [ text "відмінити"
                                            ]
                                        , button
                                            [ type_ "button"
                                            , class "px-3 py-1.5 text-xs font-medium text-[var(--color-button-text)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] focus:ring-1 focus:ring-[var(--color-primary)] rounded transition-colors duration-150 flex items-center gap-1.5"
                                            , onClick <| SaveFilterDo
                                            ]
                                            [ text "зберегти"
                                            , if model.saveFilterInProgress then
                                                Shared.Components.Spinner.loadingSpinner2Sm

                                              else
                                                text ""
                                            ]
                                        ]
                                    ]
                                ]
                            ++ (if model.savedFiltersLoading then
                                    [ Shared.Components.Spinner.loadingSpinner ]

                                else
                                    List.map renderSavedFilter model.savedFilters
                               )
               )
