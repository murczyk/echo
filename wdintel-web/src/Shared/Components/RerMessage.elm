module Shared.Components.RerMessage exposing (Edited, Model, Msg(..), OutSignal(..), RenderParams, ViewParams, compNewGroups, compNewProfiles, getProfileName, groupName, init, isTagSet, model0, profileNameStr, renderRow, toggleTag, update)

import Api
import Bindings as B exposing (..)
import Config
import Core.Auth
import Core.Callsigns.HintStrategy
import Core.Types exposing (..)
import Core.Unit
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import List.Extra as ListX
import Maybe exposing (withDefault)
import Maybe.Extra as MaybeX exposing (isJust)
import Pages_.RerAnalysis.Utils
import Route exposing (Route)
import Set exposing (Set)
import Shared.Callsign
import Shared.Components.Watermark as Watermark
import Shared.Icons as Icons
import Shared.MarkedText
import String exposing (fromInt, trim)
import Time
import Time.Extra as TimeExtra
import Utils.Api.ErrorHandling
import Utils.Time
import Utils.Utils exposing (..)
import Utils.ViewUtils exposing (tagsBlock)


type alias ViewParams =
    { profiles : Dict String (Maybe B.SignalProfileEntry)
    , groupInfos : Dict String B.SignalGroupEntry
    , zone : Time.Zone
    , messages : List ( Int, InboxMessage )
    , tags : List ( Int, B.Tag )
    , callsignsInfo : Dict String (List B.CallsignInfo)
    , messageComments : Dict Int (List B.MessageComment)
    , user : B.User
    , users : Dict String (Maybe B.User)
    , serverInfo : Maybe B.ServerInfo
    , networks : Dict Int B.Network
    , masterUnits : Dict Int B.Unit
    , currentRoute : Maybe (Route ())
    }


type alias RenderParams =
    { hideCheckboxes : Bool
    , hideIndividualSave : Bool
    }


type alias Edited =
    { original : B.InboxMessage }


type alias BotTagAction =
    { messageId : Int
    , tagId : Int
    }


type alias Model =
    { callsignInputs : Dict Int String
    , edited : Dict Int Edited
    , extendedForm : Set Int
    , focusedTextarea : Maybe Int
    , botTagAction : Maybe BotTagAction
    }


model0 : Model
model0 =
    { callsignInputs = Dict.empty
    , edited = Dict.empty
    , extendedForm = Set.empty
    , focusedTextarea = Nothing
    , botTagAction = Nothing
    }


type Msg
    = DeleteCallsign Int Int
    | InputDate Int String
    | InputTime Int String
    | InputFreq Int String
    | InputUnit Int String
    | InputLocation Int String
    | InputCoords Int String
    | InputPost Int String
    | SetCallsignInput Int String
    | CallsignKeyDown Int Int
    | AddCallsign Int
    | AddCallsignS Int String
    | EditCancel Int
    | EditSave Int
    | InboxSubmitDone Int Bool (Result ApiError ())
    | CommentSaveDone Int (Result ApiError ())
    | ExtendedFormChanged Int String
    | ToggleTag Int Int
    | TagSaveDone Int Int InboxMessage (Result ApiError ())
    | MarkBotTagWrong Int Int
    | MarkBotTagWrongDone Int Int (Result ApiError ())
    | CancelBotTagAction
    | BookmarkAdd Int
    | BookmarkAddDone (Result ApiError ())
    | BookmarkRemove Int
    | BookmarkRemoveDone (Result ApiError ())
    | ImportantAdd Int
    | ImportantAddDone (Result ApiError ())
    | ImportantRemove Int
    | ImportantRemoveDone (Result ApiError ())
    | DeleteMessage Int
    | SelectFreqAndShowMap String
    | OpenSidebarEdit Int
    | TextareaFocus Int
    | TextareaBlur Int


type OutSignal
    = OutFocus { elemId : String }
    | OutFormErrors (Dict String String)
    | OutDeleteMessage Int
    | OutSelectFreqAndShowMap String
    | OutOpenSidebarEdit Int


isOurOrganism : B.User -> Dict String (Maybe B.User) -> String -> Bool
isOurOrganism user users login =
    if user.name == login then
        True

    else
        case Dict.get login users of
            Nothing ->
                False

            Just (Just user2) ->
                isJust user.organismId
                    && isJust user2.organismId
                    && user2.organismId
                    == user.organismId

            _ ->
                False


addCallsign :
    Model
    -> Int
    -> List ( Int, InboxMessage )
    -> { model : Model, messages : List ( Int, InboxMessage ) }
addCallsign model id_ messages =
    let
        callsignInputs2 =
            Dict.remove id_ model.callsignInputs

        updF message =
            case Dict.get id_ model.callsignInputs of
                Nothing ->
                    message

                Just callsign ->
                    let
                        callsigns2 =
                            message.callsigns ++ [ callsign ]
                    in
                    { message | callsigns = callsigns2 }
    in
    { model = { model | callsignInputs = callsignInputs2 }
    , messages =
        updateV id_ updF messages
    }


proposedCallsignMaxLen : number
proposedCallsignMaxLen =
    16


addEdited : Int -> Dict Int Edited -> List ( Int, InboxMessage ) -> Dict Int Edited
addEdited id_ edited messages =
    case Dict.get id_ edited of
        Just _ ->
            edited

        Nothing ->
            case findK id_ messages of
                Nothing ->
                    edited

                Just message ->
                    Dict.insert id_ { original = message } edited


compNewGroups :
    List ( Int, B.InboxMessage )
    -> Dict String B.SignalGroupEntry
    -> List String
compNewGroups messages groupInfos =
    let
        groupKeysExisting =
            Dict.keys groupInfos
                |> Set.fromList
    in
    messages
        |> List.map (Tuple.second >> .groupMasterKey)
        |> MaybeX.values
        |> Set.fromList
        |> (\x -> Set.diff x groupKeysExisting)
        |> Set.toList


compNewProfiles :
    List ( Int, B.InboxMessage )
    -> Dict String (Maybe B.SignalProfileEntry)
    -> List String
compNewProfiles messages profiles =
    let
        profilesExisting =
            Dict.keys profiles
                |> Set.fromList
    in
    messages
        |> List.map (Tuple.second >> .sender)
        |> MaybeX.values
        |> Set.fromList
        |> (\x -> Set.diff x profilesExisting)
        |> Set.toList


init : Effect Msg
init =
    E.none


update :
    ViewParams
    -> Msg
    -> Model
    ->
        { model : Model
        , cmds : Effect Msg
        , sigs : List OutSignal
        , messages : List ( Int, InboxMessage )
        }
update vps msg model =
    case msg of
        SetCallsignInput id_ callsign ->
            let
                callsignInputs2 =
                    Dict.insert id_ callsign model.callsignInputs
            in
            { model =
                { model
                    | callsignInputs = callsignInputs2
                    , edited = addEdited id_ model.edited vps.messages
                }
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        CallsignKeyDown id_ key ->
            if key == 13 then
                let
                    res =
                        addCallsign model id_ vps.messages

                    m2 =
                        res.model

                    m3 =
                        { m2 | edited = addEdited id_ m2.edited res.messages }
                in
                { model = m3
                , cmds = E.none
                , sigs = [ OutFocus { elemId = callsignInputId id_ } ]
                , messages = res.messages
                }

            else
                { model = model
                , cmds = E.none
                , sigs = []
                , messages = vps.messages
                }

        AddCallsign id_ ->
            let
                res =
                    addCallsign model id_ vps.messages

                m2 =
                    res.model

                m3 =
                    { m2 | edited = addEdited id_ model.edited vps.messages }
            in
            { model = m3
            , cmds = E.none
            , sigs = []
            , messages = res.messages
            }

        AddCallsignS id_ callsign ->
            let
                messages2 =
                    updateV id_
                        (\m -> { m | callsigns = m.callsigns ++ [ callsign ] })
                        vps.messages

                m2 =
                    { model | edited = addEdited id_ model.edited vps.messages }
            in
            { model = m2
            , cmds = E.none
            , sigs = []
            , messages = messages2
            }

        DeleteCallsign id_ i_ ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        let
                            callsigns2 =
                                ListX.removeAt i_ message.callsigns
                        in
                        { message | callsigns = callsigns2 }
                    )
                    vps.messages
            }

        InputDate id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | date = Just str }
                    )
                    vps.messages
            }

        InputTime id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | time = Just str }
                    )
                    vps.messages
            }

        InputFreq id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | freq = Just str }
                    )
                    vps.messages
            }

        InputCoords id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | coords = Just str }
                    )
                    vps.messages
            }

        InputUnit id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | unit = Just str }
                    )
                    vps.messages
            }

        InputPost id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | post = Just str }
                    )
                    vps.messages
            }

        InputLocation id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | location = Just str }
                    )
                    vps.messages
            }

        EditCancel id_ ->
            let
                callsignInputs2 =
                    Dict.insert id_ "" model.callsignInputs

                messages2 =
                    case Dict.get id_ model.edited of
                        Nothing ->
                            vps.messages

                        Just edited ->
                            updateV id_ (always edited.original) vps.messages
            in
            { model =
                { model
                    | callsignInputs = callsignInputs2
                    , edited = Dict.remove id_ model.edited
                }
            , cmds = E.none
            , sigs = []
            , messages = messages2
            }

        EditSave id_ ->
            case Dict.get id_ model.edited of
                Nothing ->
                    { model = model
                    , cmds = E.none
                    , sigs = []
                    , messages = vps.messages
                    }

                Just edited ->
                    case findK id_ vps.messages of
                        Nothing ->
                            { model = model
                            , cmds = E.none
                            , sigs = []
                            , messages = vps.messages
                            }

                        Just message ->
                            let
                                message2 =
                                    case Dict.get id_ model.callsignInputs of
                                        Nothing ->
                                            message

                                        Just c ->
                                            if c /= "" then
                                                { message
                                                    | callsigns =
                                                        message.callsigns
                                                            ++ [ trim c ]
                                                }

                                            else
                                                message

                                messages2 =
                                    updateV id_ (\_ -> message2) vps.messages

                                otherChanges =
                                    sanitizeMessageForSubmit edited.original
                                        /= sanitizeMessageForSubmit message2

                                commentChanged =
                                    edited.original.extendedForm
                                        /= message2.extendedForm

                                submitCmd =
                                    if otherChanges then
                                        Api.rer_importer_inbox_submit (InboxSubmitDone id_ commentChanged)
                                            { messages =
                                                [ ( id_
                                                  , sanitizeMessageForSubmit message2
                                                  )
                                                ]
                                            }

                                    else
                                        E.none

                                commentCmd =
                                    if not otherChanges && commentChanged then
                                        buildCommentSaveCmd id_ message2

                                    else
                                        E.none
                            in
                            { model = model
                            , cmds = E.batch [ submitCmd, commentCmd ]
                            , sigs = []
                            , messages = messages2
                            }

        InboxSubmitDone _ _ (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження повідомлення" e
            , sigs = []
            , messages = vps.messages
            }

        InboxSubmitDone id_ commentChanged (Ok ()) ->
            if commentChanged then
                let
                    commentCmd =
                        findK id_ vps.messages
                            |> Maybe.map (buildCommentSaveCmd id_)
                            |> Maybe.withDefault E.none
                in
                { model = model
                , cmds = commentCmd
                , sigs = []
                , messages = vps.messages
                }

            else
                { model = { model | edited = Dict.remove id_ model.edited, callsignInputs = Dict.remove id_ model.callsignInputs }
                , cmds = E.none
                , sigs = []
                , messages = vps.messages
                }

        CommentSaveDone id_ (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження коментаря" e
            , sigs = []
            , messages = vps.messages
            }

        CommentSaveDone id_ (Ok ()) ->
            { model = { model | edited = Dict.remove id_ model.edited, callsignInputs = Dict.remove id_ model.callsignInputs }
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        ExtendedFormChanged id_ str ->
            { model = { model | edited = addEdited id_ model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages =
                updateV id_
                    (\message ->
                        { message | extendedForm = Just str }
                    )
                    vps.messages
            }

        ToggleTag msgId tagId ->
            case findK msgId vps.messages of
                Nothing ->
                    { model = model
                    , cmds = E.none
                    , sigs = []
                    , messages = vps.messages
                    }

                Just messageBefore ->
                    let
                        userHasTag =
                            hasUserTag msgId tagId vps.user.name vps.messages

                        cmd =
                            if userHasTag then
                                Api.inbox_message_tags_rm (TagSaveDone msgId tagId messageBefore) { messageId = msgId, tagId = tagId }

                            else
                                Api.inbox_message_tags_add (TagSaveDone msgId tagId messageBefore) { messageId = msgId, tagId = tagId }

                        botPanel =
                            if userHasTag && hasBotTag msgId tagId vps.messages then
                                Just { messageId = msgId, tagId = tagId }

                            else
                                Nothing
                    in
                    { model = { model | botTagAction = botPanel }
                    , cmds = E.sendCmd cmd
                    , sigs = []
                    , messages =
                        toggleTag msgId tagId (Just vps.user.name) vps.user.organismId vps.messages
                    }

        TagSaveDone msgId _ messageBefore (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося оновити тег" e
            , sigs = []
            , messages = updateV msgId (\_ -> messageBefore) vps.messages
            }

        TagSaveDone _ _ _ (Ok _) ->
            { model = model
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        MarkBotTagWrong msgId tagId ->
            { model = model
            , cmds =
                Api.inbox_message_tags_model_error
                    (MarkBotTagWrongDone msgId tagId)
                    { messageId = msgId, tagId = tagId }
                    |> E.sendCmd
            , sigs = []
            , messages = vps.messages
            }

        MarkBotTagWrongDone msgId tagId (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося оновити тег бота" e
            , sigs = []
            , messages = vps.messages
            }

        MarkBotTagWrongDone msgId tagId (Ok _) ->
            { model = { model | botTagAction = Nothing }
            , cmds = E.none
            , sigs = []
            , messages = removeBotTags msgId tagId vps.messages
            }

        CancelBotTagAction ->
            { model = { model | botTagAction = Nothing }
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        BookmarkAdd id_ ->
            { model = model
            , cmds = E.sendCmd <| Api.rer_bookmark_add BookmarkAddDone { messageId = id_ }
            , sigs = []
            , messages =
                updateV id_
                    (\message -> { message | bookmarked = True })
                    vps.messages
            }

        BookmarkAddDone (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання закладки" e
            , sigs = []
            , messages = vps.messages
            }

        BookmarkAddDone (Ok ()) ->
            { model = model
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        BookmarkRemove id_ ->
            { model = model
            , cmds = E.sendCmd <| Api.rer_bookmark_rm BookmarkRemoveDone { messageId = id_ }
            , sigs = []
            , messages =
                updateV id_
                    (\message -> { message | bookmarked = False })
                    vps.messages
            }

        BookmarkRemoveDone (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення закладки" e
            , sigs = []
            , messages = vps.messages
            }

        BookmarkRemoveDone (Ok ()) ->
            { model = model
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        ImportantAdd id_ ->
            { model = model
            , cmds = E.sendCmd <| Api.rer_important_add ImportantAddDone { messageId = id_ }
            , sigs = []
            , messages =
                updateV id_
                    (\message -> { message | important = True })
                    vps.messages
            }

        ImportantAddDone (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання важливого повідомлення" e
            , sigs = []
            , messages = vps.messages
            }

        ImportantAddDone (Ok ()) ->
            { model = model
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        ImportantRemove id_ ->
            { model = model
            , cmds = E.sendCmd <| Api.rer_important_rm ImportantRemoveDone { messageId = id_ }
            , sigs = []
            , messages =
                updateV id_
                    (\message -> { message | important = False })
                    vps.messages
            }

        ImportantRemoveDone (Err e) ->
            { model = model
            , cmds = Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення важливого повідомлення" e
            , sigs = []
            , messages = vps.messages
            }

        ImportantRemoveDone (Ok ()) ->
            { model = model
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        DeleteMessage id_ ->
            { model = model
            , cmds = E.none
            , sigs = [ OutDeleteMessage id_ ]
            , messages = vps.messages
            }

        SelectFreqAndShowMap freq ->
            { model = model
            , cmds = E.none
            , sigs = [ OutSelectFreqAndShowMap freq ]
            , messages = vps.messages
            }

        OpenSidebarEdit msgId ->
            { model = model
            , cmds = E.none
            , sigs = [ OutOpenSidebarEdit msgId ]
            , messages = vps.messages
            }

        TextareaFocus msgId ->
            { model = { model | focusedTextarea = Just msgId }
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }

        TextareaBlur _ ->
            { model = { model | focusedTextarea = Nothing }
            , cmds = E.none
            , sigs = []
            , messages = vps.messages
            }


callsignInputId : Int -> String
callsignInputId id_ =
    "add-callsign-input-" ++ String.fromInt id_


profileNameStr : String -> B.SignalProfileEntry -> String
profileNameStr uuid x =
    case ( x.givenName, x.familyName ) of
        ( Just a, Just b ) ->
            a ++ " " ++ b

        ( Just a, Nothing ) ->
            a

        ( Nothing, Just b ) ->
            b

        ( Nothing, Nothing ) ->
            uuid


getProfileName : Dict String (Maybe B.SignalProfileEntry) -> String -> String
getProfileName profiles uuid =
    case Dict.get uuid profiles of
        Just (Just profile) ->
            profileNameStr uuid profile

        _ ->
            uuid


groupName : String -> Dict String B.SignalGroupEntry -> String
groupName masterKey groupInfos =
    case Dict.get masterKey groupInfos of
        Just group ->
            group.name

        _ ->
            masterKey


sanitizeMessageForSubmit : InboxMessage -> InboxMessage
sanitizeMessageForSubmit message =
    { message
        | tags = Nothing
        , inboxTags = Nothing
        , extendedForm = Nothing
    }


buildCommentSaveCmd : Int -> InboxMessage -> Effect Msg
buildCommentSaveCmd msgId message =
    let
        commentCleaned =
            message.extendedForm
                |> Maybe.map trim
                |> Maybe.andThen
                    (\v ->
                        if v == "" then
                            Nothing

                        else
                            Just v
                    )
    in
    Api.rer_importer_comment_save (CommentSaveDone msgId)
        { messageId = msgId, comment = commentCleaned }
        |> E.sendCmd


isTagSet : Int -> Int -> List ( Int, B.InboxMessage ) -> Bool
isTagSet msgId tagId messages =
    messages
        |> findK msgId
        |> Maybe.map (.inboxTags >> Maybe.withDefault [] >> List.any (\t -> t.tagId == tagId))
        |> Maybe.withDefault False


hasUserTag : Int -> Int -> String -> List ( Int, B.InboxMessage ) -> Bool
hasUserTag msgId tagId login messages =
    messages
        |> findK msgId
        |> Maybe.map
            (\m ->
                inboxTagsFor m
                    |> List.any
                        (\t ->
                            t.tagId
                                == tagId
                                && t.model
                                == Nothing
                                && t.login
                                == Just login
                        )
            )
        |> Maybe.withDefault False


hasBotTag : Int -> Int -> List ( Int, B.InboxMessage ) -> Bool
hasBotTag msgId tagId messages =
    messages
        |> findK msgId
        |> Maybe.map
            (\m ->
                inboxTagsFor m
                    |> List.any
                        (\t ->
                            t.tagId == tagId && MaybeX.isJust t.model
                        )
            )
        |> Maybe.withDefault False


inboxTagsFor : B.InboxMessage -> List B.InboxMessageTag
inboxTagsFor message =
    message.inboxTags |> Maybe.withDefault []


tagIdsWithFallback : List B.InboxMessageTag -> List Int -> List Int
tagIdsWithFallback inboxTags fallbackTags =
    let
        ids =
            inboxTags
                |> List.map .tagId
                |> ListX.unique
    in
    ids
        ++ (fallbackTags
                |> List.filter (\tid -> not (List.member tid ids))
           )


toggleTag :
    Int
    -> Int
    -> Maybe String
    -> Maybe Int
    -> List ( Int, B.InboxMessage )
    -> List ( Int, B.InboxMessage )
toggleTag msgId tagId login organismId messages =
    let
        updateMessage message =
            let
                currentTags =
                    inboxTagsFor message

                remainingTags =
                    case login of
                        Just loginName ->
                            List.filter
                                (\tag ->
                                    not
                                        (tag.tagId
                                            == tagId
                                            && tag.model
                                            == Nothing
                                            && tag.login
                                            == Just loginName
                                        )
                                )
                                currentTags

                        Nothing ->
                            currentTags

                hasRemoved =
                    List.length remainingTags /= List.length currentTags

                added =
                    case ( login, hasRemoved ) of
                        ( Just loginName, False ) ->
                            [ { id = 0
                              , tagId = tagId
                              , confidence = 1
                              , login = Just loginName
                              , model = Nothing
                              , organismId = organismId
                              }
                            ]

                        _ ->
                            []

                inboxTags2 =
                    added ++ remainingTags

                tags2 =
                    tagIdsWithFallback inboxTags2 (message.tags |> def [])
            in
            { message | tags = Just tags2, inboxTags = Just inboxTags2 }
    in
    messages |> updateV msgId updateMessage


removeBotTags :
    Int
    -> Int
    -> List ( Int, B.InboxMessage )
    -> List ( Int, B.InboxMessage )
removeBotTags msgId tagId messages =
    let
        updateMessage message =
            let
                inboxTags2 =
                    inboxTagsFor message
                        |> List.filter
                            (\tag ->
                                not
                                    (tag.tagId
                                        == tagId
                                        && MaybeX.isJust tag.model
                                    )
                            )

                tags2 =
                    tagIdsWithFallback inboxTags2 (message.tags |> def [])
            in
            { message | inboxTags = Just inboxTags2, tags = Just tags2 }
    in
    messages |> updateV msgId updateMessage


renderRow :
    ViewParams
    -> RenderParams
    -> Model
    -> ( Int, ( Int, InboxMessage ) )
    -> Html Msg
renderRow vps _ model ( i_, ( msgId, message ) ) =
    let
        callsignTag ( j, callsign ) =
            let
                hintResult =
                    Core.Callsigns.HintStrategy.getCallsignHints Core.Callsigns.HintStrategy.MessageContext message vps callsign

                result =
                    if List.length hintResult.prioritizedCallsigns > 0 then
                        Shared.Callsign.viewWithHintResult callsign hintResult

                    else
                        Shared.Callsign.viewDefault callsign False
            in
            span
                [ class "inline-flex items-center gap-1 text-secondary hover:text-secondary-hover transition-colors group callsign-tooltip"
                ]
                [ span [ class "text-uppercase font-medium" ] [ result ]
                , button
                    [ type_ "button"
                    , class "w-4 h-4 flex items-center justify-center text-secondary hover:text-error transition-colors opacity-60 group-hover:opacity-100"
                    , onClick <| DeleteCallsign msgId j
                    , title "Видалити позивний"
                    ]
                    [ i [ class "bi bi-x text-sm" ] [] ]
                , text "|"
                ]

        imgWidth =
            200

        renderImage image =
            div [ style "display" "inline-block" ]
                [ a
                    [ href image
                    , target "_blank"
                    ]
                    [ img
                        [ src image
                        , style "width" (String.fromInt imgWidth ++ "px")
                        ]
                        []
                    ]
                ]

        renderAttachment : MessageMediaInfo -> Html msg
        renderAttachment attachment =
            let
                displayFileName =
                    withDefault "<файл без назви>" attachment.fileName
            in
            a
                [ class "btn btn-outline-secondary btn-sm mb-2"
                , href attachment.href
                , download displayFileName
                , target "_blank"
                ]
                [ i [ class "bi bi-download me-2" ] []
                , text displayFileName
                ]

        renderMedia : MessageMediaInfo -> Maybe (Html msg)
        renderMedia attachment =
            let
                isImage =
                    String.startsWith "image/" attachment.contentType

                isMp3 =
                    String.contains "mpeg" attachment.contentType
                        || String.contains "mp3" attachment.contentType
                        || (attachment.fileName
                                |> Maybe.map String.toLower
                                |> Maybe.map (String.endsWith ".mp3")
                                |> withDefault False
                           )
            in
            if isImage then
                Nothing

            else if isMp3 then
                Just <| renderAttachment attachment

            else if Config.featureHideDocuments then
                Nothing

            else
                Just <| renderAttachment attachment

        timeColumn =
            let
                formattedDateTime =
                    case ( message.date, message.time ) of
                        ( Just dateStr, Just timeStr ) ->
                            Utils.Time.parseDatetimeParts (dateStr ++ "T" ++ timeStr)
                                |> Result.toMaybe
                                |> Maybe.map (TimeExtra.partsToPosix vps.zone)
                                |> Maybe.map (Utils.Time.renderDateTimeF1 vps.zone)
                                |> Maybe.withDefault (String.trim (dateStr ++ " " ++ timeStr))

                        ( Just dateStr, Nothing ) ->
                            dateStr

                        ( Nothing, Just timeStr ) ->
                            timeStr

                        _ ->
                            message.timestamp
                                |> Maybe.map (Utils.Time.renderDateTimeF1 vps.zone << Time.millisToPosix)
                                |> Maybe.withDefault ""

                dateTimeBlock =
                    HtmlX.viewIf (formattedDateTime /= "") <|
                        div
                            [ class "flex items-center gap-2"
                            , title "Час перехоплення"
                            ]
                            [ i [ class "bi bi-calendar-event text-icons" ] []
                            , span [ class "font-medium" ] [ text formattedDateTime ]
                            ]

                actionsBlock =
                    div [ class "flex justify-center gap-4" ]
                        [ let
                            bookmarked =
                                message.bookmarked
                          in
                          div
                            [ title "додати в закладки"
                            , class "cursor-pointer text-action  text-[16px]"
                            , onClick
                                (if bookmarked then
                                    BookmarkRemove msgId

                                 else
                                    BookmarkAdd msgId
                                )
                            ]
                            [ i
                                [ class "bi"
                                , classList
                                    [ ( "bi-bookmark", not bookmarked )
                                    , ( "bi-bookmark-fill", bookmarked )
                                    ]
                                ]
                                []
                            ]
                        , let
                            important =
                                message.important
                          in
                          div
                            [ title "помітити як важливе"
                            , class "text-[16px] cursor-pointer text-action"
                            , onClick
                                (if important then
                                    ImportantRemove msgId

                                 else
                                    ImportantAdd msgId
                                )
                            ]
                            [ i
                                [ class "bi"
                                , classList
                                    [ ( "bi-exclamation-triangle", not important )
                                    , ( "bi-exclamation-triangle-fill text-danger", important )
                                    ]
                                ]
                                []
                            ]
                        , HtmlX.viewIf (Core.Auth.hasRole "DeleteMsg" vps.user) <|
                            div
                                [ title "видалити повідомлення"
                                , class "text-[16px] cursor-pointer text-action"
                                , attribute "data-bs-toggle" "modal"
                                , attribute "data-bs-target" "#deleteMessageModal"
                                ]
                                [ i
                                    [ class "bi bi-trash3 text-danger"
                                    , onClick <| DeleteMessage msgId
                                    ]
                                    []
                                ]
                        , div
                            [ class "text-center cursor-pointer"
                            , style "font-size" "16px"
                            , title "редагувати додаткові поля"
                            , onClick <| OpenSidebarEdit msgId
                            ]
                            [ i [ class "bi bi-pencil text-action" ] []
                            ]
                        ]
            in
            [ div [ class "flex flex-col gap-1" ]
                [ actionsBlock
                , dateTimeBlock
                , metadataBlock
                ]
            ]

        metadataBlock =
            let
                itemBlock : { iconName : String, iconTitle : String, label : Maybe String } -> List (Html Msg) -> Html Msg
                itemBlock config actions =
                    div [ class "flex justify-between items-center" ]
                        [ div [ class "flex items-center" ]
                            [ i [ class ("bi mr-2 text-icons leading-none " ++ config.iconName), title config.iconTitle ] []
                            , span [ class "" ]
                                [ text <| Maybe.withDefault "" config.label ]
                            ]
                        , div [ class "flex items-center gap-1" ]
                            actions
                        ]

                messageTimestamp =
                    message.timestamp
                        |> Maybe.map (Utils.Time.renderDateTimeF1 vps.zone << Time.millisToPosix)
            in
            div [ class "flex flex-col gap-1" ]
                [ div [ title "Час коли попало в групу" ]
                    [ itemBlock
                        { iconTitle = String.fromInt msgId
                        , iconName = "bi-clock-history"
                        , label = messageTimestamp
                        }
                        []
                    ]
                , let
                    mGroup =
                        message.groupMasterKey
                            |> Maybe.andThen (\groupMasterKey -> Dict.get groupMasterKey vps.groupInfos)
                  in
                  itemBlock { iconTitle = "Група", iconName = "bi-signal", label = Maybe.map .name mGroup } []
                , let
                    emptyName =
                        "(невідомо)"

                    profile =
                        message.sender
                            |> Maybe.andThen (\s -> Dict.get s vps.profiles)
                            |> MaybeX.join
                            |> Maybe.withDefault
                                { givenName = Just emptyName, familyName = Nothing }

                    label =
                        case ( profile.givenName, profile.familyName ) of
                            ( Nothing, Nothing ) ->
                                emptyName

                            _ ->
                                Maybe.withDefault "" profile.givenName
                                    ++ " "
                                    ++ Maybe.withDefault "" profile.familyName
                  in
                  itemBlock { iconTitle = "Відправник", iconName = "bi-person-circle", label = Just label } []
                , let
                    updatedRouteString =
                        case vps.currentRoute of
                            Just x ->
                                insertShowMapToQuery (Pages_.RerAnalysis.Utils.updateQueryWithSelectedFreq (message.freq |> def "") x)

                            Nothing ->
                                "/rer-analysis"

                    actionsBlock =
                        [ i
                            [ class "bi bi-map mr-1 text-icons leading-none text-sm cursor-pointer"
                            , title "Відкрити частоту на мапі"
                            , onClick (SelectFreqAndShowMap (message.freq |> def ""))
                            ]
                            []
                        , a [ href updatedRouteString, target "_blank" ]
                            [ i [ class "bi bi-box-arrow-up-right cursor-pointer text-action text-sm", title "Відкрити частоту на мапі в окремому вікні" ] [] ]
                        ]
                  in
                  itemBlock { label = message.freq, iconName = "bi-broadcast", iconTitle = "Частота" } actionsBlock
                , itemBlock { iconTitle = "Координати", iconName = "bi-geo", label = message.coords } []
                , itemBlock { iconTitle = "Пости", iconName = "bi-binoculars", label = message.post } []
                ]

        messageColumn =
            let
                networkBlock =
                    case message.networkIds of
                        Just networkIds ->
                            let
                                networkItems =
                                    List.map
                                        (\networkId ->
                                            case Dict.get networkId vps.networks of
                                                Just network ->
                                                    let
                                                        networkText =
                                                            Core.Unit.createMasterUnitText vps.masterUnits network

                                                        networkUrl =
                                                            "/rer-networks/" ++ String.fromInt networkId

                                                        noUnitsBadge =
                                                            case network.unitIds of
                                                                Nothing ->
                                                                    span [ class "ml-2 badge badge-no-unit-sm" ] [ text "в дорозвідці" ]

                                                                Just ids ->
                                                                    if List.isEmpty ids then
                                                                        span [ class "ml-2 badge badge-no-unit-sm" ] [ text "в дорозвідці" ]

                                                                    else
                                                                        text ""
                                                    in
                                                    div [ class "flex items-center gap-1 font-medium group" ]
                                                        [ span []
                                                            [ text networkText
                                                            , noUnitsBadge
                                                            ]
                                                        , a
                                                            [ href networkUrl
                                                            , target "_blank"
                                                            , class "text-action opacity-30 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer"
                                                            , title "Відкрити мережу в новій вкладці"
                                                            ]
                                                            [ i [ class "bi bi-box-arrow-up-right text-sm" ] [] ]
                                                        ]

                                                _ ->
                                                    div
                                                        [ class "font-medium"
                                                        , title <| "ID мережі " ++ String.fromInt networkId
                                                        ]
                                                        [ text "Невідома мережа" ]
                                        )
                                        networkIds

                                networkBlock_ =
                                    div [ class "border-b border-b-border pb-1" ] networkItems
                            in
                            networkBlock_

                        Nothing ->
                            text ""
            in
            [ div []
                [ div [] [ networkBlock ]
                , div [ class "m-1" ] <|
                    List.map renderImage message.images
                , div [ class "mt-1" ] <|
                    List.filterMap renderMedia message.media
                , div
                    [ style "margin" "0 auto"
                    , style "font-size" "1rem"
                    ]
                  <|
                    case message.textMarked of
                        Just textMarked ->
                            Shared.MarkedText.new textMarked |> Shared.MarkedText.view Dict.empty Nothing [] Nothing

                        Nothing ->
                            msgToHtml message.text
                ]
            ]

        proposedCallsignTag callsign =
            span
                [ class "inline-flex items-center gap-1 text-secondary hover:text-secondary-hover transition-colors cursor-pointer callsign-tooltip"
                , onClick <| AddCallsignS msgId callsign
                , title "Додати позивний"
                ]
                [ span [ class "text-uppercase font-medium" ] [ text callsign ]
                , i [ class "bi bi-plus text-sm opacity-60" ] []
                , text "|"
                ]

        callsignsProposed : List String
        callsignsProposed =
            let
                callsignsAlg2_2 =
                    List.filter (\x -> String.length x <= proposedCallsignMaxLen)
                        message.callsignsAlg2
                        |> ListX.unique

                callsignsPresent =
                    Set.fromList message.callsigns

                alg2 =
                    Set.fromList message.callsignsAlg2

                alg2New =
                    Set.diff alg2 callsignsPresent
            in
            List.filter (\x -> Set.member x alg2New) callsignsAlg2_2

        callsignsColumn =
            let
                inpVal =
                    Dict.get msgId model.callsignInputs
                        |> Maybe.withDefault ""

                isEdited =
                    case Dict.get msgId model.edited of
                        Just _ ->
                            True

                        Nothing ->
                            False
            in
            div [ class "space-y-2" ] <|
                [ div [ class "flex justify-between items-center gap-2" ]
                    [ div [ class "flex items-center gap-2" ]
                        [ input
                            [ type_ "text"
                            , class "flex-1  px-1 py-1 text-center text-uppercase border border-border rounded bg-card text-text focus:outline-none focus:ring-1 focus:ring-secondary-active"
                            , style "font-size" ".7rem"
                            , value inpVal
                            , placeholder "позивний"
                            , onInput <| SetCallsignInput msgId
                            , onKeyDown (CallsignKeyDown msgId)
                            , id <| callsignInputId msgId
                            ]
                            []
                        , button
                            [ type_ "button"
                            , class "w-5 h-5 flex items-center justify-center bg-secondary text-w rounded hover:bg-secondary-hover transition-colors disabled:opacity-50"
                            , onClick <| AddCallsign msgId
                            , disabled (inpVal == "")
                            , title "Додати позивний"
                            ]
                            [ i [ class "bi bi-plus text-xs" ] [] ]
                        ]
                    , div [ class "flex gap-1 ml-3 pl-3" ]
                        [ if isEdited then
                            button
                                [ type_ "button"
                                , class "w-7 h-7 flex items-center justify-center bg-neutral text-w rounded shadow-md hover:bg-neutral-hover hover:shadow-lg transition-all"
                                , onClick <| EditCancel msgId
                                , title "Скасувати всі зміни"
                                ]
                                [ i [ class "bi bi-x-lg text-sm" ] [] ]

                          else
                            div [ class "w-7 h-7" ] []
                        , if isEdited then
                            button
                                [ type_ "button"
                                , class "w-7 h-7 flex items-center justify-center bg-[var(--color-primary)] text-w rounded shadow-md hover:bg-primary-hover hover:shadow-lg transition-all"
                                , onClick <| EditSave msgId
                                , title "Зберегти всі зміни"
                                ]
                                [ i [ class "bi bi-check-lg text-sm" ] [] ]

                          else
                            div [ class "w-7 h-7" ] []
                        ]
                    ]
                , div [ class "flex flex-wrap gap-1" ]
                    (List.map callsignTag (enumerate message.callsigns))
                , div [ class "flex flex-wrap gap-1" ]
                    (List.map proposedCallsignTag callsignsProposed)
                ]

        extendedFormColumn =
            div [ class "flex flex-col gap-2 h-full my-1" ] <|
                [ div
                    [ class "flex justify-center"
                    ]
                  <|
                    [ tagsBlock message.tags message.inboxTags (ToggleTag msgId) vps.tags
                    ]
                , case model.botTagAction of
                    Just action ->
                        if action.messageId == msgId then
                            div
                                [ class "flex gap-2 items-center text-xs bg-card border border-border rounded px-3 py-2 shadow-sm" ]
                                [ button
                                    [ type_ "button"
                                    , class "btn btn-primary btn-sm"
                                    , onClick <| MarkBotTagWrong action.messageId action.tagId
                                    ]
                                    [ text "бот помилився" ]
                                , button
                                    [ type_ "button"
                                    , class "btn btn-outline-secondary btn-sm"
                                    , onClick CancelBotTagAction
                                    ]
                                    [ text "закрити" ]
                                ]

                        else
                            text ""

                    Nothing ->
                        text ""
                , textarea
                    [ class "w-full grow-1 px-3 py-2 border border-border rounded-lg bg-card text-text resize-none focus:outline-none focus:ring-2 focus:ring-secondary-light-active focus:border-transparent transition-all"
                    , style "min-height" "100px"
                    , style "font-size" ".9rem"
                    , placeholder "коментар"
                    , attribute "data-comment-draft" "rer-analysis"
                    , attribute "data-message-id" (String.fromInt msgId)
                    , onInput (ExtendedFormChanged msgId)
                    , onFocus (TextareaFocus msgId)
                    , onBlur (TextareaBlur msgId)
                    , value (Maybe.withDefault "" message.extendedForm)
                    , spellcheck False
                    ]
                    []
                , HtmlX.viewIf (List.length otherCommentsBlock > 0)
                    (div [] otherCommentsBlock)
                ]

        otherCommentsBlock =
            vps.messageComments
                |> Dict.get msgId
                |> Maybe.withDefault []
                |> List.filter (\x -> not (isOurOrganism vps.user vps.users x.login))
                |> List.map renderOtherComment

        renderOtherComment comment =
            div
                []
                [ strong [] [ text comment.login ]
                , text ": "
                , text comment.comment
                ]
    in
    div [ class "mb-3 p-2 bg-bw rounded-lg border border-border relative shadow-sm" ]
        [ div
            [ class "grid grid-cols-12 gap-2"
            , id <| "message-" ++ String.fromInt msgId
            ]
            [ div
                [ class "border-r border-border m-w-[160p] col-span-2 pr-2"
                ]
                timeColumn
            , div [ class "col-span-6 border-r border-border" ] messageColumn
            , div [ class "px-2 col-span-4 flex flex-col" ]
                [ div [] [ callsignsColumn ]
                , div [ class "flex-1" ] [ extendedFormColumn ]
                ]
            ]
        , Watermark.new vps.user.name |> Watermark.withPositioning ( 65, 75 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
        ]
