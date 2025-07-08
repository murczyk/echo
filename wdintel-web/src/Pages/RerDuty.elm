module Pages.RerDuty exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B exposing (..)
import Browser.Events
import Components.Navbar exposing (navBar)
import Components.ThemeSwitcher exposing (colorThemeSwitcher)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import Le.Types exposing (..)
import Le.Utils exposing (..)
import Le.Waterfall exposing (Msg(..), waterfallDivId)
import Le.Waterfall.Messages as Messages
import Le.Waterfall.Utils as Utils
import Maybe.Extra as MaybeX exposing (isJust)
import Page exposing (Page)
import Random
import Route exposing (Route)
import Route.Path
import Set exposing (Set)
import Shared
import Task
import Time
import Uuid.Barebones
import View exposing (View)
import Views


type alias Model =
    { formErrors : Dict String String
    , navCollapsed : Bool
    , waterfalls : List ( String, Le.Waterfall.Model )
    , duplicates : Set Int
    , lastPushQuery : Dict String String
    , datasources : List ( Int, Datasource )
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
                                    (Le.Waterfall.init wfId (Just wfState))
                        in
                        ( wfId, wfmodel )
                    )

        cmds =
            (E.sendCmd <| Api.datasource_list GotDatasourceList)
                :: (waterfallStates
                        |> List.map
                            (\( wfId, wfState ) ->
                                let
                                    wfcmd =
                                        Tuple.second
                                            (Le.Waterfall.init wfId (Just wfState))
                                in
                                --TODO: now it sends msgs to all waterfalls, like we check height of wf-1, but it also send to wf-2
                                E.map (WaterfallMsg wfId) wfcmd
                            )
                   )

        model =
            { formErrors = Dict.empty
            , navCollapsed = False
            , waterfalls = waterfalls
            , duplicates = Set.empty
            , lastPushQuery = route.query
            , datasources = []
            }

        pushUrlCmd =
            getPushUrlCmd model
    in
    ( model
    , E.batch (pushUrlCmd :: cmds)
    )


type Msg
    = WaterfallMsg String Le.Waterfall.Msg
    | ResizeHappened
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
        , view = view shared.isDarkMode shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }


type alias RecalcDuplicatesAcc =
    { duplicates : Set Int
    , seenMsgs : Dict String Int
    }


recalcDuplicates : Model -> Set Int
recalcDuplicates model =
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
            if msg.text == "" then
                acc

            else
                let
                    form1 =
                        msg.text

                    form2 =
                        String.dropRight 1 msg.text

                    seenForm1 =
                        Dict.get form1 acc.seenMsgs

                    seenForm2 =
                        Dict.get form2 acc.seenMsgs
                in
                if
                    (isJust seenForm1 && (seenForm1 /= Just id_))
                        || (isJust seenForm2 && (seenForm2 /= Just id_))
                then
                    { acc
                        | duplicates = acc.duplicates |> Set.insert id_
                    }

                else
                    { acc
                        | seenMsgs =
                            acc.seenMsgs
                                |> Dict.insert form1 id_
                                |> Dict.insert form2 id_
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

        WaterfallMsg id_ imsg ->
            case findK id_ model.waterfalls of
                Nothing ->
                    ( model, E.none )

                Just waterfall ->
                    let
                        ( r1model, r1cmd ) =
                            Le.Waterfall.update shared user imsg waterfall

                        waterfalls2 =
                            updateV id_ (\_ -> r1model) model.waterfalls

                        m2 =
                            { model | waterfalls = waterfalls2 }

                        m3 =
                            case imsg of
                                Le.Waterfall.CloseWaterfall ->
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
                    Le.Waterfall.init wfId Nothing
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
            ( model, E.showError "Somthing went wrong" )

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
                        (Le.Waterfall.subscriptions wf)
                )
                model.waterfalls


emptyWaterfallQueryStateWf : B.RerDutyQueryStateWf
emptyWaterfallQueryStateWf =
    { groupsSelected = Nothing
    , sendersSelected = Nothing
    , deniedSenders = Nothing
    , freqsSelected = Nothing
    , freqsDenied = Nothing
    , postsSelected = Nothing
    , postsDenied = Nothing
    , lastViewedMessageId = Nothing
    }


waterfallQueryState : Le.Waterfall.Model -> B.RerDutyQueryStateWf
waterfallQueryState wf =
    { groupsSelected = Just wf.groupsSelected
    , sendersSelected = Just wf.sendersSelect.selected
    , deniedSenders = Just wf.sendersDeniedSelect.selected
    , freqsSelected = Just wf.freqsSelect.selected
    , freqsDenied = Just wf.freqsDeniedSelect.selected
    , postsSelected = Just wf.postsSelect.selected
    , postsDenied = Just wf.postsDeniedSelect.selected
    , lastViewedMessageId = Utils.lastViewedIdToMaybe wf.lastViewedMessageId
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
                        (Le.Waterfall.messageTab
                            { isDarkMode = isDarkMode
                            , duplicates = model.duplicates
                            , datasources = model.datasources
                            , serverInfo = shared.serverInfo
                            , user = user
                            , waterfallsAmount = List.length model.waterfalls
                            }
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
