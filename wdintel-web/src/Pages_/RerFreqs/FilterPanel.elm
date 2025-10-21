module Pages_.RerFreqs.FilterPanel exposing (view)

import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Pages_.RerFreqs.Model exposing (Model, NetworkWorkflowStatus(..), TextLocation(..))
import Pages_.RerFreqs.Msg exposing (Msg(..))
import Pages_.RerFreqs.Utils as Utils
import Select
import Shared
import Shared.Components.Button as Button
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Spinner
import Shared.Components.Toggle as Toggle
import Shared.Model exposing (isDarkMode)
import Utils.RemoteData as RD exposing (RemoteData(..))
import Utils.Select
import Utils.Utils exposing (..)


view : Shared.Model -> Model -> Html Msg
view shared model =
    let
        filterState =
            model.filterState

        -- Check if any filters are active
        hasActiveFilters =
            (filterState.freq /= "")
                || (filterState.unit /= "")
                || not (List.isEmpty filterState.callsigns)
                || model.showOnlyInvestigating

        -- Count active filters
        activeFilterCount =
            [ filterState.freq /= ""
            , filterState.unit /= ""
            , not (List.isEmpty filterState.callsigns)
            , model.showOnlyInvestigating
            ]
                |> List.filter identity
                |> List.length

        tabFiltersCallsigns =
            let
                -- Get available callsigns from search results
                availableCallsigns =
                    case model.callsignSearchResults of
                        Success callsigns ->
                            List.map .callsign callsigns
                        
                        _ ->
                            []
                
                -- Create menu items from available callsigns
                menuItems =
                    List.map
                        (\callsign ->
                            Select.basicMenuItem
                                { item = callsign
                                , label = callsign
                                }
                        )
                        availableCallsigns
                
                -- Selected items (currently filtered callsigns)
                selectedItems =
                    List.map
                        (\callsign ->
                            Select.basicMenuItem
                                { item = callsign
                                , label = callsign
                                }
                        )
                        filterState.callsigns
            in
            div
                [ style "font-size" ".8rem"
                , style "min-width" "330px"
                ]
                [ Html.map SelCallsignMsg
                    (Styled.toUnstyled <|
                        Utils.Select.renderSelectVirtual
                            selectedItems
                            model.selCallsignState
                            menuItems
                            "Почніть вводити позивний..."
                            { loading = RD.isLoading model.callsignSearchResults, disabled = False, isDark = isDarkMode shared.themeMode }
                    )
                ]
    in
    div [ class "flex flex-col gap-3" ]
        [ -- Title and Clear button row
          div [ class "d-flex justify-content-between align-items-center" ]
            [ div [ class "flex items-center gap-2" ]
                [ if model.loading then
                    Shared.Components.Spinner.loadingSpinner2Sm

                  else
                    i [ class "bi bi-filter text-lg" ] []
                , h5 [ class "fw-bold mb-0 text-gray-900 dark:text-gray-100" ] [ text "Фільтри" ]
                , if activeFilterCount > 0 then
                    span
                        [ class "ml-1 inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200" ]
                        [ text (String.fromInt activeFilterCount) ]

                  else
                    text ""
                ]
            , div
                [ class "d-flex align-items-center cursor-pointer text-secondary hover:text-gray-700"
                , onClick ClearAllFilters
                , attribute "title"
                    (if hasActiveFilters then
                        "Скинути всі фільтри (" ++ String.fromInt activeFilterCount ++ ")"

                     else
                        "Немає активних фільтрів"
                    )
                ]
                [ span [ class "me-1" ] [ text "Очистити" ]
                , i [ class "bi bi-x", style "font-size" "1.2rem" ] []
                ]
            ]
        , div [ class "flex flex-col gap-2" ]
            [ div [ class "flex justify-start items-center gap-2" ]
                [ input
                    [ class "form-input w-48"
                    , type_ "text"
                    , placeholder "частота"
                    , value model.filterState.freq
                    , onInput <| \v -> FilterStateMsg { filterState | freq = v }
                    ]
                    []
                , input
                    [ class "form-input w-48"
                    , type_ "text"
                    , placeholder "підрозділ"
                    , value model.filterState.unit
                    , onInput <| \v -> FilterStateMsg { filterState | unit = v }
                    ]
                    []
                , button
                    [ class "px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
                    , onClick ToggleSidebar
                    , attribute "title"
                        (if model.showSidebar then
                            "Сховати підрозділи"

                         else
                            "Показати підрозділи"
                        )
                    ]
                    [ text "Підрозділи" ]
                , tabFiltersCallsigns
                ]
            ]
        ]
