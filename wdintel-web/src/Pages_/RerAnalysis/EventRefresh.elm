module Pages_.RerAnalysis.EventRefresh exposing (messageIdsToRefresh)

import List.Extra as ListX
import Set


messageIdsToRefresh :
    { messagesRendered : Bool
    , renderedMessageIds : List Int
    }
    -> List Int
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
            |> List.filter (\messageId -> Set.member messageId renderedMessageIds)
            |> ListX.unique
