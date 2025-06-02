module RerFreqs.NetworkConnection exposing (view)

import Bindings as B
import Bytes exposing (Bytes)
import Components.Button as Button
import Components.Watermark as Watermark exposing (Watermark)
import Debounce exposing (Debounce)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Unit as Unit
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Utils exposing (..)
import List.Extra as ListX
import RerFreqs.Model exposing (FilterName(..), Model, NetworkAddStatus(..), ReportCreation(..), TextLocation(..))
import RerFreqs.Msg exposing (Msg(..))
import RerFreqs.Utils as Utils
import Route exposing (Route)
import Route.Path
import Select
import Shared
import Time exposing (Posix)
import Time.Extra
import Url.Parser exposing (query)
import View exposing (View)


view : Model -> Shared.Model -> List (Html Msg)
view model shared =
    case model.networkAddStatus of
        NotStarted ->
            []

        _ ->
            createNetworkSidebarContent model shared


createNetworkSidebarContent : Model -> Shared.Model -> List (Html Msg)
createNetworkSidebarContent model shared =
    [ div [ class "p-4 w-full flex flex-col overflow-y-auto min-h-[80vh] max-h-screen" ]
        (case model.networkAddStatus of
            CreateNewNetwork freq addState ->
                h3 [ class "mb-[16px]!" ] [ text ("Прив'язка мережі до частоти " ++ freq) ]
                    :: viewCreateNewNetwork addState freq model shared

            SelectFromExistingNetwork freq mSelectedNetworkId ->
                h3 [ class "mb-[16px]!" ] [ text ("Прив'язка мережі до частоти " ++ freq) ]
                    :: viewSelectFromExistingNetwork freq mSelectedNetworkId model shared

            EditConnectedNetwork freq editState ->
                h3 [ class "mb-[16px]!" ] [ text ("Прив'язка мережі до частоти " ++ freq) ]
                    :: viewEditConnectedNetwork editState model shared

            NotStarted ->
                []
        )
    ]


viewCreateNewNetwork : B.CreateNetworkReq -> String -> Model -> Shared.Model -> List (Html Msg)
viewCreateNewNetwork addState freq model shared =
    let
        unitName =
            model.networkDialogUnitSelect.selected |> Maybe.andThen (\id -> Dict.get id model.masterUnits) |> Maybe.map .name

        title =
            "Створення нової мережі для підрозділу " ++ Maybe.withDefault "" unitName
    in
    [ h5 [] [ text title ]
    , section [ class "grid grid-cols-12  gap-y-2 gap-x-4" ]
        [ div [ class "col-span-6" ]
            [ label [ class "mb-1" ] [ text "Назва:*" ]
            , input
                [ class "form-control "
                , type_ "text"
                , value addState.name
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | name = v }
                ]
                []
            ]
        , div [ class "flex flex-col gap-1 col-span-3" ]
            [ label [] [ text "Тип" ]
            , let
                selectedItem =
                    (\item ->
                        Select.basicMenuItem
                            { item = item
                            , label = NetworksUtils.networkKindToLabel item
                            }
                    )
                        model.addKindSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map NetworkAddKindSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelectSingle
                        (Just selectedItem)
                        model.addKindSelect.state
                        model.addKindSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "col-span-3" ]
            [ label [ class "mb-1" ] [ text "Вид передачі" ]
            , let
                selectedItem =
                    Maybe.map
                        (\item ->
                            Select.basicMenuItem
                                { item = item
                                , label =
                                    RD.withDefault [] model.modulations
                                        |> List.filter (\mod -> mod.id == item)
                                        |> List.head
                                        |> Maybe.map .name
                                        |> Maybe.withDefault ""
                                }
                        )
                        model.addModulationSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map NetworkAddModulationSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelectSingle
                        selectedItem
                        model.addModulationSelect.state
                        model.addModulationSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "col-span-6" ]
            [ label [ class "mb-1" ] [ text "Пости" ]
            , let
                selectedItems =
                    List.map
                        (\postId ->
                            Select.basicMenuItem
                                { item = postId
                                , label =
                                    case shared.posts of
                                        Success posts ->
                                            Dict.get postId posts
                                                |> Maybe.map .name
                                                |> Maybe.withDefault ""

                                        _ ->
                                            ""
                                }
                        )
                        model.addPostsSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map NetworkAddPostsSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelect
                        selectedItems
                        model.addPostsSelect.state
                        model.addPostsSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "col-span-6" ]
            [ label [ class "mb-1" ] [ text "Локація" ]
            , input
                [ class "form-control"
                , type_ "text"
                , value <| addState.location
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | location = v }
                ]
                []
            ]
        , div [ class "col-span-12" ]
            [ label [ class "mb-1" ] [ text "Коментар" ]
            , input
                [ class "form-control"
                , value <| addState.comment
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | comment = v }
                ]
                []
            ]
        ]
    , section
        [ class "grid grid-cols-12  gap-y-2 gap-x-4 my-[16px]" ]
        [ div [ class "col-span-6" ]
            [ label [ class "mb-1" ] [ text "Радіостанція" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" addState.radioStation)
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | radioStation = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "типи радіостанцій, що використовуються підрозділом" ]
            ]
        , div [ class " col-span-6" ]
            [ label [ class "mb-1" ] [ text "Призначення" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" addState.purpose)
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | purpose = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]
        , div [ class " col-span-6" ]
            [ label [ class "mb-1" ] [ text "Характер роботи" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" addState.operationType)
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | operationType = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]
        , div [ class " col-span-6" ]
            [ label [ class "mb-1" ] [ text "Режим роботи" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" addState.operationMode)
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | operationMode = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]
        , div [ class " col-span-6" ]
            [ label [ class "mb-1" ] [ text "Період функціонування" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" addState.operationPeriod)
                , onInput <|
                    \v ->
                        NetworkAddMsg
                            { addState | operationPeriod = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]

        -- , div [ class "col-span-4" ]
        --     [ label [ class "mb-1" ] [ text "Ознаки" ]
        --     , input
        --         [ class "form-control"
        --         , value (Maybe.withDefault "" addState.signs)
        --         , onInput <|
        --             \v ->
        --                 NetworkAddMsg
        --                     { addState | signs = Just v }
        --         ]
        --         []
        --     , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "розвід. ознаки підрозділу: сленг, сигнали управління, р/с, кодування місцевості, тощо" ]
        --     ]
        , div [ class "col-span-12" ]
            [ span [] [ text "Обґрунтування прив'язки для частоти ", span [ class "font-medium" ] [ text freq ] ]
            , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
                [ textarea
                    [ class "textarea__field"
                    , placeholder "Введіть обґрунтування прив'язки"
                    , value <| Maybe.withDefault "" model.addConfirmationInp
                    , onInput Confirmation2InputChangedByUser
                    ]
                    []
                ]
            ]
        ]
    , section [ class "" ]
        [ div [ class "" ]
            [ h6 [ class "mb-0" ]
                [ text "Активність мережі" ]
            , span [ class "opacity-70 text-sm" ] [ text "Виберіть дату початку функціонування мережі на основі графіку активності частоти за місяць" ]
            ]
        , div [ class "grid grid-cols-12 gap-[8px]" ]
            [ div
                [ class "col-span-4" ]
                [ label [ class "mb-1" ] [ text "Активна з" ]
                , input
                    [ type_ "date"
                    , class "form-control w-[150px]!"
                    , required True
                    , Maybe.map (\activeFrom -> Time.millisToPosix activeFrom) addState.activeFrom
                        |> (\mActiveFrom ->
                                case mActiveFrom of
                                    Just activeFrom ->
                                        Le.Time.renderDateF4 shared.timeZone activeFrom

                                    Nothing ->
                                        ""
                           )
                        |> value
                    , onInput <|
                        NetworkAddMsg
                            << (\v ->
                                    { addState
                                        | activeFrom =
                                            case Le.Time.parseDateParts v of
                                                Err _ ->
                                                    addState.activeFrom

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                                        |> Just
                                    }
                               )
                    ]
                    []
                ]
            , let
                groupsMessageCountByDayJson =
                    B.freqDailyActivityCountEncoder (RD.withDefault { dataPerDate = Dict.empty } model.freqGroupsActivityForNetworkAdd)
              in
              div [ class "col-span-8 h-[300px]" ]
                [ Html.node "bar-chart-2"
                    [ Attr.property "data" <| groupsMessageCountByDayJson
                    ]
                    []
                ]
            ]
        ]
    , div [ class "flex gap-2 justify-end w-full" ]
        [ Button.new { label = "Відмінити", onClick = CloseAddNetworkSidebar } |> Button.withStyleSecondary |> Button.view
        , Button.new { label = "Зберегти", onClick = NetworkCreate } |> Button.view
        ]
    ]


viewSelectFromExistingNetwork : String -> Maybe Int -> Model -> Shared.Model -> List (Html Msg)
viewSelectFromExistingNetwork freq mSelectedNetworkId model shared =
    [ div [ class "flex flex-col grow relative" ]
        [ HtmlX.viewIf model.networkAddLoading <|
            span [ class "absolute top-[50%] left-[50%] -translate-1/2" ] [ Le.Block.Spinner.loadingSpinner ]
        , let
            networksWithThisFreq =
                ListX.find (\freq_ -> freq_.freq == freq) model.freqs
                    |> (\mFreq ->
                            case mFreq of
                                Just freq_ ->
                                    Just freq_.networkIds

                                Nothing ->
                                    Nothing
                       )
                    |> (\mNetworkIds ->
                            case mNetworkIds of
                                Just ids_ ->
                                    List.filterMap (\id_ -> Dict.get id_ model.networks) ids_

                                Nothing ->
                                    []
                       )

            networksWithThisFreqBlock =
                networksWithThisFreq
                    |> List.map
                        (\network_ ->
                            div
                                [ class "w-full p-2  border-1 border-border rounded-sm text-text flex justify-between"
                                ]
                                [ NetworksUtils.renderNetwork network_ model.masterUnits
                                , div [ class "flex gap-[8px]" ]
                                    [ i [ class "bi bi-pencil cursor-pointer text-action hover:text-action-hovered text-[16px]", title "редагувати", onClick <| NetworkStartEditingFlow network_ ] []
                                    , i [ class "bi bi-trash cursor-pointer text-[#b94d4d] dark:text-[#f98282] dark:hover:text-[#df7474]  text-[16px]", title "видалити", onClick <| FreqRemoveFromExistingNetwork freq network_ ] []
                                    ]
                                ]
                        )
          in
          HtmlX.viewIf (List.length networksWithThisFreq > 0) <|
            div [ class "mb-2" ]
                [ h5 [ class "" ] [ text ("Уже прив'язані до " ++ freq) ]
                , div [ class "flex flex-col gap-[4px]" ] networksWithThisFreqBlock
                ]
        , div [ class "min-h-[200px] flex flex-col" ]
            [ let
                selectItem =
                    model.networkDialogUnitSelect.selected
                        |> Maybe.map
                            (\unitId ->
                                Select.basicMenuItem
                                    { item = unitId
                                    , label = Unit.unitName model.masterUnits unitId
                                    }
                            )
              in
              div [ class "flex gap-[8px]" ]
                [ div [ class "grow-1" ]
                    [ h5 [] [ text "Пошук існуючих мереж по підрозділу" ]
                    , Html.map NetworkAddUnitSelMsg <|
                        Styled.toUnstyled <|
                            Le.Block.Select.renderSelectSingle
                                selectItem
                                model.networkDialogUnitSelect.state
                                model.networkDialogUnitSelect.items
                                "жоден"
                                (Le.Block.Select.defaultOptions shared.isDarkMode)
                    ]
                , div [ class "flex gap-[4px] items-end" ]
                    [ a
                        [ title "Додати новий підрозділ"
                        , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw! py-[1px] px-[6px]"
                        , Route.href { path = Route.Path.RerUnits, query = Dict.empty, hash = Nothing }
                        , target "_blank"
                        ]
                        [ i [ class "bi bi-plus-lg" ] []
                        ]
                    , button
                        [ title "Оновити список підрозділів"
                        , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-action text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw"
                        , onClick UnitsReloadClickedByUser
                        ]
                        [ i [ class "bi bi-arrow-clockwise" ] []
                        ]
                    ]
                ]
            , div [ class "grow-1 mt-4" ]
                (let
                    d =
                        Utils.findConnectedNetworks model.networkDialogUnitSelect.selected model.networks model.masterUnits
                 in
                 if List.length d > 0 then
                    [ span [ class "text-[var(--neutral-600)]" ] [ text <| String.fromInt (List.length d) ++ " співпадінь знайдено" ] ]
                        ++ List.map
                            (\network ->
                                let
                                    isActive =
                                        case mSelectedNetworkId of
                                            Just id ->
                                                id == network.id

                                            Nothing ->
                                                False
                                in
                                div
                                    [ class "w-full p-2  border-1 border-border rounded-sm text-text  pointer "
                                    , classList
                                        [ ( "bg-tag-selected border-1 border-border-selected text-black", isActive )
                                        , ( "hover-unmuted bg-tag", not isActive )
                                        ]
                                    , onClick <| NetworkAddToggleExistingId network.id
                                    ]
                                    [ NetworksUtils.renderNetwork network model.masterUnits
                                    ]
                            )
                            d
                        ++ [ div [ class "grid grid-cols-12 gap-[8px] mt-[8px]" ]
                                [ div [ class "flex flex-col gap-1 col-span-3" ]
                                    [ label [] [ text "Тип" ]
                                    , let
                                        selectedItem =
                                            (\item ->
                                                Select.basicMenuItem
                                                    { item = item
                                                    , label = NetworksUtils.networkKindToLabel item
                                                    }
                                            )
                                                model.addExistingKindSelect.selected

                                        defaultOptions =
                                            Le.Block.Select.defaultOptions shared.isDarkMode

                                        do2 =
                                            { defaultOptions | clearable = False }
                                      in
                                      Html.map NetworkAddExistingKindSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelectSingle
                                                (Just selectedItem)
                                                model.addExistingKindSelect.state
                                                model.addExistingKindSelect.items
                                                "жоден"
                                                do2
                                    ]
                                , div [ class "col-span-5" ]
                                    [ label [ class "mb-1" ] [ text "Вид передачі" ]
                                    , let
                                        selectedItem =
                                            Maybe.map
                                                (\item ->
                                                    Select.basicMenuItem
                                                        { item = item
                                                        , label =
                                                            RD.withDefault [] model.modulations
                                                                |> List.filter (\mod -> mod.id == item)
                                                                |> List.head
                                                                |> Maybe.map .name
                                                                |> Maybe.withDefault ""
                                                        }
                                                )
                                                model.addExistingModulationSelect.selected

                                        defaultOptions =
                                            Le.Block.Select.defaultOptions shared.isDarkMode

                                        do2 =
                                            { defaultOptions | clearable = False }
                                      in
                                      Html.map NetworkAddExistingModulationSelMsg <|
                                        Styled.toUnstyled <|
                                            Le.Block.Select.renderSelectSingle
                                                selectedItem
                                                model.addExistingModulationSelect.state
                                                model.addExistingModulationSelect.items
                                                "жоден"
                                                do2
                                    ]
                                , div [ class "row-start-2 col-span-12" ]
                                    [ span [] [ text "Обґрунтування прив'язки" ]
                                    , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
                                        [ textarea
                                            [ class "textarea__field"
                                            , placeholder "Введіть обґрунтування прив'язки"
                                            , value <| Maybe.withDefault "" model.addExistingConfirmationInp
                                            , onInput ConfirmationInputChangedByUser
                                            ]
                                            []
                                        ]
                                    ]
                                ]
                           ]

                 else
                    [ div [ class "w-full h-full flex justify-center items-center" ]
                        [ span [] [ text "Співпадінь не виявлено" ]
                        ]
                    ]
                )
            , div [ class "flex justify-end mb-2" ]
                []
            ]
        , div [ class "flex gap-2 justify-end border-t-1 pt-2 border-[var(--neutral-400)]" ]
            [ Button.new { label = "Назад", onClick = CloseAddNetworkSidebar } |> Button.withStyleSecondary |> Button.view
            , Button.new { label = "Створити нову мережу", onClick = NetworkStartCreatingFlow }
                |> Button.withDisabled (model.networkDialogUnitSelect.selected == Nothing)
                |> (\b ->
                        case mSelectedNetworkId of
                            Just id ->
                                Button.withStyleSecondary b

                            Nothing ->
                                b
                   )
                |> Button.view
            , case mSelectedNetworkId of
                Just id ->
                    Button.new { label = "Використати цю мережу", onClick = FreqAddToExistingNetwork freq id }
                        |> Button.withDisabled (model.networkDialogUnitSelect.selected == Nothing)
                        |> Button.view

                Nothing ->
                    text ""
            ]
        ]
    ]


viewEditConnectedNetwork : B.UpdateNetworkReq -> Model -> Shared.Model -> List (Html Msg)
viewEditConnectedNetwork editState model shared =
    [ h4 [] [ text "Редагування існуючої мережі" ]
    , div [ class "grid grid-cols-4  gap-y-2 gap-x-4" ]
        [ div [ class "col-span-2" ]
            [ label [ class "mb-1" ] [ text "Назва:*" ]
            , input
                [ class "form-control "
                , type_ "text"
                , value editState.name
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | name = v }
                ]
                []
            ]
        , div [ class "flex flex-col gap-1 col-span-1" ]
            [ label [] [ text "Тип" ]
            , let
                selectedItem =
                    (\item ->
                        Select.basicMenuItem
                            { item = item
                            , label =
                                NetworksUtils.networkKindToLabel item
                            }
                    )
                        model.editKindSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map NetworkEditKindSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelectSingle
                        (Just selectedItem)
                        model.editKindSelect.state
                        model.editKindSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "col-span-1" ]
            [ label [ class "mb-1" ] [ text "Вид передачі" ]
            , let
                selectedItem =
                    Maybe.map
                        (\item ->
                            Select.basicMenuItem
                                { item = item
                                , label =
                                    RD.withDefault [] model.modulations
                                        |> List.filter (\mod -> mod.id == item)
                                        |> List.head
                                        |> Maybe.map .name
                                        |> Maybe.withDefault ""
                                }
                        )
                        model.editModulationSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map NetworkEditModulationSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelectSingle
                        selectedItem
                        model.editModulationSelect.state
                        model.editModulationSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "col-span-2" ]
            [ label [ class "mb-1" ] [ text "Пости" ]
            , let
                selectedItems =
                    List.map
                        (\postId ->
                            Select.basicMenuItem
                                { item = postId
                                , label =
                                    RD.withDefault Dict.empty shared.posts
                                        |> Dict.get postId
                                        |> Maybe.map .name
                                        |> Maybe.withDefault ""
                                }
                        )
                        model.editPostsSelect.selected

                defaultOptions =
                    Le.Block.Select.defaultOptions shared.isDarkMode

                do2 =
                    { defaultOptions | clearable = False }
              in
              Html.map NetworkEditPostsSelMsg <|
                Styled.toUnstyled <|
                    Le.Block.Select.renderSelect
                        selectedItems
                        model.editPostsSelect.state
                        model.editPostsSelect.items
                        "жоден"
                        do2
            ]
        , div [ class "col-span-2" ]
            [ label [ class "mb-1" ] [ text "Локація" ]
            , input
                [ class "form-control"
                , type_ "text"
                , value <| editState.location
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | location = v }
                ]
                []
            ]
        , div [ class "col-span-2" ]
            [ label [ class "mb-1" ] [ text "Коментар" ]
            , input
                [ class "form-control"
                , value <| editState.comment
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | comment = v }
                ]
                []
            ]
        , div [ class "col-span-2" ]
            [ label [ class "mb-1" ] [ text "Радіостанція" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" editState.radioStation)
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | radioStation = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "типи радіостанцій, що використовуються підрозділом" ]
            ]

        -- , div [ class "col-span-2" ]
        --     [ label [ class "mb-1" ] [ text "Підтвердження" ]
        --     , input
        --         [ class "form-control"
        --         , value (Maybe.withDefault "" editState.confirmation)
        --         , onInput <|
        --             \v ->
        --                 NetworkEditMsg
        --                     { editState | confirmation = Just v }
        --         ]
        --         []
        --     , span [ class "text-sm  mt-1 text-[var(--neutral-600)]" ] [ text "р/о, сленг, сигнали управління або інші підтвердження приналежності р/м до підрозділу" ]
        --     ]
        , div [ class " col-span-2" ]
            [ label [ class "mb-1" ] [ text "Призначення" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" editState.purpose)
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | purpose = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]
        , div [ class " col-span-2" ]
            [ label [ class "mb-1" ] [ text "Характер роботи" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" editState.operationType)
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | operationType = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]
        , div [ class " col-span-2" ]
            [ label [ class "mb-1" ] [ text "Режим роботи радіомережі" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" editState.operationMode)
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | operationMode = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]
        , div [ class " col-span-2" ]
            [ label [ class "mb-1" ] [ text "Період функціонування" ]
            , input
                [ class "form-control"
                , value (Maybe.withDefault "" editState.operationPeriod)
                , onInput <|
                    \v ->
                        NetworkEditMsg
                            { editState | operationPeriod = Just v }
                ]
                []
            , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "поле для звіту еталонного опису радіомереж" ]
            ]

        -- , div [ class "col-span-4" ]
        --     [ label [ class "mb-1" ] [ text "Ознаки" ]
        --     , input
        --         [ class "form-control"
        --         , value (Maybe.withDefault "" editState.signs)
        --         , onInput <|
        --             \v ->
        --                 NetworkEditMsg
        --                     { editState | signs = Just v }
        --         ]
        --         []
        --     , span [ class "text-sm mt-1 text-[var(--neutral-600)]" ] [ text "розвід. ознаки підрозділу: сленг, сигнали управління, р/с, кодування місцевості, тощо" ]
        --     ]
        , div [ class "flex gap-2 justify-end col-span-4 mb-2" ]
            [ Button.new { label = "Відмінити", onClick = CloseAddNetworkSidebar } |> Button.withStyleSecondary |> Button.view
            , Button.new { label = "Зберегти", onClick = NetworkUpdate } |> Button.view
            ]
        ]
    ]
