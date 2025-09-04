module RerAnalysis.Filters exposing (leftColumn)

import Bindings as B
import Components.Checkbox
import Components.Tag as Tag
import Dict
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events as Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled
import Json.Decode as Decode
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Tooltip as Tooltip
import Le.RemoteData as RD
import Le.RerMessage
import Le.Time
import Le.Utils exposing (..)
import List.Extra as ListX
import Maybe.Extra as MaybeX
import RerAnalysis.Model exposing (..)
import RerAnalysis.Msg exposing (..)
import RerAnalysis.Query
import Select
import Set
import String exposing (fromInt)
import Time


isSavedFilterSelected : B.SavedFilter -> Model -> Bool
isSavedFilterSelected filter model =
    let
        req1 =
            filter.req

        req2 =
            RerAnalysis.Query.analysisStatsParams
                (Time.millisToPosix req1.sinceDateInclusiveMs)
                (Time.millisToPosix req1.tillDateNoninclusiveMs)
                model
    in
    req1 == req2


filterMenuBlockCountOutOf : { unfold : Bool, toggleMsg : msg, label : String, mCountLabel : Maybe String, overallLabel : String, withGreenCircle : Bool } -> Html msg -> Html msg
filterMenuBlockCountOutOf config content =
    div [ class "border border-separator mb-1" ]
        [ div
            [ class "flex justify-between items-center p-2 cursor-pointer"
            , onClick config.toggleMsg
            ]
            [ div [ class "flex-fill flex items-center justify-between me-2" ]
                [ span [ classList [ ( "font-medium", config.unfold ) ] ] [ text config.label ]
                , if config.withGreenCircle then
                    div [ class "filter-green-circle" ] []

                  else
                    text ""
                ]
            , div [ class "me-2" ]
                [ span
                    [ class "badge badge-sm rounded-pill"
                    , classList
                        [ ( "text-bg-secondary", MaybeX.isNothing config.mCountLabel )
                        , ( "text-bg-danger", MaybeX.isJust config.mCountLabel )
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
            , div []
                [ i
                    [ class "bi"
                    , classList [ ( "bi-chevron-up", config.unfold ) ]
                    , classList [ ( "bi-chevron-down", not config.unfold ) ]
                    ]
                    []
                ]
            ]
        , HtmlX.viewIf config.unfold content
        ]


leftColumn : Bool -> B.User -> Model -> Html Msg
leftColumn isDark user model =
    let
        renderSavedFilter ( filterId, filter ) =
            let
                isSelected =
                    isSavedFilterSelected filter model

                mSavedFilter =
                    Dict.get filter.id model.savedFilterEditInp

                filterDiv =
                    div
                        [ class "p-2 border d-flex justify-content-between align-items-center"
                        , classList [ ( "d-none", MaybeX.isJust mSavedFilter ) ]
                        , style "user-select" "none"
                        ]
                        [ div
                            [ class "flex-grow-1 pointer me-1"
                            , onClick <| SavedFilterSelect filterId
                            ]
                            [ if isSelected then
                                strong [] [ text filter.name ]

                              else
                                text filter.name
                            ]
                        , div [ class "flex-shrink dropdown-center" ]
                            [ div
                                [ class "flex-shrink"
                                , style "cursor" "pointer"
                                , attribute "role" "button"
                                , attribute "data-bs-toggle" "dropdown"
                                , attribute "aria-expanded" "false"
                                ]
                                [ i [ class "bi bi-three-dots" ] []
                                ]
                            , ul
                                [ class "dropdown-menu pt-1 pb-1"
                                , style "border-radius" "none"
                                ]
                                [ li []
                                    [ span
                                        [ class "dropdown-item pointer"
                                        , onClick <| SavedFilterEdit filter.id
                                        ]
                                        [ i [ class "bi bi-pen" ] []
                                        , text " редагувати"
                                        ]
                                    ]
                                , li []
                                    [ span
                                        [ class "dropdown-item pointer"
                                        , onClick <| SavedFilterUpdate filter.id
                                        ]
                                        [ i [ class "bi bi-arrow-clockwise" ] []
                                        , text " зберегти зміни"
                                        ]
                                    ]
                                , li []
                                    [ span
                                        [ class "dropdown-item text-danger pointer"
                                        , onClick <| SavedFilterDelete filter.id
                                        ]
                                        [ i [ class "bi bi-trash" ] []
                                        , text " видалити"
                                        ]
                                    ]
                                ]
                            ]
                        ]

                editDiv inp =
                    div []
                        [ div [ class "d-flex justify-content-center align-items-start mb-2" ]
                            [ textarea
                                [ class "mb-1 p-1 pt-2"
                                , onInput <| SavedFilterEditInp filter.id
                                , value inp
                                , style "height" "60px"
                                , style "width" "180px"
                                , spellcheck False
                                ]
                                []
                            ]
                        , div [ class "d-flex justify-content-center align-items-start" ]
                            [ div [ class "mb-2" ] <|
                                [ button
                                    [ type_ "button"
                                    , class "btn btn-light btn-sm text-nowrap me-1"
                                    , onClick <| SavedFilterEditCancel filterId
                                    ]
                                    [ text "відмінити"
                                    ]
                                , button
                                    [ type_ "button"
                                    , class "btn btn-outline btn-primary btn-sm text-nowrap me-1"
                                    , onClick <| SavedFilterRename filter.id
                                    ]
                                    [ text "зберегти"
                                    ]
                                ]
                            ]
                        ]
            in
            div [ class "list-item" ] <|
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
                          Components.Checkbox.new { isChecked = model.filterTagsOption == B.AllTags, onToggle = FilterTagsOptionChanged }
                            |> Components.Checkbox.withContent checkboxLabel
                            |> Components.Checkbox.view
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
                            if not (Le.Time.isMoreThanAWeekApart dtFromPosix dtToPosix) then
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
                        Le.Block.Select.renderSelectVirtual
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
                                , label = Le.RerMessage.groupName masterKey model.groupInfos
                                }
                        )
                        model.groupsSelected
            in
            div [ class "py-1 px-2" ]
                [ Html.map SelGroupMsg
                    (Html.Styled.toUnstyled <|
                        Le.Block.Select.renderSelectVirtual
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
                                                    if name == Le.RerMessage.profileNameStr k profile then
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
                        Le.Block.Select.renderSelectVirtual
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
                            Le.Block.Select.renderSelectVirtual
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
                        Le.Block.Select.defaultOptions isDark

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
                                Le.Block.Select.renderSelectSingle
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
                          Components.Checkbox.new { isChecked = model.includeOnlyNewFreqs, onToggle = SetIncludeOnlyNewFreqs }
                            |> Components.Checkbox.withContent checkboxLabel
                            |> Components.Checkbox.view
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
                        Le.Block.Select.renderSelectVirtual
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
                        Le.Block.Select.renderSelect
                            items
                            model.selUnitState
                            model.selUnitMenu
                            "всі"
                            (Le.Block.Select.defaultOptions isDark)
                    )
                , div [ class "my-1" ]
                    [ Components.Checkbox.new { isChecked = model.unitsExactMatchOnly, onToggle = UnitsExactMatchOnlyChanged }
                        |> Components.Checkbox.withContent [ text "точний збіг за еталонкою" ]
                        |> Components.Checkbox.view
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
                        Le.Block.Select.renderSelectVirtual
                            items
                            model.selLocationState
                            model.selLocationMenu
                            "всі"
                            { loading = RD.isLoading model.locations, disabled = False, isDark = isDark }
                    )
                , div
                    [ class "form-check my-1" ]
                    [ input
                        [ class "form-check-input"
                        , style "margin-top" "6px"
                        , type_ "checkbox"
                        , id "includePelengLocations"
                        , onCheck SetIncludePelengLocations
                        , checked (not model.includePelengLocations)
                        ]
                        []
                    , node
                        "sl-tooltip"
                        [ attribute "content" "якщо вимкнено - включати також повідомлення з усіх частот що запеленговані на даних локаціях"
                        , attribute "placement" "right"
                        , class "sl-tooltip-delay sl-tooltip-max-w-250"
                        ]
                        [ label
                            [ class "form-check-label"
                            , for "includePelengLocations"
                            ]
                            [ text "точний збіг "
                            , sup []
                                [ i
                                    [ class "bi-question-circle" ]
                                    []
                                ]
                            ]
                        ]
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
                        Le.Block.Select.renderSelectVirtual
                            items
                            model.selPostState
                            model.selPostMenu
                            "всі"
                            { loading = RD.isLoading model.posts, disabled = False, isDark = isDark }
                    )
                ]
    in
    div
        [ class "filter-col d-flex flex-column pt-1 left-panel"
        , style "min-height" "100%"
        ]
    <|
        ul
            [ class "nav nav-tabs nav-fill"
            ]
            [ li
                [ class "nav-item"
                ]
                [ span
                    [ class "nav-link"
                    , classList [ ( "active arrow", model.menuTab == TabFilters ) ]
                    , classList [ ( "pointer", model.menuTab /= TabFilters ) ]
                    , onClick <| SelectTab TabFilters
                    ]
                    [ text "фільтри" ]
                ]
            , li
                [ class "nav-item"
                ]
                [ span
                    [ class "nav-link"
                    , classList [ ( "active arrow", model.menuTab == TabSaved ) ]
                    , classList [ ( "pointer", model.menuTab /= TabSaved ) ]
                    , onClick <| SelectTab TabSaved
                    ]
                    [ text "збережені" ]
                ]
            ]
            :: (case model.menuTab of
                    TabFilters ->
                        tabFiltersBlock

                    TabSaved ->
                        div
                            [ class "text-center mb-2 mt-4"
                            , style "transform" "translate(8px, 0)"
                            ]
                            [ span
                                [ class "text-action cursor-pointer"
                                , onClick SaveFilterExpandToggle
                                ]
                                [ text "зберегти фільтр як" ]
                            , sup
                                [ attribute "data-bs-toggle" "tooltip"
                                , attribute "data-bs-title" "збережіть поточну вибірку як новий фільтр або замініть параметри існуючого"
                                ]
                                [ text " "
                                , i [ class "bi bi-info-circle" ] []
                                ]
                            ]
                            :: ifOrEmpty model.saveFilterExpanded
                                [ div [ class "d-flex justify-content-center align-items-start mb-2" ]
                                    [ textarea
                                        [ class "mb-1"
                                        , onInput <| SaveFilterInp
                                        , value <| model.saveFilterInp
                                        , style "height" "60px"
                                        , style "width" "180px"
                                        , spellcheck False
                                        ]
                                        []
                                    ]
                                , div [ class "d-flex justify-content-center align-items-start" ]
                                    [ div [ class "mb-2" ] <|
                                        [ button
                                            [ type_ "button"
                                            , class "btn btn-light btn-sm text-nowrap me-1"
                                            , onClick <| SaveFilterExpandToggle
                                            ]
                                            [ text "відмінити"
                                            ]
                                        , button
                                            [ type_ "button"
                                            , class "btn btn-outline btn-primary btn-sm text-nowrap me-1"
                                            , onClick <| SaveFilterDo
                                            ]
                                            [ text "зберегти"
                                            ]
                                        ]
                                            ++ (if model.saveFilterInProgress then
                                                    [ Le.Block.Spinner.loadingSpinner2Sm ]

                                                else
                                                    []
                                               )
                                    ]
                                ]
                            ++ (if model.savedFiltersLoading then
                                    [ Le.Block.Spinner.loadingSpinner ]

                                else
                                    List.map renderSavedFilter model.savedFilters
                               )
               )
