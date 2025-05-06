module Api exposing (..)

import Bindings exposing (..)
import Bytes exposing (Bytes)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import Http
import Json.Decode as Decode
import Json.Encode as Encode
import Le.Block.Toast
import Le.Types exposing (ApiError, ModelWithErrorFields)
import Le.Utils exposing (..)
import Temp exposing (jsonPair, leExpectJson, resolve)
import Url.Builder


handleHttpError :
    (Le.Block.Toast.Msg -> msg)
    -> ApiError
    -> ModelWithErrorFields model
    -> ( ModelWithErrorFields model, Effect msg )
handleHttpError toMsg e m =
    case e.httpError of
        Http.BadStatus code ->
            case code of
                401 ->
                    ( m, E.logout )

                -- 403 ->
                --     ( m, Ports.needLoginRedirect () )
                _ ->
                    case Dict.toList e.formErrors of
                        [] ->
                            case e.errors of
                                [] ->
                                    ( { m | formErrors = e.formErrors }
                                    , E.sendCmd <| Le.Block.Toast.addError toMsg "There was an error, please try again later"
                                    )

                                es ->
                                    ( { m | formErrors = e.formErrors }
                                    , E.sendCmd <| Le.Block.Toast.addErrors toMsg es
                                    )

                        _ ->
                            ( { m | formErrors = e.formErrors }
                            , E.none
                            )

        Http.BadBody badBody ->
            ( m
            , E.sendCmd <|
                Cmd.batch
                    [ Le.Block.Toast.addError toMsg "There was an error, please try again later"
                    , logError ("Bad Body: " ++ badBody) (toMsg << always Le.Block.Toast.NoOp)
                    ]
            )

        _ ->
            ( m
            , E.sendCmd <| Le.Block.Toast.addError toMsg "There was an error, please try again later"
            )


handleHttpError2 :
    (Le.Block.Toast.Msg -> msg)
    -> ApiError
    ->
        { formErrors : Dict String String
        , cmds : Effect msg
        }
handleHttpError2 toMsg e =
    case e.httpError of
        Http.BadStatus code ->
            case code of
                401 ->
                    { formErrors = e.formErrors, cmds = E.logout }

                -- 403 ->
                --     ( m, Ports.needLoginRedirect () )
                _ ->
                    case Dict.toList e.formErrors of
                        [] ->
                            case e.errors of
                                [] ->
                                    { formErrors = e.formErrors
                                    , cmds = E.sendCmd <| Le.Block.Toast.addError toMsg "There was an error, please try again later"
                                    }

                                es ->
                                    { formErrors = e.formErrors
                                    , cmds = E.sendCmd <| Le.Block.Toast.addErrors toMsg es
                                    }

                        _ ->
                            { formErrors = e.formErrors
                            , cmds = E.none
                            }

        Http.BadBody badBody ->
            { formErrors = Dict.empty
            , cmds =
                E.sendCmd <|
                    Cmd.batch
                        [ Le.Block.Toast.addError toMsg "There was an error, please try again later"
                        , logError ("Bad Body: " ++ badBody) (toMsg << always Le.Block.Toast.NoOp)
                        ]
            }

        _ ->
            { formErrors = Dict.empty
            , cmds = E.sendCmd <| Le.Block.Toast.addError toMsg "There was an error, please try again later"
            }


logError : String -> (Result ApiError () -> msg) -> Cmd msg
logError msg toMsg =
    Http.get
        { url =
            Url.Builder.absolute
                [ "api"
                , "log-error.json"
                ]
                [ Url.Builder.string "msg" msg ]
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


api_user :
    (Result ApiError User -> msg)
    -> Cmd msg
api_user toMsg =
    Http.get
        { url = "/api/user"
        , expect = leExpectJson toMsg userDecoder
        }


importer_download_kmz :
    (Result ApiError Bytes -> msg)
    -> DownloadKmzReq
    -> Cmd msg
importer_download_kmz toMsg req =
    Http.post
        { url = "/api/importer/download/operatyvka.kmz"
        , body = Http.jsonBody (downloadKmzReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


importer_download_geojson :
    (Result ApiError Bytes -> msg)
    -> DownloadKmzReq
    -> Cmd msg
importer_download_geojson toMsg req =
    Http.post
        { url = "/api/delta/download/operatyvka.geojson"
        , body = Http.jsonBody (downloadKmzReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


upload_screenshot :
    File.File
    -> (Result ApiError UploadScreenshotRes -> msg)
    -> Cmd msg
upload_screenshot file toMsg =
    Http.request
        { method = "PUT"
        , headers = []
        , url = "/api/terminal/upload-screenshot"
        , body = Http.multipartBody [ Http.filePart "image" file ]

        -- , body = Http.fileBody file
        , expect = leExpectJson toMsg uploadScreenshotResDecoder
        , timeout = Nothing
        , tracker = Nothing
        }


upload_screenshot_bytes :
    Bytes
    -> (Result ApiError UploadScreenshotRes -> msg)
    -> Cmd msg
upload_screenshot_bytes bytes toMsg =
    Http.request
        { method = "PUT"
        , headers = []
        , url = "/api/terminal/upload-screenshot"
        , body = Http.multipartBody [ Http.bytesPart "image" "image/png" bytes ]
        , expect = leExpectJson toMsg uploadScreenshotResDecoder
        , timeout = Nothing
        , tracker = Nothing
        }


upload_pdf :
    File.File
    -> (Result ApiError UploadPdfRes -> msg)
    -> Cmd msg
upload_pdf file toMsg =
    Http.request
        { method = "PUT"
        , headers = []
        , url = "/api/terminal/upload-pdf"
        , body = Http.multipartBody [ Http.filePart "image" file ]
        , expect = leExpectJson toMsg uploadPdfResDecoder
        , timeout = Nothing
        , tracker = Nothing
        }


bgtask_status_and_logs :
    (Result ApiError BgtaskStatusAndLogsRsp -> msg)
    -> Int
    -> BgtaskStatusAndLogsQuery
    -> Cmd msg
bgtask_status_and_logs toMsg taskId req =
    Http.get
        { url =
            Url.Builder.absolute
                [ "api"
                , "bgtask"
                , String.fromInt taskId
                , "status-and-logs"
                ]
                [ Url.Builder.int "skip" req.skip
                ]
        , expect = leExpectJson toMsg bgtaskStatusAndLogsRspDecoder
        }


delta_kmz_to_geojson :
    (Result ApiError Bytes -> msg)
    -> File
    -> Cmd msg
delta_kmz_to_geojson toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/delta/kmz-to-geojson"
        , body = Http.multipartBody [ Http.filePart (File.name file) file ]
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        , timeout = Nothing
        , tracker = Nothing
        }


kmz_to_fix :
    (Result ApiError Bytes -> msg)
    -> File
    -> Bool
    -> Cmd msg
kmz_to_fix toMsg file hideTitles =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/kmz/fix"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                , Http.stringPart "hide_titles"
                    (if hideTitles then
                        "1"

                     else
                        "0"
                    )
                ]
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        , timeout = Nothing
        , tracker = Nothing
        }


inbox_messages_digest :
    Maybe String
    -> (Result ApiError InboxMessagesDigestRsp -> msg)
    -> InboxMessagesReq
    -> Cmd msg
inbox_messages_digest token toMsg req =
    Http.request
        { url = "/api/rer-importer/get-inbox-count"
        , body = Http.jsonBody (inboxMessagesReqEncoder req)
        , expect = leExpectJson toMsg inboxMessagesDigestRspDecoder
        , headers = []
        , timeout = Nothing
        , tracker = token
        , method = "POST"
        }


rer_importer_inbox_submit :
    (Result ApiError () -> msg)
    -> InboxSubmitReq
    -> Cmd msg
rer_importer_inbox_submit toMsg req =
    Http.post
        { url = "/api/rer-importer/inbox/submit"
        , body = Http.jsonBody (inboxSubmitReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


rer_importer_inbox_cursor :
    (Result ApiError (Maybe Int) -> msg)
    -> Cmd msg
rer_importer_inbox_cursor toMsg =
    Http.get
        { url =
            Url.Builder.absolute
                [ "api"
                , "rer-importer"
                , "inbox"
                , "cursor"
                ]
                []
        , expect = leExpectJson toMsg (Decode.nullable Decode.int)
        }


rer_importer_inbox_update_cursor :
    (Result ApiError () -> msg)
    -> UpdateCursorReq
    -> Cmd msg
rer_importer_inbox_update_cursor toMsg req =
    Http.post
        { url =
            Url.Builder.absolute
                [ "api"
                , "rer-importer"
                , "inbox"
                , "cursor-update"
                ]
                []
        , body = Http.jsonBody (updateCursorReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


rer_importer_callsigns :
    (Result ApiError (List CallsignWithFrequencies) -> msg)
    -> RerImporterCallsignsReq
    -> Cmd msg
rer_importer_callsigns toMsg req =
    Http.post
        { url = "/api/rer-importer/callsigns"
        , body = Http.jsonBody (rerImporterCallsignsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list callsignWithFrequenciesDecoder)
        }


rer_importer_unread_counters :
    (Result ApiError UnreadCountersRsp -> msg)
    -> UnreadCountersReq
    -> Cmd msg
rer_importer_unread_counters toMsg req =
    Http.post
        { url = "/api/rer-importer/unread-counters"
        , body = Http.jsonBody (unreadCountersReqEncoder req)
        , expect = leExpectJson toMsg unreadCountersRspDecoder
        }


rer_importer_signal_group_info_batch :
    (Result ApiError SignalGroupsRsp -> msg)
    -> BatchSignalGroupReq
    -> Cmd msg
rer_importer_signal_group_info_batch toMsg req =
    Http.post
        { url = "/api/rer-importer/signal-group-batch"
        , body = Http.jsonBody (batchSignalGroupReqEncoder req)
        , expect = leExpectJson toMsg signalGroupsRspDecoder
        }


rer_importer_signal_profile_info_batch :
    (Result ApiError SignalProfilesRsp -> msg)
    -> BatchSignalProfileReq
    -> Cmd msg
rer_importer_signal_profile_info_batch toMsg req =
    Http.post
        { url = "/api/rer-importer/signal-profile-batch"
        , body = Http.jsonBody (batchSignalProfileReqEncoder req)
        , expect = leExpectJson toMsg signalProfilesRspDecoder
        }


delta_csv_to_kmz :
    (Result ApiError Bytes -> msg)
    -> File
    -> Cmd msg
delta_csv_to_kmz toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/delta/csv2kmz"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                ]
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        , timeout = Nothing
        , tracker = Nothing
        }


radios_convert :
    (Result ApiError Int -> msg)
    -> File
    -> Cmd msg
radios_convert toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/radios-convert"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                ]
        , expect = leExpectJson toMsg Decode.int
        , timeout = Nothing
        , tracker = Nothing
        }


rer_csv_import :
    (Result ApiError Int -> msg)
    -> File
    -> Cmd msg
rer_csv_import toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/rer/csv-import"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                ]
        , expect = leExpectJson toMsg Decode.int
        , timeout = Nothing
        , tracker = Nothing
        }


rer_delta_kmz_import :
    (Result ApiError Int -> msg)
    -> File
    -> Cmd msg
rer_delta_kmz_import toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/rer/delta-kmz-import"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                ]
        , expect = leExpectJson toMsg Decode.int
        , timeout = Nothing
        , tracker = Nothing
        }


rer_delta_csv_import :
    (Result ApiError Int -> msg)
    -> File
    -> Cmd msg
rer_delta_csv_import toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/rer/delta-csv-import"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                ]
        , expect = leExpectJson toMsg Decode.int
        , timeout = Nothing
        , tracker = Nothing
        }


radios_download_result_per_radio :
    (Result ApiError Bytes -> msg)
    -> RadiosDownloadResultReq
    -> Cmd msg
radios_download_result_per_radio toMsg req =
    Http.post
        { url = "/api/radios-download-result-per-radio"
        , body = Http.jsonBody (radiosDownloadResultReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


radios_download_result_per_date :
    (Result ApiError Bytes -> msg)
    -> RadiosDownloadResultReq
    -> Cmd msg
radios_download_result_per_date toMsg req =
    Http.post
        { url = "/api/radios-download-result-per-date"
        , body = Http.jsonBody (radiosDownloadResultReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


radios_download_result_csv :
    (Result ApiError Bytes -> msg)
    -> RadiosDownloadResultReq
    -> Cmd msg
radios_download_result_csv toMsg req =
    Http.post
        { url = "/api/radios-download-result-csv"
        , body = Http.jsonBody (radiosDownloadResultReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


rer_bookmark_add :
    (Result ApiError () -> msg)
    -> BookmarkAddReq
    -> Cmd msg
rer_bookmark_add toMsg req =
    Http.post
        { url = "/api/rer/bookmark/add"
        , body = Http.jsonBody (bookmarkAddReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


rer_bookmark_rm :
    (Result ApiError () -> msg)
    -> BookmarkAddReq
    -> Cmd msg
rer_bookmark_rm toMsg req =
    Http.post
        { url = "/api/rer/bookmark/delete"
        , body = Http.jsonBody (bookmarkRmReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


rer_important_add :
    (Result ApiError () -> msg)
    -> ImportantAddReq
    -> Cmd msg
rer_important_add toMsg req =
    Http.post
        { url = "/api/rer/important/add"
        , body = Http.jsonBody (importantAddReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


rer_important_rm :
    (Result ApiError () -> msg)
    -> ImportantAddReq
    -> Cmd msg
rer_important_rm toMsg req =
    Http.post
        { url = "/api/rer/important/delete"
        , body = Http.jsonBody (importantRmReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


rer_analysis_latest_senders :
    (Result ApiError SignalProfilesRsp -> msg)
    -> Cmd msg
rer_analysis_latest_senders toMsg =
    Http.post
        { url = "/api/rer-importer/latest-senders"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg signalProfilesRspDecoder
        }


logout : (Result ApiError () -> msg) -> Cmd msg
logout toMsg =
    Http.get
        { url =
            "/api/user/logout"
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


users_login :
    (Result ApiError () -> msg)
    -> LoginReq
    -> Cmd msg
users_login toMsg req =
    Http.post
        { url = "/api/user/login"
        , body = Http.jsonBody (loginReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


settings_save :
    (Result ApiError () -> msg)
    -> SettingsSaveReq
    -> Cmd msg
settings_save toMsg req =
    Http.post
        { url = "/api/user/settings-save"
        , body = Http.jsonBody (settingsSaveReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


user_sigint_groups :
    (Result ApiError (List String) -> msg)
    -> SigintGroupsReq
    -> Cmd msg
user_sigint_groups toMsg req =
    Http.post
        { url = "/api/user/sigint-groups"
        , body = Http.jsonBody (sigintGroupsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list Decode.string)
        }


server_info :
    (Result ApiError ServerInfo -> msg)
    -> Cmd msg
server_info toMsg =
    Http.post
        { url = "/api-public/server-info"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg serverInfoDecoder
        }


datasource_list :
    (Result ApiError (List ( Int, Datasource )) -> msg)
    -> Cmd msg
datasource_list toMsg =
    Http.post
        { url = "/api/datasources/list"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg (Decode.list (jsonPair Decode.int datasourceDecoder))
        }


datasource_group_list :
    (Result ApiError (List String) -> msg)
    -> Int
    -> Cmd msg
datasource_group_list toMsg req =
    Http.post
        { url = "/api/datasources/group-list"
        , body = Http.jsonBody (Encode.int req)
        , expect = leExpectJson toMsg (Decode.list Decode.string)
        }


sigint_zones_list :
    (Result ApiError (List ( Int, SigintZone )) -> msg)
    -> Cmd msg
sigint_zones_list toMsg =
    Http.post
        { url = "/api/sigint/zones/list"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg (Decode.list (jsonPair Decode.int sigintZoneDecoder))
        }


zones_datasources_list :
    (Result ApiError (List Int) -> msg)
    -> Int
    -> Cmd msg
zones_datasources_list toMsg req =
    Http.post
        { url = "/api/sigint/zones/zone-datasources"
        , body = Http.jsonBody (Encode.int req)
        , expect = leExpectJson toMsg (Decode.list Decode.int)
        }


zones_datasources_groups_list :
    (Result ApiError (List String) -> msg)
    -> ZoneDatasourceGroupsReq
    -> Cmd msg
zones_datasources_groups_list toMsg req =
    Http.post
        { url = "/api/sigint/zones/zone-datasource-groups"
        , body = Http.jsonBody (zoneDatasourceGroupsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list Decode.string)
        }


zones_datasources_groups_list_save :
    (Result ApiError () -> msg)
    -> ZoneDatasourceGroupsSaveReq
    -> Cmd msg
zones_datasources_groups_list_save toMsg req =
    Http.post
        { url = "/api/sigint/zones/zone-datasource-groups-save"
        , body = Http.jsonBody (zoneDatasourceGroupsSaveReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


inbox_message_tags_add :
    (Result ApiError () -> msg)
    -> InboxMessageTagsAddReq
    -> Cmd msg
inbox_message_tags_add toMsg req =
    Http.post
        { url = "/api/tags/tags-add"
        , body = Http.jsonBody (inboxMessageTagsAddReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


inbox_message_tags_rm :
    (Result ApiError () -> msg)
    -> InboxMessageTagsRmReq
    -> Cmd msg
inbox_message_tags_rm toMsg req =
    Http.post
        { url = "/api/tags/tags-rm"
        , body = Http.jsonBody (inboxMessageTagsAddReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }



-- POST /api/sigint/units


sigint_unit_create :
    (Result ApiError Unit -> msg)
    -> CreateUnitReq
    -> Cmd msg
sigint_unit_create toMsg req =
    Http.post
        { url = "/api/sigint/unit/create"
        , body = Http.jsonBody (createUnitReqEncoder req)
        , expect = leExpectJson toMsg unitDecoder
        }


sigint_unit_update :
    (Result ApiError Unit -> msg)
    -> Unit
    -> Cmd msg
sigint_unit_update toMsg req =
    Http.post
        { url = "/api/sigint/unit/update"
        , body = Http.jsonBody (unitEncoder req)
        , expect = leExpectJson toMsg unitDecoder
        }


sigint_unit_delete :
    (Result ApiError Unit -> msg)
    -> Int
    -> Cmd msg
sigint_unit_delete toMsg req =
    Http.post
        { url = "/api/sigint/unit/delete"
        , body = Http.jsonBody (Encode.int req)
        , expect = leExpectJson toMsg unitDecoder
        }


sigint_unit_delete_duplicate :
    (Result ApiError Unit -> msg)
    -> DeleteUnitDuplicateReq
    -> Cmd msg
sigint_unit_delete_duplicate toMsg req =
    Http.post
        { url = "/api/sigint/unit/delete-duplicate"
        , body = Http.jsonBody (deleteUnitDuplicateReqEncoder req)
        , expect = leExpectJson toMsg unitDecoder
        }



-- POST /api/sigint/signals


sigint_list_signals :
    (Result ApiError ListSignalsRsp -> msg)
    -> ListSignalsReq
    -> Cmd msg
sigint_list_signals toMsg req =
    Http.post
        { url = "/api/sigint/signals"
        , body = Http.jsonBody (listSignalsReqEncoder req)
        , expect = leExpectJson toMsg listSignalsRspDecoder
        }


sigint_signal_create :
    (Result ApiError Int -> msg)
    -> CreateSignalReq
    -> Cmd msg
sigint_signal_create toMsg req =
    Http.post
        { url = "/api/sigint/signal/create"
        , body = Http.jsonBody (createSignalReqEncoder req)
        , expect = leExpectJson toMsg Decode.int
        }


sigint_signal_update :
    (Result ApiError Int -> msg)
    -> UpdateSignalReq
    -> Cmd msg
sigint_signal_update toMsg req =
    Http.post
        { url = "/api/sigint/signal/update"
        , body = Http.jsonBody (updateSignalReqEncoder req)
        , expect = leExpectJson toMsg Decode.int
        }


sigint_signal_delete :
    (Result ApiError Int -> msg)
    -> Int
    -> Cmd msg
sigint_signal_delete toMsg req =
    Http.post
        { url = "/api/sigint/signal/delete"
        , body = Http.jsonBody (Encode.int req)
        , expect = leExpectJson toMsg Decode.int
        }


sigint_signal_unit_stats :
    (Result ApiError SignalUnitStatsRsp -> msg)
    -> ()
    -> Cmd msg
sigint_signal_unit_stats toMsg _ =
    Http.post
        { url = "/api/sigint/signal/unit-stats"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg signalUnitStatsRspDecoder
        }


sigint_list_callsigns :
    (Result ApiError ListCallsignsRsp -> msg)
    -> ListCallsignsReq
    -> Cmd msg
sigint_list_callsigns toMsg req =
    Http.post
        { url = "/api/sigint/callsigns"
        , body = Http.jsonBody (listCallsignsReqEncoder req)
        , expect = leExpectJson toMsg listCallsignsRspDecoder
        }


sigint_callsigns_with_units_from_inbox :
    (Result ApiError GetCallsignsWithUnitsFromInboxRsp -> msg)
    -> GetCallsignsWithUnitsFromInboxReq
    -> Cmd msg
sigint_callsigns_with_units_from_inbox toMsg req =
    Http.post
        { url = "/api/sigint/callsigns-with-units-from-inbox"
        , body = Http.jsonBody (getCallsignsWithUnitsFromInboxReqEncoder req)
        , expect = leExpectJson toMsg getCallsignsWithUnitsFromInboxRspDecoder
        }


sigint_callsign_create :
    (Result ApiError Callsign -> msg)
    -> CreateCallsignReq
    -> Cmd msg
sigint_callsign_create toMsg req =
    Http.post
        { url = "/api/sigint/callsign/create"
        , body = Http.jsonBody (createCallsignReqEncoder req)
        , expect = leExpectJson toMsg callsignDecoder
        }


sigint_callsign_update :
    (Result ApiError Callsign -> msg)
    -> Callsign
    -> Cmd msg
sigint_callsign_update toMsg req =
    Http.post
        { url = "/api/sigint/callsign/update"
        , body = Http.jsonBody (callsignEncoder req)
        , expect = leExpectJson toMsg callsignDecoder
        }


sigint_callsign_delete :
    (Result ApiError Callsign -> msg)
    -> Int
    -> Cmd msg
sigint_callsign_delete toMsg req =
    Http.post
        { url = "/api/sigint/callsign/delete"
        , body = Http.jsonBody (Encode.int req)
        , expect = leExpectJson toMsg callsignDecoder
        }


sigint_list_freqs :
    (Result ApiError ListFreqsRsp -> msg)
    -> ListFreqsReq
    -> Cmd msg
sigint_list_freqs toMsg req =
    Http.post
        { url = "/api/sigint/freqs"
        , body = Http.jsonBody (listFreqsReqEncoder req)
        , expect = leExpectJson toMsg listFreqsRspDecoder
        }


sigint_list_sources :
    (Result ApiError ListSourcesRsp -> msg)
    -> ()
    -> Cmd msg
sigint_list_sources toMsg _ =
    Http.post
        { url = "/api/sigint/sources"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg listSourcesRspDecoder
        }


sigint_callsign_unit_stats :
    (Result ApiError CallsignUnitStatsRsp -> msg)
    -> ()
    -> Cmd msg
sigint_callsign_unit_stats toMsg _ =
    Http.post
        { url = "/api/sigint/callsign/unit-stats"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg callsignUnitStatsRspDecoder
        }


delta_convert_kmz_to_geojson :
    (Result ApiError Int -> msg)
    -> File
    -> Cmd msg
delta_convert_kmz_to_geojson toMsg file =
    Http.post
        { url = "/api/delta/convert-kmz-to-geojson"
        , body =
            Http.multipartBody
                [ Http.filePart (File.name file) file
                ]
        , expect = leExpectJson toMsg Decode.int
        }


sigint_latest_frequencies :
    (Result ApiError (List String) -> msg)
    -> Cmd msg
sigint_latest_frequencies toMsg =
    Http.post
        { url = "/api/sigint/latest-frequencies"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg (Decode.list Decode.string)
        }


sigint_update_freq_networks :
    (Result ApiError (List Network) -> msg)
    -> UpdateFreqNetworksReq
    -> Cmd msg
sigint_update_freq_networks toMsg req =
    Http.post
        { url = "/api/sigint/update-freq-networks"
        , body = Http.jsonBody (updateFreqNetworksReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list networkDecoder)
        }


sigint_freq_unit_stats :
    (Result ApiError FreqUnitStatsRsp -> msg)
    -> Cmd msg
sigint_freq_unit_stats toMsg =
    Http.post
        { url = "/api/sigint/freq/unit-stats"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg freqUnitStatsRspDecoder
        }


waterfall_saved_filters_list :
    (Result ApiError (List SavedFilterDuty) -> msg)
    -> Cmd msg
waterfall_saved_filters_list toMsg =
    Http.post
        { url = "/api/rer/duty/saved-filters"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg (Decode.list savedFilterDutyDecoder)
        }


waterfall_saved_filter_upsert :
    (Result ApiError (List SavedFilterDuty) -> msg)
    -> SavedFilterDutyUpsertReq
    -> Cmd msg
waterfall_saved_filter_upsert toMsg req =
    Http.post
        { url = "/api/rer/duty/saved-filter-upsert"
        , body = Http.jsonBody (savedFilterDutyUpsertReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list savedFilterDutyDecoder)
        }


waterfall_saved_filter_delete :
    (Result ApiError () -> msg)
    -> Int
    -> Cmd msg
waterfall_saved_filter_delete toMsg req =
    Http.post
        { url = "/api/rer/duty/saved-filter-delete"
        , body = Http.jsonBody (Encode.int req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


list_points_by_freq :
    (Result ApiError ListPointsByFreqRsp -> msg)
    -> ListPointsByFreqReq
    -> Cmd msg
list_points_by_freq toMsg req =
    Http.post
        { url = "/api/sigint/freq/points"
        , body = Http.jsonBody (listPointsByFreqReqEncoder req)
        , expect = leExpectJson toMsg listPointsByFreqRspDecoder
        }


type alias ListCallsignsByFreqsRsp =
    Dict String (List String)


listCallsignsByFreqsRspDecoder : Decode.Decoder (Dict String (List String))
listCallsignsByFreqsRspDecoder =
    Decode.dict (Decode.list Decode.string)


list_callsigns_by_freq :
    (Result ApiError ListCallsignsByFreqsRsp -> msg)
    -> ListCallsignsByFreqsReq
    -> Cmd msg
list_callsigns_by_freq toMsg req =
    Http.post
        { url = "/api/sigint/freq/callsigns"
        , body = Http.jsonBody (listCallsignsByFreqsReqEncoder req)
        , expect = leExpectJson toMsg listCallsignsByFreqsRspDecoder
        }


type alias ListAltUnitsByFreqsRsp =
    Dict String (List FreqAltUnitMessageCount)


listAltUnitByFreqsRspDecoder : Decode.Decoder (Dict String (List FreqAltUnitMessageCount))
listAltUnitByFreqsRspDecoder =
    Decode.dict (Decode.list freqAltUnitMessageCountDecoder)


list_alt_units_by_freqs : (Result ApiError ListAltUnitsByFreqsRsp -> msg) -> ListAltUnitByFreqsReq -> Cmd msg
list_alt_units_by_freqs toMsg req =
    Http.post
        { url = "/api/sigint/freqs/alt-unit"
        , body = Http.jsonBody (listAltUnitByFreqsReqEncoder req)
        , expect = leExpectJson toMsg listAltUnitByFreqsRspDecoder
        }


create_login : (Result ApiError Login -> msg) -> CreateLoginReq -> Cmd msg
create_login toMsg req =
    Http.post
        { url = "/api/login/create"
        , body = Http.jsonBody (createLoginReqEncoder req)
        , expect = leExpectJson toMsg loginDecoder
        }


update_login : (Result ApiError Login -> msg) -> UpdateLoginReq -> Cmd msg
update_login toMsg req =
    Http.post
        { url = "/api/login/update"
        , body = Http.jsonBody (updateLoginReqEncoder req)
        , expect = leExpectJson toMsg loginDecoder
        }


list_logins : (Result ApiError ListLoginsRsp -> msg) -> ListLoginsReq -> Cmd msg
list_logins toMsg req =
    Http.post
        { url = "/api/logins"
        , body = Http.jsonBody (listLoginsReqEncoder req)
        , expect = leExpectJson toMsg listLoginsRspDecoder
        }


add_group_to_organism : (Result ApiError () -> msg) -> AddGroupToOrganismReq -> Cmd msg
add_group_to_organism toMsg req =
    Http.post
        { url = "/api/organism/add-group"
        , body = Http.jsonBody (addGroupToOrganismReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


remove_group_from_organism : (Result ApiError () -> msg) -> RemoveGroupFromOrganismReq -> Cmd msg
remove_group_from_organism toMsg req =
    Http.post
        { url = "/api/organism/remove-group"
        , body = Http.jsonBody (removeGroupFromOrganismReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


update_organism : (Result ApiError Organism -> msg) -> UpdateOrganismReq -> Cmd msg
update_organism toMsg req =
    Http.post
        { url = "/api/organism/update"
        , body = Http.jsonBody (updateOrganismReqEncoder req)
        , expect = leExpectJson toMsg organismDecoder
        }


create_organism : (Result ApiError Organism -> msg) -> CreateOrganismReq -> Cmd msg
create_organism toMsg req =
    Http.post
        { url = "/api/organism/create"
        , body = Http.jsonBody (createOrganismReqEncoder req)
        , expect = leExpectJson toMsg organismDecoder
        }


list_organisms : (Result ApiError (List Organism) -> msg) -> ListOrganismsReq -> Cmd msg
list_organisms toMsg req =
    Http.post
        { url = "/api/organisms"
        , body = Http.jsonBody (listOrganismsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list organismDecoder)
        }


organism_group_list : (Result ApiError (List SignalGroupFull) -> msg) -> Cmd msg
organism_group_list toMsg =
    Http.post
        { url = "/api/organism/group-list"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg (Decode.list signalGroupFullDecoder)
        }


create_login_delta : (Result ApiError Login -> msg) -> CreateLoginReq -> Cmd msg
create_login_delta toMsg req =
    Http.post
        { url = "/api/login/create-delta"
        , body = Http.jsonBody (createLoginReqEncoder req)
        , expect = leExpectJson toMsg loginDecoder
        }


get_delta_redirect_url : (Result ApiError DeltaLoginUrl -> msg) -> Cmd msg
get_delta_redirect_url toMsg =
    Http.get
        { url = "/api/fetch-redirect-url"
        , expect = leExpectJson toMsg deltaLoginUrlDecoder
        }


rer_freqs_callsigns :
    (Result ApiError CallsignsForFreqRsp -> msg)
    -> CallsignsForFreqReq
    -> Cmd msg
rer_freqs_callsigns toMsg req =
    Http.post
        { url = "/api/sigint/freq/callsigns-filter"
        , body = Http.jsonBody (callsignsForFreqReqEncoder req)
        , expect = leExpectJson toMsg callsignsForFreqRspDecoder
        }


rer_freq_report_etalonka :
    (Result ApiError Bytes -> msg)
    -> EtalonkaReq
    -> Cmd msg
rer_freq_report_etalonka toMsg req =
    Http.post
        { url = "/api/sigint/etalonka/report"
        , body = Http.jsonBody (etalonkaReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


get_networks_list toMsg req =
    Http.post
        { url = "/api/sigint/network-list"
        , body = Http.jsonBody (listNetworksReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list networkDecoder)
        }


get_posts toMsg req =
    Http.post
        { url = "/api/sigint/posts"
        , body = Http.jsonBody (listPostsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list postDecoder)
        }
