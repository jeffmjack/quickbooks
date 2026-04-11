import pandas as pd

xl = pd.ExcelFile('private-docs/payroll_je_spreadsheet.xlsx')
tabs_2025 = ['Jan 25','Feb 25','Mar 25','Apr 25','May 25','June 25','July 25','Aug 25','Sept 25','Oct 25','Nov 25','Dec 25']

results = []
for tab in tabs_2025:
    df = xl.parse(tab, header=None)
    cells = {}
    for i, row in df.iterrows():
        for j, val in enumerate(row):
            if pd.notna(val) and str(val).strip() not in ['', 'nan']:
                cells[(i,j)] = val

    je_credit, jeff, usa, total, drivers = None, None, None, None, None
    for (i,j), val in cells.items():
        s = str(val)
        if 'Accrued Payroll' in s:
            for jj in range(j-1, -1, -1):
                if (i,jj) in cells:
                    try: je_credit = float(cells[(i,jj)])
                    except: pass
                    break
        if 'Jeff wages' in s:
            try: jeff = float(cells.get((i,j-1)))
            except: pass
        if 'USA wages' in s:
            try: usa = float(cells.get((i,j-1)))
            except: pass
        if s.strip() == 'Total':
            try: total = float(cells.get((i,j-1)))
            except: pass
        if 'Delivery Labor from spreadsheet' in s:
            try: drivers = float(cells.get((i,j-1)))
            except: pass

    results.append({'month': tab, 'je_credit': je_credit, 'jeff': jeff, 'usa': usa, 'total': total, 'drivers': drivers})

bs = {
    'Jan 25': 7043.81, 'Feb 25': 9259.48, 'Mar 25': 15050.84, 'Apr 25': 22370.65,
    'May 25': 28749.49, 'June 25': 36258.23, 'July 25': 18348.45, 'Aug 25': 24945.47,
    'Sept 25': 31090.45, 'Oct 25': 40470.17, 'Nov 25': 47010.85, 'Dec 25': 24880.89
}

def fmt(v):
    if v is None: return '—'
    return f'${v:,.0f}'

print(f"{'Month':<10} {'AJE Credit':>12} {'Jeff':>10} {'Erica':>10} {'Grand Total':>12} {'Drivers':>10} {'BS Balance':>12} {'Implied Debits':>15}")
print('-'*95)
prev_bal = 0
credit_total = 0
for r in results:
    m = r['month']
    credit = r['je_credit'] or 0
    credit_total += credit
    bal = bs.get(m, 0)
    change = bal - prev_bal
    implied = credit - change
    print(f"{m:<10} {fmt(credit):>12} {fmt(r['jeff']):>10} {fmt(r['usa']):>10} {fmt(r['total']):>12} {fmt(r['drivers']):>10} {fmt(bal):>12} {fmt(implied):>15}")
    prev_bal = bal

print('-'*95)
print(f"{'TOTAL':<10} {fmt(credit_total):>12}")
print()
print(f"Total AJE credits to 2200 in 2025:  {fmt(credit_total)}")
print(f"Year-end residual in 2200:           $24,881")
print(f"Implied total payroll debits to 2200: {fmt(credit_total - 24880.89)}")
