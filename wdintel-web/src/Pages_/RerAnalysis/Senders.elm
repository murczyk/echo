module Pages_.RerAnalysis.Senders exposing (menuItems, selectedMenuItems, selectedNames)

import Bindings as B
import Dict exposing (Dict)
import List.Extra as ListX
import Select
import Set exposing (Set)
import Shared.Components.RerMessage
import String


selectedNames : Dict String (Maybe B.SignalProfileEntry) -> List String -> List String
selectedNames profiles senderIds =
    senderIds
        |> List.map (senderName profiles)


menuItems : Dict String (Maybe B.SignalProfileEntry) -> List B.AnalysisStatsSender -> List (Select.MenuItem String)
menuItems profiles senders =
    let
        duplicatedNames =
            duplicateNames profiles senders
    in
    senders
        |> List.map
            (\sender ->
                Select.basicMenuItem
                    { item = sender.uuid
                    , label = senderLabel profiles duplicatedNames sender
                    }
            )


selectedMenuItems : Dict String (Maybe B.SignalProfileEntry) -> List B.AnalysisStatsSender -> List String -> List (Select.MenuItem String)
selectedMenuItems profiles senders selectedSenderIds =
    let
        duplicatedNames =
            duplicateNames profiles senders
    in
    selectedSenderIds
        |> List.map
            (\senderId ->
                let
                    sender =
                        senders
                            |> ListX.find (\entry -> entry.uuid == senderId)
                            |> Maybe.withDefault
                                { uuid = senderId
                                , count = 0
                                , freqBreakdown = []
                                , perDay = Dict.empty
                                }
                in
                Select.basicMenuItem
                    { item = senderId
                    , label = senderLabel profiles duplicatedNames sender
                    }
            )


duplicateNames : Dict String (Maybe B.SignalProfileEntry) -> List B.AnalysisStatsSender -> Set String
duplicateNames profiles senders =
    senders
        |> List.foldl
            (\sender counts ->
                let
                    name =
                        senderName profiles sender.uuid
                in
                Dict.update name
                    (\mCount -> Just (Maybe.withDefault 0 mCount + 1))
                    counts
            )
            Dict.empty
        |> Dict.toList
        |> List.filterMap
            (\( name, count ) ->
                if count > 1 then
                    Just name

                else
                    Nothing
            )
        |> Set.fromList


senderLabel : Dict String (Maybe B.SignalProfileEntry) -> Set String -> B.AnalysisStatsSender -> String
senderLabel profiles duplicatedNames sender =
    let
        name =
            senderName profiles sender.uuid

        disambiguatedName =
            if Set.member name duplicatedNames then
                name ++ " [" ++ shortUuid sender.uuid ++ "]"

            else
                name
    in
    disambiguatedName ++ " (" ++ String.fromInt sender.count ++ ")"


senderName : Dict String (Maybe B.SignalProfileEntry) -> String -> String
senderName profiles senderId =
    Shared.Components.RerMessage.getProfileName profiles senderId


shortUuid : String -> String
shortUuid uuid =
    String.left 8 uuid
