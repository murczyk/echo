we have signal_message entries, we want to be able to reply to them.
when I reply to a signal_message - I create a signal message that has link to an original message, but it's just a nullable foreign key: if original message is deleted - we still persist the reply, we just keep the info in db that it's in fact a response to a message that is currently unavailable. same goes for a reply - we might delete it but we would like to keep a knowledge in the system that it was in fact present at some point.

such requirement points us towards a reply as dedicated table. we have db table message_reply, with attributes original_signal_message_id (nullable foreign key to a signal_message table) , reply_signal_message_id (nullable foreign key to a signal_message table) , created_at (utc timezone non null), deleted (bool not null default false).

from web UI in both rer-duty-neo and rer-analysis-neo you have a reply button among common actions like copy a link to a message, delete a message etc (anybody can reply). when you press it - we open our standard New Message popup, with readonly block 'citedMessage' (we expect to be able to cite multiple messages, when we do so - we create multiple message_reply entries, one per cited message, with new message_id as reply_id). on confirm we send a new message to the same group, so we create a regular signal_message entry (that's bein processed as always) and 1 or more message_reply entries.

now loading messages on rer-analysis-neo and rer-duty-neo is different: once you've loaded new portion of messages - you run async query that loads reply data for these messages. also, we push to Redis (I guess?) updates on messages to refresh visible mssages, make sure the message_reply hits that Redis live updates feed too.
we also have periodical updates we poll on those pages, they should also include latest reply_message entries, so we refresh the web ui correspondingly for relevant messages if some present. make sure we don't fetch this data proactively on each redis tick, but do it only when our planned polling mechanism decides it's time. 

when we pulled in new replies data, it is structured thuis way: it has replies list and reply_messages content.
we pull replies for a set of signal_message IDs.
1) replies is just a straight list of all message_reply entries that have either original_signal_message_id or reply_signal_message_id in the list of signal_message_ids.
2) reply_messages is a list of narrowly queried signal_message-related data: all fields of citedMessage data frame and a link to a signal_message (link to rer-duty-neo if we fetch this for rer-duty-neo screen, link to rer-analysis-neo for rer-analysis-neo screen).

citedMessage dataframe (rendered both in message lists and create message screen) is bare minimum info about the message: signal_message.timestamp and first 2 rows (or first 256 chars) of signal_message.body. please document that if we want to show other info (like sender's login etc) - we need to update this endpoint as well.

once we've fetched replies data - we enrich related visible signal_message entries (below the tags block): 
1) if signal message is a reply to other message - we write 'Оригінальне повідомлення' text in our 'active text' theme (when you press it - we show a pop-up Do You Want To Open Original Message?, if yes - follow the link to a message in new tab), and below it - citedMessage card.
structure of citedMessage card: quote of the message: 1st row is timestamp (small font size, the same active font: date in format dd.mm followed by space + middledot + space, followed by time in format hh:MM), 2nd row is our preview text, in regular font; pressing timestamp also prompts the dialog to open the link to a message in new tab.
2) if signal message has replies - we write (below the  'Оригінальне повідомлення'  from pt.1 if we have it, otherwise insteadof it) Ланцюжок, followed by circular chip with number of replies to this message (inside the chip); below this we show all the replies, each as a separate row,  oldest to newest; format of a row: number of the row (starting from 1) in a circular outline, then to the right - cited message card.
between rows we show thin vertical lines from number 1 to number 2 etc, so they indeed look like a chain. focusing on a message highlight circle with a number so its theme changes to 'selected', it's a visual aid.


for messages that come from signal and whatsapp datasources we also have info what message is a reply to a different message, echo_im should be providing this info (update it in ../echo_im if it doesn't). worker that process datasources should start created message_reply entries for new incoming messages so we show that too.
