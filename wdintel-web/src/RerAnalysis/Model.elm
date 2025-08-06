module RerAnalysis.Model exposing (FilterName(..), GroupsActivityPeriod(..), MenuTab(..), Model, ReportTemplate(..), SendersType(..))

import Bindings as B
import Dict exposing (Dict)
import Le.Block.DateRangePicker
import Le.Block.DateTime
import Le.Block.Toast
import Le.RemoteData exposing (RemoteData)
import Le.RerMessage
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp)
import Select
import Set exposing (Set)
import Time


type alias Model =
    { formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , zone : Maybe Time.Zone
    , from : Le.Block.DateTime.Model
    , to : Le.Block.DateTime.Model
    , dateRangePicker : Le.Block.DateRangePicker.Model
    , loadingInboxMessages : Bool
    , messages : List ( Int, B.InboxMessage )
    , freqs : RemoteData ApiError (List B.AnalysisStatsFreq)
    , callsigns : RemoteData ApiError (List B.AnalysisStatsCallsign)
    , counts : RemoteData ApiError B.CountStatsRsp
    , profiles : Dict String (Maybe B.SignalProfileRsp)
    , groupsSelected : List String
    , sendersSelected : List String
    , freqsSelected : List String
    , callsignsSelected : List String
    , unitsSelected : List String
    , locationsSelected : List String
    , includePelengLocations : Bool
    , includeOnlyNewFreqs : Bool
    , tagsSelected : List Int
    , groupInfos : Dict String B.SignalGroupEntry
    , rowsModel : Le.RerMessage.Model
    , senderInput : String
    , callsignInput : String
    , sendersSortBy : String
    , freqsSortBy : String
    , callsignsSortBy : String
    , unitsSortBy : String
    , locationsSortBy : String
    , orWithExtendedForm : Bool
    , orBookmarked : Bool
    , orImportant : Bool
    , orWithCoords : Bool
    , unfoldGroupsFilter : Bool
    , unfoldSendersFilter : Bool
    , unfoldFreqsFilter : Bool
    , unfoldCallsignsFilter : Bool
    , unfoldUnitsFilter : Bool
    , unfoldLocationsFilter : Bool
    , unfoldTagsFilter : Bool
    , unfoldSumTable : Bool
    , unfoldCallsignGraph : Bool
    , unfoldGraphs : Bool
    , unfoldCorrelationBlock : Bool
    , unfoldNewCallsignsBlock : Bool
    , unfoldPostsFilter : Bool
    , unfoldMapBlock : Bool
    , loadingCallsignGraph : Bool
    , callsignGraph : Maybe B.NetJsonGraphAndMeta
    , callsignGraphNolimit : Bool
    , sumTable : RemoteData ApiError B.SummaryTableFreq
    , correlatedFreqs : RemoteData ApiError (List B.CorrelatedFreq)
    , newestFirst : Bool

    -- (freq, unit) -> (maybe new_value)
    , editUnitMap : Dict ( String, String ) (Maybe String)
    , saveFilterExpanded : Bool
    , saveFilterInp : String
    , saveFilterInProgress : Bool
    , savedFilters : List ( Int, B.SavedFilter )
    , savedFiltersLoading : Bool
    , savedFilterEditInp : Dict Int String
    , searchInput : String
    , nolimitShown : Bool
    , menuTab : MenuTab
    , selGroupState : Select.State
    , selGroupMenu : List (Select.MenuItem String)
    , selSenderState : Select.State
    , selSenderMenu : List (Select.MenuItem String)
    , selFreqState : Select.State
    , selFreqMenu : List (Select.MenuItem String)
    , selCallsignState : Select.State
    , selCallsignMenu : List (Select.MenuItem String)
    , selLocationState : Select.State
    , selLocationMenu : List (Select.MenuItem String)
    , selPostState : Select.State
    , selPostMenu : List (Select.MenuItem String)
    , selUnitState : Select.State
    , selUnitMenu : List (Select.MenuItem String)
    , filterUnits : String
    , now : Maybe Time.Posix
    , tags : List ( Int, B.Tag )

    -- , showReportConstructor : Bool
    , reportTemplate : ReportTemplate
    , reportTagsOnlyThisUnit : Bool

    -- , reportIframeUrl : Maybe String
    , reportDownloadInProgress : Bool
    , bookmarks : Set Int
    , importants : Set Int
    , noMoreToLoad : Bool
    , newCallsignsLoading : Bool
    , newCallsignsRsp : Maybe B.NewCallsignsRes
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , callsignsInfoSumTable : Dict String (List B.CallsignInfo)
    , messageComments : Dict Int (List B.MessageComment)
    , users : Dict String (Maybe B.User)
    , sendersSelectedNames : List String
    , postsSelected : List String
    , deleteMessageModalId : Maybe Int
    , groupsMessageCountByDay : RemoteData ApiError B.FreqDailyActivityCount

    -- stats
    , posts : RemoteData ApiError (List B.AnalysisStatsPost)
    , locations : RemoteData ApiError (List B.AnalysisStatsLocation)
    , statsTags : RemoteData ApiError (List B.AnalysisStatsTag)
    , units : RemoteData ApiError (List B.AnalysisStatsUnit)
    , senders : RemoteData ApiError (List B.AnalysisStatsSender)
    , groups : RemoteData ApiError (List B.AnalysisStatsGroup)
    , focusedFilterItemsBeforeChange : Maybe (List String)
    , mapPoints : RemoteData ApiError (List B.FreqDetailedPoint)
    , mapNetworkUnits : List B.NetworkUnit
    , mapOpenMessages : RemoteData ApiError (List ( Int, B.InboxMessage ))
    , adjacentFreqsRangeSelect :
        { state : Select.State
        , items : List (Select.MenuItem Float)
        , selected : Float
        }
    , filterSelectedAdjacentFreqs : List String
    , groupsActivityPeriod : GroupsActivityPeriod
    , filterTagsOption : B.TagFilterOption
    }


type MenuTab
    = TabFilters
    | TabSaved


type SendersType
    = Senders
    | Posts


type ReportTemplate
    = RTTags
    | RTMouse
    | RTPelengs
    | RTBabak
    | RTInterception
    | RTNaUshnom
    | RTSenders SendersType


type FilterName
    = LocationsFilter
    | PostsFilter
    | UnitsFilter
    | CallsignsFilter
    | FreqsFilter
    | GroupsFilter
    | SendersFilter


type GroupsActivityPeriod
    = Month
    | Quarter
    | Year
    | FilterSelectedRange
