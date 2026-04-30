module Pages_.RerDuty.Waterfall.Utils exposing (compareTwoMessages, lastViewedIdToMaybe)

import Pages_.RerDuty.Waterfall.Types exposing (LastViewedMessageId(..))


compareTwoMessages : ( comparable, { a | timestamp : Maybe comparable } ) -> ( comparable, { b | timestamp : Maybe comparable } ) -> Bool
compareTwoMessages ( id1, message1 ) ( id2, message2 ) =
    case ( message1.timestamp, message2.timestamp ) of
        ( Just t1, Just t2 ) ->
            if t1 == t2 then
                id1 > id2

            else
                t1 > t2

        _ ->
            id1 > id2


lastViewedIdToMaybe : LastViewedMessageId -> Maybe Int
lastViewedIdToMaybe v =
    case v of
        LastViewedId id_ ->
            Just id_

        NotSet ->
            Nothing



