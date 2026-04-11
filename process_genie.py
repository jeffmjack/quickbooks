"""
Genie folder processor — Phase 2 bill entry pipeline.

Usage:
  python process_genie.py            # scan Genie folder, extract new files, print review summary
  python process_genie.py --post ID  # post a staged (pending) bill to QBO by DB id
"""

import os
import io
import json
import base64
import subprocess
import tempfile
import time
import argparse
import requests
from difflib import SequenceMatcher
from datetime import datetime
from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import anthropic
from supabase import create_client

load_dotenv()

# ── Clients ───────────────────────────────────────────────────────────────────

def get_drive():
    with open("google_token.json") as f:
        t = json.load(f)
    creds = Credentials(
        token=t["token"], refresh_token=t["refresh_token"],
        token_uri=t["token_uri"], client_id=t["client_id"],
        client_secret=t["client_secret"], scopes=t["scopes"]
    )
    return build("drive", "v3", credentials=creds)

def get_qbo_token():
    resp = requests.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        auth=(os.getenv("QBO_CLIENT_ID"), os.getenv("QBO_CLIENT_SECRET")),
        data={"grant_type": "refresh_token", "refresh_token": os.getenv("QBO_REFRESH_TOKEN")},
    )
    resp.raise_for_status()
    data = resp.json()
    # Persist rotated refresh token back to .env
    new_refresh = data.get("refresh_token")
    if new_refresh and new_refresh != os.getenv("QBO_REFRESH_TOKEN"):
        import re
        env_path = os.path.join(os.path.dirname(__file__), ".env")
        with open(env_path) as f:
            content = f.read()
        content = re.sub(r"^QBO_REFRESH_TOKEN=.*$", f"QBO_REFRESH_TOKEN={new_refresh}", content, flags=re.MULTILINE)
        with open(env_path, "w") as f:
            f.write(content)
        os.environ["QBO_REFRESH_TOKEN"] = new_refresh
    return data["access_token"]

def get_supabase():
    return create_client(os.getenv("SUPABASE_PROJECT_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))

ai = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
REALM_ID = os.getenv("QBO_REALM_ID")
GENIE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_GENIE_FOLDER_ID")

# ── Drive helpers ─────────────────────────────────────────────────────────────

def list_genie_files(drive):
    resp = drive.files().list(
        q=f"'{GENIE_FOLDER_ID}' in parents and trashed=false and (mimeType='application/pdf' or mimeType contains 'image/')",
        fields="files(id,name,mimeType,modifiedTime)",
        orderBy="modifiedTime asc",
    ).execute()
    return resp.get("files", [])

def download_file(drive, file_id):
    request = drive.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()

def pdf_to_images(pdf_bytes, max_pages=4):
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        pdf_path = f.name
    images = []
    with tempfile.TemporaryDirectory() as tmpdir:
        out_prefix = os.path.join(tmpdir, "page")
        subprocess.run(
            ["pdftoppm", "-r", "200", "-jpeg", "-f", "1", "-l", str(max_pages), pdf_path, out_prefix],
            capture_output=True
        )
        for fname in sorted(os.listdir(tmpdir)):
            if fname.endswith(".jpg"):
                with open(os.path.join(tmpdir, fname), "rb") as img:
                    images.append(base64.standard_b64encode(img.read()).decode())
    os.unlink(pdf_path)
    return images

def image_bytes_to_b64(raw_bytes):
    return [base64.standard_b64encode(raw_bytes).decode()]

# ── Claude extraction ─────────────────────────────────────────────────────────

EXTRACTION_PROMPT = """This scan may contain one or more separate vendor invoices/bills on different pages.

Return a JSON array — one object per distinct invoice. If pages belong to the same invoice (e.g. page 2 continues page 1's line items), combine them into one object. If a new vendor header/invoice number appears, start a new object.

Each object must have exactly this structure:
{
  "vendor_name": "exact vendor name from invoice",
  "invoice_number": "invoice or order number",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD or null",
  "total_amount": 0.00,
  "line_items": [
    {
      "line_number": 1,
      "description": "exact product description from invoice",
      "sku": "product code/SKU or null",
      "quantity": 0.0,
      "unit": "unit of measure or null",
      "unit_price": 0.00,
      "extended_price": 0.00
    }
  ],
  "confidence": 0.0-1.0
}

Return only valid JSON (an array), no other text."""

def extract_invoice(images):
    """Returns a list of extracted invoice dicts (one per distinct invoice in the scan)."""
    content = []
    for img_b64 in images:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img_b64}})
    content.append({"type": "text", "text": EXTRACTION_PROMPT})
    msg = ai.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=8192,
        messages=[{"role": "user", "content": content}]
    )
    text = msg.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    result = json.loads(text.strip())
    if isinstance(result, dict):
        result = [result]
    return result

# ── QBO helpers ───────────────────────────────────────────────────────────────

def qbo_get(token, path, params=None):
    resp = requests.get(
        f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        params=params,
    )
    resp.raise_for_status()
    return resp.json()

def get_qbo_vendors(token):
    data = qbo_get(token, "query", {"query": "SELECT * FROM Vendor MAXRESULTS 200"})
    return {v["Id"]: v["DisplayName"] for v in data.get("QueryResponse", {}).get("Vendor", [])}

def get_qbo_accounts(token):
    data = qbo_get(token, "query", {"query": "SELECT * FROM Account MAXRESULTS 200"})
    return {
        a["Id"]: {"name": a["Name"], "number": a.get("AcctNum", ""), "type": a["AccountType"]}
        for a in data.get("QueryResponse", {}).get("Account", [])
    }

def find_qbo_vendor_by_name(token, name):
    """Return (qbo_id, display_name) for the closest matching QBO vendor, or (None, None)."""
    vendors = get_qbo_vendors(token)
    name_lower = name.lower()
    best_id, best_name, best_score = None, None, 0.0
    for vid, vname in vendors.items():
        score = SequenceMatcher(None, name_lower, vname.lower()).ratio()
        if score > best_score:
            best_id, best_name, best_score = vid, vname, score
    if best_score >= 0.6:
        return best_id, best_name
    return None, None

# ── Supabase helpers ──────────────────────────────────────────────────────────

def upsert_vendor(sb, qbo_vendor_id, name):
    existing = sb.table("vendors").select("id").eq("qbo_vendor_id", qbo_vendor_id).execute()
    if existing.data:
        return existing.data[0]["id"]
    result = sb.table("vendors").insert({
        "qbo_vendor_id": qbo_vendor_id,
        "name": name,
        "short_name": name.split()[0] if name else None,
    }).execute()
    return result.data[0]["id"]

def upsert_account(sb, qbo_account_id, name, number, acct_type):
    existing = sb.table("qbo_accounts").select("id").eq("qbo_account_id", qbo_account_id).execute()
    if existing.data:
        return existing.data[0]["id"]
    result = sb.table("qbo_accounts").insert({
        "qbo_account_id": qbo_account_id,
        "name": name,
        "account_number": number,
        "account_type": acct_type,
    }).execute()
    return result.data[0]["id"]

def lookup_mapping(sb, vendor_db_id, description, sku):
    """Return (mapping_id, account_db_id, account_name, qbo_item_id, confidence) or Nones."""
    # 1. Exact SKU match
    if sku:
        r = sb.table("vendor_item_mappings") \
            .select("id,qbo_account_id,qbo_item_id,confidence,qbo_accounts(name)") \
            .eq("vendor_id", vendor_db_id).eq("item_sku", sku).execute()
        if r.data:
            row = r.data[0]
            acct_name = (row.get("qbo_accounts") or {}).get("name")
            return row["id"], row["qbo_account_id"], acct_name, row.get("qbo_item_id"), row["confidence"]

    # 2. Exact description match (case-insensitive)
    r = sb.table("vendor_item_mappings") \
        .select("id,qbo_account_id,qbo_item_id,confidence,item_description,qbo_accounts(name)") \
        .eq("vendor_id", vendor_db_id).execute()

    if not r.data:
        return None, None, None, None, 0.0

    desc_lower = description.lower()
    best_row, best_score = None, 0.0
    for row in r.data:
        score = SequenceMatcher(None, desc_lower, row["item_description"].lower()).ratio()
        if score > best_score:
            best_row, best_score = row, score

    if best_score >= 0.75 and best_row:
        acct_name = (best_row.get("qbo_accounts") or {}).get("name")
        return best_row["id"], best_row["qbo_account_id"], acct_name, best_row.get("qbo_item_id"), round(best_score * best_row["confidence"], 2)

    return None, None, None, None, 0.0

# ── Stage bill ────────────────────────────────────────────────────────────────

def stage_bill(sb, vendor_db_id, extracted, drive_file_id, drive_file_name, line_mappings):
    """Insert bill + line items into DB with status=pending. Returns bill_db_id."""
    bill_data = {
        "vendor_id": vendor_db_id,
        "invoice_number": extracted.get("invoice_number"),
        "invoice_date": extracted.get("invoice_date") or None,
        "due_date": extracted.get("due_date") or None,
        "total_amount": extracted.get("total_amount"),
        "drive_file_id": drive_file_id,
        "drive_file_name": drive_file_name,
        "source": "genie",
        "status": "pending",
        "raw_extraction": extracted,
    }
    result = sb.table("bills").insert(bill_data).execute()
    bill_db_id = result.data[0]["id"]

    for j, item in enumerate(extracted.get("line_items", [])):
        mapping_id, acct_db_id, _, _, conf = line_mappings[j]
        sb.table("bill_line_items").insert({
            "bill_id": bill_db_id,
            "line_number": item.get("line_number", j + 1),
            "description": item.get("description"),
            "sku": item.get("sku"),
            "quantity": item.get("quantity"),
            "unit": item.get("unit"),
            "unit_price": item.get("unit_price"),
            "extended_price": item.get("extended_price"),
            "qbo_account_id": acct_db_id,
            "mapping_id": mapping_id,
            "mapping_confidence": conf,
        }).execute()

    return bill_db_id

# ── Post to QBO ───────────────────────────────────────────────────────────────

def post_bill_to_qbo(token, sb, bill_db_id):
    """Post a pending bill to QBO and update its status."""
    bill = sb.table("bills").select("*, vendors(qbo_vendor_id,name), bill_line_items(*, qbo_accounts(qbo_account_id,name))") \
        .eq("id", bill_db_id).single().execute().data

    if not bill:
        print(f"Bill {bill_db_id} not found.")
        return

    if bill["status"] == "posted":
        print(f"Bill {bill_db_id} is already posted (QBO bill {bill['qbo_bill_id']}).")
        return

    vendor = bill.get("vendors", {})
    qbo_vendor_id = vendor.get("qbo_vendor_id")
    if not qbo_vendor_id:
        print(f"  ✗ Vendor has no QBO ID — can't post. Map vendor first.")
        return

    lines = []
    for li in bill.get("bill_line_items", []):
        acct = li.get("qbo_accounts", {})
        qbo_account_id = acct.get("qbo_account_id") if acct else None
        amount = li.get("extended_price") or 0

        if qbo_account_id:
            lines.append({
                "DetailType": "AccountBasedExpenseLineDetail",
                "Amount": float(amount),
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": qbo_account_id},
                },
                "Description": li.get("description"),
            })
        else:
            print(f"  ⚠ Line '{li.get('description')}' has no account mapping — skipping line")

    if not lines:
        print("  ✗ No postable lines. Ensure all line items have account mappings.")
        return

    payload = {
        "VendorRef": {"value": qbo_vendor_id},
        "TxnDate": bill.get("invoice_date"),
        "DocNumber": bill.get("invoice_number"),
        "Line": lines,
    }
    if bill.get("due_date"):
        payload["DueDate"] = bill["due_date"]

    resp = requests.post(
        f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/bill",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        json=payload,
    )

    if not resp.ok:
        print(f"  ✗ QBO API error: {resp.status_code} {resp.text}")
        sb.table("bills").update({"status": "error", "error_message": resp.text[:500]}).eq("id", bill_db_id).execute()
        return

    qbo_bill = resp.json().get("Bill", {})
    qbo_bill_id = qbo_bill.get("Id")
    sb.table("bills").update({"status": "posted", "qbo_bill_id": qbo_bill_id}).eq("id", bill_db_id).execute()
    print(f"  ✓ Posted to QBO as bill #{qbo_bill_id}")

# ── Review summary ────────────────────────────────────────────────────────────

def print_review(bill_db_id, extracted, vendor_name, qbo_vendor_name, line_mappings):
    total = extracted.get("total_amount", 0)
    print(f"\n{'='*64}")
    print(f"  Bill DB ID : {bill_db_id}")
    print(f"  Vendor     : {extracted.get('vendor_name')}", end="")
    if qbo_vendor_name:
        print(f"  →  ✓ {qbo_vendor_name} (QBO)")
    else:
        print(f"  →  ⚠ NO QBO VENDOR MATCH")
    print(f"  Invoice #  : {extracted.get('invoice_number')}   Date: {extracted.get('invoice_date')}   Total: ${total:,.2f}")
    print(f"{'─'*64}")

    for j, item in enumerate(extracted.get("line_items", [])):
        mapping_id, acct_db_id, acct_name, qbo_item_id, conf = line_mappings[j]
        desc = item.get("description", "")[:40]
        qty = item.get("quantity") or ""
        unit = item.get("unit") or ""
        up = item.get("unit_price") or 0
        ep = item.get("extended_price") or 0

        qty_str = f"{qty} {unit}".strip()
        price_str = f"@ ${up:.2f} = ${ep:.2f}" if up else f"${ep:.2f}"

        if acct_name:
            flag = f"→ {acct_name}  [conf {conf:.2f}]"
        else:
            flag = "→ ⚠ NO MAPPING"

        print(f"  {j+1:2}. {desc:<42} {qty_str:<10} {price_str:<22} {flag}")

    unmapped = sum(1 for _, acct_db_id, _, _, _ in line_mappings if not acct_db_id)
    print(f"{'─'*64}")
    if unmapped:
        print(f"  ⚠ {unmapped} line(s) have no account mapping — review before posting")
    print(f"  To post:  python process_genie.py --post {bill_db_id}")
    print()

# ── Main ──────────────────────────────────────────────────────────────────────

def run_scan():
    drive = get_drive()
    sb = get_supabase()
    qbo_token = get_qbo_token()

    files = list_genie_files(drive)
    if not files:
        print("Genie folder is empty.")
        return

    # Filter out already-staged files
    new_files = []
    for f in files:
        existing = sb.table("bills").select("id,status").eq("drive_file_id", f["id"]).execute()
        if existing.data:
            print(f"  skip: {f['name']}  (already in DB as bill {existing.data[0]['id']}, status={existing.data[0]['status']})")
        else:
            new_files.append(f)

    if not new_files:
        print("\nNo new files to process.")
        return

    print(f"\nProcessing {len(new_files)} new file(s) from Genie folder...\n")

    for f in new_files:
        fname = f["name"]
        mime = f["mimeType"]
        print(f"Processing: {fname}")

        try:
            raw = download_file(drive, f["id"])

            if mime == "application/pdf":
                images = pdf_to_images(raw, max_pages=20)
            else:
                # Image file — encode directly
                images = image_bytes_to_b64(raw)

            if not images:
                print(f"  ✗ Could not extract images from {fname}")
                continue

            invoices = extract_invoice(images)
            print(f"  Found {len(invoices)} invoice(s) in this file")

            for inv_idx, extracted in enumerate(invoices):
                if len(invoices) > 1:
                    print(f"\n  Invoice {inv_idx + 1}/{len(invoices)}:")
                vendor_name = extracted.get("vendor_name", "Unknown")

                # Find vendor in QBO
                qbo_vendor_id, qbo_vendor_name = find_qbo_vendor_by_name(qbo_token, vendor_name)
                if qbo_vendor_id:
                    vendor_db_id = upsert_vendor(sb, qbo_vendor_id, qbo_vendor_name)
                else:
                    # Stage anyway with a placeholder vendor
                    existing_v = sb.table("vendors").select("id").eq("name", vendor_name).execute()
                    if existing_v.data:
                        vendor_db_id = existing_v.data[0]["id"]
                    else:
                        r = sb.table("vendors").insert({"name": vendor_name, "short_name": vendor_name.split()[0]}).execute()
                        vendor_db_id = r.data[0]["id"]

                # Look up mappings for each line item
                line_items = extracted.get("line_items", [])
                line_mappings = []
                for item in line_items:
                    mapping = lookup_mapping(sb, vendor_db_id, item.get("description", ""), item.get("sku"))
                    line_mappings.append(mapping)

                bill_db_id = stage_bill(sb, vendor_db_id, extracted, f["id"], fname, line_mappings)
                print_review(bill_db_id, extracted, vendor_name, qbo_vendor_name, line_mappings)

        except Exception as e:
            print(f"  ✗ Error processing {fname}: {e}")
            continue


def run_post(bill_db_id):
    sb = get_supabase()
    qbo_token = get_qbo_token()
    print(f"Posting bill {bill_db_id} to QBO...")
    post_bill_to_qbo(qbo_token, sb, bill_db_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--post", type=int, metavar="BILL_ID", help="Post a staged bill to QBO")
    args = parser.parse_args()

    if args.post:
        run_post(args.post)
    else:
        run_scan()
