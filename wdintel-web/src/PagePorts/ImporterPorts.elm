port module PagePorts.ImporterPorts exposing (importer_mgrsToWgs84, importer_mgrsToWgs84Res, importer_pasteImage, importer_pasteImageRes, importer_proposeIcons, importer_proposeIconsRes, importer_usk2000ToWgs84, importer_usk2000ToWgs84Res)


port importer_usk2000ToWgs84 :
    { rowId : Int, coordId : Int, coords : { x : Int, y : Int } }
    -> Cmd msg


port importer_usk2000ToWgs84Res :
    ({ rowId : Int, coordId : Int, coords : { lat : Float, lng : Float } } -> msg)
    -> Sub msg


port importer_proposeIcons : { rowId : Int, text : String } -> Cmd msg


port importer_proposeIconsRes :
    ({ rowId : Int, icons : List String } -> msg)
    -> Sub msg


port importer_pasteImage : { rowId : Int } -> Cmd msg


port importer_pasteImageRes :
    ({ rowId : Int, contentsBase64 : String } -> msg)
    -> Sub msg


port importer_mgrsToWgs84 :
    { rowId : Int, coordId : Int, coords : String }
    -> Cmd msg


port importer_mgrsToWgs84Res :
    ({ rowId : Int
     , coordId : Int
     , coords : { lat : Float, lng : Float }
     }
     -> msg
    )
    -> Sub msg
