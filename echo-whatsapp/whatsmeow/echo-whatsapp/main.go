// Copyright (c) 2021 Tulir Asokan
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

package main

import (
	"bufio"
	"context"
	b64 "encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"

	"github.com/BurntSushi/toml"
	_ "github.com/mattn/go-sqlite3"
	"github.com/mdp/qrterminal/v3"
	"google.golang.org/protobuf/proto"

	"github.com/jackc/pgx/v5/pgxpool"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

var cli *whatsmeow.Client
var senderJid *types.JID
var log waLog.Logger = waLog.Stdout("Main", logLevel, true)

// var logLevel = "INFO"
var logLevel = "DEBUG"
var debugLogs = flag.Bool("debug", false, "Enable debug logs?")
var dbDialect = flag.String("db-dialect", "sqlite3", "Database dialect (sqlite3 or postgres)")
var dbAddress = flag.String("db-address", "file:mdtest.db?_foreign_keys=on", "Database address")
var requestFullSync = flag.Bool("request-full-sync", false, "Request full (1 year) history sync when logging in?")
var pairRejectChan = make(chan bool, 1)

type Config struct {
	PgUser     string `toml:"pg_user"`
	PgPassword string `toml:"pg_password"`
	PgHost     string `toml:"pg_host"`
	PgPort     int64  `toml:"pg_port"`
	PgDbname   string `toml:"pg_dbname"`
}

type WhatsappMsg struct {
	Id            int64
	GroupId       *int64
	RecipientId   *int64
	Body          string
	EchoMessageId int64
	QuoteId       *string
}

type WhatsappMsgPatch struct {
	Id            int64
	AttachmentB64 *string
	MessageId     string
	GroupId       *int64
	RecipientId   *int64
	Body          string
	QuoteId       *string
}

type WhatsappReaction struct {
	Id        int64
	GroupId   *int64
	SenderId  *int64
	Code      string
	MessageId *string
}

type WhatsappApiCmd struct {
	Id      int64
	Command string
	Args    string
}

type WhatsappMessageMeta struct {
	chatJid     *types.JID
	receiverJid *types.JID
	key         *waCommon.MessageKey
	chat        *waE2E.Chat
}

func handleApiCmds(dbpool *pgxpool.Pool, lastGroupInfoSync time.Time, groupsSeen map[types.JID]struct{}, accountId int, clientId int) {
	fuel := 1000
	for fuel >= 0 {
		fuel -= 1
		var q = "select id, type, args from echo_api_command where client_id = $1 order by created_at asc limit 1;"
		rows, err := dbpool.Query(context.Background(), q, clientId)
		defer rows.Close()
		if err != nil {
			log.Errorf("QueryRow 'select echo_api_command' failed: %v\n", err)
			return
		}
		toBreak := true
		for rows.Next() {
			toBreak = false
			var data WhatsappApiCmd
			err = rows.Scan(&data.Id, &data.Command, &data.Args)
			if err != nil {
				log.Errorf("Failed to map echo_api_command rec: %v\n", err)
				continue
			}
			handleApiCmd(dbpool, data.Command, data.Args, accountId, clientId)
			_, err2 := dbpool.Exec(context.Background(), "delete from echo_api_command where id = $1;", &data.Id)
			if err2 != nil {
				log.Errorf("QueryRow failed: %v\n", err2)
				continue
			}
		}
		if toBreak {
			break
		}
	}
}

func handleQueue(dbpool *pgxpool.Pool, lastGroupInfoSync time.Time, groupsSeen map[types.JID]struct{}, accountId int, clientId int) {
	sendNewReactions(dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
	sendNewMessages(dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
	editMessages(dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
}

func sendNewReactions(dbpool *pgxpool.Pool, lastGroupInfoSync time.Time, groupsSeen map[types.JID]struct{}, accountId int, clientId int) {
	var q = `select r.id, eim.group_id, eim.sender_id,  r.code, eim.internal_id as message_id
	    from echo_message_reaction_queue r inner join echo_inbox_message eim on eim.id = r.inbox_message_id
    	where r.account_id = $1 and eim.client_id = $2 order by r.created_at asc limit 100;`
	rows, err := dbpool.Query(context.Background(), q, accountId, clientId)
	defer rows.Close()
	if err != nil {
		log.Errorf("QueryRow 'select whatsapp insert queue' failed: %v\n", err)
		return
	}
	for rows.Next() {
		var data WhatsappReaction
		log.Debugf("Processing reaction - GroupId: %v, SenderId: %v, MessageId: %v", data.GroupId, data.SenderId, data.MessageId)
		err = rows.Scan(&data.Id, &data.GroupId, &data.SenderId, &data.Code, &data.MessageId)
		if err != nil {
			continue
		}
		dbpool.Exec(context.Background(), "delete from echo_message_reaction_queue where id = $1;", &data.Id)
		sendNewReaction(data, dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
	}
}

func sendNewMessages(dbpool *pgxpool.Pool, lastGroupInfoSync time.Time, groupsSeen map[types.JID]struct{}, accountId int, clientId int) {
	var q = `select mi.id as id, mi.group_id as group_id, eim.sender_id as recipient_id, m.body as body,
	m.id as echo_message_id, eim.internal_id as quote_id
	from echo_outbox_message_instance mi join echo_outbox_message m on m.id = mi.message_id
	left join echo_inbox_message eim on eim.id = mi.reply_to_inbox_message_id
	where mi.account_id = $1 and m.client_id = $2 and mi.status = 'scheduled' order by mi.updated_at asc limit 100;`
	rows, err := dbpool.Query(context.Background(), q, accountId, clientId)
	defer rows.Close()
	if err != nil {
		log.Errorf("QueryRow 'select whatsapp insert queue' failed: %v\n", err)
		return
	}
	for rows.Next() {
		var data WhatsappMsg
		err = rows.Scan(&data.Id, &data.GroupId, &data.RecipientId, &data.Body, &data.EchoMessageId, &data.QuoteId)
		if err != nil {
			continue
		}
		dbpool.Exec(context.Background(), "update echo_outbox_message_instance set updated_at=now(), status='sent' where id = $1;", &data.Id)
		var resp *whatsmeow.SendResponse = nil
		resp = sendNewMessage(data, dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
		if resp != nil {
			log.Infof("Echo message sent (server timestamp: %s)", resp.Timestamp)
			_, err2 := dbpool.Exec(context.Background(), "update echo_outbox_message_instance set whatsapp_id = $2, updated_at=now(), status='sent', send_ok = true where id = $1;", &data.Id, &resp.ID)
			if err2 != nil {
				log.Errorf("QueryRow failed: %v\n", err2)
			}
		}
	}
}

func editMessages(dbpool *pgxpool.Pool, lastGroupInfoSync time.Time, groupsSeen map[types.JID]struct{}, accountId int, clientId int) {
	var q = `select ep.id as id, mi.whatsapp_id, mi.group_id as group_id, eim.sender_id as recipient_id,
	ep.new_text as body, eim.internal_id as quote_id
	from echo_outbox_message_patch ep
	inner join echo_outbox_message eom on eom.id = ep.message_id
	inner join echo_outbox_message_instance mi on mi.message_id = eom.id
	join echo_inbox_message eim on eim.id = mi.reply_to_inbox_message_id
	where mi.account_id = $1 and eom.client_id = $2 and mi.whatsapp_id is not null order by ep.created_at asc limit 100;`
	rows, err := dbpool.Query(context.Background(), q, accountId, clientId)
	defer rows.Close()
	if err != nil {
		log.Errorf("QueryRow 'select whatsapp update queue' failed: %v\n", err)
		return
	}
	for rows.Next() {
		var data WhatsappMsgPatch
		err = rows.Scan(&data.Id, &data.MessageId, &data.GroupId, &data.RecipientId, &data.Body, &data.QuoteId)
		if err != nil {
			log.Errorf("QueryRow 'select whatsapp update queue' failed: %v\n", err)
			continue
		}
		var attach_q = `select ap.id, a.content_base64, a.path from echo_outbox_message_attachment a
	    	inner join echo_outbox_message_attachment_patch ap on a.id = ap.attachment_id 	where ap.patch_id = $1;`
		attach_rows, attach_err := dbpool.Query(context.Background(), attach_q, &data.Id)
		defer attach_rows.Close()
		if attach_err != nil {
			log.Errorf("QueryRow 'select whatsapp attachment queue' failed: %v\n", attach_err)
			continue
		}

		var attachment_id *int64
		var content_b64 *string
		var path *string

		for attach_rows.Next() {
			attach_rows.Scan(&attachment_id, &content_b64, &path)
		}

		if attachment_id != nil {
			// Prefer DB inline content if present; otherwise, fall back to reading file by path
			if content_b64 != nil && *content_b64 != "" {
				data.AttachmentB64 = content_b64
				dbpool.Exec(context.Background(), "delete from echo_outbox_message_attachment_patch where id = $1;", attachment_id)
			} else if path != nil && *path != "" {
				binData, readErr := os.ReadFile(*path)
				if readErr != nil {
					log.Errorf("Failed to read attachment file '%s': %v", *path, readErr)
				} else {
					b64s := b64.StdEncoding.EncodeToString(binData)
					data.AttachmentB64 = &b64s
					dbpool.Exec(context.Background(), "delete from echo_outbox_message_attachment_patch where id = $1;", attachment_id)
				}
			}
		}
		dbpool.Exec(context.Background(), "delete from echo_outbox_message_patch where id = $1;", &data.Id)
		resp := editMessage(data, dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
		if resp != nil {
			log.Infof("Echo message edited (server timestamp: %s)", resp.Timestamp)
			//             _, err2 := dbpool.Exec(context.Background(), "update echo_outbox_message_instance set whatsapp_id = $2, updated_at=now(), status='sent', send_ok = true where id = $1;", &data.Id, &resp.ID)
			//             if err2 != nil {
			//                 log.Errorf("QueryRow failed: %v\n", err2)
			//             }
		}
	}
}

func sendNewReaction(
	data WhatsappReaction,
	dbpool *pgxpool.Pool,
	lastGroupInfoSync time.Time,
	groupsSeen map[types.JID]struct{},
	accountId int,
	clientId int) *whatsmeow.SendResponse {
	log.Debugf("sendNewReaction starting. Data: %+v", data)
	//chatJid, receiverJid, key, chat, ok
	messageMeta := load_whatsapp_message_meta(dbpool, data.GroupId, data.SenderId, nil, data.MessageId)
	log.Debugf("Loaded messageMeta: %+v", messageMeta)
	if messageMeta == nil {
		log.Infof("messageData not found for GroupId: %v, SenderId: %v, MessageId: %v", data.GroupId, data.SenderId, data.MessageId)
		return nil
	}

	log.Debugf("Building reaction - ChatJid: %s, SenderJid: %s, MessageId: %s, Code: %s",
		messageMeta.chatJid.String(), senderJid.String(), *data.MessageId, data.Code)

	msg := cli.BuildReaction(*messageMeta.chatJid, *senderJid, *data.MessageId, data.Code)
	msg.ReactionMessage.Key = messageMeta.key

	log.Debugf("Reaction message key - ID: %s, RemoteJID: %s, FromMe: %v, Participant: %v",
		*messageMeta.key.ID, *messageMeta.key.RemoteJID, *messageMeta.key.FromMe,
		func() string {
			if messageMeta.key.Participant != nil {
				return *messageMeta.key.Participant
			} else {
				return "nil"
			}
		}())

	log.Debugf("cli.SendMessage starting: %s", *messageMeta.chatJid)
	resp, err := cli.SendMessage(context.Background(), *messageMeta.chatJid, msg)
	if err != nil {
		log.Errorf("Error sending reaction message: %v", err)
	} else {
		log.Infof("Reaction message sent (server timestamp: %s)", resp.Timestamp)
		return &resp
	}
	return nil
}

func editMessage(
	data WhatsappMsgPatch,
	dbpool *pgxpool.Pool,
	lastGroupInfoSync time.Time,
	groupsSeen map[types.JID]struct{},
	accountId int,
	clientId int) *whatsmeow.SendResponse {
	messageMeta := load_whatsapp_message_meta(dbpool, data.GroupId, data.RecipientId, nil, &data.MessageId)
	if messageMeta == nil {
		return nil
	}

	var uploaded *whatsmeow.UploadResponse
	var mimeType *string
	var fileLength *uint64

	if data.AttachmentB64 != nil {
		binData, err_b64 := b64.StdEncoding.DecodeString(*data.AttachmentB64)
		if err_b64 == nil {
			mimeType = proto.String(http.DetectContentType(binData))
			fileLength = proto.Uint64(uint64(len(binData)))
			res_uploaded, err_upload := cli.Upload(context.Background(), binData, whatsmeow.MediaImage)
			if err_upload != nil {
				log.Errorf("Failed to upload file: %v", err_upload)
				return nil
			}
			uploaded = &res_uploaded
		} else {
			log.Errorf("Failed to decode base64 string: %v", err_b64)
		}

	}

	var participant *string
	if messageMeta.receiverJid != nil {
		// Use non-AD JID form for participant in quoted replies to avoid incorrect group-wide notifications
		receiver := messageMeta.receiverJid.ToNonAD().String()
		participant = &receiver
	}

	if uploaded != nil {
		imgMsg := &waE2E.ImageMessage{
			Caption:       proto.String(data.Body),
			URL:           proto.String(uploaded.URL),
			DirectPath:    proto.String(uploaded.DirectPath),
			MediaKey:      uploaded.MediaKey,
			Mimetype:      mimeType,
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    fileLength,
		}
		if data.QuoteId != nil {
			imgMsg.ContextInfo = &waE2E.ContextInfo{
				StanzaID:    data.QuoteId,
				Participant: participant,
			}
		}
		new_message := waE2E.Message{ImageMessage: imgMsg}
		payload := cli.BuildEdit(*messageMeta.chatJid, data.MessageId, &new_message)
		// 		payload.EditedMessage.Message.ProtocolMessage.Key = messageMeta.key

		resp, err := cli.SendMessage(context.Background(), *messageMeta.chatJid, payload, whatsmeow.SendRequestExtra{
			MediaHandle: uploaded.Handle,
		})
		if err != nil {
			log.Errorf("Error sending image message: %v", err)
		} else {
			log.Infof("Image message sent (server timestamp: %s)", resp.Timestamp)
			return &resp
		}
	} else {
		msg := &waE2E.ExtendedTextMessage{Text: proto.String(data.Body)}
		if data.QuoteId != nil {
			msg.ContextInfo = &waE2E.ContextInfo{
				StanzaID:    data.QuoteId,
				Participant: participant,
			}
		}

		new_message := waE2E.Message{ExtendedTextMessage: msg}
		payload := cli.BuildEdit(*messageMeta.chatJid, data.MessageId, &new_message)
		// 		payload.EditedMessage.Message.ProtocolMessage.Key = messageMeta.key

		resp, err_send := cli.SendMessage(context.Background(), *messageMeta.chatJid, payload)
		if err_send != nil {
			log.Errorf("Error sending image message: %v", err_send)
		} else {
			log.Infof("Image message sent (server timestamp: %s)", resp.Timestamp)
			return &resp
		}
	}
	return nil
}

func sendNewMessage(
	data WhatsappMsg,
	dbpool *pgxpool.Pool,
	lastGroupInfoSync time.Time,
	groupsSeen map[types.JID]struct{},
	accountId int,
	clientId int) *whatsmeow.SendResponse {
	messageMeta := load_whatsapp_message_meta(dbpool, data.GroupId, data.RecipientId, nil, nil)
	if messageMeta == nil {
		return nil
	}

	var attach_q = `select content_base64, path from echo_outbox_message_attachment where message_id = $1 limit 1;`
	attach_rows, attach_err := dbpool.Query(context.Background(), attach_q, &data.EchoMessageId)
	defer attach_rows.Close()
	if attach_err != nil {
		log.Errorf("QueryRow 'select echo_outbox_message' failed: %v\n", attach_err)
		return nil
	}

	var uploaded *whatsmeow.UploadResponse
	var contentBase64 *string
	var contentPath *string
	var mimeType *string
	var fileLength *uint64

	for attach_rows.Next() {
		err_scan := attach_rows.Scan(&contentBase64, &contentPath)
		if err_scan != nil {
			log.Errorf("Failed to read attachment row: %v", err_scan)
			continue
		}

		var binData []byte
		var haveData bool

		if contentBase64 != nil {
			decoded, err_b64 := b64.StdEncoding.DecodeString(*contentBase64)
			if err_b64 != nil {
				log.Errorf("Failed to decode base64 string: %v", err_b64)
			} else {
				binData = decoded
				haveData = true
			}
		}

		if !haveData {
			fileBytes, readErr := os.ReadFile(*contentPath)
			if readErr != nil {
				log.Errorf("Failed to read attachment file '%s': %v", *contentPath, readErr)
			} else {
				binData = fileBytes
				haveData = true
			}
		}

		if haveData {
			mimeType = proto.String(http.DetectContentType(binData))
			fileLength = proto.Uint64(uint64(len(binData)))
			res_uploaded, err_upload := cli.Upload(context.Background(), binData, whatsmeow.MediaImage)
			if err_upload != nil {
				log.Errorf("Failed to upload file: %v", err_upload)
				return nil
			}
			uploaded = &res_uploaded
		}
	}

	var participant *string
	if messageMeta.receiverJid != nil {
		// Use non-AD JID form for participant in quoted replies to avoid incorrect group-wide notifications
		receiver := messageMeta.receiverJid.ToNonAD().String()
		participant = &receiver
	}

	if uploaded != nil {
		imgMsg := &waE2E.ImageMessage{
			Caption:       proto.String(data.Body),
			URL:           proto.String(uploaded.URL),
			DirectPath:    proto.String(uploaded.DirectPath),
			MediaKey:      uploaded.MediaKey,
			Mimetype:      mimeType,
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    fileLength,
		}
		if data.QuoteId != nil {
			imgMsg.ContextInfo = &waE2E.ContextInfo{
				StanzaID:    data.QuoteId,
				Participant: participant,
			}
		}
		resp, err := cli.SendMessage(context.Background(), *messageMeta.chatJid, &waE2E.Message{ImageMessage: imgMsg}, whatsmeow.SendRequestExtra{
			MediaHandle: uploaded.Handle,
		})
		if err != nil {
			log.Errorf("Error sending image message %d: %v", data.Id, err)
		} else {
			log.Infof("Image message %d sent (server timestamp: %s)", data.Id, resp.Timestamp)
			return &resp
		}
	} else {
		msg := &waE2E.ExtendedTextMessage{Text: proto.String(data.Body)}
		if data.QuoteId != nil {
			msg.ContextInfo = &waE2E.ContextInfo{
				StanzaID:    data.QuoteId,
				Participant: participant,
			}
		}
		resp, err_send := cli.SendMessage(context.Background(), *messageMeta.chatJid, &waE2E.Message{ExtendedTextMessage: msg})
		if err_send != nil {
			log.Errorf("Error sending text message %d: %v", data.Id, err_send)
		} else {
			log.Infof("Text message %d sent (server timestamp: %s)", data.Id, resp.Timestamp)
			return &resp
		}
	}
	return nil
}

func load_whatsapp_message_meta(dbpool *pgxpool.Pool, group_id *int64, sender_id *int64, _recipient_id *int64, messageID *string) *WhatsappMessageMeta {
	var groupJid *types.JID
	var receiverJid *types.JID

	if group_id != nil {
		q := "select group_id from echo_group where id = $1"
		groupJid = loadJid(dbpool, q, group_id)
	}

	if sender_id != nil {
		q := "select uuid from echo_sender where id = $1"
		receiverJid = loadJid(dbpool, q, sender_id)
	}

	chatJid := groupJid
	if chatJid == nil {
		chatJid = receiverJid
	}

	if chatJid == nil {
		log.Errorf("WhatsappMsg must have either GroupId or RecipientId")
		return nil
	}

	var key *waCommon.MessageKey
	var chat *waE2E.Chat

	if chatJid != nil {
		id := chatJid.String()
		chat = &waE2E.Chat{ID: &id}
	}

	if messageID != nil {
		key = cli.BuildMessageKey(*chatJid, *senderJid, *messageID)
		log.Debugf("Initial key built - Chat: %s, Sender: %s, MessageID: %s", chatJid.String(), senderJid.String(), *messageID)

		if receiverJid != nil && groupJid != nil {
			// For group reactions, keep the group as chat but set participant to original sender
			participant := receiverJid.ToNonAD().String()
			fromMe := false
			key.Participant = &participant
			key.FromMe = &fromMe
			log.Debugf("Group reaction key - Chat: %s, Participant: %s, FromMe: %v", chatJid.String(), participant, fromMe)
		} else if receiverJid != nil {
			// For direct message reactions
			participant := receiverJid.ToNonAD().String()
			fromMe := false
			key = cli.BuildMessageKey(*receiverJid, *senderJid, *messageID)
			key.Participant = &participant
			key.FromMe = &fromMe
			log.Debugf("Direct reaction key - Chat: %s, Participant: %s, FromMe: %v", receiverJid.String(), participant, fromMe)
		}
	}
	result := WhatsappMessageMeta{chatJid: chatJid, receiverJid: receiverJid, key: key, chat: chat}
	log.Debugf("WhatsappMessageMeta built: key=%s", key.String())
	return &result
}

var pattern = regexp.MustCompile(`^(\d+):\d+@lid$`)

func trimLid(input string) string {
	matches := pattern.FindStringSubmatch(input)
	if len(matches) < 2 {
		return input
	}
	return fmt.Sprintf("%s@lid", matches[1])
}

func loadJid(dbpool *pgxpool.Pool, q string, arg *int64) *types.JID {
	var resultJid *types.JID
	rows, err := dbpool.Query(context.Background(), q, arg)
	defer rows.Close()
	if err != nil {
		log.Errorf("QueryRow '%s' failed: %v\n", q, err)
	} else {
		var jid *string
		for rows.Next() {
			err = rows.Scan(&jid)
			if err != nil {
				log.Errorf("Failed to map group rec: %v\n", err)
			}
		}

		if jid != nil {
			jidValue, ok := parseJID(trimLid(*jid))
			if !ok {
				log.Errorf("Failed to parse jid: %s", ok)
			} else {
				resultJid = &jidValue
			}
		}
	}
	return resultJid
}

func handleApiCmd(dbpool *pgxpool.Pool, command string, args string, accountId int, clientId int) {
	if strings.Compare(command, "unlink") == 0 {
		err := cli.Logout(context.Background())
		if err != nil {
			log.Errorf("Error logging out: %v", err)
		}
		var q string
		q = "update echo_account set is_linked = false where source = 'whatsapp' and id = $1;"
		_, err = dbpool.Exec(context.Background(), q, accountId)
		if err != nil {
			log.Errorf("Failed to delete from whatsapp_account_status: %v", err)
		}
		q = "delete from echo_client_lock where account_id = $1 and client_id = $2;"
		_, err = dbpool.Exec(context.Background(), q, accountId, clientId)
		if err != nil {
			log.Errorf("Failed to delete from echo_client_lock: %v", err)
		}
		log.Infof("Successfully logged out")
	} else if strings.Compare(command, "mk_qr") == 0 {
		log.Infof("get QR code command received with args ", args)
		requestQr(dbpool, args, accountId)
	} else {
		log.Infof("unsupported command received: ", command)
	}
}

func main() {
	clientNamePtr := flag.String("client-name", "test", "Client Name")
	configPathPtr := flag.String("config-path", "./echo-im-whatsapp/config-debug.toml", "Path to CLI config")
	flag.Parse()
	clientName := *clientNamePtr
	configPath := *configPathPtr

	log.Infof("clientName=%s, configPath=%s\n", clientName, configPath)

	// Read config file ./config.toml for whatsapp_api_phone string. If it's empty -- sleep in a loop infinitely. If it's not empty -- print value and continue.
	var config Config
	if _, err := toml.DecodeFile(configPath, &config); err != nil {
		fmt.Println(err)
	}

	pgConnS := fmt.Sprintf("postgres://%s:%s@%s:%d/%s", config.PgUser, config.PgPassword, config.PgHost, config.PgPort, config.PgDbname)
	pgConnSLog := fmt.Sprintf("postgres://%s:<...>@%s:%d/%s", config.PgUser, config.PgHost, config.PgPort, config.PgDbname)

	dbpool, err := pgxpool.New(context.Background(), pgConnS)
	if err != nil {
		log.Errorf("Unable to connect to database %s: %v\n", pgConnSLog, err)
		os.Exit(1)
	}
	defer dbpool.Close()

	var q = "select ecc.whatsapp_app_name as app_name, ea.phone_number, ecl.client_id, ea.id from echo_account ea join echo_client_lock ecl on ea.id = ecl.account_id join echo_client ec on ec.id = ecl.client_id join echo_client_config ecc on ecl.client_id = ecc.client_id where ea.source = 'whatsapp' and ec.name = $1;"
	rows, err := dbpool.Query(context.Background(), q, clientName)
	defer rows.Close()
	if err != nil {
		log.Errorf("QueryRow 'select phone number by client' failed: %v\n", err)
		return
	}
	var app_name string
	var phoneNumber string
	var accountId int
	var clientId int
	var has_phone_number = false
	for rows.Next() {
		has_phone_number = true
		err = rows.Scan(&app_name, &phoneNumber, &clientId, &accountId)
		if err != nil {
			log.Errorf("Failed to map phone_number rec: %v\n", err)
			return
		}
	}
	if !has_phone_number {
		log.Errorf("Missing Whastapp phone number in DB for client '%s'\n", clientName)
		return
	}
	fmt.Println("WhatsappApiPhone is", phoneNumber)

	jid, ok := parseJID(phoneNumber)
	if !ok {
		log.Errorf("Failed to parse sender JID: %s", ok)
		return
	}
	senderJid = &jid

	lastGroupInfoSync := time.Now()
	groupsSeen := make(map[types.JID]struct{})

	waBinary.IndentXML = true
	flag.Parse()

	store.DeviceProps.Os = proto.String(app_name)
	if *debugLogs {
		logLevel = "DEBUG"
	}
	if *requestFullSync {
		store.DeviceProps.RequireFullSync = proto.Bool(true)
		store.DeviceProps.HistorySyncConfig = &waCompanionReg.DeviceProps_HistorySyncConfig{
			FullSyncDaysLimit:   proto.Uint32(3650),
			FullSyncSizeMbLimit: proto.Uint32(102400),
			StorageQuotaMb:      proto.Uint32(102400),
		}
	}

	dbLog := waLog.Stdout("Database", logLevel, true)
	storeContainer, err := sqlstore.New(context.Background(), *dbDialect, *dbAddress, dbLog)
	if err != nil {
		log.Errorf("Failed to connect to database: %v", err)
		return
	}
	device, err := storeContainer.GetFirstDevice(context.Background())
	if err != nil {
		log.Errorf("Failed to get device: %v", err)
		return
	}

	cli = whatsmeow.NewClient(device, waLog.Stdout("Client", logLevel, true))
	var isWaitingForPair atomic.Bool
	cli.PrePairCallback = func(jid types.JID, platform, businessName string) bool {
		isWaitingForPair.Store(true)
		defer isWaitingForPair.Store(false)
		log.Infof("Pairing %s (platform: %q, business name: %q). Type r within 3 seconds to reject pair", jid, platform, businessName)
		select {
		case reject := <-pairRejectChan:
			if reject {
				log.Infof("Rejecting pair")
				return false
			}
		case <-time.After(3 * time.Second):
		}
		log.Infof("Accepting pair")
		return true
	}

	requestQr(dbpool, phoneNumber, accountId)

	cli.AddEventHandler(mkHandler(dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId))
	err = cli.Connect()
	if err != nil {
		log.Errorf("Failed to connect: %v", err)
		return
	}

	c := make(chan os.Signal, 1)
	input := make(chan string)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	go func() {
		defer close(input)
		scan := bufio.NewScanner(os.Stdin)
		for scan.Scan() {
			line := strings.TrimSpace(scan.Text())
			if len(line) > 0 {
				input <- line
			}
		}
	}()
	go func() {
		for {
			handleApiCmds(dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
			handleQueue(dbpool, lastGroupInfoSync, groupsSeen, accountId, clientId)
			time.Sleep(1 * time.Second)
		}
	}()
	for {
		select {
		case <-c:
			log.Infof("Interrupt received, exiting")
			cli.Disconnect()
			return
		case cmd := <-input:
			if len(cmd) == 0 {
				// log.Infof("Stdin closed, sleeping")
				time.Sleep(5 * time.Second)
				// cli.Disconnect()
				// return
			} else {
				if isWaitingForPair.Load() {
					if cmd == "r" {
						pairRejectChan <- true
					} else if cmd == "a" {
						pairRejectChan <- false
					}
					continue
				}
				args := strings.Fields(cmd)
				cmd = args[0]
				args = args[1:]
				go handleCmd(strings.ToLower(cmd), args)
			}
		}
	}
}

func requestQr(dbpool *pgxpool.Pool, whatsappApiPhone string, accountId int) {
	ch, err := cli.GetQRChannel(context.Background())
	if err != nil {
		// This error means that we're already logged in, so ignore it.
		if !errors.Is(err, whatsmeow.ErrQRStoreContainsID) {
		}
	} else {
		go func() {
			for evt := range ch {
				if evt.Event == "code" {
					done := capture()
					_, err = dbpool.Exec(context.Background(),
						"update echo_account set is_linked = false where id = $1;",
						accountId,
					)
					if err != nil {
						log.Errorf("Failed to set is_linked = false: %v", err)
					}
					_, err = dbpool.Exec(context.Background(),
						"WITH old_qr_codes AS (DELETE FROM echo_qr_code WHERE account_id = $1 and source = 'whatsapp' RETURNING *) insert into echo_qr_code (account_id, source, content_base64) values ($1, 'whatsapp', $2);",
						accountId,
						evt.Code,
					)
					if err != nil {
						log.Errorf("Failed to insert into qr: %v", err)
					}
					qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
					capturedOutput, err := done()
					if err != nil {
						log.Errorf("Failed to get QR channel: %v", err)
					} else {
						log.Infof("QR: \n%s", capturedOutput)
					}
				} else {
					log.Infof("QR channel result: %s", evt.Event)
				}
			}
		}()
	}
}

func parseJID(arg string) (types.JID, bool) {
	if arg[0] == '+' {
		arg = arg[1:]
	}
	if !strings.ContainsRune(arg, '@') {
		return types.NewJID(arg, types.DefaultUserServer), true
	} else {
		recipient, err := types.ParseJID(arg)
		if err != nil {
			log.Errorf("Invalid JID %s: %v", arg, err)
			return recipient, false
		} else if recipient.User == "" {
			log.Errorf("Invalid JID %s: no server specified", arg)
			return recipient, false
		}
		return recipient, true
	}
}

func handleCmd(cmd string, args []string) {
	switch cmd {
	case "pair-phone":
		if len(args) < 1 {
			log.Errorf("Usage: pair-phone <number>")
			return
		}
		linkingCode, err := cli.PairPhone(context.Background(), args[0], true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err != nil {
			panic(err)
		}
		fmt.Println("Linking code:", linkingCode)
	case "reconnect":
		cli.Disconnect()
		err := cli.Connect()
		if err != nil {
			log.Errorf("Failed to connect: %v", err)
		}
	case "logout":
		err := cli.Logout(context.Background())
		if err != nil {
			log.Errorf("Error logging out: %v", err)
		} else {
			log.Infof("Successfully logged out")
		}
	case "appstate":
		if len(args) < 1 {
			log.Errorf("Usage: appstate <types...>")
			return
		}
		names := []appstate.WAPatchName{appstate.WAPatchName(args[0])}
		if args[0] == "all" {
			names = []appstate.WAPatchName{appstate.WAPatchRegular, appstate.WAPatchRegularHigh, appstate.WAPatchRegularLow, appstate.WAPatchCriticalUnblockLow, appstate.WAPatchCriticalBlock}
		}
		resync := len(args) > 1 && args[1] == "resync"
		for _, name := range names {
			err := cli.FetchAppState(context.Background(), name, resync, false)
			if err != nil {
				log.Errorf("Failed to sync app state: %v", err)
			}
		}
	case "request-appstate-key":
		if len(args) < 1 {
			log.Errorf("Usage: request-appstate-key <ids...>")
			return
		}
		var keyIDs = make([][]byte, len(args))
		for i, id := range args {
			decoded, err := hex.DecodeString(id)
			if err != nil {
				log.Errorf("Failed to decode %s as hex: %v", id, err)
				return
			}
			keyIDs[i] = decoded
		}
		cli.DangerousInternals().RequestAppStateKeys(context.Background(), keyIDs)
	case "unavailable-request":
		if len(args) < 3 {
			log.Errorf("Usage: unavailable-request <chat JID> <sender JID> <message ID>")
			return
		}
		chat, ok := parseJID(args[0])
		if !ok {
			return
		}
		sender, ok := parseJID(args[1])
		if !ok {
			return
		}
		resp, err := cli.SendMessage(
			context.Background(),
			cli.Store.ID.ToNonAD(),
			cli.BuildUnavailableMessageRequest(chat, sender, args[2]),
			whatsmeow.SendRequestExtra{Peer: true},
		)
		fmt.Println(resp)
		fmt.Println(err)
	case "checkuser":
		if len(args) < 1 {
			log.Errorf("Usage: checkuser <phone numbers...>")
			return
		}
		resp, err := cli.IsOnWhatsApp(args)
		if err != nil {
			log.Errorf("Failed to check if users are on WhatsApp: %s", err.Error())
		} else {
			for _, item := range resp {
				if item.VerifiedName != nil {
					log.Infof("%s: on whatsapp: %t, JID: %s, business name: %s", item.Query, item.IsIn, item.JID, item.VerifiedName.Details.GetVerifiedName())
				} else {
					log.Infof("%s: on whatsapp: %t, JID: %s", item.Query, item.IsIn, item.JID)
				}
			}
		}
	case "subscribepresence":
		if len(args) < 1 {
			log.Errorf("Usage: subscribepresence <jid>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		err := cli.SubscribePresence(jid)
		if err != nil {
			fmt.Println(err)
		}
	case "presence":
		if len(args) == 0 {
			log.Errorf("Usage: presence <available/unavailable>")
			return
		}
		fmt.Println(cli.SendPresence(types.Presence(args[0])))
	case "chatpresence":
		if len(args) == 2 {
			args = append(args, "")
		} else if len(args) < 2 {
			log.Errorf("Usage: chatpresence <jid> <composing/paused> [audio]")
			return
		}
		jid, _ := types.ParseJID(args[0])
		fmt.Println(cli.SendChatPresence(jid, types.ChatPresence(args[1]), types.ChatPresenceMedia(args[2])))
	case "privacysettings":
		resp, err := cli.TryFetchPrivacySettings(context.Background(), false)
		if err != nil {
			fmt.Println(err)
		} else {
			fmt.Printf("%+v\n", resp)
		}
	case "setprivacysetting":
		if len(args) < 2 {
			log.Errorf("Usage: setprivacysetting <setting> <value>")
			return
		}
		setting := types.PrivacySettingType(args[0])
		value := types.PrivacySetting(args[1])
		resp, err := cli.SetPrivacySetting(context.Background(), setting, value)
		if err != nil {
			fmt.Println(err)
		} else {
			fmt.Printf("%+v\n", resp)
		}
	case "getuser":
		if len(args) < 1 {
			log.Errorf("Usage: getuser <jids...>")
			return
		}
		var jids []types.JID
		for _, arg := range args {
			jid, ok := parseJID(arg)
			if !ok {
				return
			}
			jids = append(jids, jid)
		}
		resp, err := cli.GetUserInfo(jids)
		if err != nil {
			log.Errorf("Failed to get user info: %v", err)
		} else {
			for jid, info := range resp {
				log.Infof("%s: %+v", jid, info)
			}
		}
	case "mediaconn":
		conn, err := cli.DangerousInternals().RefreshMediaConn(context.Background(), false)

		if err != nil {
			log.Errorf("Failed to get media connection: %v", err)
		} else {
			log.Infof("Media connection: %+v", conn)
		}
	case "raw":
		var node waBinary.Node
		if err := json.Unmarshal([]byte(strings.Join(args, " ")), &node); err != nil {
			log.Errorf("Failed to parse args as JSON into XML node: %v", err)
		} else if err = cli.DangerousInternals().SendNode(node); err != nil {
			log.Errorf("Error sending node: %v", err)
		} else {
			log.Infof("Node sent")
		}
	case "listnewsletters":
		newsletters, err := cli.GetSubscribedNewsletters()
		if err != nil {
			log.Errorf("Failed to get subscribed newsletters: %v", err)
			return
		}
		for _, newsletter := range newsletters {
			log.Infof("* %s: %s", newsletter.ID, newsletter.ThreadMeta.Name.Text)
		}
	case "getnewsletter":
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		meta, err := cli.GetNewsletterInfo(jid)
		if err != nil {
			log.Errorf("Failed to get info: %v", err)
		} else {
			log.Infof("Got info: %+v", meta)
		}
	case "getnewsletterinvite":
		meta, err := cli.GetNewsletterInfoWithInvite(args[0])
		if err != nil {
			log.Errorf("Failed to get info: %v", err)
		} else {
			log.Infof("Got info: %+v", meta)
		}
	case "livesubscribenewsletter":
		if len(args) < 1 {
			log.Errorf("Usage: livesubscribenewsletter <jid>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		dur, err := cli.NewsletterSubscribeLiveUpdates(context.TODO(), jid)
		if err != nil {
			log.Errorf("Failed to subscribe to live updates: %v", err)
		} else {
			log.Infof("Subscribed to live updates for %s for %s", jid, dur)
		}
	case "getnewslettermessages":
		if len(args) < 1 {
			log.Errorf("Usage: getnewslettermessages <jid> [count] [before id]")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		count := 100
		var err error
		if len(args) > 1 {
			count, err = strconv.Atoi(args[1])
			if err != nil {
				log.Errorf("Invalid count: %v", err)
				return
			}
		}
		var before types.MessageServerID
		if len(args) > 2 {
			before, err = strconv.Atoi(args[2])
			if err != nil {
				log.Errorf("Invalid message ID: %v", err)
				return
			}
		}
		messages, err := cli.GetNewsletterMessages(jid, &whatsmeow.GetNewsletterMessagesParams{Count: count, Before: before})
		if err != nil {
			log.Errorf("Failed to get messages: %v", err)
		} else {
			for _, msg := range messages {
				log.Infof("%d: %+v (viewed %d times)", msg.MessageServerID, msg.Message, msg.ViewsCount)
			}
		}
	case "createnewsletter":
		if len(args) < 1 {
			log.Errorf("Usage: createnewsletter <name>")
			return
		}
		resp, err := cli.CreateNewsletter(whatsmeow.CreateNewsletterParams{
			Name: strings.Join(args, " "),
		})
		if err != nil {
			log.Errorf("Failed to create newsletter: %v", err)
		} else {
			log.Infof("Created newsletter %+v", resp)
		}
	case "getavatar":
		if len(args) < 1 {
			log.Errorf("Usage: getavatar <jid> [existing ID] [--preview] [--community]")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		existingID := ""
		if len(args) > 2 {
			existingID = args[2]
		}
		var preview, isCommunity bool
		for _, arg := range args {
			if arg == "--preview" {
				preview = true
			} else if arg == "--community" {
				isCommunity = true
			}
		}
		pic, err := cli.GetProfilePictureInfo(jid, &whatsmeow.GetProfilePictureParams{
			Preview:     preview,
			IsCommunity: isCommunity,
			ExistingID:  existingID,
		})
		if err != nil {
			log.Errorf("Failed to get avatar: %v", err)
		} else if pic != nil {
			log.Infof("Got avatar ID %s: %s", pic.ID, pic.URL)
		} else {
			log.Infof("No avatar found")
		}
	case "getgroup":
		if len(args) < 1 {
			log.Errorf("Usage: getgroup <jid>")
			return
		}
		group, ok := parseJID(args[0])
		if !ok {
			return
		} else if group.Server != types.GroupServer {
			log.Errorf("Input must be a group JID (@%s)", types.GroupServer)
			return
		}
		resp, err := cli.GetGroupInfo(group)
		if err != nil {
			log.Errorf("Failed to get group info: %v", err)
		} else {
			log.Infof("Group info: %+v", resp)
		}
	case "subgroups":
		if len(args) < 1 {
			log.Errorf("Usage: subgroups <jid>")
			return
		}
		group, ok := parseJID(args[0])
		if !ok {
			return
		} else if group.Server != types.GroupServer {
			log.Errorf("Input must be a group JID (@%s)", types.GroupServer)
			return
		}
		resp, err := cli.GetSubGroups(group)
		if err != nil {
			log.Errorf("Failed to get subgroups: %v", err)
		} else {
			for _, sub := range resp {
				log.Infof("Subgroup: %+v", sub)
			}
		}
	case "communityparticipants":
		if len(args) < 1 {
			log.Errorf("Usage: communityparticipants <jid>")
			return
		}
		group, ok := parseJID(args[0])
		if !ok {
			return
		} else if group.Server != types.GroupServer {
			log.Errorf("Input must be a group JID (@%s)", types.GroupServer)
			return
		}
		resp, err := cli.GetLinkedGroupsParticipants(group)
		if err != nil {
			log.Errorf("Failed to get community participants: %v", err)
		} else {
			log.Infof("Community participants: %+v", resp)
		}
	case "listgroups":
		groups, err := cli.GetJoinedGroups(context.Background())
		if err != nil {
			log.Errorf("Failed to get group list: %v", err)
		} else {
			for _, group := range groups {
				log.Infof("%+v", group)
			}
		}
	case "getinvitelink":
		if len(args) < 1 {
			log.Errorf("Usage: getinvitelink <jid> [--reset]")
			return
		}
		group, ok := parseJID(args[0])
		if !ok {
			return
		} else if group.Server != types.GroupServer {
			log.Errorf("Input must be a group JID (@%s)", types.GroupServer)
			return
		}
		resp, err := cli.GetGroupInviteLink(group, len(args) > 1 && args[1] == "--reset")
		if err != nil {
			log.Errorf("Failed to get group invite link: %v", err)
		} else {
			log.Infof("Group invite link: %s", resp)
		}
	case "queryinvitelink":
		if len(args) < 1 {
			log.Errorf("Usage: queryinvitelink <link>")
			return
		}
		resp, err := cli.GetGroupInfoFromLink(args[0])
		if err != nil {
			log.Errorf("Failed to resolve group invite link: %v", err)
		} else {
			log.Infof("Group info: %+v", resp)
		}
	case "querybusinesslink":
		if len(args) < 1 {
			log.Errorf("Usage: querybusinesslink <link>")
			return
		}
		resp, err := cli.ResolveBusinessMessageLink(args[0])
		if err != nil {
			log.Errorf("Failed to resolve business message link: %v", err)
		} else {
			log.Infof("Business info: %+v", resp)
		}
	case "joininvitelink":
		if len(args) < 1 {
			log.Errorf("Usage: acceptinvitelink <link>")
			return
		}
		groupID, err := cli.JoinGroupWithLink(args[0])
		if err != nil {
			log.Errorf("Failed to join group via invite link: %v", err)
		} else {
			log.Infof("Joined %s", groupID)
		}
	case "updateparticipant":
		if len(args) < 3 {
			log.Errorf("Usage: updateparticipant <jid> <action> <numbers...>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		action := whatsmeow.ParticipantChange(args[1])
		switch action {
		case whatsmeow.ParticipantChangeAdd, whatsmeow.ParticipantChangeRemove, whatsmeow.ParticipantChangePromote, whatsmeow.ParticipantChangeDemote:
		default:
			log.Errorf("Valid actions: add, remove, promote, demote")
			return
		}
		users := make([]types.JID, len(args)-2)
		for i, arg := range args[2:] {
			users[i], ok = parseJID(arg)
			if !ok {
				return
			}
		}
		resp, err := cli.UpdateGroupParticipants(jid, users, action)
		if err != nil {
			log.Errorf("Failed to add participant: %v", err)
			return
		}
		for _, item := range resp {
			if action == whatsmeow.ParticipantChangeAdd && item.Error == 403 && item.AddRequest != nil {
				log.Infof("Participant is private: %d %s %s %v", item.Error, item.JID, item.AddRequest.Code, item.AddRequest.Expiration)
				resp, err := cli.SendMessage(context.TODO(), item.JID, &waE2E.Message{
					GroupInviteMessage: &waE2E.GroupInviteMessage{
						InviteCode:       proto.String(item.AddRequest.Code),
						InviteExpiration: proto.Int64(item.AddRequest.Expiration.Unix()),
						GroupJID:         proto.String(jid.String()),
						GroupName:        proto.String("Test group"),
						Caption:          proto.String("This is a test group"),
					},
				})
				if err != nil {
					log.Errorf("Error sending group invite: %v", err)
				} else {
					log.Infof("Group Invite sent (server timestamp: %s)", resp.Timestamp)
				}
			} else if item.Error == 409 {
				log.Infof("Participant already in group: %d %s", item.Error, item.JID)
			} else if item.Error == 0 {
				log.Infof("Added participant: %d %s", item.Error, item.JID)
			} else {
				log.Infof("Unknown status: %d %s", item.Error, item.JID)
			}
		}
	case "getrequestparticipant":
		if len(args) < 1 {
			log.Errorf("Usage: getrequestparticipant <jid>")
			return
		}
		group, ok := parseJID(args[0])
		if !ok {
			log.Errorf("Invalid JID")
			return
		}
		resp, err := cli.GetGroupRequestParticipants(group)
		if err != nil {
			log.Errorf("Failed to get request participants: %v", err)
		} else {
			log.Infof("Request participants: %+v", resp)
		}
	case "getstatusprivacy":
		resp, err := cli.GetStatusPrivacy()
		fmt.Println(err)
		fmt.Println(resp)
	case "setdisappeartimer":
		if len(args) < 2 {
			log.Errorf("Usage: setdisappeartimer <jid> <days>")
			return
		}
		days, err := strconv.Atoi(args[1])
		if err != nil {
			log.Errorf("Invalid duration: %v", err)
			return
		}
		recipient, ok := parseJID(args[0])
		if !ok {
			return
		}
		err = cli.SetDisappearingTimer(recipient, time.Duration(days)*24*time.Hour, time.Now())
		if err != nil {
			log.Errorf("Failed to set disappearing timer: %v", err)
		}
	case "setdefaultdisappeartimer":
		if len(args) < 1 {
			log.Errorf("Usage: setdefaultdisappeartimer <days>")
			return
		}
		days, err := strconv.Atoi(args[0])
		if err != nil {
			log.Errorf("Invalid duration: %v", err)
			return
		}
		err = cli.SetDefaultDisappearingTimer(time.Duration(days) * 24 * time.Hour)
		if err != nil {
			log.Errorf("Failed to set default disappearing timer: %v", err)
		}
	case "send":
		if len(args) < 2 {
			log.Errorf("Usage: send <jid> <text>")
			return
		}
		recipient, ok := parseJID(args[0])
		if !ok {
			return
		}
		msg := &waE2E.Message{Conversation: proto.String(strings.Join(args[1:], " "))}
		resp, err := cli.SendMessage(context.Background(), recipient, msg)
		if err != nil {
			log.Errorf("Error sending message: %v", err)
		} else {
			log.Infof("Message sent (server timestamp: %s)", resp.Timestamp)
		}
	case "sendpoll":
		if len(args) < 7 {
			log.Errorf("Usage: sendpoll <jid> <max answers> <question> -- <option 1> / <option 2> / ...")
			return
		}
		recipient, ok := parseJID(args[0])
		if !ok {
			return
		}
		maxAnswers, err := strconv.Atoi(args[1])
		if err != nil {
			log.Errorf("Number of max answers must be an integer")
			return
		}
		remainingArgs := strings.Join(args[2:], " ")
		question, optionsStr, _ := strings.Cut(remainingArgs, "--")
		question = strings.TrimSpace(question)
		options := strings.Split(optionsStr, "/")
		for i, opt := range options {
			options[i] = strings.TrimSpace(opt)
		}
		resp, err := cli.SendMessage(context.Background(), recipient, cli.BuildPollCreation(question, options, maxAnswers))
		if err != nil {
			log.Errorf("Error sending message: %v", err)
		} else {
			log.Infof("Message sent (server timestamp: %s)", resp.Timestamp)
		}
	case "react":
		if len(args) < 3 {
			log.Errorf("Usage: react <jid> <message ID> <reaction>")
			return
		}
		recipient, ok := parseJID(args[0])
		if !ok {
			return
		}
		messageID := args[1]
		fromMe := false
		if strings.HasPrefix(messageID, "me:") {
			fromMe = true
			messageID = messageID[len("me:"):]
		}
		reaction := args[2]
		if reaction == "remove" {
			reaction = ""
		}
		msg := &waE2E.Message{
			ReactionMessage: &waE2E.ReactionMessage{
				Key: &waCommon.MessageKey{
					RemoteJID: proto.String(recipient.String()),
					FromMe:    proto.Bool(fromMe),
					ID:        proto.String(messageID),
				},
				Text:              proto.String(reaction),
				SenderTimestampMS: proto.Int64(time.Now().UnixMilli()),
			},
		}
		resp, err := cli.SendMessage(context.Background(), recipient, msg)
		if err != nil {
			log.Errorf("Error sending reaction: %v", err)
		} else {
			log.Infof("Reaction sent (server timestamp: %s)", resp.Timestamp)
		}
	case "revoke":
		if len(args) < 2 {
			log.Errorf("Usage: revoke <jid> <message ID>")
			return
		}
		recipient, ok := parseJID(args[0])
		if !ok {
			return
		}
		messageID := args[1]
		resp, err := cli.SendMessage(context.Background(), recipient, cli.BuildRevoke(recipient, types.EmptyJID, messageID))
		if err != nil {
			log.Errorf("Error sending revocation: %v", err)
		} else {
			log.Infof("Revocation sent (server timestamp: %s)", resp.Timestamp)
		}
	case "sendimg":
		if len(args) < 2 {
			log.Errorf("Usage: sendimg <jid> <image path> [caption]")
			return
		}
		recipient, ok := parseJID(args[0])
		if !ok {
			return
		}
		data, err := os.ReadFile(args[1])
		if err != nil {
			log.Errorf("Failed to read %s: %v", args[0], err)
			return
		}
		var uploaded whatsmeow.UploadResponse
		if recipient.Server == types.NewsletterServer {
			uploaded, err = cli.UploadNewsletter(context.Background(), data, whatsmeow.MediaImage)
		} else {
			uploaded, err = cli.Upload(context.Background(), data, whatsmeow.MediaImage)
		}
		if err != nil {
			log.Errorf("Failed to upload file: %v", err)
			return
		}
		msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption:       proto.String(strings.Join(args[2:], " ")),
			URL:           proto.String(uploaded.URL),
			DirectPath:    proto.String(uploaded.DirectPath),
			MediaKey:      uploaded.MediaKey,
			Mimetype:      proto.String(http.DetectContentType(data)),
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    proto.Uint64(uint64(len(data))),
		}}
		resp, err := cli.SendMessage(context.Background(), recipient, msg, whatsmeow.SendRequestExtra{
			MediaHandle: uploaded.Handle,
		})
		if err != nil {
			log.Errorf("Error sending image message: %v", err)
		} else {
			log.Infof("Image message sent (server timestamp: %s)", resp.Timestamp)
		}
	case "setpushname":
		if len(args) == 0 {
			log.Errorf("Usage: setpushname <name>")
			return
		}
		err := cli.SendAppState(context.Background(), appstate.BuildSettingPushName(strings.Join(args, " ")))
		if err != nil {
			log.Errorf("Error setting push name: %v", err)
		} else {
			log.Infof("Push name updated")
		}
	case "setstatus":
		if len(args) == 0 {
			log.Errorf("Usage: setstatus <message>")
			return
		}
		err := cli.SetStatusMessage(strings.Join(args, " "))
		if err != nil {
			log.Errorf("Error setting status message: %v", err)
		} else {
			log.Infof("Status updated")
		}
	case "archive":
		if len(args) < 2 {
			log.Errorf("Usage: archive <jid> <action>")
			return
		}
		target, ok := parseJID(args[0])
		if !ok {
			return
		}
		action, err := strconv.ParseBool(args[1])
		if err != nil {
			log.Errorf("invalid second argument: %v", err)
			return
		}

		err = cli.SendAppState(context.Background(), appstate.BuildArchive(target, action, time.Time{}, nil))
		if err != nil {
			log.Errorf("Error changing chat's archive state: %v", err)
		}
	case "mute":
		if len(args) < 2 {
			log.Errorf("Usage: mute <jid> <action>")
			return
		}
		target, ok := parseJID(args[0])
		if !ok {
			return
		}
		action, err := strconv.ParseBool(args[1])
		if err != nil {
			log.Errorf("invalid second argument: %v", err)
			return
		}

		err = cli.SendAppState(context.Background(), appstate.BuildMute(target, action, 1*time.Hour))
		if err != nil {
			log.Errorf("Error changing chat's mute state: %v", err)
		}
	case "pin":
		if len(args) < 2 {
			log.Errorf("Usage: pin <jid> <action>")
			return
		}
		target, ok := parseJID(args[0])
		if !ok {
			return
		}
		action, err := strconv.ParseBool(args[1])
		if err != nil {
			log.Errorf("invalid second argument: %v", err)
			return
		}

		err = cli.SendAppState(context.Background(), appstate.BuildPin(target, action))
		if err != nil {
			log.Errorf("Error changing chat's pin state: %v", err)
		}
	case "getblocklist":
		blocklist, err := cli.GetBlocklist()
		if err != nil {
			log.Errorf("Failed to get blocked contacts list: %v", err)
		} else {
			log.Infof("Blocklist: %+v", blocklist)
		}
	case "block":
		if len(args) < 1 {
			log.Errorf("Usage: block <jid>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		resp, err := cli.UpdateBlocklist(jid, events.BlocklistChangeActionBlock)
		if err != nil {
			log.Errorf("Error updating blocklist: %v", err)
		} else {
			log.Infof("Blocklist updated: %+v", resp)
		}
	case "unblock":
		if len(args) < 1 {
			log.Errorf("Usage: unblock <jid>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		resp, err := cli.UpdateBlocklist(jid, events.BlocklistChangeActionUnblock)
		if err != nil {
			log.Errorf("Error updating blocklist: %v", err)
		} else {
			log.Infof("Blocklist updated: %+v", resp)
		}
	case "labelchat":
		if len(args) < 3 {
			log.Errorf("Usage: labelchat <jid> <labelID> <action>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		labelID := args[1]
		action, err := strconv.ParseBool(args[2])
		if err != nil {
			log.Errorf("invalid third argument: %v", err)
			return
		}

		err = cli.SendAppState(context.Background(), appstate.BuildLabelChat(jid, labelID, action))
		if err != nil {
			log.Errorf("Error changing chat's label state: %v", err)
		}
	case "labelmessage":
		if len(args) < 4 {
			log.Errorf("Usage: labelmessage <jid> <labelID> <messageID> <action>")
			return
		}
		jid, ok := parseJID(args[0])
		if !ok {
			return
		}
		labelID := args[1]
		messageID := args[2]
		action, err := strconv.ParseBool(args[3])
		if err != nil {
			log.Errorf("invalid fourth argument: %v", err)
			return
		}

		err = cli.SendAppState(context.Background(), appstate.BuildLabelMessage(jid, labelID, messageID, action))
		if err != nil {
			log.Errorf("Error changing message's label state: %v", err)
		}
	case "editlabel":
		if len(args) < 4 {
			log.Errorf("Usage: editlabel <labelID> <name> <color> <action>")
			return
		}
		labelID := args[0]
		name := args[1]
		color, err := strconv.Atoi(args[2])
		if err != nil {
			log.Errorf("invalid third argument: %v", err)
			return
		}
		action, err := strconv.ParseBool(args[3])
		if err != nil {
			log.Errorf("invalid fourth argument: %v", err)
			return
		}

		err = cli.SendAppState(context.Background(), appstate.BuildLabelEdit(labelID, name, int32(color), action))
		if err != nil {
			log.Errorf("Error editing label: %v", err)
		}
	}
}

var historySyncID int32
var startupTime = time.Now().Unix()

func mkHandler(dbpool *pgxpool.Pool, lastGroupInfoSync time.Time, groupsSeen map[types.JID]struct{}, accountId int, clientId int) func(interface{}) {
	return func(rawEvt interface{}) {
		switch evt := rawEvt.(type) {
		case *events.LoggedOut:
			q := "update echo_account set is_linked = false where source = 'whatsapp' and id = $1;"
			_, err := dbpool.Exec(context.Background(), q, accountId)
			if err != nil {
				log.Errorf("Failed to delete from whatsapp_account_status: %v", err)
			}
			q = "delete from echo_client_lock where account_id = $1 and client_id = $2;"
			_, err = dbpool.Exec(context.Background(), q, accountId, clientId)
			if err != nil {
				log.Errorf("Failed to delete from echo_client_lock: %v", err)
			}
			log.Infof("Successfully logged out")
		case *events.PairSuccess:
			log.Infof("PairSuccess: %s", evt.ID.String())
			parts := strings.Split(evt.ID.String(), ":")
			if len(parts) > 0 {
				whatsappApiPhone := parts[0]
				is_number := true
				for _, char := range whatsappApiPhone {
					if !unicode.IsDigit(char) {
						is_number = false
						break
					}
				}
				if is_number {
					whatsappApiPhone = "+" + whatsappApiPhone
					q := "update echo_account set is_linked = true where phone_number = $1 and source = 'whatsapp' and id = $2;"
					_, err := dbpool.Exec(context.Background(), q, whatsappApiPhone, accountId)
					if err != nil {
						log.Errorf("Failed to update echo_account: %v", err)
					}
				}
			}

		case *events.AppStateSyncComplete:
			if len(cli.Store.PushName) > 0 && evt.Name == appstate.WAPatchCriticalBlock {
				err := cli.SendPresence(types.PresenceAvailable)
				is_ok := err == nil
				q := "update echo_account set is_linked = $1 where source = 'whatsapp' and id = $2;"
				dbpool.Exec(context.Background(), q, is_ok, accountId)
				if err != nil {
					log.Warnf("Failed to send available presence: %v", err)
				} else {
					log.Infof("Marked self as available")
				}
			}
		case *events.Connected, *events.PushNameSetting:
			if len(cli.Store.PushName) == 0 {
				return
			}
			// Send presence available when connecting and when the pushname is changed.
			// This makes sure that outgoing messages always have the right pushname.
			err := cli.SendPresence(types.PresenceAvailable)
			if err != nil {
				log.Warnf("Failed to send available presence: %v", err)
			} else {
				log.Infof("Marked self as available")
			}
		case *events.StreamReplaced:
			os.Exit(0)
		case *events.Message:
			has_content := false
			metaParts := []string{fmt.Sprintf("pushname: %s", evt.Info.PushName), fmt.Sprintf("timestamp: %s", evt.Info.Timestamp)}
			if evt.Info.Type != "" {
				metaParts = append(metaParts, fmt.Sprintf("type: %s", evt.Info.Type))
			}
			if evt.Info.Category != "" {
				metaParts = append(metaParts, fmt.Sprintf("category: %s", evt.Info.Category))
			}
			if evt.IsViewOnce {
				metaParts = append(metaParts, "view once")
			}
			if evt.IsViewOnce {
				metaParts = append(metaParts, "ephemeral")
			}
			if evt.IsViewOnceV2 {
				metaParts = append(metaParts, "ephemeral (v2)")
			}
			if evt.IsDocumentWithCaption {
				metaParts = append(metaParts, "document with caption")
			}
			if evt.IsEdit {
				metaParts = append(metaParts, "edit")
			}

			log.Infof("Received message %s from %s (%s): %+v", evt.Info.ID, evt.Info.SourceString(), strings.Join(metaParts, ", "), evt.Message)

			// 			must be like "2024-03-02 14:01:42.460" in UTC
			timestamp := evt.Info.Timestamp
			timestampS := timestamp.UTC().Format("2006-01-02 15:04:05.000")

			var source_message_id *string
			message := evt.Message
			protocol_message := evt.Message.ProtocolMessage
			if protocol_message != nil {
				edit_message := protocol_message.EditedMessage
				if edit_message != nil {
					message = edit_message
					source_message_id = protocol_message.Key.ID
				}
			}

			conversation := message.GetConversation()
			var quote_id *string
			if message.ExtendedTextMessage != nil {
				conversation = message.ExtendedTextMessage.GetText()
				context := message.ExtendedTextMessage.ContextInfo
				if context != nil {
					quote_id = context.StanzaID
				}
			}
			if message.VideoMessage != nil {
				has_content = true
				conversation = message.VideoMessage.GetCaption()
				context := message.VideoMessage.ContextInfo
				if context != nil {
					quote_id = context.StanzaID
				}
			}
			if message.ImageMessage != nil {
				has_content = true
				conversation = message.ImageMessage.GetCaption()
				context := message.ImageMessage.ContextInfo
				if context != nil {
					quote_id = context.StanzaID
				}
			}
			if message.DocumentMessage != nil {
				has_content = true
				conversation = message.DocumentMessage.GetCaption()
				context := message.DocumentMessage.ContextInfo
				if context != nil {
					quote_id = context.StanzaID
				}
			}
			if conversation != "" || has_content {
				q := "insert into echo_whatsapp_queue (from_jid, from_pushname, group_jid, timestamp, body, whatsapp_id, account_id, client_id, source_message_id, quoted_message_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"
				_, err := dbpool.Exec(context.Background(),
					q,
					evt.Info.Sender.String(),
					evt.Info.PushName,
					evt.Info.Chat,
					timestampS,
					conversation,
					evt.Info.ID,
					accountId,
					clientId,
					source_message_id,
					quote_id,
				)
				if err != nil {
					log.Errorf("Failed to insert into whatsapp_queue: %v", err)
				}
			}

			// upsert
			var profile_id *int64
			var uuid = evt.Info.Sender.String()
			var name = evt.Info.PushName
			var q = "select id from echo_whatsapp_profile where account_id=$1 and uuid=$2;"
			rows, err := dbpool.Query(context.Background(), q, accountId, uuid)
			defer rows.Close()
			if err != nil {
				log.Errorf("QueryRow 'select echo_whatsapp_profile' failed: %v\n", err)
			} else {
				for rows.Next() {
					err = rows.Scan(&profile_id)
					if err != nil {
						log.Errorf("Failed to map echo_whatsapp_profile rec: %v\n", err)
					}
				}
			}
			if profile_id != nil {
				_, err := dbpool.Exec(context.Background(),
					"update echo_whatsapp_profile set given_name = $1 where id = $2",
					name,
					profile_id,
				)
				if err != nil {
					log.Errorf("Failed to update in echo_whatsapp_profile: %v", err)
				}
			} else {
				_, err := dbpool.Exec(context.Background(),
					"insert into echo_whatsapp_profile (uuid, given_name, account_id) values ($1, $2, $3)",
					uuid,
					name,
					accountId,
				)
				if err != nil {
					log.Errorf("Failed to insert into echo_whatsapp_profile: %v", err)
				}
			}

			// add groupsSeen
			if evt.Info.Chat.Server == types.GroupServer {
				groupsSeen[evt.Info.Chat] = struct{}{}
			}

			// if it's more than 10 secs since last group info sync, sync them from groupsSeen and clear the value
			if time.Since(lastGroupInfoSync) > 10*time.Second {
				log.Infof("Syncing group info for %d groups", len(groupsSeen))

				for group := range groupsSeen {
					groupInfo, err := cli.GetGroupInfo(group)
					if err != nil {
						log.Errorf("Failed to get group info for %s: %v", group, err)
						continue
					}

					var group_id *int64
					var groupJid = group.String()
					var owner_jid = groupInfo.OwnerJID
					var name = groupInfo.GroupName.Name

					log.Infof("Syncing group %s (%s)", groupJid, name)

					var q = "select id from echo_whatsapp_group where account_id=$1 and jid=$2;"
					rows, err := dbpool.Query(context.Background(), q, accountId, groupJid)
					defer rows.Close()
					if err != nil {
						log.Errorf("QueryRow 'select echo_whatsapp_group' failed: %v\n", err)
					} else {
						for rows.Next() {
							err = rows.Scan(&group_id)
							if err != nil {
								log.Errorf("Failed to map echo_whatsapp_group rec: %v\n", err)
							}
						}
					}
					if group_id != nil {
						_, err := dbpool.Exec(context.Background(),
							"update echo_whatsapp_group set owner_jid = $1, name = $2 where id = $3",
							owner_jid,
							name,
							group_id,
						)
						if err != nil {
							log.Errorf("Failed to update in echo_whatsapp_group: %v", err)
						}
					} else {
						_, err := dbpool.Exec(context.Background(),
							"insert into echo_whatsapp_group (jid, owner_jid, name, account_id) values ($1, $2, $3, $4) ",
							groupJid,
							owner_jid,
							name,
							accountId,
						)
						if err != nil {
							log.Errorf("Failed to insert into echo_whatsapp_group: %v", err)
						}
					}
				}
				groupsSeen = make(map[types.JID]struct{})
				lastGroupInfoSync = time.Now()
			}

			if evt.Message.GetPollUpdateMessage() != nil {
				decrypted, err := cli.DecryptPollVote(context.Background(), evt)
				if err != nil {
					log.Errorf("Failed to decrypt vote: %v", err)
				} else {
					log.Infof("Selected options in decrypted vote:")
					for _, option := range decrypted.SelectedOptions {
						log.Infof("- %X", option)
					}
				}
			} else if evt.Message.GetEncReactionMessage() != nil {
				decrypted, err := cli.DecryptReaction(context.Background(), evt)
				if err != nil {
					log.Errorf("Failed to decrypt encrypted reaction: %v", err)
				} else {
					log.Infof("Decrypted reaction: %+v", decrypted)
				}
			}

			img := evt.Message.GetImageMessage()
			if img != nil {
				data, err := cli.Download(context.Background(), img)
				if err != nil {
					log.Errorf("Failed to download image: %v", err)
					return
				}
				exts, _ := mime.ExtensionsByType(img.GetMimetype())
				path := fmt.Sprintf("%s%s", evt.Info.ID, exts[0])
				err = os.WriteFile(path, data, 0600)
				if err != nil {
					log.Errorf("Failed to save image: %v", err)
					return
				}
				log.Infof("Saved image in message to %s", path)
				fullOsPath, err := filepath.Abs(path)
				if err != nil {
					log.Errorf("Failed to get absolute path: %v", err)
					return
				}
				q := "insert into echo_whatsapp_queue_attachment (whatsapp_id, path, account_id) values ($1, $2, $3)"
				_, err = dbpool.Exec(context.Background(), q, evt.Info.ID, fullOsPath, accountId)
				if err != nil {
					log.Errorf("Failed to insert into whatsapp_queue_attachment: %v", err)
				}
			}

			video := evt.Message.GetVideoMessage()
			if video != nil {
				data, err := cli.Download(context.Background(), video)
				if err != nil {
					log.Errorf("Failed to download video: %v", err)
					return
				}
				exts, _ := mime.ExtensionsByType(video.GetMimetype())
				path := fmt.Sprintf("%s%s", evt.Info.ID, exts[0])
				err = os.WriteFile(path, data, 0600)
				if err != nil {
					log.Errorf("Failed to save video: %v", err)
					return
				}
				log.Infof("Saved video in message to %s", path)
				fullOsPath, err := filepath.Abs(path)
				if err != nil {
					log.Errorf("Failed to get absolute path: %v", err)
					return
				}
				q := "insert into echo_whatsapp_queue_attachment (whatsapp_id, path, account_id) values ($1, $2, $3)"
				_, err = dbpool.Exec(context.Background(), q, evt.Info.ID, fullOsPath, accountId)
				if err != nil {
					log.Errorf("Failed to insert into whatsapp_queue_attachment: %v", err)
				}
			}

			document := evt.Message.GetDocumentMessage()
			if document != nil {
				data, err := cli.Download(context.Background(), document)
				if err != nil {
					log.Errorf("Failed to download document: %v", err)
					return
				}
				exts, _ := mime.ExtensionsByType(document.GetMimetype())
				path := fmt.Sprintf("%s%s", evt.Info.ID, exts[0])
				err = os.WriteFile(path, data, 0600)
				if err != nil {
					log.Errorf("Failed to save document: %v", err)
					return
				}
				log.Infof("Saved document in message to %s", path)
				fullOsPath, err := filepath.Abs(path)
				if err != nil {
					log.Errorf("Failed to get absolute path: %v", err)
					return
				}
				q := "insert into echo_whatsapp_queue_attachment (whatsapp_id, path, account_id) values ($1, $2, $3)"
				_, err = dbpool.Exec(context.Background(), q, evt.Info.ID, fullOsPath, accountId)
				if err != nil {
					log.Errorf("Failed to insert into whatsapp_queue_attachment: %v", err)
				}
			}
		case *events.Receipt:
			if evt.Type == types.ReceiptTypeRead || evt.Type == types.ReceiptTypeReadSelf {
				log.Infof("%v was read by %s at %s", evt.MessageIDs, evt.SourceString(), evt.Timestamp)
			} else if evt.Type == types.ReceiptTypeDelivered {
				log.Infof("%s was delivered to %s at %s", evt.MessageIDs[0], evt.SourceString(), evt.Timestamp)
			}
		case *events.Presence:
			if evt.Unavailable {
				if evt.LastSeen.IsZero() {
					log.Infof("%s is now offline", evt.From)
				} else {
					log.Infof("%s is now offline (last seen: %s)", evt.From, evt.LastSeen)
				}
			} else {
				log.Infof("%s is now online", evt.From)
			}
		case *events.HistorySync:
			id := atomic.AddInt32(&historySyncID, 1)
			fileName := fmt.Sprintf("history-%d-%d.json", startupTime, id)
			file, err := os.OpenFile(fileName, os.O_WRONLY|os.O_CREATE, 0600)
			if err != nil {
				log.Errorf("Failed to open file to write history sync: %v", err)
				return
			}
			enc := json.NewEncoder(file)
			enc.SetIndent("", "  ")
			err = enc.Encode(evt.Data)
			if err != nil {
				log.Errorf("Failed to write history sync: %v", err)
				return
			}
			log.Infof("Wrote history sync to %s", fileName)
			_ = file.Close()
		case *events.AppState:
			log.Debugf("App state event: %+v / %+v", evt.Index, evt.SyncActionValue)
		case *events.KeepAliveTimeout:
			log.Debugf("Keepalive timeout event: %+v", evt)
		case *events.KeepAliveRestored:
			log.Debugf("Keepalive restored")
		case *events.Blocklist:
			log.Infof("Blocklist event: %+v", evt)
		}
	}
}

func capture() func() (string, error) {
	r, w, err := os.Pipe()
	if err != nil {
		panic(err)
	}

	done := make(chan error, 1)

	save := os.Stdout
	os.Stdout = w

	var buf strings.Builder

	go func() {
		_, err := io.Copy(&buf, r)
		r.Close()
		done <- err
	}()

	return func() (string, error) {
		os.Stdout = save
		w.Close()
		err := <-done
		return buf.String(), err
	}
}
