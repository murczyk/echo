port module Effect exposing
    ( Effect
    , none, batch
    , sendCmd, sendMsg, sendSharedMsg
    , pushRoute, replaceRoute
    , pushRoutePath, replaceRoutePath
    , loadExternalUrl, back
    , map, toCmd
    , CallsignsByNetwork, addFreqToNetwork, addMultipleCallsignsToNetwork, createNetwork, createNetworkCallsign, deleteMessage, deleteNetwork, deleteNetworkCallsign, deleteSavedAnalysisFilter, downloadFile, downloadGeojson, downloadKmz, editFreqUnitName, focusHtmlElement, getAnalysisSavedFilters, getAors, getBookmarks, getCallsigns, getCallsignsGraph, getCallsignsInfo, getCallsignsInfoShared, getCorrelatedFreqs, getCurrentTime, getDocxReportForDownload, getElementById, getFreqActivityDaily, getFreqs, getFreqsSummaryTable, getFreqsSummaryTableXlsx, getGroups, getGroupsActivityStats, getImportantMessagesIds, getInboxGroupsActivityStats, getInboxMessages, getLocations, getMessagesByIds, getMessagesComments, getMessagesMapPoints, getMetadataStats, getModulations, getNetworkCallsigns, getNetworkCallsignsActivity, getNetworkCallsignsList, getNetworkFreqCallsigns, getNetworkFreqsActivity, getNetworkGoiReport, getNetworkPoints, getNetworkReportBatch, getNetworksCallsigns, getNetworksGroupsActivity, getNetworksInfoByFreqs, getNetworksInfoByIds, getNetworksList, getNetworksReport, getNewCallsigns, getPosts, getSenders, getNetworks, getSignalsForNetwork, getSingleNetwork, getSingleNetworkFreqs, getSingleNetworkGroupsActivity, getStatsCount, getSystemSettings, getTags, getTags2, getTimeZone, getUnitStatsForNetworks, getUnits, getUnits2, getUnitsById, getUserInfo, getViewportById, initNetjsonGraph, keepAlive, loadPostsFromShared, logout, mergeNetworks, networkAddDescription, networkDeleteDescription, networkUpdateDescription, postCreate, postDelete, postUpdate, removeFreqFromNetwork, renameSavedAnalysisFilter, saveAnalysisFilter, scrollToElement, sendToastMsg, setThemeMode, showError, showErrorWithDetails, toggleDarkMode, triggerResize, updateNetwork, updateNetworkCallsign, updateNetworkFreq, updateNetworkPosts, updateNetworkUnits
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
import Route
import Route.Path
import Shared.Model
import Shared.Msg
import Task
import Time
import TimeZone
import Url exposing (Url)
import Utils.Api.Temp exposing (leExpectJson, resolve)
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
    | GetDocxReportForDownload (Result ApiError Bytes -> msg) B.ReportPreviewReq
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
    | RemoveFreqFromNetwork (Result ApiError B.Network -> msg) B.DeleteNetworkFreqReq
    | GetNetworksList (Result ApiError (List B.Network) -> msg) B.ListNetworksReq
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
    | GetModulations (Result ApiError (List B.ModulationRec) -> msg)
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


getMessagesComments toMsg payload =
    GetMessagesComments toMsg payload


getUserInfo toMsg payload =
    GetUserInfo toMsg payload


getLocations toMsg payload =
    GetLocations toMsg payload


getPosts toMsg payload =
    GetPosts toMsg payload


getCallsigns toMsg payload =
    GetCallsigns toMsg payload


getFreqs toMsg payload =
    GetFreqs toMsg payload


getSenders toMsg payload =
    GetSenders toMsg payload


getNetworks toMsg payload =
    GetNetworks toMsg payload


getGroups toMsg payload =
    GetGroups toMsg payload


getAors toMsg payload =
    GetAors toMsg payload


getMetadataStats toMsg payload =
    GetMetadataStats toMsg payload


getSystemSettings toMsg =
    GetSystemSettings toMsg


focusHtmlElement payload =
    FocusHtmlElement payload


getInboxMessages : Maybe String -> (Result ApiError B.InboxMessagesRsp -> msg) -> B.InboxMessagesReq -> Effect msg
getInboxMessages token toMsg payload =
    GetInboxMessages token toMsg payload


getStatsCount toMsg payload =
    GetStatsCount toMsg payload


getCallsignsGraph toMsg payload =
    GetCallsignsGraph toMsg payload


getImportantMessagesIds toMsg payload =
    GetImportantMessagesIds toMsg payload



--TODO: rename


getTags2 toMsg payload =
    GetTags2 toMsg payload


getFreqsSummaryTable toMsg payload =
    GetFreqsSummaryTable toMsg payload


getFreqsSummaryTableXlsx toMsg payload =
    GetFreqsSummaryTableXlsx toMsg payload


getBookmarks toMsg payload =
    GetBookmarks toMsg payload


getMessagesMapPoints toMsg payload =
    GetMessagesMapPoints toMsg payload


getGroupsActivityStats toMsg payload =
    GetGroupsActivityStats toMsg payload


getUnits2 toMsg payload =
    GetUnits2 toMsg payload


getDocxReportForDownload toMsg payload =
    GetDocxReportForDownload toMsg payload


downloadFile name content =
    DownloadFile name content


initNetjsonGraph payload =
    InitNetjsonGraph payload


getNewCallsigns toMsg payload =
    GetNewCallsigns toMsg payload


deleteMessage toMsg payload =
    DeleteMessage toMsg payload


getCallsignsInfo toMsg payload =
    GetCallsignsInfo toMsg payload


getNetworksInfoByFreqs toMsg payload =
    GetNetworksInfoByFreqs toMsg payload


getNetworksInfoByIds toMsg payload =
    GetNetworksInfoByIds toMsg payload


downloadKmz toMsg payload =
    DownloadKmz toMsg payload


downloadGeojson toMsg payload =
    DownloadGeojson toMsg payload


getCorrelatedFreqs toMsg payload =
    GetCorrelatedFreqs toMsg payload


editFreqUnitName toMsg payload =
    EditFreqUnitName toMsg payload


saveAnalysisFilter toMsg payload =
    SaveAnalysisFilter toMsg payload


renameSavedAnalysisFilter toMsg payload =
    RenameSavedAnalysisFilter toMsg payload


deleteSavedAnalysisFilter toMsg payload =
    DeleteSavedAnalysisFilter toMsg payload


getMessagesByIds toMsg payload =
    GetMessagesByIds toMsg payload


getFreqActivityDaily toMsg payload =
    GetFreqActivityDaily toMsg payload


getInboxGroupsActivityStats toMsg =
    GetInboxGroupsActivityStats toMsg


getNetworksList toMsg payload =
    GetNetworksList toMsg payload


createNetwork toMsg payload =
    CreateNetwork toMsg payload


updateNetwork toMsg payload =
    UpdateNetwork toMsg payload


keepAlive toMsg payload =
    KeepAlive toMsg payload


addFreqToNetwork toMsg payload =
    AddFreqToNetwork toMsg payload


removeFreqFromNetwork toMsg payload =
    RemoveFreqFromNetwork toMsg payload


getNetworksGroupsActivity toMsg payload =
    GetNetworksGroupsActivity toMsg payload


getNetworksCallsigns toMsg payload =
    GetNetworksCallsigns toMsg payload


getNetworkPoints toMsg payload =
    GetNetworkPoints toMsg payload


getUnitStatsForNetworks toMsg =
    GetUnitStatsForNetworks toMsg


getNetworksReport toMsg payload =
    GetNetworksReport toMsg payload


getNetworkCallsigns toMsg payload =
    GetNetworkCallsigns toMsg payload


getNetworkCallsignsActivity toMsg payload =
    GetNetworkCallsignsActivity toMsg payload


getNetworkCallsignsList toMsg payload =
    GetNetworkCallsignsList toMsg payload


getNetworkFreqCallsigns toMsg payload =
    GetNetworkFreqCallsigns toMsg payload


getSingleNetwork toMsg networkId =
    GetSingleNetwork toMsg networkId


getSingleNetworkGroupsActivity toMsg payload =
    GetSingleNetworkGroupsActivity toMsg payload


getNetworkFreqsActivity toMsg payload =
    GetNetworkFreqsActivity toMsg payload


getSingleNetworkFreqs toMsg payload =
    GetSingleNetworkFreqs toMsg payload


getCallsignsInfoShared : List String -> Effect msg
getCallsignsInfoShared callsigns =
    SendSharedMsg (Shared.Msg.CallsignsInfoAskedByPage callsigns)


mergeNetworks toMsg payload =
    MergeNetworks toMsg payload


getModulations toMsg =
    GetModulations toMsg


updateNetworkPosts toMsg payload =
    UpdateNetworkPosts toMsg payload


updateNetworkUnits toMsg payload =
    UpdateNetworkUnits toMsg payload


deleteNetwork toMsg payload =
    DeleteNetwork toMsg payload


loadPostsFromShared payload =
    SendSharedMsg (Shared.Msg.PostLoadAll payload)


postCreate toMsg payload =
    PostCreate toMsg payload


postUpdate toMsg payload =
    PostUpdate toMsg payload


postDelete toMsg payload =
    PostDelete toMsg payload


networkAddDescription toMsg payload =
    NetworkAddDescription toMsg payload


networkDeleteDescription toMsg payload =
    NetworkDeleteDescription toMsg payload


networkUpdateDescription toMsg payload =
    NetworkUpdateDescription toMsg payload


getSignalsForNetwork toMsg payload =
    GetSignalsForNetwork toMsg payload


updateNetworkFreq toMsg payload =
    UpdateNetworkFreq toMsg payload


getNetworkReportBatch toMsg payload =
    GetNetworkReportBatch toMsg payload


getNetworkGoiReport toMsg =
    GetNetworkGoiReport toMsg



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

        GetModulations toMsg ->
            GetModulations (fn << toMsg)

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
            Http.post
                { url = "/api/rer/analysis/summary-table.xlsx"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

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
            Http.post
                { url = "/api/rer/report-docx"
                , body = Http.jsonBody (B.reportPreviewReqEncoder payload)
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

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
            Http.post
                { url = "/api/rer/analysis/download-kmz"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

        DownloadGeojson toMsg payload ->
            Http.post
                { url = "/api/rer/analysis/download-geojson"
                , body = Http.jsonBody (B.analysisStatsReqEncoder payload)
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

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
                , expect = leExpectJson toMsg (Decode.list B.networkDecoder)
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
            Http.post
                { url = "/api/sigint/etalonka/report-networks"
                , body = Http.jsonBody (B.etalonkaJimForksReqEncoder payload)
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

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

        GetModulations toMsg ->
            Http.post
                { url = "/api/sigint/modulations-list"
                , body = Http.jsonBody (Encode.object [])
                , expect = leExpectJson toMsg (Decode.list B.modulationRecDecoder)
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
            Http.post
                { url = "/api/sigint/etalonka/report-networks-batch-id"
                , body = Http.jsonBody (B.etalonkaNetworkBatchReqEncoder payload)
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

        GetNetworkGoiReport toMsg ->
            Http.post
                { url = "/api/sigint/network/report-networks-goi"
                , body = Http.jsonBody (Encode.object [])
                , expect = Http.expectBytesResponse toMsg (resolve Ok)
                }

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
