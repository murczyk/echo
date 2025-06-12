module Pages.RerNetworks.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Checkbox as Checkbox
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Json.Encode as Encode
import Layouts
import Le.Block.CallsignsPopup as CallsignsPopup exposing (PopupCallerOrigin(..))
import Le.Block.Select
import Le.Block.Spinner
import Le.Block.Toast
import Le.NetworksUtils as NetworksUtils
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Time
import Le.Types exposing (ApiError, GroupsActivityPerDayRsp, GroupsByDate)
import Le.Utils exposing (networkKindVHFMapping)
import List.Extra as ListX
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Select
import Set
import Shared
import Time
import Time.Extra
import View exposing (View)


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user shared route =
    Page.new
        { init = init route shared
        , update = update shared
        , subscriptions = subscriptions
        , view = view shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "rer"
        }



-- INIT


type Mode updateReq
    = Readonly
    | Editing updateReq


type alias CallsignResModified =
    { callsign : String
    , knownCallsigns : List B.KnownCallsignShortRes
    , messageCount : Int
    , lastDatetime : Maybe Int
    , freqs : Maybe (List String)
    , networkNames : Maybe (List String)
    , isOld : Bool
    , isReported : Bool
    }


type alias Model =
    { network : RemoteData ApiError B.Network
    , callsigns : RemoteData ApiError (List B.NetworkCallsignRes)
    , mapPoints : RemoteData ApiError (List B.NetworkPoint)
    , groupsActivity : RemoteData ApiError GroupsByDate
    , freqs : RemoteData ApiError (List B.NetworkFreqsRes)
    , freqsEditingState : Mode (Dict String B.UpdateNetworkFreqReq)
    , callsignsEditingState : Mode (Dict String Bool)
    , callsignsOpenedPopupId : Maybe String
    , formErrors : Dict String String
    , toasts : Le.Block.Toast.Model
    , networks : RemoteData ApiError (Dict Int B.Network)
    , mode : Mode B.UpdateNetworkReq
    , editKindSelect : Le.Block.Select.SelectTypeSingleNotEmpty NetworksUtils.NetworkKind
    , editPostsSelect : Le.Block.Select.SelectType Int
    , addConfirmationInp : String
    , addConfirmationFreqSelect : Le.Block.Select.SelectTypeSingle String
    , addSignsInp : String
    , signals : RemoteData ApiError (List B.NetworkSignalsRes)
    , descriptionsEditDict : Dict Int B.NetworkDescription
    }


init : Route { id : String } -> Shared.Model -> () -> ( Model, Effect Msg )
init route shared () =
    ( { network = Loading
      , callsigns = NotAsked
      , mapPoints = NotAsked
      , groupsActivity = NotAsked
      , freqs = NotAsked
      , freqsEditingState = Readonly
      , callsignsEditingState = Readonly
      , callsignsOpenedPopupId = Nothing
      , toasts = Le.Block.Toast.init
      , formErrors = Dict.empty
      , networks = NotAsked
      , mode = Readonly
      , editKindSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-kind-state")
            , items =
                NetworksUtils.networkKinds
                    |> List.map
                        (\kind ->
                            Select.basicMenuItem
                                { item = kind
                                , label = NetworksUtils.networkKindToLabel kind
                                }
                        )
            , selected = NetworksUtils.VHF
            }
      , editPostsSelect =
            { state = Select.initState (Select.selectIdentifier "edit-network-posts-state")
            , items = []
            , selected = []
            }
      , addConfirmationInp = ""
      , addConfirmationFreqSelect =
            { state = Select.initState (Select.selectIdentifier "add-confirmation-freq-state")
            , items = []
            , selected = Nothing
            }
      , addSignsInp = ""
      , signals = NotAsked
      , descriptionsEditDict = Dict.empty
      }
    , case String.toInt route.params.id of
        Just id ->
            E.getSingleNetwork NetworkReturnedByApi id

        Nothing ->
            E.none
    )



-- UPDATE


type Msg
    = ToastMsg Le.Block.Toast.Msg
    | CallsignsReturnedByApi (Result ApiError B.SingleNetworkCallsignsListRsp)
    | NetworkReturnedByApi (Result ApiError B.Network)
    | MapPointsReturnedByApi (Result ApiError B.ListNetworkPointsRsp)
    | GroupsActivityReturnedByApi (Result ApiError GroupsByDate)
    | FreqsReturnedByApi (Result ApiError B.SingleNetworkFreqsListRsp)
    | CallsignsPopupOpenedByUser String
    | CallsignsPopupClosedByUser
    | NetworksReturnedByApi (Result ApiError (List B.Network))
    | NetworkEditStartedByUser
    | NetworkEditingSavedByUser
    | NetworkEditingCanceledByUser
    | NetworkEditingMsg B.UpdateNetworkReq
    | FreqsEditingMsg B.UpdateNetworkFreqReq
    | FreqsEditStartedByUser
    | FreqsEditSavedByUser
    | FreqsEditCanceledByUser
    | CallsignsEditStartedByUser
    | CallsignsEditSavedByUser
    | CallsignsEditCanceledByUser
    | FreqUpdatedByApi (Result ApiError B.Network)
    | NetworkUpdatedByApi (Result ApiError B.Network)
    | NetworkPostsUpdatedByApi B.UpdateNetworkReq (Result ApiError B.Network)
    | EditNetworkKindSelMsg (Select.Msg NetworksUtils.NetworkKind)
    | NetworkEditPostsSelMsg (Select.Msg Int)
    | DescriptionAddClickedByUser Int B.NetworkDescrType
    | NetworkDescriptionAdded B.NetworkDescrType (Result ApiError B.Network)
    | ConfirmationInputChangedByUser String
    | SignsInputChangedByUser String
    | SignalsForNetworkLoaded (Result ApiError B.NetworkSignalsListRes)
    | DescriptionDeleteClickedByUser B.NetworkDescription
    | DescriptionEditClickedByUser B.NetworkDescription
    | DescriptionEditSave B.NetworkDescription
    | DescriptionEditUpdated Int (Result ApiError B.Network)
    | DescriptionEditedByUser Int String
    | DescriptionDeleted (Result ApiError B.Network)
    | AddConfirmationFreqSelMsg (Select.Msg String)
    | CallsignReportingStatusToggledByUser CallsignResModified Bool
    | CallsignReportingStatusUpdatedByApi (Result ApiError Bool)


update : Shared.Model -> Msg -> Model -> ( Model, Effect Msg )
update shared msg model =
    case msg of
        ToastMsg imsg ->
            let
                ( im, icmds ) =
                    Le.Block.Toast.update imsg model.toasts
            in
            ( { model | toasts = im }
            , E.sendCmd <| Cmd.map ToastMsg icmds
            )

        CallsignsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | callsigns = Failure e }

        CallsignsReturnedByApi (Ok res) ->
            ( { model | callsigns = Success res.callsigns }, E.none )

        NetworkReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | network = Failure e }

        NetworkReturnedByApi (Ok res) ->
            let
                kindSelect =
                    model.editKindSelect

                postsSelect =
                    model.editPostsSelect

                --kindSelect2 =
                --TODO{ kindSelect | selected = EUtils.networkKindFromString res.kind }
                postsSelect2 =
                    { postsSelect | selected = res.postIds }
            in
            ( { model
                | network = Success res
                , editKindSelect = kindSelect
                , editPostsSelect = postsSelect2
              }
            , E.batch
                [ E.getNetworkCallsigns CallsignsReturnedByApi { networkId = res.id }
                , E.getNetworkPoints MapPointsReturnedByApi
                    { networkId = res.id
                    , sinceDateInclusiveMs = res.activeFrom
                    , tillDateNoninclusiveMs = res.activeTo
                    }
                , E.getSingleNetworkGroupsActivity GroupsActivityReturnedByApi { networkId = res.id, tillDateNoninclusiveMs = Nothing }
                , E.getSingleNetworkFreqs FreqsReturnedByApi { networkId = res.id }
                , E.getNetworksList NetworksReturnedByApi
                    { sinceDateInclusiveMs = Just res.activeFrom
                    , tillDateNoninclusiveMs = res.activeTo
                    , filterFreq = Nothing
                    , filterUnit = Nothing
                    , sortBy = Nothing
                    }

                --TODO: do not load if loaded already
                , E.loadPostsFromShared { sortBy = Nothing }
                , E.getSignalsForNetwork SignalsForNetworkLoaded { networkId = res.id }
                ]
            )

        MapPointsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | mapPoints = Failure e }

        MapPointsReturnedByApi (Ok res) ->
            ( { model | mapPoints = Success res.points }, E.none )

        GroupsActivityReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | groupsActivity = Failure e }

        GroupsActivityReturnedByApi (Ok res) ->
            ( { model | groupsActivity = Success res }, E.none )

        FreqsReturnedByApi (Err e) ->
            Api.handleHttpError ToastMsg e { model | freqs = Failure e }

        FreqsReturnedByApi (Ok res) ->
            let
                callsigns =
                    List.filterMap .callsigns res.freqs
                        |> List.concat

                addConfirmationFreqSelect =
                    model.addConfirmationFreqSelect

                acfs2 =
                    { addConfirmationFreqSelect | items = List.map .freq res.freqs |> List.map (\freq -> Select.basicMenuItem { item = freq, label = freq }) }
            in
            ( { model | freqs = Success res.freqs, addConfirmationFreqSelect = acfs2 }, E.getCallsignsInfoShared callsigns )

        CallsignsPopupOpenedByUser freq ->
            ( { model | callsignsOpenedPopupId = Just freq }, E.none )

        CallsignsPopupClosedByUser ->
            ( { model | callsignsOpenedPopupId = Nothing }, E.none )

        NetworksReturnedByApi (Err err) ->
            ( model, E.none )

        NetworksReturnedByApi (Ok networks) ->
            ( { model
                | networks =
                    Success
                        (networks
                            |> List.map (\x -> ( x.id, x ))
                            |> Dict.fromList
                        )
              }
            , E.none
            )

        NetworkEditStartedByUser ->
            case model.network of
                Success network ->
                    ( { model
                        | mode =
                            Editing
                                { id = network.id
                                , name = network.name
                                , location = network.location
                                , comment = network.comment
                                , radioStation = network.radioStation
                                , purpose = network.purpose
                                , operationMode = network.operationMode
                                , operationType = network.operationType
                                , operationPeriod = network.operationPeriod
                                , activeFrom = network.activeFrom
                                , activeTo = network.activeTo
                                , descriptions = Nothing --TODO
                                , restoreNetwork = Nothing
                                }
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        NetworkEditingSavedByUser ->
            case model.mode of
                Editing edit ->
                    ( model, E.updateNetworkPosts (NetworkPostsUpdatedByApi edit) { networkId = edit.id, postIds = model.editPostsSelect.selected } )

                Readonly ->
                    ( model, E.none )

        NetworkEditingCanceledByUser ->
            ( { model | mode = Readonly }, E.none )

        NetworkEditingMsg updNetworkReq ->
            ( { model
                | mode =
                    case model.mode of
                        Editing _ ->
                            Editing updNetworkReq

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        NetworkPostsUpdatedByApi _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkPostsUpdatedByApi editState (Ok _) ->
            ( model, E.updateNetwork NetworkUpdatedByApi editState )

        NetworkUpdatedByApi (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkUpdatedByApi (Ok network) ->
            ( { model | network = Success network, mode = Readonly }, E.none )

        EditNetworkKindSelMsg imsg ->
            case model.mode of
                Editing updNetworkReq ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editKindSelect.state

                        updatedNetworkKind =
                            Le.Block.Select.singleUpdWithDefault mAct model.editKindSelect.selected

                        kindSelect =
                            model.editKindSelect

                        kindSelect2 =
                            { kindSelect
                                | state = imodel
                                , selected = updatedNetworkKind
                            }
                    in
                    ( { model
                        | editKindSelect = kindSelect2
                        , mode = Editing updNetworkReq --{ updNetworkReq | kind = EUtils.networkKindToString updatedNetworkKind }
                      }
                    , E.sendCmd <|
                        Cmd.map
                            EditNetworkKindSelMsg
                            icmd
                    )

                _ ->
                    ( model
                    , E.none
                    )

        NetworkEditPostsSelMsg imsg ->
            case model.mode of
                Editing editNetworkState ->
                    let
                        ( mAct, imodel, icmd ) =
                            Select.update imsg model.editPostsSelect.state

                        updatedNetworkPosts =
                            Le.Block.Select.multiUpdI mAct model.editPostsSelect.selected

                        postsSelect =
                            model.editPostsSelect

                        --TODO: remove this hack
                        items =
                            case ( postsSelect.items, shared.posts ) of
                                ( [], Success posts ) ->
                                    if List.length (Dict.toList posts) > 0 then
                                        List.map (\post -> Select.basicMenuItem { item = post.id, label = post.name }) (Dict.values posts)

                                    else
                                        postsSelect.items

                                _ ->
                                    postsSelect.items

                        postsSelect2 =
                            { postsSelect
                                | state = imodel
                                , selected = updatedNetworkPosts
                                , items = items
                            }

                        network =
                            model.network

                        n2 =
                            case network of
                                Success n ->
                                    Success { n | postIds = updatedNetworkPosts }

                                _ ->
                                    network
                    in
                    ( { model
                        | editPostsSelect = postsSelect2
                        , mode = Editing editNetworkState
                        , network = n2
                      }
                    , E.sendCmd <|
                        Cmd.map
                            NetworkEditPostsSelMsg
                            icmd
                    )

                _ ->
                    ( model, E.none )

        DescriptionAddClickedByUser networkId descType ->
            let
                desc =
                    case ( descType, model.addConfirmationFreqSelect.selected ) of
                        ( B.Confirmation, Just freq ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                []
                            , frequencyDescriptions =
                                [ { descrType = B.Confirmation
                                  , description = model.addConfirmationInp
                                  , freq = freq
                                  }
                                ]
                            }

                        ( B.Confirmation, Nothing ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                [ { descrType = B.Confirmation
                                  , description = model.addConfirmationInp
                                  }
                                ]
                            , frequencyDescriptions =
                                []
                            }

                        ( B.Sign, _ ) ->
                            { networkId = networkId
                            , networkDescriptions =
                                [ { descrType = B.Sign
                                  , description = model.addSignsInp
                                  }
                                ]
                            , frequencyDescriptions =
                                []
                            }
            in
            ( model
            , E.networkAddDescription (NetworkDescriptionAdded descType) desc
            )

        NetworkDescriptionAdded _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        NetworkDescriptionAdded descType (Ok network) ->
            let
                m1 =
                    { model
                        | addConfirmationInp =
                            case descType of
                                B.Confirmation ->
                                    ""

                                B.Sign ->
                                    model.addConfirmationInp
                        , addSignsInp =
                            case descType of
                                B.Confirmation ->
                                    model.addSignsInp

                                B.Sign ->
                                    ""
                    }
            in
            ( { m1 | network = Success network }, E.none )

        ConfirmationInputChangedByUser inp ->
            ( { model | addConfirmationInp = inp }, E.none )

        SignsInputChangedByUser inp ->
            ( { model | addSignsInp = inp }, E.none )

        SignalsForNetworkLoaded (Err e) ->
            Api.handleHttpError ToastMsg e model

        SignalsForNetworkLoaded (Ok res) ->
            ( { model | signals = Success res.signals }, E.none )

        DescriptionDeleteClickedByUser description ->
            ( model, E.networkDeleteDescription DescriptionDeleted { descriptionId = description.id, networkId = description.networkId } )

        DescriptionEditClickedByUser description ->
            ( { model | descriptionsEditDict = Dict.insert description.id description model.descriptionsEditDict }, E.none )

        DescriptionEditedByUser descId newDescription ->
            let
                descEditDict =
                    case Dict.get descId model.descriptionsEditDict of
                        Just d ->
                            Dict.update descId (\_ -> Just { d | description = newDescription }) model.descriptionsEditDict

                        Nothing ->
                            model.descriptionsEditDict
            in
            ( { model | descriptionsEditDict = descEditDict }, E.none )

        DescriptionEditSave description ->
            ( model
            , E.networkUpdateDescription (DescriptionEditUpdated description.id)
                { networkId = description.networkId
                , descriptionId = description.id
                , descrType = description.descrType
                , description = description.description
                , networkFreqId = Nothing --TOOD
                }
            )

        DescriptionEditUpdated _ (Err e) ->
            Api.handleHttpError ToastMsg e model

        DescriptionEditUpdated descrId (Ok res) ->
            ( { model | network = Success res, descriptionsEditDict = Dict.remove descrId model.descriptionsEditDict }, E.none )

        DescriptionDeleted (Err e) ->
            Api.handleHttpError ToastMsg e model

        DescriptionDeleted (Ok res) ->
            ( { model | network = Success res }, E.none )

        AddConfirmationFreqSelMsg imsg ->
            let
                ( mAct, imodel, icmd ) =
                    Select.update imsg model.addConfirmationFreqSelect.state

                updatedFreq =
                    Le.Block.Select.singleUpd mAct model.addConfirmationFreqSelect.selected

                freqsSelect =
                    model.addConfirmationFreqSelect

                freqsSelect2 =
                    { freqsSelect
                        | state = imodel
                        , selected = updatedFreq
                    }
            in
            ( { model
                | addConfirmationFreqSelect = freqsSelect2
              }
            , E.sendCmd <|
                Cmd.map
                    AddConfirmationFreqSelMsg
                    icmd
            )

        FreqsEditStartedByUser ->
            case model.network of
                Success network ->
                    let
                        editFreqsDict =
                            List.map
                                (\f ->
                                    ( f.freq
                                    , { networkId = network.id
                                      , freq = f.freq
                                      , kind = f.kind
                                      , modulationId = f.modulationId
                                      , activeFrom = f.activeFrom
                                      , activeTo = f.activeTo
                                      }
                                    )
                                )
                                network.freqs
                                |> Dict.fromList
                    in
                    ( { model
                        | freqsEditingState =
                            Editing editFreqsDict
                      }
                    , E.none
                    )

                _ ->
                    ( model, E.none )

        FreqsEditSavedByUser ->
            let
                compareTwoFreqs : B.UpdateNetworkFreqReq -> B.NetworkFreq -> Bool
                compareTwoFreqs f1 f2 =
                    f1.freq
                        == f2.freq
                        && f1.modulationId
                        == f2.modulationId
                        && f1.kind
                        == f2.kind
                        && f1.networkId
                        == f2.networkId
                        && f1.activeFrom
                        == f2.activeFrom
                        && f1.activeTo
                        == f2.activeTo

                ( m1, eff1 ) =
                    case model.freqsEditingState of
                        Editing editingDict ->
                            let
                                effects =
                                    Dict.toList editingDict
                                        |> List.map Tuple.second
                                        |> List.filterMap
                                            (\updateFreqReq ->
                                                case model.network of
                                                    Success network ->
                                                        ListX.find (\f -> f.freq == updateFreqReq.freq) network.freqs
                                                            |> Maybe.andThen
                                                                (\f1 ->
                                                                    if compareTwoFreqs updateFreqReq f1 then
                                                                        Nothing

                                                                    else
                                                                        Just updateFreqReq
                                                                )

                                                    _ ->
                                                        Nothing
                                            )
                                        |> List.map (\updateFreqReq -> E.updateNetworkFreq FreqUpdatedByApi updateFreqReq)
                            in
                            ( { model
                                | freqsEditingState =
                                    if List.length effects > 0 then
                                        model.freqsEditingState

                                    else
                                        Readonly
                              }
                            , E.batch effects
                            )

                        Readonly ->
                            ( model, E.none )
            in
            ( m1
            , eff1
            )

        FreqsEditCanceledByUser ->
            ( { model | freqsEditingState = Readonly }, E.none )

        FreqsEditingMsg updFreqState ->
            ( { model
                | freqsEditingState =
                    case model.freqsEditingState of
                        Editing editingFreqsDict ->
                            Editing (Dict.insert updFreqState.freq updFreqState editingFreqsDict)

                        Readonly ->
                            Readonly
              }
            , E.none
            )

        FreqUpdatedByApi (Err e) ->
            Api.handleHttpError ToastMsg e model

        FreqUpdatedByApi (Ok network) ->
            ( { model | network = Success network, freqsEditingState = Readonly }, E.none )

        CallsignReportingStatusToggledByUser callsign isChecked ->
            ( { model
                | callsignsEditingState =
                    case model.callsignsEditingState of
                        Readonly ->
                            model.callsignsEditingState

                        Editing editingDict ->
                            Editing (Dict.insert callsign.callsign isChecked editingDict)
              }
            , E.none
            )

        CallsignReportingStatusUpdatedByApi (Err e) ->
            Api.handleHttpError ToastMsg e model

        CallsignReportingStatusUpdatedByApi (Ok res) ->
            ( { model | callsignsEditingState = Readonly }, E.none )

        CallsignsEditStartedByUser ->
            ( { model | callsignsEditingState = Editing Dict.empty }, E.none )

        CallsignsEditSavedByUser ->
            case ( model.network, model.callsignsEditingState ) of
                ( Success network, Editing editingDict ) ->
                    ( model
                    , E.updateCallsignReportingBatch CallsignReportingStatusUpdatedByApi
                        { networkId = network.id
                        , items =
                            Dict.toList editingDict
                                |> List.map (\( callsign, isReported ) -> { callsign = callsign, isReported = isReported, deleted = False })
                        }
                    )

                _ ->
                    ( model, E.none )

        CallsignsEditCanceledByUser ->
            ( { model | callsignsEditingState = Readonly }, E.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


mainInfoBlock : B.Network -> Shared.Model -> Model -> List (Html Msg)
mainInfoBlock network shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        , i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick NetworkEditStartedByUser ] []
        ]
    , div
        [ class "network-list-container" ]
        [ div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%]" ] [ text "Район функціонування/розгортання:" ]
            , span [] [ text network.location ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium  basis-[33%]" ] [ text "Призначення:" ]
            , span [] [ text <| Maybe.withDefault "" network.purpose ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Склад кореспондентів:" ]
            , span [] [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex h-[52px]! " ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Вид передачі:" ]
            , span []
                [ List.map (\freqObj -> freqObj.kind) network.freqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Режим роботи радіомережі:" ]
            , span [] [ text <| Maybe.withDefault "" network.operationMode ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Характер роботи:" ]
            , span [] [ text <| Maybe.withDefault "" network.operationType ]
            ]
        , div [ class "border-y-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Період функціонування:" ]
            , span [] [ text <| Maybe.withDefault "" network.operationPeriod ]
            ]
        ]
    , div [ class "mt-[8px]" ]
        [ h5 [] [ text "Додаткове" ]
        , div [ class "grid grid-cols-12 gap-[16px]" ]
            [ div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
                , div []
                    [ text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix network.activeFrom)
                    ]
                ]
            , div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
                , div []
                    [ case network.activeTo of
                        Just millis ->
                            Le.Time.renderDateF6 shared.timeZone
                                (Time.millisToPosix millis)
                                |> text

                        Nothing ->
                            text ""
                    ]
                ]
            , div [ class "col-span-8" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Пости:" ]
                , div [ class "" ]
                    [ case shared.posts of
                        Success posts ->
                            List.map (\postId -> Dict.get postId posts) network.postIds
                                |> List.filterMap identity
                                |> List.map .name
                                |> String.join ", "
                                |> text

                        _ ->
                            text ""
                    ]
                ]
            ]
        ]
    ]


mainInfoEditBlock : B.UpdateNetworkReq -> List B.NetworkFreq -> Shared.Model -> Model -> List (Html Msg)
mainInfoEditBlock updNetworkReq networkFreqs shared model =
    [ div [ class "mb-[8px] flex justify-between items-center" ]
        [ h5 []
            [ text "Згідно форми" ]
        , div [ class "flex gap-[8px]" ]
            [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick NetworkEditingCanceledByUser ] []
            , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick NetworkEditingSavedByUser ] []
            ]
        ]
    , div
        [ class "network-list-container" ]
        [ div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%]" ] [ text "Район функціонування/розгортання:" ]
            , input
                [ value <| updNetworkReq.location
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | location = v })
                , class "form__field"
                , placeholder "введіть район функціонування/розгортання"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium  basis-[33%]" ] [ text "Призначення:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.purpose
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | purpose = Just v })
                , class "form__field"
                , placeholder "введіть призначення"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Склад кореспондентів:" ]
            , span [] [ RD.withDefault [] model.callsigns |> List.length |> String.fromInt |> text ]
            ]
        , div [ class "border-t-1 border-border py-[8px] flex h-[52px]! " ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Вид передачі:" ]
            , span []
                [ List.map (\freqObj -> freqObj.kind) networkFreqs
                    |> List.map NetworksUtils.networkStringToLabel
                    |> Set.fromList
                    |> Set.toList
                    |> String.join ", "
                    |> text
                ]

            -- , let
            --     selectedItem =
            --         (\item ->
            --             Select.basicMenuItem
            --                 { item = item
            --                 , label =
            --                     EUtils.networkKindToLabel item
            --                 }
            --         )
            --             model.editKindSelect.selected
            --     defaultOptions =
            --         Le.Block.Select.defaultOptions shared.isDarkMode
            --     do2 =
            --         { defaultOptions | clearable = False }
            --   in
            --   Html.map EditNetworkKindSelMsg <|
            --     Styled.toUnstyled <|
            --         Le.Block.Select.renderSelectSingle
            --             (Just selectedItem)
            --             model.editKindSelect.state
            --             model.editKindSelect.items
            --             "жоден"
            --             do2
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Режим роботи радіомережі:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.operationMode
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationMode = Just v })
                , class "form__field"
                , placeholder "введіть режим роботи радіомережі"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Характер роботи:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.operationType
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationType = Just v })
                , class "form__field"
                , placeholder "введіть хараткет роботи"
                ]
                []
            ]
        , div [ class "border-t-1 border-border py-[8px] flex" ]
            [ span [ class "text-[13px] font-medium basis-[33%] " ] [ text "Період функціонування:" ]
            , input
                [ value <| Maybe.withDefault "" updNetworkReq.operationPeriod
                , onInput <| NetworkEditingMsg << (\v -> { updNetworkReq | operationPeriod = Just v })
                , class "form__field"
                , placeholder "введіть період функціонування"
                ]
                []
            ]
        ]
    , div [ class "mt-[8px]" ]
        [ h5 [] [ text "Додаткове" ]
        , div [ class "grid grid-cols-12 gap-[16px]" ]
            [ div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна з:" ]
                , input
                    [ type_ "date"
                    , class "form-control"
                    , Time.millisToPosix updNetworkReq.activeFrom
                        |> Le.Time.renderDateF4 shared.timeZone
                        |> value
                    , onInput <|
                        NetworkEditingMsg
                            << (\v ->
                                    { updNetworkReq
                                        | activeFrom =
                                            case Le.Time.parseDateParts v of
                                                Err _ ->
                                                    updNetworkReq.activeFrom

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                    }
                               )
                    ]
                    []
                ]
            , div [ class "col-span-2" ]
                [ span [ class "text-[13px] font-medium" ] [ text "Активна по:" ]
                , input
                    [ type_ "date"
                    , class "form-control"
                    , case updNetworkReq.activeTo of
                        Just millis ->
                            value <| Le.Time.renderDateF4 shared.timeZone <| Time.millisToPosix millis

                        Nothing ->
                            value ""
                    , onInput <|
                        NetworkEditingMsg
                            << (\v ->
                                    { updNetworkReq
                                        | activeTo =
                                            case Le.Time.parseDateParts v of
                                                Err _ ->
                                                    updNetworkReq.activeTo

                                                Ok parts ->
                                                    Time.Extra.partsToPosix shared.timeZone parts
                                                        |> Time.posixToMillis
                                                        |> Just
                                    }
                               )
                    ]
                    []
                ]
            , div [ class "col-span-8" ]
                [ label [ class "text-[13px] font-medium" ] [ text "Пости:" ]
                , let
                    selectedItems =
                        List.map
                            (\postId ->
                                Select.basicMenuItem
                                    { item = postId
                                    , label =
                                        RD.withDefault Dict.empty shared.posts
                                            |> Dict.get postId
                                            |> Maybe.map .name
                                            |> Maybe.withDefault ""
                                    }
                            )
                            model.editPostsSelect.selected

                    defaultOptions =
                        Le.Block.Select.defaultOptions shared.isDarkMode

                    do2 =
                        { defaultOptions | clearable = False }
                  in
                  Html.map NetworkEditPostsSelMsg <|
                    Styled.toUnstyled <|
                        Le.Block.Select.renderSelect
                            selectedItems
                            model.editPostsSelect.state
                            model.editPostsSelect.items
                            "жоден"
                            do2
                ]
            ]
        ]
    ]


freqsTable : B.NetworkFreqsRes -> Model -> Shared.Model -> Html Msg
freqsTable freq model shared =
    tr [ class "" ]
        [ td [] [ text freq.freq ]
        , td [] [ text <| Maybe.withDefault "" freq.modulation ]
        , td [] [ text <| String.fromInt freq.messageCount ]
        , case freq.callsigns of
            Just callsigns ->
                let
                    isOpen =
                        case model.callsignsOpenedPopupId of
                            Just openCallsignsPopup ->
                                openCallsignsPopup == freq.freq

                            Nothing ->
                                False
                in
                CallsignsPopup.view
                    { isOpened = isOpen
                    , onClose = CallsignsPopupClosedByUser
                    , onOpen = CallsignsPopupOpenedByUser freq.freq
                    , callsigns = callsigns
                    , callsignsInfo = shared.callsignsInfo
                    , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                    }
                    (FreqsPage
                        freq.freq
                        (RD.withDefault Dict.empty model.networks)
                    )

            _ ->
                text ""
        , td []
            [ case freq.lastDatetime of
                Just lastDatetime ->
                    text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix lastDatetime)

                Nothing ->
                    text ""
            ]
        , td []
            [ text <|
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix freq.createdAt)
            ]
        , td []
            [ text <|
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix freq.activeFrom)
            ]
        , td []
            [ case freq.activeTo of
                Just x ->
                    text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix x)

                Nothing ->
                    text ""
            ]
        ]


freqsTableEditing : B.UpdateNetworkFreqReq -> B.NetworkFreqsRes -> Model -> Shared.Model -> Html Msg
freqsTableEditing updateFreqReq freq model shared =
    tr [ class "" ]
        [ td [] [ text freq.freq ]
        , td [] [ text <| Maybe.withDefault "" freq.modulation ]
        , td [] [ text <| String.fromInt freq.messageCount ]
        , case freq.callsigns of
            Just callsigns ->
                let
                    isOpen =
                        case model.callsignsOpenedPopupId of
                            Just openCallsignsPopup ->
                                openCallsignsPopup == freq.freq

                            Nothing ->
                                False
                in
                CallsignsPopup.view
                    { isOpened = isOpen
                    , onClose = CallsignsPopupClosedByUser
                    , onOpen = CallsignsPopupOpenedByUser freq.freq
                    , callsigns = callsigns
                    , callsignsInfo = shared.callsignsInfo
                    , masterUnits = RD.withDefault Dict.empty shared.masterUnits
                    }
                    (FreqsPage
                        freq.freq
                        (RD.withDefault Dict.empty model.networks)
                    )

            _ ->
                text ""
        , td []
            [ case freq.lastDatetime of
                Just lastDatetime ->
                    text <|
                        Le.Time.renderDateF6 shared.timeZone
                            (Time.millisToPosix lastDatetime)

                Nothing ->
                    text ""
            ]
        , td []
            [ text <|
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix freq.createdAt)
            ]
        , td []
            [ input
                [ type_ "date"
                , Time.millisToPosix updateFreqReq.activeFrom
                    |> Le.Time.renderDateF4 shared.timeZone
                    |> value
                , onInput <|
                    FreqsEditingMsg
                        << (\v ->
                                { updateFreqReq
                                    | activeFrom =
                                        case Le.Time.parseDateParts v of
                                            Err _ ->
                                                updateFreqReq.activeFrom

                                            Ok parts ->
                                                Time.Extra.partsToPosix shared.timeZone parts
                                                    |> Time.posixToMillis
                                }
                           )
                , class "form-control"
                ]
                []
            ]
        , td []
            [ input
                [ type_ "date"
                , Maybe.map Time.millisToPosix updateFreqReq.activeTo
                    |> Maybe.map (Le.Time.renderDateF4 shared.timeZone)
                    |> Maybe.withDefault ""
                    |> value
                , onInput <|
                    FreqsEditingMsg
                        << (\v ->
                                { updateFreqReq
                                    | activeTo =
                                        case Le.Time.parseDateParts v of
                                            Err _ ->
                                                updateFreqReq.activeTo

                                            Ok parts ->
                                                Time.Extra.partsToPosix shared.timeZone parts
                                                    |> Time.posixToMillis
                                                    |> Just
                                }
                           )
                , class "form-control"
                ]
                []
            ]
        ]


contentBlock : Shared.Model -> B.Network -> Model -> List (Html Msg)
contentBlock shared network model =
    [ h2 []
        [ NetworksUtils.renderNetworkNameWithoutType network (RD.withDefault Dict.empty shared.masterUnits)
        ]
    , div [ class "grid grid-cols-12 gap-[30px]" ]
        [ div [ class "col-span-7 grid  gap-[30px]", style "grid-template-rows" "520px 370px" ]
            [ div [ class "col-span-8 bg-w dark:bg-[#1C1C21] p-[16px]" ]
                (case model.mode of
                    Readonly ->
                        mainInfoBlock network shared model

                    Editing eNetwork ->
                        mainInfoEditBlock eNetwork network.freqs shared model
                )
            , div [ class "col-start-1 col-end-9 row-start-2 bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
                [ h4 [] [ text "Пеленги" ]
                , let
                    mapPoints =
                        case model.mapPoints of
                            Success points ->
                                points

                            _ ->
                                []
                  in
                  if List.length mapPoints > 0 then
                    Html.node "small-map"
                        [ property "points" (Encode.list B.networkPointEncoder mapPoints)
                        , class "grow-1"
                        , property "withExitButton" (Encode.bool False)
                        ]
                        []

                  else
                    div [ class "grow-1 flex justify-center items-center" ] [ text "Пеленги відсутні" ]
                ]
            ]
        , let
            ( confirmations, signs ) =
                List.partition (\description -> description.descrType == B.Confirmation) network.descriptions
          in
          div [ class "col-span-5 bg-w dark:bg-[#1C1C21] p-[16px]" ]
            [ div [ class "mb-[16px]" ]
                [ h5 [ class "" ] [ text "Обґрунтування прив’язки" ]
                , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
                    [ textarea [ class "textarea__field", placeholder "Введіть обґрунтування прив'язки", value model.addConfirmationInp, onInput ConfirmationInputChangedByUser ] []
                    , div [ class "flex justify-between w-full" ]
                        [ div [ class "w-[200px]" ]
                            [ let
                                selectedItem =
                                    Maybe.map
                                        (\freq ->
                                            Select.basicMenuItem
                                                { item = freq
                                                , label = freq
                                                }
                                        )
                                        model.addConfirmationFreqSelect.selected

                                defaultOptions =
                                    Le.Block.Select.defaultOptions shared.isDarkMode
                              in
                              Html.map AddConfirmationFreqSelMsg <|
                                Styled.toUnstyled <|
                                    Le.Block.Select.renderSelectSingle
                                        selectedItem
                                        model.addConfirmationFreqSelect.state
                                        model.addConfirmationFreqSelect.items
                                        "виберіть частоту"
                                        defaultOptions
                            ]
                        , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Confirmation } |> Button.withOutlined True |> Button.view
                        ]
                    ]
                , div [ class "max-h-[200px] overflow-y-auto" ]
                    (List.map
                        (\description ->
                            div [ class "min-h-[50px] border-b-1 border-border py-[4px]" ]
                                [ div [ class "flex justify-between items-center " ]
                                    [ div [ class "opacity-70 flex gap-[4px] items-center" ]
                                        [ span [] [ text description.login ]
                                        , span [] [ text "|" ]
                                        , span [ class "text-[13px]" ] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
                                        , span [ class "text-[13px]" ]
                                            [ description.networkFrequencyId
                                                |> Maybe.andThen
                                                    (\freqId ->
                                                        ListX.find (\freq -> freq.id == freqId) network.freqs
                                                    )
                                                |> Maybe.map .freq
                                                |> (\mFreq ->
                                                        case mFreq of
                                                            Just f ->
                                                                text ("| " ++ f)

                                                            Nothing ->
                                                                text ""
                                                   )
                                            ]
                                        ]
                                    , div [ class "flex gap-[8px]" ]
                                        [ case Dict.get description.id model.descriptionsEditDict of
                                            Just desc ->
                                                i [ class "bi bi-check2 cursor-pointer", onClick <| DescriptionEditSave desc ] []

                                            Nothing ->
                                                i [ class "bi bi-pencil cursor-pointer", onClick <| DescriptionEditClickedByUser description ] []
                                        , i [ class "bi bi-trash cursor-pointer", onClick <| DescriptionDeleteClickedByUser description ] []
                                        ]
                                    ]
                                , div []
                                    [ case Dict.get description.id model.descriptionsEditDict of
                                        Just desc ->
                                            textarea
                                                [ class "textarea__field"
                                                , placeholder "Введіть обґрунтування прив'язки"
                                                , value desc.description
                                                , onInput <| DescriptionEditedByUser desc.id
                                                ]
                                                []

                                        Nothing ->
                                            text description.description
                                    ]
                                ]
                        )
                        (List.sortWith
                            (\a b ->
                                if a.createdAt > b.createdAt then
                                    LT

                                else
                                    GT
                            )
                            confirmations
                        )
                    )
                ]
            , div []
                [ h5 [ class "" ] [ text "Розвідувальні ознаки" ]
                , div [ class "py-[4px] mb-[8px] flex flex-col items-end gap-[4px]" ]
                    [ textarea [ class "textarea__field", placeholder "Введіть розвідувальні ознаки", value model.addSignsInp, onInput SignsInputChangedByUser ] []
                    , Button.new { label = "Зберегти", onClick = DescriptionAddClickedByUser network.id B.Sign } |> Button.withOutlined True |> Button.view
                    ]
                , div [ class "max-h-[200px] overflow-y-auto" ]
                    (List.map
                        (\description ->
                            div [ class "min-h-[50px] border-b-1 border-border py-[4px]" ]
                                [ div [ class "flex justify-between items-center " ]
                                    [ div [ class "opacity-70 flex gap-[4px] items-center" ]
                                        [ span [] [ text description.login ]
                                        , span [] [ text "|" ]
                                        , span [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix description.createdAt) ]
                                        ]
                                    , div [ class "flex gap-[8px]" ]
                                        [ i [ class "bi bi-pencil cursor-pointer" ] []
                                        , i [ class "bi bi-trash cursor-pointer", onClick <| DescriptionDeleteClickedByUser description ] []
                                        ]
                                    ]
                                , div []
                                    [ text description.description
                                    ]
                                ]
                        )
                        (List.sortWith
                            (\a b ->
                                if a.createdAt > b.createdAt then
                                    LT

                                else
                                    GT
                            )
                            signs
                        )
                    )
                , section [ class "mt-[8px]" ]
                    [ h5 [] [ text "Сигнали" ]
                    , div [ class "h-[100px] overflow-y-auto" ]
                        (List.map
                            (\signalsForUnit ->
                                if List.length signalsForUnit.signals > 0 then
                                    div []
                                        [ div []
                                            [ span [ class "font-medium" ] [ text signalsForUnit.unitName ]
                                            , div [ class "grid grid-cols-2 gap-[8px]" ] (List.map (\s -> div [ class "" ] [ span [ class "w-[50px] mr-[8px]" ] [ text s.text ], span [] [ text <| Maybe.withDefault "" s.meaning ] ]) signalsForUnit.signals)
                                            ]
                                        ]

                                else
                                    text "Відсутні прив'язані до підрозділів сигнали"
                            )
                            (RD.withDefault [] model.signals)
                        )
                    ]
                ]
            ]
        ]
    , section [ class "bg-w dark:bg-[#1C1C21] p-[16px] mt-[30px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Частоти" ]
            , case model.freqsEditingState of
                Readonly ->
                    i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick FreqsEditStartedByUser ] []

                Editing _ ->
                    div [ class "flex gap-[8px]" ]
                        [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick FreqsEditCanceledByUser ] []
                        , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick FreqsEditSavedByUser ] []
                        ]
            ]
        , case model.freqs of
            Success freqs ->
                div [ class "overflow-y-auto grow-1" ]
                    [ table [ class "table-fixed w-full" ]
                        [ thead [ class "text-[13px]/[110%] font-medium" ]
                            [ tr [ class "" ]
                                [ th [] [ text "Частота" ]
                                , th [] [ text "Модуляція" ]
                                , th [] [ text "Кількість перехоплень" ]
                                , th [] [ text "Позивні" ]
                                , th [] [ text "Останній раз в етері" ]
                                , th [] [ text "Дата прив'язки" ]
                                , th [] [ text "Активна з" ]
                                , th [] [ text "Активна по" ]
                                ]
                            ]
                        , tbody []
                            (List.map
                                (\freq ->
                                    case model.freqsEditingState of
                                        Readonly ->
                                            freqsTable freq model shared

                                        Editing updateFreqsDict ->
                                            case Dict.get freq.freq updateFreqsDict of
                                                Just updateFreqReq ->
                                                    freqsTableEditing updateFreqReq freq model shared

                                                Nothing ->
                                                    freqsTable freq model shared
                                )
                                freqs
                            )
                        ]
                    ]

            _ ->
                Le.Block.Spinner.loadingSpinnerSm
        ]
    , section [ class "bg-w dark:bg-[#1C1C21] w-full h-[500px] mt-[30px] p-[16px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [ class "" ] [ text "Позивні" ]
            , case model.callsignsEditingState of
                Readonly ->
                    i [ class "bi bi-pencil-square text-action cursor-pointer text-[20px]", onClick CallsignsEditStartedByUser ] []

                Editing _ ->
                    div [ class "flex gap-[8px]" ]
                        [ i [ class "bi bi-x-square text-action cursor-pointer text-[20px]", onClick CallsignsEditCanceledByUser ] []
                        , i [ class "bi bi-check-square text-action cursor-pointer text-[20px]", onClick CallsignsEditSavedByUser ] []
                        ]
            ]
        , case model.callsigns of
            Success callsigns ->
                div [ class "overflow-y-auto  grow-1" ]
                    [ let
                        renderCallsignMainRow :
                            CallsignResModified
                            -> List (Html Msg)
                        renderCallsignMainRow callsign =
                            let
                                rowCount =
                                    List.length callsign.knownCallsigns
                            in
                            case callsign.knownCallsigns of
                                x :: xs ->
                                    tr [ class "" ]
                                        [ td [ rowspan rowCount ] [ text <| String.toUpper callsign.callsign ]
                                        , td [ rowspan rowCount ] [ text <| String.fromInt callsign.messageCount ]
                                        , td [ rowspan rowCount ]
                                            [ case callsign.lastDatetime of
                                                Just lastDatetime ->
                                                    text <|
                                                        Le.Time.renderDateF6 shared.timeZone
                                                            (Time.millisToPosix lastDatetime)

                                                Nothing ->
                                                    text ""
                                            ]
                                        , td [ rowspan rowCount ]
                                            [ --Toggle.new { onToggle = CallsignReportingStatusToggledByUser callsign, label = "" }
                                              --|> Toggle.view callsign.isReported
                                              if callsign.isReported then
                                                i [ class "bi bi-check" ] []

                                              else
                                                text ""
                                            ]
                                        , td [] [ text x.position ]
                                        , td [] [ text x.unitName ]
                                        , td [] [ text x.comment ]
                                        , td [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x.createdAt) ]
                                        , td [] [ text <| x.sourceName ]
                                        ]
                                        :: List.map
                                            (\knownCallsign ->
                                                tr []
                                                    [ td [] [ text knownCallsign.position ]
                                                    , td [] [ text knownCallsign.unitName ]
                                                    , td [] [ text knownCallsign.comment ]
                                                    , td [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x.createdAt) ]
                                                    , td [] [ text <| knownCallsign.sourceName ]
                                                    ]
                                            )
                                            xs

                                [] ->
                                    [ text "" ]

                        renderCallsignEdit :
                            Dict String Bool
                            -> CallsignResModified
                            -> List (Html Msg)
                        renderCallsignEdit editingDict callsign =
                            let
                                rowCount =
                                    List.length callsign.knownCallsigns

                                isReported =
                                    Dict.get callsign.callsign editingDict
                                        |> Maybe.withDefault callsign.isReported
                            in
                            case callsign.knownCallsigns of
                                x :: xs ->
                                    tr [ class "" ]
                                        [ td [ rowspan rowCount ] [ text <| String.toUpper callsign.callsign ]
                                        , td [ rowspan rowCount ] [ text <| String.fromInt callsign.messageCount ]
                                        , td [ rowspan rowCount ]
                                            [ case callsign.lastDatetime of
                                                Just lastDatetime ->
                                                    text <|
                                                        Le.Time.renderDateF6 shared.timeZone
                                                            (Time.millisToPosix lastDatetime)

                                                Nothing ->
                                                    text ""
                                            ]
                                        , td [ rowspan rowCount ]
                                            [ Checkbox.new { isChecked = isReported, onToggle = CallsignReportingStatusToggledByUser callsign } |> Checkbox.view
                                            ]
                                        , td [] [ text x.position ]
                                        , td [] [ text x.unitName ]
                                        , td [] [ text x.comment ]
                                        , td [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x.createdAt) ]
                                        , td [] [ text <| x.sourceName ]
                                        ]
                                        :: List.map
                                            (\knownCallsign ->
                                                tr []
                                                    [ td [] [ text knownCallsign.position ]
                                                    , td [] [ text knownCallsign.unitName ]
                                                    , td [] [ text knownCallsign.comment ]
                                                    , td [] [ text <| Le.Time.renderDateF6 shared.timeZone (Time.millisToPosix x.createdAt) ]
                                                    , td [] [ text <| knownCallsign.sourceName ]
                                                    ]
                                            )
                                            xs

                                [] ->
                                    [ text "" ]

                        ( callsignsWithUnits, callsignsUnknown ) =
                            callsigns
                                |> List.partition
                                    (\callsign ->
                                        case callsign.knownCallsigns of
                                            Just _ ->
                                                True

                                            Nothing ->
                                                False
                                    )

                        callsignsWithUnits2 =
                            List.map
                                (\callsign ->
                                    { knownCallsigns = Maybe.withDefault [] callsign.knownCallsigns
                                    , callsign = callsign.callsign
                                    , messageCount = callsign.messageCount
                                    , lastDatetime = callsign.lastDatetime
                                    , freqs = callsign.freqs
                                    , networkNames = callsign.networkNames
                                    , isOld = callsign.isOld
                                    , isReported = callsign.isReported
                                    }
                                )
                                callsignsWithUnits
                      in
                      table [ class "table-fixed w-full" ]
                        [ thead [ class "text-[13px]/[110%] font-medium sticky bg-w dark:bg-[#1C1C21]", style "inset-block-start" "0" ]
                            [ tr [ class "" ]
                                [ th [ class "w-[10%]" ] [ text "Позивний" ]
                                , th [ class "w-[7%]" ] [ text "Кількість перехоплень з позивним" ]
                                , th [ class "w-[10%]" ] [ text "Останній раз в етері" ]
                                , th [ class "w-[8%]" ] [ text "Звітний" ]
                                , th [ class "w-[22%]" ] [ text "Посада" ]
                                , th [ class "w-[14%]" ] [ text "Підрозділ" ]
                                , th [ class "w-[19%]" ] [ text "Коментар" ]
                                , th [ class "w-[10%]" ] [ text "Дата прив'язки" ]
                                , th [ class "w-[8%]" ] [ text "Джерело" ]
                                ]
                            ]
                        , tbody []
                            (List.concatMap
                                (\callsign ->
                                    case model.callsignsEditingState of
                                        Readonly ->
                                            renderCallsignMainRow callsign

                                        Editing editingDict ->
                                            renderCallsignEdit editingDict callsign
                                )
                                callsignsWithUnits2
                            )
                        , tfoot []
                            [ tr []
                                [ td [ colspan 8 ]
                                    [ span [ class "font-medium" ] [ text "Приналежність встановлюється: " ]
                                    , div [ class "flex flex-wrap gap-[4px] text-[13px]" ] (List.map (\c -> span [] [ text <| String.toUpper c.callsign ]) callsignsUnknown)
                                    ]
                                ]
                            ]
                        ]
                    ]

            _ ->
                Le.Block.Spinner.loadingSpinnerSm
        ]
    , section [ class "grid grid-cols-12 gap-[30px] h-[300px] mt-[30px]" ]
        [ div [ class "col-span-4 bg-w dark:bg-[#1C1C21] p-[16px] flex flex-col" ]
            [ h4 [] [ text "Активність мережі" ]
            , section [ class "grow-1" ]
                [ case model.groupsActivity of
                    Success data ->
                        let
                            groupsMessageCountByDayJson =
                                data |> Encode.dict identity (Encode.dict identity Encode.int)
                        in
                        Html.node "bar-chart"
                            [ property "data" <| groupsMessageCountByDayJson
                            , property "last-day" <| Encode.int shared.now
                            , class "block"
                            ]
                            []

                    _ ->
                        Le.Block.Spinner.loadingSpinnerSm
                ]
            ]
        , let
            updatedAtString =
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix network.lastUpdatedAt)

            updatedByString =
                Maybe.withDefault "невідомий" network.lastUpdatedBy

            createdAtString =
                Le.Time.renderDateF6 shared.timeZone
                    (Time.millisToPosix network.createdAt)
          in
          div [ class "col-span-2 bg-w dark:bg-[#1C1C21] p-[16px]" ]
            [ section []
                [ div [ style "padding-left" "4px", title ("Прив'язку створено " ++ createdAtString) ]
                    [ i [ class "bi bi-calendar-date" ]
                        []
                    , text <|
                        " "
                            ++ createdAtString
                    ]
                , div [ style "padding-left" "4px", title ("Востаннє прив'язка редагована " ++ updatedAtString ++ " користувачем " ++ updatedByString) ]
                    [ i [ class "bi bi-pencil-square" ] []
                    , text (" " ++ updatedAtString ++ " (" ++ updatedByString ++ ")")
                    ]
                ]
            ]
        ]
    ]


view : Shared.Model -> Model -> View Msg
view shared model =
    { title = "Мережа"
    , body =
        [ div []
            [ Le.Block.Toast.view ToastMsg model.toasts <|
                div [ class "bg-[#F5F7F9] dark:bg-[#0E0E11] rer-network min-h-sceen" ]
                    [ div [ class "w-[75vw] mx-auto py-[16px]" ]
                        (case model.network of
                            Success network ->
                                contentBlock shared network model

                            _ ->
                                [ div [ class "h-full" ] [ Le.Block.Spinner.loadingSpinner ] ]
                        )
                    ]
            ]
        ]
    }
