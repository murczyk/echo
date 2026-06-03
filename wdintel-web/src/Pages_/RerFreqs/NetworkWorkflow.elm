module Pages_.RerFreqs.NetworkWorkflow exposing (view)

import Bindings as B
import Core.Unit as Unit
import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Html.Styled as Styled
import List.Extra as ListX
import Pages_.RerFreqs.Model exposing (Model, NetworkWorkflowStatus(..))
import Pages_.RerFreqs.Msg exposing (Msg(..))
import Route
import Route.Path
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.Spinner
import Shared.Components.Toggle as Toggle
import Shared.Model exposing (isDarkMode)
import Utils.NetworksUtils as NetworksUtils
import Utils.RerNetworkDetails
import Utils.RemoteData as RemoteData
import Utils.Select


view : Model -> Shared.Model -> Dict Int B.Network -> List (Html Msg)
view model shared networks =
    case model.networkWorkflowStatus of
        NotStarted ->
            []

        _ ->
            renderNetworkSidebar model shared networks


renderNetworkSidebar : Model -> Shared.Model -> Dict Int B.Network -> List (Html Msg)
renderNetworkSidebar model shared networks =
    [ div [ class "p-4 w-full flex flex-col overflow-y-auto min-h-[80vh] max-h-screen" ]
        (case model.networkWorkflowStatus of
            SelectingNetwork freq searchState ->
                let
                    tabButton tab label =
                        button
                            [ onClick (NetworkWorkflowTabClicked tab)
                            , class "px-4 py-2 text-sm font-medium border-b-2"
                            , classList [ ( "border-primary text-primary", model.networkWorkflowTab == tab ), ( "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300", model.networkWorkflowTab /= tab ) ]
                            ]
                            [ text label ]
                in
                [ h3 [ class "mb-4 font-semibold" ] [ text ("Прив'язка до частоти: " ++ freq) ]
                , div [ class "border-b border-gray-200" ]
                    [ nav [ class "-mb-px flex space-x-8" ]
                        [ tabButton Pages_.RerFreqs.Model.Search "Пошук та прив'язка"
                        , tabButton Pages_.RerFreqs.Model.Manage ("Уже прив'язані (" ++ String.fromInt (List.length (getLinkedNetworks freq model networks)) ++ ")")
                        ]
                    ]
                ]
                    ++ (case model.networkWorkflowTab of
                            Pages_.RerFreqs.Model.Search ->
                                viewSelectingNetwork freq searchState model shared networks

                            Pages_.RerFreqs.Model.Manage ->
                                viewManagingLinks freq model shared networks
                       )

            NotStarted ->
                []
        )
    ]


getLinkedNetworks : String -> Model -> Dict Int B.Network -> List B.Network
getLinkedNetworks freq model networks =
    ListX.find (\f -> f.freq == freq) model.freqs
        |> Maybe.map .networkIds
        |> Maybe.map (List.filterMap (\id -> Dict.get id networks))
        |> Maybe.withDefault []


viewManagingLinks : String -> Model -> Shared.Model -> Dict Int B.Network -> List (Html Msg)
viewManagingLinks freq model shared networks =
    let
        linkedNetworks =
            getLinkedNetworks freq model networks
    in
    [ div [ class "py-4" ]
        [ p [ class "text-sm text-gray-600 mb-4" ] [ text "Ця частота прив'язана до наступних мереж. Натисніть на олівець, щоб перейти до редагування мережі." ]
        , if List.isEmpty linkedNetworks then
            div [ class "text-center py-8" ] [ text "До цієї частоти не прив'язано жодної мережі." ]

          else
            div [ class "space-y-2" ]
                (List.map
                    (\network_ ->
                        div
                            [ class "w-full p-2  border border-border rounded-sm text-text flex justify-between items-center"
                            ]
                            [ case shared.masterUnits of
                                RemoteData.Success units ->
                                    NetworksUtils.renderNetwork network_ units

                                _ ->
                                    text "Завантаження..."
                            , div [ class "flex gap-2" ]
                                [ a
                                    [ class "text-blue-500 hover:underline"
                                    , Route.href
                                        { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network_.id }
                                        , query = Utils.RerNetworkDetails.query shared.rerNetworkDetailsPreferredView
                                        , hash = Nothing
                                        }
                                    , target "_blank"
                                    ]
                                    [ i [ class "bi bi-pencil" ] [] ]
                                , button [ class "text-red-500 hover:underline", onClick (FreqRemoveFromExistingNetwork freq network_) ] [ i [ class "bi bi-trash" ] [] ]
                                ]
                            ]
                    )
                    linkedNetworks
                )
        ]
    ]


viewSelectingNetwork : String -> Maybe Int -> Model -> Shared.Model -> Dict Int B.Network -> List (Html Msg)
viewSelectingNetwork freq selectedNetworkId model shared networks =
    [ div [ class "flex flex-col grow relative" ]
        [ HtmlX.viewIf model.networkAddLoading <|
            span [ class "absolute top-[50%] left-[50%] -translate-1/2" ] [ Shared.Components.Spinner.loadingSpinner ]
        , p [ class "text-sm text-gray-600 my-4" ] [ text "Виберіть підрозділ, щоб знайти існуючі мережі, або створіть нову." ]
        , let
            -- Get networks already connected to this frequency
            alreadyConnectedNetworkIds =
                ListX.find (\freq_ -> freq_.freq == freq) model.freqs
                    |> Maybe.map .networkIds
                    |> Maybe.withDefault []

            -- Filter out networks that are already connected to this frequency
            filterOutAlreadyConnected networksList =
                List.filter (\n -> not (List.member n.id alreadyConnectedNetworkIds)) networksList

            networksToShow =
                if model.showNetworksWithoutUnit then
                    -- Show ONLY networks without units when checkbox is checked
                    Dict.values networks
                        |> List.filter (\n -> Maybe.withDefault [] n.unitIds == [])
                        |> filterOutAlreadyConnected

                else
                    -- Show only networks with selected unit when checkbox is unchecked
                    case model.networkDialogUnitSelect.selected of
                        Just unitId ->
                            Dict.values networks
                                |> List.filter (\n -> List.member unitId (Maybe.withDefault [] n.unitIds))
                                |> filterOutAlreadyConnected

                        Nothing ->
                            []
          in
          div [ class "min-h-[200px] flex flex-col" ]
            [ let
                selectItem =
                    model.networkDialogUnitSelect.selected
                        |> Maybe.map
                            (\unitId ->
                                Select.basicMenuItem
                                    { item = unitId
                                    , label =
                                        case shared.masterUnits of
                                            RemoteData.Success units ->
                                                Unit.unitName units unitId

                                            _ ->
                                                "Завантаження..."
                                    }
                            )

                options =
                    Utils.Select.defaultOptions (isDarkMode shared.themeMode)
              in
              div [ class "flex gap-[8px]" ]
                [ div [ class "grow-1" ]
                    [ h5 [] [ text "Пошук існуючих мереж по підрозділу" ]
                    , Html.map NetworkAddUnitSelMsg <|
                        Styled.toUnstyled <|
                            Utils.Select.renderSelectSingle
                                selectItem
                                model.networkDialogUnitSelect.state
                                model.networkDialogUnitSelect.items
                                "почніть вводити назву підрозділу"
                                { options | disabled = model.showNetworksWithoutUnit }
                    ]
                , div [ class "flex gap-[4px] items-end" ]
                    [ a
                        [ Attr.title "Додати новий підрозділ"
                        , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw! py-[1px] px-[6px]"
                        , Route.href { path = Route.Path.RerUnits, query = Dict.empty, hash = Nothing }
                        , target "_blank"
                        ]
                        [ i [ class "bi bi-plus-lg" ] []
                        ]
                    ]
                ]
            , div [ class "flex items-center gap-2 mb-4 mt-2" ]
                [ Toggle.new
                    { onToggle = NetworkSearchWithoutUnitToggle
                    , label = "В дорозвідці (показати мережі без підрозділу)"
                    , id = "network-search-without-unit-toggle"
                    }
                    |> Toggle.view model.showNetworksWithoutUnit
                ]
            , div [ class "grow-1 mt-4" ]
                (if List.length networksToShow > 0 then
                    [ span [ class "text-[var(--neutral-600)]" ] [ text <| String.fromInt (List.length networksToShow) ++ " мереж знайдено" ]
                    , div [ class "flex flex-col gap-[4px] mt-2" ]
                        (case shared.masterUnits of
                            RemoteData.Success units ->
                                List.map (\network -> renderNetworkSelectionItem network selectedNetworkId units) networksToShow

                            _ ->
                                []
                        )
                    ]

                 else
                    [ div [ class "w-full h-full flex justify-center items-center" ]
                        [ span [] [ text "Співпадінь не виявлено" ]
                        ]
                    ]
                )
            , div [ class "flex justify-start mb-2 mt-4 border-t pt-4" ]
                [ div [ class "flex flex-col items-end gap-4 w-full" ]
                    [ Button.new { label = "Використати цю мережу", onClick = FreqAddToExistingNetwork freq (Maybe.withDefault 0 selectedNetworkId) }
                        |> Button.withDisabled (selectedNetworkId == Nothing)
                        |> Button.view
                    , a [ class "text-sm text-blue-600 hover:underline", Route.href { path = Route.Path.RerNetworks_Create, hash = Nothing, query = Dict.fromList [ ( "freq", freq ) ] }, target "_blank" ]
                        [ text "Не знайшли потрібну мережу? Створити нову" ]
                    ]
                ]
            ]
        ]
    ]


renderNetworkSelectionItem : B.Network -> Maybe Int -> Dict Int B.Unit -> Html Msg
renderNetworkSelectionItem network selectedNetworkId masterUnits =
    let
        isActive =
            case selectedNetworkId of
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
        [ NetworksUtils.renderNetwork network masterUnits
        ]
