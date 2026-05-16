"""Pull a few recent Ramp emails from billing@ to understand their structure.

Looking for:
  - From / Subject patterns we already know about ("payment initiated", "payment delivered")
  - Body structure: is it parseable HTML/plain, or do we need attachment extraction?
  - Customer identifier (display name, ID?)
  - Invoice number(s) referenced
  - Amount, date, transaction id
"""

import base64
import json
import re
import sys
import urllib.parse
import urllib.request


def access_token() -> str:
    tok = json.load(open("google_token.json"))
    body = urllib.parse.urlencode({
        "client_id": tok["client_id"],
        "client_secret": tok["client_secret"],
        "refresh_token": tok["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["access_token"]


def gmail_get(at: str, path: str) -> dict:
    req = urllib.request.Request(
        f"https://gmail.googleapis.com/gmail/v1/users/me{path}",
        headers={"Authorization": f"Bearer {at}"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def get_body_text(payload: dict) -> str:
    """Extract plain-text body from a Gmail message payload, recursing parts."""
    parts = payload.get("parts") or []
    if not parts:
        body = payload.get("body", {})
        data = body.get("data")
        if data:
            return base64.urlsafe_b64decode(data + "===").decode("utf-8", errors="replace")
        return ""
    out = []
    for p in parts:
        mt = p.get("mimeType", "")
        if mt == "text/plain":
            data = p.get("body", {}).get("data")
            if data:
                out.append(base64.urlsafe_b64decode(data + "===").decode("utf-8", errors="replace"))
        elif p.get("parts"):
            out.append(get_body_text(p))
    return "\n\n".join(out)


def get_header(headers, name):
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def main() -> int:
    at = access_token()

    # Search both 'payment initiated' and 'payment delivered' Ramp subjects.
    queries = [
        'from:communications@ramp.com newer_than:30d',
    ]

    for q in queries:
        print(f"\n========================================")
        print(f"QUERY: {q}")
        print(f"========================================")
        encoded = urllib.parse.quote(q)
        results = gmail_get(at, f"/messages?q={encoded}&maxResults=3")
        ids = [m["id"] for m in (results.get("messages") or [])]
        if not ids:
            print("(no matches)")
            continue
        for mid in ids:
            msg = gmail_get(at, f"/messages/{mid}?format=full")
            headers = msg["payload"]["headers"]
            subject = get_header(headers, "Subject")
            sender = get_header(headers, "From")
            date = get_header(headers, "Date")
            print(f"\n--- {mid} ---")
            print(f"From:    {sender}")
            print(f"Subject: {subject}")
            print(f"Date:    {date}")
            body = get_body_text(msg["payload"])
            # Trim noise — collapse blank lines.
            body = re.sub(r"\n{3,}", "\n\n", body).strip()
            # Show first 1500 chars
            print("\n[body — first 1500 chars]")
            print(body[:1500])
            if len(body) > 1500:
                print(f"\n... ({len(body) - 1500} more chars)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
