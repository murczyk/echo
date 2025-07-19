module Le.EventHelpers exposing (subscribeToEvent, subscribeToEvents, unsubscribeFromEvents, subscribeToNetworkChanges, subscribeToCallsignChanges, subscribeToSignalChanges, subscribeToInboxChanges)

import Bindings as B
import Effect as E exposing (Effect)
import Route.Path
import Shared.Msg exposing (Msg(..))
import Task


-- Helper functions for pages to subscribe to events

subscribeToEvent : Route.Path.Path -> B.EventType -> Effect Msg
subscribeToEvent pageId eventType =
    E.sendCmd <| Task.perform (\_ -> SubscribeToEvents pageId [ eventType ]) (Task.succeed ())


subscribeToEvents : Route.Path.Path -> List B.EventType -> Effect Msg
subscribeToEvents pageId eventTypes =
    E.sendCmd <| Task.perform (\_ -> SubscribeToEvents pageId eventTypes) (Task.succeed ())


unsubscribeFromEvents : Route.Path.Path -> Effect Msg
unsubscribeFromEvents pageId =
    E.sendCmd <| Task.perform (\_ -> UnsubscribeFromEvents pageId) (Task.succeed ())


-- Convenience functions for common event subscriptions

subscribeToNetworkChanges : Route.Path.Path -> Effect Msg
subscribeToNetworkChanges pageId =
    subscribeToEvent pageId B.EtNetworkChanged


subscribeToCallsignChanges : Route.Path.Path -> Effect Msg
subscribeToCallsignChanges pageId =
    subscribeToEvent pageId B.EtCallsignChanged


subscribeToSignalChanges : Route.Path.Path -> Effect Msg
subscribeToSignalChanges pageId =
    subscribeToEvent pageId B.EtSignalChanged


subscribeToInboxChanges : Route.Path.Path -> Effect Msg
subscribeToInboxChanges pageId =
    subscribeToEvent pageId (B.EtInboxChanged 0) -- The Int parameter will be handled by the backend 