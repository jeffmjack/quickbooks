"""Post the 12/31/25 accrued payroll correcting AJE to QBO."""
import os, re, requests
from dotenv import load_dotenv
load_dotenv()

def get_token():
    resp = requests.post(
        'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        auth=(os.getenv('QBO_CLIENT_ID'), os.getenv('QBO_CLIENT_SECRET')),
        data={'grant_type': 'refresh_token', 'refresh_token': os.getenv('QBO_REFRESH_TOKEN')},
    )
    resp.raise_for_status()
    data = resp.json()
    new_refresh = data.get('refresh_token')
    if new_refresh and new_refresh != os.getenv('QBO_REFRESH_TOKEN'):
        with open('.env') as f: content = f.read()
        content = re.sub(r'^QBO_REFRESH_TOKEN=.*$', f'QBO_REFRESH_TOKEN={new_refresh}', content, flags=re.MULTILINE)
        with open('.env', 'w') as f: f.write(content)
        os.environ['QBO_REFRESH_TOKEN'] = new_refresh
    return data['access_token']

token = get_token()
REALM = os.getenv('QBO_REALM_ID')
headers = {
    'Authorization': f'Bearer {token}',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
}

# Account IDs (verified from QBO)
ACCTS = {
    '2200 Accrued Payroll':            '148',
    'Breakfast Taco Labor':            '211',
    'Sandwich and Wrap Labor':         '222',
    'Delivery Contract Labor 1099':    '223',
    '6101 Officer Expense (salary)':   '137',
    '6103 Management':                 '152',
}

TOTAL = 24880.89
splits = {
    'Breakfast Taco Labor':           7744.35,
    'Sandwich and Wrap Labor':        5451.60,
    'Delivery Contract Labor 1099':   4932.84,
    '6101 Officer Expense (salary)':  3447.33,
    '6103 Management':                3304.77,
}

# Verify splits sum correctly
assert abs(sum(splits.values()) - TOTAL) < 0.01, f"Splits don't balance: {sum(splits.values())}"

memo = "YE cash basis adj: reverse over-accrued payroll. Est wages AJEs ($751,373 CR) exceeded Homebase debits ($726,492 DR). See 2025_YearEnd_AJE_AccruedPayroll.pdf"

lines = []

# Debit: 2200 Accrued Payroll
lines.append({
    "Id": "1",
    "DetailType": "JournalEntryLineDetail",
    "Amount": TOTAL,
    "Description": "Clear over-accrued payroll - cash basis YE correction",
    "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": {"value": ACCTS['2200 Accrued Payroll']},
    }
})

# Credits: COGS labor accounts
credit_descs = {
    'Breakfast Taco Labor':          'Over-accrued taco labor 31.1%',
    'Sandwich and Wrap Labor':       'Over-accrued sandwich labor 21.9%',
    'Delivery Contract Labor 1099':  'Over-accrued delivery labor 19.8%',
    '6101 Officer Expense (salary)': 'Over-accrued officer comp 13.9%',
    '6103 Management':               'Over-accrued management labor 13.3%',
}
for idx, (acct, amt) in enumerate(splits.items(), start=2):
    lines.append({
        "Id": str(idx),
        "DetailType": "JournalEntryLineDetail",
        "Amount": amt,
        "Description": credit_descs[acct],
        "JournalEntryLineDetail": {
            "PostingType": "Credit",
            "AccountRef": {"value": ACCTS[acct]},
        }
    })

payload = {
    "TxnDate": "2025-12-31",
    "DocNumber": "AJE-2025-PR",
    "Line": lines,
}

resp = requests.post(
    f'https://quickbooks.api.intuit.com/v3/company/{REALM}/journalentry',
    headers=headers,
    json=payload,
)

if resp.ok:
    je = resp.json().get('JournalEntry', {})
    je_id = je.get('Id')
    print(f"Posted successfully!")
    print(f"  QBO JE ID:   {je_id}")
    print(f"  TxnDate:     {je.get('TxnDate')}")
    print(f"  DocNumber:   {je.get('DocNumber')}")
    print(f"  Review URL:  https://app.qbo.intuit.com/app/journal?txnId={je_id}")
else:
    print(f"Error {resp.status_code}: {resp.text}")
