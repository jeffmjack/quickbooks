"""Generate a sanity-check summary PDF for the pulled QBO reports."""

import pandas as pd
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from datetime import date

OUT = "private-docs/reports_summary.pdf"

styles = getSampleStyleSheet()
title_style = ParagraphStyle("title", parent=styles["Title"], fontSize=16, spaceAfter=6)
h2_style = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=12, spaceBefore=14, spaceAfter=4, textColor=colors.HexColor("#1F4E79"))
body_style = ParagraphStyle("body", parent=styles["Normal"], fontSize=9, spaceAfter=3)
warning_style = ParagraphStyle("warn", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#C00000"), spaceAfter=3)
mono_style = ParagraphStyle("mono", parent=styles["Code"], fontSize=8, spaceAfter=2)

TABLE_STYLE = TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E79")),
    ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
    ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTSIZE",   (0, 0), (-1, -1), 8),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#EBF3FB"), colors.white]),
    ("GRID",       (0, 0), (-1, -1), 0.25, colors.HexColor("#AAAAAA")),
    ("VALIGN",     (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING",  (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
])

def fmt(val):
    try:
        return f"${float(val):>12,.2f}"
    except:
        return str(val) if val else "—"


def section(story, title):
    story.append(Spacer(1, 0.1 * inch))
    story.append(Paragraph(title, h2_style))


def make_table(headers, rows, col_widths=None):
    data = [headers] + rows
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TABLE_STYLE)
    return t


def main():
    story = []
    story.append(Paragraph("QBO Reports — Sanity Check Summary", title_style))
    story.append(Paragraph(f"Generated {date.today().strftime('%B %d, %Y')} | Cash Basis", body_style))
    story.append(Spacer(1, 0.2 * inch))

    # ── 1. P&L ──────────────────────────────────────────────────────────────
    section(story, "1. Profit & Loss by Month (Jan 2025 – Feb 2026, Cash)")
    df = pd.read_excel("private-docs/ProfitAndLoss_by_month_2025-2026.xlsx")
    df.columns = [str(c) for c in df.columns]
    month_cols = [c for c in df.columns if c not in ("Unnamed: 0", "Total")]
    key_rows = ["Total Income", "Total Cost of Goods Sold", "Gross Profit",
                "Total Expenses", "Net Operating Income", "Net Income"]
    headers = [""] + month_cols + ["Total"]
    rows = []
    for label in key_rows:
        match = df[df["Unnamed: 0"].str.strip() == label]
        if not match.empty:
            r = match.iloc[0]
            rows.append([label] + [fmt(r.get(c, "")) for c in month_cols] + [fmt(r.get("Total", ""))])
    col_w = [1.5 * inch] + [0.45 * inch] * len(month_cols) + [0.6 * inch]
    story.append(make_table(headers, rows, col_widths=col_w))
    net_income = df[df["Unnamed: 0"].str.strip() == "Net Income"]
    if not net_income.empty:
        total = net_income.iloc[0].get("Total", "")
        story.append(Paragraph(f"<b>Net Income (period total): {fmt(total)}</b>", body_style))

    # ── 2. Balance Sheet ─────────────────────────────────────────────────────
    section(story, "2. Balance Sheet by Month (Jan 2025 – Feb 2026)")
    df = pd.read_excel("private-docs/BalanceSheet_by_month_2025-2026.xlsx")
    df.columns = [str(c) for c in df.columns]
    month_cols = [c for c in df.columns if c not in ("Unnamed: 0",)]
    key_rows = ["TOTAL ASSETS", "Total Liabilities", "Total Equity", "TOTAL LIABILITIES AND EQUITY"]
    headers = [""] + month_cols
    rows = []
    for label in key_rows:
        match = df[df["Unnamed: 0"].str.strip() == label]
        if not match.empty:
            r = match.iloc[0]
            rows.append([label] + [fmt(r.get(c, "")) for c in month_cols])
    col_w = [1.7 * inch] + [0.45 * inch] * len(month_cols)
    story.append(make_table(headers, rows, col_widths=col_w))
    # Latest equity
    eq = df[df["Unnamed: 0"].str.strip() == "Total Equity"]
    if not eq.empty and month_cols:
        latest_col = month_cols[-1]
        story.append(Paragraph(f"<b>Total Equity as of {latest_col}: {fmt(eq.iloc[0].get(latest_col, ''))}</b>", body_style))

    # ── 3. General Ledger ────────────────────────────────────────────────────
    section(story, "3. General Ledger (Jan – Feb 2026)")
    df = pd.read_excel("private-docs/GeneralLedger_Jan-Feb_2026.xlsx")
    txn_rows = df[df["Transaction Type"].notna() & ~df["Transaction Type"].astype(str).str.startswith("Total")]
    story.append(Paragraph(f"Total transaction rows: <b>{len(txn_rows):,}</b>", body_style))
    type_counts = txn_rows["Transaction Type"].value_counts().head(10)
    rows = [[t, str(c)] for t, c in type_counts.items()]
    story.append(make_table(["Transaction Type", "Count"], rows, col_widths=[3 * inch, 1 * inch]))

    # ── 4. Sales by Customer ─────────────────────────────────────────────────
    section(story, "4. Sales by Customer Detail (Jan – Feb 2026)")
    df = pd.read_excel("private-docs/SalesByCustomer_Jan-Feb_2026.xlsx")
    if len(df) <= 2:
        story.append(Paragraph(
            "⚠ WARNING: QBO returned only a summary total row — no customer-level detail. "
            "The CustomerSales report may not support detail at this level. "
            "We may need to pull TransactionListByCustomer instead.",
            warning_style))
        total_row = df[df.iloc[:, 0].astype(str).str.upper().str.contains("TOTAL")]
        if not total_row.empty:
            story.append(Paragraph(f"Total reported: <b>{fmt(total_row.iloc[0].get('Total', ''))}</b>", body_style))
    else:
        story.append(Paragraph(f"Total customer rows: <b>{len(df):,}</b>", body_style))
        story.append(Paragraph(f"Total sales: <b>{fmt(df['Total'].sum())}</b>", body_style))

    # ── 5. AR Aging ──────────────────────────────────────────────────────────
    section(story, "5. AR Aging as of 2/28/2026")
    df = pd.read_excel("private-docs/AR_Aging_2026-02-28.xlsx")
    total_row = df[df["Customer"].isna() & df["Transaction Type"].isna()]
    open_invoices = df[df["Transaction Type"] == "Invoice"]
    story.append(Paragraph(f"Open invoice rows: <b>{len(open_invoices):,}</b>", body_style))
    total = df[df.iloc[:, 0].astype(str).str.strip().str.upper() == "TOTAL"]
    if not total.empty:
        story.append(Paragraph(f"Total AR Open Balance: <b>{fmt(total.iloc[0].get('Open Balance', ''))}</b>", body_style))
    # Aging buckets
    buckets = ["Current", "1 - 30", "31 - 60", "61 - 90", "91 or more"]
    bucket_rows = []
    for b in buckets:
        match = df[df["Date"].astype(str).str.contains(b, na=False)]
        if not match.empty:
            ob = match[match["Open Balance"].notna()]["Open Balance"]
            bucket_rows.append([b, fmt(ob.sum())])
    if bucket_rows:
        story.append(make_table(["Aging Bucket", "Open Balance"], bucket_rows, col_widths=[2 * inch, 1.5 * inch]))

    # ── 6. Bill Payments ─────────────────────────────────────────────────────
    section(story, "6. Bill Payments (Jan – Feb 2026)")
    df = pd.read_excel("private-docs/BillPayments_Jan-Feb_2026.xlsx")
    unique_payments = df.drop_duplicates(subset=["Date", "Vendor", "Amount"])
    story.append(Paragraph(f"Total payments: <b>{len(unique_payments):,}</b> | "
                            f"Total amount: <b>{fmt(unique_payments['Amount'].sum())}</b>", body_style))
    top_vendors = unique_payments.groupby("Vendor")["Amount"].sum().sort_values(ascending=False).head(8)
    rows = [[v, fmt(a)] for v, a in top_vendors.items()]
    story.append(make_table(["Vendor", "Total Paid"], rows, col_widths=[3 * inch, 1.5 * inch]))

    # ── 7. AP Aging ──────────────────────────────────────────────────────────
    section(story, "7. AP Aging as of 2/28/2026")
    df = pd.read_excel("private-docs/AP_Aging_2026-02-28.xlsx")
    total = df[df.iloc[:, 0].astype(str).str.strip().str.upper() == "TOTAL"]
    if not total.empty:
        story.append(Paragraph(f"Total AP Open Balance: <b>{fmt(total.iloc[0].get('Open Balance', ''))}</b>", body_style))
    open_bills = df[df["Transaction Type"] == "Bill"]
    story.append(Paragraph(f"Open bill rows: <b>{len(open_bills):,}</b>", body_style))
    top_vendors = df[df["Transaction Type"] == "Bill"].groupby("Vendor")["Open Balance"].sum().sort_values(ascending=False).head(8)
    if not top_vendors.empty:
        rows = [[v, fmt(a)] for v, a in top_vendors.items()]
        story.append(make_table(["Vendor", "Open Balance"], rows, col_widths=[3 * inch, 1.5 * inch]))

    # Build PDF
    doc = SimpleDocTemplate(OUT, pagesize=letter,
                            leftMargin=0.6*inch, rightMargin=0.6*inch,
                            topMargin=0.6*inch, bottomMargin=0.6*inch)
    doc.build(story)
    print(f"Summary saved to {OUT}")


if __name__ == "__main__":
    main()
