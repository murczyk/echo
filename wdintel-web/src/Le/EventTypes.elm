module Le.EventTypes exposing (EventState, EventSubscription, EventSubscriptions, subscribeToEvent, subscribeToEvents, unsubscribeFromEvents, getSubscribedEvents)

import Bindings as B
import Dict exposing (Dict)
import Route.Path


type alias EventState =
    { isPolling : Bool
    , lastEventId : Maybe String
    , error : Maybe String
    , retryCount : Int
    , retryDelay : Int
    }


type alias EventSubscription =
    { pageId : Route.Path.Path
    , eventTypes : List B.EventType
    }


type alias EventSubscriptions =
    Dict String (List B.EventType)


-- Helper functions for type-safe event subscriptions

subscribeToEvent : Route.Path.Path -> B.EventType -> EventSubscriptions -> EventSubscriptions
subscribeToEvent pageId eventType subscriptions =
    let
        pageIdString = Route.Path.toString pageId
        currentEvents =
            Dict.get pageIdString subscriptions
                |> Maybe.withDefault []
    in
    Dict.insert pageIdString (eventType :: currentEvents) subscriptions


subscribeToEvents : Route.Path.Path -> List B.EventType -> EventSubscriptions -> EventSubscriptions
subscribeToEvents pageId eventTypes subscriptions =
    let
        pageIdString = Route.Path.toString pageId
        currentEvents =
            Dict.get pageIdString subscriptions
                |> Maybe.withDefault []
    in
    Dict.insert pageIdString (eventTypes ++ currentEvents) subscriptions


unsubscribeFromEvents : Route.Path.Path -> EventSubscriptions -> EventSubscriptions
unsubscribeFromEvents pageId subscriptions =
    let
        pageIdString = Route.Path.toString pageId
    in
    Dict.remove pageIdString subscriptions


getSubscribedEvents : Route.Path.Path -> EventSubscriptions -> List B.EventType
getSubscribedEvents pageId subscriptions =
    let
        pageIdString = Route.Path.toString pageId
    in
    Dict.get pageIdString subscriptions
        |> Maybe.withDefault [] 