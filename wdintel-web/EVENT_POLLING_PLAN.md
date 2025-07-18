# Event Polling Implementation Plan

## Overview
Add real-time event polling to the ECHO application to enable automatic updates when data changes on the server. This will eliminate the need for manual refresh buttons and provide a more responsive user experience.

## Architecture Decisions
- **Layout**: Create new `EventLayout` for centralized event polling
- **Event Distribution**: Use `Shared.Model` to pass events to pages
- **Persistence**: Session-level storage (no localStorage for now)
- **Scope**: Pages opt-in to specific event types they care about

## Subtasks

### Subtask 1: Create Event Service in Le/
**File**: `src/Le/EventService.elm`

**Objectives**:
- Create polling service for `/api/event-stream/long-poll` endpoint
- Handle connection management and error states
- Use existing `B.EventType` from Bindings.elm
- Implement retry logic and connection recovery

**Key Components**:
```elm
module Le.EventService exposing (EventState, startPolling, stopPolling, pollEvents)

type alias EventState =
    { isPolling : Bool
    , lastEventId : Maybe String
    , error : Maybe String
    , retryCount : Int
    }

-- Functions to manage polling lifecycle
```

**Acceptance Criteria**:
- [x] Can start/stop polling
- [x] Handles connection errors gracefully
- [x] Implements exponential backoff for retries
- [x] Uses existing `B.EventType` and `B.EventMsg` types
- [x] Uses generated `B.LongPollReq` and `B.LongPollRsp` types

---

### Subtask 2: Create EventLayout and Update Shared.Model
**Files**: 
- `src/Layouts/EventLayout.elm`
- `src/Shared.elm`

**Objectives**:
- Create new layout with event polling capabilities
- Add event state to Shared.Model for distribution
- Implement event filtering and distribution mechanism
- Handle session-level `lastEventId` storage

**Key Components**:
```elm
-- EventLayout.elm
type alias EventLayoutModel =
    { lastEventId : Maybe String
    , isPolling : Bool
    , error : Maybe String
    }

-- Shared.elm additions
type alias Model =
    { -- existing fields
    , eventPolling : EventPollingState
    }

type alias EventPollingState =
    { lastEventId : Maybe String
    , isPolling : Bool
    , pendingEvents : List B.EventMsg
    }
```

**Acceptance Criteria**:
- [x] EventLayout polls for events successfully
- [x] Events are stored in Shared.Model
- [x] Session-level event ID persistence works
- [x] Layout integrates with existing app structure
- [x] Type-safe event subscriptions using Route.Path.Path
- [x] Helper functions for easy page event subscription
- [x] Simplified EventLayout that just renders children
- [x] Removed keepAlive functionality (focuses only on event polling)

---

### Subtask 3: Update RerCallsigns to Opt-in to ETUnitChanged
**File**: `src/Pages/RerCallsigns.elm`

**Objectives**:
- Add event subscription to `ETUnitChanged` events via Shared.Model
- Handle unit refresh when events are received
- Remove or disable manual "Reload Units" button
- Add visual feedback for real-time updates

**Key Changes**:
```elm
-- Add to Model
type alias Model =
    { -- existing fields
    , lastProcessedEventId : Maybe String  -- Track processed events
    }

-- Add to Msg
type Msg
    = -- existing messages
    | HandleUnitChangedEvent B.EventMsg
    | ProcessPendingEvents

-- Update update function to handle events
```

**Acceptance Criteria**:
- [ ] Page receives `ETUnitChanged` events automatically
- [ ] Units refresh when events are received
- [ ] Manual "Reload Units" button is removed/disabled
- [ ] Visual indicator shows when units are being updated
- [ ] No duplicate event processing

---

### Subtask 4: Integrate EventLayout with App Structure
**Files**: 
- `src/Main.elm` (or main app file)
- Update existing layouts

**Objectives**:
- Update main app to use EventLayout
- Ensure proper event flow from layout → shared → pages
- Test event delivery and page responsiveness
- Add connection status indicators

**Key Components**:
```elm
-- Main app structure
EventLayout
    { user = user
    , shared = shared
    , content = pageContent
    }
```

**Acceptance Criteria**:
- [ ] App uses EventLayout successfully
- [ ] Events flow correctly from layout to pages
- [ ] Connection status is visible to users
- [ ] No performance degradation from polling
- [ ] Graceful handling of connection issues

---

## Event Flow Diagram
```
EventLayout (polls) → Shared.Model (stores) → Pages (consume)
     ↓                      ↓                      ↓
/api/event-stream    pendingEvents list    handle specific events
```

## Testing Strategy
1. **Unit Tests**: Test EventService polling logic
2. **Integration Tests**: Test event flow from layout to pages
3. **Manual Testing**: Verify real-time updates work in browser
4. **Error Testing**: Test connection failures and recovery

## Success Metrics
- [ ] Manual refresh buttons can be removed
- [ ] Real-time updates work reliably
- [ ] No performance impact on app
- [ ] Users see immediate feedback for data changes
- [ ] Connection issues are handled gracefully

## Future Enhancements
- Add localStorage persistence for lastEventId
- Implement event batching for better performance
- Add user controls to pause/resume polling
- Support for different polling intervals per event type

## Implementation Notes
- Backend already supports `/api/event-stream/long-poll` endpoint
- Event types are defined in `B.EventType` (ETGeneric, ETNetworkChanged, ETCallsignChanged, ETSignalChanged, ETUnitChanged, ETInboxChanged)
- Polling uses Redis streams with 50-second timeout
- Session lifetime is 180 seconds 