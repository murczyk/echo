module SessionExpiryTests exposing (tests)

import Core.EventService
import Core.Types exposing (ApiError)
import Dict
import Effect as E
import Expect exposing (Expectation)
import Http
import Layouts.Navbar as Navbar
import Route exposing (Route)
import Shared
import Shared.Msg as Msg
import Test exposing (Test, describe, test)
import Url


tests : Test
tests =
    describe "Expired sessions stop background requests"
        [ test "current-user 401 clears authentication and stays on login" <|
            \_ ->
                withSession <|
                    \route shared ->
                        let
                            ( signedOut, effect ) =
                                Shared.update route (Msg.GotUser (Err (httpError 401))) shared
                        in
                        Expect.all
                            [ \_ -> Expect.equal Nothing signedOut.user
                            , \_ -> Expect.equal False signedOut.userLoaded
                            , \_ -> Expect.equal False signedOut.eventService.isPolling
                            , \_ -> Expect.equal E.none effect
                            ]
                            ()
        , test "event-poll 401 logs out without scheduling retries" <|
            \_ ->
                withSession <|
                    \route shared ->
                        let
                            ( signedOut, effect ) =
                                Shared.update route (Msg.EventServiceEventsReceived (Err (httpError 401))) shared
                        in
                        Expect.all
                            [ \_ -> Expect.equal Nothing signedOut.user
                            , \_ -> Expect.equal False signedOut.eventService.isPolling
                            , \_ -> Expect.equal 0 signedOut.eventService.retryCount
                            , \_ -> Expect.equal (E.loadExternalUrlForced "/api/user/logout?redirect=%2F") effect
                            ]
                            ()
        , test "late responses and queued polling messages cannot restart a stopped session" <|
            \_ ->
                withSession <|
                    \route shared ->
                        let
                            ( signedOut, _ ) =
                                Shared.update route Msg.SignOut shared

                            lateMessages =
                                [ Msg.EventServiceEventsReceived (Ok { events = [], lastEventId = Just "late", deploymentMaintenance = Nothing })
                                , Msg.EventServiceEventsReceived (Err (httpError 500))
                                , Msg.EventServiceRetryPolling
                                , Msg.EventServicePollEvents
                                , Msg.EventServiceStartPolling
                                , Msg.SignOut
                                ]
                        in
                        lateMessages
                            |> List.map (\msg -> Shared.update route msg signedOut)
                            |> List.map
                                (\( updated, effect ) ->
                                    ( updated.eventService == signedOut.eventService, effect == E.none )
                                )
                            |> Expect.equal (List.repeat (List.length lateMessages) ( True, True ))
        , test "temporary event failures retain polling" <|
            \_ ->
                withSession <|
                    \route shared ->
                        let
                            ( updated, _ ) =
                                Shared.update route (Msg.EventServiceEventsReceived (Err (httpError 500))) shared
                        in
                        Expect.equal ( True, 1 ) ( updated.eventService.isPolling, updated.eventService.retryCount )
        , test "temporary event failures do not consume the persistent error notification" <|
            \_ ->
                withSession <|
                    \route shared ->
                        let
                            fail failure state =
                                Shared.update route (Msg.EventServiceEventsReceived (Err (apiError failure))) state

                            interrupted =
                                List.range 1 8
                                    |> List.foldl (\_ state -> fail Http.NetworkError state |> Tuple.first) shared

                            ( unexpected, firstEffect ) =
                                fail (Http.BadStatus 403) interrupted

                            ( _, repeatedEffect ) =
                                fail (Http.BadStatus 403) unexpected

                            ( recovered, _ ) =
                                Shared.update route (Msg.EventServiceEventsReceived (Ok { events = [], lastEventId = Just "recovered", deploymentMaintenance = Nothing })) unexpected
                        in
                        Expect.all
                            [ \_ -> Expect.equal True interrupted.eventService.isPolling
                            , \_ -> Expect.equal True interrupted.eventService.connectionInterrupted
                            , \_ -> Expect.equal False interrupted.eventService.persistentErrorReported
                            , \_ -> Expect.equal 8 interrupted.eventService.retryCount
                            , \_ -> Expect.equal 30000 interrupted.eventService.retryDelay
                            , \_ -> Expect.equal False unexpected.eventService.connectionInterrupted
                            , \_ -> Expect.equal True unexpected.eventService.persistentErrorReported
                            , \_ -> Expect.equal True (isBatchEffect firstEffect)
                            , \_ -> Expect.equal False (isBatchEffect repeatedEffect)
                            , \_ -> Expect.equal False recovered.eventService.connectionInterrupted
                            , \_ -> Expect.equal False recovered.eventService.persistentErrorReported
                            , \_ -> Expect.equal 0 recovered.eventService.retryCount
                            , \_ -> Expect.equal (Just "recovered") recovered.eventService.lastEventId
                            ]
                            ()
        , test "keep-alive 401 stops queued ticks and ignores late responses" <|
            \_ ->
                withSession <|
                    \route _ ->
                        let
                            ( navbar, _ ) =
                                Navbar.init ()

                            ( stopped, effect ) =
                                Navbar.update route (Navbar.KeepAliveDone (Err (httpError 401)))
                                    { navbar | connectionInterrupted = True }

                            ( afterLateResponse, _ ) =
                                Navbar.update route (Navbar.KeepAliveDone (Ok ())) stopped

                            ( _, tickEffect ) =
                                Navbar.update route Navbar.Slept afterLateResponse
                        in
                        Expect.all
                            [ \_ -> Expect.equal True stopped.keepAliveStopped
                            , \_ -> Expect.equal False stopped.connectionInterrupted
                            , \_ -> Expect.equal E.logout effect
                            , \_ -> Expect.equal E.none tickEffect
                            ]
                            ()
        , describe "temporary background failures self-clear without toasts"
            (List.map temporaryFailureTest [ Http.NetworkError, Http.Timeout, Http.BadStatus 500, Http.BadStatus 503, Http.BadStatus 599 ])
        , describe "unexpected keep-alive errors retain reporting"
            (List.map unexpectedFailureTest [ Http.BadStatus 400, Http.BadStatus 403, Http.BadStatus 429, Http.BadUrl "invalid", Http.BadBody "invalid" ])
        ]


temporaryFailureTest : Http.Error -> Test
temporaryFailureTest failure =
    test (Debug.toString failure) <|
        \_ ->
            withSession <|
                \route shared ->
                    let
                        ( navbar, _ ) =
                            Navbar.init ()

                        ( interrupted, firstEffect ) =
                            Navbar.update route (Navbar.KeepAliveDone (Err (apiError failure))) navbar

                        ( _, repeatedEffect ) =
                            Navbar.update route (Navbar.KeepAliveDone (Err (apiError failure))) interrupted

                        ( recovered, _ ) =
                            Navbar.update route (Navbar.KeepAliveDone (Ok ())) interrupted

                        ( _, tickEffect ) =
                            Navbar.update route Navbar.Slept interrupted

                        eventService =
                            shared.eventService

                        ( polling, pollingEffect ) =
                            Shared.update route (Msg.EventServiceEventsReceived (Err (apiError failure)))
                                { shared | eventService = { eventService | retryCount = 5 } }

                        ( pollingRecovered, _ ) =
                            Shared.update route (Msg.EventServiceEventsReceived (Ok { events = [], lastEventId = Nothing, deploymentMaintenance = Nothing })) polling
                    in
                    Expect.all
                        [ \_ -> Expect.equal False interrupted.keepAliveStopped
                        , \_ -> Expect.equal True interrupted.connectionInterrupted
                        , \_ -> Expect.equal E.none firstEffect
                        , \_ -> Expect.equal E.none repeatedEffect
                        , \_ -> Expect.notEqual E.none tickEffect
                        , \_ -> Expect.equal False recovered.connectionInterrupted
                        , \_ -> Expect.equal True polling.eventService.isPolling
                        , \_ -> Expect.equal True polling.eventService.connectionInterrupted
                        , \_ -> Expect.equal False (isBatchEffect pollingEffect)
                        , \_ -> Expect.notEqual E.none pollingEffect
                        , \_ -> Expect.equal False pollingRecovered.eventService.connectionInterrupted
                        ]
                        ()


unexpectedFailureTest : Http.Error -> Test
unexpectedFailureTest failure =
    test (Debug.toString failure) <|
        \_ ->
            withSession <|
                \route _ ->
                    let
                        ( navbar, _ ) =
                            Navbar.init ()

                        ( updated, effect ) =
                            Navbar.update route (Navbar.KeepAliveDone (Err (apiError failure)))
                                { navbar | connectionInterrupted = True }
                    in
                    Expect.all
                        [ \_ -> Expect.equal False updated.keepAliveStopped
                        , \_ -> Expect.equal False updated.connectionInterrupted
                        , \_ -> Expect.notEqual E.none effect
                        ]
                        ()


apiError : Http.Error -> ApiError
apiError failure =
    { httpError = failure, formErrors = Dict.empty, errors = [] }


httpError : Int -> ApiError
httpError status =
    { httpError = Http.BadStatus status, formErrors = Dict.empty, errors = [] }


isBatchEffect : E.Effect msg -> Bool
isBatchEffect effect =
    String.startsWith "Batch" (Debug.toString effect)


withSession : (Route () -> Shared.Model -> Expectation) -> Expectation
withSession check =
    case Url.fromString "http://localhost/login" of
        Nothing ->
            Expect.fail "invalid test URL"

        Just url ->
            let
                route =
                    Route.fromUrl () url

                ( initial, _ ) =
                    Shared.init (Ok { isDark = False, now = 0 }) route

                eventService =
                    Core.EventService.init
            in
            check route
                { initial
                    | user = Maybe.map (\user -> { user | name = "operator" }) initial.user
                    , userLoaded = True
                    , eventService = { eventService | isPolling = True }
                }
