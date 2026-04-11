"""
Run once to authorize Google access for billing@thegreencart.com.
Saves a token to google_token.json for future use.
Usage: python get_google_token.py
"""

import os
import json
from dotenv import load_dotenv
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
]

# Build a client config dict from .env instead of requiring a JSON file
client_config = {
    "installed": {
        "client_id": os.getenv("GOOGLE_CLIENT_ID"),
        "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": ["http://localhost:8080"],
    }
}

flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
creds = flow.run_local_server(port=8080, prompt="consent")

# Save token
token_data = {
    "token": creds.token,
    "refresh_token": creds.refresh_token,
    "token_uri": creds.token_uri,
    "client_id": creds.client_id,
    "client_secret": creds.client_secret,
    "scopes": creds.scopes,
}
with open("google_token.json", "w") as f:
    json.dump(token_data, f, indent=2, default=list)

print(f"\nAuthorized successfully.")
print(f"Token saved to google_token.json")
print(f"Refresh token: {creds.refresh_token[:30]}...")
