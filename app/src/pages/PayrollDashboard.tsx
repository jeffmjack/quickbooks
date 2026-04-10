import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// ── Static data (will be replaced with API calls) ──────────────────────────

const AJE_HISTORY = [
  {
    month: 'Jan 2026', jeId: '88882', docNumber: 'Jan Accrue PR',
    txnDate: '2026-01-31', total: 76146.00, status: 'posted',
  },
  {
    month: 'Feb 2026', jeId: '88883', docNumber: 'Feb Accrue PR',
    txnDate: '2026-02-28', total: 80017.45, status: 'posted',
  },
  {
    month: 'Mar 2026', jeId: '91305', docNumber: 'PR-2026-03',
    txnDate: '2026-03-31', total: 90415.73, status: 'posted',
  },
  {
    month: 'Apr 2026', jeId: null, docNumber: null,
    txnDate: null, total: null, status: 'pending',
  },
]

const MARCH_SPLITS = [
  { account: 'Breakfast Taco Labor',         amount: 29213.71 },
  { account: 'Sandwich and Wrap Labor',       amount: 17569.81 },
  { account: 'Delivery Contract Labor 1099', amount: 17930.00 },
  { account: '6101 Officer Expense',          amount: 10000.00 },
  { account: '6103 Management',               amount: 15702.21 },
]

const ROLE_MAP = [
  { role: 'Taco Cook / Roller / Supervisor / Salsa Bar', maps_to: 'Breakfast Taco Labor' },
  { role: 'Sando Assemb.', maps_to: 'Sandwich and Wrap Labor' },
  { role: 'Admin. Assistant / AM Prep Manager', maps_to: '50/50 Taco / Sandwich' },
  { role: 'Prep Assistant / Dishwasher', maps_to: '50/50 Taco / Sandwich' },
  { role: 'Kitchen Mgr / Shift Sup / Prep Mgr', maps_to: '6103 Management' },
  { role: 'Driver roles', maps_to: 'Delivery Contract Labor 1099 (from spreadsheet)' },
  { role: 'Jeffrey Jackson (salary $120k)', maps_to: '6101 Officer Expense ($10k/mo)' },
  { role: 'Amerykah Medford (salary $120k)', maps_to: '6103 Management ($10k/mo)' },
  { role: 'Yessica D (salary $70.2k)', maps_to: 'Breakfast Taco Labor ($5,850/mo)' },
]

// ── Component ──────────────────────────────────────────────────────────────

export default function PayrollDashboard() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Payroll AJE Monitor</h2>
        <p className="text-muted-foreground text-sm">
          Monthly cash-basis COGS allocation from 2200 Accrued Payroll
        </p>
      </div>

      {/* AJE Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2026 AJE Status</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Doc #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Total CR to 2200</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>QBO</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {AJE_HISTORY.map((row) => (
                <TableRow key={row.month}>
                  <TableCell className="font-medium">{row.month}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {row.docNumber ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.txnDate ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.total ? fmt(row.total) : '—'}
                  </TableCell>
                  <TableCell>
                    {row.status === 'posted' ? (
                      <Badge variant="secondary">Posted</Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-600 border-amber-400">
                        Pending
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.jeId ? (
                      <a
                        href={`https://app.qbo.intuit.com/app/journal?txnId=${row.jeId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-600 hover:underline"
                      >
                        JE {row.jeId} ↗
                      </a>
                    ) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Most recent AJE detail */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">March 2026 — Split Detail</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">% of Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MARCH_SPLITS.map((row) => (
                <TableRow key={row.account}>
                  <TableCell>{row.account}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(row.amount)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {((row.amount / 90415.73) * 100).toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold border-t-2">
                <TableCell>Total</TableCell>
                <TableCell className="text-right font-mono">{fmt(90415.73)}</TableCell>
                <TableCell className="text-right">100%</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Role mapping reference */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Role → COGS Mapping</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Homebase Role</TableHead>
                <TableHead>Maps To</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROLE_MAP.map((row) => (
                <TableRow key={row.role}>
                  <TableCell className="text-sm">{row.role}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.maps_to}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
