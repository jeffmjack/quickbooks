from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.lib.enums import TA_LEFT
from datetime import date

doc = SimpleDocTemplate(
    'private-docs/Barney/2025_YearEnd_AJE_AccruedPayroll.pdf',
    pagesize=letter,
    rightMargin=0.75*inch, leftMargin=0.75*inch,
    topMargin=0.75*inch, bottomMargin=0.75*inch
)

styles = getSampleStyleSheet()
h1 = ParagraphStyle('h1', fontSize=14, fontName='Helvetica-Bold', spaceAfter=6)
h2 = ParagraphStyle('h2', fontSize=11, fontName='Helvetica-Bold', spaceAfter=4, spaceBefore=12)
body = ParagraphStyle('body', fontSize=9, fontName='Helvetica', spaceAfter=4, leading=14)
caption = ParagraphStyle('caption', fontSize=8, fontName='Helvetica-Oblique', textColor=colors.grey)
green = colors.HexColor('#2d6a4f')
dark_green = colors.HexColor('#1b4332')
light = colors.HexColor('#f8f8f8')
mid = colors.HexColor('#f0f0f0')
grid = colors.HexColor('#cccccc')

story = []

story.append(Paragraph('Green Cart — Year-End Adjusting Journal Entry', h1))
story.append(Paragraph('2200 Accrued Payroll Correction | December 31, 2025', h2))
story.append(Paragraph(f'Prepared: {date.today().strftime("%B %d, %Y")} | Cash Basis Reporting', caption))
story.append(Spacer(1, 10))
story.append(HRFlowable(width='100%', thickness=1, color=colors.black))
story.append(Spacer(1, 8))

# Finding
story.append(Paragraph('Finding', h2))
story.append(Paragraph(
    'The December 31, 2025 cash basis balance sheet showed a <b>$24,880.89 credit balance in account '
    '2200 Accrued Payroll</b>. On a cash basis balance sheet this account should net to zero at year-end, '
    'as expenses are recognized only when cash is disbursed. The balance had been building throughout 2025, '
    'with two manual cleanup entries made mid-year (July: -$17,910; December: -$22,130) that reduced but '
    'did not fully clear it.', body))

# Root Cause
story.append(Paragraph('Root Cause', h2))
story.append(Paragraph(
    'Green Cart uses a two-step payroll accounting process:', body))
story.append(Paragraph(
    '<b>Step 1 — Homebase biweekly payroll JE (automatic):</b> Each payroll run, Homebase debits '
    '2200 Accrued Payroll for wages paid (Wages and Salaries, Contractor Payments, Employee Benefits, '
    'Expense Reimbursements) and credits 1000 Chase Checking for net cash disbursed. Employer taxes '
    'are routed separately to 6120 Payroll Taxes.', body))
story.append(Paragraph(
    '<b>Step 2 — Month-end manual AJE:</b> A monthly journal entry credits 2200 Accrued Payroll and '
    'debits the appropriate COGS labor accounts. Amounts are sourced from the Homebase Timesheets '
    '"Est. Wages" column (hours x hourly rate) for hourly workers, plus manually calculated salaried '
    'wages (Jeffrey, Erica) and driver payroll from a separate spreadsheet.', body))
story.append(Paragraph(
    'The residual balance accumulated because <b>the monthly AJE credit to 2200 consistently exceeded '
    'the Homebase automatic debit to 2200</b> — estimated wages accrued to COGS were slightly higher '
    'than actual wages disbursed in cash. The cumulative over-accrual across all 12 months of 2025 '
    'totaled $24,880.89, leaving a credit balance on the cash basis balance sheet.', body))

# Month-by-month table
story.append(Paragraph('Month-by-Month Reconciliation', h2))
bs_data = [
    ['Month', 'AJE Credit to 2200', 'BS Balance (EOM)', 'Net Change'],
    ['Jan 2025', '$57,431', '$7,044', '+$7,044'],
    ['Feb 2025', '$55,877', '$9,259', '+$2,215'],
    ['Mar 2025', '$60,275', '$15,051', '+$5,792'],
    ['Apr 2025', '$59,557', '$22,371', '+$7,320'],
    ['May 2025', '$61,237', '$28,749', '+$6,378'],
    ['Jun 2025', '$59,680', '$36,258', '+$7,509'],
    ['Jul 2025', '$62,690', '$18,348', '-$17,910'],
    ['Aug 2025', '$60,873', '$24,945', '+$6,597'],
    ['Sep 2025', '$59,777', '$31,090', '+$6,145'],
    ['Oct 2025', '$64,165', '$40,470', '+$9,380'],
    ['Nov 2025', '$67,202', '$47,011', '+$6,541'],
    ['Dec 2025', '$82,609', '$24,881', '-$22,130'],
    ['TOTAL 2025', '$751,373', '', ''],
]
t = Table(bs_data, colWidths=[1.2*inch, 1.6*inch, 1.6*inch, 1.3*inch])
t.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), green),
    ('TEXTCOLOR', (0,0), (-1,0), colors.white),
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTNAME', (0,-1), (-1,-1), 'Helvetica-Bold'),
    ('BACKGROUND', (0,-1), (-1,-1), mid),
    ('FONTSIZE', (0,0), (-1,-1), 8),
    ('ROWBACKGROUNDS', (0,1), (-1,-2), [colors.white, light]),
    ('GRID', (0,0), (-1,-1), 0.5, grid),
    ('ALIGN', (1,0), (-1,-1), 'RIGHT'),
    ('TOPPADDING', (0,0), (-1,-1), 4),
    ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ('LEFTPADDING', (0,0), (-1,-1), 6),
]))
story.append(t)
story.append(Spacer(1, 4))
story.append(Paragraph(
    'Total Homebase payroll debits to 2200 (actual cash paid): $726,492 | '
    'Total AJE credits to 2200 (estimated): $751,373 | Over-accrual: $24,881', caption))

# Journal Entry
story.append(Paragraph('Journal Entry — December 31, 2025', h2))
story.append(Paragraph('DocNumber: AJE-2025-PR | Posted to QuickBooks Online', caption))
story.append(Spacer(1, 4))

je_data = [
    ['Account', 'Debit', 'Credit'],
    ['2200 Accrued Payroll', '$24,880.89', ''],
    ['    Breakfast Taco Labor', '', '$7,744.35'],
    ['    Sandwich and Wrap Labor', '', '$5,451.60'],
    ['    Delivery Contract Labor 1099', '', '$4,932.84'],
    ['    6101 Officer Expense (salary)', '', '$3,447.33'],
    ['    6103 Management', '', '$3,304.77'],
    ['TOTAL', '$24,880.89', '$24,880.89'],
]
jt = Table(je_data, colWidths=[3.5*inch, 1.3*inch, 1.3*inch])
jt.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), dark_green),
    ('TEXTCOLOR', (0,0), (-1,0), colors.white),
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTNAME', (0,-1), (-1,-1), 'Helvetica-Bold'),
    ('BACKGROUND', (0,-1), (-1,-1), mid),
    ('FONTSIZE', (0,0), (-1,-1), 9),
    ('ROWBACKGROUNDS', (0,1), (-1,-2), [colors.white, light]),
    ('GRID', (0,0), (-1,-1), 0.5, grid),
    ('ALIGN', (1,0), (-1,-1), 'RIGHT'),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ('LEFTPADDING', (0,0), (-1,-1), 8),
]))
story.append(jt)

# Split methodology
story.append(Paragraph('Split Methodology', h2))
story.append(Paragraph(
    'The $24,880.89 credit was distributed across COGS labor accounts proportionally to each '
    "account's share of the full-year 2025 manual AJE allocations. This reflects where the "
    'over-accrual originated across the year.', body))

split_data = [
    ['Account', 'Full-Year Total', 'Share', 'AJE Amount'],
    ['Breakfast Taco Labor', '$232,435', '31.1%', '$7,744.35'],
    ['Sandwich and Wrap Labor', '$163,622', '21.9%', '$5,451.60'],
    ['Delivery Contract Labor 1099', '$148,052', '19.8%', '$4,932.84'],
    ['6101 Officer Expense', '$103,467', '13.9%', '$3,447.33'],
    ['6103 Management', '$99,188', '13.3%', '$3,304.77'],
    ['TOTAL', '$746,764', '100%', '$24,880.89'],
]
st = Table(split_data, colWidths=[2.5*inch, 1.3*inch, 0.9*inch, 1.3*inch])
st.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), green),
    ('TEXTCOLOR', (0,0), (-1,0), colors.white),
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTNAME', (0,-1), (-1,-1), 'Helvetica-Bold'),
    ('BACKGROUND', (0,-1), (-1,-1), mid),
    ('FONTSIZE', (0,0), (-1,-1), 8),
    ('ROWBACKGROUNDS', (0,1), (-1,-2), [colors.white, light]),
    ('GRID', (0,0), (-1,-1), 0.5, grid),
    ('ALIGN', (1,0), (-1,-1), 'RIGHT'),
    ('TOPPADDING', (0,0), (-1,-1), 4),
    ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ('LEFTPADDING', (0,0), (-1,-1), 6),
]))
story.append(st)

story.append(Spacer(1, 16))
story.append(HRFlowable(width='100%', thickness=0.5, color=colors.grey))
story.append(Spacer(1, 4))
story.append(Paragraph(
    'Prepared using Claude Code + Anthropic API | Green Cart Finance Automation | '
    f'{date.today().strftime("%Y-%m-%d")}', caption))

doc.build(story)
print('PDF saved to private-docs/Barney/2025_YearEnd_AJE_AccruedPayroll.pdf')
