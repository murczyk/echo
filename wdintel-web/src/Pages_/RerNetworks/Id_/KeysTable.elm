module Pages_.RerNetworks.Id_.KeysTable exposing
    ( initLoad
    , update
    , view
    )

import Api
import Bindings as B
import Core.Types exposing (ApiError)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import List.Extra as ListX
import Pages_.RerNetworks.Id_.Model exposing (Model)
import Pages_.RerNetworks.Id_.Msg as Msgs exposing (KeysMsg(..))
import Shared.Components.Spinner
import Shared.Components.Table as Table
import Shared.Components.Table.Column as TableColumn
import Shared.Components.Table.Config as TableConfig
import String
import Utils.Api.ErrorHandling
import Utils.RemoteData exposing (RemoteData(..))


initLoad : Int -> Effect KeysMsg
initLoad networkId =
    E.sendCmd (Api.sigint_list_keys KeysReturnedByApi { sigintNetworkId = networkId })


update : Shared.Model -> KeysMsg -> Model -> ( Model, Effect KeysMsg )
update _ msg networkModel =
    case msg of
        KeysReturnedByApi (Err e) ->
            ( { networkModel | networkKeys = Failure e }
            , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження ключів" e
            )

        KeysReturnedByApi (Ok res) ->
            ( { networkModel | networkKeys = Success res.keys }
            , E.none
            )

        SetKeysTableState newState ->
            ( { networkModel | keysTableState = newState }
            , E.none
            )


view : Model -> Html KeysMsg
view networkModel =
    section [ class "bg-w dark:bg-[#1C1C21] p-[16px] mt-[30px] flex flex-col" ]
        [ div [ class "mb-[8px] flex justify-between items-center" ]
            [ h4 [] [ text "Ключі" ] ]
        , case networkModel.networkKeys of
            Success keys ->
                div [ class "table-responsive-modern" ]
                    [ if List.isEmpty keys then
                        emptyKeysPlaceholder

                      else
                        Table.view (keysTableConfig networkModel) networkModel.keysTableState keys
                    ]

            _ ->
                Shared.Components.Spinner.loadingSpinnerSm
        ]


emptyKeysPlaceholder : Html msg
emptyKeysPlaceholder =
    div
        [ class "flex flex-col items-center justify-center py-12 text-center" ]
        [ i [ class "bi bi-key text-4xl text-gray-400 mb-4" ] []
        , p [ class "text-gray-600 dark:text-gray-400 text-lg font-medium" ] [ text "Немає ключів в мережі" ]
        , p [ class "text-gray-500 dark:text-gray-500 text-sm mt-2" ]
            [ text "Додайте ключі до частот мережі" ]
        ]


keysTableConfig : Model -> Table.Config B.EncryptionKeyData KeysMsg
keysTableConfig networkModel =
    TableConfig.config
        { toId = keyRowId
        , toMsg = SetKeysTableState
        , columns =
            [ TableColumn.stringColumn "Частота" (\key -> freqLabelById networkModel key.sigintNetworkFreqId)
            , TableColumn.stringColumn "Ключ" (\key -> keyLabel key.key)
            ]
        }


keyRowId : B.EncryptionKeyData -> String
keyRowId key =
    case ( key.sigintNetworkFreqId, key.id ) of
        ( Just freqId, _ ) ->
            String.fromInt freqId

        ( Nothing, Just keyId ) ->
            String.fromInt keyId

        ( Nothing, Nothing ) ->
            key.key


freqLabelById : Model -> Maybe Int -> String
freqLabelById networkModel freqId =
    case ( networkModel.freqs, freqId ) of
        ( Success freqs, Just id ) ->
            freqs
                |> ListX.find (\freq -> freq.networkFreqId == id)
                |> Maybe.map .freq
                |> Maybe.withDefault "-"

        _ ->
            "-"


keyLabel : String -> String
keyLabel value =
    if String.trim value == "" then
        "-"

    else
        value
