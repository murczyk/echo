port module Effect exposing
    ( Effect
    , none, batch
    , sendCmd, sendMsg, sendSharedMsg
    , pushRoute, replaceRoute
    , pushRoutePath, replaceRoutePath
    , loadExternalUrl, back
    , map, toCmd
    , CallsignsByNetwork, ReportDownloadResult, addFreqToNetwork, addMultipleCallsignsToNetwork, createNetwork, createNetworkCallsign, deleteMessage, deleteNetwork, deleteNetworkCallsign, deleteSavedAnalysisFilter, downloadFile, downloadGeojson, downloadKmz, editFreqUnitName, focusHtmlElement, getAnalysisSavedFilters, getAors, getBookmarks, getCallsigns, getCallsignsGraph, getCallsignsInfo, getCallsignsInfoShared, getCorrelatedFreqs, getCurrentTime, getDocxReportForDownload, getElementById, getFreqActivityDaily, getFreqs, getFreqsSummaryTable, getFreqsSummaryTableXlsx, getGroups, getGroupsActivityStats, getImportantMessagesIds, getInboxGroupsActivityStats, getInboxMessages, getLocations, getMessagesByIds, getMessagesComments, getMessagesMapPoints, getMetadataStats, getEncryptions, getNetworkCallsigns, getNetworkCallsignsActivity, getNetworkCallsignsList, getNetworkFreqCallsigns, getNetworkFreqsActivity, getNetworkGoiReport, getNetworkPoints, getNetworkReportBatch, getNetworksCallsigns, getNetworksGroupsActivity, getNetworksInfoByFreqs, getNetworksInfoByIds, getNetworksList, getNetworksReport, getNewCallsigns, getPosts, getSenders, getNetworks, getSignalsForNetwork, getSingleNetwork, getSingleNetworkFreqs, getSingleNetworkGroupsActivity, getStatsCount, getSystemSettings, getTags, getTags2, getTimeZone, getUnitStatsForNetworks, getUnits, getUnits2, getUnitsById, getUserInfo, getViewportById, initNetjsonGraph, keepAlive, loadPostsFromShared, logout, mergeNetworks, networkAddDescription, networkDeleteDescription, networkUpdateDescription, postCreate, postDelete, postUpdate, reactivateNetworkFreq, removeFreqFromNetwork, renameSavedAnalysisFilter, saveAnalysisFilter, scrollToElement, sendToastMsg, setThemeMode, showError, showErrorWithDetails, toggleDarkMode, triggerResize, updateNetwork, updateNetworkCallsign, updateNetworkFreq, updateNetworkPosts, updateNetworkUnits
    )

{-|

@docs Effect

@docs none, batch
@docs sendCmd, sendMsg

@docs pushRoute, replaceRoute
@docs pushRoutePath, replaceRoutePath
@docs loadExternalUrl, back

@docs map, toCmd

-}

import Bindings as B exposing (AnalysisStatsReq)
import Browser.Dom
import Browser.Navigation
import Bytes exposing (Bytes)
import Shared.Components.Toast
import Core.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Dict exposing (Dict)
import File.Download
import Http
import Json.Decode as Decode
import Json.Encode as Encode
import Process
import Route
import Route.Path
import Shared.Model
import Shared.Msg
import Task
import Time
import TimeZone
import Url exposing (Url)
import Utils.Api.Temp exposing (leExpectJson, resolve, resolveWithErrorCodeHeader)
import Utils.Time
import Utils.Utils exposing (decodePair)


type Effect msg
    = -- BASICS
      None
    | Batch (List (Effect msg))
    | SendCmd (Cmd msg)
      -- ROUTING
    | PushUrl String
    | ReplaceUrl String
    | LoadExternalUrl String
    | Back
      -- SHARED
    | SendSharedMsg Shared.Msg.Msg
      --
    | GetCurrentTime (Time.Posix -> msg)
    | GetTimeZone (Result TimeZone.Error ( String, Time.Zone ) -> msg)
    | GetElementById String (Result Browser.Dom.Error Browser.Dom.Element -> msg)
    | GetViewportById String (Result Browser.Dom.Error Browser.Dom.Viewport -> msg)
    | GetAnalysisSavedFilters (Result ApiError (List B.SavedFilter) -> msg)
    | GetUnits B.ListUnitsReq (Result ApiError B.ListUnitsRsp -> msg)
    | GetUnitsById (Result ApiError B.ListUnitsByIdRsp -> msg) B.ListUnitsByIdReq
    | GetMessagesComments (Result ApiError B.MessageComments -> msg) B.BatchMessageCommentsReq
    | GetUserInfo (Result ApiError B.User -> msg) B.UserInfoReq
    | GetLocations (Result ApiError B.LocationStatsRsp -> msg) B.AnalysisStatsReq
    | GetPosts (Result ApiError B.PostStatsRsp -> msg) B.AnalysisStatsReq
    | GetCallsigns (Result ApiError B.CallsignStatsRsp -> msg) B.AnalysisStatsReq
    | GetFreqs (Result ApiError B.FreqStatsRsp -> msg) B.AnalysisStatsReq
    | GetSenders (Result ApiError B.SenderStatsRsp -> msg) B.AnalysisStatsReq
    | GetNetworks (Result ApiError B.NetworkStatsRsp -> msg) B.AnalysisStatsReq
    | GetGroups (Result ApiError B.GroupStatsRsp -> msg) B.AnalysisStatsReq
    | GetAors (Result ApiError B.AreaOfResponsibilityStatsRsp -> msg) B.AnalysisStatsReq
    | GetMetadataStats (Result ApiError B.MetadataStatsRsp -> msg) B.AnalysisStatsReq
    | GetSystemSettings (Result ApiError B.SystemSettingsCurrentRsp -> msg)
    | FocusHtmlElement { elemId : String }
    | GetInboxMessages (Maybe String) (Result ApiError B.InboxMessagesRsp -> msg) B.InboxMessagesReq
    | GetStatsCount (Result ApiError B.CountStatsRsp -> msg) B.AnalysisStatsReq
    | GetTags (Result ApiError (List ( Int, B.Tag )) -> msg)
    | GetTags2 (Result ApiError B.TagStatsRsp -> msg) B.AnalysisStatsReq
    | GetFreqsSummaryTable (Result ApiError B.SummaryTableFreq -> msg) B.AnalysisStatsReq
    | GetFreqsSummaryTableXlsx (Result ApiError Bytes -> msg) B.AnalysisStatsReq
    | GetCallsignsGraph (Result ApiError B.NetJsonGraphAndMeta -> msg) B.CallsignsGraphReq
    | GetBookmarks (Result ApiError (List B.Bookmark) -> msg) B.BookmarkListReq
    | GetImportantMessagesIds (Result ApiError (List B.Important) -> msg) B.ImportantListReq
    | GetMessagesMapPoints (Result ApiError B.MapPointsRsp -> msg) B.MapPointsReq
    | GetGroupsActivityStats (Result ApiError GroupsActivityPerDayRsp -> msg) B.ListGroupsByFreqsPerDayReq
    | GetUnits2 (Result ApiError B.UnitStatsRsp -> msg) B.AnalysisStatsReq
    | GetDocxReportForDownload (Result ApiError ReportDownloadResult -> msg) B.ReportPreviewReq
    | DownloadFile String String Bytes
    | ScrollToElement { elemId : String, x : Int, y : Int }
    | InitNetjsonGraph { graphDataAndMeta : B.NetJsonGraphAndMeta, elemId : String }
    | GetNewCallsigns (Result ApiError B.NewCallsignsRes -> msg) B.AnalysisStatsReq
    | DeleteMessage (Result ApiError () -> msg) { id : Int }
    | GetCallsignsInfo (Result ApiError (List B.CallsignInfoRes) -> msg) B.RerCallsignInfoBatchReq
    | GetNetworksInfoByFreqs (Result ApiError (List B.Network) -> msg) (List String)
    | GetNetworksInfoByIds (Result ApiError (List B.Network) -> msg) (List Int)
    | AddMultipleCallsignsToNetwork (Result ApiError (List B.NetworkCallsign) -> msg) B.AddAsKnownNetworkCallsignReq
    | CreateNetworkCallsign (Result ApiError B.NetworkCallsign -> msg) B.CreateNetworkCallsignReq
    | DeleteNetworkCallsign (Result ApiError B.NetworkCallsign -> msg) Int
    | UpdateNetworkCallsign (Result ApiError B.NetworkCallsign -> msg) B.UpdateNetworkCallsignReq
    | DownloadKmz (Result ApiError Bytes -> msg) AnalysisStatsReq
    | DownloadGeojson (Result ApiError Bytes -> msg) B.AnalysisStatsReq
    | GetCorrelatedFreqs (Result ApiError B.CorrelatedFreqsRsp -> msg) B.AnalysisStatsReq
    | EditFreqUnitName (Result ApiError () -> msg) B.EditFreqUnitNameReq
    | SaveAnalysisFilter (Result ApiError (List B.SavedFilter) -> msg) B.SavedFilterUpsertReq
    | RenameSavedAnalysisFilter (Result ApiError () -> msg) { id : Int, name : String }
    | DeleteSavedAnalysisFilter (Result ApiError () -> msg) Int
    | GetMessagesByIds (Result ApiError B.MessageIdsRsp -> msg) B.MessageIdsReq
    | GetFreqActivityDaily (Result ApiError B.FreqDailyActivityCount -> msg) B.FreqStatsReq
    | GetInboxGroupsActivityStats (Result ApiError B.InboxByGroupDigestRsp -> msg)
    | CreateNetwork (Result ApiError B.Network -> msg) B.CreateNetworkReq
    | UpdateNetwork (Result ApiError B.Network -> msg) B.UpdateNetworkReq
    | KeepAlive (Result ApiError () -> msg) B.KeepAliveReq
    | AddFreqToNetwork (Result ApiError B.Network -> msg) B.AddNetworkFreqReq
    | ReactivateNetworkFreq (Result ApiError B.Network -> msg) B.ReactivateNetworkFreqReq
    | RemoveFreqFromNetwork (Result ApiError B.Network -> msg) B.DeleteNetworkFreqReq
    | GetNetworksList (Result ApiError B.ListNetworksRsp -> msg) B.ListNetworksReq
    | GetNetworksGroupsActivity (Result ApiError GroupsActivityPerDayRsp -> msg) B.NetworkGroupsActivityReq
    | GetNetworksCallsigns (Result ApiError CallsignsByNetwork -> msg) B.NetworkCallsignsReq
    | GetNetworkPoints (Result ApiError B.ListNetworkPointsRsp -> msg) B.ListNetworkPointsReq
    | GetUnitStatsForNetworks (Result ApiError B.NetworkUnitStatsRsp -> msg)
    | GetNetworksReport (Result ApiError Bytes -> msg) B.EtalonkaJimForksReq
    | GetNetworkCallsigns (Result ApiError B.SingleNetworkCallsignsListRsp -> msg) B.SingleNetworkCallsignsReq
    | GetNetworkCallsignsActivity (Result ApiError B.NetworkCallsignsActivityRsp -> msg) B.NetworkCallsignsActivityReq
    | GetNetworkCallsignsList (Result ApiError B.ListNetworkCallsignsRes -> msg) B.ListNetworkCallsignsReq
    | GetNetworkFreqCallsigns (Result ApiError B.NetworkFreqCallsignsRsp -> msg) B.NetworkFreqCallsignsReq
    | GetSingleNetwork (Result ApiError B.Network -> msg) Int
    | GetSingleNetworkGroupsActivity (Result ApiError GroupsByDate -> msg) B.NetworkGroupsActivityOneReq
    | GetNetworkFreqsActivity (Result ApiError (Dict String (Dict String Int)) -> msg) B.NetworkFreqsActivityReq
    | GetSingleNetworkFreqs (Result ApiError B.SingleNetworkFreqsListRsp -> msg) B.SingleNetworkFreqsReq
    | MergeNetworks (Result ApiError B.Network -> msg) B.MergeNetworkReq
    | GetEncryptions (Result ApiError (List B.EncryptionRec) -> msg)
    | UpdateNetworkPosts (Result ApiError B.Network -> msg) B.UpdateNetworkPostsReq
    | PostCreate (Result ApiError B.Post -> msg) B.CreatePostReq
    | PostUpdate (Result ApiError B.Post -> msg) B.UpdatePostReq
    | PostDelete (Result ApiError () -> msg) B.DeletePostReq
    | NetworkAddDescription (Result ApiError B.Network -> msg) B.AddNetworkDescriptionsReq
    | NetworkDeleteDescription (Result ApiError B.Network -> msg) B.DeleteNetworkDescriptionReq
    | NetworkUpdateDescription (Result ApiError B.Network -> msg) B.UpdateNetworkDescriptionReq
    | GetSignalsForNetwork (Result ApiError B.NetworkSignalsListRes -> msg) B.NetworkSignalsListReq
    | UpdateNetworkFreq (Result ApiError B.Network -> msg) B.UpdateNetworkFreqReq
    | GetNetworkReportBatch (Result ApiError Bytes -> msg) B.EtalonkaNetworkBatchReq
    | GetNetworkGoiReport (Result ApiError Bytes -> msg)
    | UpdateNetworkUnits (Result ApiError B.Network -> msg) B.UpdateNetworkUnitsReq
    | DeleteNetwork (Result ApiError B.Network -> msg) B.DeleteNetworkReq



-- BASICS


{-| Don't send any effect.
-}
none : Effect msg
none =
    None


{-| Send multiple effects at once.
-}
batch : List (Effect msg) -> Effect msg
batch =
    Batch


{-| Send a normal `Cmd msg` as an effect, something like `Http.get` or `Random.generate`.
-}
sendCmd : Cmd msg -> Effect msg
sendCmd =
    SendCmd


{-| Send a message as an effect. Useful when emitting events from UI components.
-}
sendMsg : msg -> Effect msg
sendMsg msg =
    Task.succeed msg
        |> Task.perform identity
        |> SendCmd


sendSharedMsg : Shared.Msg.Msg -> Effect msg
sendSharedMsg msg =
    SendSharedMsg msg



-- ROUTING


{-| Set the new route, and make the back button go back to the current route.
-}
pushRoute :
    { path : Route.Path.Path
    , query : Dict String String
    , hash : Maybe String
    }
    -> Effect msg
pushRoute route =
    PushUrl (Route.toString route)


{-| Same as `Effect.pushRoute`, but without `query` or `hash` support
-}
pushRoutePath : Route.Path.Path -> Effect msg
pushRoutePath path =
    PushUrl (Route.Path.toString path)


{-| Set the new route, but replace the previous one, so clicking the back
button **won't** go back to the previous route.
-}
replaceRoute :
    { path : Route.Path.Path
    , query : Dict String String
    , hash : Maybe String
    }
    -> Effect msg
replaceRoute route =
    ReplaceUrl (Route.toString route)


{-| Same as `Effect.replaceRoute`, but without `query` or `hash` support
-}
replaceRoutePath : Route.Path.Path -> Effect msg
replaceRoutePath path =
    ReplaceUrl (Route.Path.toString path)


{-| Redirect users to a new URL, somewhere external to your web application.
-}
loadExternalUrl : String -> Effect msg
loadExternalUrl =
    LoadExternalUrl


{-| Navigate back one page
-}
back : Effect msg
back =
    Back



--


logout : Effect msg
logout =
    SendSharedMsg Shared.Msg.SignOut


toggleDarkMode : Effect msg
toggleDarkMode =
    SendSharedMsg Shared.Msg.ToggleDarkMode


setThemeMode : Shared.Model.ThemeMode -> Effect msg
setThemeMode themeMode =
    SendSharedMsg (Shared.Msg.SetThemeMode themeMode)


triggerResize : Effect msg
triggerResize =
    SendSharedMsg Shared.Msg.TriggerResize


showError : String -> Effect msg
showError error =
    SendSharedMsg (Shared.Msg.ShowToast error)


{-| Show error toast with separate title and content
-}
showErrorWithDetails : String -> String -> Effect msg
showErrorWithDetails title content =
    SendSharedMsg (Shared.Msg.ShowToastWithDetails title content)


sendToastMsg : Shared.Components.Toast.Msg -> Effect msg
sendToastMsg toastMsg =
    SendSharedMsg (Shared.Msg.ToastMsg toastMsg)


getCurrentTime : (Time.Posix -> msg) -> Effect msg
getCurrentTime toMsg =
    GetCurrentTime toMsg


getTimeZone :
    (Result TimeZone.Error ( String, Time.Zone ) -> msg)
    -> Effect msg
getTimeZone toMsg =
    GetTimeZone toMsg


getElementById : String -> (Result Browser.Dom.Error Browser.Dom.Element -> msg) -> Effect msg
getElementById id_ toMsg =
    GetElementById id_ toMsg


getViewportById : String -> (Result Browser.Dom.Error Browser.Dom.Viewport -> msg) -> Effect msg
getViewportById id_ toMsg =
    GetViewportById id_ toMsg


scrollToElement : { elemId : String, x : Int, y : Int } -> Effect msg
scrollToElement payload =
    ScrollToElement payload


getAnalysisSavedFilters : (Result ApiError (List B.SavedFilter) -> msg) -> Effect msg
getAnalysisSavedFilters toMsg =
    GetAnalysisSavedFilters toMsg


getTags : (Result ApiError (List ( Int, B.Tag )) -> msg) -> Effect msg
getTags toMsg =
    GetTags toMsg


getUnits : (Result ApiError B.ListUnitsRsp -> msg) -> B.ListUnitsReq -> Effect msg
getUnits toMsg payload =
    GetUnits payload toMsg


getUnitsById : (Result ApiError B.ListUnitsByIdRsp -> msg) -> B.ListUnitsByIdReq -> Effect msg
getUnitsById toMsg payload =
    GetUnitsById toMsg payload


getMessagesComments : (Result ApiError B.MessageComments -> msg) -> B.BatchMessageCommentsReq -> Effect msg
getMessagesComments toMsg payload =
    GetMessagesComments toMsg payload


getUserInfo : (Result ApiError B.User -> msg) -> B.UserInfoReq -> Effect msg
getUserInfo toMsg payload =
    GetUserInfo toMsg payload


getLocations : (Result ApiError B.LocationStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getLocations toMsg payload =
    GetLocations toMsg payload


getPosts : (Result ApiError B.PostStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getPosts toMsg payload =
    GetPosts toMsg payload


getCallsigns : (Result ApiError B.CallsignStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getCallsigns toMsg payload =
    GetCallsigns toMsg payload


getFreqs : (Result ApiError B.FreqStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getFreqs toMsg payload =
    GetFreqs toMsg payload


getSenders : (Result ApiError B.SenderStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getSenders toMsg payload =
    GetSenders toMsg payload


getNetworks : (Result ApiError B.NetworkStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getNetworks toMsg payload =
    GetNetworks toMsg payload


getGroups : (Result ApiError B.GroupStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getGroups toMsg payload =
    GetGroups toMsg payload


getAors : (Result ApiError B.AreaOfResponsibilityStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getAors toMsg payload =
    GetAors toMsg payload


getMetadataStats : (Result ApiError B.MetadataStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getMetadataStats toMsg payload =
    GetMetadataStats toMsg payload


getSystemSettings : (Result ApiError B.SystemSettingsCurrentRsp -> msg) -> Effect msg
getSystemSettings toMsg =
    GetSystemSettings toMsg


focusHtmlElement : { elemId : String } -> Effect msg
focusHtmlElement payload =
    FocusHtmlElement payload


getInboxMessages : Maybe String -> (Result ApiError B.InboxMessagesRsp -> msg) -> B.InboxMessagesReq -> Effect msg
getInboxMessages token toMsg payload =
    GetInboxMessages token toMsg payload


getStatsCount : (Result ApiError B.CountStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getStatsCount toMsg payload =
    GetStatsCount toMsg payload


getCallsignsGraph : (Result ApiError B.NetJsonGraphAndMeta -> msg) -> B.CallsignsGraphReq -> Effect msg
getCallsignsGraph toMsg payload =
    GetCallsignsGraph toMsg payload


getImportantMessagesIds : (Result ApiError (List B.Important) -> msg) -> B.ImportantListReq -> Effect msg
getImportantMessagesIds toMsg payload =
    GetImportantMessagesIds toMsg payload



--TODO: rename


getTags2 : (Result ApiError B.TagStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getTags2 toMsg payload =
    GetTags2 toMsg payload


getFreqsSummaryTable : (Result ApiError B.SummaryTableFreq -> msg) -> B.AnalysisStatsReq -> Effect msg
getFreqsSummaryTable toMsg payload =
    GetFreqsSummaryTable toMsg payload


getFreqsSummaryTableXlsx : (Result ApiError Bytes -> msg) -> B.AnalysisStatsReq -> Effect msg
getFreqsSummaryTableXlsx toMsg payload =
    GetFreqsSummaryTableXlsx toMsg payload


getBookmarks : (Result ApiError (List B.Bookmark) -> msg) -> B.BookmarkListReq -> Effect msg
getBookmarks toMsg payload =
    GetBookmarks toMsg payload


getMessagesMapPoints : (Result ApiError B.MapPointsRsp -> msg) -> B.MapPointsReq -> Effect msg
getMessagesMapPoints toMsg payload =
    GetMessagesMapPoints toMsg payload


getGroupsActivityStats : (Result ApiError GroupsActivityPerDayRsp -> msg) -> B.ListGroupsByFreqsPerDayReq -> Effect msg
getGroupsActivityStats toMsg payload =
    GetGroupsActivityStats toMsg payload


getUnits2 : (Result ApiError B.UnitStatsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getUnits2 toMsg payload =
    GetUnits2 toMsg payload


type alias ReportDownloadResult =
    { bytes : Bytes
    , fileName : Maybe String
    }


getDocxReportForDownload : (Result ApiError ReportDownloadResult -> msg) -> B.ReportPreviewReq -> Effect msg
getDocxReportForDownload toMsg payload =
    GetDocxReportForDownload toMsg payload


downloadFile : String -> String -> Bytes -> Effect msg
downloadFile name content =
    DownloadFile name content


initNetjsonGraph : { graphDataAndMeta : B.NetJsonGraphAndMeta, elemId : String } -> Effect msg
initNetjsonGraph payload =
    InitNetjsonGraph payload


getNewCallsigns : (Result ApiError B.NewCallsignsRes -> msg) -> B.AnalysisStatsReq -> Effect msg
getNewCallsigns toMsg payload =
    GetNewCallsigns toMsg payload


deleteMessage : (Result ApiError () -> msg) -> { id : Int } -> Effect msg
deleteMessage toMsg payload =
    DeleteMessage toMsg payload


getCallsignsInfo : (Result ApiError (List B.CallsignInfoRes) -> msg) -> B.RerCallsignInfoBatchReq -> Effect msg
getCallsignsInfo toMsg payload =
    GetCallsignsInfo toMsg payload


getNetworksInfoByFreqs : (Result ApiError (List B.Network) -> msg) -> List String -> Effect msg
getNetworksInfoByFreqs toMsg payload =
    GetNetworksInfoByFreqs toMsg payload


getNetworksInfoByIds : (Result ApiError (List B.Network) -> msg) -> List Int -> Effect msg
getNetworksInfoByIds toMsg payload =
    GetNetworksInfoByIds toMsg payload


downloadKmz : (Result ApiError Bytes -> msg) -> AnalysisStatsReq -> Effect msg
downloadKmz toMsg payload =
    DownloadKmz toMsg payload


downloadGeojson : (Result ApiError Bytes -> msg) -> B.AnalysisStatsReq -> Effect msg
downloadGeojson toMsg payload =
    DownloadGeojson toMsg payload


getCorrelatedFreqs : (Result ApiError B.CorrelatedFreqsRsp -> msg) -> B.AnalysisStatsReq -> Effect msg
getCorrelatedFreqs toMsg payload =
    GetCorrelatedFreqs toMsg payload


editFreqUnitName : (Result ApiError () -> msg) -> B.EditFreqUnitNameReq -> Effect msg
editFreqUnitName toMsg payload =
    EditFreqUnitName toMsg payload


saveAnalysisFilter : (Result ApiError (List B.SavedFilter) -> msg) -> B.SavedFilterUpsertReq -> Effect msg
saveAnalysisFilter toMsg payload =
    SaveAnalysisFilter toMsg payload


renameSavedAnalysisFilter : (Result ApiError () -> msg) -> { id : Int, name : String } -> Effect msg
renameSavedAnalysisFilter toMsg payload =
    RenameSavedAnalysisFilter toMsg payload


deleteSavedAnalysisFilter : (Result ApiError () -> msg) -> Int -> Effect msg
deleteSavedAnalysisFilter toMsg payload =
    DeleteSavedAnalysisFilter toMsg payload


getMessagesByIds : (Result ApiError B.MessageIdsRsp -> msg) -> B.MessageIdsReq -> Effect msg
getMessagesByIds toMsg payload =
    GetMessagesByIds toMsg payload


getFreqActivityDaily : (Result ApiError B.FreqDailyActivityCount -> msg) -> B.FreqStatsReq -> Effect msg
getFreqActivityDaily toMsg payload =
    GetFreqActivityDaily toMsg payload


getInboxGroupsActivityStats : (Result ApiError B.InboxByGroupDigestRsp -> msg) -> Effect msg
getInboxGroupsActivityStats toMsg =
    GetInboxGroupsActivityStats toMsg


getNetworksList : (Result ApiError B.ListNetworksRsp -> msg) -> B.ListNetworksReq -> Effect msg
getNetworksList toMsg payload =
    GetNetworksList toMsg payload


createNetwork : (Result ApiError B.Network -> msg) -> B.CreateNetworkReq -> Effect msg
createNetwork toMsg payload =
    CreateNetwork toMsg payload


updateNetwork : (Result ApiError B.Network -> msg) -> B.UpdateNetworkReq -> Effect msg
updateNetwork toMsg payload =
    UpdateNetwork toMsg payload


keepAlive : (Result ApiError () -> msg) -> B.KeepAliveReq -> Effect msg
keepAlive toMsg payload =
    KeepAlive toMsg payload


addFreqToNetwork : (Result ApiError B.Network -> msg) -> B.AddNetworkFreqReq -> Effect msg
addFreqToNetwork toMsg payload =
    AddFreqToNetwork toMsg payload


reactivateNetworkFreq : (Result ApiError B.Network -> msg) -> B.ReactivateNetworkFreqReq -> Effect msg
reactivateNetworkFreq toMsg payload =
    ReactivateNetworkFreq toMsg payload


removeFreqFromNetwork : (Result ApiError B.Network -> msg) -> B.DeleteNetworkFreqReq -> Effect msg
removeFreqFromNetwork toMsg payload =
    RemoveFreqFromNetwork toMsg payload


getNetworksGroupsActivity : (Result ApiError GroupsActivityPerDayRsp -> msg) -> B.NetworkGroupsActivityReq -> Effect msg
getNetworksGroupsActivity toMsg payload =
    GetNetworksGroupsActivity toMsg payload


getNetworksCallsigns : (Result ApiError CallsignsByNetwork -> msg) -> B.NetworkCallsignsReq -> Effect msg
getNetworksCallsigns toMsg payload =
    GetNetworksCallsigns toMsg payload


getNetworkPoints : (Result ApiError B.ListNetworkPointsRsp -> msg) -> B.ListNetworkPointsReq -> Effect msg
getNetworkPoints toMsg payload =
    GetNetworkPoints toMsg payload


getUnitStatsForNetworks : (Result ApiError B.NetworkUnitStatsRsp -> msg) -> Effect msg
getUnitStatsForNetworks toMsg =
    GetUnitStatsForNetworks toMsg


getNetworksReport : (Result ApiError Bytes -> msg) -> B.EtalonkaJimForksReq -> Effect msg
getNetworksReport toMsg payload =
    GetNetworksReport toMsg payload


getNetworkCallsigns : (Result ApiError B.SingleNetworkCallsignsListRsp -> msg) -> B.SingleNetworkCallsignsReq -> Effect msg
getNetworkCallsigns toMsg payload =
    GetNetworkCallsigns toMsg payload


getNetworkCallsignsActivity : (Result ApiError B.NetworkCallsignsActivityRsp -> msg) -> B.NetworkCallsignsActivityReq -> Effect msg
getNetworkCallsignsActivity toMsg payload =
    GetNetworkCallsignsActivity toMsg payload


getNetworkCallsignsList : (Result ApiError B.ListNetworkCallsignsRes -> msg) -> B.ListNetworkCallsignsReq -> Effect msg
getNetworkCallsignsList toMsg payload =
    GetNetworkCallsignsList toMsg payload


getNetworkFreqCallsigns : (Result ApiError B.NetworkFreqCallsignsRsp -> msg) -> B.NetworkFreqCallsignsReq -> Effect msg
getNetworkFreqCallsigns toMsg payload =
    GetNetworkFreqCallsigns toMsg payload


getSingleNetwork : (Result ApiError B.Network -> msg) -> Int -> Effect msg
getSingleNetwork toMsg networkId =
    GetSingleNetwork toMsg networkId


getSingleNetworkGroupsActivity : (Result ApiError GroupsByDate -> msg) -> B.NetworkGroupsActivityOneReq -> Effect msg
getSingleNetworkGroupsActivity toMsg payload =
    GetSingleNetworkGroupsActivity toMsg payload


getNetworkFreqsActivity : (Result ApiError (Dict String (Dict String Int)) -> msg) -> B.NetworkFreqsActivityReq -> Effect msg
getNetworkFreqsActivity toMsg payload =
    GetNetworkFreqsActivity toMsg payload


getSingleNetworkFreqs : (Result ApiError B.SingleNetworkFreqsListRsp -> msg) -> B.SingleNetworkFreqsReq -> Effect msg
getSingleNetworkFreqs toMsg payload =
    GetSingleNetworkFreqs toMsg payload


getCallsignsInfoShared : List String -> Effect msg
getCallsignsInfoShared callsigns =
    SendSharedMsg (Shared.Msg.CallsignsInfoAskedByPage callsigns)


mergeNetworks : (Result ApiError B.Network -> msg) -> B.MergeNetworkReq -> Effect msg
mergeNetworks toMsg payload =
    MergeNetworks toMsg payload


getEncryptions : (Result ApiError (List B.EncryptionRec) -> msg) -> Effect msg
getEncryptions toMsg =
    GetEncryptions toMsg


updateNetworkPosts : (Result ApiError B.Network -> msg) -> B.UpdateNetworkPostsReq -> Effect msg
updateNetworkPosts toMsg payload =
    UpdateNetworkPosts toMsg payload


updateNetworkUnits : (Result ApiError B.Network -> msg) -> B.UpdateNetworkUnitsReq -> Effect msg
updateNetworkUnits toMsg payload =
    UpdateNetworkUnits toMsg payload


deleteNetwork : (Result ApiError B.Network -> msg) -> B.DeleteNetworkReq -> Effect msg
deleteNetwork toMsg payload =
    DeleteNetwork toMsg payload


loadPostsFromShared : B.ListPostsReq -> Effect msg
loadPostsFromShared payload =
    SendSharedMsg (Shared.Msg.PostLoadAll payload)


postCreate : (Result ApiError B.Post -> msg) -> B.CreatePostReq -> Effect msg
postCreate toMsg payload =
    PostCreate toMsg payload


postUpdate : (Result ApiError B.Post -> msg) -> B.UpdatePostReq -> Effect msg
postUpdate toMsg payload =
    PostUpdate toMsg payload


postDelete : (Result ApiError () -> msg) -> B.DeletePostReq -> Effect msg
postDelete toMsg payload =
    PostDelete toMsg payload


networkAddDescription : (Result ApiError B.Network -> msg) -> B.AddNetworkDescriptionsReq -> Effect msg
networkAddDescription toMsg payload =
    NetworkAddDescription toMsg payload


networkDeleteDescription : (Result ApiError B.Network -> msg) -> B.DeleteNetworkDescriptionReq -> Effect msg
networkDeleteDescription toMsg payload =
    NetworkDeleteDescription toMsg payload


networkUpdateDescription : (Result ApiError B.Network -> msg) -> B.UpdateNetworkDescriptionReq -> Effect msg
networkUpdateDescription toMsg payload =
    NetworkUpdateDescription toMsg payload


getSignalsForNetwork : (Result ApiError B.NetworkSignalsListRes -> msg) -> B.NetworkSignalsListReq -> Effect msg
getSignalsForNetwork toMsg payload =
    GetSignalsForNetwork toMsg payload


updateNetworkFreq : (Result ApiError B.Network -> msg) -> B.UpdateNetworkFreqReq -> Effect msg
updateNetworkFreq toMsg payload =
    UpdateNetworkFreq toMsg payload


getNetworkReportBatch : (Result ApiError Bytes -> msg) -> B.EtalonkaNetworkBatchReq -> Effect msg
getNetworkReportBatch toMsg payload =
    GetNetworkReportBatch toMsg payload


getNetworkGoiReport : (Result ApiError Bytes -> msg) -> Effect msg
getNetworkGoiReport toMsg =
    GetNetworkGoiReport toMsg



reportPollDelayMillis : Float
reportPollDelayMillis =
    2000


decodeJsonBody : Decode.Decoder a -> String -> Result String a
decodeJsonBody decoder body =
    Decode.decodeString decoder body
        |> Result.mapError Decode.errorToString


postJsonTask : String -> Encode.Value -> Decode.Decoder a -> Task.Task ApiError a
postJsonTask url body decoder =
    Http.task
        { method = "POST"
        , headers = []
        , url = url
        , body = Http.jsonBody body
        , resolver = Http.stringResolver (resolve (decodeJsonBody decoder))
        , timeout = Nothing
        }


postJsonTaskWithReportPermissionHeader : String -> Encode.Value -> Decode.Decoder a -> Task.Task ApiError a
postJsonTaskWithReportPermissionHeader url body decoder =
    Http.task
        { method = "POST"
        , headers = []
        , url = url
        , body = Http.jsonBody body
        , resolver = Http.stringResolver (resolveWithErrorCodeHeader "x-echo-error-code" (decodeJsonBody decoder))
        , timeout = Nothing
        }


postBytesTask : String -> Encode.Value -> Task.Task ApiError Bytes
postBytesTask url body =
    Http.task
        { method = "POST"
        , headers = []
        , url = url
        , body = Http.jsonBody body
        , resolver = Http.bytesResolver (resolve Ok)
        , timeout = Nothing
        }


reportHistoryStatusDecoder : Decode.Decoder ReportHistoryStatus
reportHistoryStatusDecoder =
    Decode.map3 ReportHistoryStatus
        (Decode.field "status" Decode.string)
        (Decode.field "last_error" (Decode.nullable Decode.string))
        (Decode.field "file_name" (Decode.nullable Decode.string))


type alias ReportHistoryStatus =
    { status : String
    , lastError : Maybe String
    , fileName : Maybe String
    }


reportHistoryError : ReportHistoryStatus -> ApiError
reportHistoryError row =
    { httpError = Http.BadBody (Maybe.withDefault "Report generation failed" row.lastError)
    , formErrors = Dict.empty
    , errors = Maybe.withDefault [] (Maybe.map List.singleton row.lastError)
    }


waitReportHistoryDone : Int -> Task.Task ApiError Int
waitReportHistoryDone reportHistoryId =
    waitReportHistoryDoneWithFilename reportHistoryId
        |> Task.map .id


waitReportHistoryDoneWithFilename : Int -> Task.Task ApiError { id : Int, fileName : Maybe String }
waitReportHistoryDoneWithFilename reportHistoryId =
    postJsonTask
        "/api/report-history/status"
        (B.reportHistoryIdReqEncoder { id = reportHistoryId })
        reportHistoryStatusDecoder
        |> Task.andThen
            (\row ->
                case row.status of
                    "done" ->
                        Task.succeed { id = reportHistoryId, fileName = row.fileName }

                    "failed" ->
                        Task.fail (reportHistoryError row)

                    "planned" ->
                        Process.sleep reportPollDelayMillis
                            |> Task.andThen (\_ -> waitReportHistoryDoneWithFilename reportHistoryId)

                    "in_progress" ->
                        Process.sleep reportPollDelayMillis
                            |> Task.andThen (\_ -> waitReportHistoryDoneWithFilename reportHistoryId)

                    _ ->
                        Task.fail (reportHistoryError row)
            )


downloadReportHistoryTask : Int -> Task.Task ApiError Bytes
downloadReportHistoryTask reportHistoryId =
    postBytesTask
        "/api/report-history/download"
        (B.reportHistoryIdReqEncoder { id = reportHistoryId })


launchReportTaskAndDownload : String -> Encode.Value -> (Result ApiError Bytes -> msg) -> Cmd msg
launchReportTaskAndDownload url body toMsg =
    postJsonTask url body Decode.int
        |> Task.andThen waitReportHistoryDone
        |> Task.andThen downloadReportHistoryTask
        |> Task.attempt toMsg


launchAnalysisReportTaskAndDownload : B.ReportPreviewReq -> (Result ApiError ReportDownloadResult -> msg) -> Cmd msg
launchAnalysisReportTaskAndDownload payload toMsg =
    postJsonTaskWithReportPermissionHeader
        "/api/rer/report-docx-task-launch"
        (B.reportPreviewReqEncoder payload)
        Decode.int
        |> Task.andThen waitReportHistoryDoneWithFilename
        |> Task.andThen
            (\row ->
                downloadReportHistoryTask row.id
                    |> Task.map
                        (\bytes ->
                            { bytes = bytes
                            , fileName = row.fileName
                            }
                        )
            )
        |> Task.attempt toMsg


-- INTERNALS


{-| Elm Land depends on this function to connect pages and layouts
together into the overall app.
-}
map : (msg1 -> msg2) -> Effect msg1 -> Effect msg2
map fn effect =
    case effect of
        None ->
            None

        Batch list ->
            Batch (List.map (map fn) list)

        SendCmd cmd ->
            SendCmd (Cmd.map fn cmd)

        PushUrl url ->
            PushUrl url

        ReplaceUrl url ->
            ReplaceUrl url

        Back ->
            Back

        LoadExternalUrl url ->
            LoadExternalUrl url

        SendSharedMsg sharedMsg ->
            SendSharedMsg sharedMsg

        GetCurrentTime toMsg ->
            GetCurrentTime (fn << toMsg)

        GetTimeZone toMsg ->
            GetTimeZone (fn << toMsg)

        GetElementById id toMsg ->
            GetElementById id (fn << toMsg)

        GetViewportById id toMsg ->
            GetViewportById id (fn << toMsg)

        GetAnalysisSavedFilters toMsg ->
            GetAnalysisSavedFilters (fn << toMsg)

        GetTags toMsg ->
            GetTags (fn << toMsg)

        GetUnits payload toMsg ->
            GetUnits payload (fn << toMsg)

        GetMessagesComments toMsg payload ->
            GetMessagesComments (fn << toMsg) payload

        GetUserInfo toMsg payload ->
            GetUserInfo (fn << toMsg) payload

        GetUnitsById toMsg payload ->
            GetUnitsById (fn << toMsg) payload

        GetLocations toMsg payload ->
            GetLocations (fn << toMsg) payload

        GetPosts toMsg payload ->
            GetPosts (fn << toMsg) payload

        GetSenders toMsg payload ->
            GetSenders (fn << toMsg) payload

        GetNetworks toMsg payload ->
            GetNetworks (fn << toMsg) payload

        GetGroups toMsg payload ->
            GetGroups (fn << toMsg) payload

        GetAors toMsg payload ->
            GetAors (fn << toMsg) payload

        GetMetadataStats toMsg payload ->
            GetMetadataStats (fn << toMsg) payload

        GetSystemSettings toMsg ->
            GetSystemSettings (fn << toMsg)

        GetFreqs toMsg payload ->
            GetFreqs (fn << toMsg) payload

        GetCallsigns toMsg payload ->
            GetCallsigns (fn << toMsg) payload

        FocusHtmlElement payload ->
            FocusHtmlElement payload

        GetInboxMessages token toMsg payload ->
            GetInboxMessages token (fn << toMsg) payload

        GetStatsCount toMsg payload ->
            GetStatsCount (fn << toMsg) payload

        GetTags2 toMsg payload ->
            GetTags2 (fn << toMsg) payload

        GetFreqsSummaryTable toMsg payload ->
            GetFreqsSummaryTable (fn << toMsg) payload

        GetFreqsSummaryTableXlsx toMsg payload ->
            GetFreqsSummaryTableXlsx (fn << toMsg) payload

        GetCallsignsGraph toMsg payload ->
            GetCallsignsGraph (fn << toMsg) payload

        GetBookmarks toMsg payload ->
            GetBookmarks (fn << toMsg) payload

        GetImportantMessagesIds toMsg payload ->
            GetImportantMessagesIds (fn << toMsg) payload

        GetMessagesMapPoints toMsg payload ->
            GetMessagesMapPoints (fn << toMsg) payload

        GetGroupsActivityStats toMsg payload ->
            GetGroupsActivityStats (fn << toMsg) payload

        GetUnits2 toMsg payload ->
            GetUnits2 (fn << toMsg) payload

        GetDocxReportForDownload toMsg payload ->
            GetDocxReportForDownload (fn << toMsg) payload

        DownloadFile name mime content ->
            DownloadFile name mime content

        ScrollToElement payload ->
            ScrollToElement payload

        InitNetjsonGraph payload ->
            InitNetjsonGraph payload

        GetNewCallsigns toMsg payload ->
            GetNewCallsigns (fn << toMsg) payload

        DeleteMessage toMsg payload ->
            DeleteMessage (fn << toMsg) payload

        GetCallsignsInfo toMsg payload ->
            GetCallsignsInfo (fn << toMsg) payload

        GetNetworksInfoByFreqs toMsg payload ->
            GetNetworksInfoByFreqs (fn << toMsg) payload

        GetNetworksInfoByIds toMsg payload ->
            GetNetworksInfoByIds (fn << toMsg) payload

        AddMultipleCallsignsToNetwork toMsg payload ->
            AddMultipleCallsignsToNetwork (fn << toMsg) payload

        CreateNetworkCallsign toMsg payload ->
            CreateNetworkCallsign (fn << toMsg) payload

        DeleteNetworkCallsign toMsg callsignId ->
            DeleteNetworkCallsign (fn << toMsg) callsignId

        UpdateNetworkCallsign toMsg payload ->
            UpdateNetworkCallsign (fn << toMsg) payload

        DownloadKmz toMsg payload ->
            DownloadKmz (fn << toMsg) payload

        DownloadGeojson toMsg payload ->
            DownloadGeojson (fn << toMsg) payload

        GetCorrelatedFreqs toMsg payload ->
            GetCorrelatedFreqs (fn << toMsg) payload

        EditFreqUnitName toMsg payload ->
            EditFreqUnitName (fn << toMsg) payload

        SaveAnalysisFilter toMsg payload ->
            SaveAnalysisFilter (fn << toMsg) payload

        RenameSavedAnalysisFilter toMsg payload ->
            RenameSavedAnalysisFilter (fn << toMsg) payload

        DeleteSavedAnalysisFilter toMsg payload ->
            DeleteSavedAnalysisFilter (fn << toMsg) payload

        GetMessagesByIds toMsg payload ->
            GetMessagesByIds (fn << toMsg) payload

        GetFreqActivityDaily toMsg payload ->
            GetFreqActivityDaily (fn << toMsg) payload

        GetInboxGroupsActivityStats toMsg ->
            GetInboxGroupsActivityStats (fn << toMsg)

        GetNetworksList toMsg payload ->
            GetNetworksList (fn << toMsg) payload

        CreateNetwork toMsg payload ->
            CreateNetwork (fn << toMsg) payload

        UpdateNetwork toMsg payload ->
            UpdateNetwork (fn << toMsg) payload

        KeepAlive toMsg payload ->
            KeepAlive (fn << toMsg) payload

        AddFreqToNetwork toMsg payload ->
            AddFreqToNetwork (fn << toMsg) payload

        ReactivateNetworkFreq toMsg payload ->
            ReactivateNetworkFreq (fn << toMsg) payload

        RemoveFreqFromNetwork toMsg payload ->
            RemoveFreqFromNetwork (fn << toMsg) payload

        GetNetworksGroupsActivity toMsg payload ->
            GetNetworksGroupsActivity (fn << toMsg) payload

        GetNetworksCallsigns toMsg payload ->
            GetNetworksCallsigns (fn << toMsg) payload

        GetNetworkPoints toMsg payload ->
            GetNetworkPoints (fn << toMsg) payload

        GetUnitStatsForNetworks toMsg ->
            GetUnitStatsForNetworks (fn << toMsg)

        GetNetworksReport toMsg payload ->
            GetNetworksReport (fn << toMsg) payload

        GetNetworkCallsigns toMsg payload ->
            GetNetworkCallsigns (fn << toMsg) payload

        GetNetworkCallsignsActivity toMsg payload ->
            GetNetworkCallsignsActivity (fn << toMsg) payload

        GetNetworkCallsignsList toMsg payload ->
            GetNetworkCallsignsList (fn << toMsg) payload

        GetNetworkFreqCallsigns toMsg payload ->
            GetNetworkFreqCallsigns (fn << toMsg) payload

        GetSingleNetwork toMsg payload ->
            GetSingleNetwork (fn << toMsg) payload

        GetSingleNetworkGroupsActivity toMsg payload ->
            GetSingleNetworkGroupsActivity (fn << toMsg) payload

        GetNetworkFreqsActivity toMsg payload ->
            GetNetworkFreqsActivity (fn << toMsg) payload

        GetSingleNetworkFreqs toMsg payload ->
            GetSingleNetworkFreqs (fn << toMsg) payload

        MergeNetworks toMsg payload ->
            MergeNetworks (fn << toMsg) payload

        GetEncryptions toMsg ->
            GetEncryptions (fn << toMsg)

        UpdateNetworkPosts toMsg payload ->
            UpdateNetworkPosts (fn << toMsg) payload

        PostCreate toMsg payload ->
            PostCreate (fn << toMsg) payload

        PostUpdate toMsg payload ->
            PostUpdate (fn << toMsg) payload

        PostDelete toMsg payload ->
            PostDelete (fn << toMsg) payload

        NetworkAddDescription toMsg payload ->
            NetworkAddDescription (fn << toMsg) payload

        NetworkUpdateDescription toMsg payload ->
            NetworkUpdateDescription (fn << toMsg) payload

        NetworkDeleteDescription toMsg payload ->
            NetworkDeleteDescription (fn << toMsg) payload

        GetSignalsForNetwork toMsg payload ->
            GetSignalsForNetwork (fn << toMsg) payload

        UpdateNetworkFreq toMsg payload ->
            UpdateNetworkFreq (fn << toMsg) payload

        GetNetworkReportBatch toMsg payload ->
            GetNetworkReportBatch (fn << toMsg) payload

        GetNetworkGoiReport toMsg ->
            GetNetworkGoiReport (fn << toMsg)

        UpdateNetworkUnits toMsg payload ->
            UpdateNetworkUnits (fn << toMsg) payload

        DeleteNetwork toMsg payload ->
            DeleteNetwork (fn << toMsg) payload


{-| Elm Land depends on this function to perform your effects.
-}
toCmd :
    { key : Browser.Navigation.Key
    , url : Url
    , shared : Shared.Model.Model
    , fromSharedMsg : Shared.Msg.Msg -> msg
    , batch : List msg -> msg
    , toCmd : msg -> Cmd msg
    }
    -> Effect msg
    -> Cmd msg
toCmd options effect =
    case effect of
        None ->
            Cmd.none

        Batch list ->
            Cmd.batch (List.map (toCmd options) list)

        SendCmd cmd ->
            cmd

        PushUrl url ->
            Browser.Navigation.pushUrl options.key url

        ReplaceUrl url ->
            Browser.Navigation.replaceUrl options.key url

        Back ->
            Browser.Navigation.back options.key 1

        LoadExternalUrl url ->
            Browser.Navigation.load url

        SendSharedMsg sharedMsg ->
            Task.succeed sharedMsg
                |> Task.perform options.fromSharedMsg

        GetCurrentTime toMsg ->
            Task.perform toMsg Time.now

        GetTimeZone toMsg ->
            Task.attempt toMsg Utils.Time.getZone

        GetElementById id_ toMsg ->
            Task.attempt toMsg (Browser.Dom.getElement id_)

        GetViewportById id_ toMsg ->
            Task.attempt toMsg (Browser.Dom.getViewportOf id_)

        GetAnalysisSavedFilters toMsg ->
            Http.post
                { url = "/api/rer/analysis/saved-filters"
                , body = Http.jsonBody (Encode.object [])
                , expect = leExpectJson toMsg (Decode.list B.savedFilterDecoder)
                }

        GetTags toMsg ->
            Http.post
                { url = "/api/tags/tags-list"
                , body = Http.jsonBody (Encode.object [])
                , expect = leExpectJson toMsg (Decode.list (decodePair Decode.int B.tagDecoder))
                }

        GetUnits payload toMsg ->
            Http.post
                { url = "/api/sigint/units"
                , body = Http.jsonBody (B.listUnitsReqEncoder payload)
                , expect = leExpectJson toMsg B.listUnitsRspDecoder
                }

        GetMessagesComments toMsg payload ->
            Http.post
                { url = "/api/rer/message/comments-batch"
                , body = Http.jsonBody (B.batchMessageCommentsReqEncoder payload)
                , expect = leExpectJson toMsg B.messageCommentsDecoder
                }

        GetUserInfo toMsg payload ->
            Http.post
                { url = "/api/user/user-info"
                , body =
                    Http.jsonBody (B.userInfoReqEncoder payload)
                , expect = leExpectJson toMsg B.userDecoder
                }

        GetUnitsById toMsg payload ->
            Http.post
                { url = "/api/sigint/units-by-id"
                , body = Http.jsonBody (B.listUnitsByIdReqEncoder payload)
                , expect = leExpectJson toMsg B.listUnitsByIdRspDecoder
                }

        GetLocations toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/locations"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.locationStatsRspDecoder
                }

        GetPosts toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/posts"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.postStatsRspDecoder
                }

        GetSenders toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/senders"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.senderStatsRspDecoder
                }

        GetNetworks toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/networks"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.networkStatsRspDecoder
                }

        GetGroups toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/groups"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.groupStatsRspDecoder
                }

        GetAors toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/aors"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.areaOfResponsibilityStatsRspDecoder
                }

        GetMetadataStats toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/metadata"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.metadataStatsRspDecoder
                }

        GetSystemSettings toMsg ->
            Http.post
                { url = "/api/system-settings/current"
                , body = Http.emptyBody
                , expect = leExpectJson toMsg B.systemSettingsCurrentRspDecoder
                }

        GetFreqs toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/freqs"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.freqStatsRspDecoder
                }

        GetCallsigns toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/callsigns"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.callsignStatsRspDecoder
                }

        GetInboxMessages token toMsg payload ->
            Http.request
                { method = "POST"
                , url = "/api/rer-importer/get-inbox"
                , body = Http.jsonBody (B.inboxMessagesReqEncoder payload)
                , expect = leExpectJson toMsg B.inboxMessagesRspDecoder
                , headers = []
                , timeout = Nothing
                , tracker = token
                }

        GetStatsCount toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/count"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.countStatsRspDecoder
                }

        GetTags2 toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/tags"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.tagStatsRspDecoder
                }

        GetFreqsSummaryTable toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/summary-table-freq"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.summaryTableFreqDecoder
                }

        GetFreqsSummaryTableXlsx toMsg payload ->
            launchReportTaskAndDownload
                "/api/rer/analysis/summary-table-task-launch"
                (B.analysisStatsReqEncoder payload)
                toMsg

        GetCallsignsGraph toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/callsigns-graph"
                , body = Http.jsonBody (B.callsignsGraphReqEncoder payload)
                , expect = leExpectJson toMsg B.netJsonGraphAndMetaDecoder
                }

        GetBookmarks toMsg payload ->
            Http.post
                { url = "/api/rer/bookmarks"
                , body = Http.jsonBody (B.bookmarkListReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.list B.bookmarkDecoder)
                }

        GetImportantMessagesIds toMsg payload ->
            Http.post
                { url = "/api/rer/importants"
                , body = Http.jsonBody (B.importantListReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.list B.importantDecoder)
                }

        GetMessagesMapPoints toMsg payload ->
            Http.post
                { url = "/api/rer-importer/get-inbox-map"
                , body = Http.jsonBody (B.mapPointsReqEncoder payload)
                , expect = leExpectJson toMsg B.mapPointsRspDecoder
                }

        GetGroupsActivityStats toMsg payload ->
            Http.post
                { url = "/api/sigint/freq/groups-per-day"
                , body = Http.jsonBody (B.listGroupsByFreqsPerDayReqEncoder payload)
                , expect = leExpectJson toMsg groupsByFreqsPerDayRspDecoder
                }

        GetUnits2 toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/stats/units"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.unitStatsRspDecoder
                }

        GetDocxReportForDownload toMsg payload ->
            launchAnalysisReportTaskAndDownload payload toMsg

        DownloadFile name mime content ->
            File.Download.bytes name mime content

        GetNewCallsigns toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/new-callsigns"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.newCallsignsResDecoder
                }

        DeleteMessage toMsg payload ->
            Http.post
                { url = "/api/rer-importer/delete-message"
                , body = Http.jsonBody (B.inboxDeleteReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.succeed ())
                }

        GetCallsignsInfo toMsg payload ->
            Http.post
                { url = "/api/rer/callsign-info-batch"
                , body = Http.jsonBody (B.rerCallsignInfoBatchReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.list B.callsignInfoResDecoder)
                }

        GetNetworksInfoByFreqs toMsg payload ->
            Http.post
                { url = "/api/sigint/network-info-batch-freq"
                , body = Http.jsonBody (Encode.list Encode.string payload)
                , expect = leExpectJson toMsg (Decode.list B.networkDecoder)
                }

        GetNetworksInfoByIds toMsg payload ->
            Http.post
                { url = "/api/sigint/network-info-batch-id"
                , body = Http.jsonBody (Encode.list Encode.int payload)
                , expect = leExpectJson toMsg (Decode.list B.networkDecoder)
                }

        AddMultipleCallsignsToNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsign/add-as-known"
                , body = Http.jsonBody (B.addAsKnownNetworkCallsignReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.list B.networkCallsignDecoder)
                }

        CreateNetworkCallsign toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsign/create"
                , body = Http.jsonBody (B.createNetworkCallsignReqEncoder payload)
                , expect = leExpectJson toMsg B.networkCallsignDecoder
                }

        DeleteNetworkCallsign toMsg callsignId ->
            Http.post
                { url = "/api/sigint/network-callsign/delete"
                , body = Http.jsonBody (Encode.int callsignId)
                , expect = leExpectJson toMsg B.networkCallsignDecoder
                }

        UpdateNetworkCallsign toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsign/update"
                , body = Http.jsonBody (B.updateNetworkCallsignReqEncoder payload)
                , expect = leExpectJson toMsg B.networkCallsignDecoder
                }

        DownloadKmz toMsg payload ->
            launchReportTaskAndDownload
                "/api/rer/analysis/kmz-task-launch"
                (B.analysisStatsReqEncoder payload)
                toMsg

        DownloadGeojson toMsg payload ->
            launchReportTaskAndDownload
                "/api/rer/analysis/geojson-task-launch"
                (B.analysisStatsReqEncoder payload)
                toMsg

        GetCorrelatedFreqs toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/correlated-freqs"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.correlatedFreqsRspDecoder
                }

        EditFreqUnitName toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/freq-edit-unit-name"
                , body = Http.jsonBody (B.editFreqUnitNameReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.succeed ())
                }

        SaveAnalysisFilter toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/saved-filter-upsert"
                , body = Http.jsonBody (B.savedFilterUpsertReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.list B.savedFilterDecoder)
                }

        RenameSavedAnalysisFilter toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/saved-filter-rename"
                , body = Http.jsonBody (B.savedFilterRenameReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.succeed ())
                }

        DeleteSavedAnalysisFilter toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/saved-filter-delete"
                , body = Http.jsonBody (Encode.int payload)
                , expect = leExpectJson toMsg (Decode.succeed ())
                }

        GetMessagesByIds toMsg payload ->
            Http.request
                { method = "POST"
                , url = "/api/rer-importer/messages-by-id"
                , body = Http.jsonBody (B.messageIdsReqEncoder payload)
                , expect = leExpectJson toMsg B.messageIdsRspDecoder
                , headers = []
                , timeout = Nothing
                , tracker = Nothing
                }

        GetFreqActivityDaily toMsg payload ->
            Http.post
                { url = "/api/sigint/freqs/daily"
                , body = Http.jsonBody (B.freqStatsReqEncoder payload)
                , expect = leExpectJson toMsg B.freqDailyActivityCountDecoder
                }

        GetInboxGroupsActivityStats toMsg ->
            Http.post
                { url = "/api/rer-importer/get-inbox-group-stats"
                , body = Http.jsonBody (Encode.object [])
                , expect = leExpectJson toMsg B.inboxByGroupDigestRspDecoder
                }

        CreateNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/create-network"
                , body = Http.jsonBody (B.createNetworkReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        UpdateNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/update-network"
                , body = Http.jsonBody (B.updateNetworkReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        KeepAlive toMsg payload ->
            Http.post
                { url = "/api/user/keep-alive"
                , body = Http.jsonBody (B.keepAliveReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.succeed ())
                }

        AddFreqToNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/network/add-freq"
                , body = Http.jsonBody (B.addNetworkFreqReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        ReactivateNetworkFreq toMsg payload ->
            Http.post
                { url = "/api/sigint/network/reactivate-freq"
                , body = Http.jsonBody (B.reactivateNetworkFreqReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        RemoveFreqFromNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/network/delete-freq"
                , body = Http.jsonBody (B.deleteNetworkFreqReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        GetNetworksList toMsg payload ->
            Http.post
                { url = "/api/sigint/network-list"
                , body = Http.jsonBody (B.listNetworksReqEncoder payload)
                , expect = leExpectJson toMsg B.listNetworksRspDecoder
                }

        GetNetworksGroupsActivity toMsg payload ->
            Http.post
                { url = "/api/sigint/network-group-activity"
                , body = Http.jsonBody (B.networkGroupsActivityReqEncoder payload)
                , expect = leExpectJson toMsg groupsByFreqsPerDayRspDecoder
                }

        GetNetworksCallsigns toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsigns"
                , body = Http.jsonBody (B.networkCallsignsReqEncoder payload)
                , expect = leExpectJson toMsg callsignsByNetworkDecoder
                }

        GetNetworkPoints toMsg payload ->
            Http.post
                { url = "/api/sigint/network-points"
                , body = Http.jsonBody (B.listNetworkPointsReqEncoder payload)
                , expect = leExpectJson toMsg B.listNetworkPointsRspDecoder
                }

        GetUnitStatsForNetworks toMsg ->
            Http.post
                { url = "/api/sigint/network/unit-stats"
                , body = Http.jsonBody (Encode.object [])
                , expect = leExpectJson toMsg B.networkUnitStatsRspDecoder
                }

        GetNetworksReport toMsg payload ->
            launchReportTaskAndDownload
                "/api/sigint/etalonka/report-networks-task-launch"
                (B.etalonkaJimForksReqEncoder payload)
                toMsg

        GetNetworkCallsigns toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsigns-list"
                , body = Http.jsonBody (B.singleNetworkCallsignsReqEncoder payload)
                , expect = leExpectJson toMsg B.singleNetworkCallsignsListRspDecoder
                }

        GetNetworkCallsignsActivity toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsigns/activity"
                , body = Http.jsonBody (B.networkCallsignsActivityReqEncoder payload)
                , expect = leExpectJson toMsg B.networkCallsignsActivityRspDecoder
                }

        GetNetworkCallsignsList toMsg payload ->
            Http.post
                { url = "/api/sigint/network-callsigns/list"
                , body = Http.jsonBody (B.listNetworkCallsignsReqEncoder payload)
                , expect = leExpectJson toMsg B.listNetworkCallsignsResDecoder
                }

        GetNetworkFreqCallsigns toMsg payload ->
            Http.post
                { url = "/api/sigint/network-freq-callsigns"
                , body = Http.jsonBody (B.networkFreqCallsignsReqEncoder payload)
                , expect = leExpectJson toMsg B.networkFreqCallsignsRspDecoder
                }

        GetSingleNetwork toMsg networkId ->
            Http.post
                { url = "/api/sigint/network-info-one"
                , body = Http.jsonBody (Encode.int networkId)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        GetSingleNetworkGroupsActivity toMsg payload ->
            Http.post
                { url = "/api/sigint/network-group-activity-one"
                , body = Http.jsonBody (B.networkGroupsActivityOneReqEncoder payload)
                , expect = leExpectJson toMsg groupsPerDayRspDecoder
                }

        GetNetworkFreqsActivity toMsg payload ->
            Http.post
                { url = "/api/sigint/network-freqs-activity-one"
                , body = Http.jsonBody (B.networkFreqsActivityReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.dict (Decode.dict Decode.int))
                }

        GetSingleNetworkFreqs toMsg payload ->
            Http.post
                { url = "/api/sigint/network-freqs-list"
                , body = Http.jsonBody (B.singleNetworkFreqsReqEncoder payload)
                , expect = leExpectJson toMsg B.singleNetworkFreqsListRspDecoder
                }

        MergeNetworks toMsg payload ->
            Http.post
                { url = "/api/sigint/merge-network"
                , body = Http.jsonBody (B.mergeNetworkReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        GetEncryptions toMsg ->
            Http.post
                { url = "/api/sigint/encryptions-list"
                , body = Http.jsonBody (Encode.object [])
                , expect = leExpectJson toMsg (Decode.list B.encryptionRecDecoder)
                }

        UpdateNetworkPosts toMsg payload ->
            Http.post
                { url = "/api/sigint/network/update-posts"
                , body = Http.jsonBody (B.updateNetworkPostsReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        PostCreate toMsg payload ->
            Http.post
                { url = "/api/sigint/post/create"
                , body = Http.jsonBody (B.createPostReqEncoder payload)
                , expect = leExpectJson toMsg B.postDecoder
                }

        PostUpdate toMsg payload ->
            Http.post
                { url = "/api/sigint/post/update"
                , body = Http.jsonBody (B.updatePostReqEncoder payload)
                , expect = leExpectJson toMsg B.postDecoder
                }

        PostDelete toMsg payload ->
            Http.post
                { url = "/api/sigint/post/delete"
                , body = Http.jsonBody (B.deletePostReqEncoder payload)
                , expect = leExpectJson toMsg (Decode.succeed ())
                }

        NetworkAddDescription toMsg payload ->
            Http.post
                { url = "/api/sigint/network/add-descriptions"
                , body = Http.jsonBody (B.addNetworkDescriptionsReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        NetworkDeleteDescription toMsg payload ->
            Http.post
                { url = "/api/sigint/network/delete-description"
                , body = Http.jsonBody (B.deleteNetworkDescriptionReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        NetworkUpdateDescription toMsg payload ->
            Http.post
                { url = "/api/sigint/network/update-description"
                , body = Http.jsonBody (B.updateNetworkDescriptionReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        GetSignalsForNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/network-signals-list"
                , body = Http.jsonBody (B.networkSignalsListReqEncoder payload)
                , expect = leExpectJson toMsg B.networkSignalsListResDecoder
                }

        UpdateNetworkFreq toMsg payload ->
            Http.post
                { url = "/api/sigint/network/update-freq"
                , body = Http.jsonBody (B.updateNetworkFreqReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        GetNetworkReportBatch toMsg payload ->
            launchReportTaskAndDownload
                "/api/sigint/etalonka/report-networks-batch-id-task-launch"
                (B.etalonkaNetworkBatchReqEncoder payload)
                toMsg

        GetNetworkGoiReport toMsg ->
            launchReportTaskAndDownload
                "/api/sigint/network/report-networks-goi-task-launch"
                (Encode.object [])
                toMsg

        UpdateNetworkUnits toMsg payload ->
            Http.post
                { url = "/api/sigint/network/update-units"
                , body = Http.jsonBody (B.updateNetworkUnitsReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        DeleteNetwork toMsg payload ->
            Http.post
                { url = "/api/sigint/delete-network"
                , body = Http.jsonBody (B.deleteNetworkReqEncoder payload)
                , expect = leExpectJson toMsg B.networkDecoder
                }

        FocusHtmlElement payload ->
            port_focusHtmlElement payload

        ScrollToElement payload ->
            port_scrollToElement payload

        InitNetjsonGraph payload ->
            port_initNetjsonGraph payload


groupsByFreqsPerDayRspDecoder : Decode.Decoder GroupsActivityPerDayRsp
groupsByFreqsPerDayRspDecoder =
    Decode.dict (Decode.dict (Decode.dict Decode.int))


groupsPerDayRspDecoder : Decode.Decoder GroupsByDate
groupsPerDayRspDecoder =
    Decode.dict (Decode.dict Decode.int)


type alias CallsignsByNetwork =
    Dict String (List String)


callsignsByNetworkDecoder : Decode.Decoder (Dict String (List String))
callsignsByNetworkDecoder =
    Decode.dict (Decode.list Decode.string)


addMultipleCallsignsToNetwork : (Result ApiError (List B.NetworkCallsign) -> msg) -> B.AddAsKnownNetworkCallsignReq -> Effect msg
addMultipleCallsignsToNetwork toMsg payload =
    AddMultipleCallsignsToNetwork toMsg payload


createNetworkCallsign : (Result ApiError B.NetworkCallsign -> msg) -> B.CreateNetworkCallsignReq -> Effect msg
createNetworkCallsign toMsg payload =
    CreateNetworkCallsign toMsg payload


deleteNetworkCallsign : (Result ApiError B.NetworkCallsign -> msg) -> Int -> Effect msg
deleteNetworkCallsign toMsg callsignId =
    DeleteNetworkCallsign toMsg callsignId


updateNetworkCallsign : (Result ApiError B.NetworkCallsign -> msg) -> B.UpdateNetworkCallsignReq -> Effect msg
updateNetworkCallsign toMsg payload =
    UpdateNetworkCallsign toMsg payload



--PORTS


port port_focusHtmlElement : { elemId : String } -> Cmd msg


port port_scrollToElement : { elemId : String, x : Int, y : Int } -> Cmd msg


port port_initNetjsonGraph :
    { elemId : String
    , graphDataAndMeta : B.NetJsonGraphAndMeta
    }
    -> Cmd msg
