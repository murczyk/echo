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
                            , \_ -> Expect.equal (E.loadExternalUrl "/api/user/logout") effect
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
        , test "temporary event failures retain bounded retries" <|
            \_ ->
                withSession <|
                    \route shared ->
                        let
                            ( updated, _ ) =
                                Shared.update route (Msg.EventServiceEventsReceived (Err (httpError 500))) shared
                        in
                        Expect.equal ( True, 1 ) ( updated.eventService.isPolling, updated.eventService.retryCount )
        , test "keep-alive 401 stops queued ticks and ignores late responses" <|
            \_ ->
                withSession <|
                    \route _ ->
                        let
                            ( navbar, _ ) =
                                Navbar.init ()

                            ( stopped, effect ) =
                                Navbar.update route (Navbar.KeepAliveDone (Err (httpError 401))) navbar

                            ( afterLateResponse, _ ) =
                                Navbar.update route (Navbar.KeepAliveDone (Ok ())) stopped

                            ( _, tickEffect ) =
                                Navbar.update route Navbar.Slept afterLateResponse
                        in
                        Expect.all
                            [ \_ -> Expect.equal True stopped.keepAliveStopped
                            , \_ -> Expect.equal E.logout effect
                            , \_ -> Expect.equal E.none tickEffect
                            ]
                            ()
        , test "temporary keep-alive errors are surfaced without ending the session" <|
            \_ ->
                withSession <|
                    \route _ ->
                        let
                            ( navbar, _ ) =
                                Navbar.init ()

                            ( updated, effect ) =
                                Navbar.update route (Navbar.KeepAliveDone (Err (httpError 500))) navbar
                        in
                        Expect.all
                            [ \_ -> Expect.equal False updated.keepAliveStopped
                            , \_ -> Expect.notEqual E.none effect
                            ]
                            ()
        ]


httpError : Int -> ApiError
httpError status =
    { httpError = Http.BadStatus status, formErrors = Dict.empty, errors = [] }


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
