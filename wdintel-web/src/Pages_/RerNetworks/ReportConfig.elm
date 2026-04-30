module Pages_.RerNetworks.ReportConfig exposing
    ( CommonReportSettings
    , ExtendedReportSettings
    , ReportContext
    , ReportType(..)
    , ReportTypeOption(..)
    , defaultCommonSettings
    , generateFileName
    , optionToReportType
    , reportTypeToOption
    , toApiEtalonkaType
    )

import Bindings as B
import Time
import Utils.Time


{-| Типи звітів
-}
type ReportType
    = AccordingToForm CommonReportSettings
    | ExtendedReport ExtendedReportSettings


{-| Опції для RadioGroup
-}
type ReportTypeOption
    = AccordingToFormOption
    | ExtendedReportOption


{-| Базові налаштування звіту
-}
type alias CommonReportSettings =
    { activeFreqsOnly : Bool
    , includeSigintSigns : Bool
    , includeConfirmation : Bool
    }


{-| Розширені налаштування звіту
-}
type alias ExtendedReportSettings =
    { common : CommonReportSettings
    , includeUnitCallsigns : Bool
    , includePelengsMap : Bool
    }


{-| Контекст для генерації імені файлу
-}
type alias ReportContext =
    { fromDate : Maybe Time.Posix
    , toDate : Maybe Time.Posix
    , zone : Time.Zone
    , networkId : Maybe Int
    }


{-| Налаштування за замовчуванням для базового звіту
-}
defaultCommonSettings : CommonReportSettings
defaultCommonSettings =
    { activeFreqsOnly = True
    , includeSigintSigns = True
    , includeConfirmation = True
    }


{-| Налаштування за замовчуванням для розширеного звіту
-}
defaultExtendedSettings : ExtendedReportSettings
defaultExtendedSettings =
    { common = defaultCommonSettings
    , includeUnitCallsigns = False
    , includePelengsMap = True
    }


{-| Конвертація типу звіту в опцію для RadioGroup
-}
reportTypeToOption : ReportType -> ReportTypeOption
reportTypeToOption reportType =
    case reportType of
        AccordingToForm _ ->
            AccordingToFormOption

        ExtendedReport _ ->
            ExtendedReportOption


{-| Конвертація опції RadioGroup в тип звіту
-}
optionToReportType : ReportTypeOption -> ReportType
optionToReportType option =
    case option of
        AccordingToFormOption ->
            AccordingToForm defaultCommonSettings

        ExtendedReportOption ->
            ExtendedReport defaultExtendedSettings


{-| Конвертація налаштувань звіту в API bindings
-}
toApiEtalonkaType : ReportType -> ReportContext -> B.EtalonkaReportType
toApiEtalonkaType reportType context =
    case reportType of
        AccordingToForm settings ->
            B.AccordingToTheForm
                { activeFreqsOnly = settings.activeFreqsOnly
                , includeSigintSigns = settings.includeSigintSigns
                , includeConfirmation = settings.includeConfirmation
                }

        ExtendedReport settings ->
            B.ExtendedReport
                { sinceDateInclusiveMs =
                    context.fromDate
                        |> Maybe.map Time.posixToMillis
                        |> Maybe.withDefault 0
                , tillDateInclusiveMs =
                    context.toDate
                        |> Maybe.map Time.posixToMillis
                , activeFreqsOnly = settings.common.activeFreqsOnly
                , includeUnitCallsigns = settings.includeUnitCallsigns
                , includeSigintSigns = settings.common.includeSigintSigns
                , includeConfirmation = settings.common.includeConfirmation
                , includePelengsMap = settings.includePelengsMap
                }


{-| Генерація імені файлу для звіту
-}
generateFileName : ReportContext -> String
generateFileName context =
    let
        extension =
            "docx"

        baseFileName =
            case context.networkId of
                Just networkId ->
                    "etalonka_network_" ++ String.fromInt networkId

                Nothing ->
                    "etalonka"

        withDates =
            case ( context.fromDate, context.toDate ) of
                ( Just fromDate, Just toDate ) ->
                    baseFileName
                        ++ "_"
                        ++ Utils.Time.renderDateTimeF6 context.zone fromDate
                        ++ "_"
                        ++ Utils.Time.renderDateTimeF6 context.zone toDate

                ( Just fromDate, Nothing ) ->
                    baseFileName
                        ++ "_"
                        ++ Utils.Time.renderDateTimeF6 context.zone fromDate

                _ ->
                    baseFileName
    in
    withDates ++ "." ++ extension
