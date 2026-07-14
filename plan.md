# Move My Reports To Dedicated Page

## HOWTO

Keep implementation work in `Open Items` as a checkbox list. Check items as they are completed, add new items when new required work appears, and remove the plan file once all items are complete and there are no unresolved questions.
Put any blocking or review-needed questions in `QnA`; add your suggested answers. If a question is answered, fold the answer back into `Open Items` as concrete work or a concrete decision, then remove the answered question. Do not delete the plan file while `QnA` still has unresolved questions. If all QnA items are resolved and there are still some Open Items - start implementing those items; if some questions arise durins the implementation so you're blocked with the solution of a current open item - pause the execution and ask user to answer them.

## Open Items

- [ ] Locate the existing `Мої Звіти` implementation under `Налаштування` and identify the route/component that renders it.
- [ ] Create or expose a dedicated `Мої Звіти` page route outside settings.
- [ ] Add `Мої Звіти` to the top-right login/user dropdown next to `Налаштування`, with `Налаштування` immediately after it.
- [ ] Remove any UI copy or badge that presents `Мої Звіти` as beta functionality.
- [ ] Keep the `Мої Звіти` tab visible at `/settings-neo`, but make selecting it redirect to the new dedicated page.
- [ ] Add a hyperlink/external-link icon at the end of the `Мої Звіти` settings tab label so it is clear the tab opens another page.
- [ ] Update links from `Налаштування -> Мої Звіти` to point to the new dedicated page and display the hyperlink text as `Мої Звіти`.
- [ ] Add a legacy redirect from `/settings-neo?section=my-reports` to the new `Мої Звіти` page route.
- [ ] Adjust the dedicated page layout so the reports table uses space similarly to `/admin/all-reports`, including page width, table height, `Мої Звіти` title, and title counter.
- [ ] Run frontend formatting with `cd wdintel-web && npm run format:staged`.
- [ ] Run the relevant frontend build/check, ideally `just build-front`.

## QnA
