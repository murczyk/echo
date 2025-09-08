module Pages_.RerDuty.Waterfall.Filters exposing (Filter, FilterMsg(..), createMenu, ensureAllSendersNamed, extractSendersIds, groupNameToIds, updateSelectItems)

import Bindings as B
import Shared.Components.RerMessage
import Shared.Components.Toast
import Pages_.RerDuty.Waterfall.Types exposing (..)
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Select
import Set
import Utils.Select as LeSelect
import Utils.Utils exposing (getLabelOrDefault)


type alias Filter r =
    { r
        | sendersSelect : LeSelect.SelectType String
        , groupInfos : Dict String B.SignalGroupEntry
        , groupsSelected : List String
        , sendersDeniedSelect : LeSelect.SelectType String
        , freqsDeniedSelect : LeSelect.SelectType String
        , freqsSelect : LeSelect.SelectType String
        , postsDeniedSelect : LeSelect.SelectType String
        , postsSelect : LeSelect.SelectType String
        , filterSelect :
            { state : Select.State
            , items : List (Select.MenuItem Int)
            , selected : Maybe Int
            }
        , sendersSelectedNames : List String
        , sendersDeniedNames : List String
        , profiles : Dict String (Maybe B.SignalProfileEntry)
        , savedFilters : List ( Int, B.SavedFilterDuty )
        , saveFilterInp : String
        , deleteFilterConfirmationId : Maybe Int
        , unfoldSettings : Bool
        , lastViewedMessageId : LastViewedMessageId
        , freqs : List String
        , filterSelectedAdjacentFreqs : List String
        , filterDeniedAdjacentFreqs : List String
        , adjacentFreqsRangeSelect :
            { state : Select.State
            , items : List (Select.MenuItem Float)
            , selected : Float
            }
    }


type FilterMsg
    = SaveFilterDo
    | SaveFilterDone (Result ApiError (List B.SavedFilterDuty))
    | SaveFilterInp String
    | SelectFilterMsg (Select.Msg Int)
    | DeleteFilter Int
    | DeleteFilterConfirm
    | DeleteFilterCancel
    | DeleteFilterDone (Result ApiError ())
    | SavedFiltersGot (Result ApiError (List B.SavedFilterDuty))
    | SelectSendersMsg (Select.Msg String)
    | DenySendersMsg (Select.Msg String)
    | SelectFreqsMsg (Select.Msg String)
    | SelectPostsMsg (Select.Msg String)
    | DenyPostsMsg (Select.Msg String)
    | DenyFreqsMsg (Select.Msg String)
    | SelectGroup String
    | UnselectGroup String
    | SelectAllGroups
    | ToggleUnfoldSettings
    | SelectFilterFreqsRange (Select.Msg Float)


extractSendersIds : List String -> List String -> Dict String (Maybe B.SignalProfileEntry) -> List String -> List String
extractSendersIds oldSendersNames newSendersNames profiles senders =
    if newSendersNames == oldSendersNames then
        senders

    else
        profiles
            |> Dict.toList
            |> List.filterMap
                (\( k, v ) ->
                    case v of
                        Nothing ->
                            Nothing

                        Just profile ->
                            if List.member (Shared.Components.RerMessage.profileNameStr k profile) newSendersNames then
                                Just k

                            else
                                Nothing
                )


ensureAllSendersNamed : Dict String (Maybe B.SignalProfileEntry) -> List String -> List String -> List String
ensureAllSendersNamed profiles sendersIds sendersNames =
    sendersIds
        |> List.filterMap
            (\id ->
                case Dict.get id profiles of
                    Just (Just profile) ->
                        Just (Shared.Components.RerMessage.profileNameStr id profile)

                    _ ->
                        Nothing
            )
        |> Set.fromList
        |> (\namesSet -> ( namesSet, Set.size namesSet > Set.size (Set.fromList sendersNames) ))
        |> (\( namesSet, listIncomplete ) ->
                if listIncomplete then
                    Set.toList namesSet

                else
                    sendersNames
           )


createMenu : List String -> List (Select.MenuItem String)
createMenu list =
    list
        |> List.map
            (\item ->
                Select.basicMenuItem
                    { item = item
                    , label = getLabelOrDefault item
                    }
            )


groupNameToIds n dict =
    dict
        |> Dict.toList
        |> List.filterMap
            (\( id, v ) ->
                if v.name == n then
                    Just id

                else
                    Nothing
            )


buildSelectUsersItems :
    Dict String (Maybe B.SignalProfileEntry)
    -> List (Select.MenuItem String)
buildSelectUsersItems profiles =
    -- todo: ideally: render users only in selected groups
    Dict.toList profiles
        |> List.filterMap
            (\( uuid, mP ) ->
                case mP of
                    Nothing ->
                        Nothing

                    Just p ->
                        Just (Shared.Components.RerMessage.profileNameStr uuid p)
            )
        |> Set.fromList
        |> Set.toList
        |> List.map
            (\name ->
                Select.basicMenuItem
                    { item = name
                    , label = name
                    }
            )


updateSelectItems : Filter a -> Filter a
updateSelectItems m2 =
    let
        sendersSelect =
            LeSelect.updateSelectItems (\_ -> buildSelectUsersItems m2.profiles) m2.sendersSelect

        sendersDeniedSelect =
            LeSelect.updateSelectItems (\_ -> buildSelectUsersItems m2.profiles) m2.sendersDeniedSelect
    in
    { m2
        | sendersSelect = sendersSelect
        , sendersDeniedSelect = sendersDeniedSelect
    }
