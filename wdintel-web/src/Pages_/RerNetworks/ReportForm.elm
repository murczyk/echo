module Pages_.RerNetworks.ReportForm exposing
    ( Config
    , view
    )

import Html exposing (..)
import Html.Attributes exposing (..)
import Pages_.RerNetworks.ReportConfig as ReportConfig exposing (ReportType(..), ReportTypeOption(..))
import Shared.Components.Checkbox as Checkbox
import Shared.Components.DateTime
import Shared.Components.RadioGroup as RadioGroup


{-| Конфігурація для форми звіту
-}
type alias Config msg =
    { onReportTypeChanged : ReportTypeOption -> msg
    , onActiveFreqsOnlyChanged : Bool -> msg
    , onIncludeSigintSignsChanged : Bool -> msg
    , onIncludeConfirmationChanged : Bool -> msg
    , onIncludeUnitCallsignsChanged : Bool -> msg
    , onIncludePelengsMapChanged : Bool -> msg
    , reportFromDate : Maybe Shared.Components.DateTime.Model
    , reportToDate : Maybe Shared.Components.DateTime.Model
    , onReportFromDateMsg : Maybe (Shared.Components.DateTime.Msg msg -> msg)
    , onReportToDateMsg : Maybe (Shared.Components.DateTime.Msg msg -> msg)
    , showDateRange : Bool
    }


{-| Селектор типу звіту
-}
typeSelector : ReportType -> Config msg -> Html msg
typeSelector currentReport config =
    let
        currentType =
            ReportConfig.reportTypeToOption currentReport

        options =
            [ ( AccordingToFormOption, "Згідно форми" )
            , ( ExtendedReportOption, "Розширений звіт" )
            ]

        onRadioChange selectedOption =
            config.onReportTypeChanged selectedOption
    in
    div [ class "mb-4" ]
        [ RadioGroup.new "report-type" options currentType onRadioChange
            |> RadioGroup.view
        ]


{-| Форма налаштувань звіту
-}
settingsForm : Config msg -> ReportType -> Html msg
settingsForm config reportType =
    case reportType of
        AccordingToForm settings ->
            standardForm config settings

        ExtendedReport settings ->
            extendedForm config settings


{-| Стандартна форма
-}
standardForm : Config msg -> ReportConfig.CommonReportSettings -> Html msg
standardForm config settings =
    div [ class "grid grid-cols-2 gap-6 min-h-[281px]" ]
        [ -- Left column: Basic settings
          div [ class "border rounded-lg p-4" ]
            [ h4 [ class "text-lg font-medium mb-3 text-gray-900 dark:text-gray-100" ] [ text "Основні налаштування" ]
            , div [ class "space-y-3" ]
                [ commonSettingsView config settings
                ]
            ]
        , -- Right column: Empty for standard form
          div [ class "border rounded-lg p-4 bg-gray-50 dark:bg-gray-800 opacity-50" ]
            [ h4 [ class "text-lg font-medium mb-3 text-gray-500" ] [ text "Додаткові опції" ]
            , p [ class "text-sm text-gray-500" ] [ text "Доступні тільки в розширеному звіті" ]
            ]
        ]


{-| Розширена форма
-}
extendedForm : Config msg -> ReportConfig.ExtendedReportSettings -> Html msg
extendedForm config settings =
    div [ class "grid grid-cols-2 gap-6 min-h-[281px]" ]
        [ -- Left column: Basic settings
          div [ class "border rounded-lg p-4" ]
            [ h4 [ class "text-lg font-medium mb-3 text-gray-900 dark:text-gray-100" ] [ text "Основні налаштування" ]
            , div [ class "space-y-3" ]
                [ commonSettingsView config settings.common
                ]
            ]
        , -- Right column: Additional options
          div [ class "border rounded-lg p-4" ]
            [ h4 [ class "text-lg font-medium mb-3 text-gray-900 dark:text-gray-100" ] [ text "Додаткові опції" ]
            , div [ class "space-y-4" ]
                [ -- Date range section (if enabled)
                  if config.showDateRange then
                    dateRangeSection config

                  else
                    text ""
                , -- Extended checkboxes section
                  div [ class "space-y-2" ]
                    [ extendedSettingsView config settings
                    ]
                ]
            ]
        ]


{-| Компоненти для базових налаштувань
-}
commonSettingsView : Config msg -> ReportConfig.CommonReportSettings -> Html msg
commonSettingsView config settings =
    div [ class "space-y-3" ]
        [ Checkbox.new
            { isChecked = settings.activeFreqsOnly
            , onToggle = config.onActiveFreqsOnlyChanged
            }
            |> Checkbox.withContent [ text "Лише активні частоти" ]
            |> Checkbox.view
        , Checkbox.new
            { isChecked = settings.includeSigintSigns
            , onToggle = config.onIncludeSigintSignsChanged
            }
            |> Checkbox.withContent [ text "Включити сигнали" ]
            |> Checkbox.view
        , Checkbox.new
            { isChecked = settings.includeConfirmation
            , onToggle = config.onIncludeConfirmationChanged
            }
            |> Checkbox.withContent [ text "Включити підтвердження" ]
            |> Checkbox.view
        ]


{-| Компоненти для розширених налаштувань
-}
extendedSettingsView : Config msg -> ReportConfig.ExtendedReportSettings -> Html msg
extendedSettingsView config settings =
    div [ class "space-y-2" ]
        [ Checkbox.new
            { isChecked = settings.includeUnitCallsigns
            , onToggle = config.onIncludeUnitCallsignsChanged
            }
            |> Checkbox.withContent [ text "Включити позивні підрозділів" ]
            |> Checkbox.view
        , Checkbox.new
            { isChecked = settings.includePelengsMap
            , onToggle = config.onIncludePelengsMapChanged
            }
            |> Checkbox.withContent [ text "Включити карту пеленгів" ]
            |> Checkbox.view
        ]


{-| Секція вибору дат
-}
dateRangeSection : Config msg -> Html msg
dateRangeSection config =
    case config.reportFromDate of
        Just fromDateModel ->
            case config.reportToDate of
                Just toDateModel ->
                    case config.onReportFromDateMsg of
                        Just onFromDateMsg ->
                            case config.onReportToDateMsg of
                                Just onToDateMsg ->
                                    div []
                                        [ div [ class "space-y-2" ]
                                            [ div []
                                                [ span [ class "text-sm font-medium w-8" ] [ text "Від:" ]
                                                , div [ class "flex gap-1" ]
                                                    (Shared.Components.DateTime.new
                                                        { model = fromDateModel
                                                        , toMsg = onFromDateMsg
                                                        }
                                                        |> Shared.Components.DateTime.view
                                                    )
                                                ]
                                            , div [ class "" ]
                                                [ span [ class "text-sm font-medium w-8" ] [ text "До:" ]
                                                , div [ class "flex gap-1" ]
                                                    (Shared.Components.DateTime.new
                                                        { model = toDateModel
                                                        , toMsg = onToDateMsg
                                                        }
                                                        |> Shared.Components.DateTime.view
                                                    )
                                                ]
                                            ]
                                        ]

                                Nothing ->
                                    text ""

                        Nothing ->
                            text ""

                Nothing ->
                    text ""

        Nothing ->
            text ""


{-| Головна функція для відображення всієї форми
-}
view : Config msg -> ReportType -> Html msg
view config reportType =
    div [ class "space-y-4" ]
        [ typeSelector reportType config
        , settingsForm config reportType
        ]
