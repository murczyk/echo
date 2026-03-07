console.log("Your custom plugin function imported");
// eslint-disable-next-line import/no-anonymous-default-export
export default function (text, extra) {
  console.log("Your custom plugin function called");
  console.log("Here's a message text");
  console.log(text);
  console.log("Here's a message object with some parsed data");
  console.log(extra.message);
  console.log("Here's your task configuration");
  console.log(extra.task);

  if (text.toLowerCase().includes("test")) {
    console.log("Passed conditions the message would be forwarded");

    return true;
  }
  console.log("Did not pass conditions the message won't be forwarded");
  return false;
}
