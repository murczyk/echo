module Pages_.RerNetworks.ReportModal exposing
    ( Config
    , view
    )

import Html exposing (..)
import Html.Attributes exposing (..)
import Shared.Components.Button as Button
import Shared.Components.ModalDialog as ModalDialog
import Pages_.RerNetworks.ReportForm as ReportForm
import Shared.Components.Spinner
import Pages_.RerNetworks.ReportConfig exposing (ReportType)


{-| Конфігурація модального вікна звіту
-}
type alias Config msg =
    { isOpen : Bool
    , onClose : msg
    , onDownload : msg
    , isDownloading : Bool
    , reportType : ReportType
    , reportFormConfig : ReportForm.Config msg
    , title : String
    , description : String
    }


{-| Відображення модального вікна звіту
-}
view : Config msg -> Html msg
view config =
    let
        dialogContent =
            [ div [ class "flex flex-col gap-4 p-4 w-[700px]" ]
                [ -- Header
                  div []
                    [ h2 [ class "text-xl font-semibold mb-2" ] [ text config.title ]
                    , p [ class "text-gray-600 dark:text-gray-400 mb-4" ] [ text config.description ]
                    ]
                , -- Report form
                  ReportForm.view config.reportFormConfig config.reportType
                , -- Footer buttons
                  div [ class "flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700" ]
                    [ Button.new { label = "Назад", onClick = config.onClose } 
                        |> Button.withStyleSecondary 
                        |> Button.view
                    , Button.new { label = "Згенерувати", onClick = config.onDownload }
                        |> (if config.isDownloading then
                                Button.withIcon [ Shared.Components.Spinner.loadingSpinner2Sm ]
                            else
                                identity
                           )
                        |> Button.view
                    ]
                ]
            ]
    in
    ModalDialog.modalDialog config.isOpen config.onClose [] dialogContent
