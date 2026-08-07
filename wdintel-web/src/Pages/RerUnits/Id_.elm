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
    | ChildUnits


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
    , downloadInProgress : Maybe Int
    , orbitLinkDialogOpen : Bool
    , orbitUnitUnlinking : Maybe String
    , deviceNetworkDialogOpen : Bool
    , unitEditDialogOpen : Maybe UnitEditSection
    , unitUpdating : Bool
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
            if Dict.get "tab" route.query == Just "files" then
                Files

            else
                Overview
      , childUnits = Nothing
      , childUnitsLoading = False
      , downloadInProgress = Nothing
      , orbitLinkDialogOpen = False
      , orbitUnitUnlinking = Nothing
      , deviceNetworkDialogOpen = False
      , unitEditDialogOpen = Nothing
      , unitUpdating = False
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
                , activeTab =
                    if model.activeTab == ChildUnits && List.isEmpty details.orbitUnits then
                        Overview

                    else
                        model.activeTab
                , childUnits =
                    if List.isEmpty details.orbitUnits then
                        Nothing

                    else
                        model.childUnits
              }
            , E.none
            )


changeTab : Tab -> Model -> ( Model, Effect Msg )
changeTab tab state =
    if tab == ChildUnits && state.childUnits == Nothing && not state.childUnitsLoading then
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
                        | company = req.company
                        , battalion = req.battalion
                        , regiment = req.regiment
                        , division = req.division
                        , army = req.army
                        , militaryDistrict = req.militaryDistrict
                        , armyRegion = req.armyRegion
                        , active = req.active
                        , isDeduplicateCandidate = req.isDeduplicateCandidate
                        , comment = req.comment
                        , orbitNote = req.orbitNote
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
                      }
                    , E.none
                    )


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
        , deviceNetworkDialog model details
        , unitEditDialog model details.unit
        , orbitLinkDialog model
        , tabsView model.activeTab (not (List.isEmpty details.orbitUnits))
        , case model.activeTab of
            Overview ->
                overviewTab user shared model details

            Files ->
                filesTab user shared model details.attachments

            ChildUnits ->
                childUnitsTab model
        ]


orbitLinkDialog : Model -> Html Msg
orbitLinkDialog model =
    case ( model.orbitLinkDialogOpen, model.unitId ) of
        ( True, Just unitId ) ->
            node "orbit-unit-link-dialog"
                [ attribute "data-unit-id" (String.fromInt unitId)
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
                    { path = Route.Path.RerUnits
                    , query = Dict.empty
                    , hash = Nothing
                    }
                ]
                [ i [ class "bi bi-arrow-left me-2" ] []
                , text "До підрозділів"
                ]
            , h1 [ class "mb-0" ] [ text details.unit.name ]
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
            , disabled (model.unitEditDialogOpen /= Nothing || model.deviceNetworkDialogOpen || model.unitUpdating)
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


tabsView : Tab -> Bool -> Html Msg
tabsView activeTab hasOrbitUnit =
    let
        tabButton tab label =
            button
                [ class "px-4 py-2 text-sm font-medium border-b-2 bg-transparent"
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
        [ class "d-flex border-bottom"
        , attribute "role" "tablist"
        ]
        [ tabButton Overview "Огляд"
        , tabButton Files "Файли"
        , if hasOrbitUnit then
            tabButton ChildUnits "Підпорядковані підрозділи"

          else
            text ""
        ]


childUnitsTab : Model -> Html Msg
childUnitsTab state =
    div
        [ class "border rounded p-4 bg-card"
        , attribute "role" "tabpanel"
        ]
        [ case state.childUnits of
            Just childUnits ->
                div [ class "row g-4" ]
                    [ childUnitColumn
                        "Структурне підпорядкування"
                        childUnits.generativeUnits
                    , childUnitColumn
                        "Оперативне підпорядкування"
                        childUnits.operationalUnits
                    ]

            Nothing ->
                if state.childUnitsLoading then
                    div [ class "flex justify-center py-8" ]
                        [ Shared.Components.Spinner.loadingSpinner ]

                else
                    text ""
        ]


childUnitColumn : String -> List B.OrbitChildUnit -> Html Msg
childUnitColumn titleText units =
    div [ class "col-md-6" ]
        [ h2 [ class "h4 mb-3" ] [ text titleText ]
        , if List.isEmpty units then
            p [ class "text-secondary mb-0" ]
                [ text "Немає прив’язаних підрозділів." ]

          else
            div [ class "list-group" ]
                (List.map childUnitLink units)
        ]


childUnitLink : B.OrbitChildUnit -> Html Msg
childUnitLink unit =
    a
        [ class "list-group-item list-group-item-action"
        , href ("/rer-units/" ++ String.fromInt unit.sigintUnitId)
        , target "_blank"
        , rel "noopener noreferrer"
        ]
        [ text unit.name ]


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
                orbitDataActions state True canLinkOrbitUnit Nothing

              else
                text ""
            ]
        , orbitNoteView orbitNote
        , p [] [ text "Відсутні дані із системи Orbit." ]
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
            [ overviewField "Рота, взвод" unit.company
            , overviewField "Батальйон" unit.battalion
            , overviewField "Полк/Бригада" unit.regiment
            , overviewField "Дивізія" unit.division
            , overviewField "Корпус/Армія" unit.army
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


orbitNoteView : Maybe String -> Html Msg
orbitNoteView orbitNote =
    div [ class "mb-4" ]
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
                orbitDataActions state showOrbitNote False (Just orbitUnit)

              else
                text ""
            ]
        , if showOrbitNote then
            orbitNoteView orbitNote

          else
            text ""
        , orbitUnitDetails shared orbitUnit
        ]


orbitDataActions : Model -> Bool -> Bool -> Maybe B.OrbitUnitDetails -> Html Msg
orbitDataActions state canEditNote canLinkOrbitUnit orbitUnit =
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
                        , text "Редагувати примітку Orbit"
                        ]
                    ]

              else
                text ""
            , if canLinkOrbitUnit then
                li []
                    [ button
                        [ class "dropdown-item d-flex align-items-center gap-2"
                        , type_ "button"
                        , onClick OpenOrbitLinkDialog
                        ]
                        [ i [ class "bi bi-link-45deg" ] []
                        , text "Прив'язати Orbit підрозділ"
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
