module Le.RerMessage exposing (Edited, Model, Msg(..), OutSignal(..), RenderParams, ViewParams, compNewGroups, compNewProfiles, getProfileName, groupName, init, isTagSet, model0, profileNameStr, renderRow, toggleTag, update)

import Api
import Bindings as B exposing (..)
import Components.Tag as Tag
import Components.Watermark as Watermark exposing (Watermark)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Extra as HtmlX
import Le.Auth
import Le.Block.ActionMenu
import Le.Block.Callsign
import Le.Block.MarkedText
import Le.Block.Unit
import Le.Callsign
import Le.Components exposing (fieldError, isInvalidCls)
import Le.ErrorHandling
import Le.Time
import Le.Types exposing (..)
import Le.Utils exposing (..)
import Le.ViewUtils exposing (tagsBlock)
import List.Extra as ListX
import Maybe.Extra as MaybeX exposing (isJust)
import RerAnalysis.Utils
import Route exposing (Route)
import Set exposing (Set)
import Time


extendedFormWidth =
    260


type alias ViewParams =
    { profiles : Dict String (Maybe B.SignalProfileEntry)
    , groupInfos : Dict String B.SignalGroupEntry
    , zone : Maybe Time.Zone
    , messages : List ( Int, InboxMessage )
    , bookmarks : Set Int
    , importants : Set Int
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


type alias Model =
    { callsignInputs : Dict Int String
    , edited : Dict Int Edited
    , extendedForm : Set Int
    }


model0 : Model
model0 =
    { callsignInputs = Dict.empty
    , edited = Dict.empty
    , extendedForm = Set.empty
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
    | InboxSubmitDone Int (Result ApiError ())
    | ExtendedFormChanged Int String
    | ToggleTag Int Int
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


type OutSignal
    = OutFocus { elemId : String }
    | OutFormErrors (Dict String String)
    | OutBookmarkAdd Int
    | OutBookmarkRm Int
    | OutImportantAdd Int
    | OutImportantRm Int
    | OutDeleteMessage Int
    | OutSelectFreqAndShowMap String


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
            let
                updatedMsgs =
                    case Dict.get id_ model.edited of
                        Nothing ->
                            []

                        Just _ ->
                            case findK id_ vps.messages of
                                Nothing ->
                                    []

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
                                                                    ++ [ String.trim c ]
                                                        }

                                                    else
                                                        message
                                    in
                                    [ ( id_, message2 ) ]

                messages2 =
                    case updatedMsgs of
                        x :: [] ->
                            updateV id_ (\_ -> Tuple.second x) vps.messages

                        _ ->
                            vps.messages

                cmds =
                    case updatedMsgs of
                        [] ->
                            E.none

                        _ ->
                            Api.rer_importer_inbox_submit (InboxSubmitDone id_)
                                { messages = updatedMsgs }
            in
            { model = model
            , cmds = cmds
            , sigs = []
            , messages = messages2
            }

        InboxSubmitDone _ (Err e) ->
            { model = model
            , cmds = Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка збереження повідомлення" e
            , sigs = []
            , messages = vps.messages
            }

        InboxSubmitDone id_ (Ok ()) ->
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
            { model = { model | edited = addEdited msgId model.edited vps.messages }
            , cmds = E.none
            , sigs = []
            , messages = toggleTag msgId tagId vps.messages
            }

        BookmarkAdd id_ ->
            { model = model
            , cmds = E.sendCmd <| Api.rer_bookmark_add BookmarkAddDone { messageId = id_ }
            , sigs = [ OutBookmarkAdd id_ ]
            , messages = vps.messages
            }

        BookmarkAddDone (Err e) ->
            { model = model
            , cmds = Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання закладки" e
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
            , sigs = [ OutBookmarkRm id_ ]
            , messages = vps.messages
            }

        BookmarkRemoveDone (Err e) ->
            { model = model
            , cmds = Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення закладки" e
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
            , sigs = [ OutImportantAdd id_ ]
            , messages = vps.messages
            }

        ImportantAddDone (Err e) ->
            { model = model
            , cmds = Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання важливого повідомлення" e
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
            , sigs = [ OutImportantRm id_ ]
            , messages = vps.messages
            }

        ImportantRemoveDone (Err e) ->
            { model = model
            , cmds = Le.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення важливого повідомлення" e
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


isTagSet : Int -> Int -> List ( Int, B.InboxMessage ) -> Bool
isTagSet msgId tagId messages =
    messages
        |> findK msgId
        |> mmap (.tags >> def [] >> List.member tagId)
        |> def False


toggleTag : Int -> Int -> List ( Int, B.InboxMessage ) -> List ( Int, B.InboxMessage )
toggleTag msgId tagId messages =
    let
        isSet =
            isTagSet msgId tagId messages
    in
    messages
        |> updateV msgId
            (\m ->
                let
                    tags2 : Maybe (List Int)
                    tags2 =
                        m.tags
                            |> def []
                            |> (\tags ->
                                    if isSet then
                                        List.filter (\x -> x /= tagId) tags

                                    else
                                        tags ++ [ tagId ]
                               )
                            |> Just
                in
                { m | tags = tags2 }
            )


renderRow :
    ViewParams
    -> RenderParams
    -> Model
    -> Dict String String
    -> ( Int, ( Int, InboxMessage ) )
    -> Html Msg
renderRow vps renderPs model formErrors ( i_, ( msgId, message ) ) =
    let
        idPrefix =
            "rer-inbox-msg-"

        idExtendedFormTextarea =
            idPrefix ++ String.fromInt msgId

        callsignBlock ( j, callsign ) =
            let
                networksWithMessageFreq =
                    Le.Callsign.filterNetworksByFreq vps.networks message.freq

                networksUnitIds =
                    Le.Callsign.getAllUnitsIdsForNetworks networksWithMessageFreq

                networkUnits =
                    Le.Callsign.getUnitsInfoByIds networksUnitIds vps.masterUnits

                prioritizeCallsignsPartial c =
                    Le.Callsign.prioritizeCallsigns vps.masterUnits networkUnits vps.callsignsInfo c

                ( prio, nonPrio ) =
                    prioritizeCallsignsPartial callsign

                conditionMet =
                    List.length prio > 0 || List.length nonPrio > 0

                result =
                    if conditionMet then
                        Le.Block.Callsign.view callsign ( prio, nonPrio )

                    else
                        Le.Block.Callsign.viewDefault callsign False
            in
            div [ class "d-flex justify-content-between text-uppercase" ]
                [ div [ class "flex-fill" ]
                    [ result ]
                , div [ class "ms-1" ]
                    [ i
                        [ class "bi bi-dash-circle text-action cursor-pointer"
                        , attribute "role" "button"
                        , onClick <| DeleteCallsign msgId j
                        ]
                        []
                    ]
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

        groupNameBlock =
            case
                message.groupMasterKey
                    |> Maybe.andThen (\groupMasterKey -> Dict.get groupMasterKey vps.groupInfos)
            of
                Nothing ->
                    []

                Just group ->
                    [ div
                        [ class "text-center mb-1"
                        , style "font-size" ".8rem"
                        ]
                      <|
                        (text <| group.name)
                            :: (case message.duplicateIds of
                                    Nothing ->
                                        []

                                    Just duplicateIds ->
                                        if List.length duplicateIds > 0 then
                                            let
                                                lbl =
                                                    "+" ++ String.fromInt (List.length duplicateIds)
                                            in
                                            [ text " "
                                            , sup
                                                [ class "badge rounded-pill text-bg-light"
                                                ]
                                                [ text lbl ]
                                            ]

                                        else
                                            []
                               )
                    ]

        senderNameBlock =
            case message.sender of
                Nothing ->
                    []

                Just senderUuid ->
                    senderNameBlockNoInput senderUuid

        senderNameBlockNoInput _ =
            let
                emptyName =
                    "(невідомо)"

                profile =
                    message.sender
                        |> Maybe.andThen (\s -> Dict.get s vps.profiles)
                        |> MaybeX.join
                        |> Maybe.withDefault
                            { givenName = Just emptyName, familyName = Nothing }
            in
            [ div
                [ class "unknown-profile-name text-center mb-1"

                -- , onClick <| AddNameInput id_ senderUuid
                ]
                [ text <|
                    case ( profile.givenName, profile.familyName ) of
                        ( Nothing, Nothing ) ->
                            emptyName

                        _ ->
                            Maybe.withDefault "" profile.givenName
                                ++ " "
                                ++ Maybe.withDefault "" profile.familyName
                ]
            ]

        editedBlock =
            if renderPs.hideIndividualSave then
                []

            else
                let
                    show =
                        case Dict.get msgId model.edited of
                            Just _ ->
                                True

                            Nothing ->
                                False
                in
                [ div [ classList [ ( "opacity-0", not show ) ], class "flex flex-col gap-2" ]
                    [ button
                        [ type_ "button"
                        , class "btn btn-light btn-sm text-nowrap"
                        , onClick <| EditCancel msgId
                        , style "font-size" ".75rem"
                        ]
                        [ i [ class "bi bi-x-circle" ] []
                        ]
                    , button
                        [ type_ "button"
                        , class "btn btn-outline btn-primary btn-sm text-nowrap"
                        , style "font-size" ".75rem"
                        , onClick <| EditSave msgId
                        ]
                        [ i [ class "bi bi-check" ] []
                        ]
                    ]
                ]

        actionMenuBody =
            let
                updatedRouteString =
                    case vps.currentRoute of
                        Just x ->
                            insertShowMapToQuery (RerAnalysis.Utils.updateQueryWithSelectedFreq (message.freq |> def "") x)

                        Nothing ->
                            "/rer-analysis"
            in
            [ span []
                [ i [ class "bi me-1 bi-pin-map" ] []
                , button [ class "bg-transparent border-0", onClick (SelectFreqAndShowMap (message.freq |> def "")) ]
                    [ text "на мапі" ]
                ]
            , span []
                [ i [ class "bi me-1 bi-pin-map" ] []
                , a [ href updatedRouteString, target "_blank" ]
                    [ text "на мапі "
                    , sup []
                        [ i
                            [ class "bi bi-box-arrow-up-right"
                            ]
                            []
                        ]
                    ]
                ]
            ]

        dateInpBlock =
            [ div [ class "d-flex justify-content-center mb-1" ]
                [ div [ class "d-flex justify-content-center" ]
                    [ div [ class "me-2" ] [ i [ class "bi bi-calendar-event" ] [] ]
                    , input
                        [ type_ "text"
                        , class "text-center"
                        , style "width" "120px"
                        , value <| Maybe.withDefault "" message.date
                        , onInput <| InputDate msgId
                        ]
                        []
                    , div [ class "ms-1 opacity-0" ] [ i [ class "bi bi-calendar-event" ] [] ]
                    ]
                ]
            , div [ class "d-flex justify-content-center mb-1" ]
                [ div [ class "d-flex justify-content-center" ]
                    [ div [ class "me-2" ] [ i [ class "bi bi-clock" ] [] ]
                    , div []
                        [ input
                            [ type_ "text"
                            , class "text-center"
                            , style "width" "120px"
                            , value <| Maybe.withDefault "" message.time
                            , onInput <| InputTime msgId
                            ]
                            []
                        ]
                    , div [ class "ms-1 opacity-0" ] [ i [ class "bi bi-clock" ] [] ]
                    ]
                ]
            , div [ class "d-flex justify-content-center mb-1" ]
                [ div [ class "d-flex justify-content-center" ]
                    [ Le.Block.ActionMenu.actionMenu actionMenuBody "bi-broadcast text-danger"
                    , div []
                        [ input
                            [ type_ "text"
                            , class "text-center"
                            , style "width" "120px"
                            , value <| Maybe.withDefault "" message.freq
                            , onInput <| InputFreq msgId
                            ]
                            []
                        ]
                    , div
                        [ class "ms-1 opacity-0"
                        ]
                        [ i [ class "bi bi-broadcast" ] [] ]
                    ]
                ]
            , div [ class "d-flex justify-content-center mb-1" ]
                [ div [ class "d-flex justify-content-center" ]
                    [ div [ class "me-2" ] [ i [ class "bi bi-geo" ] [] ]
                    , div [] <|
                        input
                            [ type_ "text"
                            , class "text-center"
                            , style "width" "120px"
                            , value <| Maybe.withDefault "" message.coords
                            , onInput <| InputCoords msgId
                            , placeholder "коорд"
                            , isInvalidCls ("coordinates-" ++ String.fromInt msgId) formErrors
                            ]
                            []
                            :: fieldError ("coordinates-" ++ String.fromInt msgId) formErrors
                    , div [ class "ms-1 opacity-0" ] [ i [ class "bi bi-geo" ] [] ]
                    ]
                ]
            , div [ class "d-flex justify-content-center mb-1" ]
                [ div [ class "d-flex justify-content-center" ]
                    [ div [ class "me-2" ] [ i [ class "bi bi-binoculars" ] [] ]
                    , div [] <|
                        input
                            [ type_ "text"
                            , class "text-center"
                            , style "width" "120px"
                            , value <| Maybe.withDefault "" message.post
                            , onInput <| InputPost msgId
                            , placeholder "пост"
                            , isInvalidCls ("post-" ++ String.fromInt msgId) formErrors
                            ]
                            []
                            :: fieldError ("post-" ++ String.fromInt msgId) formErrors
                    , div [ class "ms-1 opacity-0" ] [ i [ class "bi bi-binoculars" ] [] ]
                    ]
                ]
            ]

        bookmarkBlock =
            let
                bookmarked =
                    Set.member msgId vps.bookmarks
            in
            div
                ([ style "font-size" "1rem"
                 , style "cursor" "pointer"
                 , title "додати в закладки"
                 , class "me-1"
                 ]
                    ++ (if bookmarked then
                            [ onClick <| BookmarkRemove msgId ]

                        else
                            [ onClick <| BookmarkAdd msgId
                            ]
                       )
                )
                [ i
                    [ class "bi"
                    , classList
                        [ ( "bi-bookmark", not bookmarked )
                        , ( "bi-bookmark-fill", bookmarked )
                        ]
                    ]
                    []
                ]

        importantBlock =
            let
                important =
                    Set.member msgId vps.importants
            in
            div
                ([ style "font-size" "1rem"
                 , style "cursor" "pointer"
                 , title "помітити як важливе"
                 , class "me-1"
                 ]
                    ++ (if important then
                            [ onClick <| ImportantRemove msgId ]

                        else
                            [ onClick <| ImportantAdd msgId
                            ]
                       )
                )
                [ i
                    [ class "bi"
                    , classList
                        [ ( "bi-exclamation-triangle", not important )
                        , ( "bi-exclamation-triangle-fill text-danger", important )
                        ]
                    ]
                    []
                ]

        deleteMessageBlock =
            if Le.Auth.hasRole "DeleteMsg" vps.user then
                div
                    [ style "font-size" "1rem"
                    , style "cursor" "pointer"
                    , title "видалити повідомлення"
                    , class "me-1"
                    , attribute "data-bs-toggle" "modal"
                    , attribute "data-bs-target" "#deleteMessageModal"
                    ]
                    [ i
                        [ class "bi bi-trash3 text-danger"
                        , onClick <| DeleteMessage msgId
                        ]
                        []
                    ]

            else
                text ""

        timeColumn =
            [ div [] <|
                div [ class "flex justify-start items-center" ]
                    [ bookmarkBlock
                    , importantBlock
                    , deleteMessageBlock
                    , div
                        [ class "text-center"
                        , style "font-size" ".8rem"
                        ]
                        [ text <|
                            case vps.zone of
                                Just zone ->
                                    Maybe.withDefault ""
                                        (Maybe.map
                                            (Le.Time.renderDateTimeF1 zone << Time.millisToPosix)
                                            message.timestamp
                                        )

                                Nothing ->
                                    ""
                        ]
                    ]
                    :: groupNameBlock
                    ++ senderNameBlock
                    ++ dateInpBlock
            ]

        messageColumn =
            let
                networkBlock =
                    case message.networkIds of
                        Just networkIds ->
                            div [] <|
                                for_ networkIds <|
                                    \networkId ->
                                        case Dict.get networkId vps.networks of
                                            Just network ->
                                                Le.Block.Unit.boldMasterUnit vps.masterUnits network

                                            _ ->
                                                text "Невідома мережа"

                        Nothing ->
                            text ""
            in
            [ div []
                [ div []
                    [ div [ class "" ]
                        [ input
                            [ type_ "text"
                            , class "w-100"
                            , style "padding-left" "5px"
                            , style "padding-top" "2px"
                            , style "padding-bottom" "2px"

                            -- , style "font-size" "1rem"
                            , value <| Maybe.withDefault "" message.unit
                            , onInput <| InputUnit msgId
                            , placeholder "підрозділ"
                            ]
                            []
                        , div [] [ networkBlock ]
                        ]
                    ]
                , div [ class "d-flex justify-content-between mt-2" ]
                    [ div [ class "flex-fill" ]
                        [ input
                            [ type_ "text"
                            , class " w-100"
                            , style "padding-left" "5px"
                            , style "padding-top" "2px"
                            , style "padding-bottom" "2px"

                            -- , style "font-size" "1rem"
                            , value <| Maybe.withDefault "" message.location
                            , onInput <| InputLocation msgId
                            , placeholder "локація"
                            ]
                            []
                        ]
                    ]
                , div [ class "mt-1" ] <|
                    List.map renderImage message.images
                , div
                    [ style "margin" "0 auto"
                    , style "font-size" "1rem"
                    ]
                  <|
                    case message.textMarked of
                        Just textMarked ->
                            Le.Block.MarkedText.new textMarked |> Le.Block.MarkedText.view Dict.empty Nothing [] Nothing

                        Nothing ->
                            msgToHtml message.text
                ]
            ]

        proposedCallsignBlock callsign =
            div
                [ class "d-flex justify-content-between text-uppercase mt-1"
                , style "font-size" ".7rem"
                ]
                [ div
                    [ class "flex-fill"
                    , onClick <| AddCallsignS msgId callsign
                    ]
                    [ span [ class "text-action cursor-pointer" ]
                        [ text callsign ]
                    ]
                , div [ class "ms-1" ]
                    [ i
                        [ class "bi bi-dash-circle text-danger"
                        , attribute "role" "button"
                        , style "opacity" "0"
                        ]
                        []
                    ]
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
            in
            [ div [] <|
                div [ class "flex justify-between" ]
                    [ div [ class "flex-fill" ]
                        [ input
                            [ type_ "text"
                            , class "text-center text-uppercase"
                            , style "width" "130px"
                            , value inpVal
                            , placeholder "позивний"
                            , onInput <| SetCallsignInput msgId
                            , onKeyDown (CallsignKeyDown msgId)
                            , id <| callsignInputId msgId
                            ]
                            []
                        ]
                    , div [ class "ms-1" ]
                        [ i
                            [ class "bi bi-plus-circle align-middle"
                            , classList [ ( "text-muted opacity-50", inpVal == "" ) ]
                            , classList [ ( "text-success", inpVal /= "" ) ]
                            , attribute "role" "button"
                            , onClick <| AddCallsign msgId
                            ]
                            []
                        ]
                    ]
                    :: List.map callsignBlock (enumerate message.callsigns)
                    ++ List.map proposedCallsignBlock callsignsProposed
            ]

        extendedFormColumn =
            [ div [ class "mb-2" ] <|
                [ div
                    [ class "flex justify-center mb-2"
                    ]
                  <|
                    [ tagsBlock message.tags (ToggleTag msgId) vps.tags
                    ]
                , textarea
                    [ class "form-control pt-2 rounded-0"
                    , style "font-size" ".9rem"
                    , placeholder "коментар"
                    , id <| idExtendedFormTextarea
                    , onInput (ExtendedFormChanged msgId)
                    , value <| Maybe.withDefault "" message.extendedForm
                    , style "min-height" "100px"
                    , spellcheck False
                    ]
                    []
                ]
            , HtmlX.viewIf (List.length otherCommentsBlock > 0)
                (div [ class "mb-2" ] otherCommentsBlock)
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
    div [ class "rer-message mb-4 relative" ]
        [ div
            [ class "flex  message"
            , id <| "message-" ++ String.fromInt msgId
            ]
            [ div
                [ style "min-width" (String.fromInt imgWidth ++ "px")
                ]
                timeColumn
            , div [ class "basis-[45%]" ] messageColumn
            , div [ class "text-center mx-1" ] callsignsColumn
            , div [ class "text-center mx-1 basis-[23%]" ] extendedFormColumn
            , div [ class "" ] editedBlock
            ]
        , Watermark.new vps.user.name |> Watermark.withPositioning ( 65, 75 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
        , Watermark.new vps.user.name |> Watermark.withPositioning ( 25, 30 ) |> Watermark.withFontSize "1.8rem" |> Watermark.view
        ]
