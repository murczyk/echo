port module PagePorts.WaterfallPorts exposing (waterfall_copyTextToClipboard, waterfall_getVisibleMsgIds, waterfall_getVisibleMsgIdsRes, waterfall_scrollIntoView)


port waterfall_isShown :
    { elemId : String }
    -> Cmd msg


port waterfall_isShownRes :
    ({ elemId : String
     , shown : Bool
     }
     -> msg
    )
    -> Sub msg


port waterfall_scrollTo :
    { elemId : String
    , x : Int
    , y : Int
    }
    -> Cmd msg


port waterfall_copyTextToClipboard : { text : String } -> Cmd msg


port waterfall_getVisibleMsgIds :
    { waterfallId : String
    , allMsgIds : List Int
    }
    -> Cmd msg


port waterfall_getVisibleMsgIdsRes :
    ({ waterfallId : String, msgIds : List Int, firstVisibleHeight : Float } -> msg)
    -> Sub msg


port waterfall_scrollIntoView : { elemId : String, height : Float, waterfallId : String } -> Cmd msg
