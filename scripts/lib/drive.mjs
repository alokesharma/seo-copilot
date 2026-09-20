// Write a file into the user's own Google Drive using the existing OAuth token.
// The Workspace blocks public Apps Script web apps, so the Mac cannot call Google
// directly. Instead the Mac DROPS the brief here and an Apps Script timer picks it
// up — no public URL, nothing for an admin policy to block.
import { readFileSync } from "node:fs";

const H = process.env.HOME;
const CFG = H + "/.config/seo-copilot";

async function accessToken() {
  const t = JSON.parse(readFileSync(`${CFG}/token.json`, "utf8"));
  const c = JSON.parse(readFileSync(`${CFG}/credentials.json`, "utf8"));
  const cred = c.installed || c.web;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: cred.client_id, client_secret: cred.client_secret,
      refresh_token: t.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google token refresh failed: " + JSON.stringify(j).slice(0, 160));
  return j.access_token;
}

/** Create or overwrite a file by name, returning its id. */
export async function putFile(name, content, mimeType = "text/html") {
  const tok = await accessToken();
  const auth = { authorization: "Bearer " + tok };

  // drive.file scope only sees files this app created — which is exactly what we want
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const found = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, { headers: auth })).json();
  const id = found.files?.[0]?.id;

  if (id) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: "PATCH", headers: { ...auth, "content-type": mimeType }, body: content });
    if (!r.ok) throw new Error("Drive update failed: " + (await r.text()).slice(0, 160));
    return id;
  }

  const boundary = "part" + Date.now();
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + JSON.stringify({ name, mimeType }) + `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    + content + `\r\n--${boundary}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST", headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` }, body });
  const j = await r.json();
  if (!j.id) throw new Error("Drive create failed: " + JSON.stringify(j).slice(0, 160));
  return j.id;
}
