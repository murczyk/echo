1. we have AORs A and B. signal group X is added to AOR A, signal group Y if added to AOR B. we filter messages by AOR A. make sure we don't see messages from group Y.
2. we have AORs A and B. signal group X is added to AOR A, signal group Y if added to AORs A and B. we filter messages by AOR A. make sure we see messages from both groups.
3. we have AORs A and B. signal group X is added to AOR A, signal group Y is added to AOR B. 
sigint network K is added to AOR A, sigint network L is added to AOR B. 
we filter messages by AOR A. we have 3 messages in each group: one without network, one with network A, one with network B.
make sure that when we filter by AOR A - we see both groups in dropdown.
4. we have AORs A and B. signal group X is added to AOR A, signal group Y is added to AOR B.
sigint network K is added to AOR A, sigint network L is added to AOR B.
we filter messages by AOR A. in group X we have 3 messages: one without network, one with network A, one with network B.
in group Y we have only one message, from network K.
make sure that when we filter by AOR A - we see both groups in group dropdown, and only network K in networks dropdown.
5. we have AORs A and B. signal group X is added to AOR A, signal group Y is added to AOR B.
we have one message without network, but this message is attached to both groups X and Y.
we filter messages by AOR A.
make sure this message is visible, and both groups X and Y are shown in group dropdown.
6. same setup as in case 5.
after filtering by AOR A, we additionally select group X.
make sure the shared message is still visible, and group Y is still present in group dropdown because the remaining message belongs to both X and Y.
7. we have AORs A and B, and also wide AOR C that covers both A and B.
signal group X is added to AOR A. sigint network K is added to AOR C.
we have one message in group X from network K.
we filter messages by AOR B.
make sure the message is visible, group X is shown in group dropdown, and network K is shown in networks dropdown.
8. we have AORs A and B. signal group Y is added to AOR B. sigint network K is added to AOR A.
we have one message in group Y from network K, and there are no other messages from groups in AOR A.
we filter messages by AOR A.
make sure the message is visible and group Y is shown in group dropdown.
also make sure this exact behavior for networks dropdown is defined explicitly: either network K must be shown there too, or it must stay hidden. this case is important because group dropdown and networks dropdown are built differently.
9. we have AORs A and B. signal group X is added to AOR A, signal group Y is added to AOR B.
we have one secret group S available to the user, and S has no messages. we also have one secret group H that is not available to the user.
without any AOR filter, make sure S is shown in group dropdown with zero count, and H is not shown.
after selecting any AOR filter, make sure S is no longer injected automatically with zero count.
10. we have AOR A, signal group X in AOR A, and sigint network K in AOR A.
group X has one message without network and one message from network K.
we filter by AOR A and `without network`.
make sure only the no-network message remains, networks dropdown is empty, and frequencies dropdown does not show the frequency from the message that had network K.
11. we have AOR A, signal group X in AOR A, and sigint network K in AOR A.
we set both filters at once: `without network = true` and `selected network = K`.
make sure results are empty and all dependent filter values are empty too, because these filters are mutually exclusive.
12. we have AOR A, signal group X in AOR A, and two sigint networks K and L with the same frequency.
network K was active before the message time and stopped before the message was sent. network L was active at the moment the message was sent.
we have one message in group X on that frequency.
make sure only L is matched and shown in networks dropdown.
13. we have AOR A for group X and AOR B for network K.
we have one message in group X from network K.
we filter by group X or by the message frequency so that only this message remains.
make sure AOR dropdown shows both A and B, because the remaining message is linked to both the group AOR and the network AOR.
14. we have AOR A, signal group X in AOR A, and one message that has no normal location but has peleng coordinates.
we filter by `with coords`.
make sure the message is included.
if `include peleng locations` is enabled, make sure location filter values are built only from surviving messages and do not include unrelated locations.
15. explicit rule from user feedback: when filtering by AOR, we must take into account AORs not only from the signal group, but also from the radio network itself.
minimal case:
signal group X is in AOR B only.
sigint network K is in AOR A only.
we have one message in group X from network K.
we filter by AOR A.
make sure the message is visible even though the group itself does not belong to AOR A.
16. same explicit rule, but for rendered filter values:
signal group X is in AOR B only.
sigint network K is in AOR A only.
we have one message in group X from network K.
we filter by AOR A.
make sure group X is shown in group dropdown because the remaining message matched by radio-network AOR.
17. bookmarked checkbox:
we have two messages in the same visible group. only one of them is bookmarked by the current user.
when `bookmarked` checkbox is enabled, make sure only the bookmarked message remains and dependent filter values are recalculated only from it.
18. important checkbox:
we have two messages in the same visible group. only one of them is marked as important.
when `important` checkbox is enabled, make sure only that message remains.
19. extended form checkbox:
we have two messages in the same visible group. only one of them has a non-empty comment / extended form.
when `with extended form` checkbox is enabled, make sure only that message remains.
20. metadata checkboxes:
we have one message with metadata and one message without metadata.
when `only with metadata` is enabled, make sure only the first message remains.
when `without metadata` is enabled, make sure only the second message remains.
when both checkboxes are enabled at once, make sure results are empty.
21. units exact match checkbox:
we have one message whose header unit is X, but its network is linked in etalon to unit Y.
when filtering by unit Y without `exact units only`, make sure the message remains because etalon match is enough.
when the same filter is used with `exact units only`, make sure only etalon-linked messages remain and header-only matches are ignored.
22. model tags checkbox:
we have one message tagged only by model and another message tagged manually by user with the same tag.
when filtering by this tag and enabling `without model tags`, make sure only the manually tagged message remains.
23. tags only this unit checkbox:
we have two users from different organisms who tagged messages with the same tag.
when `tags only this unit` checkbox is enabled for the current user, make sure only messages tagged by users from the same organism are taken into account.
24. tag-like filters must affect callsigns dropdown too:
we have one bookmarked message with callsign C1 and one non-bookmarked message with callsign C2.
when `bookmarked` checkbox is enabled, make sure only C1 remains in callsigns dropdown.
same kind of check should hold for `important`, `with coords`, selected tags, and other tag-like filters that narrow the surviving message set.
25. tag-like filters must affect tags dropdown too:
we have two tagged messages, but only one of them is bookmarked.
when `bookmarked` checkbox is enabled, make sure tags dropdown is built only from the bookmarked message.
also make sure callsign filter affects tags dropdown, because all filters should affect each other.
26. tag filter option `all tags`:
we have one message with tags A and B, one message with only A, and one message with only B.
when tags A and B are selected with `all tags`, make sure only the message that has both tags remains.
27. mixed checkbox semantics in tag block:
we have one bookmarked message without comment and one commented message without bookmark.
when `bookmarked` and `with extended form` are enabled together, make sure the exact intended behavior is documented and tested.
currently backend applies `with extended form` as an extra mandatory filter, so only messages that satisfy both conditions should remain.
28. sender filter:
we have messages from different senders in the same visible group.
when sender S is selected, make sure only messages from S remain and dependent filter values are recalculated only from them.
29. callsign filter:
we have messages with different callsigns.
when callsign C is selected, make sure only messages containing C remain and dependent filter values do not include values from other callsigns.
30. post filter with empty value:
we have one message with post P and one message without post.
when empty post is selected in filter, make sure only message without post remains.
31. metadata exact text filters:
we have metadata values in color code / sender id / sender name / receiver id / receiver name / hash.
make sure concrete metadata filters match these fields exactly, and dependent filter values are calculated only from surviving messages.
32. undefined unit value:
we have one message with no unit in header and no matching etalon unit, and another message with a known unit.
when `Не визначено` is selected in unit filter, make sure only the first message remains.
33. direct location filter:
we have messages with different explicit locations in the same visible scope.
when location L is selected, make sure only messages with location L remain and dependent filter values do not include values from other locations.
34. `include peleng locations` checkbox must change location filtering semantics:
we have one message that has no explicit location but has peleng-derived location P through frequency mapping.
when location P is selected with `include peleng locations = false`, make sure the message is not matched.
when the same location is selected with `include peleng locations = true`, make sure the message is matched.
35. `without metadata` must dominate concrete metadata filters:
we have one message without metadata and one message with metadata sender S.
when `without metadata` is enabled together with a concrete metadata filter like sender S, make sure we still see only non-metadata messages.
concrete metadata fields must not narrow the result further in this mode.
36. sender + group filters must match the same message-group row:
we have one message attached to groups X and Y.
in group X the sender is A, in group Y the sender is B.
when group X and sender B are selected together, make sure the message is not matched.
also make sure group dropdown under sender A does not leak group Y, and sender dropdown under group X does not leak sender B.
37. selected network filter must use explicit inbox-network links, not only matching frequency:
we have two networks K and L active on the same frequency in the same visible scope.
we have one message on that frequency, explicitly linked only to network K.
when network K is selected, make sure the message is visible.
when network L is selected, make sure the message is not visible.
38. deleted networks must be ignored by network filters:
we have one message linked only to network K, and K is deleted.
make sure network K is absent from network filter values.
when `without network` is enabled, make sure this message behaves like a message without network.
when deleted network K is selected directly in request params, make sure the result is empty.
39. deleted messages must not contribute to filter values:
we have one normal message and one deleted message in the same visible group.
make sure counts and dependent filter values are calculated only from the non-deleted message.
40. metadata filter values must use metadata ids, not display names:
we have metadata with sender id SID and sender name SNAME, and receiver id RID with receiver name RNAME.
make sure metadata sender values contain SID but not SNAME, and metadata receiver values contain RID but not RNAME.
