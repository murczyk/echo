module RerAnalysis.FiltersReloading exposing (FilterDataState(..), FilterInteraction(..), endpoints, focusAndReloadOptionsIfNeeded, handleFilterState, invalidateFiltersState)

import Api
import Bindings as B
import Effect as E exposing (Effect)
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Types exposing (ApiError)
import RerAnalysis.Model exposing (FilterName(..), Model)
import RerAnalysis.Msg exposing (Msg(..))
import Select


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

            }


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


handleFilterState : Maybe (List String) -> Maybe (Select.Action String) -> List String -> RemoteData ApiError a -> FilterInteraction
handleFilterState focusedFilterItemsBeforeChange mAction newSelectedValues items =
    case ( mAction, focusedFilterItemsBeforeChange ) of
        ( Just Select.Focus, Nothing ) ->
            let
                optionsOutdated =
                    focusAndReloadOptionsIfNeeded items focusedFilterItemsBeforeChange
            in
            BeforeInteraction optionsOutdated

        ( Just (Select.Deselect _), Nothing ) ->
            let
                optionsOutdated =
                    focusAndReloadOptionsIfNeeded items focusedFilterItemsBeforeChange
            in
            BeforeInteraction optionsOutdated

        ( Just Select.Blur, Just _ ) ->
            let
                needsReload =
                    reloadStatsIfSelectedChanged newSelectedValues focusedFilterItemsBeforeChange
            in
            AfterInteraction needsReload

        ( Just (Select.MenuToggle Select.MenuClose), Just _ ) ->
            let
                needsReload =
                    reloadStatsIfSelectedChanged newSelectedValues focusedFilterItemsBeforeChange
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
    ]
