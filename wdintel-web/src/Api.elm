module Api exposing (..)

import Bindings exposing (..)
import Bytes exposing (Bytes)
import Core.Types exposing (ApiError, ModelWithErrorFields)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import Http
import Json.Decode as Decode
import Json.Encode as Encode
import Markdown.Block as Block
import Markdown.Parser
import Shared.Components.Toast
import Shared.Msg exposing (ChangelogReleaseMeta, ChangelogReleasePage)
import Url.Builder
import Utils.Api.RetryableHttp as RetryableHttp
import Utils.Api.Temp exposing (jsonPair, leExpectJson, resolve)


{-| TODO: Refactor error handling to be more flexible and avoid code duplication.
This function is a temporary solution for login-specific error handling.
-}
handleHttpError :
    (Shared.Components.Toast.Msg -> msg)
    -> ApiError
    -> ModelWithErrorFields model
    -> ( ModelWithErrorFields model, Effect msg )
handleHttpError toMsg e m =
    case e.httpError of
        Http.BadStatus code ->
            case code of
                401 ->
                    ( m, E.logout )

                _ ->
                    case Dict.toList e.formErrors of
                        [] ->
                            case e.errors of
                                [] ->
                                    ( { m | formErrors = e.formErrors }
                                    , E.sendCmd <| Shared.Components.Toast.addError toMsg "There was an error, please try again later"
                                    )

                                es ->
                                    ( { m | formErrors = e.formErrors }
                                    , E.sendCmd <| Shared.Components.Toast.addErrors toMsg es
                                    )

                        _ ->
                            ( { m | formErrors = e.formErrors }
                            , E.none
                            )

        Http.BadBody badBody ->
            ( m
            , E.sendCmd <|
                Cmd.batch
                    [ Shared.Components.Toast.addError toMsg "There was an error, please try again later"
                    , logError ("Bad Body: " ++ badBody) (toMsg << always Shared.Components.Toast.NoOp)
                    ]
            )

        _ ->
            ( m
            , E.sendCmd <| Shared.Components.Toast.addError toMsg "There was an error, please try again later"
            )


handleLoginHttpError :
    (Shared.Components.Toast.Msg -> msg)
    -> ApiError
    -> ModelWithErrorFields model
    -> ( ModelWithErrorFields model, Effect msg )
handleLoginHttpError toMsg e m =
    case e.httpError of
        Http.BadStatus code ->
            case code of
                401 ->
                    -- For login page, treat 401 as form error instead of logout
                    ( { m | formErrors = Dict.insert "login" "Невірний логін або пароль" e.formErrors }
                    , E.none
                    )

                _ ->
                    case Dict.toList e.formErrors of
                        [] ->
                            case e.errors of
                                [] ->
                                    ( { m | formErrors = e.formErrors }
                                    , E.sendCmd <| Shared.Components.Toast.addError toMsg "There was an error, please try again later"
                                    )

                                es ->
                                    ( { m | formErrors = e.formErrors }
                                    , E.sendCmd <| Shared.Components.Toast.addErrors toMsg es
                                    )

                        _ ->
                            ( { m | formErrors = e.formErrors }
                            , E.none
                            )

        Http.BadBody badBody ->
            ( m
            , E.sendCmd <|
                Cmd.batch
                    [ Shared.Components.Toast.addError toMsg "There was an error, please try again later"
                    , logError ("Bad Body: " ++ badBody) (toMsg << always Shared.Components.Toast.NoOp)
                    ]
            )

        _ ->
            ( m
            , E.sendCmd <| Shared.Components.Toast.addError toMsg "There was an error, please try again later"
            )


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
                [ Url.Builder.int "skip" req.skip ]
        , expect = leExpectJson toMsg bgtaskStatusAndLogsRspDecoder
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


alpine_convert :
    (Result ApiError Int -> msg)
    -> File
    -> String
    -> Cmd msg
alpine_convert toMsg file outputFormat =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/alpine/convert"
        , body =
            Http.multipartBody
                [ Http.stringPart "output_format" outputFormat
                , Http.filePart (File.name file) file
                ]
        , expect = leExpectJson toMsg Decode.int
        , timeout = Nothing
        , tracker = Nothing
        }


alpine_download_result :
    (Result ApiError Bytes -> msg)
    -> AlpineDownloadResultReq
    -> Cmd msg
alpine_download_result toMsg req =
    Http.post
        { url = "/api/alpine/download-result"
        , body = Http.jsonBody (alpineDownloadResultReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
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
    -> Effect msg
rer_importer_inbox_submit toMsg req =
    RetryableHttp.retryablePost
        RetryableHttp.defaultRetryConfig
        toMsg
        { url = "/api/rer-importer/inbox/submit"
        , body = Http.jsonBody (inboxSubmitReqEncoder req)
        , decoder = Decode.succeed ()
        }


rer_importer_comment_save :
    (Result ApiError () -> msg)
    -> InboxCommentSaveReq
    -> Cmd msg
rer_importer_comment_save toMsg req =
    Http.post
        { url = "/api/rer-importer/comment-save"
        , body = Http.jsonBody (inboxCommentSaveReqEncoder req)
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


api_mark_release_seen :
    String
    -> (Result ApiError () -> msg)
    -> Cmd msg
api_mark_release_seen releaseId toMsg =
    Http.post
        { url = "/api/user/release-seen"
        , body = Http.jsonBody (markReleaseSeenReqEncoder { releaseId = releaseId })
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


changelog_index :
    (Result ApiError (List Shared.Msg.ChangelogReleaseMeta) -> msg)
    -> Cmd msg
changelog_index toMsg =
    Http.get
        { url = "/releases/index.json"
        , expect = leExpectJson toMsg changelogIndexDecoder
        }


changelogIndexDecoder : Decode.Decoder (List Shared.Msg.ChangelogReleaseMeta)
changelogIndexDecoder =
    Decode.list
        (Decode.map2
            Shared.Msg.ChangelogReleaseMeta
            (Decode.field "release_id" Decode.string)
            (Decode.field "title" Decode.string)
        )


changelog_latest :
    String
    -> (Result ApiError Shared.Msg.ChangelogReleasePage -> msg)
    -> Cmd msg
changelog_latest releaseId toMsg =
    Http.get
        { url = "/releases/" ++ releaseId ++ "/release.md"
        , expect =
            Http.expectStringResponse toMsg
                (resolve (parseChangelogMarkdown releaseId))
        }


parseChangelogMarkdown : String -> String -> Result String Shared.Msg.ChangelogReleasePage
parseChangelogMarkdown releaseId rawMarkdown =
    Markdown.Parser.parse rawMarkdown
        |> Result.mapError
            (List.map Markdown.Parser.deadEndToString
                >> String.join "\n"
            )
        |> Result.map
            (\blocks ->
                { releaseId = releaseId
                , headings =
                    blocks
                        |> List.filterMap
                            (\block ->
                                case block of
                                    Block.Heading level inlines ->
                                        if level == Block.H1 then
                                            Nothing

                                        else
                                            Just (Block.extractInlineText inlines)

                                    _ ->
                                        Nothing
                            )
                }
            )


datasource_list :
    (Result ApiError (List ( Int, Datasource )) -> msg)
    -> Cmd msg
datasource_list toMsg =
    Http.post
        { url = "/api/datasources/list"
        , body = Http.jsonBody (Encode.object [])
        , expect = leExpectJson toMsg (Decode.list (jsonPair Decode.int datasourceDecoder))
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


inbox_message_tags_model_error :
    (Result ApiError () -> msg)
    -> InboxMessageTagModelErrorReq
    -> Cmd msg
inbox_message_tags_model_error toMsg req =
    Http.post
        { url = "/api/tags/tag-model-error"
        , body = Http.jsonBody (inboxMessageTagModelErrorReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


admin_restart_datasource :
    (Result ApiError Bool -> msg)
    -> Int
    -> Cmd msg
admin_restart_datasource toMsg datasourceId =
    Http.post
        { url = "/api/admin/restart-datasource"
        , body = Http.jsonBody (Encode.int datasourceId)
        , expect = leExpectJson toMsg Decode.bool
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


sigint_unit_create_with_auto_network :
    (Result ApiError CreateUnitWithAutoNetworkRsp -> msg)
    -> CreateUnitWithAutoNetworkReq
    -> Cmd msg
sigint_unit_create_with_auto_network toMsg req =
    Http.post
        { url = "/api/sigint/unit/create-with-auto-network"
        , body = Http.jsonBody (createUnitWithAutoNetworkReqEncoder req)
        , expect = leExpectJson toMsg createUnitWithAutoNetworkRspDecoder
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


sigint_list_signals_csv :
    (Result ApiError Bytes -> msg)
    -> ListSignalsReq
    -> Cmd msg
sigint_list_signals_csv toMsg req =
    Http.post
        { url = "/api/sigint/signals/csv"
        , body = Http.jsonBody (listSignalsReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
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


sigint_list_callsigns_csv :
    (Result ApiError Bytes -> msg)
    -> ListCallsignsReq
    -> Cmd msg
sigint_list_callsigns_csv toMsg req =
    Http.post
        { url = "/api/sigint/callsigns/csv"
        , body = Http.jsonBody (listCallsignsReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
        }


sigint_list_callsigns_xlsx :
    (Result ApiError Bytes -> msg)
    -> ListCallsignsReq
    -> Cmd msg
sigint_list_callsigns_xlsx toMsg req =
    Http.post
        { url = "/api/sigint/callsigns/xlsx"
        , body = Http.jsonBody (listCallsignsReqEncoder req)
        , expect = Http.expectBytesResponse toMsg (resolve Ok)
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


sigint_list_freqs_with_tracker :
    (Result ApiError ListFreqsRsp -> msg)
    -> String
    -> ListFreqsReq
    -> Cmd msg
sigint_list_freqs_with_tracker toMsg tracker req =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/sigint/freqs"
        , body = Http.jsonBody (listFreqsReqEncoder req)
        , expect = leExpectJson toMsg listFreqsRspDecoder
        , timeout = Nothing
        , tracker = Just tracker
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


sigint_list_keys :
    (Result ApiError ListKeysRsp -> msg)
    -> ListKeysReq
    -> Cmd msg
sigint_list_keys toMsg req =
    Http.post
        { url = "/api/sigint/keys"
        , body = Http.jsonBody (listKeysReqEncoder req)
        , expect = leExpectJson toMsg listKeysRspDecoder
        }


sigint_create_key :
    (Result ApiError EncryptionKeyData -> msg)
    -> CreateEncryptionKeyReq
    -> Cmd msg
sigint_create_key toMsg req =
    Http.post
        { url = "/api/sigint/keys/create"
        , body = Http.jsonBody (createEncryptionKeyReqEncoder req)
        , expect = leExpectJson toMsg encryptionKeyDataDecoder
        }


sigint_update_key :
    (Result ApiError EncryptionKeyData -> msg)
    -> UpdateEncryptionKeyReq
    -> Cmd msg
sigint_update_key toMsg req =
    Http.post
        { url = "/api/sigint/keys/update"
        , body = Http.jsonBody (updateEncryptionKeyReqEncoder req)
        , expect = leExpectJson toMsg encryptionKeyDataDecoder
        }


sigint_delete_key :
    (Result ApiError EncryptionKeyData -> msg)
    -> DeleteEncryptionKeyReq
    -> Cmd msg
sigint_delete_key toMsg req =
    Http.post
        { url = "/api/sigint/keys/delete"
        , body = Http.jsonBody (deleteEncryptionKeyReqEncoder req)
        , expect = leExpectJson toMsg encryptionKeyDataDecoder
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


list_logins : (Result ApiError ListLoginsRsp -> msg) -> ListLoginsReq -> Cmd msg
list_logins toMsg req =
    Http.post
        { url = "/api/logins"
        , body = Http.jsonBody (listLoginsReqEncoder req)
        , expect = leExpectJson toMsg listLoginsRspDecoder
        }


my_scope : (Result ApiError Bindings.MyScope -> msg) -> Cmd msg
my_scope toMsg =
    Http.post
        { url = "/api/organism/my-scope"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg Bindings.myScopeDecoder
        }


list_organisms : (Result ApiError (List Organism) -> msg) -> ListOrganismsReq -> Cmd msg
list_organisms toMsg req =
    Http.post
        { url = "/api/organisms"
        , body = Http.jsonBody (listOrganismsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list organismDecoder)
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


get_networks_list_with_tracker :
    (Result ApiError ListNetworksRsp -> msg)
    -> String
    -> ListNetworksReq
    -> Cmd msg
get_networks_list_with_tracker toMsg tracker req =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/sigint/network-list"
        , body = Http.jsonBody (listNetworksReqEncoder req)
        , expect = leExpectJson toMsg listNetworksRspDecoder
        , timeout = Nothing
        , tracker = Just tracker
        }

get_posts :
    (Result ApiError (List Post) -> msg)
    -> ListPostsReq
    -> Cmd msg
get_posts toMsg req =
    Http.post
        { url = "/api/sigint/posts"
        , body = Http.jsonBody (listPostsReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list postDecoder)
        }


units_search :
    (Result ApiError ListUnitsByIdRsp -> msg)
    -> String
    -> UnitSearchReq
    -> Cmd msg
units_search toMsg tracker req =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/sigint/unit/search"
        , body = Http.jsonBody (unitSearchReqEncoder req)
        , expect = leExpectJson toMsg listUnitsByIdRspDecoder
        , timeout = Nothing
        , tracker = Just tracker
        }



-- Messenger API functions


messenger_list_accounts : (Result ApiError AccountsRsp -> msg) -> Cmd msg
messenger_list_accounts toMsg =
    Http.post
        { url = "/api/messenger/list"
        , body = Http.jsonBody Encode.null
        , expect = leExpectJson toMsg accountsRspDecoder
        }



-- Custom retry config for QR code requests - only retry once


qrCodeRetryConfig : { maxRetries : Int, maxDurationMs : Int, initialIntervalMs : Float, maxIntervalMs : Float }
qrCodeRetryConfig =
    { maxRetries = 1 -- Only retry once (original + 1 retry = 2 total attempts)
    , maxDurationMs = 10000 -- 10 seconds max total time
    , initialIntervalMs = 1000 -- Start with 1 second delay
    , maxIntervalMs = 3000 -- Max 3 second delay
    }


messenger_get_qr_retryable : (Result ApiError QrCodeRsp -> msg) -> QrCodeReq -> Effect msg
messenger_get_qr_retryable toMsg req =
    RetryableHttp.retryablePost
        qrCodeRetryConfig
        toMsg
        { url = "/api/messenger/qr"
        , body = Http.jsonBody (qrCodeReqEncoder req)
        , decoder = qrCodeRspDecoder
        }


messenger_is_linked : (Result ApiError IsAccountLinkedRsp -> msg) -> IsAccountLinkedReq -> Cmd msg
messenger_is_linked toMsg req =
    Http.post
        { url = "/api/messenger/is-linked"
        , body = Http.jsonBody (isAccountLinkedReqEncoder req)
        , expect = leExpectJson toMsg isAccountLinkedRspDecoder
        }


messenger_edit_account : (Result ApiError () -> msg) -> AccountStatusReq -> Cmd msg
messenger_edit_account toMsg req =
    Http.post
        { url = "/api/messenger/edit"
        , body = Http.jsonBody (accountStatusReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


messenger_unlink_account : (Result ApiError () -> msg) -> DeleteAccountReq -> Cmd msg
messenger_unlink_account toMsg req =
    Http.post
        { url = "/api/messenger/unlink"
        , body = Http.jsonBody (deleteAccountReqEncoder req)
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


messenger_link_account : (Result ApiError LinkAccountRsp -> msg) -> LinkAccountReq -> Cmd msg
messenger_link_account toMsg req =
    Http.post
        { url = "/api/messenger/link"
        , body = Http.jsonBody (linkAccountReqEncoder req)
        , expect = leExpectJson toMsg linkAccountRspDecoder
        }


messenger_link_operator : (Result ApiError LinkAccountRsp -> msg) -> LinkEchoOperatorReq -> Cmd msg
messenger_link_operator toMsg req =
    Http.post
        { url = "/api/messenger/link-operator"
        , body = Http.jsonBody (linkEchoOperatorReqEncoder req)
        , expect = leExpectJson toMsg linkAccountRspDecoder
        }


aor_list : (Result ApiError (List AreaOfResponsibility) -> msg) -> ListAreasOfResponsibilityReq -> Cmd msg
aor_list toMsg req =
    Http.post
        { url = "/api/sigint/aor"
        , body = Http.jsonBody (listAreasOfResponsibilityReqEncoder req)
        , expect = leExpectJson toMsg (Decode.list areaOfResponsibilityDecoder)
        }


palitra_list : (Result ApiError (List Palitra) -> msg) -> Cmd msg
palitra_list toMsg =
    Http.post
        { url = "/api/palitra/list"
        , body = Http.emptyBody
        , expect = leExpectJson toMsg (Decode.list palitraDecoder)
        }


palitra_list_v2 : (Result ApiError (List PalitraReadV2) -> msg) -> Cmd msg
palitra_list_v2 toMsg =
    Http.post
        { url = "/api/palitra/v2/list"
        , body = Http.emptyBody
        , expect = leExpectJson toMsg (Decode.list palitraReadV2Decoder)
        }


palitra_map_list_v2 : (Result ApiError (List PalitraReadV2) -> msg) -> Cmd msg
palitra_map_list_v2 toMsg =
    Http.post
        { url = "/api/palitra/v2/list-map"
        , body = Http.emptyBody
        , expect = leExpectJson toMsg (Decode.list palitraReadV2Decoder)
        }


palitra_delete : (Result ApiError () -> msg) -> Int -> Cmd msg
palitra_delete toMsg palitraId =
    Http.post
        { url = "/api/palitra/delete/" ++ String.fromInt palitraId
        , body = Http.emptyBody
        , expect = leExpectJson toMsg (Decode.succeed ())
        }


palitra_create : (Result ApiError Palitra -> msg) -> CreatePalitraReq -> Cmd msg
palitra_create toMsg req =
    Http.post
        { url = "/api/palitra/create"
        , body = Http.jsonBody (createPalitraReqEncoder req)
        , expect = leExpectJson toMsg palitraDecoder
        }


palitra_update : (Result ApiError PalitraDetails -> msg) -> Int -> CreatePalitraReq -> Cmd msg
palitra_update toMsg palitraId req =
    Http.post
        { url = "/api/palitra/update/" ++ String.fromInt palitraId
        , body = Http.jsonBody (createPalitraReqEncoder req)
        , expect = leExpectJson toMsg palitraDetailsDecoder
        }


palitra_upload_points : (Result ApiError () -> msg) -> Int -> File -> Cmd msg
palitra_upload_points toMsg palitraId file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/palitra/upload-points/" ++ String.fromInt palitraId
        , body = Http.multipartBody [ Http.filePart (File.name file) file ]
        , expect = leExpectJson toMsg (Decode.succeed ())
        , timeout = Nothing
        , tracker = Nothing
        }


palitra_analyze_kmz : (Result ApiError AnalyzeKmzResponse -> msg) -> File -> Cmd msg
palitra_analyze_kmz toMsg file =
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/palitra/analyze-kmz"
        , body = Http.multipartBody [ Http.filePart (File.name file) file ]
        , expect = leExpectJson toMsg analyzeKmzResponseDecoder
        , timeout = Nothing
        , tracker = Nothing
        }


palitra_create_with_kmz : (Result ApiError Palitra -> msg) -> CreatePalitraReq -> File -> Cmd msg
palitra_create_with_kmz toMsg req file =
    let
        accessType =
            case req.access of
                ByLogins _ ->
                    "logins"

                ByOrganisms _ ->
                    "organisms"

                ByAor _ ->
                    "aor"

        accessValues =
            case req.access of
                ByLogins { logins } ->
                    String.join "," logins

                ByOrganisms { organismIds } ->
                    String.join "," (List.map String.fromInt organismIds)

                ByAor { aorIds } ->
                    String.join "," (List.map String.fromInt aorIds)
    in
    Http.request
        { method = "POST"
        , headers = []
        , url = "/api/palitra/create-with-kmz"
        , body =
            Http.multipartBody
                [ Http.stringPart "name" req.name
                , Http.stringPart "color_hex" req.colorHex
                , Http.stringPart "access_type" accessType
                , Http.stringPart "access_values" accessValues
                , Http.filePart "kmz" file
                ]
        , expect = leExpectJson toMsg palitraDecoder
        , timeout = Nothing
        , tracker = Nothing
        }
