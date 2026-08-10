module Pages_.RerAnalysis.Msg exposing (Msg(..))

import Bindings as B
import Bytes exposing (Bytes)
import Core.Types exposing (..)
import Effect as E
import Pages_.RerAnalysis.Model exposing (..)
import Select
import Shared.Components.DateRangePicker
import Shared.Components.RerMessage
import Shared.Components.Toast
import Time exposing (Posix)


type Msg
    = NoOp
    | ToastMsg Shared.Components.Toast.Msg
    | InitGotTime Posix
    | DateRangePickerMsg Shared.Components.DateRangePicker.Msg
    | EventPollTrigger (Maybe String)
    | EventPollReceived (Result ApiError B.LongPollRsp)
    | InboxEvents (List B.EventMsg)
    | InboxMessagesUpdated (Result ApiError B.MessageIdsRsp)
    | GotInbox (Result ApiError B.InboxMessagesRsp)
    | GotInboxMore (Result ApiError B.InboxMessagesRsp)
    | NetworksInfoLoaded (Result ApiError (List B.Network))
    | GetSumTable
    | GotSumTable (Result ApiError B.SummaryTableFreq)
    | SelectFreq String
    | SelectOneFreq String
    | ToggleTagSelection Int
    | UnselectFreq String
    | RowsMsg Shared.Components.RerMessage.Msg
    | LoadMessagesNolimit
    | ToggleSortBySenders
    | ToggleSortByFreqs
    | ToggleSortByCallsigns
    | ToggleSortByUnits
    | ToggleSortByLocations
    | Refresh
    | ToggleOnlyWithExtendedForm
    | SetIncludePelengLocations Bool
    | SetIncludeOnlyNewFreqs Bool
    | ToggleOnlyBookmarked
    | ToggleOnlyImportant
    | ToggleOrWithCoords
    | ToggleWithoutModelTags
    | ToggleUnfoldAorsFilter
    | ToggleUnfoldGroupsFilter
    | ToggleUnfoldSendersFilter
    | ToggleUnfoldFreqsFilter
    | ToggleUnfoldCallsignsFilter
    | ToggleUnfoldUnitsFilter
    | ToggleUnfoldLocationsFilter
    | ToggleUnfoldTagsFilter
    | ToggleUnfoldNetworksFilter
    | ToggleUnfoldMetadataFilter
    | ToggleUnfoldPostsFilter
    | ToggleUnfoldSumTable
    | ToggleUnfoldGraphs
    | ToggleUnfoldCallsignGraph
    | ToggleUnfoldNewCallsignsBlock
    | ToggleUnfoldMapBlock
    | GotCallsignGraph (Result ApiError B.NetJsonGraphAndMeta)
    | ToggleCallsignGraphNolimit
    | DownloadXlsx
    | DownloadXlsxDone (Result ApiError Bytes)
    | DownloadKmz
    | DownloadKmzDone (Result ApiError Bytes)
    | DownloadGeojson
    | DownloadGeojsonDone (Result ApiError Bytes)
    | GetCorrelatedFreqs
    | GotCorrelatedFreqs (Result ApiError B.CorrelatedFreqsRsp)
    | ClearAllFilters
    | ToggleNewestFirst
    | EditUnitName String String
    | EditUnitCancel String String
    | EditUnitFormChanged String String String
    | EditUnitSave String String
    | EditUnitSaveDone String String String (Result ApiError ())
    | SaveFilterExpandToggle
    | SaveFilterInp String
    | SaveFilterDo
    | SaveFilterDone (Result ApiError (List B.SavedFilter))
    | SavedFiltersGot (Result ApiError (List B.SavedFilter))
    | SavedFilterMenuToggle Int
    | SavedFilterMenuClose
    | SavedFilterEdit Int
    | SavedFilterEditCancel Int
    | SavedFilterEditInp Int String
    | SavedFilterUpdate Int
    | SavedFilterRename Int
    | SavedFilterRenameDone (Result ApiError ())
    | SavedFilterDelete Int
    | SavedFilterDeleteDone (Result ApiError ())
    | SavedFilterSelect Int
    | SearchInput String
    | SelMetadataCcMsg (Select.Msg String)
    | SelMetadataSenderMsg (Select.Msg String)
    | SelMetadataReceiverMsg (Select.Msg String)
    | SelMetadataHashMsg (Select.Msg String)
    | OnlyWithMetadataChanged Bool
    | WithoutMetadataChanged Bool
    | WithoutNetworkChanged Bool
    | SearchDo
    | SearchInputKeyDown Int
    | SearchReset
    | SelectTab MenuTab
    | SelAorMsg (Select.Msg String)
    | SelGroupMsg (Select.Msg String)
    | SelSenderMsg (Select.Msg String)
    | SelFreqMsg (Select.Msg String)
    | SelCallsignMsg (Select.Msg String)
    | SelLocationMsg (Select.Msg String)
    | SelPostMsg (Select.Msg String)
    | SelUnitMsg (Select.Msg String)
    | SelNetworkMsg (Select.Msg String)
    | FilterUnitsInp String
    | GotTags (Result ApiError (List ( Int, B.Tag )))
    | ReportTemplateSelect ReportTemplate
    | ToggleReportConstructor
    | CloseReportConstructor
    | ReportDownloadDocx
    | ReportDownloadDocxDone (Result ApiError E.ReportDownloadResult)
    | ReportDownloadSummaryTableDone (Result ApiError Bytes)
    | ScrollMessagesToTop
    | LoadMoreMessages
    | LoadNewCallsignStats
    | GotNewCallsignStats (Result ApiError B.NewCallsignsRes)
    | GotMessagesComments (Result ApiError B.MessageComments)
    | GotUserInfo String (Result ApiError B.User)
    | ReportTagsOnlyThisUnitToggle
    | ReportTagsOnlyThisUnitForReportToggle
    | Report1213LinkedNetworksOnlyToggle
    | ReportWithoutCommentsToggle
    | ReportBabakNewCallsignMinMentionsInput String
    | ReportDigestOmitExoIdToggle
    | ReportDigestForm1217Toggle
    | ReportTagsWithoutBotTagsToggle
    | ReportAdvancedSendersToggle
    | ReportReoNoCommentsToggle
    | ReportSposobUnitNameInput String
    | DeleteMessageConfirm
    | DeleteMessageCancel
    | DeleteMessageDone Int (Result ApiError ())
    | GotStatsCount (Result ApiError B.CountStatsRsp)
    | GotSystemSettings (Result ApiError B.SystemSettingsCurrentRsp)
    | GotUserDutySettings (Result ApiError B.UserDutySettingsDto)
    | GotStatsAors (Result ApiError B.AreaOfResponsibilityStatsRsp)
    | GotStatsFreqs (Result ApiError B.FreqStatsRsp)
    | GotStatsCallsigns (Result ApiError B.CallsignStatsRsp)
    | GotStatsLocations (Result ApiError B.LocationStatsRsp)
    | GotStatsPosts (Result ApiError B.PostStatsRsp)
    | GotStatsTags (Result ApiError B.TagStatsRsp)
    | GotStatsUnits (Result ApiError B.UnitStatsRsp)
    | GotStatsSenders (Result ApiError B.SenderStatsRsp)
    | GotStatsNetworks (Result ApiError B.NetworkStatsRsp)
    | GotStatsMetadata (Result ApiError B.MetadataStatsRsp)
    | GotGdocCallsignsForSumTable (Result ApiError (List B.CallsignInfoRes))
    | GotStatsGroups (Result ApiError B.GroupStatsRsp)
    | GotMapPoints (Result ApiError B.MapPointsRsp)
    | MapClosed
    | MapPeriodChanged { startDate : Int, endDate : Int }
    | LoadMessagesForMap (List Int)
    | GotMessagesForMap Int (List Int) (Result ApiError B.MessageIdsRsp)
    | GotFreqActivityDaily (Result ApiError B.FreqDailyActivityCount)
    | SetUnitFilterFromMap String
    | SelectFilterAdjacentFreqsRange (Select.Msg Float)
    | SelectReportTagSortBy (Select.Msg B.TagReportSortBy)
    | SelectReportAdjacentFreqsRange (Select.Msg Float)
    | SelectReportReoFileType (Select.Msg B.ReoReportFileType)
    | SelectReportActiveNetworksAors (Select.Msg Int)
    | GroupsActivityPeriodChanged GroupsActivityPeriod
    | FilterTagsOptionChanged Bool
    | UnitsExactMatchOnlyChanged Bool
    | CloseEditSidebar
    | SaveEditSidebar
    | EditSidebarUpdate Int (B.InboxMessage -> B.InboxMessage)
    | EditSidebarSaveDone Int (Result ApiError ())
    | GotPalitras (Result ApiError (List B.PalitraReadV2))
    | GotAllAors (Result ApiError (List B.AreaOfResponsibility))
