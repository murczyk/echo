module RerAnalysis.Msg exposing (Msg(..))

import Bindings as B
import Bytes exposing (Bytes)
import Le.Block.DateRangePicker
import Le.Block.Toast
import Le.RerMessage
import Le.Types exposing (..)
import RerAnalysis.Model exposing (..)
import Select
import Time exposing (Posix)
import TimeZone


type Msg
    = NoOp
    | ToastMsg Le.Block.Toast.Msg
    | InitGotZone (Result TimeZone.Error ( String, Time.Zone ))
    | InitGotTime Time.Zone Posix
    | DateRangePickerMsg Le.Block.DateRangePicker.Msg
    | GotInbox (Result ApiError B.InboxMessagesRsp)
    | GotInboxMore (Result ApiError B.InboxMessagesRsp)
    | GetSumTable
    | GotSumTable (Result ApiError B.SummaryTableFreq)
    | SelectFreq String
    | SelectOneFreq String
    | ToggleTagSelection Int
    | UnselectFreq String
    | RowsMsg Le.RerMessage.Msg
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
    | ToggleUnfoldGroupsFilter
    | ToggleUnfoldSendersFilter
    | ToggleUnfoldFreqsFilter
    | ToggleUnfoldCallsignsFilter
    | ToggleUnfoldUnitsFilter
    | ToggleUnfoldLocationsFilter
    | ToggleUnfoldTagsFilter
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
    | SearchDo
    | SearchInputKeyDown Int
    | SearchReset
    | SelectTab MenuTab
    | SelGroupMsg (Select.Msg String)
    | SelSenderMsg (Select.Msg String)
    | SelFreqMsg (Select.Msg String)
    | SelCallsignMsg (Select.Msg String)
    | SelLocationMsg (Select.Msg String)
    | SelPostMsg (Select.Msg String)
    | SelUnitMsg (Select.Msg String)
    | FilterUnitsInp String
    | GotTags (Result ApiError (List ( Int, B.Tag )))
    | ReportTemplateSelect ReportTemplate
    | ReportDownloadDocx
    | ReportDownloadDocxDone (Result ApiError Bytes)
    | ScrollMessagesToTop
    | GotBookmarks (Result ApiError (List B.Bookmark))
    | GotImportants (Result ApiError (List B.Important))
    | LoadMoreMessages
    | LoadNewCallsignStats
    | GotNewCallsignStats (Result ApiError B.NewCallsignsRes)
    | GotMessagesComments (Result ApiError B.MessageComments)
    | GotUserInfo String (Result ApiError B.User)
    | ReportTagsOnlyThisUnitToggle
    | DeleteMessageConfirm
    | DeleteMessageCancel
    | DeleteMessageDone Int (Result ApiError ())
    | GotStatsCount (Result ApiError B.CountStatsRsp)
    | GotStatsFreqs (Result ApiError B.FreqStatsRsp)
    | GotStatsCallsigns (Result ApiError B.CallsignStatsRsp)
    | GotStatsLocations (Result ApiError B.LocationStatsRsp)
    | GotStatsPosts (Result ApiError B.PostStatsRsp)
    | GotStatsTags (Result ApiError B.TagStatsRsp)
    | GotStatsUnits (Result ApiError B.UnitStatsRsp)
    | GotStatsSenders (Result ApiError B.SenderStatsRsp)
    | GotGdocCallsignsForSumTable (Result ApiError (List B.CallsignInfoRes))
    | GotNetworksForSumTable (Result ApiError (List B.Network))
    | GotStatsGroups (Result ApiError B.GroupStatsRsp)
    | GotMapPoints (Result ApiError B.MapPointsRsp)
    | MapClosed
    | MapPeriodChanged { startDate : Int, endDate : Int }
    | LoadMessagesForMap (List Int)
    | GotMessagesForMap (Result ApiError B.MessageIdsRsp)
    | GotFreqActivityDaily (Result ApiError B.FreqDailyActivityCount)
    | SetUnitFilterFromMap String
    | SelectFilterAdjacentFreqsRange (Select.Msg Float)
    | GroupsActivityPeriodChanged GroupsActivityPeriod
    | FilterTagsOptionChanged Bool
