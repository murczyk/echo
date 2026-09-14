module Pages.RerUnits.Id_ exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Bytes exposing (Bytes)
import Core.Auth
import Core.Types exposing (ApiError)
import Dict
import Effect as E exposing (Effect)
import File.Download as Download
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (on, onClick)
import Json.Decode as Decode
import Json.Encode as Encode
import Layouts
import Page exposing (Page)
import Route exposing (Route)
import Route.Path
import Shared
import Shared.Components.Button as Button
import Shared.Components.ModalDialog as ModalDialog
import Shared.Components.Spinner
import Time
import Utils.Api.ErrorHandling
import Utils.Time
import View exposing (View)


page : Auth.User -> Shared.Model -> Route { id : String } -> Page Model Msg
page user shared route =
    Page.new
        { init = init user route
        , update = update
        , subscriptions = subscriptions
        , view = view user shared
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-units"
        }


type Tab
    = Overview
    | Files
    | Networks
    | Management
    | ChildUnits
    | Changelog


type UnitEditSection
    = UnitData
    | OrbitData


type alias Model =
    { unitId : Maybe Int
    , details : Maybe B.UnitDetailsRsp
    , detailsLoading : Bool
    , detailsLoadFailed : Bool
    , activeTab : Tab
    , childUnits : Maybe B.UnitOrbitChildrenRsp
    , childUnitsLoading : Bool
    , changelog : Maybe B.UnitChangelogRsp
    , changelogLoading : Bool
    , downloadInProgress : Maybe Int
    , orbitLinkDialogOpen : Bool
    , orbitUnitUnlinking : Maybe String
    , deviceNetworkDialogOpen : Bool
    , unitEditDialogOpen : Maybe UnitEditSection
    , unitUpdating : Bool
    , unitDeleteDialogOpen : Bool
    , unitDeleting : Bool
    , unitLabelInput : String
    , unitLabelSaving : Bool
    , unitLabelDeleting : Maybe Int
    }


init : Auth.User -> Route { id : String } -> () -> ( Model, Effect Msg )
init _ route _ =
    let
        unitId =
            route.params.id
                |> String.toInt
                |> Maybe.andThen positiveInt

        initialEffects =
            case unitId of
                Just id ->
                    [ loadDetails id ]

                Nothing ->
                    []
    in
    ( { unitId = unitId
      , details = Nothing
      , detailsLoading = unitId /= Nothing
      , detailsLoadFailed = False
      , activeTab =
            case Dict.get "tab" route.query of
                Just "files" ->
                    Files

                Just "networks" ->
                    Networks

                Just "management" ->
                    Management

                Just "changelog" ->
                    Changelog

                _ ->
                    Overview
      , childUnits = Nothing
      , childUnitsLoading = False
      , changelog = Nothing
      , changelogLoading = False
      , downloadInProgress = Nothing
      , orbitLinkDialogOpen = False
      , orbitUnitUnlinking = Nothing
      , deviceNetworkDialogOpen = False
      , unitEditDialogOpen = Nothing
      , unitUpdating = False
      , unitDeleteDialogOpen = False
      , unitDeleting = False
      , unitLabelInput = ""
      , unitLabelSaving = False
      , unitLabelDeleting = Nothing
      }
    , E.batch initialEffects
    )


positiveInt : Int -> Maybe Int
positiveInt value =
    if value > 0 then
        Just value

    else
        Nothing


loadDetails : Int -> Effect Msg
loadDetails unitId =
    E.sendCmd <|
        Api.sigint_unit_details DetailsReturnedByApi
            { unitId = unitId
            }


type Msg
    = DetailsReturnedByApi (Result ApiError B.UnitDetailsRsp)
    | RetryDetails
    | ChangeTab Tab
    | ChildUnitsReturnedByApi (Result ApiError B.UnitOrbitChildrenRsp)
    | ChangelogReturnedByApi (Result ApiError B.UnitChangelogRsp)
    | AttachmentsUploaded
    | DownloadAttachment B.UnitAttachment
    | AttachmentDownloaded B.UnitAttachment (Result ApiError Bytes)
    | OpenOrbitLinkDialog
    | CloseOrbitLinkDialog
    | OrbitUnitLinked
    | UnlinkOrbitUnit B.OrbitUnitDetails
    | OrbitUnitUnlinked String (Result ApiError ())
    | OpenDeviceNetworkDialog
    | CloseDeviceNetworkDialog
    | DeviceNetworkCreated
    | OpenUnitEditDialog UnitEditSection
    | CloseUnitEditDialog
    | SubmitUnitEdit B.CreateUnitReq
    | UnitEditUpdated (Result ApiError B.Unit)
    | SetUnitActive Bool
    | UnitActiveUpdated (Result ApiError B.Unit)
    | OpenUnitDeleteDialog
    | CloseUnitDeleteDialog
    | ConfirmUnitDelete
    | UnitDeleted (Result ApiError B.Unit)
    | SetUnitLabelInput String
    | SubmitUnitLabel
    | UnitLabelCreated (Result ApiError B.UnitLabel)
    | DeleteUnitLabel Int
    | UnitLabelDeleted Int (Result ApiError ())


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        DetailsReturnedByApi result ->
            updateDetails result model

        RetryDetails ->
            retryDetails model

        ChangeTab tab ->
            changeTab tab model

        ChildUnitsReturnedByApi result ->
            updateChildUnits result model

        ChangelogReturnedByApi result ->
            updateChangelog result model

        AttachmentsUploaded ->
            reloadAttachments model

        DownloadAttachment attachment ->
            downloadAttachment attachment model

        AttachmentDownloaded attachment result ->
            attachmentDownloaded attachment result model

        OpenOrbitLinkDialog ->
            ( { model | orbitLinkDialogOpen = True }, E.none )

        CloseOrbitLinkDialog ->
            ( { model | orbitLinkDialogOpen = False }, E.none )

        OrbitUnitLinked ->
            orbitUnitLinked model

        UnlinkOrbitUnit orbitUnit ->
            unlinkOrbitUnit orbitUnit model

        OrbitUnitUnlinked orbitUnitId result ->
            orbitUnitUnlinked orbitUnitId result model

        OpenDeviceNetworkDialog ->
            ( { model | deviceNetworkDialogOpen = True }, E.none )

        CloseDeviceNetworkDialog ->
            ( { model | deviceNetworkDialogOpen = False }, E.none )

        DeviceNetworkCreated ->
            deviceNetworkCreated model

        OpenUnitEditDialog section ->
            ( { model | unitEditDialogOpen = Just section }, E.none )

        CloseUnitEditDialog ->
            ( { model | unitEditDialogOpen = Nothing }, E.none )

        SubmitUnitEdit req ->
            submitUnitEdit req model

        UnitEditUpdated result ->
            unitEditUpdated result model

        SetUnitActive active ->
            setUnitActive active model

        UnitActiveUpdated result ->
            unitActiveUpdated result model

        OpenUnitDeleteDialog ->
            ( { model | unitDeleteDialogOpen = True }, E.none )

        CloseUnitDeleteDialog ->
            if model.unitDeleting then
                ( model, E.none )

            else
                ( { model | unitDeleteDialogOpen = False }, E.none )

        ConfirmUnitDelete ->
            confirmUnitDelete model

        UnitDeleted result ->
            unitDeleted result model

        SetUnitLabelInput value ->
            ( { model | unitLabelInput = value }, E.none )

        SubmitUnitLabel ->
            submitUnitLabel model

        UnitLabelCreated result ->
            unitLabelCreated result model

        DeleteUnitLabel labelId ->
            deleteUnitLabel labelId model

        UnitLabelDeleted labelId result ->
            unitLabelDeleted labelId result model


updateDetails : Result ApiError B.UnitDetailsRsp -> Model -> ( Model, Effect Msg )
updateDetails result model =
    case result of
        Err err ->
            ( { model
                | detailsLoading = False
                , detailsLoadFailed = True
              }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підрозділу" err
            )

        Ok details ->
            ( { model
                | details = Just details
                , detailsLoading = False
                , detailsLoadFailed = False
                , changelogLoading = model.activeTab == Changelog && model.changelog == Nothing
                , activeTab =
                    if model.activeTab == ChildUnits && List.isEmpty details.orbitUnits then
                        Overview

                    else if model.activeTab == Management && not details.canEditUnitLabels && List.isEmpty details.labels then
                        Overview

                    else
                        model.activeTab
                , childUnits = Nothing
              }
            , if model.activeTab == Changelog && model.changelog == Nothing then
                E.sendCmd <|
                    Api.sigint_unit_changelog ChangelogReturnedByApi
                        { unitId = details.unit.id }

              else
                E.none
            )


changeTab : Tab -> Model -> ( Model, Effect Msg )
changeTab tab state =
    if tab == Changelog && state.changelog == Nothing && not state.changelogLoading then
        case state.unitId of
            Just unitId ->
                ( { state | activeTab = tab, changelogLoading = True }
                , E.sendCmd <|
                    Api.sigint_unit_changelog ChangelogReturnedByApi
                        { unitId = unitId }
                )

            Nothing ->
                ( { state | activeTab = tab }, E.none )

    else if tab == ChildUnits && state.childUnits == Nothing && not state.childUnitsLoading then
        case state.unitId of
            Just unitId ->
                ( { state | activeTab = tab, childUnitsLoading = True }
                , E.sendCmd <|
                    Api.sigint_unit_orbit_children ChildUnitsReturnedByApi
                        { unitId = unitId }
                )

            Nothing ->
                ( { state | activeTab = tab }, E.none )

    else
        ( { state | activeTab = tab }, E.none )


updateChangelog : Result ApiError B.UnitChangelogRsp -> Model -> ( Model, Effect Msg )
updateChangelog result state =
    case result of
        Err err ->
            ( { state | changelogLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження журналу змін" err
            )

        Ok changelog ->
            ( { state
                | changelog = Just changelog
                , changelogLoading = False
              }
            , E.none
            )


updateChildUnits : Result ApiError B.UnitOrbitChildrenRsp -> Model -> ( Model, Effect Msg )
updateChildUnits result state =
    case result of
        Err err ->
            ( { state | childUnitsLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підпорядкованих підрозділів" err
            )

        Ok childUnits ->
            ( { state
                | childUnits = Just childUnits
                , childUnitsLoading = False
              }
            , E.none
            )


retryDetails : Model -> ( Model, Effect Msg )
retryDetails model =
    case model.unitId of
        Nothing ->
            ( model, E.none )

        Just unitId ->
            ( { model
                | detailsLoading = True
                , detailsLoadFailed = False
              }
            , loadDetails unitId
            )


reloadAttachments : Model -> ( Model, Effect Msg )
reloadAttachments model =
    case model.unitId of
        Nothing ->
            ( model, E.none )

        Just unitId ->
            ( model, loadDetails unitId )


downloadAttachment : B.UnitAttachment -> Model -> ( Model, Effect Msg )
downloadAttachment attachment model =
    if model.downloadInProgress /= Nothing then
        ( model, E.none )

    else
        ( { model | downloadInProgress = Just attachment.id }
        , E.sendCmd <|
            Api.sigint_unit_attachment_download
                (AttachmentDownloaded attachment)
                { attachmentId = attachment.id
                }
        )


attachmentDownloaded : B.UnitAttachment -> Result ApiError Bytes -> Model -> ( Model, Effect Msg )
attachmentDownloaded attachment result model =
    case result of
        Err err ->
            ( { model | downloadInProgress = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження файлу" err
            )

        Ok bytes ->
            ( { model | downloadInProgress = Nothing }
            , E.sendCmd <|
                Download.bytes
                    (downloadFileName attachment)
                    (downloadContentType attachment)
                    bytes
            )


downloadFileName : B.UnitAttachment -> String
downloadFileName attachment =
    if String.isEmpty (String.trim attachment.fileName) then
        "attachment-" ++ String.fromInt attachment.id

    else
        attachment.fileName


downloadContentType : B.UnitAttachment -> String
downloadContentType attachment =
    if String.isEmpty (String.trim attachment.contentType) then
        "application/octet-stream"

    else
        attachment.contentType


orbitUnitLinked : Model -> ( Model, Effect Msg )
orbitUnitLinked model =
    case model.unitId of
        Nothing ->
            ( { model | orbitLinkDialogOpen = False }, E.none )

        Just unitId ->
            ( { model
                | orbitLinkDialogOpen = False
                , detailsLoading = True
                , changelog = Nothing
              }
            , loadDetails unitId
            )


unlinkOrbitUnit : B.OrbitUnitDetails -> Model -> ( Model, Effect Msg )
unlinkOrbitUnit orbitUnit model =
    case model.unitId of
        Nothing ->
            ( model, E.none )

        Just unitId ->
            ( { model | orbitUnitUnlinking = Just orbitUnit.unitId }
            , E.sendCmd <|
                Api.sigint_unit_orbit_unlink
                    (OrbitUnitUnlinked orbitUnit.unitId)
                    { sigintUnitId = unitId
                    , orbitUnitId = orbitUnit.unitId
                    }
            )


orbitUnitUnlinked : String -> Result ApiError () -> Model -> ( Model, Effect Msg )
orbitUnitUnlinked _ result model =
    case result of
        Err err ->
            ( { model | orbitUnitUnlinking = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення прив’язки Orbit" err
            )

        Ok () ->
            case model.unitId of
                Nothing ->
                    ( { model | orbitUnitUnlinking = Nothing }, E.none )

                Just unitId ->
                    ( { model
                        | orbitUnitUnlinking = Nothing
                        , detailsLoading = True
                        , changelog = Nothing
                      }
                    , loadDetails unitId
                    )


deviceNetworkCreated : Model -> ( Model, Effect Msg )
deviceNetworkCreated model =
    case model.unitId of
        Nothing ->
            ( { model | deviceNetworkDialogOpen = False }, E.none )

        Just unitId ->
            ( { model
                | deviceNetworkDialogOpen = False
                , detailsLoading = True
              }
            , loadDetails unitId
            )


submitUnitEdit : B.CreateUnitReq -> Model -> ( Model, Effect Msg )
submitUnitEdit req model =
    case model.details of
        Nothing ->
            ( model, E.none )

        Just details ->
            let
                unit =
                    details.unit

                updatedUnit =
                    { unit
                        | other = req.other
                        , teamOrCrew = req.teamOrCrew
                        , section = req.section
                        , squad = req.squad
                        , platoon = req.platoon
                        , company = req.company
                        , battalion = req.battalion
                        , regiment = req.regiment
                        , brigade = req.brigade
                        , division = req.division
                        , corps = req.corps
                        , army = req.army
                        , militaryDistrict = req.militaryDistrict
                        , armyRegion = req.armyRegion
                        , name = Maybe.withDefault unit.name req.name
                        , active = req.active
                        , isDeduplicateCandidate = req.isDeduplicateCandidate
                        , comment = req.comment
                        , orbitNote = req.orbitNote
                        , presentInOrbit = req.presentInOrbit
                    }
            in
            ( { model | unitUpdating = True }
            , E.sendCmd <| Api.sigint_unit_update UnitEditUpdated updatedUnit
            )


unitEditUpdated : Result ApiError B.Unit -> Model -> ( Model, Effect Msg )
unitEditUpdated result model =
    case result of
        Err err ->
            ( { model | unitUpdating = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка редагування підрозділу" err
            )

        Ok unit ->
            case model.details of
                Nothing ->
                    ( { model | unitUpdating = False, unitEditDialogOpen = Nothing }, E.none )

                Just details ->
                    ( { model
                        | details = Just { details | unit = unit }
                        , unitUpdating = False
                        , unitEditDialogOpen = Nothing
                        , changelog = Nothing
                      }
                    , E.none
                    )


setUnitActive : Bool -> Model -> ( Model, Effect Msg )
setUnitActive active model =
    case model.details of
        Just details ->
            if model.unitUpdating then
                ( model, E.none )

            else
                let
                    unit =
                        details.unit
                in
                ( { model | unitUpdating = True }
                , E.sendCmd <|
                    Api.sigint_unit_update UnitActiveUpdated
                        { unit | active = active }
                )

        Nothing ->
            ( model, E.none )


unitActiveUpdated : Result ApiError B.Unit -> Model -> ( Model, Effect Msg )
unitActiveUpdated result model =
    case result of
        Err err ->
            ( { model | unitUpdating = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка зміни статусу підрозділу" err
            )

        Ok unit ->
            case model.details of
                Nothing ->
                    ( { model | unitUpdating = False }, E.none )

                Just details ->
                    ( { model
                        | details = Just { details | unit = unit }
                        , unitUpdating = False
                        , changelog = Nothing
                      }
                    , E.none
                    )


confirmUnitDelete : Model -> ( Model, Effect Msg )
confirmUnitDelete model =
    case model.unitId of
        Just unitId ->
            if model.unitDeleting then
                ( model, E.none )

            else
                ( { model | unitDeleting = True }
                , E.sendCmd <| Api.sigint_unit_delete UnitDeleted unitId
                )

        Nothing ->
            ( model, E.none )


unitDeleted : Result ApiError B.Unit -> Model -> ( Model, Effect Msg )
unitDeleted result model =
    case result of
        Err err ->
            ( { model | unitDeleting = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення підрозділу" err
            )

        Ok _ ->
            ( model
            , E.pushRoute
                { path = Route.Path.RerUnitsNeo
                , query = Dict.empty
                , hash = Nothing
                }
            )


submitUnitLabel : Model -> ( Model, Effect Msg )
submitUnitLabel model =
    case model.unitId of
        Just unitId ->
            if String.length (String.trim model.unitLabelInput) < 2 || model.unitLabelSaving then
                ( model, E.none )

            else
                ( { model | unitLabelSaving = True }
                , E.sendCmd <|
                    Api.sigint_unit_label_create UnitLabelCreated
                        { unitId = unitId
                        , label = model.unitLabelInput
                        }
                )

        Nothing ->
            ( model, E.none )


unitLabelCreated : Result ApiError B.UnitLabel -> Model -> ( Model, Effect Msg )
unitLabelCreated result model =
    case result of
        Err err ->
            ( { model | unitLabelSaving = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка додавання синоніму підрозділу" err
            )

        Ok _ ->
            case model.unitId of
                Just unitId ->
                    ( { model
                        | unitLabelSaving = False
                        , unitLabelInput = ""
                        , detailsLoading = True
                      }
                    , loadDetails unitId
                    )

                Nothing ->
                    ( { model | unitLabelSaving = False }, E.none )


deleteUnitLabel : Int -> Model -> ( Model, Effect Msg )
deleteUnitLabel labelId model =
    if model.unitLabelDeleting /= Nothing then
        ( model, E.none )

    else
        ( { model | unitLabelDeleting = Just labelId }
        , E.sendCmd <|
            Api.sigint_unit_label_delete (UnitLabelDeleted labelId)
                { labelId = labelId }
        )


unitLabelDeleted : Int -> Result ApiError () -> Model -> ( Model, Effect Msg )
unitLabelDeleted _ result model =
    case result of
        Err err ->
            ( { model | unitLabelDeleting = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення синоніму підрозділу" err
            )

        Ok () ->
            case model.unitId of
                Just unitId ->
                    ( { model
                        | unitLabelDeleting = Nothing
                        , detailsLoading = True
                      }
                    , loadDetails unitId
                    )

                Nothing ->
                    ( { model | unitLabelDeleting = Nothing }, E.none )


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    { title = "Підрозділ противника"
    , body =
        [ div [ class "page-rer-unit-details w-5/6 mx-auto py-4" ]
            [ case ( model.unitId, model.details ) of
                ( Nothing, _ ) ->
                    invalidUnitView

                ( Just _, Just details ) ->
                    detailsView user shared model details

                ( Just _, Nothing ) ->
                    if model.detailsLoading then
                        loadingView

                    else
                        detailsErrorView model.detailsLoadFailed
            ]
        ]
    }


invalidUnitView : Html Msg
invalidUnitView =
    div [ class "alert alert-danger" ]
        [ text "Некоректний ID підрозділу." ]


loadingView : Html Msg
loadingView =
    div [ class "flex justify-center py-12" ]
        [ Shared.Components.Spinner.loadingSpinner ]


detailsErrorView : Bool -> Html Msg
detailsErrorView loadFailed =
    div [ class "alert alert-danger d-flex align-items-center justify-content-between" ]
        [ text
            (if loadFailed then
                "Не вдалося завантажити підрозділ."

             else
                "Підрозділ не знайдено."
            )
        , button
            [ class "btn btn-outline-danger btn-sm"
            , type_ "button"
            , onClick RetryDetails
            ]
            [ text "Спробувати ще раз" ]
        ]


detailsView : Auth.User -> Shared.Model -> Model -> B.UnitDetailsRsp -> Html Msg
detailsView user shared model details =
    div [ class "flex flex-col gap-4" ]
        [ detailsHeader user model details
        , unitDeleteDialog model
        , deviceNetworkDialog model details
        , unitEditDialog model details.unit
        , orbitLinkDialog model details.unit
        , tabsView model.activeTab
            (not (List.isEmpty details.orbitUnits))
            (details.canEditUnitLabels || not (List.isEmpty details.labels))
        , case model.activeTab of
            Overview ->
                overviewTab user shared model details

            Files ->
                filesTab user shared model details.attachments

            Networks ->
                networksTab user details.unit.id

            Management ->
                managementTab model details

            ChildUnits ->
                childUnitsTab model

            Changelog ->
                changelogTab shared model
        ]


orbitLinkDialog : Model -> B.Unit -> Html Msg
orbitLinkDialog model unit =
    case ( model.orbitLinkDialogOpen, model.unitId ) of
        ( True, Just unitId ) ->
            node "orbit-unit-link-dialog"
                [ attribute "data-unit-id" (String.fromInt unitId)
                , attribute "data-unit" (Encode.encode 0 (B.unitEncoder unit))
                , on "orbit-unit-link-close" (Decode.succeed CloseOrbitLinkDialog)
                , on "orbit-unit-linked" (Decode.succeed OrbitUnitLinked)
                ]
                []

        _ ->
            text ""


detailsHeader : Auth.User -> Model -> B.UnitDetailsRsp -> Html Msg
detailsHeader user model details =
    div
        [ class "d-flex align-items-center justify-content-between gap-3 flex-wrap" ]
        [ div [ class "d-flex align-items-center gap-3 flex-wrap" ]
            [ a
                [ class "btn btn-outline-secondary btn-sm"
                , Route.href
                    { path = Route.Path.RerUnitsNeo
                    , query = Dict.empty
                    , hash = Nothing
                    }
                ]
                [ i [ class "bi bi-arrow-left me-2" ] []
                , text "До підрозділів"
                ]
            , h1 [ class "mb-0 d-flex align-items-center gap-2" ]
                [ text details.unit.name
                , if details.unit.active then
                    text ""

                  else
                    span
                        [ class "badge rounded-pill text-bg-secondary fs-6 fw-normal" ]
                        [ text "Неактивний" ]
                ]
            ]
        , if Core.Auth.hasRole "UnitsEditor" user then
            unitActions model details

          else
            text ""
        ]


unitActions : Model -> B.UnitDetailsRsp -> Html Msg
unitActions model details =
    div [ class "dropdown" ]
        [ button
            [ class "btn btn-sm btn-link text-secondary p-1"
            , type_ "button"
            , disabled
                (model.unitEditDialogOpen
                    /= Nothing
                    || model.deviceNetworkDialogOpen
                    || model.unitUpdating
                    || model.unitDeleteDialogOpen
                )
            , attribute "data-bs-toggle" "dropdown"
            , attribute "aria-expanded" "false"
            , attribute "aria-label" "Дії з підрозділом"
            ]
            [ i [ class "bi bi-three-dots-vertical" ] [] ]
        , ul [ class "dropdown-menu dropdown-menu-end" ]
            [ li []
                [ button
                    [ class "dropdown-item d-flex align-items-center gap-2"
                    , type_ "button"
                    , onClick (SetUnitActive (not details.unit.active))
                    ]
                    [ i
                        [ class
                            (if details.unit.active then
                                "bi bi-toggle-off"

                             else
                                "bi bi-toggle-on"
                            )
                        ]
                        []
                    , text
                        (if details.unit.active then
                            "Деактивувати"

                         else
                            "Активувати"
                        )
                    ]
                ]
            , li [] [ hr [ class "dropdown-divider" ] [] ]
            , li []
                [ button
                    [ class "dropdown-item d-flex align-items-center gap-2 text-danger"
                    , type_ "button"
                    , onClick OpenUnitDeleteDialog
                    ]
                    [ i [ class "bi bi-trash" ] []
                    , text "Видалити"
                    ]
                ]
            ]
        ]


unitDeleteDialog : Model -> Html Msg
unitDeleteDialog model =
    ModalDialog.modalDialog model.unitDeleteDialogOpen CloseUnitDeleteDialog []
        [ div [ class "p-6" ]
            [ h2 [ class "text-xl font-semibold mb-4" ] [ text "Видалення підрозділу" ]
            , p [ class "text-gray-600 mb-6" ] [ text "Ви впевнені, що хочете видалити цей підрозділ?" ]
            , div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseUnitDeleteDialog }
                    |> Button.withStyleSecondary
                    |> Button.withDisabled model.unitDeleting
                    |> Button.view
                , Button.new { label = "Видалити", onClick = ConfirmUnitDelete }
                    |> Button.withStyleDanger
                    |> Button.withDisabled model.unitDeleting
                    |> (if model.unitDeleting then
                            Button.withIcon [ Shared.Components.Spinner.loadingSpinner2Sm ]

                        else
                            identity
                       )
                    |> Button.view
                ]
            ]
        ]


unitEditDialog : Model -> B.Unit -> Html Msg
unitEditDialog model unit =
    case model.unitEditDialogOpen of
        Just section ->
            node "unit-edit-dialog"
                [ attribute "data-unit" (Encode.encode 0 (B.unitEncoder unit))
                , attribute "data-section"
                    (case section of
                        UnitData ->
                            "unit"

                        OrbitData ->
                            "orbit"
                    )
                , attribute "data-submitting"
                    (if model.unitUpdating then
                        "true"

                     else
                        "false"
                    )
                , on "unit-edit-close" (Decode.succeed CloseUnitEditDialog)
                , on "unit-edit-submit"
                    (Decode.map SubmitUnitEdit <|
                        Decode.at [ "detail" ] B.createUnitReqDecoder
                    )
                ]
                []

        Nothing ->
            text ""


deviceNetworkDialog : Model -> B.UnitDetailsRsp -> Html Msg
deviceNetworkDialog model details =
    if model.deviceNetworkDialogOpen then
        node "device-network-create-dialog"
            [ attribute "data-unit-id" (String.fromInt details.unit.id)
            , attribute "data-unit-name" details.unit.name
            , attribute "data-unit-mask"
                (Encode.encode 0 <|
                    Encode.list Encode.string (defaultUnitMasks details.unit)
                )
            , on "device-network-create-close" (Decode.succeed CloseDeviceNetworkDialog)
            , on "device-network-created" (Decode.succeed DeviceNetworkCreated)
            ]
            []

    else
        text ""


defaultUnitMasks : B.Unit -> List String
defaultUnitMasks unit =
    let
        parts =
            [ unit.company
            , unit.battalion
            , unit.regiment
            , unit.division
            , unit.army
            , unit.militaryDistrict
            , unit.armyRegion
            ]
                |> List.filter (not << String.isEmpty << String.trim)

        forward =
            String.join " " parts

        backward =
            String.join " " (List.reverse parts)
    in
    if forward == backward then
        [ forward ]

    else
        [ forward, backward ]


tabsView : Tab -> Bool -> Bool -> Html Msg
tabsView activeTab hasOrbitUnit showManagement =
    let
        tabButton tab label =
            button
                [ class "px-4 py-2 text-sm font-medium border-b-2 bg-transparent flex-shrink-0 whitespace-nowrap"
                , classList
                    [ ( "border-primary text-primary", activeTab == tab )
                    , ( "border-transparent text-secondary", activeTab /= tab )
                    ]
                , type_ "button"
                , attribute "role" "tab"
                , attribute "aria-selected"
                    (if activeTab == tab then
                        "true"

                     else
                        "false"
                    )
                , onClick (ChangeTab tab)
                ]
                [ text label ]
    in
    nav
        [ class "d-flex border-bottom overflow-x-auto"
        , attribute "role" "tablist"
        ]
        [ tabButton Overview "Огляд"
        , tabButton Files "Файли"
        , tabButton Networks "Мережі"
        , if hasOrbitUnit then
            tabButton ChildUnits "Підпорядковані підрозділи"

          else
            text ""
        , tabButton Changelog "Журнал змін"
        , if showManagement then
            tabButton Management "Керування"

          else
            text ""
        ]


networksTab : Auth.User -> Int -> Html Msg
networksTab user unitId =
    div
        [ attribute "role" "tabpanel"
        , style "height" "70vh"
        ]
        [ node "rer-networks-neo"
            [ attribute "data-auth-user-roles" (String.join "," user.roles)
            , attribute "data-unit-id" (String.fromInt unitId)
            , class "block w-full h-full"
            ]
            []
        ]


changelogTab : Shared.Model -> Model -> Html Msg
changelogTab shared state =
    div
        [ class "flex flex-col gap-3"
        , attribute "role" "tabpanel"
        ]
        [ case state.changelog of
            Just changelog ->
                if List.isEmpty changelog.entries then
                    div [ class "border rounded p-4 bg-card text-secondary" ]
                        [ text "Змін після запуску журналу ще немає." ]

                else
                    div [ class "d-flex flex-column gap-3" ]
                        (List.map (changelogEntryView shared) changelog.entries)

            Nothing ->
                if state.changelogLoading then
                    div [ class "flex justify-center py-8" ]
                        [ Shared.Components.Spinner.loadingSpinner ]

                else
                    text ""
        ]


changelogEntryView : Shared.Model -> B.UnitChangelogEntry -> Html Msg
changelogEntryView shared entry =
    div [ class "border rounded p-4 bg-card" ]
        [ div [ class "d-flex justify-content-between gap-3 flex-wrap mb-3" ]
            [ div [ class "fw-semibold" ] [ text (changelogActionLabel entry.action) ]
            , div [ class "text-secondary text-sm" ]
                [ text
                    (Utils.Time.renderDateTimeF1 shared.timeZone
                        (Time.millisToPosix entry.createdAt)
                        ++ " · "
                        ++ changelogAuthor entry.author
                    )
                ]
            ]
        , if List.isEmpty entry.changes then
            text ""

          else
            div [ class "table-responsive" ]
                [ table [ class "table table-sm table-bordered align-middle mb-0" ]
                    [ thead []
                        [ tr []
                            [ th [ scope "col" ] [ text "Поле" ]
                            , th [ scope "col" ] [ text "Було" ]
                            , th [ scope "col" ] [ text "Стало" ]
                            ]
                        ]
                    , tbody [] (List.map changelogChangeRow entry.changes)
                    ]
                ]
        ]


changelogChangeRow : B.UnitChangelogChange -> Html Msg
changelogChangeRow change =
    tr []
        [ th [ scope "row" ] [ text (changelogFieldLabel change.field) ]
        , td [ style "white-space" "pre-wrap", style "overflow-wrap" "anywhere" ]
            [ text (changelogValue change.field change.oldValue) ]
        , td [ style "white-space" "pre-wrap", style "overflow-wrap" "anywhere" ]
            [ text (changelogValue change.field change.newValue) ]
        ]


changelogActionLabel : String -> String
changelogActionLabel action =
    case action of
        "create" ->
            "Підрозділ створено"

        "delete" ->
            "Підрозділ видалено"

        "orbit_links" ->
            "Змінено прив’язку до Orbit"

        _ ->
            "Дані підрозділу змінено"


changelogAuthor : String -> String
changelogAuthor author =
    if author == "system" then
        "Система"

    else
        author


changelogFieldLabel : String -> String
changelogFieldLabel field =
    case field of
        "name" ->
            "Назва"

        "other" ->
            "Інше"

        "team_or_crew" ->
            "Команда/Екіпаж"

        "section" ->
            "Секція"

        "squad" ->
            "Відділення"

        "platoon" ->
            "Взвод"

        "company" ->
            "Рота"

        "battalion" ->
            "Батальйон"

        "regiment" ->
            "Полк"

        "brigade" ->
            "Бригада"

        "division" ->
            "Дивізія"

        "corps" ->
            "Корпус"

        "army" ->
            "Армія"

        "military_district" ->
            "Група армій/Фронт/Види та роди ЗС"

        "army_region" ->
            "Регіон/ТВД/Збройні Сили"

        "active" ->
            "Статус"

        "comment" ->
            "Коментар"

        "orbit_note" ->
            "Примітка Orbit"

        "present_in_orbit" ->
            "Присутній в Orbit"

        "is_deduplicate_candidate" ->
            "Можливо дублікат"

        "is_inconsistent" ->
            "Неузгоджені дані"

        "deleted" ->
            "Видалено"

        "orbit_units" ->
            "Підрозділи Orbit"

        _ ->
            field


changelogValue : String -> Maybe String -> String
changelogValue field value =
    case ( field, value ) of
        ( "active", Just "true" ) ->
            "Активний"

        ( "active", Just "false" ) ->
            "Неактивний"

        ( _, Just "true" ) ->
            "Так"

        ( _, Just "false" ) ->
            "Ні"

        ( _, Just textValue ) ->
            textValue

        ( _, Nothing ) ->
            "—"


childUnitsTab : Model -> Html Msg
childUnitsTab state =
    div
        [ class "border rounded p-4 bg-card"
        , attribute "role" "tabpanel"
        ]
        [ case state.childUnits of
            Just childUnits ->
                childUnitsTable childUnits.units

            Nothing ->
                if state.childUnitsLoading then
                    div [ class "flex justify-center py-8" ]
                        [ Shared.Components.Spinner.loadingSpinner ]

                else
                    text ""
        ]


childUnitsTable : List B.OrbitChildUnit -> Html Msg
childUnitsTable units =
    if List.isEmpty units then
        p [ class "text-secondary mb-0" ]
            [ text "Немає прив’язаних підрозділів." ]

    else
        div [ class "table-responsive" ]
            [ table [ class "table table-bordered align-middle mb-0" ]
                [ thead []
                    [ tr []
                        [ th [ scope "col" ] [ text "Назва" ]
                        , th [ scope "col", class "text-center" ]
                            [ text "Структурне підпорядкування" ]
                        , th [ scope "col", class "text-center" ]
                            [ text "Оперативне підпорядкування" ]
                        ]
                    ]
                , tbody [] (List.map childUnitRow units)
                ]
            ]


childUnitRow : B.OrbitChildUnit -> Html Msg
childUnitRow unit =
    tr []
        [ td []
            [ div [ class "d-flex align-items-center gap-2" ]
                ([ childUnitStatus unit.active
                 , a
                    [ href ("/rer-units/" ++ String.fromInt unit.sigintUnitId) ]
                    [ text unit.name ]
                 ]
                    ++ List.map (childUnitOrbitLink unit.name) unit.orbitUnitIds
                )
            ]
        , childUnitRelationshipCell unit.isGenerative
        , childUnitRelationshipCell unit.isOperational
        ]


childUnitStatus : Bool -> Html Msg
childUnitStatus active =
    span
        [ class "d-inline-block rounded-circle flex-shrink-0"
        , class
            (if active then
                "bg-success"

             else
                "bg-secondary"
            )
        , style "width" "10px"
        , style "height" "10px"
        , title
            (if active then
                "Активний"

             else
                "Неактивний"
            )
        ]
        []


childUnitRelationshipCell : Bool -> Html Msg
childUnitRelationshipCell isLinked =
    td [ class "text-center" ]
        [ if isLinked then
            span []
                [ i
                    [ class "bi bi-check-circle-fill text-success fs-5"
                    , attribute "aria-hidden" "true"
                    ]
                    []
                , span [ class "visually-hidden" ] [ text "Так" ]
                ]

          else
            text ""
        ]


childUnitOrbitLink : String -> String -> Html Msg
childUnitOrbitLink unitName orbitUnitId =
    a
        [ class "d-inline-flex flex-shrink-0"
        , href
            ("https://delta.mil.gov.ua/orbit/units/"
                ++ orbitUnitId
                ++ "/organizational-structure"
            )
        , target "_blank"
        , rel "noopener noreferrer"
        , title "Відкрити підрозділ в Orbit"
        , attribute "aria-label" ("Відкрити " ++ unitName ++ " в Orbit")
        ]
        [ img
            [ src "/img/delta-icon.webp"
            , alt ""
            , style "height" "22px"
            , style "width" "22px"
            ]
            []
        ]


overviewTab : Auth.User -> Shared.Model -> Model -> B.UnitDetailsRsp -> Html Msg
overviewTab user shared model details =
    let
        hasOrbitNote =
            details.unit.orbitNote
                |> Maybe.map (not << String.isEmpty << String.trim)
                |> Maybe.withDefault False

        orbitCards =
            if List.isEmpty details.orbitUnits then
                if details.canLinkOrbitUnit || hasOrbitNote then
                    [ emptyOrbitDataCard
                        (Core.Auth.hasRole "UnitsEditor" user)
                        model
                        details.canLinkOrbitUnit
                        details.unit.orbitNote
                    ]

                else
                    []

            else
                List.indexedMap
                    (\index ->
                        orbitDataCard
                            (Core.Auth.hasRole "UnitsEditor" user)
                            shared
                            model
                            (index == 0)
                            details.unit.orbitNote
                    )
                    details.orbitUnits
    in
    div
        [ class "flex flex-col gap-4"
        , attribute "role" "tabpanel"
        ]
        (unitOverviewCard
            (Core.Auth.hasRole "UnitsEditor" user)
            shared
            model
            details
            :: orbitCards
        )


emptyOrbitDataCard : Bool -> Model -> Bool -> Maybe String -> Html Msg
emptyOrbitDataCard canManageOrbitData state canLinkOrbitUnit orbitNote =
    div [ class "border rounded p-4 bg-card" ]
        [ div [ class "d-flex align-items-center justify-content-between gap-3 mb-4" ]
            [ h2 [ class "h4 mb-0" ] [ text "Дані із Orbit" ]
            , if canManageOrbitData then
                orbitDataActions state True Nothing

              else
                text ""
            ]
        , p [] [ text "Відсутні дані із системи Orbit." ]
        , if canLinkOrbitUnit then
            p [ class "mb-0" ]
                [ button
                    [ class "btn btn-outline-primary d-inline-flex align-items-center gap-2"
                    , type_ "button"
                    , onClick OpenOrbitLinkDialog
                    ]
                    [ img
                        [ src "/img/delta-icon.webp"
                        , alt ""
                        , style "height" "22px"
                        , style "width" "22px"
                        ]
                        []
                    , text "Прив'язати Orbit підрозділ"
                    ]
                ]

          else
            text ""
        , orbitNoteView orbitNote
        ]


unitOverviewCard : Bool -> Shared.Model -> Model -> B.UnitDetailsRsp -> Html Msg
unitOverviewCard canEdit shared state details =
    let
        unit =
            details.unit
    in
    div
        [ class "border rounded p-4 bg-card" ]
        [ if canEdit then
            div [ class "d-flex justify-content-end mb-3" ]
                [ unitOverviewActions state details.canCreateDeviceNetwork ]

          else
            text ""
        , div [ class "row g-4" ]
            [ overviewField "Назва" unit.name
            , overviewField "Інше" unit.other
            , overviewField "Команда/Екіпаж" unit.teamOrCrew
            , overviewField "Секція" unit.section
            , overviewField "Відділення" unit.squad
            , overviewField "Взвод" unit.platoon
            , overviewField "Рота" unit.company
            , overviewField "Батальйон" unit.battalion
            , overviewField "Полк" unit.regiment
            , overviewField "Бригада" unit.brigade
            , overviewField "Дивізія" unit.division
            , overviewField "Корпус" unit.corps
            , overviewField "Армія" unit.army
            , overviewField "Група армій/Фронт/Види та роди ЗС" unit.militaryDistrict
            , overviewField "Регіон/ТВД/Збройні Сили" unit.armyRegion
            , overviewField
                "Статус"
                (if unit.active then
                    "Активний"

                 else
                    "Неактивний"
                )
            , overviewField
                "Дата внесення"
                (Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix unit.createdAt)
                )
            , div [ class "col-12" ]
                [ div [ class "text-secondary text-sm mb-1" ] [ text "Коментар" ]
                , div
                    [ class "border rounded p-3"
                    , style "min-height" "96px"
                    , style "white-space" "pre-wrap"
                    , style "overflow-wrap" "anywhere"
                    ]
                    [ text (textOrDash unit.comment) ]
                ]
            ]
        ]


unitOverviewActions : Model -> Bool -> Html Msg
unitOverviewActions state canCreateDeviceNetwork =
    div [ class "dropdown" ]
        [ button
            [ class "btn btn-sm btn-link text-secondary p-1"
            , type_ "button"
            , disabled (state.unitEditDialogOpen /= Nothing || state.deviceNetworkDialogOpen || state.unitUpdating)
            , attribute "data-bs-toggle" "dropdown"
            , attribute "aria-expanded" "false"
            , attribute "aria-label" "Дії з даними підрозділу"
            ]
            [ i [ class "bi bi-three-dots-vertical" ] [] ]
        , ul [ class "dropdown-menu dropdown-menu-end" ]
            [ li []
                [ button
                    [ class "dropdown-item d-flex align-items-center gap-2"
                    , type_ "button"
                    , onClick (OpenUnitEditDialog UnitData)
                    ]
                    [ i [ class "bi bi-pencil" ] []
                    , text "Редагувати"
                    ]
                ]
            , if canCreateDeviceNetwork then
                li []
                    [ button
                        [ class "dropdown-item d-flex align-items-center gap-2"
                        , type_ "button"
                        , onClick OpenDeviceNetworkDialog
                        ]
                        [ i [ class "bi bi-router" ] []
                        , text "Додати мережу пристроя"
                        ]
                    ]

              else
                text ""
            ]
        ]


managementTab : Model -> B.UnitDetailsRsp -> Html Msg
managementTab model details =
    div
        [ class "flex flex-col gap-4"
        , attribute "role" "tabpanel"
        ]
        [ unitLabelsCard model details ]


unitLabelsCard : Model -> B.UnitDetailsRsp -> Html Msg
unitLabelsCard model details =
    let
        tooltip =
            "Якщо в перехопленні зустрічається такий синонім - ми прив'язуємо перехоплення до даного підрозділу"

        inputTooShort =
            String.length (String.trim model.unitLabelInput) < 2
    in
    div [ class "border rounded p-4 bg-card" ]
        [ div [ class "d-flex align-items-center gap-2 mb-3" ]
            [ h2 [ class "h4 mb-0" ] [ text "Синоніми підрозділу" ]
            , i
                [ class "bi bi-info-circle text-secondary"
                , title tooltip
                , attribute "aria-label" tooltip
                ]
                []
            ]
        , if List.isEmpty details.labels then
            p [ class "text-secondary" ] [ text "Синонімів немає." ]

          else
            unitLabelsTable model details.canEditUnitLabels details.labels
        , if details.canEditUnitLabels then
            div []
                [ div [ class "input-group", style "max-width" "560px" ]
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , value model.unitLabelInput
                        , placeholder "Введіть синонім підрозділу"
                        , disabled model.unitLabelSaving
                        , on "input" (Decode.map SetUnitLabelInput (Decode.at [ "target", "value" ] Decode.string))
                        ]
                        []
                    , button
                        [ class "btn btn-primary"
                        , type_ "button"
                        , disabled (inputTooShort || model.unitLabelSaving)
                        , onClick SubmitUnitLabel
                        ]
                        [ text
                            (if model.unitLabelSaving then
                                "Додавання…"

                             else
                                "Додати"
                            )
                        ]
                    ]
                , if not (String.isEmpty model.unitLabelInput) && inputTooShort then
                    div [ class "text-danger text-sm mt-1" ]
                        [ text "Синонім має містити щонайменше 2 символи." ]

                  else
                    text ""
                ]

          else
            text ""
        ]


unitLabelsTable : Model -> Bool -> List B.UnitLabel -> Html Msg
unitLabelsTable model canEdit labels =
    div [ class "table-responsive mb-3" ]
        [ table [ class "table table-bordered align-middle mb-0" ]
            [ thead []
                [ tr []
                    [ th [ scope "col" ] [ text "Синонім" ]
                    , th [ scope "col", class "text-end", style "width" "96px" ] [ text "Дії" ]
                    ]
                ]
            , tbody [] (List.map (unitLabelRow model canEdit) labels)
            ]
        ]


unitLabelRow : Model -> Bool -> B.UnitLabel -> Html Msg
unitLabelRow model canEdit label =
    tr []
        [ td [ class "text-break" ] [ text label.label ]
        , td [ class "text-end" ]
            [ if canEdit then
                button
                    [ class "btn btn-sm btn-outline-danger"
                    , type_ "button"
                    , title "Видалити синонім"
                    , attribute "aria-label" ("Видалити синонім " ++ label.label)
                    , disabled (model.unitLabelDeleting /= Nothing)
                    , onClick (DeleteUnitLabel label.id)
                    ]
                    [ if model.unitLabelDeleting == Just label.id then
                        span [ class "spinner-border spinner-border-sm" ] []

                      else
                        i [ class "bi bi-trash" ] []
                    ]

              else
                text ""
            ]
        ]


orbitNoteView : Maybe String -> Html Msg
orbitNoteView orbitNote =
    div [ class "mt-4" ]
        [ div [ class "text-secondary text-sm mb-1" ] [ text "Примітка Orbit" ]
        , div
            [ class "border rounded p-3"
            , style "min-height" "72px"
            , style "white-space" "pre-wrap"
            , style "overflow-wrap" "anywhere"
            ]
            [ text (textOrDash (Maybe.withDefault "" orbitNote)) ]
        ]


orbitDataCard : Bool -> Shared.Model -> Model -> Bool -> Maybe String -> B.OrbitUnitDetails -> Html Msg
orbitDataCard canManageOrbitData shared state showOrbitNote orbitNote orbitUnit =
    div [ class "border rounded p-4 bg-card" ]
        [ div [ class "d-flex align-items-center justify-content-between gap-3 mb-4" ]
            [ h2 [ class "h4 mb-0" ] [ text "Дані із Orbit" ]
            , if canManageOrbitData then
                orbitDataActions state showOrbitNote (Just orbitUnit)

              else
                text ""
            ]
        , orbitUnitDetails shared orbitUnit
        , if showOrbitNote then
            orbitNoteView orbitNote

          else
            text ""
        ]


orbitDataActions : Model -> Bool -> Maybe B.OrbitUnitDetails -> Html Msg
orbitDataActions state canEditNote orbitUnit =
    let
        isUnlinking =
            case orbitUnit of
                Just unit ->
                    state.orbitUnitUnlinking == Just unit.unitId

                Nothing ->
                    False

        actionLabel =
            if isUnlinking then
                "Відв’язування Orbit підрозділу"

            else
                "Дії з даними Orbit"
    in
    div [ class "dropdown" ]
        [ button
            [ class "btn btn-sm btn-link text-secondary"
            , type_ "button"
            , disabled (state.orbitUnitUnlinking /= Nothing || state.unitEditDialogOpen /= Nothing || state.unitUpdating)
            , attribute "data-bs-toggle" "dropdown"
            , attribute "aria-expanded" "false"
            , attribute "aria-label" actionLabel
            , attribute "aria-busy"
                (if isUnlinking then
                    "true"

                 else
                    "false"
                )
            ]
            [ if isUnlinking then
                span [ class "spinner-border spinner-border-sm" ] []

              else
                i [ class "bi bi-three-dots-vertical" ] []
            ]
        , ul [ class "dropdown-menu dropdown-menu-end" ]
            [ if canEditNote then
                li []
                    [ button
                        [ class "dropdown-item d-flex align-items-center gap-2"
                        , type_ "button"
                        , onClick (OpenUnitEditDialog OrbitData)
                        ]
                        [ i [ class "bi bi-pencil" ] []
                        , text "Редагувати дані Orbit"
                        ]
                    ]

              else
                text ""
            , case orbitUnit of
                Just unit ->
                    li []
                        [ button
                            [ class "dropdown-item text-danger d-flex align-items-center gap-2"
                            , type_ "button"
                            , disabled (state.orbitUnitUnlinking /= Nothing)
                            , onClick (UnlinkOrbitUnit unit)
                            ]
                            [ i [ class "bi bi-link-45deg" ] []
                            , text
                                (if isUnlinking then
                                    "Відв’язування…"

                                 else
                                    "Відв'язати Orbit підрозділ"
                                )
                            ]
                        ]

                Nothing ->
                    text ""
            ]
        ]


orbitUnitDetails : Shared.Model -> B.OrbitUnitDetails -> Html Msg
orbitUnitDetails shared orbitUnit =
    div []
        [ div [ class "mb-4" ]
            [ h3 [ class "h5" ] [ text (orbitUnitTitle orbitUnit) ]
            , p [ class "mb-0" ]
                [ a
                    [ class "btn btn-outline-primary d-inline-flex align-items-center gap-2"
                    , href
                        ("https://delta.mil.gov.ua/orbit/units/"
                            ++ orbitUnit.unitId
                            ++ "/organizational-structure"
                        )
                    , target "_blank"
                    , rel "noopener noreferrer"
                    ]
                    [ img
                        [ src "/img/delta-icon.webp"
                        , alt ""
                        , style "height" "22px"
                        , style "width" "22px"
                        ]
                        []
                    , text "Відкрити в Orbit"
                    ]
                ]
            ]
        , div [ class "row g-4" ]
            [ overviewField "ID підрозділу" orbitUnit.unitId
            , overviewMaybeField "Оригінальна назва" orbitUnit.unitNameOriginal
            , overviewParentUnits
                "Структурне підпорядкування"
                orbitUnit.generativeParentUnits
            , overviewParentUnits
                "Оперативне підпорядкування"
                orbitUnit.operationalParentUnits
            , overviewMaybeField "Номер підрозділу" orbitUnit.unitNumber
            , overviewMaybeListField "Альтернативні назви" orbitUnit.unitAlternateNames
            , overviewMaybeListField "Альтернативні номери" orbitUnit.unitAlternateNumbers
            , overviewField "Ешелон" (orbitDictionaryValue orbitUnit.unitEchelon)
            , overviewField "Тип бойового підрозділу" (orbitDictionaryValue orbitUnit.combatUnitType)
            , overviewField
                "Угруповання військ"
                (orbitUnit.groupingOfForces
                    |> List.map .name
                    |> String.join "\n"
                )
            , overviewField
                "Дата створення"
                (Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix orbitUnit.createdAt)
                )
            , overviewField
                "Дата оновлення"
                (Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix orbitUnit.updatedAt)
                )
            ]
        ]


orbitUnitTitle : B.OrbitUnitDetails -> String
orbitUnitTitle orbitUnit =
    case orbitUnit.unitName of
        Just name ->
            name

        Nothing ->
            Maybe.withDefault orbitUnit.unitId orbitUnit.unitNameShort


overviewMaybeField : String -> Maybe String -> Html Msg
overviewMaybeField labelText value =
    overviewField labelText (Maybe.withDefault "" value)


overviewMaybeListField : String -> Maybe (List String) -> Html Msg
overviewMaybeListField labelText values =
    overviewField labelText
        (values
            |> Maybe.withDefault []
            |> String.join "\n"
        )


orbitDictionaryValue : Maybe B.OrbitDictionaryValue -> String
orbitDictionaryValue value =
    value
        |> Maybe.map .name
        |> Maybe.withDefault ""


overviewParentUnits : String -> List B.OrbitParentUnit -> Html Msg
overviewParentUnits labelText parents =
    div [ class "col-md-6" ]
        [ div [ class "text-secondary text-sm mb-1" ] [ text labelText ]
        , div
            [ class "fw-semibold"
            , style "overflow-wrap" "anywhere"
            ]
            (if List.isEmpty parents then
                [ text "—" ]

             else
                parents
                    |> List.map
                        (\parent ->
                            case parent.sigintUnitId of
                                Just sigintUnitId ->
                                    a [ href ("/rer-units/" ++ String.fromInt sigintUnitId) ]
                                        [ text parent.name ]

                                Nothing ->
                                    text parent.name
                        )
                    |> List.intersperse (text " / ")
            )
        ]


overviewField : String -> String -> Html Msg
overviewField labelText value =
    div [ class "col-md-6" ]
        [ div [ class "text-secondary text-sm mb-1" ] [ text labelText ]
        , div
            [ class "fw-semibold"
            , style "white-space" "pre-wrap"
            , style "overflow-wrap" "anywhere"
            ]
            [ text (textOrDash value) ]
        ]


filesTab : Auth.User -> Shared.Model -> Model -> List B.UnitAttachment -> Html Msg
filesTab user shared model attachments =
    let
        isAdmin =
            Core.Auth.hasRole "Admin" user
    in
    div
        [ class "flex flex-col gap-4"
        , attribute "role" "tabpanel"
        ]
        [ if isAdmin then
            adminFiles model

          else
            attachmentsTable shared model attachments
        ]


adminFiles : Model -> Html Msg
adminFiles model =
    case model.unitId of
        Nothing ->
            text ""

        Just unitId ->
            node "unit-attachment-upload"
                [ attribute "data-unit-id" (String.fromInt unitId)
                , on "unit-attachments-uploaded" (Decode.succeed AttachmentsUploaded)
                ]
                []


attachmentsTable : Shared.Model -> Model -> List B.UnitAttachment -> Html Msg
attachmentsTable shared model attachments =
    if List.isEmpty attachments then
        div [ class "border rounded p-5 text-center text-secondary" ]
            [ text "Файлів немає." ]

    else
        div [ class "table-responsive" ]
            [ table [ class "table table-bordered align-middle mb-0" ]
                [ thead []
                    [ tr []
                        [ th [ scope "col" ] [ text "Файл" ]
                        , th [ scope "col" ] [ text "Короткий опис" ]
                        , th [ scope "col" ] [ text "Повний опис" ]
                        , th [ scope "col", class "text-nowrap" ] [ text "Дата внесення" ]
                        ]
                    ]
                , tbody []
                    (List.map (attachmentRow shared model) attachments)
                ]
            ]


attachmentRow : Shared.Model -> Model -> B.UnitAttachment -> Html Msg
attachmentRow shared model attachment =
    let
        isDownloading =
            model.downloadInProgress == Just attachment.id

        anyDownloadInProgress =
            model.downloadInProgress /= Nothing

    in
    tr [ style "height" "96px" ]
        [ td tallCellAttributes
            [ button
                [ class "btn btn-link p-0 text-start d-inline-flex align-items-center gap-2"
                , type_ "button"
                , Attr.disabled anyDownloadInProgress
                , onClick (DownloadAttachment attachment)
                ]
                [ if isDownloading then
                    span
                        [ class "spinner-border spinner-border-sm"
                        , attribute "role" "status"
                        ]
                        []

                  else
                    i [ class "bi bi-download" ] []
                , span [ class "text-break" ] [ text (downloadFileName attachment) ]
                ]
            , div [ class "small text-secondary mt-2" ]
                [ text (formatFileSize attachment.sizeBytes) ]
            ]
        , descriptionCell attachment.shortDescription
        , descriptionCell attachment.fullDescription
        , td tallCellAttributes
            [ text <|
                Utils.Time.renderDateTimeF1 shared.timeZone
                    (Time.millisToPosix attachment.createdAt)
            ]
        ]


tallCellAttributes : List (Html.Attribute msg)
tallCellAttributes =
    [ class "align-top"
    , style "height" "96px"
    , style "min-height" "96px"
    , style "vertical-align" "top"
    ]


descriptionCell : String -> Html msg
descriptionCell value =
    td tallCellAttributes
        [ div
            [ style "white-space" "pre-wrap"
            , style "overflow-wrap" "anywhere"
            , style "word-break" "break-word"
            ]
            [ text (textOrDash value) ]
        ]


textOrDash : String -> String
textOrDash value =
    if String.isEmpty (String.trim value) then
        "—"

    else
        value


formatFileSize : Int -> String
formatFileSize sizeBytes =
    if sizeBytes >= 1024 * 1024 then
        String.fromInt (sizeBytes // (1024 * 1024)) ++ " МБ"

    else if sizeBytes >= 1024 then
        String.fromInt (sizeBytes // 1024) ++ " КБ"

    else
        String.fromInt sizeBytes ++ " Б"
