port module PagePorts.RerDutyPorts exposing (rer_duty_inboxChanged)


port rer_duty_inboxChanged : (List Int -> msg) -> Sub msg
