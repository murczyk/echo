module Pages.RerUnits exposing (EditUnitState, Model, Msg, RemovingDuplicateProcess, page)

import Api
import Auth
import Bindings as B
import Core.Auth
import Core.Types exposing (ApiError)
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import File exposing (File)
import File.Select
import Html exposing (..)
import Html.Attributes as Attr exposing (..)
import Html.Events exposing (..)
import Layouts
import List.Extra as ListX
import Page exposing (Page)
import Process
import Route exposing (Route)
import Shared
import Shared.Components.Button as Button
import Shared.Components.Checkbox as Checkbox
import Shared.Components.Console
import Shared.Components.Popup
import Shared.Components.Spinner
import Shared.Model exposing (isDarkMode)
import Task
import Time
import Utils.Api.ErrorHandling
import Utils.Time
import Utils.Utils as UtilsU
import View exposing (View)


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared _ =
    Page.new
        { init = init
        , update = update
        , view = view (isDarkMode shared.themeMode) shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user _ =
    Layouts.Navbar
        { user = user
        , activeName = "rer-units"
        }


type alias Model =
    { units : List B.Unit
    , inpCompany : String
    , inpBattalion : String
    , inpRegiment : String
    , inpDivision : String
    , inpArmy : String
    , inpComment : String
    , inpActive : Bool
    , editUnit : Dict Int EditUnitState
    , deleteUnitConfirmation : Maybe Int
    , console : Shared.Components.Console.Model
    , actionsPopupUnitId : Maybe Int
    , removingDuplicateProcess : RemovingDuplicateProcess
    , removeDuplicateLoading : Bool
    , filterActive : Bool
    , filterDivision : String
    , filterArmy : String
    , filterRegiment : String
    , filterBattalion : String
    , filterCompany : String
    , addUnitConfirmation : Maybe AddUnitConfirmation
    }


type RemovingDuplicateProcess
    = NotStarted
    | UnitSelected Int
    | UnitDuplicateSelected Int Int


type alias AddUnitConfirmation =
    { skipNetworkCreation : Bool
    , locations : List String
    , locationDraft : String
    , unitMask : List String
    , unitMaskDraft : String
    , validationError : Maybe String
    , saving : Bool
    }


loadUnits : Effect Msg
loadUnits =
    E.getUnits GotUnits
        { sortBy = Nothing
        , afterUnitId = Nothing
        , beforeUnitId = Nothing
        }


init : () -> ( Model, Effect Msg )
init _ =
    ( { units = []
      , inpCompany = ""
      , inpBattalion = ""
      , inpRegiment = ""
      , inpDivision = ""
      , inpArmy = ""
      , inpComment = ""
      , inpActive = True
      , editUnit = Dict.empty
      , deleteUnitConfirmation = Nothing
      , console = Shared.Components.Console.init
      , actionsPopupUnitId = Nothing
      , removeDuplicateLoading = False
      , removingDuplicateProcess = NotStarted
      , filterActive = False
      , filterDivision = ""
      , filterArmy = ""
      , filterRegiment = ""
      , filterBattalion = ""
      , filterCompany = ""
      , addUnitConfirmation = Nothing
      }
    , E.batch
        [ loadUnits
        ]
    )


type Msg
    = GotUnits (Result ApiError B.ListUnitsRsp)
    | InpCompany String
    | InpBattalion String
    | InpRegiment String
    | InpDivision String
    | InpArmy String
    | AddUnit (Maybe Bool)
    | AddUnitDone (Result ApiError B.Unit)
    | CloseAddUnitConfirmation
    | AddUnitSkipNetwork Bool
    | AddUnitLocationDraftChanged String
    | AddUnitLocationKeyDown Int
    | AddUnitLocationCommit
    | AddUnitLocationRemove String
    | AddUnitMaskDraftChanged String
    | AddUnitMaskKeyDown Int
    | AddUnitMaskCommit
    | AddUnitMaskRemove String
    | AddUnitConfirm
    | AddUnitWithAutoNetworkDone (Result ApiError B.CreateUnitWithAutoNetworkRsp)
    | InpComment String
    | InpActive Bool
    | EditUnit Int
    | EditUnitMsg Int EditUnitState
    | EditUnitSave Int
    | EditUnitDone Int (Result ApiError B.Unit)
    | EditUnitCancel Int
    | DeleteUnit Int
    | DeleteUnitConfirm
    | DeleteUnitCancel
    | DeleteUnitDone (Result ApiError B.Unit)
    | ClearInputs
    | LoadKMZ
    | LoadKMZSelected File
    | LoadKMZDone File (Result ApiError Int)
    | ConsoleMsg (Shared.Components.Console.Msg Msg)
    | OpenUnitActionsPopup Int
    | CloseUnitActionsPopup
    | FixUnitDuplicates Int
    | FinishFixingUnitDuplicates
    | RemoveDuplicate Int
    | RemoveDuplicateCancel
    | RemoveDuplicateConfirm
    | RemoveDuplicateDone (Result ApiError B.Unit)
    | FilterActive Bool
    | FilterDivision String
    | FilterArmy String
    | FilterRegiment String
    | FilterBattalion String
    | FilterCompany String
    | ClearFilters


type alias EditUnitState =
    { inpCompany : String
    , inpBattalion : String
    , inpRegiment : String
    , inpDivision : String
    , inpArmy : String
    , inpComment : String
    , inpActive : Bool
    }


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        GotUnits (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження підрозділів" err
            )

        GotUnits (Ok rsp) ->
            let
                units =
                    rsp.units
            in
            ( { model | units = units }
            , E.none
            )

        InpCompany v ->
            ( { model | inpCompany = v }, E.none )

        InpBattalion v ->
            ( { model | inpBattalion = v }, E.none )

        InpRegiment v ->
            ( { model | inpRegiment = v }, E.none )

        InpDivision v ->
            ( { model | inpDivision = v }, E.none )

        InpArmy v ->
            ( { model | inpArmy = v }, E.none )

        InpActive v ->
            ( { model | inpActive = v }, E.none )

        InpComment v ->
            ( { model | inpComment = v }, E.none )

        AddUnit maybeDevicesSectionEnabled ->
            case maybeDevicesSectionEnabled of
                Just True ->
                    ( { model | addUnitConfirmation = Just (initAddUnitConfirmation model) }
                    , E.none
                    )

                Just False ->
                    ( model
                    , E.sendCmd <|
                        Api.sigint_unit_create AddUnitDone (createUnitReqFromInputs model)
                    )

                Nothing ->
                    ( model, E.none )

        AddUnitDone (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення підрозділу" err
            )

        AddUnitDone (Ok _) ->
            ( clearUnitInputs model
            , loadUnits
            )

        CloseAddUnitConfirmation ->
            ( { model | addUnitConfirmation = Nothing }, E.none )

        AddUnitSkipNetwork v ->
            ( updateAddUnitConfirmation
                (\confirmation ->
                    { confirmation
                        | skipNetworkCreation = v
                        , validationError = Nothing
                    }
                )
                model
            , E.none
            )

        AddUnitLocationDraftChanged v ->
            ( updateAddUnitConfirmation
                (\confirmation ->
                    if String.contains "," v then
                        { confirmation
                            | locations = commitChipDraft confirmation.locations v
                            , locationDraft = ""
                            , validationError = Nothing
                        }

                    else
                        { confirmation | locationDraft = v, validationError = Nothing }
                )
                model
            , E.none
            )

        AddUnitLocationKeyDown keyCode ->
            if keyCode == 13 then
                update AddUnitLocationCommit model

            else
                ( model, E.none )

        AddUnitLocationCommit ->
            ( updateAddUnitConfirmation commitLocationDraft model
            , E.none
            )

        AddUnitLocationRemove location ->
            ( updateAddUnitConfirmation
                (\confirmation ->
                    { confirmation
                        | locations = List.filter ((/=) location) confirmation.locations
                        , validationError = Nothing
                    }
                )
                model
            , E.none
            )

        AddUnitMaskDraftChanged v ->
            ( updateAddUnitConfirmation
                (\confirmation -> { confirmation | unitMaskDraft = v })
                model
            , E.none
            )

        AddUnitMaskKeyDown keyCode ->
            if keyCode == 13 then
                update AddUnitMaskCommit model

            else
                ( model, E.none )

        AddUnitMaskCommit ->
            ( updateAddUnitConfirmation commitUnitMaskDraft model
            , E.none
            )

        AddUnitMaskRemove unitMask ->
            ( updateAddUnitConfirmation
                (\confirmation ->
                    { confirmation | unitMask = List.filter ((/=) unitMask) confirmation.unitMask }
                )
                model
            , E.none
            )

        AddUnitConfirm ->
            case model.addUnitConfirmation of
                Nothing ->
                    ( model, E.none )

                Just confirmation ->
                    let
                        confirmation2 =
                            confirmation
                                |> commitLocationDraft
                                |> commitUnitMaskDraft
                    in
                    if not confirmation2.skipNetworkCreation && List.isEmpty confirmation2.locations then
                        ( { model
                            | addUnitConfirmation =
                                Just
                                    { confirmation2
                                        | validationError = Just "Додайте принаймні одну локацію або увімкніть пропуск створення мережі"
                                    }
                          }
                        , E.none
                        )

                    else
                        ( { model
                            | addUnitConfirmation =
                                Just
                                    { confirmation2
                                        | validationError = Nothing
                                        , saving = True
                                    }
                          }
                        , E.sendCmd <|
                            Api.sigint_unit_create_with_auto_network
                                AddUnitWithAutoNetworkDone
                                { unit = createUnitReqFromInputs model
                                , skipNetworkCreation = confirmation2.skipNetworkCreation
                                , locations = confirmation2.locations
                                , unitMask = confirmation2.unitMask
                                }
                        )

        AddUnitWithAutoNetworkDone (Err err) ->
            ( updateAddUnitConfirmation
                (\confirmation -> { confirmation | saving = False })
                model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка створення підрозділу" err
            )

        AddUnitWithAutoNetworkDone (Ok _) ->
            ( clearUnitInputs model
            , loadUnits
            )

        EditUnit id ->
            case ListX.find (\u -> u.id == id) model.units of
                Nothing ->
                    ( model, E.none )

                Just unit ->
                    ( { model
                        | editUnit =
                            Dict.insert id
                                { inpCompany = unit.company
                                , inpBattalion = unit.battalion
                                , inpRegiment = unit.regiment
                                , inpDivision = unit.division
                                , inpArmy = unit.army
                                , inpComment = unit.comment
                                , inpActive = unit.active
                                }
                                model.editUnit
                        , actionsPopupUnitId = Nothing
                      }
                    , E.none
                    )

        EditUnitMsg id editState ->
            ( { model | editUnit = Dict.insert id editState model.editUnit }
            , E.none
            )

        EditUnitSave id ->
            case Dict.get id model.editUnit of
                Nothing ->
                    ( model, E.none )

                Just editState ->
                    case ListX.find (\u -> u.id == id) model.units of
                        Nothing ->
                            ( model, E.none )

                        Just unit ->
                            ( model
                            , E.sendCmd <|
                                Api.sigint_unit_update (EditUnitDone id)
                                    { unit
                                        | company = String.trim editState.inpCompany
                                        , battalion = String.trim editState.inpBattalion
                                        , regiment = String.trim editState.inpRegiment
                                        , division = String.trim editState.inpDivision
                                        , army = String.trim editState.inpArmy
                                        , comment = String.trim editState.inpComment
                                        , active = editState.inpActive
                                    }
                            )

        EditUnitDone _ (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка оновлення підрозділу" err
            )

        EditUnitDone id (Ok _) ->
            ( { model | editUnit = Dict.remove id model.editUnit }
            , loadUnits
            )

        EditUnitCancel id ->
            ( { model | editUnit = Dict.remove id model.editUnit }, E.none )

        DeleteUnit id ->
            ( { model
                | deleteUnitConfirmation = Just id
                , actionsPopupUnitId = Nothing
              }
            , E.none
            )

        DeleteUnitConfirm ->
            let
                m2 =
                    { model | deleteUnitConfirmation = Nothing }
            in
            case model.deleteUnitConfirmation of
                Nothing ->
                    ( m2, E.none )

                Just id ->
                    ( m2
                    , E.sendCmd <| Api.sigint_unit_delete DeleteUnitDone id
                    )

        DeleteUnitCancel ->
            ( { model | deleteUnitConfirmation = Nothing }, E.none )

        DeleteUnitDone (Err err) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення підрозділу" err
            )

        DeleteUnitDone (Ok _) ->
            ( model
            , loadUnits
            )

        ClearInputs ->
            ( { model
                | inpCompany = ""
                , inpBattalion = ""
                , inpRegiment = ""
                , inpDivision = ""
                , inpArmy = ""
                , inpComment = ""
                , inpActive = True
                , addUnitConfirmation = Nothing
              }
            , E.none
            )

        LoadKMZ ->
            ( model
            , E.sendCmd <|
                File.Select.file
                    []
                    LoadKMZSelected
            )

        LoadKMZSelected file ->
            let
                m2 =
                    model
            in
            ( m2
            , E.sendCmd <|
                Api.delta_convert_kmz_to_geojson (LoadKMZDone file) file
            )

        LoadKMZDone _ (Err e) ->
            ( model
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження KMZ файлу" e
            )

        LoadKMZDone _ (Ok taskId) ->
            ( model
            , E.sendCmd <| Task.perform (always (ConsoleMsg (Shared.Components.Console.TaskLaunched taskId))) (Process.sleep 0)
            )

        ConsoleMsg imsg ->
            Shared.Components.Console.update
                { msg = imsg
                , model = model.console
                , toModel = \console -> { model | console = console }
                , toMsg = ConsoleMsg
                , finalizer = E.none
                }

        OpenUnitActionsPopup id ->
            ( { model | actionsPopupUnitId = Just id }, E.none )

        CloseUnitActionsPopup ->
            ( { model | actionsPopupUnitId = Nothing }, E.none )

        FixUnitDuplicates id ->
            ( { model | removingDuplicateProcess = UnitSelected id, actionsPopupUnitId = Nothing }, E.none )

        FinishFixingUnitDuplicates ->
            ( { model | removingDuplicateProcess = NotStarted }, E.none )

        RemoveDuplicate duplicateId ->
            let
                removingDuplicateProcess2 =
                    case model.removingDuplicateProcess of
                        UnitSelected unitId ->
                            UnitDuplicateSelected unitId duplicateId

                        UnitDuplicateSelected unitId _ ->
                            UnitDuplicateSelected unitId duplicateId

                        _ ->
                            NotStarted
            in
            ( { model | removingDuplicateProcess = removingDuplicateProcess2 }, E.none )

        RemoveDuplicateCancel ->
            let
                removingDuplicateProcess2 =
                    case model.removingDuplicateProcess of
                        UnitDuplicateSelected unitId _ ->
                            UnitSelected unitId

                        _ ->
                            NotStarted
            in
            ( { model | removingDuplicateProcess = removingDuplicateProcess2 }, E.none )

        RemoveDuplicateConfirm ->
            case model.removingDuplicateProcess of
                UnitDuplicateSelected unitId duplicateId ->
                    ( { model | removeDuplicateLoading = True }
                    , E.sendCmd <|
                        Api.sigint_unit_delete_duplicate RemoveDuplicateDone
                            { cloneToDeleteId = duplicateId
                            , originalId = unitId
                            }
                    )

                _ ->
                    ( model, E.none )

        RemoveDuplicateDone (Err err) ->
            ( { model | removeDuplicateLoading = False }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка видалення дублікату підрозділу" err
            )

        RemoveDuplicateDone (Ok _) ->
            let
                removingDuplicateProcess2 =
                    case model.removingDuplicateProcess of
                        UnitDuplicateSelected unitId _ ->
                            UnitSelected unitId

                        _ ->
                            NotStarted
            in
            ( { model | removeDuplicateLoading = False, removingDuplicateProcess = removingDuplicateProcess2 }
            , loadUnits
            )

        FilterActive v ->
            ( { model | filterActive = v }, E.none )

        FilterDivision v ->
            ( { model | filterDivision = v }, E.none )

        FilterArmy v ->
            ( { model | filterArmy = v }, E.none )

        FilterRegiment v ->
            ( { model | filterRegiment = v }, E.none )

        FilterBattalion v ->
            ( { model | filterBattalion = v }, E.none )

        FilterCompany v ->
            ( { model | filterCompany = v }, E.none )

        ClearFilters ->
            ( { model | filterActive = False, filterDivision = "", filterArmy = "", filterRegiment = "", filterBattalion = "", filterCompany = "" }, E.none )


createUnitReqFromInputs : Model -> B.CreateUnitReq
createUnitReqFromInputs model =
    { company = String.trim model.inpCompany
    , battalion = String.trim model.inpBattalion
    , regiment = String.trim model.inpRegiment
    , division = String.trim model.inpDivision
    , army = String.trim model.inpArmy
    , active = model.inpActive
    , comment = String.trim model.inpComment
    }


clearUnitInputs : Model -> Model
clearUnitInputs model =
    { model
        | inpCompany = ""
        , inpBattalion = ""
        , inpRegiment = ""
        , inpDivision = ""
        , inpArmy = ""
        , inpComment = ""
        , inpActive = True
        , addUnitConfirmation = Nothing
    }


updateAddUnitConfirmation : (AddUnitConfirmation -> AddUnitConfirmation) -> Model -> Model
updateAddUnitConfirmation updateConfirmation model =
    { model | addUnitConfirmation = Maybe.map updateConfirmation model.addUnitConfirmation }


initAddUnitConfirmation : Model -> AddUnitConfirmation
initAddUnitConfirmation model =
    { skipNetworkCreation = False
    , locations = []
    , locationDraft = ""
    , unitMask = defaultUnitMask (createUnitReqFromInputs model)
    , unitMaskDraft = ""
    , validationError = Nothing
    , saving = False
    }


unitNamePartsFromReq : B.CreateUnitReq -> List String
unitNamePartsFromReq req =
    [ req.company
    , req.battalion
    , req.regiment
    , req.division
    , req.army
    ]
        |> List.map String.trim
        |> List.filter (not << String.isEmpty)


unitNameFromReq : B.CreateUnitReq -> String
unitNameFromReq req =
    req
        |> unitNamePartsFromReq
        |> String.join " "


defaultUnitMask : B.CreateUnitReq -> List String
defaultUnitMask req =
    let
        parts =
            unitNamePartsFromReq req

        forward =
            String.join " " parts

        reverse =
            parts
                |> List.reverse
                |> String.join " "
    in
    dedupeTrimmedCaseInsensitive [ forward, reverse ]


dedupeTrimmedCaseInsensitive : List String -> List String
dedupeTrimmedCaseInsensitive items =
    items
        |> List.foldl
            (\item acc ->
                let
                    trimmed =
                        String.trim item

                    key =
                        String.toLower trimmed
                in
                if String.isEmpty trimmed || List.member key (List.map String.toLower acc) then
                    acc

                else
                    acc ++ [ trimmed ]
            )
            []


commitChipDraft : List String -> String -> List String
commitChipDraft current draft =
    draft
        |> String.split ","
        |> dedupeTrimmedCaseInsensitive
        |> (++) current
        |> dedupeTrimmedCaseInsensitive


commitLocationDraft : AddUnitConfirmation -> AddUnitConfirmation
commitLocationDraft confirmation =
    { confirmation
        | locations = commitChipDraft confirmation.locations confirmation.locationDraft
        , locationDraft = ""
        , validationError = Nothing
    }


commitUnitMaskDraft : AddUnitConfirmation -> AddUnitConfirmation
commitUnitMaskDraft confirmation =
    { confirmation
        | unitMask = commitChipDraft confirmation.unitMask confirmation.unitMaskDraft
        , unitMaskDraft = ""
    }


filteredUnits : Model -> List B.Unit
filteredUnits model =
    model.units
        |> List.filter
            (\unit ->
                if not model.filterActive then
                    True

                else
                    unit.active
            )
        |> List.filter
            (\unit ->
                if String.isEmpty model.filterDivision then
                    True

                else
                    String.contains (String.toLower model.filterDivision) (String.toLower unit.division)
            )
        |> List.filter
            (\unit ->
                if String.isEmpty model.filterArmy then
                    True

                else
                    String.contains (String.toLower model.filterArmy) (String.toLower unit.army)
            )
        |> List.filter
            (\unit ->
                if String.isEmpty model.filterRegiment then
                    True

                else
                    String.contains (String.toLower model.filterRegiment) (String.toLower unit.regiment)
            )
        |> List.filter
            (\unit ->
                if String.isEmpty model.filterBattalion then
                    True

                else
                    String.contains (String.toLower model.filterBattalion) (String.toLower unit.battalion)
            )
        |> List.filter
            (\unit ->
                if String.isEmpty model.filterCompany then
                    True

                else
                    String.contains (String.toLower model.filterCompany) (String.toLower unit.company)
            )


potentialDuplicates : Model -> List B.Unit
potentialDuplicates model =
    let
        company =
            String.toLower (String.trim model.inpCompany)

        battalion =
            String.toLower (String.trim model.inpBattalion)

        regiment =
            String.toLower (String.trim model.inpRegiment)

        division =
            String.toLower (String.trim model.inpDivision)

        army =
            String.toLower (String.trim model.inpArmy)

        anyInput =
            not (List.all String.isEmpty [ company, battalion, regiment, division, army ])

        matchesField userInput unitField =
            String.isEmpty userInput
                || (not (String.isEmpty unitField) && String.contains userInput (String.toLower unitField))
    in
    if anyInput then
        model.units
            |> List.filter
                (\unit ->
                    matchesField company unit.company
                        && matchesField battalion unit.battalion
                        && matchesField regiment unit.regiment
                        && matchesField division unit.division
                        && matchesField army unit.army
                )

    else
        []


subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.none


removeDuplicateConfirmationText : Maybe B.Unit -> Maybe B.Unit -> String
removeDuplicateConfirmationText unit unitToRemove =
    case ( unit, unitToRemove ) of
        ( Just unit_, Just unitToRemove_ ) ->
            "При підтвердженні - всі позивні, сигнали та привязки з підрозділу \"" ++ unitToRemove_.name ++ "\" буде перенесено до підрозділу \"" ++ unit_.name ++ "\". \n Ви дійсно бажаєте об'єднати підрозділ \"" ++ unit_.name ++ "\" із підрозділом \"" ++ unitToRemove_.name ++ "\"?"

        _ ->
            ""


addUnitConfirmationModal : Model -> Html Msg
addUnitConfirmationModal model =
    case model.addUnitConfirmation of
        Nothing ->
            text ""

        Just confirmation ->
            let
                req =
                    createUnitReqFromInputs model

                unitName =
                    unitNameFromReq req

                unitNamePreview =
                    if String.isEmpty unitName then
                        "Без назви"

                    else
                        unitName

                finalLocations =
                    commitChipDraft confirmation.locations confirmation.locationDraft

                confirmDisabled =
                    confirmation.saving
                        || (not confirmation.skipNetworkCreation && List.isEmpty finalLocations)

                chipView onRemove isDisabled chipText =
                    span
                        [ class "badge text-bg-secondary d-inline-flex align-items-center gap-1"
                        , style "font-size" "0.85rem"
                        , style "white-space" "normal"
                        , style "text-align" "left"
                        ]
                        [ span [] [ text chipText ]
                        , button
                            [ class "btn-close btn-close-white"
                            , style "font-size" "0.55rem"
                            , type_ "button"
                            , Attr.disabled isDisabled
                            , onClick (onRemove chipText)
                            ]
                            []
                        ]

                chipEditor labelText placeholderText items draft onDraftChanged onKeyDownMsg onCommitMsg onRemoveMsg isDisabled =
                    div [ class "mb-3" ]
                        [ label [ class "form-label fw-semibold" ] [ text labelText ]
                        , div [ class "d-flex flex-wrap gap-2 mb-2" ]
                            (if List.isEmpty items then
                                [ span [ class "text-muted small" ] [ text "Немає" ] ]

                             else
                                List.map (chipView onRemoveMsg isDisabled) items
                            )
                        , div [ class "input-group" ]
                            [ input
                                [ class "form-control"
                                , type_ "text"
                                , placeholder placeholderText
                                , value draft
                                , onInput onDraftChanged
                                , UtilsU.onKeyDown onKeyDownMsg
                                , Attr.disabled isDisabled
                                ]
                                []
                            , button
                                [ class "btn btn-outline-secondary"
                                , type_ "button"
                                , Attr.disabled isDisabled
                                , onClick onCommitMsg
                                ]
                                [ i [ class "bi bi-plus-lg" ] [] ]
                            ]
                        ]

                networkFieldsDisabled =
                    confirmation.saving || confirmation.skipNetworkCreation
            in
            div
                [ class "modal fade show d-block"
                , attribute "tabindex" "-1"
                , attribute "role" "dialog"
                , style "background-color" "rgba(0, 0, 0, 0.5)"
                , style "z-index" "1055"
                ]
                [ div
                    [ class "modal-dialog modal-lg modal-dialog-scrollable"
                    , attribute "role" "document"
                    ]
                    [ div [ class "modal-content" ]
                        [ div [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "Створення підрозділу" ]
                            , button
                                [ class "btn-close"
                                , type_ "button"
                                , Attr.disabled confirmation.saving
                                , onClick CloseAddUnitConfirmation
                                ]
                                []
                            ]
                        , div [ class "modal-body" ]
                            [ div [ class "mb-3" ]
                                [ label [ class "form-label fw-semibold" ] [ text "Підрозділ" ]
                                , div
                                    [ class "form-control"
                                    , style "min-height" "38px"
                                    , style "background-color" "var(--bs-secondary-bg)"
                                    ]
                                    [ text unitNamePreview ]
                                ]
                            , div [ class "mb-4" ]
                                [ label [ class "form-label fw-semibold" ] [ text "Коментар" ]
                                , div
                                    [ class "form-control"
                                    , style "min-height" "38px"
                                    , style "white-space" "pre-wrap"
                                    , style "background-color" "var(--bs-secondary-bg)"
                                    ]
                                    [ text
                                        (if String.isEmpty req.comment then
                                            "Немає"

                                         else
                                            req.comment
                                        )
                                    ]
                                ]
                            , div [ class "border-top pt-3" ]
                                [ h6 [ class "fw-bold" ] [ text "Радіомережа" ]
                                , p [ class "text-muted small mb-3" ]
                                    [ text "Разом з підрозділом буде створена SIGINT мережа, яку можна редагувати у База Даних - Мережі." ]
                                , div [ class "form-check mb-2" ]
                                    [ input
                                        [ class "form-check-input"
                                        , type_ "checkbox"
                                        , checked confirmation.skipNetworkCreation
                                        , Attr.disabled confirmation.saving
                                        , onCheck AddUnitSkipNetwork
                                        , id "skipNetworkCreation"
                                        ]
                                        []
                                    , label [ class "form-check-label", for "skipNetworkCreation" ]
                                        [ text "Пропустити створення мережі?" ]
                                    ]
                                , div [ class "text-muted small mb-3" ]
                                    [ text "Якщо пропустити створення мережі, вхідні повідомлення не будуть автоматично зіставлятися з цим підрозділом." ]
                                , div [ class "mb-3" ]
                                    [ label [ class "form-label fw-semibold" ] [ text "Назва майбутньої мережі" ]
                                    , div
                                        [ class "form-control"
                                        , style "min-height" "38px"
                                        , style "background-color" "var(--bs-secondary-bg)"
                                        ]
                                        [ text ("р/м 💻 " ++ unitNamePreview) ]
                                    ]
                                , chipEditor
                                    "Локації"
                                    "Додати локацію"
                                    confirmation.locations
                                    confirmation.locationDraft
                                    AddUnitLocationDraftChanged
                                    AddUnitLocationKeyDown
                                    AddUnitLocationCommit
                                    AddUnitLocationRemove
                                    networkFieldsDisabled
                                , div [ class "form-text mb-3" ]
                                    [ text "Якщо текст сигналу містить одну з цих назв, повідомлення буде позначено як повідомлення від цього підрозділу." ]
                                , chipEditor
                                    "Маски підрозділу"
                                    "Додати маску"
                                    confirmation.unitMask
                                    confirmation.unitMaskDraft
                                    AddUnitMaskDraftChanged
                                    AddUnitMaskKeyDown
                                    AddUnitMaskCommit
                                    AddUnitMaskRemove
                                    networkFieldsDisabled
                                , case confirmation.validationError of
                                    Nothing ->
                                        text ""

                                    Just validationError ->
                                        div [ class "alert alert-danger mb-0" ] [ text validationError ]
                                ]
                            ]
                        , div [ class "modal-footer" ]
                            [ button
                                [ class "btn btn-secondary"
                                , type_ "button"
                                , Attr.disabled confirmation.saving
                                , onClick CloseAddUnitConfirmation
                                ]
                                [ text "Відмінити" ]
                            , button
                                [ class "btn btn-primary"
                                , type_ "button"
                                , Attr.disabled confirmDisabled
                                , onClick AddUnitConfirm
                                ]
                                [ if confirmation.saving then
                                    span [ class "spinner-border spinner-border-sm" ] []

                                  else
                                    text "Підтвердити"
                                ]
                            ]
                        ]
                    ]
                ]


contentBlock : Shared.Model -> Model -> Html Msg
contentBlock shared model =
    let
        ( _, hasEditorOrAdminRole ) =
            case shared.user of
                Just user ->
                    ( Core.Auth.hasRole "Admin" user, Core.Auth.hasRole "UnitsEditor" user )

                Nothing ->
                    ( False, False )

        isEditing =
            not (Dict.isEmpty model.editUnit)

        devicesSectionEnabled =
            Maybe.map .devicesSectionEnabled shared.systemSettings

        addUnitDisabled =
            not hasEditorOrAdminRole || devicesSectionEnabled == Nothing

        addUnitButtonLabel =
            case devicesSectionEnabled of
                Nothing ->
                    "Завантаження..."

                Just _ ->
                    "Додати"

        renderUnitTrView : B.Unit -> Html Msg
        renderUnitTrView unit =
            tr
                [ class <|
                    if unit.active then
                        ""

                    else
                        "disabled"
                , class <|
                    let
                        activeTableRow selectedUnitId currentUnitId =
                            if selectedUnitId == currentUnitId then
                                "active-table-row"

                            else
                                ""
                    in
                    case model.removingDuplicateProcess of
                        UnitSelected unitId ->
                            activeTableRow unitId unit.id

                        UnitDuplicateSelected unitId _ ->
                            activeTableRow unitId unit.id

                        _ ->
                            ""
                ]
                [ td [ title (String.fromInt unit.id) ]
                    [ text <| unit.name ]
                , td [] [ text <| unit.company ]
                , td [] [ text <| unit.battalion ]
                , td [] [ text <| unit.regiment ]
                , td [] [ text <| unit.division ]
                , td [] [ text <| unit.army ]
                , td []
                    [ text <|
                        Utils.Time.renderDateTimeF1 shared.timeZone
                            (Time.millisToPosix unit.createdAt)
                    ]
                , td [] [ div [ style "white-space" "pre-line" ] [ text unit.comment ] ]
                , td [ class "text-center align-middle" ]
                    [ if unit.active then
                        div [ class "flex flex-col items-center" ]
                            [ i [ class "bi bi-check-circle-fill", style "color" "#198754", style "font-size" "1.3em", title "Активний" ] [] ]

                      else
                        div [ class "flex flex-col items-center" ]
                            [ i [ class "bi bi-x-circle-fill", style "color" "#dc3545", style "font-size" "1.3em", title "Неактивний" ] [] ]
                    ]
                , if hasEditorOrAdminRole then
                    td [ class "align-middle" ]
                        [ div [ style "margin" "auto", style "width" "fit-content" ]
                            (let
                                selectDuplicateButton selectedUnitId currentUnitId =
                                    if selectedUnitId /= currentUnitId then
                                        [ button
                                            [ class "btn btn-outline-primary btn-sm"
                                            , attribute "data-bs-toggle" "modal"
                                            , attribute "data-bs-target" "#removeDuplicateConfirmationModal"
                                            , onClick <| RemoveDuplicate currentUnitId
                                            ]
                                            [ i [ class "bi bi-plus-lg" ] [] ]
                                        ]

                                    else
                                        []
                             in
                             case model.removingDuplicateProcess of
                                NotStarted ->
                                    let
                                        actionsBody =
                                            button
                                                (class "btn btn-outline-primary btn-sm"
                                                    :: (if isEditing then
                                                            [ class "btn-outline-secondary disabled" ]

                                                        else
                                                            []
                                                       )
                                                )
                                                [ i [ class "bi bi-three-dots-vertical" ] [] ]

                                        actionsPopupBody =
                                            div [ class "popup-actions" ]
                                                [ div [ class "d-flex align-items-center gap-2 py-2 pointer popup-action", onClick <| EditUnit unit.id ]
                                                    [ i [ class "bi bi-pencil-square", style "margin-top" "2px" ] []
                                                    , span [] [ text "редагувати" ]
                                                    ]
                                                , div [ class "d-flex align-items-center gap-2 py-2 pointer popup-action", onClick <| FixUnitDuplicates unit.id ]
                                                    [ i [ class "bi bi-plus-lg", style "margin-top" "2px" ] []
                                                    , span [] [ text "виправити дублікати" ]
                                                    ]
                                                , div
                                                    [ class "d-flex align-items-center gap-2 py-2 pointer popup-action"
                                                    , attribute "data-bs-toggle" "modal"
                                                    , attribute "data-bs-target" "#deleteConfirmationModal"
                                                    , onClick <| DeleteUnit unit.id
                                                    ]
                                                    [ i [ class "bi bi-trash", style "margin-top" "2px" ] []
                                                    , span [] [ text "видалити" ]
                                                    ]
                                                ]
                                    in
                                    [ Shared.Components.Popup.new
                                        { body = actionsBody
                                        , popupBody = actionsPopupBody
                                        , isOpen = model.actionsPopupUnitId == Just unit.id
                                        , onOpen = OpenUnitActionsPopup <| unit.id
                                        , onClose = CloseUnitActionsPopup
                                        , disabled = isEditing
                                        }
                                        |> Shared.Components.Popup.withPlacementTop
                                        |> Shared.Components.Popup.withFakeAnchor
                                        |> Shared.Components.Popup.withSkidding "-16"
                                        |> Shared.Components.Popup.view
                                    ]

                                UnitSelected unitId ->
                                    selectDuplicateButton unitId unit.id

                                UnitDuplicateSelected unitId _ ->
                                    selectDuplicateButton unitId unit.id
                            )
                        ]

                  else
                    text ""
                ]

        renderUnitTrEdit : B.Unit -> EditUnitState -> Html Msg
        renderUnitTrEdit unit editState =
            tr []
                [ td [ title (String.fromInt unit.id) ]
                    [ text <| unit.name ]
                , td []
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Рота, взвод"
                        , value editState.inpCompany
                        , onInput <| EditUnitMsg unit.id << (\v -> { editState | inpCompany = v })
                        ]
                        []
                    ]
                , td []
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Батальйон"
                        , value editState.inpBattalion
                        , onInput <| EditUnitMsg unit.id << (\v -> { editState | inpBattalion = v })
                        ]
                        []
                    ]
                , td []
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Полк/Бригада"
                        , value editState.inpRegiment
                        , onInput <| EditUnitMsg unit.id << (\v -> { editState | inpRegiment = v })
                        ]
                        []
                    ]
                , td []
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Дивізія"
                        , value editState.inpDivision
                        , onInput <| EditUnitMsg unit.id << (\v -> { editState | inpDivision = v })
                        ]
                        []
                    ]
                , td []
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Корпус/Армія"
                        , value editState.inpArmy
                        , onInput <| EditUnitMsg unit.id << (\v -> { editState | inpArmy = v })
                        ]
                        []
                    ]
                , td []
                    [ text <|
                        Utils.Time.renderDateTimeF1 shared.timeZone
                            (Time.millisToPosix unit.createdAt)
                    ]
                , td []
                    [ input
                        [ class "form-control"
                        , type_ "text"
                        , placeholder "Коментар"
                        , value editState.inpComment
                        , onInput <| EditUnitMsg unit.id << (\v -> { editState | inpComment = v })
                        ]
                        []
                    ]
                , td []
                    [ div
                        [ class "form-check me-2" ]
                        [ input
                            [ class "form-check-input"
                            , type_ "checkbox"
                            , onCheck <| EditUnitMsg unit.id << (\v -> { editState | inpActive = v })
                            , checked editState.inpActive
                            ]
                            []
                        , label
                            [ class "form-check-label"
                            , for "inpActive"
                            ]
                            [ text "Активний" ]
                        ]
                    ]
                , td [ style "font-size" ".8rem" ]
                    [ div [ class "d-flex justify-content-start align-items-center" ]
                        [ button
                            [ class "btn btn-sm btn-outline-primary"
                            , type_ "button"
                            , onClick <| EditUnitSave unit.id
                            ]
                            [ i [ class "bi bi-check2" ] []
                            ]
                        , button
                            [ class "btn btn-sm btn-outline-danger ms-2"
                            , type_ "button"
                            , onClick <| EditUnitCancel unit.id
                            ]
                            [ i [ class "bi bi-x" ] []
                            ]
                        ]
                    ]
                ]

        renderUnitTr : B.Unit -> Html Msg
        renderUnitTr unit =
            case Dict.get unit.id model.editUnit of
                Nothing ->
                    renderUnitTrView unit

                Just editState ->
                    renderUnitTrEdit unit editState

        deleteConfirmationModal =
            div
                [ class "modal fade"
                , attribute "tabindex" "-1"
                , attribute "role" "dialog"
                , attribute "aria-hidden" "true"
                , id "deleteConfirmationModal"
                ]
                [ div
                    [ class "modal-dialog"
                    , attribute "role" "document"
                    ]
                    [ div
                        [ class "modal-content" ]
                        [ div
                            [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "Видалення підрозділу" ]
                            , button
                                [ class "btn-close"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , attribute "ariaLabel" "Close"
                                ]
                                []
                            ]
                        , div
                            [ class "modal-body p-3" ]
                            [ text "Ви впевнені, що хочете видалити цей підрозділ?"
                            ]
                        , div
                            [ class "modal-footer" ]
                            [ button
                                [ class "btn btn-secondary"
                                , attribute "type" "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick DeleteUnitCancel
                                ]
                                [ text "Відміна" ]
                            , button
                                [ class "btn btn-danger"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick <| DeleteUnitConfirm
                                ]
                                [ text "Видалити" ]
                            ]
                        ]
                    ]
                ]

        removeDuplicateConfirmationModal =
            div
                [ class "modal fade"
                , attribute "tabindex" "-1"
                , attribute "role" "dialog"
                , attribute "aria-hidden" "true"
                , id "removeDuplicateConfirmationModal"
                ]
                [ div
                    [ class "modal-dialog"
                    , attribute "role" "document"
                    ]
                    [ div
                        [ class "modal-content" ]
                        [ div
                            [ class "modal-header" ]
                            [ h5 [ class "modal-title" ] [ text "Увага!" ]
                            , button
                                [ class "btn-close"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , attribute "ariaLabel" "Close"
                                ]
                                []
                            ]
                        , div
                            [ class "modal-body p-3" ]
                            [ text
                                (case model.removingDuplicateProcess of
                                    UnitDuplicateSelected unitId duplicateId ->
                                        let
                                            unit =
                                                ListX.find (\u -> u.id == unitId) model.units

                                            duplicateUnit =
                                                ListX.find (\u -> u.id == duplicateId) model.units
                                        in
                                        removeDuplicateConfirmationText unit duplicateUnit

                                    _ ->
                                        ""
                                )
                            ]
                        , div
                            [ class "modal-footer" ]
                            [ button
                                [ class "btn btn-secondary"
                                , attribute "type" "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick RemoveDuplicateCancel
                                ]
                                [ text "Відмінити" ]
                            , button
                                [ class "btn btn-primary"
                                , type_ "button"
                                , attribute "data-bs-dismiss" "modal"
                                , onClick <| RemoveDuplicateConfirm
                                ]
                                [ text "Підтвердити" ]
                            ]
                        ]
                    ]
                ]

        addUnitPanel =
            div
                [ class "d-flex justify-content-start align-items-center"
                ]
                [ input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorOrAdminRole)
                    , type_ "text"
                    , placeholder "Рота, взвод"
                    , onInput InpCompany
                    , value model.inpCompany
                    ]
                    []
                , input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorOrAdminRole)
                    , type_ "text"
                    , placeholder "Батальйон"
                    , onInput InpBattalion
                    , value model.inpBattalion
                    ]
                    []
                , input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorOrAdminRole)
                    , type_ "text"
                    , placeholder "Полк/Бригада"
                    , onInput InpRegiment
                    , value model.inpRegiment
                    ]
                    []
                , input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorOrAdminRole)
                    , type_ "text"
                    , placeholder "Дивізія"
                    , onInput InpDivision
                    , value model.inpDivision
                    ]
                    []
                , input
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorOrAdminRole)
                    , type_ "text"
                    , placeholder "Корпус/Армія"
                    , onInput InpArmy
                    , value model.inpArmy
                    ]
                    []
                , textarea
                    [ class "form-control me-2"
                    , Attr.disabled (not hasEditorOrAdminRole)
                    , placeholder "Коментар"
                    , onInput InpComment
                    , value model.inpComment
                    , rows 1
                    ]
                    []
                , Checkbox.new { isChecked = model.inpActive, onToggle = InpActive }
                    |> Checkbox.withContent [ span [] [ text "Активний" ] ]
                    |> Checkbox.view
                , div [ class "flex gap-[4px] ml-[4px]" ]
                    [ Button.new { label = "Очистити", onClick = ClearInputs }
                        |> Button.withDisabled (not hasEditorOrAdminRole)
                        |> Button.withStyleSecondary
                        |> Button.view
                    , Button.new { label = addUnitButtonLabel, onClick = AddUnit devicesSectionEnabled }
                        |> Button.withDisabled addUnitDisabled
                        |> Button.view
                    ]
                ]

        removingDuplicatesHeader unit =
            div []
                [ div [ style "padding" "36px 0" ]
                    []
                , div
                    [ class "fixed-header" ]
                    [ div
                        [ class "container-xxl d-flex align-items-center justify-content-between", style "padding" "13px 20px" ]
                        [ div []
                            [ h3
                                [ style "margin-bottom" "10px" ]
                                [ text ("вибраний підрозділ: \"" ++ unit.name ++ "\"") ]
                            , div [ class "d-flex align-items-center", style "gap" "10px" ]
                                [ h5 [ style "margin-bottom" "2px" ] [ text "оберіть дублікат вибраного підрозділу з таблиці та натисніть" ]
                                , button
                                    [ class "btn btn-outline-primary btn-sm pointer-events-none"
                                    ]
                                    [ i [ class "bi bi-plus-lg" ] [] ]
                                , h5 [ style "margin-bottom" "2px" ] [ text " у рядку" ]
                                ]
                            ]
                        , div [ class "d-flex align-items-center gap-3" ]
                            ((if model.removeDuplicateLoading then
                                [ Shared.Components.Spinner.loadingSpinnerSm ]

                              else
                                []
                             )
                                ++ [ button
                                        [ class "btn btn-primary"
                                        , type_ "button"
                                        , onClick FinishFixingUnitDuplicates
                                        , Attr.disabled model.removeDuplicateLoading
                                        ]
                                        [ text "завершити" ]
                                   ]
                            )
                        ]
                    ]
                ]

        mainContent =
            div []
                [ let
                    regularHeader =
                        h1
                            [ class "py-4" ]
                            [ text "підрозділи противника" ]

                    header selectedUnitId =
                        let
                            unit =
                                ListX.find (\u -> u.id == selectedUnitId) model.units
                        in
                        case unit of
                            Just unit_ ->
                                removingDuplicatesHeader unit_

                            _ ->
                                regularHeader
                  in
                  case model.removingDuplicateProcess of
                    UnitSelected unitId ->
                        header unitId

                    UnitDuplicateSelected unitId _ ->
                        header unitId

                    _ ->
                        regularHeader
                , div
                    [ class "border p-3 mb-4"
                    , style "background-color" "var(--bs-tertiary-bg)"
                    ]
                    [ button
                        [ class "btn btn-outline-secondary"
                        , Attr.disabled (not hasEditorOrAdminRole)
                        , type_ "button"
                        , onClick LoadKMZ
                        ]
                        [ text "підвантажити KMZ з картою підрозділів з Дельти"
                        ]
                    ]
                , Shared.Components.Console.view model.console
                , div
                    [ class "border mb-4 p-3"
                    , style "background-color" "var(--bs-tertiary-bg)"
                    ]
                    [ addUnitPanel
                    ]
                , let
                    duplicates =
                        potentialDuplicates model
                  in
                  if not (List.isEmpty duplicates) then
                    div [ class "alert alert-warning mt-2" ]
                        [ text "Можливо, такий підрозділ вже існує:"
                        , table [ class "table table-sm mt-2" ]
                            [ thead []
                                [ tr []
                                    [ th [] [ text "Назва" ]
                                    , th [] [ text "Рота/Взвод" ]
                                    , th [] [ text "Батальйон" ]
                                    , th [] [ text "Полк/Бригада" ]
                                    , th [] [ text "Дивізія" ]
                                    , th [] [ text "Корпус/Армія" ]
                                    ]
                                ]
                            , tbody []
                                (List.map
                                    (\unit ->
                                        tr []
                                            [ td [] [ text unit.name ]
                                            , td [] [ text unit.company ]
                                            , td [] [ text unit.battalion ]
                                            , td [] [ text unit.regiment ]
                                            , td [] [ text unit.division ]
                                            , td [] [ text unit.army ]
                                            ]
                                    )
                                    duplicates
                                )
                            ]
                        ]

                  else
                    text ""
                , div
                    [ class "border mb-4 p-3 bg-card rounded-lg"
                    ]
                    [ div [ class "d-flex justify-content-between align-items-center mb-3" ]
                        [ h5 [ class "fw-bold mb-0 text-gray-900 dark:text-gray-100" ] [ text "Фільтри" ]
                        , div [ class "d-flex align-items-center", style "cursor" "pointer", onClick ClearFilters, attribute "title" "Очистити фільтри" ]
                            [ span [ class "me-1 text-secondary" ] [ text "Очистити" ]
                            , i [ class "bi bi-x text-secondary", style "font-size" "1.2rem" ] []
                            ]
                        ]
                    , div [ class "mb-3 d-flex align-items-center gap-3" ]
                        [ Checkbox.new { isChecked = model.filterActive, onToggle = FilterActive }
                            |> Checkbox.withContent [ span [ class "text-gray-900 dark:text-gray-100" ] [ text "Лише активні" ] ]
                            |> Checkbox.view
                        ]
                    , div [ class "row g-3" ]
                        [ div [ class "col-md-4" ]
                            [ label [ class "form-label text-gray-900 dark:text-gray-100" ] [ text "Рота/Взвод:" ]
                            , input
                                [ class "form-control bg-card border border-border text-gray-900 dark:text-gray-100"
                                , type_ "text"
                                , placeholder "Введіть назву роти/взводу"
                                , value model.filterCompany
                                , onInput FilterCompany
                                ]
                                []
                            ]
                        , div [ class "col-md-4" ]
                            [ label [ class "form-label text-gray-900 dark:text-gray-100" ] [ text "Батальйон:" ]
                            , input
                                [ class "form-control bg-card border border-border text-gray-900 dark:text-gray-100"
                                , type_ "text"
                                , placeholder "Введіть назву батальйону"
                                , value model.filterBattalion
                                , onInput FilterBattalion
                                ]
                                []
                            ]
                        , div [ class "col-md-4" ]
                            [ label [ class "form-label text-gray-900 dark:text-gray-100" ] [ text "Полк/Бригада:" ]
                            , input
                                [ class "form-control bg-card border border-border text-gray-900 dark:text-gray-100"
                                , type_ "text"
                                , placeholder "Введіть назву полку/бригади"
                                , value model.filterRegiment
                                , onInput FilterRegiment
                                ]
                                []
                            ]
                        , div [ class "col-md-6" ]
                            [ label [ class "form-label text-gray-900 dark:text-gray-100" ] [ text "Дивізія:" ]
                            , input
                                [ class "form-control bg-card border border-border text-gray-900 dark:text-gray-100"
                                , type_ "text"
                                , placeholder "Введіть назву дивізії"
                                , value model.filterDivision
                                , onInput FilterDivision
                                ]
                                []
                            ]
                        , div [ class "col-md-6" ]
                            [ label [ class "form-label text-gray-900 dark:text-gray-100" ] [ text "Корпус/Армія:" ]
                            , input
                                [ class "form-control bg-card border border-border text-gray-900 dark:text-gray-100"
                                , type_ "text"
                                , placeholder "Введіть назву корпусу/армії"
                                , value model.filterArmy
                                , onInput FilterArmy
                                ]
                                []
                            ]
                        ]
                    ]
                , table [ class "table table-bordered table", style "position" "relative" ]
                    [ thead [ style "position" "sticky", style "top" "0", style "z-index" "2", style "background" "#fff" ]
                        [ tr []
                            [ th [ scope "col", class "nowrap" ] [ text "Назва" ]
                            , th [ scope "col", class "nowrap" ] [ text "Рота, взвод" ]
                            , th [ scope "col", class "nowrap" ] [ text "Батальйон" ]
                            , th [ scope "col", class "nowrap" ] [ text "Полк/Бригада" ]
                            , th [ scope "col", class "nowrap" ] [ text "Дивізія" ]
                            , th [ scope "col", class "nowrap" ] [ text "Корпус/Армія" ]
                            , th [ scope "col", class "nowrap" ] [ text "Дата внесення" ]
                            , th [ scope "col", class "nowrap" ] [ text "Коментар" ]
                            , th [ scope "col", class "nowrap" ] [ text "Активний" ]
                            , if hasEditorOrAdminRole then
                                th [ scope "col", class "nowrap" ] [ text "Дії" ]

                              else
                                text ""
                            ]
                        ]
                    , tbody [] <|
                        List.map renderUnitTr (filteredUnits model)
                    ]
                ]
    in
    div []
        [ deleteConfirmationModal
        , removeDuplicateConfirmationModal
        , addUnitConfirmationModal model
        , mainContent
        ]


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view _ shared _ model =
    { title = "підрозділи противника"
    , body =
        [ div [ class "page-rer-units w-5/6 mx-auto" ] <|
            [ div [ class "row" ]
                [ div [ class "col-sm-12" ]
                    [ contentBlock shared model ]
                ]
            ]
        ]
    }
