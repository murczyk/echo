module Core.EventHelpers exposing (subscribeToInboxChanges)

import Bindings as B
import Effect as E exposing (Effect)
import Route.Path
import Shared.Msg exposing (Msg(..))



-- Helper functions for pages to subscribe to events


subscribeToEvent : Route.Path.Path -> B.EventType -> Effect msg
subscribeToEvent pageId eventType =
    E.sendSharedMsg <| SubscribeToEvents pageId [ eventType ]



-- Convenience functions for common event subscriptions


subscribeToInboxChanges : Route.Path.Path -> Effect msg
subscribeToInboxChanges pageId =
    subscribeToEvent pageId (B.EtInboxChanged 0)



-- The Int parameter will be handled by the backend
