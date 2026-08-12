module Pages_.RerAnalysis.EventRefresh exposing (messageIdsToRefresh)

import Bindings as B
import List.Extra as ListX
import Set


messageIdsToRefresh :
    { messagesRendered : Bool
    , renderedMessageIds : List Int
    }
    -> List B.EventMsg
    -> List Int
messageIdsToRefresh context events =
    if not context.messagesRendered then
        []

    else
        let
            renderedMessageIds =
                Set.fromList context.renderedMessageIds
        in
        events
            |> List.filterMap
                (\event ->
                    case event.eventType of
                        B.EtInboxChanged messageId ->
                            Just messageId

                        _ ->
                            Nothing
                )
            |> List.filter (\messageId -> Set.member messageId renderedMessageIds)
            |> ListX.unique
