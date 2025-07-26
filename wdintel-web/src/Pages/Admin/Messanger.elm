module Pages.Admin.Messanger exposing (Model, Msg, page)

import Api
import Auth
import Bindings as B
import Components.Button as Button
import Components.Sidebar as Sidebar
import Components.Table as Table
import Components.Table.Column as TableColumn
import Components.Table.Config as TableConfig
import Dict exposing (Dict)
import Effect as E exposing (Effect)
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Html.Styled as Styled
import Layouts
import Le.Block.Select
import Le.Components exposing (..)
import Le.ErrorHandling
import Le.RemoteData as RD exposing (RemoteData(..))
import Le.Types exposing (..)
import Le.Utils exposing (..)
import Page exposing (Page)
import Route exposing (Route)
import Select
import Shared
import View exposing (View)
import Views


page : Auth.User -> Shared.Model -> Route () -> Page Model Msg
page user shared req =
    Page.new
        { init = init
        , update = update
        , view = view shared.isDarkMode shared user
        , subscriptions = subscriptions
        }
        |> Page.withLayout (toLayout user)


toLayout : Auth.User -> Model -> Layouts.Layout Msg
toLayout user model =
    Layouts.Navbar
        { user = user
        , activeName = "admin"
        }



-- INIT


type alias Model =
    { accounts : RemoteData ApiError (List B.EchoAccountF1)
    , sidebarOpen : Bool
    , formErrors : Dict String String
    }


init : () -> ( Model, Effect Msg )
init () =
    ( { accounts = RD.NotAsked
      , sidebarOpen = False
      , formErrors = Dict.empty
      }
    , E.none
    )



-- UPDATE


type Msg
    = NoOp
    | LoadAccounts
    | GotAccounts (Result ApiError B.AccountsRsp)
    | OpenLinkSidebar
    | CloseLinkSidebar


update : Msg -> Model -> ( Model, Effect Msg )
update msg model =
    case msg of
        NoOp ->
            ( model
            , E.none
            )

        LoadAccounts ->
            ( { model | accounts = RD.Loading }
            , E.sendCmd (Api.messenger_list_accounts GotAccounts)
            )

        GotAccounts result ->
            ( { model | accounts = 
                case result of
                    Ok accountsRsp ->
                        RD.Success accountsRsp.accounts
                    Err error ->
                        RD.Failure error
              }
            , E.none
            )

        OpenLinkSidebar ->
            ( { model | sidebarOpen = True }
            , E.none
            )

        CloseLinkSidebar ->
            ( { model | sidebarOpen = False }
            , E.none
            )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.none



-- VIEW


view : Bool -> Shared.Model -> B.User -> Model -> View Msg
view dark shared user model =
    { title = "Адмін: месенджери"
    , body = body dark shared user model
    }


body : Bool -> Shared.Model -> B.User -> Model -> List (Html Msg)
body dark shared user model =
    let
        sidebarContent =
            []
    in
    [ div
        [ classList [ ( "overflow-hidden", model.sidebarOpen ) ]
        , class "w-5/6 mx-auto"
        ]
        [ Sidebar.view model.sidebarOpen CloseLinkSidebar sidebarContent
        , div [] (mainBlock dark model)
        ]
    ]


mainBlock : Bool -> Model -> List (Html Msg)
mainBlock isDark model =
    [ div []
        [ h1 [ class "py-4 text-2xl font-bold text-foreground" ] [ text "Месенджери" ]
        , div
            [ class "border border-border rounded-lg mb-4 p-4 bg-[var(--bs-tertiary-bg)]"
            ]
            [ div [ class "flex justify-between items-center" ]
                [ div [ class "text-sm text-muted-foreground" ] 
                    [ text "Управління прив'язаними акаунтами месенджерів" ]
                , Button.new { label = "Прив'язати новий", onClick = OpenLinkSidebar }
                    |> Button.view
                ]
            ]
        , div [ class "text-center py-8" ]
            [ text "Тут буде таблиця з акаунтами" ]
        ]
    ]
