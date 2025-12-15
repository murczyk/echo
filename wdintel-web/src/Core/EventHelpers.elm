module Core.EventHelpers exposing (subscribeToEvent, subscribeToEvents, unsubscribeFromEvents, subscribeToNetworkChanges, subscribeToCallsignChanges, subscribeToSignalChanges, subscribeToInboxChanges)

import Bindings as B
import Effect as E exposing (Effect)
import Route.Path
import Shared.Msg exposing (Msg(..))
import Task


-- Helper functions for pages to subscribe to events

subscribeToEvent : Route.Path.Path -> B.EventType -> Effect msg
subscribeToEvent pageId eventType =
    E.sendSharedMsg <| SubscribeToEvents pageId [ eventType ]


subscribeToEvents : Route.Path.Path -> List B.EventType -> Effect msg
subscribeToEvents pageId eventTypes =
    E.sendSharedMsg <| SubscribeToEvents pageId eventTypes


unsubscribeFromEvents : Route.Path.Path -> Effect msg
unsubscribeFromEvents pageId =
    E.sendSharedMsg <| UnsubscribeFromEvents pageId


-- Convenience functions for common event subscriptions

subscribeToNetworkChanges : Route.Path.Path -> Effect msg
subscribeToNetworkChanges pageId =
    subscribeToEvent pageId B.EtNetworkChanged


subscribeToCallsignChanges : Route.Path.Path -> Effect msg
subscribeToCallsignChanges pageId =
    subscribeToEvent pageId B.EtCallsignChanged


subscribeToSignalChanges : Route.Path.Path -> Effect msg
subscribeToSignalChanges pageId =
    subscribeToEvent pageId B.EtSignalChanged


subscribeToInboxChanges : Route.Path.Path -> Effect msg
subscribeToInboxChanges pageId =
    subscribeToEvent pageId (B.EtInboxChanged 0) -- The Int parameter will be handled by the backend
