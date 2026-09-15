module Pages.RerDuty exposing (Model, Msg(..), page, update)

import Api
import Auth
import Bindings as B exposing (..)
import Browser.Events
import Config
import Core.EventHelpers
import Core.Types exposing (..)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Http
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import List.Extra as ListX
import Maybe.Extra exposing (isJust)
import Page exposing (Page)
import Pages_.RerDuty.Waterfall exposing (Msg(..), waterfallDivId)
import Pages_.RerDuty.Waterfall.Messages as Messages
import Pages_.RerDuty.Waterfall.Utils as Utils
import Process
import Random
import Route exposing (Route)
import Route.Path
import Set exposing (Set)
import Shared
import Shared.Model exposing (isDarkMode)
import Task
import Time
import Utils.Api.ErrorHandling
import Utils.Api.Temp exposing (leExpectJson)
import Utils.RemoteData exposing (RemoteData(..))
import Utils.Utils exposing (..)
import Uuid.Barebones
import View exposing (View)


type alias Model =
    { navCollapsed : Bool
    , waterfalls : List ( String, Pages_.RerDuty.Waterfall.Model )
    , duplicates : Set Int
    , lastPushQuery : Dict String String
    , datasources : List ( Int, Datasource )
    , eventLastId : Maybe String
    }


init : Route () -> () -> ( Model, Effect Msg )
init route _ =
    let
        ms : Maybe B.RerDutyQueryState
        ms =
            case Dict.get "state" route.query of
                Nothing ->
                    Nothing

                Just str ->
                    case Decode.decodeString B.rerDutyQueryStateDecoder str of
                        Err _ ->
                            Nothing

                        Ok v ->
                            Just v

        waterfallStates : List ( String, B.RerDutyQueryStateWf )
        waterfallStates =
            ms
                |> andThen .waterfalls
                |> def [ ( "wf-0", emptyWaterfallQueryStateWf ) ]

        waterfalls =
            waterfallStates
                |> List.map
                    (\( wfId, wfState ) ->
                        let
                            wfmodel =
                                Tuple.first
                                    (Pages_.RerDuty.Waterfall.init wfId (Just wfState))
                        in
                        ( wfId, wfmodel )
                    )

        cmds =
            Core.EventHelpers.subscribeToInboxChanges route.path
                :: (E.sendCmd <| Api.datasource_list GotDatasourceList)
                :: (waterfallStates
                        |> List.map
                            (\( wfId, wfState ) ->
                                let
                                    wfcmd =
                                        Tuple.second
                                            (Pages_.RerDuty.Waterfall.init wfId (Just wfState))
                                in
                                --TODO: now it sends msgs to all waterfalls, like we check height of wf-1, but it also send to wf-2
                                E.map (WaterfallMsg wfId) wfcmd
                            )
                   )

        model =
            { navCollapsed = False
            , waterfalls = waterfalls
            , duplicates = Set.empty
            , lastPushQuery = route.query
            , datasources = []
            , eventLastId = Nothing
            }

        pushUrlCmd =
            getPushUrlCmd model
    in
    ( model
    , E.batch (pushUrlCmd :: pollEvents Nothing :: cmds)
    )


type Msg
    = WaterfallMsg String Pages_.RerDuty.Waterfall.Msg
    | ResizeHappened
    | EventPollTrigger (Maybe String)
    | EventPollReceived (Result ApiError B.LongPollRsp)
    | InboxEvents (List B.EventMsg)
    | InboxMessagesUpdated (Result ApiError B.MessageIdsRsp)
    | GenerateNewWaterfallId
    | AddWaterfall String
    | CollapseNavToggle
    | GotDatasourceList (Result ApiError (List ( Int, Datasource )))
    | SwitchTheme


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init req
        , update = update shared user
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-duty"
        }


type alias RecalcDuplicatesAcc =
    { duplicates : Set Int
    , seenMsgs : Dict String Int
    }


recalcDuplicates : Model -> Set Int
recalcDuplicates model =
    if Config.featureDisableRerDutyDedup || List.length model.waterfalls > 1 then
        Set.empty

    else
        let
            msgs : List ( Int, B.InboxMessage )
            msgs =
                List.concatMap (\( _, wf ) -> Messages.toMessageList wf.messages) model.waterfalls

            msgs2 : List ( Int, B.InboxMessage )
            msgs2 =
                msgs

            -- List.sortBy
            --     (\( _, x ) -> Maybe.withDefault 0 x.timestamp)
            --     msgs
            go : ( Int, B.InboxMessage ) -> RecalcDuplicatesAcc -> RecalcDuplicatesAcc
            go ( id_, msg ) acc =
                let
                    mUid =
                        msg.messageUid
                            |> andThen
                                (\uid ->
                                    if String.isEmpty uid then
                                        Nothing

                                    else
                                        Just uid
                                )
                in
                case mUid of
                    Nothing ->
                        acc

                    Just uid ->
                        let
                            seenUid =
                                Dict.get uid acc.seenMsgs
                        in
                        if isJust seenUid && (seenUid /= Just id_) then
                            { acc
                                | duplicates = acc.duplicates |> Set.insert id_
                            }

                        else
                            { acc
                                | seenMsgs =
                                    acc.seenMsgs
                                        |> Dict.insert uid id_
                            }
        in
        (List.foldl go
            { duplicates = Set.empty
            , seenMsgs = Dict.empty
            }
            msgs2
        ).duplicates


update : Shared.Model -> B.User -> Msg -> Model -> ( Model, Effect Msg )
update shared user msg model =
    case msg of
        CollapseNavToggle ->
            ( { model | navCollapsed = not model.navCollapsed }
            , E.sendCmd <| Task.perform (\_ -> ResizeHappened) Time.now
            )

        EventPollTrigger lastId ->
            ( model, pollEvents lastId )

        EventPollReceived (Err _) ->
            ( model, pollEventsDelayed 1000 model.eventLastId )

        EventPollReceived (Ok rsp) ->
            let
                inboxEvents =
                    rsp.events
                        |> List.filter
                            (\event ->
                                case event.eventType of
                                    B.EtInboxChanged _ ->
                                        True

                                    _ ->
                                        False
                            )
            in
            ( { model | eventLastId = rsp.lastEventId }
            , E.batch
                [ pollEvents rsp.lastEventId
                , E.sendMsg <| InboxEvents inboxEvents
                ]
            )

        InboxEvents events ->
            events
                |> List.filterMap
                    (\event ->
                        case event.eventType of
                            B.EtInboxChanged messageId ->
                                Just messageId

                            _ ->
                                Nothing
                    )
                |> ListX.unique
                |> (\ids ->
                        if List.isEmpty ids then
                            ( model, E.none )

                        else
                            ( model
                            , E.getMessagesByIds InboxMessagesUpdated { messageIds = ids, inboxReq = Nothing }
                            )
                   )

        InboxMessagesUpdated (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося оновити повідомлення" e
            )

        InboxMessagesUpdated (Ok rsp) ->
            let
                waterfallsAndEffects =
                    List.map
                        (\( wfId, wf ) ->
                            let
                                wfMessageIds =
                                    wf.messages
                                        |> Messages.toMessageList
                                        |> List.map Tuple.first
                                        |> Set.fromList

                                updatedMessages =
                                    List.foldl
                                        (\( msgId, message ) acc ->
                                            if Set.member msgId wfMessageIds then
                                                Messages.updateMessage msgId ( msgId, message ) acc

                                            else
                                                acc
                                        )
                                        wf.messages
                                        rsp.messages

                                refreshedMessages =
                                    rsp.messages
                                        |> List.filter (\( msgId, _ ) -> Set.member msgId wfMessageIds)

                                ( updatedWaterfall, waterfallEffect ) =
                                    if List.isEmpty refreshedMessages then
                                        ( { wf | messages = updatedMessages }, E.none )

                                    else
                                        Pages_.RerDuty.Waterfall.applyRefreshedMessages
                                            shared
                                            refreshedMessages
                                            { wf | messages = updatedMessages }
                            in
                            ( ( wfId, updatedWaterfall ), E.map (WaterfallMsg wfId) waterfallEffect )
                        )
                        model.waterfalls

                waterfalls2 =
                    List.map Tuple.first waterfallsAndEffects

                refreshEffects =
                    waterfallsAndEffects |> List.map Tuple.second

                m2 =
                    { model | waterfalls = waterfalls2 }
            in
            ( { m2 | duplicates = recalcDuplicates m2 }, E.batch refreshEffects )

        WaterfallMsg id_ imsg ->
            case findK id_ model.waterfalls of
                Nothing ->
                    ( model, E.none )

                Just waterfall ->
                    let
                        ( r1model, r1cmd ) =
                            Pages_.RerDuty.Waterfall.update shared user imsg waterfall

                        waterfalls2 =
                            updateV id_ (\_ -> r1model) model.waterfalls

                        m2 =
                            { model | waterfalls = waterfalls2 }

                        m3 =
                            case imsg of
                                Pages_.RerDuty.Waterfall.CloseWaterfall ->
                                    { m2
                                        | waterfalls =
                                            List.filter (\( wId, _ ) -> wId /= id_) model.waterfalls
                                    }

                                _ ->
                                    m2

                        m4 =
                            { m3 | duplicates = recalcDuplicates m3 }

                        pushUrlCmd =
                            getPushUrlCmd m4

                        m5 =
                            { m4 | lastPushQuery = buildQuery m4 }
                    in
                    ( m5
                    , E.batch
                        [ pushUrlCmd
                        , E.map (WaterfallMsg id_) r1cmd
                        ]
                    )

        ResizeHappened ->
            let
                cmd =
                    List.map
                        (\( id_, _ ) ->
                            E.getElementById (waterfallDivId id_) GotWaterfallDiv
                                |> E.map (WaterfallMsg id_)
                        )
                        model.waterfalls
                        |> E.batch
            in
            ( model, cmd )

        GenerateNewWaterfallId ->
            ( model, E.sendCmd <| Random.generate AddWaterfall Uuid.Barebones.uuidStringGenerator )

        AddWaterfall generatedId ->
            let
                wfId =
                    "wf-" ++ String.slice 0 5 generatedId

                isIdDuplicated =
                    List.any (\( id, _ ) -> id == wfId) model.waterfalls

                ( wfModel, wfCmd ) =
                    Pages_.RerDuty.Waterfall.init wfId Nothing
            in
            if isIdDuplicated then
                ( model, E.none )

            else
                ( { model
                    | waterfalls = model.waterfalls ++ [ ( wfId, wfModel ) ]
                  }
                , E.map (WaterfallMsg wfId) wfCmd
                )

        GotDatasourceList (Err e) ->
            ( model, Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження джерел даних" e )

        GotDatasourceList (Ok xs) ->
            let
                m2 =
                    { model
                        | datasources = xs
                        , waterfalls =
                            List.map
                                (\( wfId, wf ) -> ( wfId, { wf | datasources = xs } ))
                                model.waterfalls
                    }
            in
            ( m2, E.none )

        SwitchTheme ->
            ( model, E.toggleDarkMode )


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch <|
        Browser.Events.onResize (\_ _ -> ResizeHappened)
            :: List.map
                (\( id_, wf ) ->
                    Sub.map (WaterfallMsg id_)
                        (Pages_.RerDuty.Waterfall.subscriptions wf)
                )
                model.waterfalls


emptyWaterfallQueryStateWf : B.RerDutyQueryStateWf
emptyWaterfallQueryStateWf =
    { groupsSelected = Nothing
    , groupsDenied = Nothing
    , sendersSelected = Nothing
    , deniedSenders = Nothing
    , freqsSelected = Nothing
    , freqsDenied = Nothing
    , postsSelected = Nothing
    , postsDenied = Nothing
    , unitsSelected = Nothing
    , unitsDenied = Nothing
    , selectedUnitIds = Nothing
    , deniedUnitIds = Nothing
    , selectedDeviceNames = Nothing
    , deniedDeviceNames = Nothing
    , unitsExactMatchOnly = Nothing
    , lastViewedMessageId = Nothing
    , highlightKeywordsEnabled = Nothing
    , highlightKeywordSetId = Nothing
    }


waterfallQueryState : Pages_.RerDuty.Waterfall.Model -> B.RerDutyQueryStateWf
waterfallQueryState wf =
    { groupsSelected = Just wf.groupsSelected
    , groupsDenied = Nothing
    , sendersSelected = Just wf.sendersSelect.selected
    , deniedSenders = Just wf.sendersDeniedSelect.selected
    , freqsSelected = Just wf.freqsSelect.selected
    , freqsDenied = Just wf.freqsDeniedSelect.selected
    , postsSelected = Just wf.postsSelect.selected
    , postsDenied = Just wf.postsDeniedSelect.selected
    , unitsSelected = Nothing
    , unitsDenied = Nothing
    , selectedUnitIds = Nothing
    , deniedUnitIds = Nothing
    , selectedDeviceNames = Nothing
    , deniedDeviceNames = Nothing
    , unitsExactMatchOnly = Nothing
    , lastViewedMessageId = Utils.lastViewedIdToMaybe wf.lastViewedMessageId
    , highlightKeywordsEnabled = Nothing
    , highlightKeywordSetId = Nothing
    }


modelQueryState : Model -> B.RerDutyQueryState
modelQueryState model =
    { waterfalls =
        Just <| List.map (\( wfId, wf ) -> ( wfId, waterfallQueryState wf )) model.waterfalls
    }


buildQuery : Model -> Dict String String
buildQuery model =
    let
        stateS =
            Encode.encode 0 (B.rerDutyQueryStateEncoder (modelQueryState model))
    in
    Dict.fromList
        [ ( "state", stateS )
        ]


pollEventsDelayed : Float -> Maybe String -> Effect Msg
pollEventsDelayed delayMs lastEventId =
    E.sendCmd <| Task.perform (\_ -> EventPollTrigger lastEventId) (Process.sleep delayMs)


pollEvents : Maybe String -> Effect Msg
pollEvents lastEventId =
    let
        request : B.LongPollReq
        request =
            { sessionId = "current"
            , lastEventId = lastEventId
            , deploymentMaintenanceProtocol = Nothing
            , knownDeploymentMaintenanceId = Nothing
            }
    in
    E.sendCmd <|
        Http.post
            { url = "/api/event-stream/long-poll"
            , body = Http.jsonBody (B.longPollReqEncoder request)
            , expect = leExpectJson EventPollReceived B.longPollRspDecoder
            }


getPushUrlCmd : Model -> Effect Msg
getPushUrlCmd model =
    let
        query =
            buildQuery model
    in
    if query /= model.lastPushQuery then
        E.pushRoute { path = Route.Path.RerDuty, hash = Nothing, query = query }

    else
        E.none



-- Browser.Navigation.pushUrl model.key url


newTabBlock : Html Msg
newTabBlock =
    span
        [ style "font-size" "1.4rem"
        , class "m-2  cursor-pointer"
        , onClick GenerateNewWaterfallId
        , title "нова колонка"
        ]
        [ i [ class "bi bi-plus-square" ] []
        ]


body : Bool -> Shared.Model -> User -> Model -> List (Html Msg)
body isDarkMode shared user model =
    [ div [ class "bg-background flex rer-duty flex-1" ] <|
        [ div
            [ class
                ("grid-container grow-1 "
                    ++ (if List.length model.waterfalls <= 2 then
                            "justify-items-center"

                        else
                            ""
                       )
                )
            ]
          <|
            List.map
                (\( id_, wf ) ->
                    Html.map (WaterfallMsg id_)
                        (Pages_.RerDuty.Waterfall.messageTab
                            { isDarkMode = isDarkMode
                            , duplicates = model.duplicates
                            , datasources = model.datasources
                            , serverInfo = shared.serverInfo
                            , user = user
                            , waterfallsAmount = List.length model.waterfalls
                            , masterUnits =
                                case shared.masterUnits of
                                    Success units ->
                                        units

                                    _ ->
                                        Dict.empty
                            , networks =
                                case shared.networks of
                                    Success networks ->
                                        networks

                                    _ ->
                                        Dict.empty
                            }
                            shared
                            wf
                        )
                )
                model.waterfalls
        , div [ class "shrink mt-12" ]
            [ newTabBlock ]
        ]
    ]


view : Bool -> Shared.Model -> User -> Model -> View Msg
view dark shared user model =
    { title = "РЕР-оперативний"
    , body = body dark shared user model
    }
