module Le.Waterfall.Messages exposing (Messages, appendList, filterMessages, fromList, getItem, prependList, toList, toMessageList, toModelList, updateMessage, updateModel)

import Bindings as B
import Le.Config exposing (waterfallMessageLimit)
import Le.Waterfall.Message as Message


type Messages
    = Messages (List ( Int, ( B.InboxMessage, Message.Model ) ))



-- UTILS


combine : ( Int, B.InboxMessage ) -> Message.Model -> ( Int, ( B.InboxMessage, Message.Model ) )
combine ( id, message_ ) model =
    ( id, ( message_, model ) )


extractMessages : ( Int, ( B.InboxMessage, Message.Model ) ) -> ( Int, B.InboxMessage )
extractMessages ( i, ( aVal, _ ) ) =
    ( i, aVal )


extractModels : ( Int, ( B.InboxMessage, Message.Model ) ) -> Message.Model
extractModels ( i, ( _, model ) ) =
    model



--


fromList : List ( Int, B.InboxMessage ) -> Messages
fromList messageList =
    let
        messages =
            if List.length messageList > waterfallMessageLimit then
                messageList |> List.reverse |> List.take waterfallMessageLimit

            else
                messageList

        models =
            messages
                |> List.map
                    (\( id_, _ ) ->
                        Message.init
                            { id = id_ }
                    )

        combined =
            List.map2 combine messages models
    in
    Messages combined


prependList : Messages -> List ( Int, B.InboxMessage ) -> Messages
prependList (Messages messageList) newMessages =
    let
        (Messages newMsgs) =
            fromList newMessages

        result =
            newMsgs ++ messageList
    in
    if List.length result > waterfallMessageLimit then
        Messages (result |> List.take waterfallMessageLimit)

    else
        Messages result


appendList : Messages -> List ( Int, B.InboxMessage ) -> Messages
appendList (Messages messageList) newMessages =
    let
        (Messages newMsgs) =
            fromList newMessages

        result =
            messageList ++ newMsgs
    in
    if List.length result > waterfallMessageLimit then
        Messages (result |> List.reverse |> List.take waterfallMessageLimit |> List.reverse)

    else
        Messages result



--


toMessageList : Messages -> List ( Int, B.InboxMessage )
toMessageList (Messages list) =
    List.map extractMessages list


toModelList : Messages -> List Message.Model
toModelList (Messages list) =
    List.map extractModels list


toList : Messages -> List ( Int, ( B.InboxMessage, Message.Model ) )
toList (Messages list) =
    list



--


updateModel : Int -> Message.Model -> Messages -> Messages
updateModel id newModel (Messages messages) =
    List.map
        (\( i, ( message_, model_ ) ) ->
            if i == id then
                ( i, ( message_, newModel ) )

            else
                ( i, ( message_, model_ ) )
        )
        messages
        |> Messages


updateMessage : Int -> ( Int, B.InboxMessage ) -> Messages -> Messages
updateMessage id newMessage (Messages messages) =
    List.map
        (\( i, ( message_, model_ ) ) ->
            if i == id then
                ( i, ( Tuple.second newMessage, model_ ) )

            else
                ( i, ( message_, model_ ) )
        )
        messages
        |> Messages


filterMessages : (( Int, B.InboxMessage ) -> Bool) -> Messages -> Messages
filterMessages predicate (Messages messages) =
    List.filter (\( id, ( message, _ ) ) -> predicate ( id, message )) messages
        |> Messages


getItem : Int -> Messages -> Maybe ( B.InboxMessage, Message.Model )
getItem id (Messages messages) =
    messages |> List.filter (\( id_, _ ) -> id == id_) |> List.head |> Maybe.map (\( _, ( message, model ) ) -> ( message, model ))
