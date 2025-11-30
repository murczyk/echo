module Pages.RerPalitra exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Core.Auth
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Select
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (on, onClick, onInput, targetValue)
import Html.Styled as Styled
import Json.Decode as Decode
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Platform.Sub as Sub
import Route exposing (Route)
import Select
import Shared
import Shared.Components.Badge as Badge
import Shared.Components.Button as Button
import Shared.Components.SegmentedControl as SegmentedControl
import Shared.Components.Sidebar as Sidebar
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Sorter as Sorter
import Shared.Model exposing (isDarkMode)
import String
import Utils.Api.ErrorHandling
import Utils.RemoteData exposing (RemoteData(..))
import Utils.Select
import View exposing (View)


type alias Model =
    { palitras : RemoteData ApiError (List B.Palitra)
    , tableState : Table.State
    , deleting : Maybe Int
    , uploadingPoints : Maybe Int
    , form : Form
    , submitInFlight : Bool
    , showCreateSidebar : Bool
    , editSidebar : Maybe Int
    , editForm : Maybe Form
    , editSubmitInFlight : Bool
    , myScope : RemoteData ApiError B.MyScope
    , loginsSelect :
        { state : Select.State
        , items : List (Select.MenuItem String)
        , selected : List String
        }
    , organismsSelect :
        { state : Select.State
        , items : List (Select.MenuItem Int)
        , selected : List Int
        }
    , aorSelect :
        { state : Select.State
        , items : List (Select.MenuItem Int)
        , selected : List Int
        }
    , logins : RemoteData ApiError B.ListLoginsRsp
    , organisms : RemoteData ApiError (List B.Organism)
    , aorList : RemoteData ApiError (List B.AreaOfResponsibility)
    }


type alias Form =
    { name : String
    , colorHex : String
    , access : AccessForm
    }


type AccessForm
    = LoginsAccess String
    | OrganismsAccess String
    | AorAccess String


normalizeAccessForm : AccessForm -> AccessForm
normalizeAccessForm access =
    case access of
        LoginsAccess _ ->
            LoginsAccess ""

        OrganismsAccess _ ->
            OrganismsAccess ""

        AorAccess _ ->
            AorAccess ""


type Msg
    = NoOp
    | PalitraListResp (Result ApiError (List B.Palitra))
    | TableStateChanged Table.State
    | DeleteRequested Int
    | DeleteResponse Int (Result ApiError ())
    | UploadPointsClicked Int
    | FileSelectedForUpload Int File
    | UploadPointsResponse Int (Result ApiError ())
    | UpdateForm (Form -> Form)
    | ChangeAccess AccessForm
    | ShowCreateSidebar
    | CloseCreateSidebar
    | SubmitCreate
    | CreateResponse (Result ApiError B.Palitra)
    | OpenEditSidebar Int
    | CloseEditSidebar
    | UpdateEditForm (Form -> Form)
    | SubmitEdit
    | UpdateResponse Int (Result ApiError B.PalitraDetails)
    | MyScopeResp (Result ApiError B.MyScope)
    | LoginsSelectMsg (Select.Msg String)
    | OrganismsSelectMsg (Select.Msg Int)
    | AorSelectMsg (Select.Msg Int)
    | LoginsResp (Result ApiError B.ListLoginsRsp)
    | OrganismsResp (Result ApiError (List B.Organism))
    | AorListResp (Result ApiError (List B.AreaOfResponsibility))


isAdmin : Auth.User -> Bool
isAdmin user =
    Core.Auth.hasRole "Admin" user


init : Auth.User -> () -> ( Model, Effect Msg )
init user _ =
    let
        admin =
            isAdmin user

        adminCmds =
            if admin then
                [ Api.list_organisms OrganismsResp { sortBy = Nothing }
                , Api.aor_list AorListResp { sortBy = Nothing }
                ]

            else
                []
    in
    ( { palitras = Loading
      , tableState = Table.initialSort "Назва"
      , deleting = Nothing
      , uploadingPoints = Nothing
      , form = emptyForm
      , submitInFlight = False
      , showCreateSidebar = False
      , editSidebar = Nothing
      , editForm = Nothing
      , editSubmitInFlight = False
      , myScope = Loading
      , loginsSelect =
            { state = Select.initState (Select.selectIdentifier "sel-logins")
            , items = []
            , selected = []
            }
      , organismsSelect =
            { state = Select.initState (Select.selectIdentifier "sel-organisms")
            , items = []
            , selected = []
            }
      , aorSelect =
            { state = Select.initState (Select.selectIdentifier "sel-aor")
            , items = []
            , selected = []
            }
      , logins = NotAsked
      , organisms =
            if admin then
                Loading

            else
                NotAsked
      , aorList =
            if admin then
                Loading

            else
                NotAsked
      }
    , E.sendCmd <|
        Cmd.batch
            ([ Api.palitra_list PalitraListResp
             , Api.my_scope MyScopeResp
             ]
                ++ adminCmds
            )
    )


emptyForm : Form
emptyForm =
    { name = ""
    , colorHex = "#00bcd4"
    , access = LoginsAccess ""
    }


update : Auth.User -> Msg -> Model -> ( Model, Effect Msg )
update user msg model =
    case msg of
        NoOp ->
            ( model, E.none )

        PalitraListResp (Ok list) ->
            ( { model | palitras = Success list }, E.none )

        PalitraListResp (Err err) ->
            ( { model | palitras = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити палітри" err
            )

        TableStateChanged state ->
            ( { model | tableState = state }, E.none )

        DeleteRequested palitraId ->
            ( { model | deleting = Just palitraId }
            , E.sendCmd <| Api.palitra_delete (DeleteResponse palitraId) palitraId
            )

        DeleteResponse palitraId (Ok _) ->
            case model.palitras of
                Success list ->
                    ( { model
                        | palitras = Success <| List.filter (\p -> p.id /= palitraId) list
                        , deleting = Nothing
                      }
                    , E.none
                    )

                _ ->
                    ( { model | deleting = Nothing }, E.none )

        DeleteResponse _ (Err err) ->
            ( { model | deleting = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося видалити палітру" err
            )

        UploadPointsClicked palitraId ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    [ "application/vnd.google-earth.kmz"
                    , "application/vnd.google-earth.kml+xml"
                    , ".kmz"
                    , ".kml"
                    ]
                    (FileSelectedForUpload palitraId)
            )

        FileSelectedForUpload palitraId file ->
            ( { model | uploadingPoints = Just palitraId }
            , E.sendCmd <| Api.palitra_upload_points (UploadPointsResponse palitraId) palitraId file
            )

        UploadPointsResponse _ (Ok _) ->
            ( { model | uploadingPoints = Nothing }
            , E.batch
                [ E.sendCmd <| Api.palitra_list PalitraListResp
                ]
            )

        UploadPointsResponse _ (Err err) ->
            ( { model | uploadingPoints = Nothing }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити точки" err
            )

        UpdateForm fn ->
            ( { model | form = fn model.form }, E.none )

        ChangeAccess access ->
            let
                -- Синхронізуємо select states з новим типом доступу
                ( loginsSelect, organismsSelect, aorSelect ) =
                    case access of
                        LoginsAccess logins ->
                            let
                                ls =
                                    model.loginsSelect

                                selected =
                                    logins
                                        |> String.split ","
                                        |> List.map String.trim
                                        |> List.filter (\s -> s /= "")
                            in
                            ( { ls | selected = selected }, model.organismsSelect, model.aorSelect )

                        OrganismsAccess ids ->
                            let
                                os =
                                    model.organismsSelect

                                selected =
                                    ids
                                        |> String.split ","
                                        |> List.filter (\s -> s /= "")
                                        |> List.filterMap String.toInt
                            in
                            ( model.loginsSelect, { os | selected = selected }, model.aorSelect )

                        AorAccess ids ->
                            let
                                as_ =
                                    model.aorSelect

                                selected =
                                    ids
                                        |> String.split ","
                                        |> List.filter (\s -> s /= "")
                                        |> List.filterMap String.toInt
                            in
                            ( model.loginsSelect, model.organismsSelect, { as_ | selected = selected } )
            in
            if model.editSidebar /= Nothing then
                -- Оновлюємо editForm
                case model.editForm of
                    Just editForm ->
                        ( { model
                            | editForm = Just { editForm | access = access }
                            , loginsSelect = loginsSelect
                            , organismsSelect = organismsSelect
                            , aorSelect = aorSelect
                          }
                        , E.none
                        )

                    Nothing ->
                        ( { model
                            | loginsSelect = loginsSelect
                            , organismsSelect = organismsSelect
                            , aorSelect = aorSelect
                          }
                        , E.none
                        )

            else
                -- Оновлюємо form
                let
                    form =
                        model.form

                    form1 =
                        { form | access = access }
                in
                ( { model
                    | form = form1
                    , loginsSelect = loginsSelect
                    , organismsSelect = organismsSelect
                    , aorSelect = aorSelect
                  }
                , E.none
                )

        ShowCreateSidebar ->
            let
                -- Завантажуємо scope якщо ще не завантажено
                scopeCmd =
                    if model.myScope == NotAsked then
                        Api.my_scope MyScopeResp

                    else
                        Cmd.none

                -- Завантажуємо дані для Admin якщо ще не завантажені
                adminDataCmds =
                    if isAdmin user then
                        [ if model.logins == NotAsked then
                            Api.list_logins LoginsResp { sortBy = Nothing, filterByRoles = Nothing }

                          else
                            Cmd.none
                        , if model.organisms == NotAsked then
                            Api.list_organisms OrganismsResp { sortBy = Nothing }

                          else
                            Cmd.none
                        , if model.aorList == NotAsked then
                            Api.aor_list AorListResp { sortBy = Nothing }

                          else
                            Cmd.none
                        ]

                    else
                        []

                allCmds =
                    (scopeCmd :: adminDataCmds) |> List.filter (\cmd -> cmd /= Cmd.none)

                -- Автоматично заповнюємо форму для не-admin користувачів
                initialForm =
                    if isAdmin user then
                        emptyForm

                    else
                        -- Для не-admin автоматично підставляємо логін
                        { emptyForm | access = LoginsAccess user.name }

                -- Синхронізуємо select з формою
                loginsSelect =
                    if isAdmin user then
                        model.loginsSelect

                    else
                        let
                            ls =
                                model.loginsSelect
                        in
                        { ls | selected = [ user.name ] }
            in
            ( { model
                | showCreateSidebar = True
                , form = initialForm
                , loginsSelect = loginsSelect
                , aorSelect =
                    case ( isAdmin user, model.myScope ) of
                        ( False, Success scope ) ->
                            let
                                items =
                                    scope.aors
                                        |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                                currentAorSelect =
                                    model.aorSelect

                                selectedAors =
                                    if List.isEmpty model.aorSelect.selected then
                                        scope.aorIds

                                    else
                                        model.aorSelect.selected
                            in
                            { currentAorSelect | items = items, selected = selectedAors }

                        _ ->
                            model.aorSelect
                , myScope =
                    if model.myScope == NotAsked then
                        Loading

                    else
                        model.myScope
                , logins =
                    if isAdmin user && model.logins == NotAsked then
                        Loading

                    else
                        model.logins
                , organisms =
                    if isAdmin user && model.organisms == NotAsked then
                        Loading

                    else
                        model.organisms
                , aorList =
                    if isAdmin user && model.aorList == NotAsked then
                        Loading

                    else
                        model.aorList
              }
            , if List.isEmpty allCmds then
                E.none

              else
                E.sendCmd <| Cmd.batch allCmds
            )

        MyScopeResp (Ok scope) ->
            let
                aorItems =
                    scope.aors
                        |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                allowedAorIds =
                    scope.aorIds

                currentSelected =
                    model.aorSelect.selected
                        |> List.filter (\id -> List.member id allowedAorIds)

                defaultSelected =
                    if List.isEmpty currentSelected then
                        allowedAorIds

                    else
                        currentSelected

                currentAorSelect =
                    model.aorSelect

                updatedAorSelect =
                    if isAdmin user then
                        currentAorSelect

                    else
                        { currentAorSelect
                            | items = aorItems
                            , selected = defaultSelected
                        }
            in
            ( { model
                | myScope = Success scope
                , aorSelect = updatedAorSelect
              }
            , E.none
            )

        MyScopeResp (Err err) ->
            ( { model | myScope = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити ваші дані" err
            )

        CloseCreateSidebar ->
            let
                -- Очищаємо select states
                loginsSelect =
                    model.loginsSelect

                organismsSelect =
                    model.organismsSelect

                aorSelect =
                    model.aorSelect
            in
            ( { model
                | showCreateSidebar = False
                , form = emptyForm
                , loginsSelect = { loginsSelect | selected = [] }
                , organismsSelect = { organismsSelect | selected = [] }
                , aorSelect = { aorSelect | selected = [] }
              }
            , E.none
            )

        SubmitCreate ->
            if isFormValid model.form then
                let
                    req =
                        buildCreateReq model.form
                in
                ( { model | submitInFlight = True }
                , E.sendCmd <| Api.palitra_create CreateResponse req
                )

            else
                -- Форма невалідна, не відправляємо запит (це не має статися при правильній роботі UI)
                ( model, E.none )

        CreateResponse (Ok p) ->
            let
                newList =
                    case model.palitras of
                        Success list ->
                            Success (p :: list)

                        _ ->
                            Success [ p ]

                -- Очищаємо select states
                loginsSelect =
                    model.loginsSelect

                organismsSelect =
                    model.organismsSelect

                aorSelect =
                    model.aorSelect
            in
            ( { model
                | palitras = newList
                , form = emptyForm
                , submitInFlight = False
                , showCreateSidebar = False
                , loginsSelect = { loginsSelect | selected = [] }
                , organismsSelect = { organismsSelect | selected = [] }
                , aorSelect = { aorSelect | selected = [] }
              }
            , E.none
            )

        CreateResponse (Err err) ->
            ( { model | submitInFlight = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося створити палітру" err
            )

        LoginsSelectMsg selectMsg ->
            let
                ( mAction, newState, selectCmd ) =
                    Select.update selectMsg model.loginsSelect.state

                updatedSelected =
                    Utils.Select.multiUpdS mAction model.loginsSelect.selected

                loginsSelect =
                    model.loginsSelect

                newSelect =
                    { loginsSelect | state = newState, selected = updatedSelected }

                accessValue =
                    LoginsAccess (String.join "," updatedSelected)
            in
            if model.editSidebar /= Nothing then
                -- Оновлюємо editForm
                case model.editForm of
                    Just editForm ->
                        ( { model
                            | loginsSelect = newSelect
                            , editForm = Just { editForm | access = accessValue }
                          }
                        , E.sendCmd <| Cmd.map LoginsSelectMsg selectCmd
                        )

                    Nothing ->
                        ( { model | loginsSelect = newSelect }
                        , E.sendCmd <| Cmd.map LoginsSelectMsg selectCmd
                        )

            else
                -- Оновлюємо form
                let
                    form =
                        model.form

                    newForm =
                        { form | access = accessValue }
                in
                ( { model | loginsSelect = newSelect, form = newForm }
                , E.sendCmd <| Cmd.map LoginsSelectMsg selectCmd
                )

        OrganismsSelectMsg selectMsg ->
            let
                ( mAction, newState, selectCmd ) =
                    Select.update selectMsg model.organismsSelect.state

                updatedSelected =
                    Utils.Select.multiUpdI mAction model.organismsSelect.selected

                organismsSelect =
                    model.organismsSelect

                newSelect =
                    { organismsSelect | state = newState, selected = updatedSelected }

                accessValue =
                    OrganismsAccess (String.join "," (List.map String.fromInt updatedSelected))
            in
            if model.editSidebar /= Nothing then
                -- Оновлюємо editForm
                case model.editForm of
                    Just editForm ->
                        ( { model
                            | organismsSelect = newSelect
                            , editForm = Just { editForm | access = accessValue }
                          }
                        , E.sendCmd <| Cmd.map OrganismsSelectMsg selectCmd
                        )

                    Nothing ->
                        ( { model | organismsSelect = newSelect }
                        , E.sendCmd <| Cmd.map OrganismsSelectMsg selectCmd
                        )

            else
                -- Оновлюємо form
                let
                    form =
                        model.form

                    newForm =
                        { form | access = accessValue }
                in
                ( { model | organismsSelect = newSelect, form = newForm }
                , E.sendCmd <| Cmd.map OrganismsSelectMsg selectCmd
                )

        AorSelectMsg selectMsg ->
            let
                ( mAction, newState, selectCmd ) =
                    Select.update selectMsg model.aorSelect.state

                updatedSelected =
                    Utils.Select.multiUpdI mAction model.aorSelect.selected

                aorSelect =
                    model.aorSelect

                newSelect =
                    { aorSelect | state = newState, selected = updatedSelected }

                accessValue =
                    AorAccess (String.join "," (List.map String.fromInt updatedSelected))
            in
            if model.editSidebar /= Nothing then
                -- Оновлюємо editForm
                case model.editForm of
                    Just editForm ->
                        ( { model
                            | aorSelect = newSelect
                            , editForm = Just { editForm | access = accessValue }
                          }
                        , E.sendCmd <| Cmd.map AorSelectMsg selectCmd
                        )

                    Nothing ->
                        ( { model | aorSelect = newSelect }
                        , E.sendCmd <| Cmd.map AorSelectMsg selectCmd
                        )

            else
                -- Оновлюємо form
                let
                    form =
                        model.form

                    newForm =
                        { form | access = accessValue }
                in
                ( { model | aorSelect = newSelect, form = newForm }
                , E.sendCmd <| Cmd.map AorSelectMsg selectCmd
                )

        LoginsResp (Ok loginsResp) ->
            let
                loginsSelect =
                    model.loginsSelect

                items =
                    loginsResp.users
                        |> List.map (\login -> Select.basicMenuItem { item = login.login, label = login.login })

                newSelect =
                    { loginsSelect | items = items }
            in
            ( { model | logins = Success loginsResp, loginsSelect = newSelect }, E.none )

        LoginsResp (Err err) ->
            ( { model | logins = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити логіни" err
            )

        OrganismsResp (Ok orgs) ->
            let
                organismsSelect =
                    model.organismsSelect

                items =
                    orgs
                        |> List.map (\org -> Select.basicMenuItem { item = org.id, label = org.name })

                newSelect =
                    { organismsSelect | items = items }
            in
            ( { model | organisms = Success orgs, organismsSelect = newSelect }, E.none )

        OrganismsResp (Err err) ->
            ( { model | organisms = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити підрозділи" err
            )

        AorListResp (Ok aors) ->
            let
                aorSelect =
                    model.aorSelect

                items =
                    aors
                        |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })

                newSelect =
                    { aorSelect | items = items }
            in
            ( { model | aorList = Success aors, aorSelect = newSelect }, E.none )

        AorListResp (Err err) ->
            ( { model | aorList = Failure err }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося завантажити смуги" err
            )

        OpenEditSidebar palitraId ->
            case model.palitras of
                Success list ->
                    case ListX.find (\p -> p.id == palitraId) list of
                        Just palitra ->
                            let
                                initializedForm =
                                    palitraToForm palitra

                                -- Завантажуємо scope якщо ще не завантажено
                                scopeCmd =
                                    if model.myScope == NotAsked then
                                        Api.my_scope MyScopeResp

                                    else
                                        Cmd.none

                                -- Завантажуємо дані для Admin якщо ще не завантажені
                                adminDataCmds =
                                    if isAdmin user then
                                        [ if model.logins == NotAsked then
                                            Api.list_logins LoginsResp { sortBy = Nothing, filterByRoles = Nothing }

                                          else
                                            Cmd.none
                                        , if model.organisms == NotAsked then
                                            Api.list_organisms OrganismsResp { sortBy = Nothing }

                                          else
                                            Cmd.none
                                        , if model.aorList == NotAsked then
                                            Api.aor_list AorListResp { sortBy = Nothing }

                                          else
                                            Cmd.none
                                        ]

                                    else
                                        []

                                allCmds =
                                    (scopeCmd :: adminDataCmds) |> List.filter (\cmd -> cmd /= Cmd.none)

                                -- Синхронізуємо select states з формою
                                ( loginsSelect, organismsSelect, aorSelect ) =
                                    case initializedForm.access of
                                        LoginsAccess logins ->
                                            let
                                                ls =
                                                    model.loginsSelect

                                                selected =
                                                    logins
                                                        |> String.split ","
                                                        |> List.map String.trim
                                                        |> List.filter (\s -> s /= "")
                                            in
                                            ( { ls | selected = selected }, model.organismsSelect, model.aorSelect )

                                        OrganismsAccess ids ->
                                            let
                                                os =
                                                    model.organismsSelect

                                                selected =
                                                    ids
                                                        |> String.split ","
                                                        |> List.filter (\s -> s /= "")
                                                        |> List.filterMap String.toInt
                                            in
                                            ( model.loginsSelect, { os | selected = selected }, model.aorSelect )

                                        AorAccess ids ->
                                            let
                                                as_ =
                                                    model.aorSelect

                                                selected =
                                                    ids
                                                        |> String.split ","
                                                        |> List.filter (\s -> s /= "")
                                                        |> List.filterMap String.toInt
                                            in
                                            ( model.loginsSelect, model.organismsSelect, { as_ | selected = selected } )
                            in
                            ( { model
                                | editSidebar = Just palitraId
                                , editForm = Just initializedForm
                                , myScope =
                                    if model.myScope == NotAsked then
                                        Loading

                                    else
                                        model.myScope
                                , logins =
                                    if isAdmin user && model.logins == NotAsked then
                                        Loading

                                    else
                                        model.logins
                                , organisms =
                                    if isAdmin user && model.organisms == NotAsked then
                                        Loading

                                    else
                                        model.organisms
                                , aorList =
                                    if isAdmin user && model.aorList == NotAsked then
                                        Loading

                                    else
                                        model.aorList
                                , loginsSelect = loginsSelect
                                , organismsSelect = organismsSelect
                                , aorSelect = aorSelect
                              }
                            , if List.isEmpty allCmds then
                                E.none

                              else
                                E.sendCmd <| Cmd.batch allCmds
                            )

                        Nothing ->
                            ( model, E.none )

                _ ->
                    ( model, E.none )

        CloseEditSidebar ->
            ( { model | editSidebar = Nothing, editForm = Nothing }, E.none )

        UpdateEditForm fn ->
            case model.editForm of
                Just form ->
                    let
                        updatedForm =
                            fn form

                        -- Синхронізуємо select states з новим типом доступу
                        ( loginsSelect, organismsSelect, aorSelect ) =
                            case updatedForm.access of
                                LoginsAccess logins ->
                                    let
                                        ls =
                                            model.loginsSelect

                                        selected =
                                            logins
                                                |> String.split ","
                                                |> List.map String.trim
                                                |> List.filter (\s -> s /= "")
                                    in
                                    ( { ls | selected = selected }, model.organismsSelect, model.aorSelect )

                                OrganismsAccess ids ->
                                    let
                                        os =
                                            model.organismsSelect

                                        selected =
                                            ids
                                                |> String.split ","
                                                |> List.filter (\s -> s /= "")
                                                |> List.filterMap String.toInt
                                    in
                                    ( model.loginsSelect, { os | selected = selected }, model.aorSelect )

                                AorAccess ids ->
                                    let
                                        as_ =
                                            model.aorSelect

                                        selected =
                                            ids
                                                |> String.split ","
                                                |> List.filter (\s -> s /= "")
                                                |> List.filterMap String.toInt
                                    in
                                    ( model.loginsSelect, model.organismsSelect, { as_ | selected = selected } )
                    in
                    ( { model
                        | editForm = Just updatedForm
                        , loginsSelect = loginsSelect
                        , organismsSelect = organismsSelect
                        , aorSelect = aorSelect
                      }
                    , E.none
                    )

                Nothing ->
                    ( model, E.none )

        SubmitEdit ->
            case ( model.editSidebar, model.editForm ) of
                ( Just palitraId, Just form ) ->
                    if isFormValid form then
                        let
                            req =
                                buildCreateReq form
                        in
                        ( { model | editSubmitInFlight = True }
                        , E.sendCmd <| Api.palitra_update (UpdateResponse palitraId) palitraId req
                        )

                    else
                        -- Форма невалідна, не відправляємо запит (це не має статися при правильній роботі UI)
                        ( model, E.none )

                _ ->
                    ( model, E.none )

        UpdateResponse palitraId (Ok palitraDetails) ->
            let
                updatedList =
                    case model.palitras of
                        Success list ->
                            list
                                |> List.map
                                    (\p ->
                                        if p.id == palitraId then
                                            palitraDetails.palitra

                                        else
                                            p
                                    )
                                |> Success

                        _ ->
                            model.palitras
            in
            ( { model
                | palitras = updatedList
                , editSidebar = Nothing
                , editForm = Nothing
                , editSubmitInFlight = False
              }
            , E.none
            )

        UpdateResponse _ (Err err) ->
            ( { model | editSubmitInFlight = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Не вдалося оновити палітру" err
            )


view : Auth.User -> Shared.Model -> Model -> View Msg
view user shared model =
    let
        isDark =
            isDarkMode shared.themeMode
    in
    { title = "палітри"
    , body =
        [ div
            [ classList [ ( "overflow-hidden", model.showCreateSidebar || model.editSidebar /= Nothing ) ]
            , class "w-5/6 mx-auto"
            ]
            [ Sidebar.view model.showCreateSidebar CloseCreateSidebar (createPalitraSidebarContent isDark user model)
            , case model.editSidebar of
                Just _ ->
                    Sidebar.view True CloseEditSidebar (editPalitraSidebarContent isDark user model)

                Nothing ->
                    text ""
            , case model.palitras of
                Loading ->
                    div [ class "p-4" ] [ Shared.Components.Spinner.loadingSpinner2Sm ]

                Failure _ ->
                    div [ class "p-4 text-red-600" ] [ text "Не вдалося завантажити палітри" ]

                Success pal ->
                    div []
                        [ div []
                            [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Палітри" ]
                            , div [ class "mb-4 flex justify-end" ]
                                [ Button.new { label = "Додати палітру", onClick = ShowCreateSidebar }
                                    |> Button.view
                                ]
                            , div [ class "table-responsive-modern" ] [ renderTable user model pal ]
                            ]
                        ]

                NeedsReload _ ->
                    text ""

                NotAsked ->
                    text ""
            ]
        ]
    }


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init user
        , update = update user
        , view = view user shared
        , subscriptions = \_ -> Sub.none
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "etalonka"
        }


renderTable : Auth.User -> Model -> List B.Palitra -> Html Msg
renderTable user model palitras =
    let
        canDelete palitra =
            Core.Auth.hasRole "Admin" user
                || (Maybe.withDefault "" palitra.author == user.name)

        defaultCustomizations =
            Table.defaultCustomizations

        customizations =
            { defaultCustomizations
                | tableAttrs = [ class "base-table" ]
            }

        tableConfig : Table.Config B.Palitra Msg
        tableConfig =
            Table.customConfig
                { toId = .id >> String.fromInt
                , toMsg = TableStateChanged
                , customizations = customizations
                , columns =
                    [ Table.stringColumn "Назва" .name
                    , Table.veryCustomColumn
                        { name = "Колір"
                        , viewData =
                            \p ->
                                { attributes = [ class "col-narrow" ]
                                , children =
                                    [ span
                                        [ class "inline-block w-6 h-6 rounded"
                                        , style "background" p.colorHex
                                        , style "display" "inline-block"
                                        ]
                                        []
                                    ]
                                }
                        , sorter = Sorter.increasingOrDecreasingBy .colorHex
                        }
                    , Table.stringColumn "Файл" (\p -> Maybe.withDefault "—" p.sourceFileName)
                    , Table.stringColumn "Автор" (\p -> Maybe.withDefault "—" p.author)
                    , Table.veryCustomColumn
                        { name = "Доступ"
                        , viewData =
                            \p ->
                                { attributes = []
                                , children = [ renderAccessCompact user model.myScope model.organisms model.aorList p ]
                                }
                        , sorter = Sorter.unsortable
                        }
                    , Table.veryCustomColumn
                        { name = "Дія"
                        , viewData =
                            \p ->
                                let
                                    isDeleting =
                                        model.deleting == Just p.id

                                    isUploading =
                                        model.uploadingPoints == Just p.id

                                    canModify =
                                        canDelete p
                                in
                                { attributes = [ class "col-narrow" ]
                                , children =
                                    if canModify then
                                        [ div [ class "flex gap-[4px] text-sm items-center" ]
                                            [ button
                                                [ title "Редагувати"
                                                , class "icon-btn icon-btn-primary"
                                                , onClick (OpenEditSidebar p.id)
                                                ]
                                                [ i [ class "bi bi-pencil" ] [] ]
                                            , button
                                                [ title "Завантажити точки"
                                                , class "icon-btn icon-btn-primary"
                                                , onClick
                                                    (if isUploading then
                                                        NoOp

                                                     else
                                                        UploadPointsClicked p.id
                                                    )
                                                , Attr.disabled isUploading
                                                ]
                                                [ i [ class "bi bi-cloud-upload" ] [] ]
                                            , button
                                                [ title "Видалити"
                                                , class "icon-btn icon-btn-danger"
                                                , onClick
                                                    (if isDeleting then
                                                        NoOp

                                                     else
                                                        DeleteRequested p.id
                                                    )
                                                , Attr.disabled isDeleting
                                                ]
                                                [ i [ class "bi bi-trash" ] [] ]
                                            , if isDeleting || isUploading then
                                                Shared.Components.Spinner.loadingSpinner2Sm

                                              else
                                                text ""
                                            ]
                                        ]

                                    else
                                        [ text "" ]
                                }
                        , sorter = Sorter.unsortable
                        }
                    ]
                }
    in
    Table.view tableConfig model.tableState palitras


renderAccessCompact : Auth.User -> RemoteData ApiError B.MyScope -> RemoteData ApiError (List B.Organism) -> RemoteData ApiError (List B.AreaOfResponsibility) -> B.Palitra -> Html Msg
renderAccessCompact user myScopeData organismsData aorData p =
    let
        admin =
            isAdmin user

        isAuthor =
            Maybe.withDefault "" p.author == user.name

        canSeeAccess =
            admin || isAuthor

        maxShow =
            2

        renderList : List String -> Html Msg
        renderList items =
            let
                shown =
                    List.take maxShow items

                remaining =
                    List.length items - maxShow
            in
            div [ class "flex flex-col gap-1" ]
                [ div [ class "text-xs" ]
                    [ text (String.join ", " shown)
                    , if remaining > 0 then
                        span [ class "text-muted-foreground" ] [ text (" (+" ++ String.fromInt remaining ++ " ще)") ]

                      else
                        text ""
                    ]
                ]
    in
    if not canSeeAccess then
        div [ class "text-xs text-muted-foreground" ] [ text "—" ]

    else if not (List.isEmpty p.accessLogins) then
        div []
            [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Логіни" ]
            , renderList p.accessLogins
            ]

    else if not (List.isEmpty p.accessOrganismIds) then
        if admin then
            case organismsData of
                Success organisms ->
                    let
                        names =
                            p.accessOrganismIds
                                |> List.filterMap
                                    (\id ->
                                        ListX.find (\org -> org.id == id) organisms
                                            |> Maybe.map .name
                                    )
                    in
                    div []
                        [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Підрозділи" ]
                        , renderList names
                        ]

                Loading ->
                    div [ class "text-xs text-muted-foreground" ] [ text "завантаження..." ]

                _ ->
                    div []
                        [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Підрозділи" ]
                        , div [ class "text-xs" ] [ text (String.fromInt (List.length p.accessOrganismIds) ++ " шт") ]
                        ]

        else
            -- Не-Admin автор - показуємо з myScope
            case myScopeData of
                Success myScope ->
                    case myScope.organism of
                        Just organism ->
                            div []
                                [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Підрозділи" ]
                                , renderList [ organism.name ]
                                ]

                        Nothing ->
                            div [ class "text-xs text-muted-foreground" ] [ text "—" ]

                _ ->
                    div [ class "text-xs text-muted-foreground" ] [ text "завантаження..." ]

    else if not (List.isEmpty p.accessAorId) then
        if admin then
            case aorData of
                Success aors ->
                    let
                        names =
                            p.accessAorId
                                |> List.filterMap
                                    (\id ->
                                        ListX.find (\aor -> aor.id == id) aors
                                            |> Maybe.map .name
                                    )
                    in
                    div []
                        [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Смуги" ]
                        , renderList names
                        ]

                Loading ->
                    div [ class "text-xs text-muted-foreground" ] [ text "завантаження..." ]

                _ ->
                    div []
                        [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Смуги" ]
                        , div [ class "text-xs" ] [ text (String.fromInt (List.length p.accessAorId) ++ " шт") ]
                        ]

        else
            -- Не-Admin автор - показуємо назви смуг з p.accessAorId, але тільки ті, що є в myScope.aorIds
            case myScopeData of
                Success myScope ->
                    let
                        allowedAorIds =
                            myScope.aorIds

                        names =
                            p.accessAorId
                                |> List.filter (\id -> List.member id allowedAorIds)
                                |> List.filterMap
                                    (\id ->
                                        myScope.aors
                                            |> ListX.find (\aor -> aor.id == id)
                                            |> Maybe.map .name
                                    )

                        namesOrIds =
                            if List.isEmpty names then
                                p.accessAorId
                                    |> List.filter (\id -> List.member id allowedAorIds)
                                    |> List.map String.fromInt

                            else
                                names
                    in
                    div []
                        [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Смуги" ]
                        , renderList namesOrIds
                        ]

                _ ->
                    div [ class "text-xs text-muted-foreground" ] [ text "завантаження..." ]

    else
        div [ class "text-xs text-muted-foreground" ] [ text "без доступу" ]



-- Визначає, чи користувач є Editor (може вибирати, але значення автоматичні)


isEditor : Auth.User -> Bool
isEditor user =
    Core.Auth.hasRole "UnitsEditor" user
        || Core.Auth.hasRole "CallsignsEditor" user



-- Визначає доступні типи доступу для користувача


getAvailableAccessTypes : Auth.User -> B.MyScope -> List AccessForm
getAvailableAccessTypes user myScope =
    let
        admin =
            isAdmin user

        editor =
            isEditor user

        hasOrganism =
            case myScope.organism of
                Just _ ->
                    True

                Nothing ->
                    False

        hasAorIds =
            not (List.isEmpty myScope.aorIds)
    in
    List.filterMap identity
        [ Just (LoginsAccess "")
        , if admin || hasOrganism then
            Just (OrganismsAccess "")

          else
            Nothing
        , if admin || (editor && hasAorIds) then
            Just (AorAccess "")

          else
            Nothing
        ]



-- Визначає, чи опція доступу обмежена для користувача (readonly)
-- Тільки Admin може вводити вручну, Editor і Rer мають readonly поля


isAccessRestricted : Auth.User -> AccessForm -> Bool
isAccessRestricted user access =
    let
        admin =
            isAdmin user
    in
    case access of
        LoginsAccess _ ->
            not admin

        OrganismsAccess _ ->
            not admin

        AorAccess _ ->
            not admin



-- Отримує підказку для типу доступу


getAccessHint : Auth.User -> AccessForm -> Maybe String
getAccessHint user access =
    if isAccessRestricted user access then
        case access of
            LoginsAccess _ ->
                if isEditor user then
                    Just "Редактор може надати доступ лише власному логіну"

                else
                    Just "Тільки ваш логін"

            OrganismsAccess _ ->
                if isEditor user then
                    Just "Редактор може надати доступ лише власному підрозділу"

                else
                    Just "Тільки ваші підрозділи"

            AorAccess _ ->
                if isEditor user then
                    Just "Редактор може надати доступ лише до смуг свого підрозділу"

                else
                    Nothing

    else
        Nothing



-- Валідація форми перед відправкою


isFormValid : Form -> Bool
isFormValid form =
    if String.isEmpty form.name then
        False

    else
        case form.access of
            LoginsAccess logins ->
                let
                    loginList =
                        logins
                            |> String.split ","
                            |> List.map String.trim
                            |> List.filter (\s -> s /= "")
                in
                not (List.isEmpty loginList)

            OrganismsAccess ids ->
                let
                    organismList =
                        ids
                            |> String.split ","
                            |> List.filter (\s -> s /= "")
                            |> List.filterMap String.toInt
                in
                not (List.isEmpty organismList)

            AorAccess ids ->
                let
                    aorList =
                        ids
                            |> String.split ","
                            |> List.filter (\s -> s /= "")
                            |> List.filterMap String.toInt
                in
                not (List.isEmpty aorList)


createPalitraSidebarContent : Bool -> Auth.User -> Model -> List (Html Msg)
createPalitraSidebarContent isDark user model =
    let
        myScope =
            case model.myScope of
                Success scope ->
                    scope

                _ ->
                    -- Default empty scope для випадку коли ще не завантажено
                    { organism = Nothing, aorIds = [], aors = [] }

        availableAccessTypes =
            getAvailableAccessTypes user myScope

        ( accessFields, accessHint ) =
            case model.form.access of
                LoginsAccess _ ->
                    let
                        loginRestricted =
                            isAccessRestricted user (LoginsAccess "")

                        loginField =
                            if loginRestricted then
                                -- Readonly поле для Editor і Rer
                                div
                                    [ class "w-full px-3 py-2 border border-dashed border-border rounded-md bg-muted/40 text-foreground flex items-center justify-between" ]
                                    [ span [] [ text user.name ]
                                    , span [ class "text-xs text-muted-foreground" ] [ text "Автоматично" ]
                                    ]

                            else
                                -- elm-select для Admin
                                Html.map LoginsSelectMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelect
                                            (model.loginsSelect.selected
                                                |> List.map (\login -> Select.basicMenuItem { item = login, label = login })
                                            )
                                            model.loginsSelect.state
                                            model.loginsSelect.items
                                            "Оберіть логіни"
                                            (Utils.Select.defaultOptions isDark)
                    in
                    ( [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ]
                                [ text
                                    (if loginRestricted then
                                        "Ваш логін"

                                     else
                                        "Логіни"
                                    )
                                ]
                            , loginField
                            ]
                      ]
                    , getAccessHint user (LoginsAccess "")
                    )

                OrganismsAccess _ ->
                    let
                        organismRestricted =
                            isAccessRestricted user (OrganismsAccess "")

                        organismField =
                            if organismRestricted then
                                -- Для Editor і Rer - показуємо readonly поле
                                case model.myScope of
                                    Success scope ->
                                        case scope.organism of
                                            Just organism ->
                                                div [ class "flex flex-col gap-2" ]
                                                    [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Ваш підрозділ" ]
                                                    , Badge.view organism.name
                                                    ]

                                            Nothing ->
                                                div [ class "text-xs text-red-500" ]
                                                    [ text "Вашому логіну не призначено підрозділ. Зверніться до адміністратора." ]

                                    Loading ->
                                        div [ class "flex flex-col gap-2" ]
                                            [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Ваш підрозділ" ]
                                            , Shared.Components.Spinner.loadingSpinner2Sm
                                            ]

                                    _ ->
                                        div [ class "text-xs text-muted-foreground" ]
                                            [ text "Завантаження..." ]

                            else
                                -- elm-select для Admin
                                Html.map OrganismsSelectMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelect
                                            (model.organismsSelect.selected
                                                |> List.map
                                                    (\id ->
                                                        case model.organisms of
                                                            Success orgs ->
                                                                ListX.find (\org -> org.id == id) orgs
                                                                    |> Maybe.map (\org -> Select.basicMenuItem { item = id, label = org.name })
                                                                    |> Maybe.withDefault (Select.basicMenuItem { item = id, label = "Unknown" })

                                                            _ ->
                                                                Select.basicMenuItem { item = id, label = "Loading..." }
                                                    )
                                            )
                                            model.organismsSelect.state
                                            model.organismsSelect.items
                                            "Оберіть підрозділи"
                                            (Utils.Select.defaultOptions isDark)
                    in
                    ( [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Підрозділи" ]
                            , organismField
                            ]
                      ]
                    , getAccessHint user (OrganismsAccess "")
                    )

                AorAccess _ ->
                    let
                        aorRestricted =
                            isAccessRestricted user (AorAccess "")

                        aorField =
                            if aorRestricted then
                                case model.myScope of
                                    Success scope ->
                                        if List.isEmpty scope.aors then
                                            div [ class "text-xs text-red-500" ]
                                                [ text "У вашому підрозділі немає призначених смуг (AOR). Зверніться до адміністратора або оберіть інший тип доступу." ]

                                        else
                                            let
                                                baseOptions =
                                                    Utils.Select.defaultOptions isDark

                                                selectOptions =
                                                    { baseOptions | clearable = False }
                                            in
                                            Html.map AorSelectMsg <|
                                                Styled.toUnstyled <|
                                                    Utils.Select.renderSelect
                                                        (model.aorSelect.selected
                                                            |> List.filterMap
                                                                (\id ->
                                                                    scope.aors
                                                                        |> ListX.find (\aor -> aor.id == id)
                                                                        |> Maybe.map (\aor -> Select.basicMenuItem { item = id, label = aor.name })
                                                                )
                                                        )
                                                        model.aorSelect.state
                                                        (scope.aors
                                                            |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })
                                                        )
                                                        "Оберіть смуги"
                                                        selectOptions

                                    Loading ->
                                        div [ class "flex flex-col gap-2" ]
                                            [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Завантаження смуг..." ]
                                            , Shared.Components.Spinner.loadingSpinner2Sm
                                            ]

                                    _ ->
                                        div [ class "text-xs text-muted-foreground" ]
                                            [ text "Завантаження..." ]

                            else
                                let
                                    baseOptions =
                                        Utils.Select.defaultOptions isDark

                                    selectOptions =
                                        { baseOptions | clearable = False }
                                in
                                -- elm-select для Admin
                                Html.map AorSelectMsg <|
                                    Styled.toUnstyled <|
                                        Utils.Select.renderSelect
                                            (model.aorSelect.selected
                                                |> List.map
                                                    (\id ->
                                                        case model.aorList of
                                                            Success aors ->
                                                                ListX.find (\aor -> aor.id == id) aors
                                                                    |> Maybe.map (\aor -> Select.basicMenuItem { item = id, label = aor.name })
                                                                    |> Maybe.withDefault (Select.basicMenuItem { item = id, label = "Unknown" })

                                                            _ ->
                                                                Select.basicMenuItem { item = id, label = "Loading..." }
                                                    )
                                        )
                                        model.aorSelect.state
                                        model.aorSelect.items
                                        "Оберіть смуги"
                                        selectOptions
                    in
                    ( [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Смуги (AOR)" ]
                            , aorField
                            ]
                      ]
                    , getAccessHint user (AorAccess "")
                    )

        accessOptions =
            List.filterMap
                (\accessType ->
                    let
                        normalized =
                            normalizeAccessForm accessType
                    in
                    case normalized of
                        LoginsAccess _ ->
                            Just { value = normalized, label = "Логіни" }

                        OrganismsAccess _ ->
                            Just { value = normalized, label = "Підрозділи" }

                        AorAccess _ ->
                            Just { value = normalized, label = "Смуги" }
                )
                availableAccessTypes

        accessSegmentOnChange accessForm =
            case accessForm of
                LoginsAccess _ ->
                    let
                        restrictedLogin =
                            isAccessRestricted user (LoginsAccess "")
                    in
                    if restrictedLogin then
                        ChangeAccess (LoginsAccess user.name)

                    else
                        ChangeAccess accessForm

                OrganismsAccess _ ->
                    let
                        restrictedOrganism =
                            isAccessRestricted user (OrganismsAccess "")
                    in
                    if restrictedOrganism then
                        -- Для не-admin підставляємо organismId з myScope
                        case model.myScope of
                            Success scope ->
                                case scope.organism of
                                    Just organism ->
                                        ChangeAccess (OrganismsAccess (String.fromInt organism.id))

                                    Nothing ->
                                        -- Не повинно статися, бо getAvailableAccessTypes це відфільтрує
                                        ChangeAccess accessForm

                            _ ->
                                -- myScope ще не завантажено
                                ChangeAccess accessForm

                    else
                        ChangeAccess accessForm

                AorAccess _ ->
                    let
                        admin =
                            isAdmin user
                    in
                    if not admin then
                        -- Editor і Rer автоматично використовують свої AOR IDS
                        case model.myScope of
                            Success scope ->
                                ChangeAccess (AorAccess (String.join "," (List.map String.fromInt scope.aorIds)))

                            _ ->
                                ChangeAccess accessForm

                    else
                        ChangeAccess accessForm
    in
    [ div [ class "flex flex-col h-full" ]
        [ div [ class "p-6 border-b border-border" ]
            [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Створити палітру" ]
            ]
        , div [ class "flex-1 overflow-y-auto p-6" ]
            [ div [ class "space-y-6" ]
                [ div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва *" ]
                    , input
                        [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                        , type_ "text"
                        , placeholder "Назва палітри"
                        , value model.form.name
                        , onInput (\v -> UpdateForm (\f -> { f | name = v }))
                        ]
                        []
                    ]
                , div [ class "flex flex-col gap-2" ]
                    [ label
                        [ class "text-sm font-medium text-foreground"
                        , style "display" "block"
                        ]
                        [ text "Колір" ]
                    , input
                        [ type_ "color"
                        , class "w-16 h-10 border border-border rounded-md"
                        , value model.form.colorHex
                        , on "change" (Decode.map (\v -> UpdateForm (\f -> { f | colorHex = v })) targetValue)
                        ]
                        []
                    ]
                , div [ class "space-y-2" ]
                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Доступ" ]
                    , div [ class "flex flex-wrap gap-2" ]
                        [ SegmentedControl.new
                            (normalizeAccessForm model.form.access)
                            accessSegmentOnChange
                            accessOptions
                            |> SegmentedControl.view
                        ]
                    , case accessHint of
                        Just hint ->
                            div [ class "text-xs text-muted-foreground mt-1" ] [ text hint ]

                        Nothing ->
                            text ""
                    , div [] accessFields
                    ]
                ]
            ]
        , div [ class "p-6 border-t border-border bg-muted/30" ]
            [ div [ class "flex justify-end gap-3" ]
                [ Button.new { label = "Скасувати", onClick = CloseCreateSidebar }
                    |> Button.withStyleSecondary
                    |> Button.view
                , Button.new
                    { label = "Створити"
                    , onClick =
                        if model.submitInFlight then
                            NoOp

                        else
                            SubmitCreate
                    }
                    |> Button.withDisabled model.submitInFlight
                    |> Button.view
                ]
            ]
        ]
    ]


buildCreateReq : Form -> B.CreatePalitraReq
buildCreateReq form =
    { name = form.name
    , colorHex = form.colorHex
    , access = accessToBinding form.access
    , sourceFileName = Nothing
    , lastUploadedAtTs = Nothing
    }


accessToBinding : AccessForm -> B.PalitraAccess
accessToBinding accessForm =
    case accessForm of
        LoginsAccess logins ->
            let
                items =
                    logins
                        |> String.split ","
                        |> List.map String.trim
                        |> List.filter (\s -> s /= "")
            in
            B.ByLogins { logins = items }

        OrganismsAccess ids ->
            let
                items =
                    ids
                        |> String.split ","
                        |> List.filter (\s -> s /= "")
                        |> List.filterMap String.toInt
            in
            B.ByOrganisms { organismIds = items }

        AorAccess ids ->
            let
                items =
                    ids
                        |> String.split ","
                        |> List.filter (\s -> s /= "")
                        |> List.filterMap String.toInt
            in
            B.ByAor { aorIds = items }


editPalitraSidebarContent : Bool -> Auth.User -> Model -> List (Html Msg)
editPalitraSidebarContent isDark user model =
    case model.editForm of
        Just editForm ->
            let
                myScope =
                    case model.myScope of
                        Success scope ->
                            scope

                        _ ->
                            { organism = Nothing, aorIds = [], aors = [] }

                availableAccessTypes =
                    getAvailableAccessTypes user myScope

                ( accessFields, accessHint ) =
                    case editForm.access of
                        LoginsAccess _ ->
                            let
                                loginRestricted =
                                    isAccessRestricted user (LoginsAccess "")

                                loginField =
                                    if loginRestricted then
                                        div
                                            [ class "w-full px-3 py-2 border border-dashed border-border rounded-md bg-muted/40 text-foreground flex items-center justify-between" ]
                                            [ span [] [ text user.name ]
                                            , span [ class "text-xs text-muted-foreground" ] [ text "Автоматично" ]
                                            ]

                                    else
                                        Html.map LoginsSelectMsg <|
                                            Styled.toUnstyled <|
                                                Utils.Select.renderSelect
                                                    (model.loginsSelect.selected
                                                        |> List.map (\login -> Select.basicMenuItem { item = login, label = login })
                                                    )
                                                    model.loginsSelect.state
                                                    model.loginsSelect.items
                                                    "Оберіть логіни"
                                                    (Utils.Select.defaultOptions isDark)
                            in
                            ( [ div [ class "space-y-2" ]
                                    [ label [ class "text-sm font-medium text-foreground" ]
                                        [ text
                                            (if loginRestricted then
                                                "Ваш логін"

                                             else
                                                "Логіни"
                                            )
                                        ]
                                    , loginField
                                    ]
                              ]
                            , getAccessHint user (LoginsAccess "")
                            )

                        OrganismsAccess _ ->
                            let
                                organismRestricted =
                                    isAccessRestricted user (OrganismsAccess "")

                                organismField =
                                    if organismRestricted then
                                        case model.myScope of
                                            Success scope ->
                                                case scope.organism of
                                                    Just organism ->
                                                        div [ class "flex flex-col gap-2" ]
                                                            [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Ваш підрозділ" ]
                                                            , Badge.view organism.name
                                                            ]

                                                    Nothing ->
                                                        div [ class "text-xs text-red-500" ]
                                                            [ text "Вашому логіну не призначено підрозділ. Зверніться до адміністратора." ]

                                            Loading ->
                                                div [ class "flex flex-col gap-2" ]
                                                    [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Ваш підрозділ" ]
                                                    , Shared.Components.Spinner.loadingSpinner2Sm
                                                    ]

                                            _ ->
                                                div [ class "text-xs text-muted-foreground" ]
                                                    [ text "Завантаження..." ]

                                    else
                                        Html.map OrganismsSelectMsg <|
                                            Styled.toUnstyled <|
                                                Utils.Select.renderSelect
                                                    (model.organismsSelect.selected
                                                        |> List.map
                                                            (\id ->
                                                                case model.organisms of
                                                                    Success orgs ->
                                                                        ListX.find (\org -> org.id == id) orgs
                                                                            |> Maybe.map (\org -> Select.basicMenuItem { item = id, label = org.name })
                                                                            |> Maybe.withDefault (Select.basicMenuItem { item = id, label = "Unknown" })

                                                                    _ ->
                                                                        Select.basicMenuItem { item = id, label = "Loading..." }
                                                            )
                                                    )
                                                    model.organismsSelect.state
                                                    model.organismsSelect.items
                                                    "Оберіть підрозділи"
                                                    (Utils.Select.defaultOptions isDark)
                            in
                            ( [ div [ class "space-y-2" ]
                                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Підрозділи" ]
                                    , organismField
                                    ]
                              ]
                            , getAccessHint user (OrganismsAccess "")
                            )

                        AorAccess _ ->
                            let
                                aorRestricted =
                                    isAccessRestricted user (AorAccess "")

                                aorField =
                                    if aorRestricted then
                                        case model.myScope of
                                            Success scope ->
                                                if List.isEmpty scope.aors then
                                                    div [ class "text-xs text-red-500" ]
                                                        [ text "У вашому підрозділі немає призначених смуг (AOR). Зверніться до адміністратора або оберіть інший тип доступу." ]

                                                else
                                                    let
                                                        baseOptions =
                                                            Utils.Select.defaultOptions isDark

                                                        selectOptions =
                                                            { baseOptions | clearable = False }
                                                    in
                                                    Html.map AorSelectMsg <|
                                                        Styled.toUnstyled <|
                                                            Utils.Select.renderSelect
                                                                (model.aorSelect.selected
                                                                    |> List.filterMap
                                                                        (\id ->
                                                                            scope.aors
                                                                                |> ListX.find (\aor -> aor.id == id)
                                                                                |> Maybe.map (\aor -> Select.basicMenuItem { item = id, label = aor.name })
                                                                        )
                                                            )
                                                            model.aorSelect.state
                                                            (scope.aors
                                                                |> List.map (\aor -> Select.basicMenuItem { item = aor.id, label = aor.name })
                                                            )
                                                            "Оберіть смуги"
                                                            selectOptions

                                            Loading ->
                                                div [ class "flex flex-col gap-2" ]
                                                    [ div [ class "text-xs text-muted-foreground uppercase" ] [ text "Завантаження смуг..." ]
                                                    , Shared.Components.Spinner.loadingSpinner2Sm
                                                    ]

                                            _ ->
                                                div [ class "text-xs text-muted-foreground" ]
                                                    [ text "Завантаження..." ]

                                    else
                                        let
                                            baseOptions =
                                                Utils.Select.defaultOptions isDark

                                            selectOptions =
                                                { baseOptions | clearable = False }
                                        in
                                        Html.map AorSelectMsg <|
                                            Styled.toUnstyled <|
                                                Utils.Select.renderSelect
                                                    (model.aorSelect.selected
                                                        |> List.map
                                                            (\id ->
                                                                case model.aorList of
                                                                    Success aors ->
                                                                        ListX.find (\aor -> aor.id == id) aors
                                                                            |> Maybe.map (\aor -> Select.basicMenuItem { item = id, label = aor.name })
                                                                            |> Maybe.withDefault (Select.basicMenuItem { item = id, label = "Unknown" })

                                                                    _ ->
                                                                        Select.basicMenuItem { item = id, label = "Loading..." }
                                                            )
                                                )
                                                model.aorSelect.state
                                                model.aorSelect.items
                                                "Оберіть смуги"
                                                selectOptions
                            in
                            ( [ div [ class "space-y-2" ]
                                    [ label [ class "text-sm font-medium text-foreground" ] [ text "Смуги (AOR)" ]
                                    , aorField
                                    ]
                              ]
                            , getAccessHint user (AorAccess "")
                            )

                accessOptions =
                    List.filterMap
                        (\accessType ->
                            let
                                normalized =
                                    normalizeAccessForm accessType
                            in
                            case normalized of
                                LoginsAccess _ ->
                                    Just { value = normalized, label = "Логіни" }

                                OrganismsAccess _ ->
                                    Just { value = normalized, label = "Підрозділи" }

                                AorAccess _ ->
                                    Just { value = normalized, label = "Смуги" }
                        )
                        availableAccessTypes

                accessSegmentOnChange accessForm =
                    case accessForm of
                        LoginsAccess _ ->
                            let
                                restrictedLogin =
                                    isAccessRestricted user (LoginsAccess "")
                            in
                            if restrictedLogin then
                                ChangeAccess (LoginsAccess user.name)

                            else
                                ChangeAccess accessForm

                        OrganismsAccess _ ->
                            let
                                restrictedOrganism =
                                    isAccessRestricted user (OrganismsAccess "")
                            in
                            if restrictedOrganism then
                                -- Для не-admin підставляємо organismId з myScope
                                case model.myScope of
                                    Success scope ->
                                        case scope.organism of
                                            Just organism ->
                                                ChangeAccess (OrganismsAccess (String.fromInt organism.id))

                                            Nothing ->
                                                -- Не повинно статися, бо getAvailableAccessTypes це відфільтрує
                                                ChangeAccess accessForm

                                    _ ->
                                        -- myScope ще не завантажено
                                        ChangeAccess accessForm

                            else
                                ChangeAccess accessForm

                        AorAccess _ ->
                            let
                                admin =
                                    isAdmin user
                            in
                            if not admin then
                                case model.myScope of
                                    Success scope ->
                                        ChangeAccess (AorAccess (String.join "," (List.map String.fromInt scope.aorIds)))

                                    _ ->
                                        ChangeAccess accessForm

                            else
                                ChangeAccess accessForm
            in
            [ div [ class "flex flex-col h-full" ]
                [ div [ class "p-6 border-b border-border" ]
                    [ h2 [ class "text-lg font-semibold mb-1" ] [ text "Редагувати палітру" ]
                    ]
                , div [ class "flex-1 overflow-y-auto p-6" ]
                    [ div [ class "space-y-6" ]
                        [ div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Назва *" ]
                            , input
                                [ class "w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
                                , type_ "text"
                        , placeholder "Назва палітри"
                        , value editForm.name
                        , onInput (\v -> UpdateEditForm (\f -> { f | name = v }))
                        ]
                        []
                    ]
                , div [ class "flex flex-col gap-2" ]
                    [ label
                        [ class "text-sm font-medium text-foreground"
                        , style "display" "block"
                        ]
                        [ text "Колір" ]
                    , input
                        [ type_ "color"
                        , class "w-16 h-10 border border-border rounded-md"
                        , value editForm.colorHex
                        , on "change" (Decode.map (\v -> UpdateEditForm (\f -> { f | colorHex = v })) targetValue)
                        ]
                                []
                            ]
                        , div [ class "space-y-2" ]
                            [ label [ class "text-sm font-medium text-foreground" ] [ text "Доступ" ]
                            , div [ class "flex flex-wrap gap-2" ]
                                [ SegmentedControl.new
                                    (normalizeAccessForm editForm.access)
                                    accessSegmentOnChange
                                    accessOptions
                                    |> SegmentedControl.view
                                ]
                            , case accessHint of
                                Just hint ->
                                    div [ class "text-xs text-muted-foreground mt-1" ] [ text hint ]

                                Nothing ->
                                    text ""
                            , div [] accessFields
                            ]
                        ]
                    ]
                , div [ class "p-6 border-t border-border bg-muted/30" ]
                    [ div [ class "flex justify-end gap-3" ]
                        [ Button.new { label = "Скасувати", onClick = CloseEditSidebar }
                            |> Button.withStyleSecondary
                            |> Button.view
                        , Button.new
                            { label = "Зберегти"
                            , onClick =
                                if model.editSubmitInFlight then
                                    NoOp

                                else
                                    SubmitEdit
                            }
                            |> Button.withDisabled model.editSubmitInFlight
                            |> Button.view
                        ]
                    ]
                ]
            ]

        Nothing ->
            []


palitraToForm : B.Palitra -> Form
palitraToForm palitra =
    let
        access =
            if not (List.isEmpty palitra.accessLogins) then
                LoginsAccess (String.join "," palitra.accessLogins)

            else if not (List.isEmpty palitra.accessOrganismIds) then
                OrganismsAccess (String.join "," (List.map String.fromInt palitra.accessOrganismIds))

            else if not (List.isEmpty palitra.accessAorId) then
                AorAccess (String.join "," (List.map String.fromInt palitra.accessAorId))

            else
                LoginsAccess ""
    in
    { name = palitra.name
    , colorHex = palitra.colorHex
    , access = access
    }
