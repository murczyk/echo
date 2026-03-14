module Pages_.RerAnalysis.FiltersReloading exposing (FilterDataState(..), FilterInteraction(..), endpoints, focusAndReloadOptionsIfNeeded, handleFilterState, invalidateFiltersState)

import Api
import Bindings as B
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Pages_.RerAnalysis.Model exposing (FilterName(..), FocusedFilterSnapshot, Model)
import Pages_.RerAnalysis.Msg exposing (Msg(..))
import Select
import Utils.RemoteData as RD exposing (RemoteData(..))


type FilterDataState
    = UpToDate
    | Outdated


type FilterInteraction
    = BeforeInteraction FilterDataState
    | AfterInteraction FilterDataState
    | Other


type alias AnalysisFiltersData a =
    { a
        | aors : RemoteData ApiError (List B.AnalysisStatsAor)
        , posts : RemoteData ApiError (List B.AnalysisStatsPost)
        , locations : RemoteData ApiError (List B.AnalysisStatsLocation)
        , statsTags : RemoteData ApiError (List B.AnalysisStatsTag)
        , units : RemoteData ApiError (List B.AnalysisStatsUnit)
        , senders : RemoteData ApiError (List B.AnalysisStatsSender)
        , groups : RemoteData ApiError (List B.AnalysisStatsGroup)
        , freqs : RemoteData ApiError (List B.AnalysisStatsFreq)
        , callsigns : RemoteData ApiError (List B.AnalysisStatsCallsign)
        , networksStats : RemoteData ApiError (List B.AnalysisStatsNetwork)
    }



--TODO: add TagsFilter


invalidateFiltersState : FilterName -> AnalysisFiltersData a -> AnalysisFiltersData a
invalidateFiltersState filterTriggeredChange model =
    case filterTriggeredChange of
        AorsFilter ->
            { model
                | locations = NeedsReload (RD.withDefault [] model.locations)
                , units = NeedsReload (RD.withDefault [] model.units)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        SendersFilter ->
            { model
                | locations = NeedsReload (RD.withDefault [] model.locations)
                , units = NeedsReload (RD.withDefault [] model.units)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        GroupsFilter ->
            { model
                | locations = NeedsReload (RD.withDefault [] model.locations)
                , units = NeedsReload (RD.withDefault [] model.units)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        FreqsFilter ->
            { model
                | locations = NeedsReload (RD.withDefault [] model.locations)
                , units = NeedsReload (RD.withDefault [] model.units)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        CallsignsFilter ->
            { model
                | locations = NeedsReload (RD.withDefault [] model.locations)
                , units = NeedsReload (RD.withDefault [] model.units)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        LocationsFilter ->
            { model
                | callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , units = NeedsReload (RD.withDefault [] model.units)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        PostsFilter ->
            { model
                | callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , units = NeedsReload (RD.withDefault [] model.units)
                , locations = NeedsReload (RD.withDefault [] model.locations)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        UnitsFilter ->
            { model
                | callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , locations = NeedsReload (RD.withDefault [] model.locations)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , networksStats = NeedsReload (RD.withDefault [] model.networksStats)
            }

        NetworksFilter ->
            { model
                | callsigns = NeedsReload (RD.withDefault [] model.callsigns)
                , posts = NeedsReload (RD.withDefault [] model.posts)
                , locations = NeedsReload (RD.withDefault [] model.locations)
                , senders = NeedsReload (RD.withDefault [] model.senders)
                , freqs = NeedsReload (RD.withDefault [] model.freqs)
                , groups = NeedsReload (RD.withDefault [] model.groups)
                , aors = NeedsReload (RD.withDefault [] model.aors)
                , units = NeedsReload (RD.withDefault [] model.units)
            }


focusedItemsForKey : String -> Maybe FocusedFilterSnapshot -> Maybe (List String)
focusedItemsForKey filterKey focusedFilterItemsBeforeChange =
    case focusedFilterItemsBeforeChange of
        Just snapshot ->
            if snapshot.filterKey == filterKey then
                Just snapshot.itemsBeforeChange

            else
                Nothing

        Nothing ->
            Nothing


focusAndReloadOptionsIfNeeded : RemoteData ApiError a -> Maybe (List String) -> FilterDataState
focusAndReloadOptionsIfNeeded items focusedFilterItemsBeforeChange =
    if focusedFilterItemsBeforeChange == Nothing then
        case items of
            NeedsReload _ ->
                Outdated

            NotAsked ->
                Outdated

            _ ->
                UpToDate

    else
        UpToDate


reloadStatsIfSelectedChanged : List String -> Maybe (List String) -> FilterDataState
reloadStatsIfSelectedChanged selectedItems focusedFilterItemsBeforeChange =
    case focusedFilterItemsBeforeChange of
        Just items_ ->
            if items_ == selectedItems then
                UpToDate

            else
                Outdated

        Nothing ->
            Outdated


handleFilterState : String -> Maybe FocusedFilterSnapshot -> Maybe (Select.Action String) -> List String -> RemoteData ApiError a -> FilterInteraction
handleFilterState filterKey focusedFilterItemsBeforeChange mAction newSelectedValues items =
    let
        currentFocusedItems =
            focusedItemsForKey filterKey focusedFilterItemsBeforeChange
    in
    case ( mAction, currentFocusedItems ) of
        ( Just Select.Focus, Nothing ) ->
            let
                optionsOutdated =
                    focusAndReloadOptionsIfNeeded items currentFocusedItems
            in
            BeforeInteraction optionsOutdated

        ( Just (Select.Deselect _), Nothing ) ->
            let
                optionsOutdated =
                    focusAndReloadOptionsIfNeeded items currentFocusedItems
            in
            BeforeInteraction optionsOutdated

        ( Just Select.Blur, Just _ ) ->
            let
                needsReload =
                    reloadStatsIfSelectedChanged newSelectedValues currentFocusedItems
            in
            AfterInteraction needsReload

        ( Just (Select.MenuToggle Select.MenuClose), Just _ ) ->
            let
                needsReload =
                    reloadStatsIfSelectedChanged newSelectedValues currentFocusedItems
            in
            AfterInteraction needsReload

        ( Just Select.Clear, _ ) ->
            AfterInteraction Outdated

        _ ->
            Other


endpoints : List ( FilterName, B.AnalysisStatsReq -> Effect Msg )
endpoints =
    [ ( AorsFilter, E.getAors GotStatsAors )
    , ( LocationsFilter, E.getLocations GotStatsLocations )
    , ( PostsFilter, E.getPosts GotStatsPosts )
    , ( CallsignsFilter, E.getCallsigns GotStatsCallsigns )
    , ( FreqsFilter, E.getFreqs GotStatsFreqs )
    , ( SendersFilter, E.getSenders GotStatsSenders )
    , ( GroupsFilter
      , E.getGroups GotStatsGroups
      )
    , ( NetworksFilter, E.getNetworks GotStatsNetworks )
    ]
