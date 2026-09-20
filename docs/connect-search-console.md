# Connecting Google Search Console

This tool reads your Search Console data using **your own** Google credentials. You
create an OAuth client in Google Cloud, paste two values into the Setup tab, and
approve the connection once.

It works this way for three reasons: your data never passes through anyone else's
infrastructure, there is no cap on how many people can use the tool, and you never see
the "Google hasn't verified this app" warning that a shared client would produce.

Ten minutes, once.

---

## 1. Create a Google Cloud project

<https://console.cloud.google.com/projectcreate>

Any name. It is only a container. Skip this if you already have one.

## 2. Enable the Search Console API

<https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>

Select the project from step 1, then press **Enable**. Miss this and the connection
fails later with "API not enabled".

## 3. Configure the consent screen

<https://console.cloud.google.com/apis/credentials/consent>

Choose **External**. Fill in an app name and your email address, then save.

On the **Test users** step, add your own Google address — the one that owns the
Search Console property. Skipping this is the single most common cause of
"access blocked" at the final step.

## 4. Create an OAuth client

<https://console.cloud.google.com/apis/credentials>

**Create credentials → OAuth client ID → Desktop app**.

Desktop matters. A "Web application" client rejects the loopback redirect this tool
uses, and you get `redirect_uri_mismatch`.

Copy the **client ID** and **client secret**.

## 5. Connect

Paste both into the Setup tab and press **Connect**. A Google tab opens, you approve,
and the tab tells you it worked. Setup then lists every property that account can read,
which is how you confirm you authorised the right Google account.

---

## When it goes wrong

**"Google hasn't verified this app"**
Expected. It is your own app, used only by you. Click **Advanced**, then
**Go to … (unsafe)**.

**"Access blocked: app has not completed verification"**
Your address is not on the test-user list. Go back to step 3, add it, try again.

**`redirect_uri_mismatch`**
The client was created as a Web application. Delete it and make a Desktop app client.

**Connected, but your site is not listed**
You approved a different Google account from the one that owns the property. Revoke
the app at <https://myaccount.google.com/permissions> and connect again.

**"API not enabled"**
Step 2 was skipped, or the API was enabled on a different project from the one your
client belongs to.
