module RerAnalysis.FreqBadge exposing (freqBadge)

import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Extra exposing (viewMaybe)
import Le.Block.Badges
import Le.RemoteData
import Le.Utils exposing (..)
import List.Extra as ListX
import RerAnalysis.Model exposing (..)
import RerAnalysis.Msg exposing (..)
import String


freqBadge : Model -> String -> Html Msg
freqBadge model freqStr =
    let
        isSelected x =
            List.member x model.freqsSelected

        lblHtml =
            [ div [ class "d-flex align-items-center" ] <|
                [ div [] [ text <| getLabelOrDefault freqStr ]
                , flip viewMaybe (ListX.find (\x -> x.freq == freqStr) (Le.RemoteData.withDefault [] model.freqs)) <|
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
            Le.Block.Badges.badgeSelectedCloseCounter lblHtml (UnselectFreq freqStr)

        else
            [ Le.Block.Badges.badgeNotSelectedHtml lblHtml
                (SelectFreq freqStr)
            ]
