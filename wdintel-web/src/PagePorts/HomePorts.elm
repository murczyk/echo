port module PagePorts.HomePorts exposing (home_mgrsToWgs84, home_mgrsToWgs84Res, home_usk2000ToWgs84, home_usk2000ToWgs84Res, home_wgs84ToMgrs, home_wgs84ToMgrsRes, home_wgs84ToUsk2000, home_wgs84ToUsk2000Res)


port home_usk2000ToWgs84 :
    { coords : { x : Int, y : Int } }
    -> Cmd msg


port home_usk2000ToWgs84Res :
    ({ coords : { lat : Float, lng : Float } } -> msg)
    -> Sub msg


port home_wgs84ToUsk2000 :
    { coords : { lat : Float, lng : Float } }
    -> Cmd msg


port home_wgs84ToUsk2000Res :
    ({ coords : { x : Int, y : Int } } -> msg)
    -> Sub msg


port home_mgrsToWgs84 :
    { coords : String }
    -> Cmd msg


port home_mgrsToWgs84Res :
    ({ coords : { lat : Float, lng : Float } } -> msg)
    -> Sub msg


port home_wgs84ToMgrs :
    { coords : { lat : Float, lng : Float }, viewId : Int }
    -> Cmd msg


port home_wgs84ToMgrsRes :
    ({ coords : String, viewId : Int } -> msg)
    -> Sub msg
