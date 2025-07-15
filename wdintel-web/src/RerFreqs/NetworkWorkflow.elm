module RerFreqs.NetworkWorkflow exposing (view)

import Bindings as B
import Bytes exposing (Bytes)
import Components.Button as Button
import Components.Checkbox as Checkbox
import Components.Toggle as Toggle
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
import RerFreqs.Model exposing (FilterName(..), Model, NetworkWorkflowStatus(..), TextLocation(..))
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
    case model.networkWorkflowStatus of
        NotStarted ->
            []

        _ ->
            renderNetworkSidebar model shared


renderNetworkSidebar : Model -> Shared.Model -> List (Html Msg)
renderNetworkSidebar model shared =
    [ div [ class "p-4 w-full flex flex-col overflow-y-auto min-h-[80vh] max-h-screen" ]
        (case model.networkWorkflowStatus of
            SelectingNetwork freq searchState ->
                h3 [ class "mb-[16px]!" ] [ text ("Прив'язка мережі до частоти " ++ freq) ]
                    :: viewSelectingNetwork freq searchState model shared

            NotStarted ->
                []
        )
    ]


viewSelectingNetwork : String -> Maybe Int -> Model -> Shared.Model -> List (Html Msg)
viewSelectingNetwork freq selectedNetworkId model shared =
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
                                    [ a [ class "bi bi-pencil cursor-pointer text-action hover:text-action-hovered text-[16px]", Attr.title "редагувати", Route.href { path = Route.Path.RerNetworks_Id_ { id = String.fromInt network_.id }, query = Dict.empty, hash = Nothing }, target "_blank" ] [ i [] [] ]
                                    , i [ class "bi bi-trash cursor-pointer text-[#b94d4d] dark:text-[#f98282] dark:hover:text-[#df7474]  text-[16px]", Attr.title "видалити", onClick <| FreqRemoveFromExistingNetwork freq network_ ] []
                                    ]
                                ]
                        )
          in
          HtmlX.viewIf (List.length networksWithThisFreq > 0) <|
            div [ class "mb-2" ]
                [ h5 [ class "" ] [ text ("Уже прив'язані до " ++ freq) ]
                , div [ class "flex flex-col gap-[4px]" ] networksWithThisFreqBlock
                ]
        , let
            -- Get networks already connected to this frequency
            alreadyConnectedNetworkIds =
                ListX.find (\freq_ -> freq_.freq == freq) model.freqs
                    |> Maybe.map .networkIds
                    |> Maybe.withDefault []

            -- Filter out networks that are already connected to this frequency
            filterOutAlreadyConnected networks =
                List.filter (\n -> not (List.member n.id alreadyConnectedNetworkIds)) networks

            networksToShow =
                if model.showNetworksWithoutUnit then
                    -- Show ONLY networks without units when checkbox is checked
                    Dict.values model.networks
                        |> List.filter (\n -> Maybe.withDefault [] n.unitIds == [])
                        |> filterOutAlreadyConnected

                else
                    -- Show only networks with selected unit when checkbox is unchecked
                    case model.networkDialogUnitSelect.selected of
                        Just unitId ->
                            Dict.values model.networks
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
                                    , label = Unit.unitName model.masterUnits unitId
                                    }
                            )
              in
              let
                options =
                    Le.Block.Select.defaultOptions shared.isDarkMode
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
                    , button
                        [ Attr.title "Оновити список підрозділів"
                        , class "outline-0! border-1! border-border rounded-sm! bg-transparent text-action text-[21px]! transition-colors duration-350 hover:bg-action! hover:text-bw  py-[1px] px-[6px]"
                        , onClick UnitsReloadClickedByUser
                        ]
                        [ i [ class "bi bi-arrow-clockwise" ] []
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
                        (List.map (\network -> renderNetworkSelectionItem network selectedNetworkId model.masterUnits) networksToShow)
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
            , a
                [ class "inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-action border border-transparent rounded-md hover:bg-[var(--teal-blue-normal-hover)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--teal-blye-normal-active)]"
                , Route.href { path = Route.Path.RerNetworks_Create, hash = Nothing, query = Dict.fromList [ ( "freq", freq ) ] }
                , target "_blank"
                ]
                [ text "Створити нову мережу" ]
            , case selectedNetworkId of
                Just id ->
                    Button.new { label = "Використати цю мережу", onClick = FreqAddToExistingNetwork freq id }
                        |> Button.withDisabled (model.networkDialogUnitSelect.selected == Nothing && not model.showNetworksWithoutUnit)
                        |> Button.view

                Nothing ->
                    text ""
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
