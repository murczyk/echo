"""Source text available to the script: the user's prompt and the Echo
messages and file sections already retrieved in this request."""

from dataclasses import dataclass

from . import state


@dataclass(frozen=True)
class Message:
    message_id: int
    message_identifier: str
    text: str
    datetime: str = ""
    author: str = ""
    group: str = ""

    def citation(self):
        return {
            "messageId": self.message_id,
            "messageIdentifier": self.message_identifier,
        }


@dataclass(frozen=True)
class FileSection:
    reference: dict
    name: str
    locator: str
    text: str
    datetime: str = ""

    def citation(self):
        return dict(self.reference)


def files():
    """Authorized file sections read in this request, with pinned citations."""
    return [FileSection(item["source"], item["name"], item["locator"], item["text"])
            for item in state.inputs().get("files", [])]


def prompt():
    """The user's message for this request (pasted reports usually live here)."""
    return state.inputs().get("prompt", "")


def messages():
    """Echo messages retrieved by earlier tool calls in this request."""
    return [
        Message(
            message_id=item["messageId"],
            message_identifier=item["messageIdentifier"],
            text=item.get("text", ""),
            datetime=item.get("datetime", ""),
            author=item.get("author", ""),
            group=item.get("group", ""),
        )
        for item in state.inputs().get("messages", [])
    ]


def texts():
    """The prompt followed by every retrieved message and file section, as (text, source) pairs;
    the prompt has no source."""
    return [(prompt(), None)] + [(message.text, message) for message in messages()] + [(section.text, section) for section in files()]
