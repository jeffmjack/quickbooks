"""Inspect labels + filters on billing@thegreencart.com.

Uses google_token.json (the same refresh token the edge functions use for billing@).
Read-only: lists labels, then prints all Gmail filters (criteria + actions).
"""

import json
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


def main() -> int:
    at = access_token()

    profile = gmail_get(at, "/profile")
    print(f"=== Inbox: {profile.get('emailAddress')} ===\n")

    labels = gmail_get(at, "/labels").get("labels", [])
    user_labels = [l for l in labels if l.get("type") == "user"]
    print(f"=== User labels ({len(user_labels)}) ===")
    for l in sorted(user_labels, key=lambda x: x["name"].lower()):
        print(f"  {l['name']!r:<40}  id={l['id']}")

    print()
    filters = gmail_get(at, "/settings/filters").get("filter", [])
    print(f"=== Filters ({len(filters)}) ===")
    label_by_id = {l["id"]: l["name"] for l in labels}
    for f in filters:
        crit = f.get("criteria", {})
        act = f.get("action", {})
        crit_str = ", ".join(f"{k}={v}" for k, v in crit.items())
        actions = []
        for lid in act.get("addLabelIds", []):
            actions.append(f"+{label_by_id.get(lid, lid)}")
        for lid in act.get("removeLabelIds", []):
            actions.append(f"-{label_by_id.get(lid, lid)}")
        if act.get("forward"):
            actions.append(f"forward→{act['forward']}")
        print(f"  if [{crit_str}] then {', '.join(actions) or '(no actions)'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
