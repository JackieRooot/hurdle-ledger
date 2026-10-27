# hurdle-ledger — shared account ledger

[中文](README.md) | English

A fully static website, hosted on GitHub Pages, that tracks the returns and performance fees of an investment account shared by one manager and any number of friends (investors). It uses unit (NAV) accounting, a hurdle rate, a high-water mark, and a performance fee. The defaults are a 6% hurdle and a 25% fee, and each investor can have their own rates. New friends can join at any time.

> The web pages themselves are in Chinese. This document explains them in English; Chinese button labels are quoted where it helps (for example **新增** = "Add").

**The repository is public, but it contains no plaintext data.** All records and screenshots are encrypted in the browser before upload (PBKDF2-SHA256 with 600,000 iterations + AES-GCM-256). The password is never stored in the repository, decrypted data lives only in browser memory, and a forgotten password means the data cannot be recovered.

| File | Purpose |
|---|---|
| `index.html` | Viewer: enter password → decrypt → display |
| `editor.html` | Editor: enter data, upload screenshots → publish to the repo automatically (or export manually) |
| `calc.js` | All calculation logic (formulas are documented in the comment at the top of the file) |
| `crypto.js` | Encryption / decryption |
| `github.js` | Commits directly from the editor to the repo (auto-publish) |
| `view.js`, `style.css`, `zip.js` | Rendering, styles, manual-export zip |
| `ocr.js`, `vendor/` | Reads the total assets from a screenshot (local copy of Tesseract.js, loaded only when you pick a screenshot in the editor) |
| `data.enc` | All text records, encrypted (created by the editor the first time) |
| `shots/` | Encrypted screenshots, one file each |
| `tests/` | Node unit tests (fictional test data only) |

## Enable GitHub Pages

1. Open the repository → **Settings** → **Pages** in the sidebar.
2. Under **Build and deployment**, set Source to **Deploy from a branch**.
3. Choose branch **main**, folder **/ (root)**, and click **Save**.
4. After 1–2 minutes the URL appears at the top of the page, usually `https://<username>.github.io/hurdle-ledger/`.
   - Viewer: `…/hurdle-ledger/` (send this to your friends)
   - Editor: `…/hurdle-ledger/editor.html` (for you)

## How friends view it

Friends don't need to install anything: they open the viewer URL in a phone or desktop browser and enter the password. While the page is open it checks for new data every 3 minutes (and whenever the tab becomes visible again) and refreshes automatically; they can also click **刷新** (Refresh) in the top-right corner.

## Create a GitHub token (for auto-publish, one time only)

1. Sign in to GitHub → avatar (top right) → **Settings** → **Developer settings** (bottom of the sidebar) → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Give it any name, e.g. `hurdle-ledger`, and pick an expiration (e.g. 1 year; generate a new one when it expires).
3. Under **Repository access**, choose **Only select repositories** and select only `hurdle-ledger`.
4. Under **Permissions**, click **Add permissions** (or expand **Repository permissions**), type **contents** in the search box (searching "repo" finds nothing), tick **Contents**, and change its access from **Read-only** to **Read and write**. Metadata (read-only) is added automatically; leave everything else at the default.
   If Contents doesn't appear in the list, go back to step 3 and make sure **Only select repositories** is chosen and `hurdle-ledger` is selected.
5. Click **Generate token**, copy the string starting with `github_pat_`, and keep it somewhere safe (a password manager or a private note). **Don't send it to friends and don't commit it to the repository.**

This token can only read and write files in this one repository. The editor keeps it only in page memory: it is not offered to the browser's password manager and not written to browser storage. It is cleared when you close or lock the page, so you paste it again next time. If it ever leaks, click **Revoke** on the same GitHub page and generate a new one.

## First-time setup

1. Open the editor. Under **新建数据集** (New dataset), enter the manager's name, the first investor's name, the funding date, your initial investment A and that investor's initial investment B (both must be greater than 0), and set a password (12+ characters recommended; avoid birthdays or anything easy to guess).
2. Under **自动发布到 GitHub** (Auto-publish to GitHub), paste the token and click **连接** (Connect). The page commits the encrypted `data.enc` to the repository automatically.
3. If other friends also put money in on the opening day, add them under **出资人** (Investors) and fill in **开户时投入** (Amount invested at inception).
4. Send the viewer URL and the password to your friends, ideally through different channels. All investors share the same URL and password and can see each other's data, so nicknames are recommended.

## When a new friend joins (mid-way)

1. Open the editor, load the data, and connect to GitHub.
2. Under **出资人** (Investors), click **添加** (Add): enter a name (a nickname is fine) and set **开户时投入** (Amount invested at inception) to **0**. Leave the hurdle rate and fee rate blank to use the defaults (6% and 25%), or enter custom rates for this person.
3. Under **资金流动** (Cash flows), record their first deposit: choose them under **谁** (Who), type **注资** (Deposit), and enter the account's total value just before the money arrived. They buy units at that day's NAV; everyone else's units and value are unaffected.
4. In the year they join, their hurdle is pro-rated by the **number of days the money was in the account** (e.g. money deposited on October 1 earns only about a quarter of a year's hurdle by year-end). From the following year on, they are treated like everyone else.
5. Once saved it publishes automatically. Send them the viewer URL and password.

Each investor's hurdle, high-water mark and fee are calculated **independently**. Changing someone's rates recalculates every year. An investor who has cash-flow records cannot be deleted; delete their cash flows first.

An older `data.enc` (from the single-friend version) is converted automatically when loaded: the original friend becomes the first investor, existing records stay the same, and so do the results. It is saved in the new format the next time you publish.

## Three ways to open the editor

| Button | When to use |
|---|---|
| **从本站加载 data.enc** (Load data.enc from this site) | Day-to-day updates: the repository already has data and you continue from it. Use this almost every time |
| **选择本地文件…** (Choose local file…) | You have a `data.enc` that hasn't been uploaded yet (e.g. a manual export you never uploaded, or your own backup). After loading, connect to GitHub and publish |
| **新建数据集** (New dataset) | First use, when the repository has no data yet |

## Quarterly update (once after each quarter ends)

1. Open the editor → enter the password → **从本站加载 data.enc** → paste the token under **自动发布到 GitHub** and click **连接**.
2. Under **季度快照** (Quarterly snapshot), fill in:
   - **日期** (Date): the day the account value was recorded, usually the last day of the quarter. **Every year must have a December 31 snapshot**, otherwise that year's fees cannot be settled.
   - **期间** (Period): filled in automatically from the date (e.g. `2026Q3`); usually no need to change it.
   - **账户总值** (Account value): total account assets after that day's close, already including all of that day's deposits and withdrawals.
   - **截图** (Screenshot): choose the asset screenshot from your brokerage app. It is compressed and encrypted automatically.
     Once you pick it, the editor **reads the total assets from the screenshot and fills in the account value** (a few seconds; the first time it downloads about 12 MB of recognition files). Recognition runs entirely in the browser, and the screenshot is never sent to any server. The result is checked against "stocks + wealth products + cash = total assets" and shown below the form:
     - ✓ means it matches the itemized amounts; on ⚠, compare the amount with the screenshot.
     - If the screenshot was taken during the broker's clearing time, it warns that the figures may be inaccurate; it's better to take the screenshot after clearing.
     - If the app hid the amounts (\*\*\*\*) or no total is found, nothing is filled in; enter it by hand.
     - If you edit the account value while recognition is running, your value is kept; click **改用识别值** (Use recognized value) to switch.
     - You can also fill in the account value first and pick the screenshot afterwards: the recognized value replaces it, and the old value is shown.
3. Click **新增** (Add). The **计算结果预览** (Results preview) below updates immediately; check that the NAV, each person's value, the hurdle lines and the estimated fees look right. A December 31 snapshot triggers the year-end settlement automatically: each investor is settled separately, and the units corresponding to their fee are moved from them to the manager.
4. About 2 seconds after saving, the data is encrypted and committed to the repository (the status at the top shows "已发布" / Published), together with the screenshot. The viewer updates after roughly 1–2 minutes.

You can record several snapshots in the same quarter (as long as the dates differ; only one per day). Each is shown and calculated separately; "相对上期收益率" (Return vs. previous period) compares with the immediately preceding record.

## Recording deposits / withdrawals (every time one happens)

1. **Before the money moves in or out of the account**, note the account's total value at that moment ("当时账户总值"). If the market has already closed that day, use the post-close value.
2. Open the editor, load the data and connect to GitHub. Under **资金流动** (Cash flows), fill in the date, who, deposit or withdrawal, the amount, and the account value at that time.
3. Below the form you immediately see the NAV at that moment and the corresponding number of units; for a withdrawal it also shows that person's value at the time.
4. The page validates automatically: nobody can withdraw more than their value at the time, and an investor must also leave enough to cover their own estimated fee. Records that fail validation cannot be saved.
5. If there are several cash flows on the same day, enter them one by one in the order they actually happened, each with **its own** account value immediately before it.
6. It publishes automatically after saving.

## Editing, back-filling and viewing records

- Every record in the lists has **编辑** (Edit) and **删除** (Delete). You can back-fill old records or change dates; after saving they are placed in the right order by date and all later results are recalculated.
- Tables are sorted by date by default, newest first. Click any column header to sort by that column; click again to reverse (▼ / ▲ shows the current order). The viewer's "季度明细" (Quarterly details) and "资金流动明细" (Cash-flow details) tables sort the same way.
- When editing a snapshot, choosing a new screenshot replaces the old one.

## Publishing

- With GitHub connected and "修改后自动发布" (Auto-publish after changes) ticked, every save publishes automatically; you normally don't need to do anything.
- The **立即发布** (Publish now) button at the top is always available: with changes it publishes right away; without changes it just says the repository is already up to date; if not connected yet it opens the connection settings. After a failed publish, click it to retry.
- Every publish leaves a commit named "Update encrypted ledger data" in the repository; `data.enc` and any new screenshots go in the same commit.

### Publish conflicts

If the repository's `data.enc` was updated after you loaded the data (for example you published from another device, or you reopened the editor within 1–2 minutes of publishing and loaded the old version), the publish is rejected rather than overwriting anything. In that case click **从仓库重新加载最新数据** (Reload latest data from repository) under **自动发布到 GitHub**, then re-enter your recent changes.

## Without a token: manual export and upload

The editor works without connecting to GitHub too: click **手动导出** (Manual export). Without new screenshots it downloads `data.enc`; with new screenshots it downloads a zip (containing `data.enc` and `shots/xxxx.enc`). Screenshots are only kept in page memory until exported and won't appear in the next export after that, so make sure the zip is saved.

### How to upload (GitHub website)

1. Open the repository home page → **Add file** → **Upload files**.
2. Drag in `data.enc`. If there are screenshots, unzip the archive and drag in the whole `shots` folder (GitHub keeps the folder structure and overwrites files with the same name).
3. Click **Commit changes**. Refresh the viewer after 1–2 minutes to see the update.

This also works on a phone: open the repository on github.com in a browser (choose "Desktop site") and use Upload files the same way.

## Changing the password

1. Editor → **修改密码** (Change password); enter the current password and the new one.
2. The page downloads every screenshot, decrypts it with the old password and re-encrypts it with the new one. If a screenshot can't be downloaded, you can supply the matching `.enc` file from your computer.
3. Click **确认使用新密码** (Confirm new password). If GitHub is connected, `data.enc` and all screenshots are republished automatically; otherwise click **手动导出** and upload the zip's `data.enc` and the whole `shots` folder, overwriting the old files.
4. Tell your friends the new password. Any viewer page they have open will prompt them to enter it.

## Password fields

- The ledger password field is a standard password field, so the browser can remember and autofill it (the username shown when saving is `hurdle-ledger`).
- The **显示** (Show) button to the right of the field switches it to a plain text box so input methods (including IME phrases) work normally; it switches back to dots on submit.
- The GitHub token field is never saved by the browser's password manager, so it can't overwrite the ledger password.

## What the numbers on the page mean

- Each investor has their own card and set of figures. The fee income on the manager's card is the total across all investors.
- **年末门槛线（不提成线）** (Year-end hurdle line / no-fee line): the year-end hurdle given the cash flows so far. If an investor's value at year-end does not exceed it, there is no fee.
- **当前门槛线** (Current hurdle line): the hurdle pro-rated to the days elapsed so far, used to estimate the "预估分成" (estimated fee). In the opening year, the hurdle on the amount invested at inception is always the full-year rate, not pro-rated; later deposits and withdrawals (including the first deposit of a friend who joins mid-way) are weighted by days in the account; from the second year on, the opening high-water mark is pro-rated by days elapsed during the year.
- **预估分成** (Estimated fee): the fee that would be charged if the year were settled today. It is for reference only; units are transferred only at a December 31 snapshot.
- The full rules are in "计算规则（通俗说明）" (Calculation rules, plain-language) at the bottom of the viewer, and the formulas are in the comment at the top of `calc.js`.

## Data and backups

- `data.enc` is the only place data is stored (initial amounts, the investor list, all snapshots and cash flows). It must keep this name, stay in the repository root, and never be deleted. Screenshots are not in `data.enc`; they are separate files in `shots/`.
- Every publish keeps the previous version in the repository history. If something is deleted or broken by mistake: on GitHub click `data.enc` → **History** → find the old version → download it, then load it in the editor with **选择本地文件…** and publish again.
- It's a good idea to click **手动导出** now and then and keep a copy of `data.enc` on your computer or cloud drive. It is encrypted, so it is safe anywhere, but you must remember the password to open it.

## FAQ

- **The page still looks old**: GitHub Pages lets browsers cache pages for about 10 minutes. Force-refresh with **Ctrl+F5** (Mac: **Cmd+Shift+R**).
- **"本站还没有 data.enc" (No data.enc on this site yet)**: there is no `data.enc` in the repository root yet, or it was just uploaded and hasn't been deployed (wait 1–2 minutes).
- **A screenshot won't open**: the screenshot file was never uploaded to `shots/`, or it was encrypted with an old password. Edit that snapshot in the editor, choose the screenshot again, and publish.

## Running the tests

Requires Node.js 22 or later; no dependencies to install:

```bash
node --test tests/*.test.mjs
```

After changing any `.js` file or `style.css`, change the version string (`?v=…`) at the top of both `index.html` and `editor.html` (the two must match) so browsers download all files again instead of mixing old and new ones. The tests check that both pages use the same version.

## Notes

- Never commit plaintext data, plaintext screenshots, passwords or tokens to the repository, including in issues and commit messages.
- `robots.txt` blocks all crawlers and every page carries `noindex`. But the URL itself is public, so security depends entirely on the strength of the password.
- If the editor has changes that haven't been published or exported, closing the page shows a warning.
- If you let the browser remember the ledger password, anyone who can use your device can open the ledger directly, so make sure the device has a screen lock.
