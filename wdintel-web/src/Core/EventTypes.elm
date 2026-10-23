module Core.EventTypes exposing (EventState, EventSubscriptions, subscribeToEvents, unsubscribeFromEvents)

import Bindings as B
import Dict exposing (Dict)
import Route.Path
import Time


type alias EventState =
    { isPolling : Bool
    , flavor : B.LongPollFlavor
    , requestInFlight : Bool
    , generation : Int
    , lastEventId : Maybe String
    , lastPollStartedAt : Maybe Time.Posix
    , lastGenericFullAt : Maybe Time.Posix
    , error : Maybe String
    , connectionInterrupted : Bool
    , persistentErrorReported : Bool
    , retryCount : Int
    , retryDelay : Int
    }


type alias EventSubscriptions =
    Dict String (List B.EventType)



-- Helper functions for type-safe event subscriptions


subscribeToEvents : Route.Path.Path -> List B.EventType -> EventSubscriptions -> EventSubscriptions
subscribeToEvents pageId eventTypes subscriptions =
    let
        pageIdString =
            Route.Path.toString pageId

        currentEvents =
            Dict.get pageIdString subscriptions
                |> Maybe.withDefault []
    in
    Dict.insert pageIdString (eventTypes ++ currentEvents) subscriptions


unsubscribeFromEvents : Route.Path.Path -> EventSubscriptions -> EventSubscriptions
unsubscribeFromEvents pageId subscriptions =
    let
        pageIdString =
            Route.Path.toString pageId
    in
    Dict.remove pageIdString subscriptions
