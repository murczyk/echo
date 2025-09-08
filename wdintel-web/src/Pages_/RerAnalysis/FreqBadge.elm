module Pages_.RerAnalysis.FreqBadge exposing (freqBadge)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Extra exposing (viewMaybe)
import List.Extra as ListX
import Pages_.RerAnalysis.Model exposing (..)
import Pages_.RerAnalysis.Msg exposing (..)
import Shared.Components.Badges
import String
import Utils.RemoteData
import Utils.Utils exposing (..)


freqBadge : Model -> String -> Html Msg
freqBadge model freqStr =
    let
        isSelected x =
            List.member x model.freqsSelected

        lblHtml =
            [ div [ class "d-flex align-items-center" ] <|
                [ div [] [ text <| getLabelOrDefault freqStr ]
                , flip viewMaybe (ListX.find (\x -> x.freq == freqStr) (Utils.RemoteData.withDefault [] model.freqs)) <|
                    \freq ->
                        div
                            [ class "ms-2"
                            , style "font-size" ".85rem"
                            ]
                            [ small []
                                [ span [ class "badge rounded-pill text-bg-light" ]
                                    [ text <| String.fromInt freq.count ]
                                ]
                            ]
                ]
            ]
    in
    div [ class "me-2 fs-6 mb-2" ] <|
        if isSelected freqStr then
            Shared.Components.Badges.badgeSelectedCloseCounter lblHtml (UnselectFreq freqStr)

        else
            [ Shared.Components.Badges.badgeNotSelectedHtml lblHtml
                (SelectFreq freqStr)
            ]
