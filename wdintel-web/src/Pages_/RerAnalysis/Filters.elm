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
import Pages_.RerAnalysis.Senders as RerAnalysisSenders
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


filterMenuBlock : { unfold : Bool, toggleMsg : msg, label : String } -> Html msg -> Html msg
filterMenuBlock config content =
    div [ class "bg-[var(--color-card)] border border-[var(--color-border)] rounded mb-2 shadow-sm hover:shadow transition-shadow duration-150" ]
        [ div
            [ class "flex items-center px-3 py-2 cursor-pointer hover:bg-[var(--color-bg-muted)] transition-colors duration-150"
            , onClick config.toggleMsg
            ]
            [ div [ class "flex items-center gap-2 flex-grow" ]
                [ span [ classList [ ( "font-medium text-[var(--color-text)] text-sm", config.unfold ), ( "font-normal text-[var(--color-text)] text-sm", not config.unfold ) ] ] [ text config.label ]
                ]
            , i
                [ class "bi text-xs transition-transform duration-150 ml-2 text-[var(--color-text)]"
                , classList [ ( "bi-chevron-up", config.unfold ) ]
                , classList [ ( "bi-chevron-down", not config.unfold ) ]
                ]
                []
            ]
        , HtmlX.viewIf config.unfold content
        ]


isRefreshing : RD.RemoteData err data -> Bool
isRefreshing remoteData =
    case remoteData of
        RD.Loading ->
            True

        _ ->
            False


freshMenuItems : RD.RemoteData err data -> List menuItem -> List menuItem
freshMenuItems remoteData menuItems =
    case remoteData of
        RD.Success _ ->
            menuItems

        _ ->
            []


rerAnalysisCheckboxLabel : List (Html msg) -> Html msg
rerAnalysisCheckboxLabel content =
    span [ class "rer-analysis-checkbox-label" ] content


unitsExactMatchCheckboxChipLabel : Model -> Maybe String
unitsExactMatchCheckboxChipLabel model =
    case model.counts of
        RD.Success counts ->
            if model.unitsExactMatchOnly then
                Just ("неточних збігів: " ++ fromInt counts.unitsNonExactMatchesCount)

            else
                Just ("точних збігів: " ++ fromInt counts.unitsExactMatchesCount)

        _ ->
            Nothing


unitsExactMatchCheckboxContent : Model -> List (Html msg)
unitsExactMatchCheckboxContent model =
    [ span [ class "rer-analysis-units-exact-match-content" ]
        (span [ class "rer-analysis-units-exact-match-label" ] [ text "точний збіг за еталонкою" ]
            :: (case unitsExactMatchCheckboxChipLabel model of
                    Just chipLabel ->
                        [ span
                            [ class "inline-flex items-center rounded-full border border-amber-500/40 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold leading-none text-amber-700" ]
                            [ text chipLabel ]
                        ]

                    Nothing ->
                        []
               )
        )
    ]


view : Bool -> B.User -> Model -> Html Msg
view isDark _ model =
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
                                (List.sortBy (Tuple.second >> .label) model.tags)
                        , div [ class "rer-analysis-checkboxes" ]
                            [ let
                                checkboxLabel =
                                    [ rerAnalysisCheckboxLabel
                                        [ Html.node
                                            "sl-tooltip"
                                            [ attribute "content" "якщо ця опція вимкнена - при виборі 2+ тегів \"x\" і \"y\" знайдуться повідомлення де є \"x\" або \"y\". якщо ввімкнена - при виборі 2+ тегів знайдуться повідомлення де є і \"x\" i \"y\""
                                            , attribute "placement" "right"
                                            , class "rer-analysis-checkbox-tooltip sl-tooltip-delay sl-tooltip-max-w-250 text-sm"
                                            ]
                                            [ text "співпадіння з усіма вибраними вище"
                                            , sup []
                                                [ i
                                                    [ class "bi-question-circle" ]
                                                    []
                                                ]
                                            ]
                                        ]
                                    ]
                              in
                              Shared.Components.Checkbox.new { isChecked = model.filterTagsOption == B.AllTags, onToggle = FilterTagsOptionChanged }
                                |> Shared.Components.Checkbox.withContent checkboxLabel
                                |> Shared.Components.Checkbox.view
                            , Shared.Components.Checkbox.new { isChecked = model.reportTagsOnlyThisUnit, onToggle = always ReportTagsOnlyThisUnitToggle }
                                |> Shared.Components.Checkbox.withContent [ rerAnalysisCheckboxLabel [ text "лише теги мого підрозділу" ] ]
                                |> Shared.Components.Checkbox.view
                            , Shared.Components.Checkbox.new { isChecked = model.withoutModelTags, onToggle = always ToggleWithoutModelTags }
                                |> Shared.Components.Checkbox.withContent [ rerAnalysisCheckboxLabel [ text "без відміток роботами" ] ]
                                |> Shared.Components.Checkbox.view
                            ]
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
                            if not (Utils.Time.isMoreThanThresholdApart dtFromPosix dtToPosix) then
                                extractMRecordField fieldAccessor (List.length <| RD.withDefault [] remoteData) (RD.toMaybe model.counts)
                                    |> String.fromInt

                            else
                                "10+"

                        _ ->
                            ""

                metadataField labelText selectedItems state menuItems selectMsg =
                    let
                        isDisabled =
                            model.withoutMetadata

                        selectedMenuItems =
                            List.map
                                (\item ->
                                    Select.basicMenuItem
                                        { item = item
                                        , label = item
                                        }
                                )
                                selectedItems
                    in
                    div [ class "mb-3" ]
                        [ div [ class "mb-1 text-xs font-medium text-[var(--color-text)] uppercase tracking-wide" ] [ text labelText ]
                        , div [ class "flex-1" ]
                            [ Html.map selectMsg
                                (Html.Styled.toUnstyled <|
                                    Utils.Select.renderSelectVirtual
                                        selectedMenuItems
                                        state
                                        (freshMenuItems model.metadataStats menuItems)
                                        "всі"
                                        { loading = isRefreshing model.metadataStats
                                        , disabled = isDisabled
                                        , isDark = isDark
                                        }
                                )
                            ]
                        ]

                tabFiltersMetadata =
                    let
                        metadataToggleCheckbox labelText isChecked onToggle isDisabled =
                            div
                                [ class "rer-analysis-checkbox-row"
                                , classList [ ( "opacity-50 cursor-not-allowed", isDisabled ) ]
                                ]
                                [ Shared.Components.Checkbox.new { isChecked = isChecked, onToggle = onToggle }
                                    |> Shared.Components.Checkbox.withDisabled isDisabled
                                    |> Shared.Components.Checkbox.withContent
                                        [ rerAnalysisCheckboxLabel [ text labelText ] ]
                                    |> Shared.Components.Checkbox.view
                                ]
                    in
                    div [ class "py-2 px-3" ]
                        [ metadataField "cc" model.metadataCc model.selMetadataCcState model.selMetadataCcMenu SelMetadataCcMsg
                        , metadataField "відправник" model.metadataSender model.selMetadataSenderState model.selMetadataSenderMenu SelMetadataSenderMsg
                        , metadataField "отримувач" model.metadataReceiver model.selMetadataReceiverState model.selMetadataReceiverMenu SelMetadataReceiverMsg
                        , metadataField "хеш" model.metadataHash model.selMetadataHashState model.selMetadataHashMenu SelMetadataHashMsg
                        , div [ class "rer-analysis-checkboxes" ]
                            [ metadataToggleCheckbox
                                "тільки без метаданих"
                                model.withoutMetadata
                                WithoutMetadataChanged
                                model.onlyWithMetadata
                            , metadataToggleCheckbox
                                "тільки з метаданими"
                                model.onlyWithMetadata
                                OnlyWithMetadataChanged
                                model.withoutMetadata
                            ]
                        ]
            in
            [ filterMenuBlockCountOutOf
                { unfold = model.unfoldAorsFilter
                , toggleMsg = ToggleUnfoldAorsFilter
                , label = "смуги"
                , mCountLabel = List.length model.aorsSelected |> zeroToNothing |> mmap String.fromInt
                , overallLabel = getOverallOptionsCount (\r -> r.aorsCount) model.aors
                , withGreenCircle = False
                }
                tabFiltersAors
            , filterMenuBlockCountOutOf
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
                , mCountLabel = model.sendersSelected |> List.length |> zeroToNothing |> mmap String.fromInt
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
            , filterMenuBlock
                { unfold = model.unfoldMetadataFilter
                , toggleMsg = ToggleUnfoldMetadataFilter
                , label = "метадані"
                }
                tabFiltersMetadata
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
                        + trueToOne model.withoutModelTags
                        + trueToOne model.reportTagsOnlyThisUnit
                    )
                        |> zeroToNothing
                        |> mmap String.fromInt
                , overallLabel =
                    extractMRecordField (\r -> r.tagsCount) (List.length model.tags) (RD.toMaybe model.counts)
                        |> String.fromInt
                , withGreenCircle = model.reportTagsOnlyThisUnit
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
                            (freshMenuItems model.aors model.selAorMenu)
                            "всі"
                            { loading = isRefreshing model.aors, disabled = False, isDark = isDark }
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
                            (freshMenuItems model.groups model.selGroupMenu)
                            "всі"
                            { loading = isRefreshing model.groups, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersSenders =
            let
                items =
                    RerAnalysisSenders.selectedMenuItems model.profiles (RD.withDefault [] model.senders) model.sendersSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelSenderMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            items
                            model.selSenderState
                            (freshMenuItems model.senders model.selSenderMenu)
                            "всі"
                            { loading = isRefreshing model.senders, disabled = False, isDark = isDark }
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
                                (freshMenuItems model.freqs model.selFreqMenu)
                                "всі"
                                { loading = isRefreshing model.freqs, disabled = model.includeOnlyNewFreqs, isDark = isDark }
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
                            (freshMenuItems model.callsigns model.selCallsignMenu)
                            "всі"
                            { loading = isRefreshing model.callsigns, disabled = False, isDark = isDark }
                    )
                ]

        tabFiltersUnits =
            let
                isLegacyUnitValue value =
                    not (Pages_.RerAnalysis.Query.isCanonicalUnitIdValue value)

                unitLabel value =
                    case ( String.toInt value, model.units ) of
                        ( Just unitId, RD.Success units ) ->
                            units
                                |> List.filter (\unit -> unit.unitId == unitId)
                                |> List.head
                                |> Maybe.map .name
                                |> Maybe.withDefault value

                        _ ->
                            getLabelOrDefault value

                items =
                    List.map
                        (\unit ->
                            Select.customMenuItem
                                { item = unit
                                , label = unitLabel unit
                                , view =
                                    Html.Styled.fromUnstyled <|
                                        div []
                                            [ text (unitLabel unit)
                                            , span [ class "badge rounded-pill text-bg-light" ]
                                                [ text <| unitLabel unit ]
                                            ]
                                }
                        )
                        model.unitsSelected

                options =
                    Utils.Select.defaultOptions isDark
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelUnitMsg
                    (Html.Styled.toUnstyled <|
                        Utils.Select.renderSelect
                            items
                            model.selUnitState
                            (freshMenuItems model.units model.selUnitMenu)
                            "всі"
                            { options | loading = isRefreshing model.units }
                    )
                , if
                    List.isEmpty model.unitsSelected
                        || not (List.any isLegacyUnitValue model.unitsSelected)
                  then
                    text ""

                  else
                    div [ class "rer-analysis-units-exact-match-row" ]
                        [ Shared.Components.Checkbox.new { isChecked = model.unitsExactMatchOnly, onToggle = UnitsExactMatchOnlyChanged }
                            |> Shared.Components.Checkbox.withContent (unitsExactMatchCheckboxContent model)
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
                            (freshMenuItems model.locations model.selLocationMenu)
                            "всі"
                            { loading = isRefreshing model.locations, disabled = False, isDark = isDark }
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
                            (freshMenuItems model.posts model.selPostMenu)
                            "всі"
                            { loading = isRefreshing model.posts, disabled = False, isDark = isDark }
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
                            (freshMenuItems model.networksStats model.selNetworkMenu)
                            "всі"
                            { loading = isRefreshing model.networksStats
                            , clearable = True
                            , disabled = False
                            , isDark = isDark
                            , trunc = Utils.Select.Long
                            }
                    )
                , div [ class "my-3" ]
                    [ Shared.Components.Checkbox.new { isChecked = model.withoutNetwork, onToggle = WithoutNetworkChanged }
                        |> Shared.Components.Checkbox.withContent
                            [ text "без мережі "
                            , i [ class "bi-question-circle text-xs text-gray-500 dark:text-gray-400" ] []
                            ]
                        |> Shared.Components.Checkbox.view
                    ]
                ]
    in
    div
        [ class "flex flex-col p-6 pr-2 min-h-full"
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
                                    model.savedFilters
                                        |> List.sortBy (Tuple.second >> .name)
                                        |> List.map renderSavedFilter
                               )
               )
