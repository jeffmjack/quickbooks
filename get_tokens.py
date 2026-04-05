"""
Run once to get your QBO refresh token and realm ID.
Usage: python get_tokens.py
"""

import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

import requests
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("QBO_CLIENT_ID")
CLIENT_SECRET = os.getenv("QBO_CLIENT_SECRET")
ENVIRONMENT = os.getenv("QBO_ENVIRONMENT", "sandbox")
REDIRECT_URI = "http://localhost:8080/callback"
SCOPE = "com.intuit.quickbooks.accounting"

AUTH_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"


class CallbackHandler(BaseHTTPRequestHandler):
    result = {}

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return

        params = parse_qs(parsed.query)
        code = params.get("code", [None])[0]
        realm_id = params.get("realmId", [None])[0]

        if not code:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Missing auth code.")
            return

        # Exchange code for tokens
        resp = requests.post(
            TOKEN_URL,
            auth=(CLIENT_ID, CLIENT_SECRET),
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
            },
        )
        resp.raise_for_status()
        tokens = resp.json()

        CallbackHandler.result = {
            "realm_id": realm_id,
            "refresh_token": tokens.get("refresh_token"),
            "access_token": tokens.get("access_token"),
        }

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"<h2>Success! You can close this tab and return to the terminal.</h2>")

        # Shut down the server after responding
        threading.Thread(target=self.server.shutdown).start()

    def log_message(self, format, *args):
        pass  # silence request logs


def main():
    params = {
        "client_id": CLIENT_ID,
        "scope": SCOPE,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "state": "qbo_genie",
    }
    auth_link = f"{AUTH_URL}?{urlencode(params)}"

    print("Starting local OAuth callback server on http://localhost:8080 ...")
    print(f"\nOpening browser for authorization. If it doesn't open, visit:\n\n  {auth_link}\n")

    server = HTTPServer(("localhost", 8080), CallbackHandler)
    webbrowser.open(auth_link)
    server.serve_forever()

    result = CallbackHandler.result
    if not result:
        print("No tokens received. Something went wrong.")
        return

    realm_id = result["realm_id"]
    refresh_token = result["refresh_token"]

    print(f"\nSuccess!\n")
    print(f"  Realm ID:      {realm_id}")
    print(f"  Refresh Token: {refresh_token}")

    # Write back to .env
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    with open(env_path) as f:
        content = f.read()

    content = content.replace("QBO_REALM_ID=", f"QBO_REALM_ID={realm_id}")
    content = content.replace("QBO_REFRESH_TOKEN=", f"QBO_REFRESH_TOKEN={refresh_token}")

    with open(env_path, "w") as f:
        f.write(content)

    print("\n.env updated with Realm ID and Refresh Token.")


if __name__ == "__main__":
    main()
