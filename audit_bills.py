"""
Audit entered bills from Google Drive against QBO to build vendor_item_mappings.
Processes the most recent N bills, extracts data via Claude vision, matches to QBO bills.
"""

import os
import io
import json
import base64
import subprocess
import tempfile
import time
import requests
from datetime import datetime
from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import anthropic
from supabase import create_client

load_dotenv()

# ── Clients ──────────────────────────────────────────────────────────────────

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
ENTERED_BILLS_ID = "1l4eDyFh-FztzGdNGCDNAmOrWpXDHdHCK"

# ── Drive helpers ─────────────────────────────────────────────────────────────

def list_entered_bills(drive, limit=100):
    files = []
    page_token = None
    while len(files) < limit:
        resp = drive.files().list(
            q=f"'{ENTERED_BILLS_ID}' in parents and mimeType='application/pdf' and trashed=false",
            fields="nextPageToken,files(id,name,modifiedTime,size)",
            orderBy="modifiedTime desc",
            pageSize=min(100, limit - len(files)),
            pageToken=page_token,
        ).execute()
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files[:limit]

def download_pdf(drive, file_id):
    request = drive.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()

def pdf_to_images(pdf_bytes, max_pages=3):
    """Convert first N pages of PDF to base64 JPEG images."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        pdf_path = f.name
    with tempfile.TemporaryDirectory() as tmpdir:
        out_prefix = os.path.join(tmpdir, "page")
        subprocess.run(
            ["pdftoppm", "-r", "200", "-jpeg", "-f", "1", "-l", str(max_pages), pdf_path, out_prefix],
            capture_output=True
        )
        images = []
        for fname in sorted(os.listdir(tmpdir)):
            if fname.endswith(".jpg"):
                with open(os.path.join(tmpdir, fname), "rb") as img:
                    images.append(base64.standard_b64encode(img.read()).decode())
    os.unlink(pdf_path)
    return images

# ── Claude extraction ─────────────────────────────────────────────────────────

EXTRACTION_PROMPT = """Extract all information from this vendor invoice/bill. Return a JSON object with exactly this structure:

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

If multiple pages, combine all line items. Return only valid JSON, no other text."""

def extract_bill(images):
    content = []
    for img_b64 in images:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img_b64}})
    content.append({"type": "text", "text": EXTRACTION_PROMPT})

    msg = ai.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": content}]
    )
    text = msg.content[0].text.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    result = json.loads(text.strip())
    # Claude occasionally returns a list with one dict — unwrap it
    if isinstance(result, list):
        result = result[0] if result else {}
    return result

# ── QBO lookup ────────────────────────────────────────────────────────────────

def find_qbo_bill(token, vendor_name, invoice_number, invoice_date):
    """Search QBO for a matching bill."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    # Search by DocNumber — try as-is and also stripped of leading zeros
    for doc_num in dict.fromkeys([invoice_number, invoice_number.lstrip("0")]):
        if not doc_num:
            continue
        query = f"SELECT * FROM Bill WHERE DocNumber = '{doc_num}' MAXRESULTS 5"
        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/query",
            headers=headers, params={"query": query}
        )
        if resp.ok:
            bills = resp.json().get("QueryResponse", {}).get("Bill", [])
            if bills:
                return bills[0]

    # Fallback: search by vendor name keyword, then match by date proximity
    if invoice_date and vendor_name:
        try:
            datetime.strptime(invoice_date, "%Y-%m-%d")  # validate format
            kw = vendor_name.split()[0].replace("'", "\\'")  # first word, escaped
            query = f"SELECT * FROM Bill WHERE VendorRef.name LIKE '%{kw}%' MAXRESULTS 100"
            resp = requests.get(
                f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/query",
                headers=headers, params={"query": query}
            )
            if resp.ok:
                bills = resp.json().get("QueryResponse", {}).get("Bill", [])
                # Pick the bill whose TxnDate is closest to invoice_date (within 7 days)
                from datetime import timedelta
                inv_dt = datetime.strptime(invoice_date, "%Y-%m-%d")
                best, best_delta = None, timedelta(days=8)
                for b in bills:
                    try:
                        b_dt = datetime.strptime(b.get("TxnDate", ""), "%Y-%m-%d")
                        delta = abs(b_dt - inv_dt)
                        if delta < best_delta:
                            best, best_delta = b, delta
                    except:
                        pass
                if best:
                    return best
        except:
            pass
    return None

def get_qbo_accounts(token):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    resp = requests.get(
        f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/query",
        headers=headers,
        params={"query": "SELECT * FROM Account MAXRESULTS 200"}
    )
    accounts = {}
    for a in resp.json().get("QueryResponse", {}).get("Account", []):
        accounts[a["Id"]] = {"name": a["Name"], "number": a.get("AcctNum", ""), "type": a["AccountType"]}
    return accounts

def get_qbo_items(token):
    """Load all QBO items with their expense accounts."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    items = {}
    for start in range(1, 500, 100):
        resp = requests.get(
            f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/query",
            headers=headers,
            params={"query": f"SELECT * FROM Item MAXRESULTS 100 STARTPOSITION {start}"}
        )
        batch = resp.json().get("QueryResponse", {}).get("Item", [])
        for item in batch:
            exp_acct = item.get("ExpenseAccountRef", {})
            items[item["Id"]] = {
                "name": item["Name"],
                "expense_account_id": exp_acct.get("value"),
                "expense_account_name": exp_acct.get("name"),
            }
        if len(batch) < 100:
            break
    return items

def get_qbo_vendors(token):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    resp = requests.get(
        f"https://quickbooks.api.intuit.com/v3/company/{REALM_ID}/query",
        headers=headers,
        params={"query": "SELECT * FROM Vendor MAXRESULTS 200"}
    )
    vendors = {}
    for v in resp.json().get("QueryResponse", {}).get("Vendor", []):
        vendors[v["Id"]] = v["DisplayName"]
    return vendors

# ── Supabase upserts ──────────────────────────────────────────────────────────

def upsert_vendor(sb, qbo_vendor_id, name):
    existing = sb.table("vendors").select("id").eq("qbo_vendor_id", qbo_vendor_id).execute()
    if existing.data:
        return existing.data[0]["id"]
    result = sb.table("vendors").insert({
        "qbo_vendor_id": qbo_vendor_id,
        "name": name,
        "short_name": name.split()[0] if name else None
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
        "account_type": acct_type
    }).execute()
    return result.data[0]["id"]

def upsert_mapping(sb, vendor_id, description, sku, account_id, confidence=1.0, notes=None):
    # Check if mapping already exists
    q = sb.table("vendor_item_mappings").select("id,confidence").eq("vendor_id", vendor_id)
    if sku:
        q = q.eq("item_sku", sku)
    else:
        q = q.eq("item_description", description)
    existing = q.execute()

    if existing.data:
        # Update if new confidence is higher
        if confidence > existing.data[0]["confidence"]:
            sb.table("vendor_item_mappings").update({
                "qbo_account_id": account_id,
                "confidence": confidence,
                "notes": notes,
                "updated_at": datetime.utcnow().isoformat()
            }).eq("id", existing.data[0]["id"]).execute()
        return existing.data[0]["id"]

    result = sb.table("vendor_item_mappings").insert({
        "vendor_id": vendor_id,
        "item_description": description,
        "item_sku": sku,
        "qbo_account_id": account_id,
        "confidence": confidence,
        "notes": notes
    }).execute()
    return result.data[0]["id"]

# ── Main ──────────────────────────────────────────────────────────────────────

def main(limit=60):
    print(f"Starting bill audit (processing up to {limit} recent bills)...\n")

    drive = get_drive()
    sb = get_supabase()
    qbo_token = get_qbo_token()

    print("Loading QBO accounts, items, and vendors...")
    qbo_accounts = get_qbo_accounts(qbo_token)
    qbo_items = get_qbo_items(qbo_token)
    qbo_vendors = get_qbo_vendors(qbo_token)
    print(f"  {len(qbo_accounts)} accounts, {len(qbo_items)} items, {len(qbo_vendors)} vendors\n")

    bills = list_entered_bills(drive, limit=limit)
    print(f"Found {len(bills)} entered bills to process\n")

    stats = {"processed": 0, "matched_qbo": 0, "mappings_created": 0, "errors": 0}

    for i, bill_file in enumerate(bills):
        fname = bill_file["name"]
        print(f"[{i+1}/{len(bills)}] {fname}")

        try:
            # Download + convert to images
            pdf_bytes = download_pdf(drive, bill_file["id"])
            images = pdf_to_images(pdf_bytes, max_pages=4)
            if not images:
                print(f"  ⚠ No images extracted, skipping")
                stats["errors"] += 1
                continue

            # Extract with Claude
            extracted = extract_bill(images)
            vendor_name = extracted.get("vendor_name", "Unknown")
            invoice_number = extracted.get("invoice_number", "")
            invoice_date = extracted.get("invoice_date", "")
            total = extracted.get("total_amount", 0)
            line_items = extracted.get("line_items", [])
            confidence = extracted.get("confidence", 0.8)

            print(f"  Vendor: {vendor_name} | Invoice: {invoice_number} | Date: {invoice_date} | Total: ${total:,.2f} | Lines: {len(line_items)}")

            # Find matching QBO bill
            qbo_bill = find_qbo_bill(qbo_token, vendor_name, invoice_number, invoice_date)

            if not qbo_bill:
                print(f"  ⚠ No QBO match found")
                stats["errors"] += 1
                stats["processed"] += 1
                continue

            stats["matched_qbo"] += 1
            qbo_vendor_id = qbo_bill.get("VendorRef", {}).get("value", "")
            qbo_vendor_name = qbo_bill.get("VendorRef", {}).get("name", vendor_name)

            # Upsert vendor
            vendor_db_id = upsert_vendor(sb, qbo_vendor_id, qbo_vendor_name)

            # Process QBO bill lines — handle both item-based and account-based
            qbo_lines = [l for l in qbo_bill.get("Line", []) if l.get("DetailType") != "SubTotalLineDetail"]
            qbo_line_map = {}  # position → {qbo_item_id, qbo_item_name, acct_id, acct_db_id}

            for idx, line in enumerate(qbo_lines):
                entry = {}
                # Item-based (most common)
                item_detail = line.get("ItemBasedExpenseLineDetail", {})
                if item_detail:
                    item_ref = item_detail.get("ItemRef", {})
                    item_id = item_ref.get("value")
                    if item_id and item_id in qbo_items:
                        qbo_item = qbo_items[item_id]
                        entry["qbo_item_id"] = item_id
                        entry["qbo_item_name"] = qbo_item["name"]
                        acct_id = qbo_item.get("expense_account_id")
                        if acct_id and acct_id in qbo_accounts:
                            acct = qbo_accounts[acct_id]
                            entry["acct_db_id"] = upsert_account(sb, acct_id, acct["name"], acct["number"], acct["type"])

                # Account-based (fallback)
                acct_detail = line.get("AccountBasedExpenseLineDetail", {})
                if acct_detail and "acct_db_id" not in entry:
                    acct_ref = acct_detail.get("AccountRef", {})
                    acct_id = acct_ref.get("value")
                    if acct_id and acct_id in qbo_accounts:
                        acct = qbo_accounts[acct_id]
                        entry["acct_db_id"] = upsert_account(sb, acct_id, acct["name"], acct["number"], acct["type"])

                if entry:
                    qbo_line_map[idx] = entry

            mappings_this_bill = 0

            # Insert bill record
            bill_insert = {
                "vendor_id": vendor_db_id,
                "invoice_number": invoice_number,
                "invoice_date": invoice_date or None,
                "total_amount": total,
                "qbo_bill_id": qbo_bill.get("Id"),
                "drive_file_id": bill_file["id"],
                "drive_file_name": fname,
                "source": "drive",
                "status": "posted",
                "raw_extraction": extracted
            }
            existing_bill = sb.table("bills").select("id").eq("drive_file_id", bill_file["id"]).execute()
            if existing_bill.data:
                bill_db_id = existing_bill.data[0]["id"]
                # Update qbo_bill_id if we now have a match
                sb.table("bills").update({"qbo_bill_id": qbo_bill.get("Id"), "status": "posted"}).eq("id", bill_db_id).execute()
            else:
                try:
                    bill_result = sb.table("bills").insert(bill_insert).execute()
                    bill_db_id = bill_result.data[0]["id"]
                except Exception as e:
                    if "bills_qbo_bill_id_key" in str(e):
                        # Another Drive file already claimed this QBO bill; insert without qbo_bill_id
                        bill_insert["qbo_bill_id"] = None
                        bill_result = sb.table("bills").insert(bill_insert).execute()
                        bill_db_id = bill_result.data[0]["id"]
                    else:
                        raise

            # Skip line items if already recorded WITH account mappings
            existing_lines = sb.table("bill_line_items").select("id,qbo_account_id").eq("bill_id", bill_db_id).execute()
            if existing_lines.data:
                has_accounts = any(r["qbo_account_id"] for r in existing_lines.data)
                if has_accounts:
                    print(f"  ✓ Already processed, skipping line items")
                    stats["processed"] += 1
                    continue
                else:
                    # Prior run had no account IDs — wipe and redo
                    sb.table("bill_line_items").delete().eq("bill_id", bill_db_id).execute()

            # Positional match: PDF line j → QBO line j
            primary = qbo_line_map.get(0, {})

            for j, item in enumerate(line_items):
                desc = item.get("description", "")
                sku = item.get("sku")
                qbo_line = qbo_line_map.get(j, primary)
                acct_db_id = qbo_line.get("acct_db_id")
                qbo_item_id = qbo_line.get("qbo_item_id")
                qbo_item_name = qbo_line.get("qbo_item_name")

                if desc and (acct_db_id or qbo_item_id):
                    upsert_mapping(
                        sb, vendor_db_id, desc, sku, acct_db_id,
                        confidence=confidence,
                        notes=f"QBO item: {qbo_item_name} | Audited from {fname}"
                    )
                    # Also store the qbo_item_id in the mapping
                    if qbo_item_id:
                        existing = sb.table("vendor_item_mappings") \
                            .select("id").eq("vendor_id", vendor_db_id) \
                            .eq("item_description", desc).execute()
                        if existing.data:
                            sb.table("vendor_item_mappings").update(
                                {"qbo_item_id": qbo_item_id}
                            ).eq("id", existing.data[0]["id"]).execute()
                    mappings_this_bill += 1
                    stats["mappings_created"] += 1

                # Insert line item
                sb.table("bill_line_items").insert({
                    "bill_id": bill_db_id,
                    "line_number": item.get("line_number", j + 1),
                    "description": desc,
                    "sku": sku,
                    "quantity": item.get("quantity"),
                    "unit": item.get("unit"),
                    "unit_price": item.get("unit_price"),
                    "extended_price": item.get("extended_price"),
                    "qbo_account_id": acct_db_id,
                    "mapping_confidence": confidence,
                }).execute()

            print(f"  ✓ Matched QBO bill #{qbo_bill.get('Id')} | {len(line_items)} PDF lines | {len(qbo_line_map)} QBO lines | {mappings_this_bill} mappings")
            stats["processed"] += 1

            # Respect rate limits
            time.sleep(0.5)

        except Exception as e:
            print(f"  ✗ Error: {e}")
            stats["errors"] += 1
            continue

    print(f"\n{'='*60}")
    print(f"Audit complete!")
    print(f"  Bills processed:    {stats['processed']}")
    print(f"  Matched to QBO:     {stats['matched_qbo']}")
    print(f"  Mappings created:   {stats['mappings_created']}")
    print(f"  Errors/skipped:     {stats['errors']}")

    # Summary of mappings by vendor
    print(f"\nMappings by vendor:")
    result = sb.table("vendor_item_mappings").select("vendor_id, vendors(name)", count="exact").execute()
    vendors_done = sb.table("vendors").select("id, name").execute()
    for v in vendors_done.data:
        count = sb.table("vendor_item_mappings").select("id", count="exact").eq("vendor_id", v["id"]).execute()
        if count.count:
            print(f"  {v['name']}: {count.count} mappings")


if __name__ == "__main__":
    import sys
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    main(limit=limit)
