module Pages_.RerNetworks.ReportUpdate exposing
    ( createReportDownloadEffect
    , handleReportDownloadResponse
    , updateCommonSetting
    , updateExtendedSetting
    , updateReportFromForm
    )

import Bytes exposing (Bytes)
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import File.Download as Download
import Pages_.RerNetworks.ReportConfig as ReportConfig exposing (ReportContext, ReportType(..), ReportTypeOption)
import Utils.Api.ErrorHandling


{-| Оновлення типу звіту
-}
updateReportFromForm : ReportTypeOption -> ReportType
updateReportFromForm option =
    ReportConfig.optionToReportType option


{-| Оновлення налаштування "Лише активні частоти"
-}
updateCommonSetting : String -> Bool -> ReportType -> ReportType
updateCommonSetting settingName checked currentReport =
    case ( settingName, currentReport ) of
        ( "activeFreqsOnly", AccordingToForm settings ) ->
            AccordingToForm { settings | activeFreqsOnly = checked }

        ( "includeSigintSigns", AccordingToForm settings ) ->
            AccordingToForm { settings | includeSigintSigns = checked }

        ( "includeConfirmation", AccordingToForm settings ) ->
            AccordingToForm { settings | includeConfirmation = checked }

        ( "includeHeadingsAndFreqs", AccordingToForm settings ) ->
            AccordingToForm { settings | includeHeadingsAndFreqs = checked }

        ( "activeFreqsOnly", ExtendedReport settings ) ->
            let
                newCommon =
                    { activeFreqsOnly = checked
                    , includeSigintSigns = settings.common.includeSigintSigns
                    , includeConfirmation = settings.common.includeConfirmation
                    , includeHeadingsAndFreqs = settings.common.includeHeadingsAndFreqs
                    }
            in
            ExtendedReport { settings | common = newCommon }

        ( "includeSigintSigns", ExtendedReport settings ) ->
            let
                newCommon =
                    { activeFreqsOnly = settings.common.activeFreqsOnly
                    , includeSigintSigns = checked
                    , includeConfirmation = settings.common.includeConfirmation
                    , includeHeadingsAndFreqs = settings.common.includeHeadingsAndFreqs
                    }
            in
            ExtendedReport { settings | common = newCommon }

        ( "includeConfirmation", ExtendedReport settings ) ->
            let
                newCommon =
                    { activeFreqsOnly = settings.common.activeFreqsOnly
                    , includeSigintSigns = settings.common.includeSigintSigns
                    , includeConfirmation = checked
                    , includeHeadingsAndFreqs = settings.common.includeHeadingsAndFreqs
                    }
            in
            ExtendedReport { settings | common = newCommon }

        ( "includeHeadingsAndFreqs", ExtendedReport settings ) ->
            let
                newCommon =
                    { activeFreqsOnly = settings.common.activeFreqsOnly
                    , includeSigintSigns = settings.common.includeSigintSigns
                    , includeConfirmation = settings.common.includeConfirmation
                    , includeHeadingsAndFreqs = checked
                    }
            in
            ExtendedReport { settings | common = newCommon }

        _ ->
            currentReport


{-| Оновлення розширених налаштувань
-}
updateExtendedSetting : String -> Bool -> ReportType -> ReportType
updateExtendedSetting settingName checked currentReport =
    case ( settingName, currentReport ) of
        ( "includeUnitCallsigns", ExtendedReport settings ) ->
            ExtendedReport { settings | includeUnitCallsigns = checked }

        ( "includePelengsMap", ExtendedReport settings ) ->
            ExtendedReport { settings | includePelengsMap = checked }

        _ ->
            currentReport


{-| Створення ефекту для завантаження звіту
-}
createReportDownloadEffect :
    ReportType
    -> ReportContext
    -> (ReportType -> ReportContext -> Effect msg)
    -> Effect msg
createReportDownloadEffect reportType context apiCall =
    apiCall reportType context


{-| Обробка відповіді завантаження звіту
-}
handleReportDownloadResponse :
    Result ApiError Bytes
    -> ReportContext
    -> (Bool -> model -> model)
    -> model
    -> ( model, Effect msg )
handleReportDownloadResponse result context updateDownloadingState model =
    case result of
        Err e ->
            ( updateDownloadingState False model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка генерації звіту" e
            )

        Ok bytes ->
            let
                updatedModel =
                    updateDownloadingState False model

                fileName =
                    ReportConfig.generateFileName context

                mimeType =
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            in
            ( updatedModel
            , E.sendCmd <| Download.bytes fileName mimeType bytes
            )
