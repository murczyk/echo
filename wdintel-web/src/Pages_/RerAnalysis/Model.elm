module Pages_.RerAnalysis.Model exposing (FilterName(..), FocusedFilterSnapshot, GroupsActivityPeriod(..), MenuTab(..), Model, ReportTemplate(..), SendersType(..))

import Bindings as B
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Select
import Shared.Components.DateRangePicker
import Shared.Components.DateTime
import Shared.Components.RerMessage
import Shared.Components.Toast
import Time
import Utils.RemoteData exposing (RemoteData)


type alias FocusedFilterSnapshot =
    { filterKey : String
    , itemsBeforeChange : List String
    }


type alias Model =
    { formErrors : Dict String String
    , toasts : Shared.Components.Toast.Model
    , from : Shared.Components.DateTime.Model
    , to : Shared.Components.DateTime.Model
    , dateRangePicker : Shared.Components.DateRangePicker.Model
    , loadingInboxMessages : Bool
    , messages : List ( Int, B.InboxMessage )
    , freqs : RemoteData ApiError (List B.AnalysisStatsFreq)
    , callsigns : RemoteData ApiError (List B.AnalysisStatsCallsign)
    , counts : RemoteData ApiError B.CountStatsRsp
    , profiles : Dict String (Maybe B.SignalProfileRsp)
    , aorsSelected : List String
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
    , networksExtra : Dict Int B.Network
    , rowsModel : Shared.Components.RerMessage.Model
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
    , orWithoutCoords : Bool
    , unfoldAorsFilter : Bool
    , unfoldGroupsFilter : Bool
    , unfoldSendersFilter : Bool
    , unfoldFreqsFilter : Bool
    , unfoldCallsignsFilter : Bool
    , unfoldUnitsFilter : Bool
    , unfoldLocationsFilter : Bool
    , unfoldTagsFilter : Bool
    , unfoldNetworksFilter : Bool
    , unfoldMetadataFilter : Bool
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
    , savedFilterMenuOpen : Maybe Int
    , searchInput : String
    , metadataCc : List String
    , metadataSender : List String
    , metadataReceiver : List String
    , metadataHash : List String
    , onlyWithMetadata : Bool
    , withoutMetadata : Bool
    , withoutNetwork : Bool
    , nolimitShown : Bool
    , menuTab : MenuTab
    , selAorState : Select.State
    , selAorMenu : List (Select.MenuItem String)
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
    , selNetworkState : Select.State
    , selNetworkMenu : List (Select.MenuItem String)
    , selMetadataCcState : Select.State
    , selMetadataCcMenu : List (Select.MenuItem String)
    , selMetadataSenderState : Select.State
    , selMetadataSenderMenu : List (Select.MenuItem String)
    , selMetadataReceiverState : Select.State
    , selMetadataReceiverMenu : List (Select.MenuItem String)
    , selMetadataHashState : Select.State
    , selMetadataHashMenu : List (Select.MenuItem String)
    , filterUnits : String
    , now : Maybe Time.Posix
    , tags : List ( Int, B.Tag )
    , showReportConstructor : Bool
    , reportTemplate : ReportTemplate
    , reportTagsOnlyThisUnit : Bool
    , reportTagsOnlyThisUnitForReport : Bool
    , report1213LinkedNetworksOnly : Bool
    , reportWithoutComments : Bool
    , reportDigestOmitExoId : Bool
    , reportDigestForm1217 : Bool
    , reportAdvancedSenders : Bool
    , reportAdjacentFreqsRangeSelect :
        { state : Select.State
        , items : List (Select.MenuItem Float)
        , selected : Float
        }
    , reportReoFileTypeSelect :
        { state : Select.State
        , items : List (Select.MenuItem B.ReoReportFileType)
        , selected : B.ReoReportFileType
        }
    , reportReoNoComments : Bool
    , reportActiveNetworksAorsSelect :
        { state : Select.State
        , items : List (Select.MenuItem Int)
        , selected : List Int
        }

    -- , reportIframeUrl : Maybe String
    , reportDownloadInProgress : Bool
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
    , aors : RemoteData ApiError (List B.AnalysisStatsAor)
    , allAors : List B.AreaOfResponsibility
    , aorNames : List B.AreaOfResponsibilityEntry
    , posts : RemoteData ApiError (List B.AnalysisStatsPost)
    , locations : RemoteData ApiError (List B.AnalysisStatsLocation)
    , statsTags : RemoteData ApiError (List B.AnalysisStatsTag)
    , units : RemoteData ApiError (List B.AnalysisStatsUnit)
    , senders : RemoteData ApiError (List B.AnalysisStatsSender)
    , groups : RemoteData ApiError (List B.AnalysisStatsGroup)
    , networksStats : RemoteData ApiError (List B.AnalysisStatsNetwork)
    , metadataStats : RemoteData ApiError B.MetadataStatsRsp
    , networkNames : List B.NetworkEntry
    , networksSelected : List String
    , focusedFilterItemsBeforeChange : Maybe FocusedFilterSnapshot
    , mapPoints : RemoteData ApiError (List B.FreqDetailedPoint)
    , mapNetworkUnits : List B.NetworkUnit
    , mapOpenMessages : RemoteData ApiError (List ( Int, B.InboxMessage ))
    , mapOpenMessagesLoadRequestId : Int
    , mapOpenMessagesRequestId : Int
    , adjacentFreqsRangeSelect :
        { state : Select.State
        , items : List (Select.MenuItem Float)
        , selected : Float
        }
    , filterSelectedAdjacentFreqs : List String
    , groupsActivityPeriod : GroupsActivityPeriod
    , filterTagsOption : B.TagFilterOption
    , unitsExactMatchOnly : Bool
    , unitsExactMatchOnlyExplicit : Bool
    , systemSettingsLoaded : Bool
    , withoutModelTags : Bool
    , editSidebar : Maybe Int
    , eventLastId : Maybe String

    -- палітри
    , palitras : RemoteData ApiError (List B.PalitraReadV2)
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
    | RTPostsDocx
    | RTSenders SendersType
    | RTReo
    | RTDigest
    | ActiveNetworks
    | RTNetworkFrequencies
    | RTSummaryTable
    | RTReport1213


type FilterName
    = AorsFilter
    | LocationsFilter
    | PostsFilter
    | UnitsFilter
    | CallsignsFilter
    | FreqsFilter
    | GroupsFilter
    | SendersFilter
    | NetworksFilter


type GroupsActivityPeriod
    = Month
    | Quarter
    | Year
    | FilterSelectedRange
